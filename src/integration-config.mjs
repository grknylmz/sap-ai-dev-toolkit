// Resolves CPI (Cloud Integration) and APIM (API Management) OAuth client
// credentials from the MCP host environment. Pure: no I/O, no network.
// Every error message starts with a stable prefix (Explicit CPI/APIM, CPI_,
// APIM_, No CPI/APIM, Multiple CPI/APIM, Configure CPI) so the tool layer
// can surface it verbatim; no message ever echoes a secret value.

const SIDES = Object.freeze({
  CPI: Object.freeze({ prefix: 'CPI', defaultVcapService: 'it-rt' }),
  APIM: Object.freeze({ prefix: 'APIM', defaultVcapService: 'apimanagement-apiportal' })
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function fail(message) {
  throw new Error(message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateEndpoint(value, prefix, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${prefix}_${label} is not a valid URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${prefix}_${label} must not contain credentials, a query, or a fragment`);
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    fail(`${prefix}_${label} must use https`);
  }
  return parsed;
}

function finalize(prefix, source, bindingName, raw) {
  const url = validateEndpoint(raw.url, prefix, 'URL').href.replace(/\/+$/, '');
  const token = validateEndpoint(raw.tokenUrl, prefix, 'TOKEN_URL');
  if (!/\/oauth\/token$/.test(token.pathname)) {
    token.pathname = `${token.pathname.replace(/\/+$/, '')}/oauth/token`;
  }
  return Object.freeze({
    source,
    bindingName: bindingName || null,
    url,
    tokenUrl: token.href,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret
  });
}

function explicitConfig(env, prefix) {
  const keys = [`${prefix}_URL`, `${prefix}_TOKEN_URL`, `${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`];
  if (!keys.some(key => env[key] !== undefined && env[key] !== '')) return null;
  const missing = keys.filter(key => !text(env[key]));
  if (missing.length) fail(`Explicit ${prefix} configuration is incomplete: ${missing.join(', ')}`);
  return finalize(prefix, 'environment', null, {
    url: text(env[`${prefix}_URL`]),
    tokenUrl: text(env[`${prefix}_TOKEN_URL`]),
    clientId: text(env[`${prefix}_CLIENT_ID`]),
    clientSecret: text(env[`${prefix}_CLIENT_SECRET`])
  });
}

/** Parse a CPI/APIM service key (nested `oauth` or flat APIM shape) into raw OAuth fields. */
function parseServiceKey(value, origin) {
  let key = value;
  if (typeof value === 'string') {
    try {
      key = JSON.parse(value);
    } catch {
      fail(`${origin} is not valid JSON`);
    }
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) fail(`${origin} must be a JSON object`);
  const oauth = key.oauth && typeof key.oauth === 'object' && !Array.isArray(key.oauth) ? key.oauth : key;
  const raw = {
    url: text(oauth.url),
    tokenUrl: text(oauth.tokenurl) || text(oauth.tokenUrl),
    clientId: text(oauth.clientid) || text(oauth.clientId),
    clientSecret: text(oauth.clientsecret) || text(oauth.clientSecret)
  };
  if (!raw.clientSecret && (oauth.certificate || oauth.key || oauth.privateKey || key.certificate || key.key || key.privateKey)) {
    fail(`${origin} is a certificate-based key; create a ClientId/Secret service key`);
  }
  const missing = Object.entries({ url: raw.url, tokenurl: raw.tokenUrl, clientid: raw.clientId, clientsecret: raw.clientSecret })
    .filter(([, entry]) => !entry)
    .map(([name]) => name);
  if (missing.length) fail(`${origin} is missing ${missing.join(', ')}`);
  return raw;
}

function serviceKeyConfig(env, prefix) {
  const value = env[`${prefix}_SERVICE_KEY`];
  if (value === undefined || value === '') return null;
  return finalize(prefix, 'service-key', null, parseServiceKey(value, `${prefix}_SERVICE_KEY`));
}

function vcapConfig(env, prefix, defaultVcapService) {
  const raw = env.VCAP_SERVICES;
  const bindingName = text(env[`${prefix}_BINDING`]);
  if (!raw) {
    if (bindingName) fail(`No ${prefix} VCAP_SERVICES binding matches ${prefix}_BINDING`);
    return null;
  }
  let services;
  try {
    services = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    fail(`${prefix}_VCAP_SERVICE lookup failed: VCAP_SERVICES is not valid JSON`);
  }
  const label = text(env[`${prefix}_VCAP_SERVICE`]) || defaultVcapService;
  const instances = services && typeof services === 'object' && Array.isArray(services[label]) ? services[label] : [];
  let candidates = instances.filter(instance => instance && typeof instance === 'object' && !Array.isArray(instance));
  if (bindingName) {
    candidates = candidates.filter(instance => (instance.name || instance.binding_name) === bindingName);
    if (!candidates.length) fail(`No ${prefix} VCAP_SERVICES binding matches ${prefix}_BINDING`);
  }
  if (!candidates.length) return null;
  if (candidates.length > 1) fail(`Multiple ${prefix} VCAP_SERVICES bindings; set ${prefix}_BINDING`);
  const [instance] = candidates;
  const name = instance.name || instance.binding_name;
  const origin = `${prefix}_VCAP_SERVICE binding credentials`;
  return finalize(prefix, 'vcap-services', typeof name === 'string' ? name : null, parseServiceKey(instance.credentials, origin));
}

function storedConfig(stored, prefix) {
  const key = stored?.[prefix.toLowerCase()];
  if (key === undefined || key === null) return null;
  return finalize(prefix, 'stored-key', null, parseServiceKey(key, `Stored ${prefix} service key`));
}

// Precedence: explicit variables, *_SERVICE_KEY, VCAP_SERVICES, then the key stored by `sap-ai-dev --setup-integration`.
function resolveSide(env, { prefix, defaultVcapService }, stored) {
  return explicitConfig(env, prefix)
    ?? serviceKeyConfig(env, prefix)
    ?? vcapConfig(env, prefix, defaultVcapService)
    ?? storedConfig(stored, prefix);
}

/** Resolve one side from the environment only (no stored key); null when that side is not configured there. */
export function resolveIntegrationSideFromEnvironment(env, side) {
  return resolveSide(env, SIDES[side]);
}

/** Validate a pasted CPI/APIM service key (JSON text or object); returns the resolved side config. */
export function parseIntegrationServiceKey(side, value) {
  return finalize(side, 'stored-key', null, parseServiceKey(value, `${side} service key`));
}

/**
 * Resolve CPI and APIM client credentials; at least one side must be configured.
 * `stored` holds service keys saved by the setup wizard ({ cpi, apim }) and has the lowest precedence.
 */
export function resolveIntegrationConfig(env = process.env, { stored } = {}) {
  const cpi = resolveSide(env, SIDES.CPI, stored);
  const apim = resolveSide(env, SIDES.APIM, stored);
  if (!cpi && !apim) {
    fail('Configure CPI (CPI_SERVICE_KEY or CPI_URL/CPI_TOKEN_URL/CPI_CLIENT_ID/CPI_CLIENT_SECRET) and/or APIM (APIM_SERVICE_KEY or APIM_*) credentials in the MCP host environment, or run sap-ai-dev --setup-integration to paste and verify service keys.');
  }
  return Object.freeze({ cpi, apim });
}

export const INTEGRATION_CONFIG_ERROR = /^(?:Explicit CPI|Explicit APIM|CPI_|APIM_|No CPI|No APIM|Multiple CPI|Multiple APIM|Configure CPI|Stored (?:CPI|APIM)|Stored Integration Suite)/;
