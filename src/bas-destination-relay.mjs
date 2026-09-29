import http from 'node:http';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { CookieJar } from 'tough-cookie';
import { brandedEnvValue } from './branding.mjs';
import { redactText } from './redact.mjs';

const DEFAULT_PROXY = 'http://127.0.0.1:8887';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'
]);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// SAP ties CSRF tokens to the session that fetched them. The BAS .dest proxy
// authenticates each hop, so the relay pairs every token with the exact
// Set-Cookie state SAP returned alongside it and replays both on the unsafe
// request. Without this pairing SAP sees a token from a foreign session and
// answers "CSRF token validation failed" with HTTP 403.
// Tokens are session-scoped, not path-scoped, but SAP only issues them from
// GET-capable endpoints. POST-only services (ADT data preview among them)
// answer a same-path token fetch with 4xx, so the relay always fetches from
// the GET-friendly discovery endpoint and accepts that session's token for
// unsafe requests to any path.
const CSRF_FETCH_PATH = '/sap/bc/adt/discovery';
const TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TOKEN_FAILURES = 3;
const MAX_CONFIGURED_TOKEN_FAILURES = 10;
const MAX_TUNNEL_FALLBACKS = 2;
// Carrying a POST's content-length on the token-fetch GET would make the
// proxy wait for a body that never arrives, so the relay drops body headers.
const BODY_HEADERS = new Set(['content-length', 'content-type']);
// The forwarded request's content-length must describe the body undici is
// about to send. Forwarding the inbound value alongside a re-buffered body
// makes undici reject the request (UND_ERR_INVALID_ARG), so it is always
// recomputed from the actual payload.
const LENGTH_HEADERS = new Set(['content-length', 'transfer-encoding']);
// undici transparently decompresses gzip/deflate/br responses but keeps the
// content-encoding header, so forwarding the client's accept-encoding would
// hand VSP a "gzip" body that is actually plain bytes. Dropping the header
// lets undici request identity encoding and keeps bodies consistent.
const ENCODING_HEADERS = new Set(['accept-encoding', 'content-encoding']);

function headersFrom(requestHeaders, extra = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || LENGTH_HEADERS.has(lower) || ENCODING_HEADERS.has(lower)) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return { ...headers, ...extra };
}

function fetchHeaders(requestHeaders, extra = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || BODY_HEADERS.has(lower) || ENCODING_HEADERS.has(lower)) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return { ...headers, ...extra };
}

function tunnelFailure(status) {
  // 502/504 from the proxy itself means the absolute-form .dest request is
  // being refused; worth retrying through a CONNECT tunnel.
  return status === 502 || status === 504;
}

function csrfFailure(status, headers, body) {
  return status === 403 && (
    String(headers.get?.('x-csrf-token') || '').toLowerCase() === 'required' ||
    String(body || '').toLowerCase().includes('csrf token validation failed')
  );
}

function maxTokenFailures(env, log, destinationName) {
  const configured = brandedEnvValue(env, 'MAX_CSRF_RETRIES');
  if (configured === undefined || configured === '') return DEFAULT_MAX_TOKEN_FAILURES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    log(`[${destinationName}] invalid CSRF retry setting; using the default of ${DEFAULT_MAX_TOKEN_FAILURES}`);
    return DEFAULT_MAX_TOKEN_FAILURES;
  }
  return Math.min(parsed, MAX_CONFIGURED_TOKEN_FAILURES);
}

function copyCookieJar(jar) {
  return CookieJar.deserializeSync(jar.serializeSync());
}

async function cookieHeader(jar, target) {
  return await jar.getCookieString(target.href) || undefined;
}

