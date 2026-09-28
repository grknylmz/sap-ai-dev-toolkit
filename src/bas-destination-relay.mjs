import http from 'node:http';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

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
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_FAILURES = 3;
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

function authFailure(status) {
  return status === 401 || status === 403;
}

function cookieHeader(jar) {
  return jar.size ? [...jar].map(([name, value]) => `${name}=${value}`).join('; ') : undefined;
}

function recordCookies(jar, headers) {
  for (const value of headers.getSetCookie?.() || []) {
    const [pair] = String(value).split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    if (/expires=thu, 01 jan 1970/i.test(String(value))) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1).trim());
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
  const credentials = destination.credentials;
  const tunnelMode = credentials?.mode === 'bas-tunnel';
  const directHost = tunnelMode ? '' : credentials?.host;
  // Internet overrides retain the direct-backend path. OnPremise overrides
  // must keep the BAS .dest route (and its Cloud Connector mapping), so they
  // use HTTP CONNECT through the BAS proxy instead of credentials.host.
  const directBase = directHost ? new URL(String(directHost)) : null;
  if (directBase) log(`[${destination.name}] BAS relay direct connect active (${directBase.origin}); BAS proxy cookie stripping bypassed`);
  if (tunnelMode) log(`[${destination.name}] BAS relay using a BAS proxy tunnel for the OnPremise destination`);
  // Proxy resolution: an explicitly configured proxy wins (an explicit empty
  // value means "go direct"). Without configuration, BAS virtual .dest hosts
  // imply the default BAS proxy; any other host (tests, direct URLs) is
  // reached directly so the relay never routes loopback traffic through a
  // foreign proxy.
  const explicitProxy = env.HTTP_PROXY ?? env.http_proxy;
  const proxyUrl = directBase ? '' : (explicitProxy !== undefined ? String(explicitProxy) : (/\.dest$/i.test(base.hostname) ? DEFAULT_PROXY : ''));
  if (tunnelMode && !proxyUrl) throw new Error('OnPremise credential overrides require the BAS destination proxy to preserve the Cloud Connector route');
  const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: false }) : undefined;
  // Self-healing mode 2: if the BAS proxy refuses absolute-form proxied
  // requests (its own 502/504), retry through a CONNECT tunnel so the relay
  // keeps working through the same egress.
  const tunnelDispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: true }) : undefined;
  let tunneled = tunnelMode;
  // Observable self-healing counters, surfaced by --doctor and tests.
  const stats = { requests: 0, csrfFetches: 0, csrfRetries: 0, tunnelFallbacks: 0, direct: Boolean(directBase), proxyTunnel: tunnelMode };
  // Per-path CSRF sessions: { token, jar, fetchedAt } where jar holds the
  // Set-Cookie state SAP returned together with the token.
  const tokenCache = new Map();

  function rememberSession(key, token, headers, httpStatus) {
    const jar = new Map();
    recordCookies(jar, headers);
    tokenCache.set(key, { token, jar, fetchedAt: Date.now(), httpStatus });
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

  async function fetchToken(requestUrl, requestHeaders) {
    const key = requestUrl.pathname;
    const cached = tokenCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached;
    stats.csrfFetches += 1;
    const response = await sendWithFallback(resolveTarget(requestUrl), 'GET', authHeaders(fetchHeaders(requestHeaders, {
      'x-csrf-token': 'Fetch',
      accept: requestHeaders.accept || 'application/xml,*/*',
      ...(cached?.jar?.size ? { cookie: cookieHeader(cached.jar) } : {})
    })));
    await response.arrayBuffer().catch(() => undefined);
    const token = response.headers.get('x-csrf-token');
    if (token && token.toLowerCase() !== 'required') {
      rememberSession(key, token, response.headers, response.status);
      return tokenCache.get(key);
    }
    return null;
  }

  async function probeCsrfSession(path = '/sap/bc/adt/discovery') {
    const requestUrl = new URL(path, base);
    const session = await fetchToken(requestUrl, { accept: 'application/xml,text/xml,*/*' });
    return {
      httpStatus: session?.httpStatus || 0,
      tokenReceived: Boolean(session?.token),
      cookieCount: session?.jar?.size || 0
    };
  }

  // Rewrite an incoming .dest target onto the direct backend host when
  // credentials are configured, keeping path and query intact.
  function resolveTarget(target) {
    if (!directBase) return target;
    return new URL(`${target.pathname}${target.search}`, directBase);
  }

  function authHeaders(extra = {}) {
    if (!credentials?.user || !credentials?.password) return extra;
    const basic = Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64');
    return { authorization: `Basic ${basic}`, ...extra };
  }

  async function forward(method, requestUrl, requestHeaders, body, session) {
    const headers = authHeaders(headersFrom(requestHeaders, {
      ...(session?.token ? { 'x-csrf-token': session.token } : {}),
      ...(session?.jar?.size ? { cookie: cookieHeader(session.jar) } : {})
    }));
    const response = await sendWithFallback(resolveTarget(requestUrl), method, headers, body);
    const responseBody = Buffer.from(await response.arrayBuffer());
    if (session) recordCookies(session.jar, response.headers);
    return { response, body: responseBody };
  }

  // Self-healing mode 1: when SAP rejects a token (expired, rotated, or
  // invalidated server-side), drop the cached session and retry with a
  // freshly fetched token paired with its own cookies. Bounded retries keep
  // a failing destination from looping forever.
  async function forwardWithRetry(method, requestUrl, requestHeaders, body, failures = 0) {
    const unsafe = UNSAFE.has(method);
    const session = unsafe ? await fetchToken(requestUrl, requestHeaders) : null;
    if (unsafe && !session) log(`[${destination.name}] BAS relay could not obtain CSRF token for ${requestUrl.pathname}`);
    const { response, body: responseBody } = await forward(method, requestUrl, requestHeaders, body, session);
    const rejected = csrfFailure(response.status, response.headers, responseBody) || (authFailure(response.status) && session);
    if (unsafe && rejected && failures < MAX_TOKEN_FAILURES) {
      log(`[${destination.name}] BAS relay CSRF session rejected for ${requestUrl.pathname}; re-establishing token and session (attempt ${failures + 1}/${MAX_TOKEN_FAILURES})`);
      stats.csrfRetries += 1;
      tokenCache.delete(requestUrl.pathname);
      return forwardWithRetry(method, requestUrl, requestHeaders, body, failures + 1);
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
      for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        // undici decompresses response bodies; the stale content-encoding and
        // content-length would misdescribe the plain bytes handed to VSP.
        if (HOP_BY_HOP.has(lower) || lower === 'content-encoding' || lower === 'content-length') continue;
        responseHeaders[name] = value;
      }
      responseHeaders['x-sap-ai-dev-toolkit-relay'] = 'bas-destination';
      res.writeHead(response.status, response.statusText, responseHeaders);
      res.end(responseBody);
    })().catch(error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'connection': 'close' });
      res.end(`BAS destination relay failed: ${error.message}\n`);
    });
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
