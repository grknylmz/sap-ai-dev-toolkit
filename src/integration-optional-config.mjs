// Optional service credentials are host/setup inputs, never tool-call inputs.
// Keep this parser independent of the core CPI/APIM/Developer Hub OAuth shapes.
export const OPTIONAL_INPUTS = Object.freeze({
  ctms: Object.freeze({ variable: 'CTMS_SERVICE_KEY', label: 'Cloud Transport Management' }),
  ans: Object.freeze({ variable: 'ANS_CONFIG', label: 'Alert Notification' }),
  event_mesh: Object.freeze({ variable: 'EVENT_MESH_CONFIG', label: 'Event Mesh' }),
  aem: Object.freeze({ variable: 'AEM_CONFIG', label: 'Advanced Event Mesh cloud' }),
  aem_semp: Object.freeze({ variable: 'AEM_SEMP_CONFIG', label: 'Advanced Event Mesh broker SEMP' }),
  open_connectors: Object.freeze({ variable: 'OPEN_CONNECTORS_CONFIG', label: 'Open Connectors' }),
  edge: Object.freeze({ variable: 'EDGE_CONFIG', label: 'Edge Integration Cell' })
});
export const OPTIONAL_COMPONENT_KEYS = Object.freeze(Object.keys(OPTIONAL_INPUTS));

const FIELDS = Object.freeze({
  ctms: ['url', 'tokenUrl', 'clientId', 'clientSecret'],
  ans: ['url', 'username', 'password'],
  event_mesh: ['url', 'tokenUrl', 'clientId', 'clientSecret', 'probeQueueName'],
  aem: ['apiToken'],
  aem_semp: ['url', 'msgVpnName', 'username', 'password'],
  open_connectors: ['url', 'userSecret', 'organizationSecret'],
  edge: ['url', 'clientId', 'clientSecret']
});
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SOURCES = new Set(['environment', 'stored-key', 'setup', 'configuration']);

function invalid(side, detail) {
  // Only fixed field names and messages enter errors; never interpolate supplied values.
  throw new Error(`${OPTIONAL_INPUTS[side].variable}: ${detail}`);
}

function endpoint(side, name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid(side, `${name} must be a valid URL`);
  }
  if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
    invalid(side, `${name} must not contain credentials, a query, or a fragment`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    invalid(side, `${name} must use https`);
  }
  return parsed;
}

/** Resolve a typed optional record. Raw cTMS service keys require explicit host/setup permission. */
export function parseOptionalConfig(side, value, { source = 'configuration', allowRawCtms = false } = {}) {
  if (!OPTIONAL_COMPONENT_KEYS.includes(side)) throw new Error('Unknown optional Integration Suite component');
  let record = value;
  if (typeof record === 'string') {
    if (source === 'stored-key') invalid(side, 'stored configuration must be a normalized object');
    try {
      record = JSON.parse(record);
    } catch {
      invalid(side, 'configuration must be valid JSON');
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) invalid(side, 'configuration must be an object');
  if (side === 'ctms' && allowRawCtms && ['environment', 'setup'].includes(source) && Object.hasOwn(record, 'uri')) {
    record = { url: record.uri, tokenUrl: record.uaa?.url, clientId: record.uaa?.clientid, clientSecret: record.uaa?.clientsecret };
  }
  const fields = FIELDS[side];
  if (Object.keys(record).some(key => !fields.includes(key))) invalid(side, 'configuration contains unsupported fields');
  const normalized = {};
  for (const field of fields) {
    const value = record[field];
    if (field === 'probeQueueName' && value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) invalid(side, `${field} must be a nonempty string`);
    if (/[\u0000-\u001f\u007f]/.test(value)) invalid(side, `${field} must not contain control characters`);
    if (side === 'open_connectors' && ['userSecret', 'organizationSecret'].includes(field) &&
        (value.length > 16384 || !/^[\x21-\x7e]+$/.test(value) || value.includes(','))) {
      invalid(side, `${field} must be an unambiguous printable authorization token`);
    }
    // Credential bytes are significant; trim endpoint/identity inputs only.
    normalized[field] = ['url', 'tokenUrl', 'probeQueueName', 'msgVpnName'].includes(field) ? value.trim() : value;
  }
  if (normalized.url) {
    const url = endpoint(side, 'url', normalized.url);
    if (side === 'edge' && url.pathname !== '/') invalid(side, 'url must be the API virtual-host origin');
    if (side === 'open_connectors' && !/\/elements\/api-v2\/?$/.test(url.pathname)) {
      invalid(side, 'url must include /elements/api-v2');
    }
    normalized.url = url.href.replace(/\/+$/, '');
  }
  if (normalized.tokenUrl) {
    const token = endpoint(side, 'tokenUrl', normalized.tokenUrl);
    if (side === 'ctms' && !/\/oauth\/token\/?$/.test(token.pathname)) {
      token.pathname = `${token.pathname.replace(/\/+$/, '')}/oauth/token`;
    }
    // Event Mesh's binding supplies the complete endpoint, not an OAuth base URL.
    normalized.tokenUrl = token.href;
  }
  return Object.freeze({ ...normalized, source: SOURCES.has(source) ? source : 'configuration' });
}

/** Environment presence wins even for empty/malformed values; errors disable only that side. */
export function resolveOptionalConfig(env = process.env, stored = {}) {
  const resolved = {};
  const errors = [];
  for (const side of OPTIONAL_COMPONENT_KEYS) {
    const { variable } = OPTIONAL_INPUTS[side];
    const supplied = env[variable] !== undefined;
    const source = supplied ? 'environment' : 'stored-key';
    resolved[side] = null;
    if (!supplied && !Object.hasOwn(stored || {}, side)) continue;
    try {
      resolved[side] = parseOptionalConfig(side, supplied ? env[variable] : stored[side], { source, allowRawCtms: supplied });
    } catch (error) {
      errors.push(Object.freeze({ component: side, source, variable, message: error.message }));
    }
  }
  return Object.freeze({ ...resolved, optional_config_errors: Object.freeze(errors) });
}

/** Private-store projection: metadata is not part of the normalized credential record. */
export function optionalConfigRecord(side, config) {
  if (!OPTIONAL_COMPONENT_KEYS.includes(side)) throw new Error('Unknown optional Integration Suite component');
  const record = Object.fromEntries(FIELDS[side].filter(field => Object.hasOwn(config || {}, field)).map(field => [field, config[field]]));
  const { source, ...normalized } = parseOptionalConfig(side, record, { source: 'stored-key' });
  return normalized;
}
