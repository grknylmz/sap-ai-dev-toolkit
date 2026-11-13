// XSUAA OAuth helpers: token requests (SAP Datasphere's x-sap-sac-custom-auth
// convention by default; other XSUAA products through `profile`), an interactive
// (authorization code + refresh token) provider, and the localhost
// authorization-code login used by the sap-ai-dev setup wizards.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { IntegrationError, readCapped } from './integration-http.mjs';

const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_MAX_BYTES = 64 * 1024;
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

/** Product profile: names in messages, the setup command, and whether the SAC custom-auth convention applies. */
export const DATASPHERE_OAUTH = Object.freeze({ product: 'Datasphere', setupCommand: 'sap-ai-dev --setup-datasphere', sacCustomAuth: true });

function proxyDispatcher(env) {
  const httpProxy = env?.HTTP_PROXY || env?.http_proxy;
  const httpsProxy = env?.HTTPS_PROXY || env?.https_proxy;
  if (!httpProxy && !httpsProxy) return undefined;
  return new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env?.NO_PROXY || env?.no_proxy });
}

/**
 * POST the tenant token endpoint (Basic auth, form encoded). Custom `sb-` clients
 * send no client_id in the body and require x-sap-sac-custom-auth; the response
 * body is never surfaced. Returns { accessToken, refreshToken, expiresAt }.
 */
export async function requestDatasphereToken({
  tokenUrl,
  clientId,
  clientSecret,
  form,
  fetchImpl = undiciFetch,
  env = process.env,
  timeoutMs = TOKEN_TIMEOUT_MS,
  now = Date.now,
  profile = DATASPHERE_OAUTH
}) {
  const body = profile.sacCustomAuth
    ? new URLSearchParams({
      ...form,
      response_type: 'token',
      ...(clientId.startsWith('sb-') ? {} : { client_id: clientId })
    })
    : new URLSearchParams(form);
  const controller = new AbortController();
  const dispatcher = proxyDispatcher(env);
  let timer;
  try {
    const request = async () => {
      const response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          ...(profile.sacCustomAuth && clientId.startsWith('sb-') ? { 'x-sap-sac-custom-auth': 'true' } : {})
        },
        body: body.toString(),
        redirect: 'manual',
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      });
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => {});
        throw new IntegrationError(`${profile.product} token request failed (HTTP ${response.status})`);
      }
      const bytes = await readCapped(response, TOKEN_MAX_BYTES, `${profile.product} token`, controller.signal);
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new IntegrationError(`${profile.product} token response was not valid JSON`);
      }
      if (typeof payload?.access_token !== 'string' || !payload.access_token) throw new IntegrationError(`${profile.product} token response contained no access token`);
      const expiresInSeconds = Number(payload.expires_in);
      return {
        accessToken: payload.access_token,
        refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : undefined,
        expiresAt: now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 0) * 1000
      };
    };
    return await Promise.race([
      request(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new IntegrationError(`${profile.product} token request failed (timeout)`));
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(`${profile.product} token request failed (${error?.name === 'AbortError' ? 'timeout' : 'network error'})`);
  } finally {
    clearTimeout(timer);
    void dispatcher?.close().catch(() => {});
  }
}

/**
 * Single-flight token provider: technical clients use client_credentials;
 * interactive clients refresh via grant_type=refresh_token
 * when no token is cached or it expires within 15 minutes, keeps a rotated
 * refresh token in memory, and hands it to persistRefreshToken.
 */
export function createDatasphereTokenProvider({ config, persistRefreshToken, fetchImpl, env = process.env, now = Date.now, profile = DATASPHERE_OAUTH }) {
  let current = null;
  let refreshPromise = null;
  const interactive = config.auth !== 'technical';
  const sessionExpired = `${profile.product} interactive session expired or was revoked; rerun ${profile.setupCommand} to sign in again.`;

  const refresh = async () => {
    const refreshToken = current?.refreshToken || config.refreshToken;
    if (interactive && !refreshToken) {
      throw new IntegrationError(sessionExpired);
    }
    try {
      const token = await requestDatasphereToken({
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        form: interactive
          ? { grant_type: 'refresh_token', refresh_token: refreshToken }
          : { grant_type: 'client_credentials' },
        ...(fetchImpl ? { fetchImpl } : {}),
        env,
        now,
        profile
      });
      current = { ...token, refreshToken: token.refreshToken || refreshToken };
      if (token.refreshToken && token.refreshToken !== refreshToken && persistRefreshToken) {
        await persistRefreshToken(token.refreshToken);
      }
      return current;
    } catch (error) {
      if (!interactive) throw error;
      if (error instanceof IntegrationError && error.message.startsWith(`${profile.product} interactive session`)) throw error;
      throw new IntegrationError(sessionExpired);
    }
  };

  return {
    async token() {
      if (current && current.expiresAt - now() >= REFRESH_MARGIN_MS) return current;
      if (!refreshPromise) {
        refreshPromise = refresh().finally(() => {
          refreshPromise = null;
        });
      }
      return refreshPromise;
    }
  };
}

