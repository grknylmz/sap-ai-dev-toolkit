import http from 'node:http';
import { once } from 'node:events';
import { execFile as nodeExecFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_HELPER_OUTPUT = 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

function safeError(message) { return new Error(message); }

function validateTarget(value) {
  let url;
  try { url = new URL(value); }
  catch { throw safeError('Windows SSO target ADT URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw safeError('Windows SSO target ADT URL must be an HTTP(S) URL without embedded user information');
  }
  url.hash = '';
  return url;
}

function hasNegotiateChallenge(headers) {
  const value = headers.get?.('www-authenticate') || '';
  return /(?:^|,)\s*Negotiate\b/i.test(value);
}

function headerObject(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host') continue;
    if (lower === 'authorization') continue;
    if (value == null) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function copyResponseHeaders(response, { proxyOrigin, targetOrigin } = {}) {
  const headers = {};
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || ['content-encoding', 'content-length', 'set-cookie'].includes(lower)) continue;
    // fetch exposes decompressed bytes, so upstream framing is no longer valid.
    if (lower === 'location' && proxyOrigin && targetOrigin) {
      try {
        const location = new URL(value, targetOrigin);
        if (location.origin === targetOrigin) {
          headers[name] = `${proxyOrigin}${location.pathname}${location.search}${location.hash}`;
          continue;
        }
      } catch {
        // Keep unparsable Location values unchanged; the client/backend can decide.
      }
    }
    headers[name] = value;
  }
  const cookies = setCookies(response.headers);
  if (cookies.length) headers['set-cookie'] = cookies;
  return headers;
}

function setCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers?.get?.('set-cookie');
  return value ? [value] : [];
}

