import { z } from 'zod';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { apiProxyRuntimeUrl } from './apim-content.mjs';
import { READ_ONLY_ANNOTATIONS, entity, key, list, metadataSummary } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';
import { bundleJwtIssuers } from './apim-bundle.mjs';
import { serviceKeyCredentials } from './cf-destination.mjs';
import { readBundle } from './iflow-bundle.mjs';

const APIM_BASE = '/apiportal/api/1.0/Management.svc';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function responseText(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) throw new IntegrationError('API response exceeded the safe size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

/** Execute a bounded API read with exactly one credential retained only in memory. */
export async function runApiProxyGet({ apim, consumerKey, bearerToken, proxyName, path, query = {}, env = process.env, fetchImpl = undiciFetch }) {
  if (!apim) throw new IntegrationError('Configure APIM credentials to resolve the deployed API proxy before testing it');
  const credentials = [consumerKey, bearerToken].filter(value => value !== undefined);
  if (credentials.length !== 1 || typeof credentials[0] !== 'string' || !credentials[0] || /[\r\n]/.test(credentials[0])) {
    throw new IntegrationError('Provide exactly one private consumer API key or bearer token');
  }
  const safeResult = value => redactPrivateValues(value, credentials);
  if (!/^\/(?:\$metadata|[A-Za-z_][A-Za-z0-9_]*)$/.test(path)) {
    throw new IntegrationError('API read path must be /$metadata or one entity set; navigation, encoded paths and query strings are not allowed');
  }
  for (const name of Object.keys(query)) {
    if (!['$top', '$select', '$filter'].includes(name)) throw new IntegrationError('Only $top, $select and $filter are allowed for API reads');
  }
  const metadata = path === '/$metadata';
  if (metadata && Object.keys(query).length) throw new IntegrationError('Metadata reads do not accept entity query options');
  const top = Number(query.$top ?? 1);
  if (!metadata && (!Number.isInteger(top) || top < 1 || top > 10)) throw new IntegrationError('API reads require $top between 1 and 10');
  const proxy = await apim.request('GET', `${APIM_BASE}/APIProxies(${key(proxyName)})`, {
    query: { $expand: 'proxyEndPoints,proxyEndPoints/virtualhosts,deploymentInfo' }
  });
  if (proxy?.state !== 'DEPLOYED') throw new IntegrationError('The API proxy is not deployed');
  let defaultHost = null;
  if (!list(list(proxy?.proxyEndPoints)[0]?.virtualhosts).length) {
    defaultHost = list(await apim.request('GET', `${APIM_BASE}/VirtualHosts`, { query: { $filter: 'isDefault eq true' } }))[0];
  }
  const runtime = apiProxyRuntimeUrl(proxy, defaultHost);
  if (!runtime) throw new IntegrationError('The API proxy has no runtime URL');
  const base = new URL(runtime);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new IntegrationError('API smoke requests require a credential-free HTTPS runtime URL from API Management');
  }
  const target = new URL(base.href);
  target.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, String(value));
  if (!metadata) target.searchParams.set('$top', String(top));
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
  const dispatcher = httpProxy || httpsProxy
    ? new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env.NO_PROXY || env.no_proxy })
    : undefined;
  try {
    let response;
    try {
      response = await fetchImpl(target.href, {
        method: 'GET',
        headers: { ...(bearerToken === undefined ? { apikey: consumerKey } : { authorization: `Bearer ${bearerToken}` }), accept: metadata ? 'application/xml' : 'application/json', 'accept-encoding': 'gzip, deflate' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
        ...(dispatcher ? { dispatcher } : {})
      });
    } catch {
      throw new IntegrationError('API proxy GET failed (network error or timeout); credentials were not returned');
    }
    const status = response.status;
    if (status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new IntegrationError(`API proxy GET failed (HTTP ${status}); response body withheld to protect credentials; redirects are not followed`);
    }
    let text;
    try {
      text = await responseText(response);
    } catch {
      throw new IntegrationError('API response could not be read within the safe size limit; response withheld');
    }
    const result = { proxy: proxyName, runtime_url: base.href, path, status, content_type: response.headers.get('content-type') };
    if (metadata) {
      if (!/<(?:\w+:)?Edmx\b/.test(text)) throw new IntegrationError('API proxy returned HTTP 200 but not an OData metadata document');
      return safeResult({ ...result, metadata: metadataSummary(text) });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new IntegrationError('API proxy returned HTTP 200 but not JSON');
    }
    const rows = data?.d?.results ?? data?.value;
    if (!Array.isArray(rows)) throw new IntegrationError('API proxy response is not an OData entity collection');
    if (rows.length > top) throw new IntegrationError('API proxy did not honor the bounded $top request');
    return safeResult({ ...result, returned: rows.length, fields: [...new Set(rows.flatMap(row => Object.keys(entity(row) ?? {})))] });
  } finally {
    await dispatcher?.close();
  }
}

