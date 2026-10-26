// OAuth client-credentials HTTP client for one CPI or APIM tenant.
// Requests are pinned to the configured tenant origin, bodies are size
// capped, and token/error responses are never echoed raw.
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

export class IntegrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrationError';
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

async function readCapped(response, limit, label) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new IntegrationError(`${label} response exceeded the safe size limit`);
  }
  if (!response.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) {
      await response.body.cancel().catch(() => {});
      throw new IntegrationError(`${label} response exceeded the safe size limit`);
    }
    chunks.push(chunk);
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

function setCookiePairs(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return values.map(value => value.split(';')[0].trim()).filter(Boolean);
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
export function createServiceClient({
  label,
  url,
  tokenUrl,
  clientId,
  clientSecret,
  csrfPath = '/',
  env = process.env,
  fetchImpl = undiciFetch,
  now = Date.now,
  retryDelayMs = 500
}) {
  const origin = new URL(url).origin;
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
  const dispatcher = httpProxy || httpsProxy
    ? envProxyAgent({ httpProxy, httpsProxy, noProxy: env.NO_PROXY || env.no_proxy })
    : undefined;
  const transportOptions = dispatcher ? { dispatcher } : {};
  let cachedToken = null;

  async function token() {
    if (cachedToken && cachedToken.expiresAt > now()) return cachedToken.value;
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body: 'grant_type=client_credentials',
        redirect: 'manual',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        ...transportOptions
      });
    } catch {
      throw new IntegrationError(`${label} token request failed (network error)`);
    }
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => {});
      throw new IntegrationError(`${label} token request failed (HTTP ${response.status})`);
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(await readCapped(response, 64 * 1024, `${label} token`)));
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(`${label} token response is not valid JSON`);
    }
    if (typeof payload?.access_token !== 'string' || !payload.access_token) {
      throw new IntegrationError(`${label} token response has no access_token`);
    }
    const ttlMs = Number.isFinite(Number(payload.expires_in))
      ? Math.max(0, (Number(payload.expires_in) - 60) * 1000)
      : DEFAULT_TOKEN_TTL_MS;
    cachedToken = { value: payload.access_token, expiresAt: now() + ttlMs };
    return cachedToken.value;
  }

  async function send(target, init) {
    try {
      return await fetchImpl(target, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...transportOptions
      });
    } catch {
      throw new IntegrationError(`${label} ${init.method} ${new URL(target).pathname} failed (network error or timeout)`);
    }
  }

  async function fetchCsrf(bearer) {
    const response = await send(new URL(`${url}${csrfPath}`).href, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}`, 'x-csrf-token': 'Fetch', accept: 'application/json' }
    });
    await response.body?.cancel().catch(() => {});
    const csrfToken = response.headers.get('x-csrf-token');
    if (!csrfToken || csrfToken.toLowerCase() === 'required') {
      throw new IntegrationError(`${label} CSRF token fetch failed (HTTP ${response.status})`);
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
    unwrap = true
  } = {}) {
    const target = new URL(`${url}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    // URLSearchParams emits '+' for spaces; OData servers expect %20. Literal '+' is already %2B.
    target.search = target.search.replaceAll('+', '%20');
    if (target.origin !== origin) throw new IntegrationError(`${label} request escaped the configured tenant`);

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
      const headers = { ...baseHeaders, authorization: `Bearer ${await token()}` };
      if (csrf) {
        headers['x-csrf-token'] = csrf.csrfToken;
        if (csrf.cookies.length) headers.cookie = csrf.cookies.join('; ');
      }
      response = await send(target.href, { method, headers, body: payload });
      if (response.status === 401 && !authRetried) {
        authRetried = true;
        await response.body?.cancel().catch(() => {});
        cachedToken = null;
        continue;
      }
      if (response.status === 403 && !csrfRetried && (response.headers.get('x-csrf-token') || '').toLowerCase() === 'required') {
        csrfRetried = true;
        await response.body?.cancel().catch(() => {});
        csrf = await fetchCsrf(await token());
        continue;
      }
      if (RETRYABLE_METHODS.has(method) && RETRYABLE_STATUS.has(response.status) && !expect.includes(response.status) && serverRetries < SERVER_RETRIES) {
        serverRetries += 1;
        await response.body?.cancel().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * serverRetries));
        continue;
      }
      break;
    }

    if (!expect.includes(response.status)) {
      let detail = '';
      try {
        detail = diagnosticText(sapMessage(new TextDecoder().decode(await readCapped(response, MAX_TEXT, label))), 400);
      } catch {
        detail = 'response body unavailable';
      }
      throw new IntegrationError(`${label} ${method} ${target.pathname} failed (HTTP ${response.status}): ${detail}`);
    }
    const status = response.status;
    const wrap = data => (withStatus ? { status, data } : data);
    if (status === 204 || status >= 300) {
      await response.body?.cancel().catch(() => {});
      return wrap(null);
    }
    if (responseType === 'bytes') return wrap(await readCapped(response, MAX_BYTES, label));
    const responseText = new TextDecoder().decode(await readCapped(response, MAX_TEXT, label));
    if (responseType === 'text') return wrap(responseText);
    if (!responseText.trim()) return wrap(null);
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new IntegrationError(`${label} ${method} ${target.pathname} returned a non-JSON response`);
    }
    return wrap(unwrap ? parsed?.d?.results ?? parsed?.d ?? parsed : parsed);
  }

  return Object.freeze({ label, request });
}
