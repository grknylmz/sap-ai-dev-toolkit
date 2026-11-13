// SAP Cloud ALM API service-key / OAuth client configuration.
// Pure: no I/O, no network. SAP documents only client credentials for the
// Cloud ALM API, so there is no interactive mode or refresh token.
import { finalizeClientCredentials } from './integration-config.mjs';

const BASE_KEYS = ['CLOUD_ALM_URL', 'CLOUD_ALM_TOKEN_URL', 'CLOUD_ALM_CLIENT_ID', 'CLOUD_ALM_CLIENT_SECRET'];

function fail(message) {
  throw new Error(message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse a "SAP Cloud ALM API" service key (JSON text or object, optionally wrapped
 * as `cf service-key --json` output) into `{ url, tokenUrl, clientId, clientSecret }`.
 */
export function parseCloudAlmServiceKey(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail('CLOUD_ALM_SERVICE_KEY is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object') fail('CLOUD_ALM_SERVICE_KEY is not valid JSON');
  const key = parsed.credentials ?? parsed.service_key?.credentials ?? parsed;
  let api = text(key?.endpoints?.Api) || text(key?.endpoints?.api);
  if (!api) {
    fail('CLOUD_ALM_SERVICE_KEY has no endpoints.Api; use a service key of the "SAP Cloud ALM API" instance (plan standard) from your Cloud ALM subaccount');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(api)) api = `https://${api}`;
  const uaa = key.uaa ?? {};
  if (!text(uaa.clientsecret) && (uaa.certificate || uaa.key)) {
    fail('CLOUD_ALM_SERVICE_KEY is a certificate (x509) binding; create a binding with client secret credentials (credential type binding-secret)');
  }
  const missing = ['url', 'clientid', 'clientsecret'].filter(field => !text(uaa[field])).map(field => `uaa.${field}`);
  if (missing.length) fail(`CLOUD_ALM_SERVICE_KEY is missing ${missing.join(', ')}`);
  return { url: api, tokenUrl: text(uaa.url), clientId: text(uaa.clientid), clientSecret: text(uaa.clientsecret) };
}

/** Validate raw credentials `{ url, tokenUrl, clientId, clientSecret }` into a frozen config. */
export function parseCloudAlmCredentials(raw, source) {
  const clientId = text(raw?.clientId);
  const clientSecret = text(raw?.clientSecret);
  if (!clientId || !clientSecret) fail('CLOUD_ALM_CLIENT_ID and CLOUD_ALM_CLIENT_SECRET are required');
  const base = finalizeClientCredentials('CLOUD_ALM', source, {
    url: text(raw?.url),
    tokenUrl: text(raw?.tokenUrl),
    clientId,
    clientSecret
  });
  return Object.freeze({
    source,
    url: base.url,
    tokenUrl: base.tokenUrl,
    clientId: base.clientId,
    clientSecret: base.clientSecret
  });
}

/**
 * Resolve credentials: explicit CLOUD_ALM_* variables, then CLOUD_ALM_SERVICE_KEY,
 * then the record stored by `sap-ai-dev --setup-cloud-alm`.
 */
export function resolveCloudAlmConfig(env = process.env, { stored } = {}) {
  if (BASE_KEYS.some(key => env[key] !== undefined && env[key] !== '')) {
    const missing = BASE_KEYS.filter(key => !text(env[key]));
    if (missing.length) fail(`Explicit CLOUD_ALM configuration is incomplete: ${missing.join(', ')}`);
    return parseCloudAlmCredentials({
      url: env.CLOUD_ALM_URL,
      tokenUrl: env.CLOUD_ALM_TOKEN_URL,
      clientId: env.CLOUD_ALM_CLIENT_ID,
      clientSecret: env.CLOUD_ALM_CLIENT_SECRET
    }, 'environment');
  }
  if (text(env.CLOUD_ALM_SERVICE_KEY)) {
    return parseCloudAlmCredentials(parseCloudAlmServiceKey(env.CLOUD_ALM_SERVICE_KEY), 'service-key');
  }
  if (stored) {
    return parseCloudAlmCredentials({
      url: stored.url,
      tokenUrl: stored.tokenurl,
      clientId: stored.clientid,
      clientSecret: stored.clientsecret
    }, 'stored-key');
  }
  return fail('Configure SAP Cloud ALM (CLOUD_ALM_SERVICE_KEY, or CLOUD_ALM_URL/CLOUD_ALM_TOKEN_URL/CLOUD_ALM_CLIENT_ID/CLOUD_ALM_CLIENT_SECRET) in the MCP host environment, or run sap-ai-dev --setup-cloud-alm.');
}