/** Redact private values without replacing JSON syntax or corrupting scalar literals. */
export function redactPrivateValues(value, secrets) {
  const privateValues = [...new Set(secrets)].filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length);
  const redactText = text => {
    for (const secret of privateValues) text = text.replaceAll(secret, '[redacted]');
    return text;
  };
  const redact = entry => {
    if (Array.isArray(entry)) return entry.map(redact);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([name, value]) => [redactText(name), redact(value)]));
    }
    if (typeof entry === 'string') return redactText(entry);
    if (entry === undefined) return entry;
    const text = String(entry);
    const redacted = redactText(text);
    return redacted === text ? entry : redacted;
  };
  return redact(value);
}

function oauthEndpoint(credentials) {
  const auth = credentials?.uaa ?? credentials?.oauth ?? credentials;
  const clientId = auth?.clientid ?? auth?.client_id;
  const clientSecret = auth?.clientsecret ?? auth?.client_secret;
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
    throw new IntegrationError('OAuth probing requires a client ID and client secret; certificate-only service keys are not supported');
  }
  const address = auth.tokenurl ?? auth.token_url ?? auth.url;
  let url;
  try {
    if (typeof address !== 'string' || /[\s@?#]/.test(address)) throw new Error();
    url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    if (url.pathname === '/') url.pathname = '/oauth/token';
    if (url.pathname !== '/oauth/token') throw new Error();
  } catch {
    throw new IntegrationError('OAuth service key requires a credential-free HTTPS /oauth/token endpoint without a query or fragment');
  }
  return { url, clientId, clientSecret };
}

/** Acquire a narrowly scoped XSUAA token only after pinning its endpoint to fresh proxy policy. */
export async function runApiProxyOAuthGet({ apim, oauth, proxyName, path, query, env = process.env, fetchImpl = undiciFetch, execFileImpl }) {
  if (!oauth || typeof oauth.scope !== 'string' || !oauth.scope || oauth.scope.length > 512 || /[\s\x00-\x1f\x7f]/.test(oauth.scope)) {
    throw new IntegrationError('OAuth probing requires exactly one nonempty whitespace-free scope');
  }
  for (const reference of [oauth.service_instance, oauth.service_key]) {
    if (typeof reference !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/.test(reference)) {
      throw new IntegrationError('OAuth probing requires CF service instance and service key names, not credentials');
    }
  }
  if (!apim) throw new IntegrationError('Configure APIM credentials before OAuth probing');
  const bundle = await apim.request('GET', '/apiportal/api/1.0/Transport.svc/APIProxies', {
    query: { name: proxyName }, accept: 'application/zip, application/octet-stream', responseType: 'bytes'
  });
  let issuers;
  try {
    issuers = bundleJwtIssuers(readBundle(bundle), proxyName);
  } catch {
    throw new IntegrationError('The selected proxy bundle could not be inspected for an explicit VerifyJWT issuer');
  }
  if (!issuers.length) throw new IntegrationError('The selected proxy has no explicit HTTPS VerifyJWT issuer for OAuth probing');
  let credentials;
  try {
    credentials = await serviceKeyCredentials(oauth.service_instance, oauth.service_key, 'OAuth', { env, execFileImpl });
  } catch {
    throw new IntegrationError('The referenced CF OAuth service key could not be read; credential details withheld');
  }
  const { url, clientId, clientSecret } = oauthEndpoint(credentials);
  if (!issuers.some(issuer => new URL(issuer).href === url.href)) {
    throw new IntegrationError('The OAuth token endpoint does not match an explicit VerifyJWT issuer of the selected proxy; no credentials were sent');
  }
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
  const dispatcher = httpProxy || httpsProxy
    ? new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env.NO_PROXY || env.no_proxy })
    : undefined;
  let bearerToken;
  try {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'accept-encoding': 'gzip, deflate' },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: oauth.scope }).toString(),
        redirect: 'manual', signal: AbortSignal.timeout(30000),
        ...(dispatcher ? { dispatcher } : {})
      });
    } catch {
      throw new IntegrationError('OAuth token request failed (network error or timeout); credential details withheld');
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new IntegrationError(`OAuth token request failed (HTTP ${response.status}); response withheld; redirects are not followed`);
    }
    let token;
    try {
      token = JSON.parse(await responseText(response));
    } catch {
      throw new IntegrationError('OAuth token response was unreadable or invalid; response withheld');
    }
    if (typeof token?.access_token !== 'string' || !token.access_token || /[\s\x00-\x1f\x7f]/.test(token.access_token) || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') {
      throw new IntegrationError('OAuth token response did not contain a usable bearer token; response withheld');
    }
    if (token.scope !== undefined && (typeof token.scope !== 'string' || token.scope.trim() !== oauth.scope)) {
      throw new IntegrationError('OAuth token response did not grant exactly the requested scope; response withheld');
    }
    bearerToken = token.access_token;
  } finally {
    await dispatcher?.close();
  }
  const result = await runApiProxyGet({ apim, bearerToken, proxyName, path, query, env, fetchImpl });
  return redactPrivateValues(result, [clientId, clientSecret, bearerToken]);
}