function mergeCookieHeader(existing, cookies) {
  const pairs = new Map();
  for (const part of String(existing || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0) pairs.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  for (const cookie of cookies || []) {
    const first = String(cookie || '').split(';', 1)[0]?.trim();
    const index = first.indexOf('=');
    if (index > 0) pairs.set(first.slice(0, index), first.slice(index + 1));
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function readRequestBody(req, limit = 50 * 1024 * 1024) {
  if (['GET', 'HEAD'].includes(req.method || 'GET')) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw safeError('Windows SSO proxy request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function helperCommand(env) {
  const command = env.SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER || env.SAP_AI_DEV_TOOLKIT_SSPI_HELPER;
  if (command) return { command, args: [] };
  if (process.platform !== 'win32') return null;
  const interactiveCredentialUi = env.SAP_AI_DEV_TOOLKIT_WINDOWS_CREDENTIAL_UI === 'true' || env.SAP_WINDOWS_CREDENTIAL_UI === 'true';
  return {
    command: env.SystemRoot ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', ...(interactiveCredentialUi ? [] : ['-NonInteractive']), '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'windows-negotiate-helper.ps1')]
  };
}

function tokenLooksLikeNtlm(token) {
  try {
    return Buffer.from(token, 'base64').subarray(0, 8).toString('ascii') === 'NTLMSSP\0';
  } catch {
    return false;
  }
}

function execHelper(helper, payload, execFileImpl = nodeExecFile, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = execFileImpl(helper.command, helper.args, {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: MAX_HELPER_OUTPUT,
      env: { ...process.env, ...env }
    }, (error, stdout) => {
      // execFile errors can contain helper stdout/stderr, including tokens.
      if (error) return reject(safeError('Windows SSO helper failed; verify the ADT endpoint supports HTTP Negotiate/SPNEGO for the signed-in Windows identity (including smart-card-backed Windows logon) and that Kerberos/SPN configuration is correct. The toolkit cannot prompt for or accept manually pasted bearer/SAML tokens.'));
      const token = String(stdout || '').trim();
      if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return reject(safeError('Windows SSO helper returned an invalid Negotiate token'));
      if (tokenLooksLikeNtlm(token)) return reject(safeError('Windows SSO helper returned an NTLM token. ADT SSO requires Kerberos/SPNEGO; verify the backend SPN and Kerberos configuration, or rerun sap-ai-dev --setup and choose username/password.'));
      resolve(token);
    });
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

async function acquireNegotiateToken({ targetUrl, challenge, env, execFileImpl }) {
  const helper = helperCommand(env);
  if (!helper) {
    throw safeError('Windows SSO requires an SSPI/Negotiate helper that uses the current Windows logon session (including smart-card-backed logon). Set SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER to a trusted helper executable, or rerun sap-ai-dev --setup and choose username/password. Manual token entry is not supported.');
  }
  return execHelper(helper, { url: targetUrl, challenge, mechanism: 'Negotiate' }, execFileImpl, env);
}

function basicFallbackCredentials(env) {
  const mode = String(env.SAP_AUTH_FALLBACK_MODE || env.SAP_AI_DEV_TOOLKIT_AUTH_FALLBACK_MODE || '').toLowerCase();
  const enabled = mode === 'basic' || env.SAP_AI_DEV_TOOLKIT_SSO_BASIC_FALLBACK === 'true';
  const user = String(env.SAP_USER || env.SAP_USERNAME || '').trim();
  const password = String(env.SAP_PASSWORD || env.SAP_PASS || '');
  if (!enabled || !user || !password) return null;
  return { user, password };
}

function hasBasicChallenge(headers) {
  const value = headers.get?.('www-authenticate') || '';
  return /(?:^|,)\s*Basic\b/i.test(value);
}

async function retryWithBasicFallback({ req, target, headers, body, fetchImpl, env }) {
  const credentials = basicFallbackCredentials(env);
  if (!credentials) return null;
  return forward(req, target, {
    ...headers,
    Authorization: `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`
  }, body, fetchImpl);
}

async function forward(req, targetUrl, headers, body, fetchImpl) {
  return fetchImpl(targetUrl, {
    method: req.method,
    headers,
    body,
    duplex: body ? 'half' : undefined,
    redirect: 'manual'
  });
}

function writeFetchResponse(res, response, base, proxyOrigin) {
  res.writeHead(response.status, response.statusText, copyResponseHeaders(response, { proxyOrigin, targetOrigin: base.origin }));
  if (!response.body) return res.end();
  response.body.pipeTo(new WritableStream({
    write(chunk) { res.write(chunk); },
    close() { res.end(); },
    abort() { res.destroy(); }
  })).catch(() => res.destroy());
}

export async function createWindowsSsoAdtProxy({ destinationUrl, env = process.env, fetchImpl = globalThis.fetch, execFileImpl = nodeExecFile } = {}) {
  if (process.platform !== 'win32' && env.SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS !== 'true') {
    throw safeError('Windows SSO for local ADT destinations is only supported on Windows');
  }
  if (typeof fetchImpl !== 'function') throw safeError('HTTP fetch implementation is unavailable');
  const base = validateTarget(destinationUrl);
  const sockets = new Set();
  let closed = false;
  let proxyOrigin = '';

  const server = http.createServer(async (req, res) => {
    if (closed) return res.destroy();
    let target;
    try {
      target = new URL(req.url || '/', base);
      if (target.origin !== base.origin) throw safeError('Cross-origin Windows SSO proxy request rejected');
      const headers = headerObject(req.headers);
      const body = await readRequestBody(req);
      let response = await forward(req, target, headers, body, fetchImpl);
      if (response.status === 401 && hasNegotiateChallenge(response.headers)) {
        const challenge = response.headers.get('www-authenticate') || '';
        const cookies = mergeCookieHeader(headers.cookie || headers.Cookie, setCookies(response.headers));
        const cancel = response.body?.cancel?.();
        await cancel?.catch?.(() => {});
        try {
          const token = await acquireNegotiateToken({ targetUrl: target.href, challenge, env, execFileImpl });
          const retryHeaders = { ...headers, Authorization: `Negotiate ${token}` };
          delete retryHeaders.cookie;
          delete retryHeaders.Cookie;
          if (cookies) retryHeaders.Cookie = cookies;
          response = await forward(req, target, retryHeaders, body, fetchImpl);
        } catch (error) {
          response = await retryWithBasicFallback({ req, target, headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) }, body, fetchImpl, env });
          if (!response) throw error;
        }
      } else if (response.status === 401 && hasBasicChallenge(response.headers) && basicFallbackCredentials(env)) {
        const cancel = response.body?.cancel?.();
        await cancel?.catch?.(() => {});
        response = await retryWithBasicFallback({ req, target, headers, body, fetchImpl, env }) || response;
      }
      writeFetchResponse(res, response, base, proxyOrigin);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        res.end(`${error.message || 'Windows SSO proxy request failed'}\n`);
      } else {
        res.destroy();
      }
    }
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  proxyOrigin = `http://127.0.0.1:${address.port}`;
  return {
    url: proxyOrigin,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close').catch(() => {});
    }
  };
}
