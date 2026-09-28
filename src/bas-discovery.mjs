import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { brandedEnvValue } from './branding.mjs';

const SECRET_KEY = /^(authorization|cookie|set-cookie|username|user|sap[_-](user(name)?|password|pass|token|saml[_-]?(user|password)|cookie[_-]?(file|string)|browser[_-]?auth|sso|credential[_-]?cmd))$|.*(password|passwd|secret|bearer|credential).*/i;
const DEFAULT_PROXY = 'http://127.0.0.1:8887';

function keyName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : value;
  if (value && typeof value === 'object' && 'value' in value) return scalar(value.value);
  return value;
}

function propertiesOf(item) {
  const result = {};
  for (const [key, value] of Object.entries(item || {})) result[keyName(key)] = scalar(value);
  const maps = Object.entries(item || {}).filter(([key]) => ['properties', 'propertymap', 'destinationproperties', 'configuration'].includes(keyName(key))).map(([, value]) => value);
  for (const map of maps) {
    if (Array.isArray(map)) {
      for (const entry of map) {
        const key = entry?.key ?? entry?.name ?? entry?.property;
        if (key != null) result[keyName(key)] = scalar(entry?.value ?? entry?.val);
      }
    } else if (map && typeof map === 'object') {
      for (const [key, value] of Object.entries(map)) result[keyName(key)] = scalar(value);
    }
  }
  return result;
}


function text(value) {
  return value == null ? '' : String(value).trim();
}

function listFromBody(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const [key, value] of Object.entries(body)) {
    if (['destinations', 'data'].includes(keyName(key)) && Array.isArray(value)) return value;
  }
  return null;
}

export function normalizeDestination(item) {
  const values = propertiesOf(item);
  const name = text(values.name || values.destinationname || values.destname);
  const authentication = text(values.authentication || values.authtype || values.auth);
  const client = text(values.sapclient || values.client) || '001';
  const backendUrl = text(values.url || values.host || values.webideexposedhost);
  const proxyType = text(values.proxytype || values.proxy);
  return {
    name,
    authentication: authentication || 'Unknown',
    client,
    url: name ? destinationUrl(name) : null,
    backendUrl: backendUrl || null,
    proxyType: proxyType || null,
    rawKeys: Object.keys(item || {}).map(String)
  };
}

export function destinationUrl(name) {
  const value = text(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Invalid BAS destination name: ${value || '<empty>'}`);
  return `http://${value}.dest`;
}

export function slugifyDestination(name, used = new Map()) {
  const base = text(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'destination';
  const count = (used.get(base) || 0) + 1;
  used.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(entry);
  return result;
}

export function sanitizeChildEnv(input = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SECRET_KEY.test(key)) env[key] = value;
  }
  env.SAP_PROXY_CONTEXTID_GUARD = 'true';
  const proxy = env.HTTP_PROXY || env.http_proxy || DEFAULT_PROXY;
  if (!env.HTTP_PROXY && !env.http_proxy) env.HTTP_PROXY = proxy;
  if (!env.HTTPS_PROXY && !env.https_proxy) env.HTTPS_PROXY = proxy;
  const noProxyKey = env.NO_PROXY != null ? 'NO_PROXY' : (env.no_proxy != null ? 'no_proxy' : 'NO_PROXY');
  const entries = String(env[noProxyKey] || '').split(',').map(value => value.trim()).filter(Boolean).filter(value => !value.toLowerCase().includes('.dest'));
  env[noProxyKey] = entries.join(',');
  return env;
}

function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