async function seedRequestCookies(jar, requestCookie, target) {
  for (const pair of String(requestCookie || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;
    try {
      await jar.setCookie(`${name}=${value}; Path=/`, target.href, { ignoreError: true });
    } catch {
      // Invalid caller-provided cookie fragments are ignored; SAP response
      // cookies remain authoritative for the destination session.
    }
  }
}

async function recordCookies(jar, headers, target, log, destinationName) {
  const values = headers.getSetCookie?.() || (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const value of values) {
    try {
      await jar.setCookie(String(value), target.href, { ignoreError: true });
    } catch {
      log(`[${destinationName}] BAS relay ignored an invalid Set-Cookie header`);
    }
  }
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large for BAS destination relay');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createBasDestinationRelay(destination, { env = process.env, fetchImpl = undiciFetch, log = () => {} } = {}) {
  if (!destination?.url) throw new Error('Destination relay requires a BAS destination URL');
  const base = new URL(destination.url);
  const cookieBase = destination.backendUrl
    ? new URL(String(destination.backendUrl))
    : (() => {
        const target = new URL(base);
        // BAS .dest URLs are local HTTP routing aliases for SAP backends that
        // are commonly HTTPS. Use a secure cookie context when BAS metadata
        // omits the backend URL so Secure session cookies are not discarded.
        if (target.protocol === 'http:' && /\.dest$/i.test(target.hostname)) target.protocol = 'https:';
        return target;
      })();
  // BAS destinations must keep their configured .dest route and authentication.
  // Proxy resolution: an explicitly configured proxy wins (an explicit empty
  // value means "go direct"). Without configuration, BAS virtual .dest hosts
  // imply the default BAS proxy; any other host (tests, direct URLs) is
  // reached directly so the relay never routes loopback traffic through a
  // foreign proxy.
  const brandedProxy = brandedEnvValue(env, 'HTTP_PROXY');
  const explicitProxy = brandedProxy !== undefined ? brandedProxy : (env.HTTP_PROXY ?? env.http_proxy);
  const proxyUrl = explicitProxy !== undefined ? String(explicitProxy) : (/\.dest$/i.test(base.hostname) ? DEFAULT_PROXY : '');
  const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: false }) : undefined;
  // Self-healing mode 2: if the BAS proxy refuses absolute-form proxied
  // requests (its own 502/504), retry through a CONNECT tunnel so the relay
  // keeps working through the same egress.
  const tunnelDispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: true }) : undefined;
  let tunneled = false;
  // Observable self-healing counters, surfaced by --doctor and tests.
  const stats = { requests: 0, csrfFetches: 0, csrfRetries: 0, csrfSessionFailures: 0, tunnelFallbacks: 0, direct: false, proxyTunnel: false };
  const maxFailures = maxTokenFailures(env, log, destination.name);
  // The shared jar captures SAP cookies from safe reads as well as CSRF fetches.
  // Each cached token gets its own snapshot so later responses cannot silently
  // pair an old token with a different session.
  const sharedCookieJar = new CookieJar();
  const tokenCache = new Map();
  const tokenFetches = new Map();

  function resolveCookieTarget(target) {
    return new URL(`${target.pathname}${target.search}`, cookieBase);
  }

  async function send(target, method, headers, body) {
    const useTunnel = tunneled && tunnelDispatcher;
    return fetchImpl(target, {
      method,
      headers,
      body: body?.length ? body : undefined,
      ...(useTunnel ? { dispatcher: tunnelDispatcher } : dispatcher ? { dispatcher } : {})
    });
  }

  // Try absolute-form first; on transport errors or proxy-level failures,
  // flip to tunneled mode once and retry (sticky for later requests).
  async function sendWithFallback(target, method, headers, body) {
    if (tunneled) return send(target, method, headers, body);
    try {
      const response = await send(target, method, headers, body);
      if (!tunnelFailure(response.status)) return response;
      log(`[${destination.name}] BAS relay proxy returned HTTP ${response.status} for ${target.pathname}; switching to proxy tunnel`);
    } catch (error) {
      log(`[${destination.name}] BAS relay absolute-form request failed for ${target.pathname} (${error.message}); switching to proxy tunnel`);
    }
    tunneled = true;
    stats.tunnelFallbacks += 1;
    return send(target, method, headers, body);
  }

  async function fetchTokenFresh(requestHeaders) {
    const key = CSRF_FETCH_PATH;
    stats.csrfFetches += 1;
    const target = new URL(CSRF_FETCH_PATH, base);
    const cookieTarget = resolveCookieTarget(target);
    const jar = copyCookieJar(sharedCookieJar);
    await seedRequestCookies(jar, requestHeaders.cookie, cookieTarget);
    const outgoingCookie = await cookieHeader(jar, cookieTarget);
    const response = await sendWithFallback(target, 'GET', fetchHeaders(requestHeaders, {
      'x-csrf-token': 'Fetch',
      accept: requestHeaders.accept || 'application/xml,*/*',
      ...(outgoingCookie ? { cookie: outgoingCookie } : {})
    }));
    await response.arrayBuffer().catch(() => undefined);
    const token = response.headers.get('x-csrf-token');
    await recordCookies(jar, response.headers, cookieTarget, log, destination.name);
    await recordCookies(sharedCookieJar, response.headers, cookieTarget, log, destination.name);
    const cookies = await jar.getCookies(cookieTarget.href);
    const session = {
      token: response.ok && token && token.toLowerCase() !== 'required' ? token : null,
      jar,
      fetchedAt: Date.now(),
      httpStatus: response.status,
      cookieCount: cookies.length
    };
    if (session.token) tokenCache.set(key, session);
    return session;
  }

  async function fetchToken(requestHeaders = {}) {
    const key = CSRF_FETCH_PATH;
    const cached = tokenCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached;
    const pending = tokenFetches.get(key);
    if (pending) return pending;
    const fetching = fetchTokenFresh(requestHeaders);
    tokenFetches.set(key, fetching);
    try {
      return await fetching;
    } finally {
      if (tokenFetches.get(key) === fetching) tokenFetches.delete(key);
    }
  }

  async function probeCsrfSession() {
    const session = await fetchToken({ accept: 'application/xml,text/xml,*/*' });
    return {
      httpStatus: session?.httpStatus || 0,
      tokenReceived: Boolean(session?.token),
      cookieCount: session?.cookieCount || 0,
      // A token alone makes unsafe requests viable: BAS proxy routes deliver
      // tokens but strip cookies, and the backend accepts the token on the
      // proxy-established Basic-auth session. cookieCount stays reported for
      // diagnosis; setup's override validation requires cookies separately.
      sessionUsable: Boolean(session?.token)
    };
  }


  async function forward(method, requestUrl, requestHeaders, body, session) {
    const target = requestUrl;
    const cookieTarget = resolveCookieTarget(target);
    const cookieJar = session?.jar || sharedCookieJar;
    if (!session) await seedRequestCookies(cookieJar, requestHeaders.cookie, cookieTarget);
    const sessionCookie = await cookieHeader(cookieJar, cookieTarget);
    const headers = headersFrom(requestHeaders, {
      ...(session?.token ? { 'x-csrf-token': session.token } : {}),
      ...(sessionCookie ? { cookie: sessionCookie } : {})
    });
    const response = await sendWithFallback(target, method, headers, body);
    const responseBody = Buffer.from(await response.arrayBuffer());
    if (session) await recordCookies(session.jar, response.headers, cookieTarget, log, destination.name);
    await recordCookies(sharedCookieJar, response.headers, cookieTarget, log, destination.name);
    return { response, body: responseBody };
  }

  // Self-healing mode 1: when SAP rejects a token (expired, rotated, or
  // invalidated server-side), drop the cached session and retry with a
  // freshly fetched token paired with its own cookies. Bounded retries keep
  // a failing destination from looping forever.
  async function forwardWithRetry(method, requestUrl, requestHeaders, body, failures = 0) {
    const unsafe = UNSAFE.has(method);
    const session = unsafe ? await fetchToken(requestHeaders) : null;
    if (unsafe && !session?.token) {
      stats.csrfSessionFailures += 1;
      const message = `BAS destination relay could not obtain a CSRF token for ${requestUrl.pathname}; no unsafe request was sent`;
      log(`[${destination.name}] ${message}`);
      const status = session?.httpStatus >= 400 ? session.httpStatus : 503;
      const response = new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return { response, body: Buffer.from(message) };
    }
    // A token without cookies is still sent: BAS proxy routes deliver tokens
    // but strip Set-Cookie, and the backend accepts the token on the Basic-
    // auth session the proxy establishes per hop. A retry cannot help there
    // (a fresh token still arrives cookie-less), so a CSRF rejection on a
    // cookie-less session is surfaced instead of retried.
    const tokenOnly = unsafe && !session.cookieCount;
    const { response, body: responseBody } = await forward(method, requestUrl, requestHeaders, body, session);
    const rejected = csrfFailure(response.status, response.headers, responseBody);
    if (unsafe && rejected && !tokenOnly && failures < maxFailures) {
      log(`[${destination.name}] BAS relay CSRF session rejected for ${requestUrl.pathname}; re-establishing token and session (attempt ${failures + 1}/${maxFailures})`);
      stats.csrfRetries += 1;
      tokenCache.delete(CSRF_FETCH_PATH);
      return forwardWithRetry(method, requestUrl, requestHeaders, body, failures + 1);
    }
    if (unsafe && rejected && tokenOnly) {
      log(`[${destination.name}] BAS relay CSRF token rejected without a session cookie for ${requestUrl.pathname}; not retried (the configured destination route delivered no cookies)`);
    } else if (unsafe && rejected && failures >= maxFailures) {
      log(`[${destination.name}] BAS relay stopped after ${maxFailures} CSRF session retries for ${requestUrl.pathname}`);
    }
    return { response, body: responseBody };
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = String(req.method || 'GET').toUpperCase();
      const requestUrl = new URL(req.url || '/', base);
      stats.requests += 1;
      const body = UNSAFE.has(method) ? await readRequestBody(req) : Buffer.alloc(0);
      const { response, body: responseBody } = await forwardWithRetry(method, requestUrl, req.headers, body);
      const responseHeaders = {};
      // SAP sessions commonly set several cookies at once; a plain object
      // assignment would collapse them to the last value. undici exposes the
      // full list via getSetCookie, and Node's http server serializes an
      // array as repeated headers.
      const setCookies = response.headers.getSetCookie?.() || [];
      if (setCookies.length) responseHeaders['set-cookie'] = setCookies;
      for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        // undici decompresses response bodies; the stale content-encoding and
        // content-length would misdescribe the plain bytes handed to VSP.
        if (lower === 'set-cookie' || HOP_BY_HOP.has(lower) || lower === 'content-encoding' || lower === 'content-length') continue;
        responseHeaders[name] = value;
      }
      responseHeaders['x-sap-ai-dev-toolkit-relay'] = 'bas-destination';
      res.writeHead(response.status, response.statusText, responseHeaders);
      res.end(responseBody);
    })().catch(error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'connection': 'close' });
      // Proxy and transport errors can embed the full proxy URL including
      // userinfo; redact before the body reaches the child (and the tool result).
      res.end(`BAS destination relay failed: ${redactText(error.message)}\n`);
    });
  });

  // Keep an error listener for the server's whole lifetime: after listen()
  // succeeds, a later 'error' event (port collision cleanup, socket reset)
  // with no listener would be an uncaught exception that kills the process.
  server.on('error', error => {
    log(`[${destination.name}] BAS relay server error: ${redactText(error.message)}`);
  });
  // Bind eagerly and report the real port through `ready`. Callers must
  // await `ready` before handing the URL to a VSP child; binding failures
  // surface as a rejected promise instead of a silently wrong guessed port.
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
  const ready = listening.then(port => `http://127.0.0.1:${port}`).catch(error => {
    log(`[${destination.name}] BAS relay failed to start: ${error.message}`);
    throw error;
  });
  return {
    ready,
    stats,
    probeCsrfSession,
    close: async () => {
      await dispatcher?.close?.();
      await tunnelDispatcher?.close?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}