/** The APIM runtime surface is available without Developer Hub; API-key mode alone requires it. */
export function registerApimRuntimeTools(register, { apim, devhub, env, fetchImpl, execFileImpl } = {}) {
  const applicationId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
  const proxyName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
  async function getApplication(id) {
    if (!devhub) throw new IntegrationError('Configure Developer Hub credentials to use application_id API-key authentication');
    const { status, data } = await devhub.request('GET', `/odata/1.0/data.svc/APIMgmt.Applications(${key(id)})`, {
      query: { $expand: 'ToAPIProductsDetails,ToSubscriptions/ToAPIProduct,ToSubscriptions/ToRatePlan' },
      expect: [200, 404], withStatus: true
    });
    if (status === 404) throw new IntegrationError(`Developer Hub application ${id} does not exist`);
    return data;
  }
  register('apim_test_api', 'Test API with private API-key or OAuth credentials',
    'Execute a GET-only OData metadata or bounded entity read against an APIM-resolved deployed proxy. Supply exactly one authentication source: application_id for a private Developer Hub key (requires DEVHUB), or oauth CF service/key references and one scope for external XSUAA client_credentials (works without DEVHUB). Fresh VerifyJWT issuer pinning precedes credential use. No keys, secrets, tokens, headers or business row values returned; no redirects or arbitrary URLs.',
    {
      application_id: applicationId.optional(),
      oauth: z.object({
        service_instance: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/),
        service_key: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/),
        scope: z.string().min(1).max(512).regex(/^[^\s\x00-\x1f\x7f]+$/)
      }).strict().optional(),
      proxy_name: proxyName,
      path: z.string().regex(/^\/(?:\$metadata|[A-Za-z_][A-Za-z0-9_]*)$/),
      query: z.object({
        $top: z.number().int().min(1).max(10).optional(),
        $select: z.string().min(1).max(1024).optional(),
        $filter: z.string().min(1).max(2048).optional()
      }).strict().optional()
    }, READ_ONLY_ANNOTATIONS,
    async ({ application_id, oauth, proxy_name, path, query }) => {
      if ((application_id !== undefined) === (oauth !== undefined)) throw new IntegrationError('Provide exactly one authentication source: application_id or oauth');
      if (oauth !== undefined) return runApiProxyOAuthGet({ apim, oauth, proxyName: proxy_name, path, query, env, fetchImpl, execFileImpl });
      const application = await getApplication(application_id);
      const result = await runApiProxyGet({ apim, consumerKey: application?.app_key, proxyName: proxy_name, path, query, env, fetchImpl });
      return redactPrivateValues({ application_id, ...result }, [application?.app_key, application?.app_secret]);
    });
}