function proxyBypasses(url, noProxy) {
  const hostname = url.host.replace(/:\d*$/, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return String(noProxy).split(/[,\s]/).some(entry => {
    if (!entry) return false;
    const match = entry.match(/^(.+):(\d+)$/);
    const candidate = (match ? match[1] : entry).toLowerCase();
    if (match && Number(match[2]) !== port) return false;
    if (/^[.*]/.test(candidate)) return hostname.endsWith(candidate.replace(/^\*/, ''));
    return hostname === candidate;
  });
}

function proxyDispatcher(target, env) {
  const url = new URL(target);
  const brandedProxy = brandedEnvValue(env, 'HTTP_PROXY');
  const httpProxy = brandedProxy !== undefined ? String(brandedProxy) : (env.http_proxy ?? env.HTTP_PROXY ?? '');
  const httpsProxy = brandedProxy !== undefined ? String(brandedProxy) : (env.https_proxy ?? env.HTTPS_PROXY ?? '');
  const proxy = url.protocol === 'https:' ? httpsProxy || httpProxy : httpProxy;
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';
  if (!proxy || proxyBypasses(url, noProxy)) return undefined;
  return new ProxyAgent({ uri: proxy, proxyTunnel: false });
}

export async function fetchDestinationList(h2oUrl, options = {}) {
  if (!h2oUrl) throw new Error('H2O_URL is required for BAS destination discovery');
  const url = `${String(h2oUrl).replace(/\/$/, '')}/api/listDestinations`;
  const env = options.env || process.env;
  const dispatcher = proxyDispatcher(url, env);
  try {
    const response = await (options.fetchImpl || undiciFetch)(url, {
      signal: options.signal || timeoutSignal(options.timeoutMs || 10000),
      headers: { accept: 'application/json' },
      ...(dispatcher ? { dispatcher } : {})
    });
    if (!response.ok) throw new Error(`BAS destination discovery failed with HTTP ${response.status}`);
    return await response.json();
  } finally {
    await dispatcher?.close();
  }
}


function requestProbe(target, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const proxy = proxyUrl ? new URL(proxyUrl) : null;
    const throughProxy = proxy && targetUrl.protocol === 'http:' && proxy.protocol === 'http:';
    const transport = throughProxy ? httpRequest : (targetUrl.protocol === 'https:' ? httpsRequest : httpRequest);
    const requestOptions = throughProxy ? {
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: 'GET',
      path: targetUrl.href,
      headers: { host: targetUrl.host, accept: 'application/xml,text/xml,*/*' }
    } : {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: { host: targetUrl.host, accept: 'application/xml,text/xml,*/*' }
    };
    const req = transport(requestOptions, response => {
      response.resume();
      resolve({ status: response.statusCode || 0, throughProxy });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function probeADT(destination, options = {}) {
  const url = `${destinationUrl(destination.name)}/sap/bc/adt/discovery`;
  if (options.skipProbe) return { status: 'skipped', available: true, url };
  try {
    const result = options.probeImpl ? await options.probeImpl(url, options) : await requestProbe(url, options.proxyUrl ?? DEFAULT_PROXY, options.timeoutMs || 5000);
    if ([401, 403].includes(result.status) || (result.status >= 200 && result.status < 300)) return { status: result.status === 401 || result.status === 403 ? 'auth-required' : 'available', available: true, httpStatus: result.status, url };
    if (result.status === 404) return { status: 'not-found', available: false, httpStatus: result.status, url };
    return { status: 'unavailable', available: false, httpStatus: result.status, url };
  } catch (error) {
    return { status: error?.message === 'probe timeout' ? 'timeout' : 'network-error', available: false, error: error?.message || 'network error', url };
  }
}

export async function discoverDestinations(options = {}) {
  const env = options.env || process.env;
  const body = options.body ?? await fetchDestinationList(env.H2O_URL, options);
  const list = listFromBody(body);
  if (!list) throw new Error(`Unrecognized BAS destination response shape; top-level keys: ${Object.keys(body || {}).map(String).join(', ') || '<none>'}`);
  const allow = text(brandedEnvValue(env, 'DESTINATION')).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const normalized = list.map(normalizeDestination).filter(item => item.name).filter(item => !allow.length || allow.includes(item.name.toLowerCase()));
  const brandedProxy = brandedEnvValue(env, 'HTTP_PROXY');
  const configuredProxy = brandedProxy !== undefined ? String(brandedProxy) : (env.HTTP_PROXY ?? env.http_proxy);
  const proxyUrl = configuredProxy !== undefined ? configuredProxy : DEFAULT_PROXY;
  const skipProbe = String(brandedEnvValue(env, 'SKIP_PROBE') || '').toLowerCase() === 'true' || options.skipProbe;
  const result = [];
  for (const destination of normalized.sort((a, b) => a.name.localeCompare(b.name))) {
    const probe = await probeADT(destination, { ...options, proxyUrl, skipProbe });
    result.push({ ...destination, probe });
  }
  return result;
}

export function statusRows(destinations) {
  return destinations.map(destination => ({ name: destination.name, client: destination.client, authentication: destination.authentication, probe: destination.probe?.status || 'unknown' }));
}

export const remediation = 'No named BAS destinations were returned. Check H2O_URL, Cloud Connector /sap/bc/adt, and run curl "$H2O_URL/api/listDestinations".';
