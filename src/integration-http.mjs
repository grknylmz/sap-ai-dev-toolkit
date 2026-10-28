// Origin-pinned OAuth and private static-authorization HTTP clients.
// Shared transport caps bodies, rejects redirects, and bounds complete reads.
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { diagnosticText } from './redact.mjs';

const TOKEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const SERVER_RETRIES = 2;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
// Only idempotent methods are retried; POST (create/deploy/import) is never re-sent.
const RETRYABLE_METHODS = new Set(['GET', 'PUT']);
const PAGINATION_HEADERS = new Set(['elements-next-page-token', 'nextpage']);

export class IntegrationError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = 'IntegrationError';
    Object.assign(this, evidence);
  }
}

/** Quote an OData string key literal; callers still percent-encode the whole segment. */
export function odataKey(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Convert OData v2 `/Date(ms)/` values to ISO strings; other values pass through. */
export function odataDate(value) {
  if (typeof value !== 'string') return value;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  return match ? new Date(Number(match[1])).toISOString() : value;
}

function discard(response) {
  // Cancellation is cleanup, not another unbounded wait on a remote stream.
  void response.body?.cancel().catch(() => {});
}

async function readCapped(response, limit, label, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    discard(response);
    throw new IntegrationError(`${label} response exceeded the safe size limit`);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > limit) throw new IntegrationError(`${label} response exceeded the safe size limit`);
      chunks.push(chunk);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sapMessage(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message;
    if (typeof message?.value === 'string') return message.value;
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON: try an OData XML error, then the raw text prefix.
  }
  const xmlMessage = /<(?:\w+:)?message\b[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/i.exec(bodyText);
  if (xmlMessage) return xmlMessage[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return bodyText.slice(0, 400);
}

function setCookieValues(headers) {
  return typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/).filter(Boolean);
}

function setCookiePairs(headers) {
  return setCookieValues(headers).map(value => value.split(';')[0].trim()).filter(Boolean);
}

// This deliberately host-only jar never honors a server-supplied Domain. It is
// private to one pinned client and only enabled for broker management sessions.
function sessionCookies(now) {
  const jar = new Map();
  return {
    remember(headers, target) {
      for (const value of setCookieValues(headers)) {
        if (value.length > 4096) continue;
        const [pair, ...attributes] = value.split(';');
        const separator = pair.indexOf('=');
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const content = pair.slice(separator + 1).trim();
        if (!/^[!#$%&'*+\-.^_`|~\w]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(content)) continue;
        let path = target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/';
        let secure = false;
        let expires = Infinity;
        let maxAge;
        for (const attribute of attributes) {
          const index = attribute.indexOf('=');
          const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
          const setting = index < 0 ? '' : attribute.slice(index + 1).trim();
          if (key === 'path' && setting.startsWith('/')) path = setting;
          if (key === 'secure') secure = true;
          if (key === 'max-age' && /^-?\d+$/.test(setting)) maxAge = Number(setting);
          if (key === 'expires' && Number.isFinite(Date.parse(setting))) expires = Date.parse(setting);
        }
        if (maxAge !== undefined) expires = now() + maxAge * 1000;
        const key = `${path}\0${name}`;
        if (expires <= now()) jar.delete(key);
        else if (jar.has(key) || jar.size < 100) jar.set(key, { name, content, path, secure, expires });
      }
    },
    header(target) {
      const matches = [];
      for (const [key, cookie] of jar) {
        if (cookie.expires <= now()) { jar.delete(key); continue; }
        const inPath = target.pathname === cookie.path
          || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
        if (inPath && (!cookie.secure || target.protocol === 'https:')) matches.push(cookie);
      }
      return matches.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.content}`).join('; ');
    }
  };
}

// undici flags EnvHttpProxyAgent as experimental with a process warning that lands in the middle of the
// setup wizard output; only that warning is dropped, and only while the agent is constructed.
function envProxyAgent(options) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
    if (code === 'UNDICI-EHPA') return;
    emitWarning.call(process, warning, ...rest);
  };
  try {
    return new EnvHttpProxyAgent(options);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Create a tenant-scoped client using OAuth client credentials. */
export function createServiceClient(options) {
  return createTransportClient({ ...options, oauth: true });
}

/** Static authorization stays in a host-private closure, never a request input. */
export function createStaticServiceClient({ authorization, ...options }) {
  if (typeof authorization !== 'function') throw new IntegrationError('Static authorization must be a private function');
  return createTransportClient({ ...options, authorization, oauth: false, exposeErrorDetails: false });
}

function createTransportClient({
  label,
  url,
  tokenUrl,
  clientId,
  clientSecret,
  csrfPath = '/',
  env = process.env,
  fetchImpl = undiciFetch,
  now = Date.now,
  retryDelayMs = 500,
  exposeErrorDetails = true,
  oauth,
  authorization,
  reuseCookies = false
}) {
  const base = new URL(url);
  if (base.username || base.password || base.search || base.hash) throw new IntegrationError(`${label} base URL must not contain credentials, query, or fragment`);
  const origin = base.origin;
  const cookies = reuseCookies ? sessionCookies(now) : null;
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
  const dispatcher = httpProxy || httpsProxy
    ? envProxyAgent({ httpProxy, httpsProxy, noProxy: env.NO_PROXY || env.no_proxy })
    : undefined;
  const transportOptions = dispatcher ? { dispatcher } : {};
  let cachedToken = null;
  const responseDeadlines = new WeakMap();

  function timeoutError(phase, deadline, status, deadlineTimer = false) {
    const expired = deadlineTimer || deadline !== undefined && now() >= deadline;
    return new IntegrationError(`${label} ${phase} ${expired ? 'deadline exceeded' : 'timed out'}`, {
      code: expired ? 'INTEGRATION_DEADLINE' : 'INTEGRATION_TIMEOUT',
      ...(expired ? { stop_reason: 'deadline', deadline } : {}),
      phase,
      ...(status === undefined ? {} : { status })
    });
  }

  // Race as well as abort: injected transports and a stalled response stream may
  // ignore AbortSignal. The timer covers the complete operation, including reads.
  async function bounded(operation, deadline, timeout, phase, status) {
    const started = now();
    const remaining = deadline === undefined ? timeout : Math.min(timeout, deadline - started);
    const deadlineTimer = Number.isFinite(deadline) && deadline - started <= timeout;
    if (remaining <= 0) throw timeoutError(phase, deadline, status);
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError(phase, deadline, status, deadlineTimer));
        controller.abort();
      }, remaining);
    });
    try {
      const result = await Promise.race([expired, operation(controller.signal)]);
      if (deadline !== undefined && now() >= deadline) throw timeoutError(phase, deadline, status);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(response, limit, deadline, phase = 'response read') {
    const end = Math.min(deadline ?? Infinity, responseDeadlines.get(response) ?? Infinity);
    try {
      return await bounded(signal => readCapped(response, limit, label, signal), end, REQUEST_TIMEOUT_MS, phase, response.status);
    } catch (error) {
      discard(response);
      if (error instanceof IntegrationError) {
        error.status ??= response.status;
        error.phase ??= phase;
      }
      throw error;
    }
  }

  async function token(deadline) {
    if (cachedToken && cachedToken.expiresAt > now()) return cachedToken.value;
    const end = Math.min(deadline ?? Infinity, now() + TOKEN_TIMEOUT_MS);
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    let response;
    try {
      response = await bounded(signal => fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate'
        },
        body: 'grant_type=client_credentials',
        redirect: 'manual',
        signal,
        ...transportOptions
      }), end, TOKEN_TIMEOUT_MS, 'token request');
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(`${label} token request failed (network error)`, { phase: 'token request' });
    }
    if (response.status < 200 || response.status > 299) {
      discard(response);
      throw new IntegrationError(`${label} token request failed (HTTP ${response.status})`, { status: response.status, phase: 'token request' });
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(await read(response, 64 * 1024, end, 'token response read')));
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(`${label} token response is not valid JSON`, { phase: 'token response read' });
    }
    if (typeof payload?.access_token !== 'string' || !payload.access_token) {
      throw new IntegrationError(`${label} token response has no access_token`, { phase: 'token response read' });
    }
    const ttlMs = Number.isFinite(Number(payload.expires_in))
      ? Math.max(0, (Number(payload.expires_in) - 60) * 1000)
      : DEFAULT_TOKEN_TTL_MS;
    cachedToken = { value: payload.access_token, expiresAt: now() + ttlMs };
    return cachedToken.value;
  }

  async function send(target, init, deadline) {
    const destination = new URL(target);
    if (destination.origin !== origin || destination.username || destination.password || destination.hash) {
      throw new IntegrationError(`${label} request escaped the configured tenant`);
    }
    const end = Math.min(deadline ?? Infinity, now() + REQUEST_TIMEOUT_MS);
    try {
      const response = await bounded(signal => fetchImpl(target, {
        ...init,
        headers: { ...init.headers, 'accept-encoding': 'gzip, deflate' },
        redirect: 'manual',
        signal,
        ...transportOptions
      }), end, REQUEST_TIMEOUT_MS, 'HTTP request');
      cookies?.remember(response.headers, destination);
      responseDeadlines.set(response, end);
      return response;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(`${label} ${init.method} ${new URL(target).pathname} failed (network error or timeout)`, { phase: 'HTTP request' });
    }
  }

  async function fetchCsrf(bearer, deadline) {
    const response = await send(new URL(`${url}${csrfPath}`).href, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}`, 'x-csrf-token': 'Fetch', accept: 'application/json' }
    }, deadline);
    discard(response);
    const csrfToken = response.headers.get('x-csrf-token');
    if (response.status < 200 || response.status >= 300 || !csrfToken || csrfToken.toLowerCase() === 'required') {
      throw new IntegrationError(`${label} CSRF token fetch failed (HTTP ${response.status})`, { status: response.status, phase: 'CSRF request' });
    }
    return { csrfToken, cookies: setCookiePairs(response.headers) };
  }

  async function request(method, path, {
    query,
    json,
    body,
    contentType,
    accept = 'application/json',
    expect = [200],
    responseType = 'json',
    withStatus = false,
    unwrap = true,
    deadline,
    responseHeaders
  } = {}) {
    if (deadline !== undefined && !Number.isFinite(deadline)) throw new IntegrationError(`${label} request deadline must be an absolute finite timestamp`);
    if (deadline !== undefined && now() >= deadline) throw timeoutError('request', deadline);
    if (responseHeaders !== undefined && (!Array.isArray(responseHeaders)
      || responseHeaders.some(name => typeof name !== 'string' || !PAGINATION_HEADERS.has(name.toLowerCase())))) {
      throw new IntegrationError(`${label} response headers are limited to documented pagination tokens`);
    }
    const target = new URL(`${url}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    // SAP management endpoints require literal OData '$' option names and '%20' spaces.
    // Decode only a leading '$' in parameter names; values stay encoded (including '+' and '&').
    target.search = target.search.replaceAll('+', '%20').replace(/([?&])%24(?=[A-Za-z_])/gi, (_, separator) => `${separator}$`);
    if (target.origin !== origin || target.username || target.password || target.hash) throw new IntegrationError(`${label} request escaped the configured tenant`);

    const baseHeaders = { accept };
    let payload;
    if (json !== undefined) {
      baseHeaders['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    } else if (typeof body === 'string') {
      // Bytes, not a string: undici would otherwise add content-type: text/plain.
      payload = Buffer.from(body, 'utf8');
      if (contentType) baseHeaders['content-type'] = contentType;
    }

    // One retry each for an expired token (401) and a CSRF challenge. Idempotent GET/PUT are also retried
    // on transient 5xx: CPI intermittently fails bundle downloads and configuration PUTs with HTTP 500.
    let csrf = null;
    let response;
    let authRetried = false;
    let csrfRetried = false;
    let serverRetries = 0;
    for (;;) {
      let authentication;
      if (oauth) authentication = `Bearer ${await token(deadline)}`;
      else {
        try {
          authentication = await bounded(() => authorization({ method, path: target.pathname }), deadline, REQUEST_TIMEOUT_MS, 'authorization');
        } catch (error) {
          if (error instanceof IntegrationError && error.code === 'INTEGRATION_DEADLINE') throw error;
          throw new IntegrationError(`${label} private authorization failed`, { phase: 'authorization' });
        }
        if (typeof authentication !== 'string' || !authentication || /[^\x20-\x7e]/.test(authentication)) {
          throw new IntegrationError(`${label} private authorization is invalid`, { phase: 'authorization' });
        }
      }
      const headers = { ...baseHeaders, authorization: authentication };
      const cookieHeader = cookies?.header(target);
      if (cookieHeader) headers.cookie = cookieHeader;
      if (csrf) {
        headers['x-csrf-token'] = csrf.csrfToken;
        if (csrf.cookies.length) headers.cookie = csrf.cookies.join('; ');
      }
      response = await send(target.href, { method, headers, body: payload }, deadline);
      if (oauth && response.status === 401 && !authRetried) {
        authRetried = true;
        discard(response);
        cachedToken = null;
        continue;
      }
      if (oauth && response.status === 403 && !csrfRetried && (response.headers.get('x-csrf-token') || '').toLowerCase() === 'required') {
        csrfRetried = true;
        discard(response);
        csrf = await fetchCsrf(await token(deadline), deadline);
        continue;
      }
      if (RETRYABLE_METHODS.has(method) && RETRYABLE_STATUS.has(response.status) && !expect.includes(response.status) && serverRetries < SERVER_RETRIES) {
        serverRetries += 1;
        discard(response);
        // Scheduling a backoff late is not a timeout; retain the normal request
        // timeout and any caller deadline instead of racing the delay itself.
        await bounded(signal => new Promise(resolve => {
          const timer = setTimeout(resolve, retryDelayMs * serverRetries);
          signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        }), deadline, REQUEST_TIMEOUT_MS, 'retry delay', response.status);
        continue;
      }
      break;
    }

    if (!expect.includes(response.status)) {
      let detail = '';
      if (!exposeErrorDetails) {
        discard(response);
        detail = 'response body withheld to protect credentials';
      } else {
        try {
          detail = diagnosticText(sapMessage(new TextDecoder().decode(await read(response, MAX_TEXT, deadline))), 400);
        } catch (error) {
          if (error?.stop_reason === 'deadline') throw error;
          detail = 'response body unavailable';
        }
      }
      throw new IntegrationError(`${label} ${method} ${target.pathname} failed (HTTP ${response.status}): ${detail}`, { status: response.status, phase: 'HTTP response' });
    }
    const status = response.status;
    const wrap = data => {
      if (responseHeaders === undefined) return withStatus ? { status, data } : data;
      const selected = {};
      for (const name of responseHeaders) {
        const normalized = name.toLowerCase();
        const value = response.headers.get(normalized);
        if (value !== null) selected[normalized] = value;
      }
      return { ...(withStatus ? { status } : {}), data, responseHeaders: selected };
    };
    if (responseType === 'none' || status === 204 || status >= 300) {
      discard(response);
      return wrap(null);
    }
    if (responseType === 'bytes') return wrap(await read(response, MAX_BYTES, deadline));
    const responseText = new TextDecoder().decode(await read(response, MAX_TEXT, deadline));
    if (responseType === 'text') return wrap(responseText);
    if (!responseText.trim()) return wrap(null);
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new IntegrationError(`${label} ${method} ${target.pathname} returned a non-JSON response`, { status, phase: 'response parse' });
    }
    return wrap(unwrap ? parsed?.d?.results ?? parsed?.d ?? parsed : parsed);
  }

  return Object.freeze({ label, origin, request });
}
