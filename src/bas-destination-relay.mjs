import http from 'node:http';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const DEFAULT_PROXY = 'http://127.0.0.1:8887';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'
]);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function headersFrom(requestHeaders, extra = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return { ...headers, ...extra };
}

function csrfFailure(status, headers, body) {
  return status === 403 && (
    String(headers.get?.('x-csrf-token') || '').toLowerCase() === 'required' ||
    String(body || '').toLowerCase().includes('csrf token validation failed')
  );
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
  const proxyUrl = env.HTTP_PROXY || env.http_proxy || DEFAULT_PROXY;
  const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: false }) : undefined;
  const tokenCache = new Map();

  async function fetchToken(target, requestHeaders) {
    const key = target.pathname;
    const cached = tokenCache.get(key);
    if (cached) return cached;
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: headersFrom(requestHeaders, { 'x-csrf-token': 'Fetch', accept: requestHeaders.accept || 'application/xml,*/*' }),
      ...(dispatcher ? { dispatcher } : {})
    });
    await response.arrayBuffer().catch(() => undefined);
    const token = response.headers.get('x-csrf-token');
    if (token && token.toLowerCase() !== 'required') tokenCache.set(key, token);
    return token;
  }

  async function forward(target, method, requestHeaders, body, token) {
    const headers = headersFrom(requestHeaders, token ? { 'x-csrf-token': token } : {});
    const response = await fetchImpl(target, {
      method,
      headers,
      body: body.length ? body : undefined,
      ...(dispatcher ? { dispatcher } : {})
    });
    const textBody = Buffer.from(await response.arrayBuffer());
    return { response, body: textBody };
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = String(req.method || 'GET').toUpperCase();
      const target = new URL(req.url || '/', base);
      let body = Buffer.alloc(0);
      if (UNSAFE.has(method)) body = await readRequestBody(req);

      let token;
      if (UNSAFE.has(method) && !req.headers['x-csrf-token']) {
        token = await fetchToken(target, req.headers);
        if (!token) log(`[${destination.name}] BAS relay could not obtain CSRF token for ${target.pathname}`);
      }

      let { response, body: responseBody } = await forward(target, method, req.headers, body, token);
      if (UNSAFE.has(method) && csrfFailure(response.status, response.headers, responseBody)) {
        tokenCache.delete(target.pathname);
        token = await fetchToken(target, req.headers);
        ({ response, body: responseBody } = await forward(target, method, req.headers, body, token));
      }

      const responseHeaders = {};
      for (const [name, value] of response.headers) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      responseHeaders['x-sap-ai-dev-toolkit-relay'] = 'bas-destination';
      res.writeHead(response.status, response.statusText, responseHeaders);
      res.end(responseBody);
    })().catch(error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'connection': 'close' });
      res.end(`BAS destination relay failed: ${error.message}\n`);
    });
  });

  server.listen(0, '127.0.0.1');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: async () => {
      await dispatcher?.close?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}
