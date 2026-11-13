// SAP Build Process Automation service-key / OAuth client configuration.
// Pure: no I/O, no network. Two auth modes: 'technical' (service-key client
// credentials) and 'interactive' (authorization code + refresh token with the
// same service-key client, so actions are attributed to the signed-in user).
import { finalizeClientCredentials } from './integration-config.mjs';

const BASE_KEYS = ['PROCESS_AUTOMATION_URL', 'PROCESS_AUTOMATION_TOKEN_URL', 'PROCESS_AUTOMATION_CLIENT_ID', 'PROCESS_AUTOMATION_CLIENT_SECRET'];

export const PROCESS_AUTOMATION_OAUTH = Object.freeze({
  product: 'SAP Build Process Automation',
  setupCommand: 'sap-ai-dev --setup-process-automation',
  sacCustomAuth: false
});

function fail(message) {
  throw new Error(message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse a process-automation-service key (JSON text or object, optionally wrapped
 * as `cf service-key --json` output) into `{ url, tokenUrl, clientId, clientSecret }`.
 */
export function parseProcessAutomationServiceKey(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail('PROCESS_AUTOMATION_SERVICE_KEY is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object') fail('PROCESS_AUTOMATION_SERVICE_KEY is not valid JSON');
  const key = parsed.credentials ?? parsed.service_key?.credentials ?? parsed;
  let api = text(key?.endpoints?.api);
  if (!api) {
    fail('PROCESS_AUTOMATION_SERVICE_KEY has no endpoints.api; use a service key of the SAP Build Process Automation instance (process-automation-service)');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(api)) api = `https://${api}`;
  const uaa = key.uaa ?? {};
  if (!text(uaa.clientsecret) && (uaa.certificate || uaa.key)) {
    fail('PROCESS_AUTOMATION_SERVICE_KEY is a certificate-based key; create a service key with client secret credentials');
  }
  const missing = ['url', 'clientid', 'clientsecret'].filter(field => !text(uaa[field])).map(field => `uaa.${field}`);
  if (missing.length) fail(`PROCESS_AUTOMATION_SERVICE_KEY is missing ${missing.join(', ')}`);
  return { url: api, tokenUrl: text(uaa.url), clientId: text(uaa.clientid), clientSecret: text(uaa.clientsecret) };
}

const ENVIRONMENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** Optional environment-scoped API key (Control Tower > Environments > API Keys) and default environment. */
function parseOptionalAccess(raw) {
  const apiKey = text(raw?.apiKey);
  if (apiKey && (apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey))) fail('PROCESS_AUTOMATION_API_KEY must be a single printable token');
  const environmentId = text(raw?.environmentId);
  if (environmentId && !ENVIRONMENT_ID.test(environmentId)) fail('PROCESS_AUTOMATION_ENVIRONMENT_ID must be 1-128 letters, digits, dots, dashes or underscores');
  return { apiKey: apiKey || null, environmentId: environmentId || null };
}

/**
 * Validate raw credentials into a frozen config.
 * `raw = { auth, url, tokenUrl, clientId, clientSecret, refreshToken?, apiKey?, environmentId? }`.
 */
export function parseProcessAutomationCredentials(raw, source) {
  const auth = text(raw?.auth) || 'technical';
  if (auth !== 'technical' && auth !== 'interactive') fail('PROCESS_AUTOMATION_AUTH must be technical or interactive');
  const clientId = text(raw?.clientId);
  const clientSecret = text(raw?.clientSecret);
  if (!clientId || !clientSecret) fail('PROCESS_AUTOMATION_CLIENT_ID and PROCESS_AUTOMATION_CLIENT_SECRET are required');
  const base = finalizeClientCredentials('PROCESS_AUTOMATION', source, {
    url: text(raw?.url),
    tokenUrl: text(raw?.tokenUrl),
    clientId,
    clientSecret
  });
  let authorizationUrl = null;
  let refreshToken = null;
  if (auth === 'interactive') {
    authorizationUrl = `${new URL(base.tokenUrl).origin}/oauth/authorize`;
    refreshToken = text(raw?.refreshToken);
    if (!refreshToken) fail('PROCESS_AUTOMATION_REFRESH_TOKEN is required for interactive sign-in; run sap-ai-dev --setup-process-automation');
  }
  return Object.freeze({
    source,
    auth,
    url: base.url,
    tokenUrl: base.tokenUrl,
    clientId: base.clientId,
    clientSecret: base.clientSecret,
    authorizationUrl,
    refreshToken,
    ...parseOptionalAccess(raw)
  });
}

/**
 * Resolve credentials: explicit PROCESS_AUTOMATION_* variables, then
 * PROCESS_AUTOMATION_SERVICE_KEY, then the record stored by
 * `sap-ai-dev --setup-process-automation`. PROCESS_AUTOMATION_API_KEY and
 * PROCESS_AUTOMATION_ENVIRONMENT_ID always win over stored values.
 */
export function resolveProcessAutomationConfig(env = process.env, { stored } = {}) {
  if (BASE_KEYS.some(key => env[key] !== undefined && env[key] !== '')) {
    const missing = BASE_KEYS.filter(key => !text(env[key]));
    if (missing.length) fail(`Explicit PROCESS_AUTOMATION configuration is incomplete: ${missing.join(', ')}`);
    return parseProcessAutomationCredentials({
      auth: env.PROCESS_AUTOMATION_AUTH,
      url: env.PROCESS_AUTOMATION_URL,
      tokenUrl: env.PROCESS_AUTOMATION_TOKEN_URL,
      clientId: env.PROCESS_AUTOMATION_CLIENT_ID,
      clientSecret: env.PROCESS_AUTOMATION_CLIENT_SECRET,
      refreshToken: env.PROCESS_AUTOMATION_REFRESH_TOKEN,
      apiKey: env.PROCESS_AUTOMATION_API_KEY,
      environmentId: env.PROCESS_AUTOMATION_ENVIRONMENT_ID
    }, 'environment');
  }
  if (text(env.PROCESS_AUTOMATION_SERVICE_KEY)) {
    return parseProcessAutomationCredentials({
      auth: env.PROCESS_AUTOMATION_AUTH,
      ...parseProcessAutomationServiceKey(env.PROCESS_AUTOMATION_SERVICE_KEY),
      refreshToken: env.PROCESS_AUTOMATION_REFRESH_TOKEN,
      apiKey: env.PROCESS_AUTOMATION_API_KEY,
      environmentId: env.PROCESS_AUTOMATION_ENVIRONMENT_ID
    }, 'service-key');
  }
  if (stored) {
    return parseProcessAutomationCredentials({
      auth: stored.auth,
      url: stored.url,
      tokenUrl: stored.tokenurl,
      clientId: stored.clientid,
      clientSecret: stored.clientsecret,
      refreshToken: stored.refreshtoken,
      apiKey: text(env.PROCESS_AUTOMATION_API_KEY) || stored.apikey,
      environmentId: text(env.PROCESS_AUTOMATION_ENVIRONMENT_ID) || stored.environmentid
    }, 'stored-key');
  }
  return fail('Configure SAP Build Process Automation (PROCESS_AUTOMATION_SERVICE_KEY, or PROCESS_AUTOMATION_URL/PROCESS_AUTOMATION_TOKEN_URL/PROCESS_AUTOMATION_CLIENT_ID/PROCESS_AUTOMATION_CLIENT_SECRET) in the MCP host environment, or run sap-ai-dev --setup-process-automation.');
}