export const createInteractiveTokenProvider = createDatasphereTokenProvider;

/** Best-effort platform browser open; every failure is ignored. */
export function openInBrowser(url, { execFileImpl = execFile } = {}) {
  const platform = process.platform;
  if (platform === 'darwin') execFileImpl('open', [url], () => {});
  else if (platform === 'win32') execFileImpl('cmd', ['/c', 'start', '', url], () => {});
  else execFileImpl('xdg-open', [url], () => {});
}

function extractCode(text, state, product) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  let url;
  try { url = new URL(trimmed); } catch { return trimmed; }
  if (url.searchParams.get('state') !== state) throw new IntegrationError(`${product} sign-in callback state did not match this login.`);
  if (url.searchParams.has('error')) throw new IntegrationError(`${product} sign-in was denied or failed.`);
  return url.searchParams.get('code') || '';
}

/**
 * Interactive sign-in: build the authorize URL, capture the redirect `code`
 * (browser mode on localhost:<port>, or a pasted URL/code), and exchange it.
 */
export async function authorizationCodeLogin({
  config,
  mode,
  port = 8080,
  openUrl,
  promptPaste,
  timeoutMs = 120_000,
  fetchImpl,
  env = process.env,
  now = Date.now,
  profile = DATASPHERE_OAUTH
}) {
  const product = profile.product;
  const state = randomBytes(32).toString('hex');
  const authorize = new URL(config.authorizationUrl);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('state', state);
  const authorizeUrl = authorize.href;
  const openAuthorizationUrl = () => {
    try {
      const opened = openUrl?.(authorizeUrl);
      if (opened && typeof opened.then === 'function') opened.catch(() => {});
    } catch {
      // Opening the browser is best-effort; the caller can print the URL.
    }
  };
  let code;
  if (mode === 'browser') {
    const server = createServer((request, response) => {
      const callback = new URL(request.url || '/', `http://localhost:${port}`);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      if (request.method !== 'GET' || callback.pathname !== '/') {
        response.writeHead(404);
        response.end('Not found.');
        return;
      }
      if (callback.searchParams.get('state') !== state) {
        response.writeHead(400);
        response.end(`This callback does not belong to the current ${product} login.`);
        return;
      }
      if (callback.searchParams.has('error')) {
        response.writeHead(400);
        response.end(`${product} sign-in was denied or failed. Return to your terminal.`);
        server.emit('datasphere-code', new IntegrationError(`${product} sign-in was denied or failed.`));
        return;
      }
      const query = callback.searchParams.get('code');
      if (!query) {
        response.writeHead(400);
        response.end(`No ${product} authorization code was received.`);
        return;
      }
      response.writeHead(200);
      response.end(`<!doctype html><html><body><p>Authorization received. Return to your terminal to confirm the ${product} connection.</p></body></html>`);
      server.emit('datasphere-code', query);
    });
    try {
      code = await new Promise((resolve, reject) => {
        const finish = (error, value) => {
          clearTimeout(timer);
          server.removeListener('datasphere-code', onCode);
          if (error) reject(error);
          else resolve(value);
        };
        const onCode = value => value instanceof Error ? finish(value) : finish(null, value);
        const timer = setTimeout(
          () => finish(new IntegrationError(`No authorization code arrived within ${Math.round(timeoutMs / 1000)} s. Check that the OAuth client redirect URI is http://localhost:${port}.`)),
          timeoutMs
        );
        server.on('datasphere-code', onCode);
        server.on('error', error => finish(new IntegrationError(`${product} local login server could not listen on localhost:${port}: ${error?.code || 'error'}`)));
        server.listen(port, 'localhost', openAuthorizationUrl);
      });
    } finally {
      await new Promise(resolve => server.close(resolve)).catch(() => {});
    }
  } else if (mode === 'paste') {
    if (typeof promptPaste !== 'function') throw new IntegrationError(`${product} paste sign-in needs a prompt`);
    openAuthorizationUrl();
    code = extractCode(await promptPaste(), state, product);
  } else {
    throw new IntegrationError(`${product} sign-in mode must be browser or paste`);
  }
  if (!code) throw new IntegrationError('No authorization code was found in the pasted URL or text.');
  return requestDatasphereToken({
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    form: { grant_type: 'authorization_code', code },
    ...(fetchImpl ? { fetchImpl } : {}),
    env,
    now,
    profile
  });
}
