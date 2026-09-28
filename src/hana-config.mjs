const EXPLICIT_CONNECTION_KEYS = [
  'HANA_RO_HOST',
  'HANA_RO_PORT',
  'HANA_RO_USER',
  'HANA_RO_PASSWORD',
  'HANA_RO_SCHEMA'
];

const DEFAULT_SERVICE_TYPES = new Set(['hana', 'hana-cloud', 'hana-cloud-db', 'hanacloud', 'sap-hana-cloud']);

function fail(message) {
  throw new Error(message);
}

function normalizeServiceType(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`HANA read-only connection is missing ${label}.`);
  return value.trim();
}

function validateHost(value) {
  const host = requiredText(value, 'host');
  if (/[\s/@?#\\]/.test(host) || host.includes('://') || host.includes(':')) {
    fail('HANA_RO_HOST must contain only a hostname; provide the port separately.');
  }
  return host;
}

function validatePort(value) {
  const portText = requiredText(String(value ?? ''), 'port');
  if (!/^\d{1,5}$/.test(portText)) fail('HANA_RO_PORT must be an integer between 1 and 65535.');
  const port = Number(portText);
  if (port < 1 || port > 65535) fail('HANA_RO_PORT must be an integer between 1 and 65535.');
  return port;
}

function validateSchema(value) {
  const schema = requiredText(value, 'schema');
  if (schema.length > 127 || /[\u0000-\u001f\u007f]/.test(schema)) {
    fail('The configured HANA schema name is invalid.');
  }
  return schema;
}

function hasExplicitConnection(env) {
  return EXPLICIT_CONNECTION_KEYS.some(key => env[key] !== undefined && env[key] !== '');
}

function explicitConfig(env) {
  const host = validateHost(env.HANA_RO_HOST);
  const port = validatePort(env.HANA_RO_PORT);
  const user = requiredText(env.HANA_RO_USER, 'read-only user');
  const password = requiredText(env.HANA_RO_PASSWORD, 'read-only password');
  const schema = validateSchema(env.HANA_RO_SCHEMA);
  return {
    source: 'environment',
    bindingName: undefined,
    serviceName: undefined,
    host,
    port,
    user,
    password,
    schema,
    trustStore: optionalTrustStore(env.HANA_RO_TRUST_STORE)
  };
}

function optionalTrustStore(value) {
  if (value === undefined || value === '') return undefined;
  const trustStore = requiredText(value, 'TLS trust-store path');
  if (/[\u0000-\u001f\u007f]/.test(trustStore)) fail('The configured HANA TLS trust-store path is invalid.');
  return trustStore;
}

function parseVcapServices(raw) {
  if (!raw) fail('Set HANA_RO_* read-only credentials or bind a selected HANA service in VCAP_SERVICES.');
  let services;
  try {
    services = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    fail('VCAP_SERVICES is not valid JSON.');
  }
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    fail('VCAP_SERVICES must contain a JSON object.');
  }
  return services;
}

function vcapCandidates(env) {
  const services = parseVcapServices(env.VCAP_SERVICES);
  const selectedType = env.HANA_RO_VCAP_SERVICE?.trim();
  const bindingName = env.HANA_RO_BINDING?.trim();
  const entries = Object.entries(services).filter(([serviceType]) => {
    return selectedType
      ? serviceType === selectedType
      : DEFAULT_SERVICE_TYPES.has(normalizeServiceType(serviceType));
  });

  if (selectedType && !entries.length) fail('The selected HANA VCAP service type was not found.');

  let candidates = entries.flatMap(([serviceName, instances]) => {
    if (!Array.isArray(instances)) return [];
    return instances
      .filter(instance => instance && typeof instance === 'object' && !Array.isArray(instance))
      .map(instance => ({ serviceName, instance }));
  });

  if (bindingName) {
    candidates = candidates.filter(({ instance }) => {
      return instance.name === bindingName || instance.binding_name === bindingName;
    });
    if (!candidates.length) fail('The selected HANA binding was not found in VCAP_SERVICES.');
  }

  if (candidates.length !== 1) {
    fail(candidates.length === 0
      ? 'No HANA VCAP binding was found; set HANA_RO_VCAP_SERVICE or explicit HANA_RO_* credentials.'
      : 'Multiple HANA VCAP bindings were found; set HANA_RO_BINDING to select exactly one.');
  }
  return candidates[0];
}

function vcapConfig(env) {
  const { serviceName, instance } = vcapCandidates(env);
  const credentials = instance.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    fail('The selected HANA binding has no usable credentials object.');
  }
  if ((!credentials.user || !credentials.password) && (credentials.hdi_user || credentials.hdi_password)) {
    fail('The selected HANA binding only exposes HDI deployment credentials; configure a separate read-only binding.');
  }
  if (credentials.user && credentials.hdi_user && credentials.user === credentials.hdi_user) {
    fail('The selected HANA binding aliases its read-only and HDI deployment users; configure separate identities.');
  }

  return {
    source: 'vcap-services',
    bindingName: typeof instance.binding_name === 'string' ? instance.binding_name : instance.name,
    serviceName,
    host: validateHost(credentials.host),
    port: validatePort(credentials.port),
    user: requiredText(credentials.user, 'read-only user'),
    password: requiredText(credentials.password, 'read-only password'),
    schema: validateSchema(credentials.schema),
    trustStore: optionalTrustStore(env.HANA_RO_TRUST_STORE)
  };
}

/** Resolve only a read-only HANA identity; HDI deployment credentials are never a fallback. */
export function resolveHanaReadOnlyConfig(env = process.env) {
  if (!env || typeof env !== 'object') fail('HANA environment configuration is unavailable.');
  const hasExplicit = hasExplicitConnection(env);
  if (hasExplicit) {
    const missing = EXPLICIT_CONNECTION_KEYS.filter(key => typeof env[key] !== 'string' || !env[key].trim());
    if (missing.length) fail(`Explicit HANA read-only configuration is incomplete: ${missing.join(', ')}.`);
    return Object.freeze(explicitConfig(env));
  }
  return Object.freeze(vcapConfig(env));
}

export function quoteHanaIdentifier(value) {
  const identifier = requiredText(value, 'identifier');
  if (identifier.length > 127 || /[\u0000-\u001f\u007f]/.test(identifier)) {
    fail('The HANA identifier is invalid.');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}