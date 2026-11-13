// SAP Datasphere tenant/OAuth client configuration and optional Open SQL credentials.
// Pure: no I/O, no network. Two auth modes: 'technical' (client credentials,
// Technical User purpose) and 'interactive' (authorization code + refresh token,
// Interactive Usage purpose).
import { finalizeClientCredentials } from './integration-config.mjs';

const BASE_KEYS = ['DATASPHERE_URL', 'DATASPHERE_TOKEN_URL', 'DATASPHERE_CLIENT_ID', 'DATASPHERE_CLIENT_SECRET'];
const SQL_KEYS = ['DATASPHERE_SQL_HOST', 'DATASPHERE_SQL_USER', 'DATASPHERE_SQL_PASSWORD'];
const ALL_SQL_KEYS = [...SQL_KEYS, 'DATASPHERE_SQL_PORT', 'DATASPHERE_SQL_SCHEMA'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function fail(message) {
  throw new Error(message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Users paste tenant page URLs with paths and #/hash routes; only the origin matters. */
function tenantOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value; // finalize reports the invalid URL with the env-key prefix.
  }
}

function validateHttpsUrl(value, prefix, label) {
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

function parseSql(raw) {
  if (!raw) return null;
  const sql = {
    host: text(raw.host),
    port: raw.port === undefined || raw.port === '' || raw.port === null ? 443 : Number(raw.port),
    user: text(raw.user),
    password: typeof raw.password === 'string' ? raw.password.trim() : '',
    schema: text(raw.schema)
  };
  if (!sql.host || !sql.user || !sql.password) {
    fail('DATASPHERE_SQL configuration is incomplete: DATASPHERE_SQL_HOST, DATASPHERE_SQL_USER, DATASPHERE_SQL_PASSWORD');
  }
  if (!Number.isInteger(sql.port) || sql.port < 1 || sql.port > 65535) {
    fail('DATASPHERE_SQL_PORT must be an integer between 1 and 65535');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(sql.host)) {
    fail('DATASPHERE_SQL_HOST must be a host name, not a URL');
  }
  if (!sql.schema) sql.schema = sql.user;
  return Object.freeze({ ...sql, password: sql.password });
}

/**
 * Validate raw Datasphere credentials into a frozen config.
 * `raw = { auth, url, tokenUrl, clientId, clientSecret, authorizationUrl?, refreshToken?, sql? }`.
 */
export function parseDatasphereCredentials(raw, source) {
  const auth = text(raw?.auth) || 'technical';
  if (auth !== 'technical' && auth !== 'interactive') {
    fail('DATASPHERE_AUTH must be technical or interactive');
  }
  const base = finalizeClientCredentials('DATASPHERE', source, {
    url: tenantOrigin(text(raw?.url)),
    tokenUrl: text(raw?.tokenUrl),
    clientId: text(raw?.clientId),
    clientSecret: text(raw?.clientSecret)
  });
  let authorizationUrl = null;
  let refreshToken = null;
  if (auth === 'interactive') {
    authorizationUrl = validateHttpsUrl(text(raw?.authorizationUrl), 'DATASPHERE', 'AUTHORIZATION_URL').href;
    refreshToken = text(raw?.refreshToken);
    if (!refreshToken) {
      fail('DATASPHERE_REFRESH_TOKEN is required for interactive sign-in; run sap-ai-dev --setup-datasphere');
    }
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
    sql: parseSql(raw?.sql)
  });
}

function sqlFromEnv(env) {
  if (!ALL_SQL_KEYS.some(key => env[key] !== undefined && env[key] !== '')) return undefined;
  const missing = SQL_KEYS.filter(key => !text(env[key]));
  if (missing.length) fail(`Explicit DATASPHERE_SQL configuration is incomplete: ${missing.join(', ')}`);
  return parseSql({
    host: env.DATASPHERE_SQL_HOST,
    port: env.DATASPHERE_SQL_PORT,
    user: env.DATASPHERE_SQL_USER,
    password: env.DATASPHERE_SQL_PASSWORD,
    schema: env.DATASPHERE_SQL_SCHEMA
  });
}

/**
 * Resolve Datasphere credentials. Base group: environment, then the record stored by
 * `sap-ai-dev --setup-datasphere`. The Open SQL group is resolved independently.
 */
export function resolveDatasphereConfig(env = process.env, { stored } = {}) {
  let config;
  if (BASE_KEYS.some(key => env[key] !== undefined && env[key] !== '')) {
    const missing = BASE_KEYS.filter(key => !text(env[key]));
    if (missing.length) fail(`Explicit DATASPHERE configuration is incomplete: ${missing.join(', ')}`);
    config = parseDatasphereCredentials({
      auth: env.DATASPHERE_AUTH,
      url: env.DATASPHERE_URL,
      tokenUrl: env.DATASPHERE_TOKEN_URL,
      clientId: env.DATASPHERE_CLIENT_ID,
      clientSecret: env.DATASPHERE_CLIENT_SECRET,
      authorizationUrl: env.DATASPHERE_AUTHORIZATION_URL,
      refreshToken: env.DATASPHERE_REFRESH_TOKEN,
      sql: sqlFromEnv(env)
    }, 'environment');
  } else if (stored) {
    config = parseDatasphereCredentials({
      auth: stored.auth,
      url: stored.url,
      tokenUrl: stored.tokenurl,
      clientId: stored.clientid,
      clientSecret: stored.clientsecret,
      authorizationUrl: stored.authorizationurl,
      refreshToken: stored.refreshtoken,
      sql: stored.sql
    }, 'stored-key');
    const sql = sqlFromEnv(env);
    if (sql) config = Object.freeze({ ...config, sql });
  } else {
    fail('Configure Datasphere (DATASPHERE_URL/DATASPHERE_TOKEN_URL/DATASPHERE_CLIENT_ID/DATASPHERE_CLIENT_SECRET) in the MCP host environment, or run sap-ai-dev --setup-datasphere.');
  }
  return config;
}
