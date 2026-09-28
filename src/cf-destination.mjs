import { randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stdin, stdout } from 'node:process';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { sanitizeChildEnv } from './bas-discovery.mjs';
import { createCfConnectivityProxy } from './cf-connectivity.mjs';
import { checkboxPrompt, colorText } from './terminal-ui.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const execFile = promisify(nodeExecFile);
const KEY_PREFIX = 'sap-ai-dev-toolkit-';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function keyPart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cliError(error) {
  const failure = new Error('Cloud Foundry CLI command failed');
  failure.stderr = String(error?.stderr || '');
  return failure;
}

async function runCf(args, { env = process.env, execFileImpl = nodeExecFile } = {}) {
  try {
    const run = execFileImpl === nodeExecFile ? execFile : promisify(execFileImpl);
    const result = await run('cf', args, {
      env,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    const output = result?.stdout ?? result ?? '';
    return typeof output === 'string' ? output : String(output);
  } catch (error) {
    throw cliError(error);
  }
}

function versionAtLeast818(value) {
  const match = /\bcf\s+version\s+(\d+)\.(\d+)\.(\d+)/i.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 8 || (major === 8 && minor >= 18);
}

function targetedSpaceName(output) {
  const match = /^\s*space:\s*(.*?)\s*$/im.exec(output);
  const name = match?.[1]?.trim() || '';
  return /^(?:<none>|\(none\)|none)$/i.test(name) ? '' : name;
}

export async function getCloudFoundryTarget({ env = process.env, execFileImpl = nodeExecFile } = {}) {
  let version;
  try {
    version = await runCf(['version'], { env, execFileImpl });
  } catch {
    return { available: false, reason: 'Cloud Foundry CLI is unavailable; CF destinations were skipped.' };
  }
  if (!versionAtLeast818(version)) {
    return { available: false, reason: 'Cloud Foundry CLI 8.18 or newer is required; CF destinations were skipped.' };
  }
  let target;
  try {
    target = await runCf(['target'], { env, execFileImpl });
  } catch {
    return { available: false, reason: 'Cloud Foundry CLI is not authenticated to a targeted space; CF destinations were skipped.' };
  }
  const spaceName = targetedSpaceName(target);
  if (!spaceName) {
    return { available: false, reason: 'Cloud Foundry CLI is not authenticated to a targeted space; CF destinations were skipped.' };
  }
  let spaceGuid;
  try {
    spaceGuid = text(await runCf(['space', spaceName, '--guid'], { env, execFileImpl }));
  } catch {
    return { available: false, reason: 'Cloud Foundry CLI is not authenticated to a targeted space; CF destinations were skipped.' };
  }
  if (!spaceGuid || /\s/.test(spaceGuid)) {
    return { available: false, reason: 'Cloud Foundry CLI is not authenticated to a targeted space; CF destinations were skipped.' };
  }
  return { available: true, spaceGuid };
}

function missingServiceKey(error) {
  const details = String(error?.stderr || '').toLowerCase();
  return details.includes('service key') && /(not found|does not exist|doesn.t exist)/.test(details);
}

export async function deleteManagedCloudFoundryServiceKeys({ env = process.env, keys = [] } = {}) {
  if (!keys.length) return { warnings: [] };
  const target = await getCloudFoundryTarget({ env });
  if (!target.available) return { warnings: [`CF service-key cleanup skipped: ${target.reason}`] };
  const warnings = [];
  for (const key of keys) {
    if (key.spaceGuid !== target.spaceGuid) {
      warnings.push(`Managed ${key.kind} service key ${key.keyName} for ${key.instanceName} requires targeting CF space ${key.spaceGuid}; it was left untouched.`);
      continue;
    }
    try {
      await runCf(['delete-service-key', '-f', '--wait', key.instanceName, key.keyName], { env });
    } catch (error) {
      if (missingServiceKey(error)) continue;
      warnings.push(`Could not delete managed ${key.kind} service key ${key.keyName} for service instance ${key.instanceName}; target CF space ${key.spaceGuid} and retry.`);
    }
  }
  return { warnings };
}

async function listToolkitServiceKeys({ env = process.env, spaceGuid, execFileImpl = nodeExecFile } = {}) {
  const options = { env, execFileImpl };
  const keys = [];
  let path = `/v3/service_credential_instances?space_guids=${encodeURIComponent(spaceGuid)}&type=key&per_page=500`;
  const visited = new Set();
  while (path && !visited.has(path)) {
    visited.add(path);
    const page = await cfJson(path, options);
    if (!Array.isArray(page?.resources)) return keys;
    for (const resource of page.resources) {
      const name = text(resource?.name);
      const instanceGuid = resource?.relationships?.service_instance?.data?.guid;
      if (!name.startsWith(KEY_PREFIX) || !instanceGuid) continue;
      keys.push({ keyName: name, instanceGuid: String(instanceGuid) });
    }
    path = page?.metadata?.pagination?.next?.href ? apiPath(page.metadata.pagination.next.href) : '';
  }
  return keys;
}

// Reconcile toolkit-created service keys against the references recorded in
// the MCP config. A Destination-instance service key exposes client
// credentials for every destination in the instance, so a key orphaned by an
// interrupted setup must not linger unnoticed.
export async function findOrphanedCloudFoundryServiceKeys({ env = process.env, spaceGuid, managedKeys = [], execFileImpl = nodeExecFile } = {}) {
  const listed = await listToolkitServiceKeys({ env, spaceGuid, execFileImpl });
  const referenced = new Set((managedKeys || [])
    .filter(ref => ref?.spaceGuid === spaceGuid && ref?.instanceGuid && ref?.keyName)
    .map(ref => `${ref.instanceGuid}\0${ref.keyName}`));
  const orphans = [];
  const instanceNames = new Map();
  for (const key of listed) {
    if (referenced.has(`${key.instanceGuid}\0${key.keyName}`)) continue;
    if (!instanceNames.has(key.instanceGuid)) {
      try {
        instanceNames.set(key.instanceGuid, text((await cfJson(`/v3/service_instances/${encodeURIComponent(key.instanceGuid)}`, { env, execFileImpl })).name));
      } catch {
        instanceNames.set(key.instanceGuid, '');
      }
    }
    orphans.push({ kind: 'toolkit-created', spaceGuid, instanceGuid: key.instanceGuid, instanceName: instanceNames.get(key.instanceGuid) || key.instanceGuid, keyName: key.keyName });
  }
  return orphans;
}

async function cfJson(path, options) {
  const value = await runCf(['curl', path], options);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Cloud Foundry API returned an invalid response');
  }
}

function apiPath(href) {
  try {
    const url = new URL(href, 'https://cf-api.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    throw new Error('Cloud Foundry API pagination link was invalid');
  }
}

async function serviceInstances(spaceGuid, options) {
  const instances = [];
  let path = `/v3/service_instances?space_guids=${encodeURIComponent(spaceGuid)}&per_page=500`;
  const visited = new Set();
  while (path && !visited.has(path)) {
    visited.add(path);
    const page = await cfJson(path, options);
    if (!Array.isArray(page?.resources)) throw new Error('Cloud Foundry service instance response was invalid');
    instances.push(...page.resources);
    path = page?.metadata?.pagination?.next?.href ? apiPath(page.metadata.pagination.next.href) : '';
  }
  return instances;
}

async function serviceOffering(instance, options) {
  const planGuid = instance?.relationships?.service_plan?.data?.guid;
  if (!planGuid) return null;
  const plan = await cfJson(`/v3/service_plans/${encodeURIComponent(planGuid)}`, options);
  const offeringGuid = plan?.relationships?.service_offering?.data?.guid;
  if (!offeringGuid) return null;
  return cfJson(`/v3/service_offerings/${encodeURIComponent(offeringGuid)}`, options);
}

function listValue(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const wanted = new Set(keys.map(keyPart));
  for (const [key, value] of Object.entries(payload)) {
    if (wanted.has(keyPart(key)) && Array.isArray(value)) return value;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (wanted.has(keyPart(key)) && value && typeof value === 'object') {
      const found = listValue(value, keys);
      if (found) return found;
    }
  }
  return null;
}

function scalar(value) {
  const wrapped = objectValue(value, ['value']);
  if (wrapped !== undefined) return scalar(wrapped);
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : '';
  return value;
}

function objectValue(object, candidates) {
  const wanted = new Set(candidates.map(keyPart));
  const entry = Object.entries(object || {}).find(([key]) => wanted.has(keyPart(key)));
  return entry?.[1];
}

function propertyValues(item) {
  let configuration = item;
  for (let index = 0; index < 3 && configuration && typeof configuration === 'object'; index += 1) {
    const nested = Object.entries(configuration).find(([key]) => keyPart(key) === 'destinationconfiguration')?.[1];
    if (!nested || typeof nested !== 'object') break;
    configuration = nested;
  }
  const values = Object.create(null);
  for (const source of [configuration, item]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      const normalized = keyPart(key);
      if (!normalized || ['properties', 'propertymap', 'destinationproperties', 'configuration', 'destinationconfiguration'].includes(normalized)) continue;
      values[normalized] = scalar(value);
    }
    for (const [key, value] of Object.entries(source)) {
      if (!['properties', 'propertymap', 'destinationproperties', 'configuration'].includes(keyPart(key))) continue;
      if (Array.isArray(value)) {
        for (const property of value) {
          if (!property || typeof property !== 'object') continue;
          const propertyKey = objectValue(property, ['key', 'name', 'property']);
          if (propertyKey != null) values[keyPart(propertyKey)] = scalar(objectValue(property, ['value', 'val']));
        }
      } else if (value && typeof value === 'object') {
        for (const [propertyKey, propertyValue] of Object.entries(value)) values[keyPart(propertyKey)] = scalar(propertyValue);
      }
    }
  }
  return values;
}

function canonicalAuthentication(value) {
  const normalized = keyPart(value);
  if (normalized === 'noauthentication') return 'NoAuthentication';
  if (normalized === 'basicauthentication') return 'BasicAuthentication';
  if (normalized === 'principalpropagation') return 'PrincipalPropagation';
  return text(value) || 'Unknown';
}

function canonicalProxyType(value) {
  const normalized = keyPart(value);
  if (normalized === 'internet') return 'Internet';
  if (normalized === 'onpremise') return 'OnPremise';
  return text(value) || 'Unknown';
}

function normalizeRecord(item, fallbackName = '') {
  const values = propertyValues(item);
  const name = text(values.name || values.destinationname || fallbackName);
  const rawUrl = text(values.url);
  let url;
  let urlError;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
        urlError = 'URL must be HTTP(S) without embedded user information';
      } else {
        url = parsed.href;
      }
    } catch {
      urlError = 'URL is invalid';
    }
  }
  const rawType = text(values.type);
  const authentication = canonicalAuthentication(values.authentication);
  const proxyType = canonicalProxyType(values.proxytype);
  return {
    name,
    type: rawType,
    url,
    urlError,
    client: text(values.sapclient) || '001',
    authentication,
    proxyType,
    user: text(values.user),
    password: values.password == null ? '' : String(values.password),
    locationId: text(values.cloudconnectorlocationid)
  };
}

function reasonFor(record, hasConnectivity) {
  if (!record.type || keyPart(record.type) !== 'http') return 'Destination Type must be HTTP';
  if (record.urlError) return record.urlError;
  if (!record.url) return 'Destination URL is missing';
  if (record.authentication === 'BasicAuthentication' && (!record.user || !record.password)) return 'BasicAuthentication requires both User and Password';
  if (!['NoAuthentication', 'BasicAuthentication', 'PrincipalPropagation'].includes(record.authentication)) return `Authentication mode ${record.authentication} is unsupported`;
  if (record.proxyType === 'Internet') {
    if (record.authentication === 'PrincipalPropagation') return 'PrincipalPropagation is not supported for Internet destinations';
    return '';
  }
  if (record.proxyType === 'OnPremise') {
    if (!hasConnectivity) return 'No Connectivity service instance is available';
    return '';
  }
  return `ProxyType ${record.proxyType} is unsupported`;
}

function destinationDescriptor(record, spaceGuid, instance, keyName, connectivity) {
  const cf = {
    spaceGuid,
    destinationInstanceGuid: String(instance.guid),
    destinationInstanceName: String(instance.name || instance.guid),
    destinationKeyName: keyName
  };
  if (record.proxyType === 'OnPremise' && connectivity) {
    cf.connectivityInstanceGuid = String(connectivity.instance.guid);
    cf.connectivityInstanceName = String(connectivity.instance.name || connectivity.instance.guid);
    cf.connectivityKeyName = connectivity.keyName;
  }
  return {
    source: 'cloud-foundry',
    name: record.name,
    serverName: `cf:${spaceGuid}:${instance.guid}:${record.name}`,
    client: record.client,
    authentication: record.authentication,
    proxyType: record.proxyType,
    probe: { status: 'unavailable', available: false },
    cf
  };
}

async function chooseInstances(instances, { input = stdin, output = stdout, message }) {
  if (instances.length === 1) return instances;
  const selected = await checkboxPrompt({
    message: colorText(`☁️ ${message}`, 'cyan', output),
    choices: instances.map(instance => ({
      value: instance,
      name: `${instance.name || instance.guid} (${instance.guid})`,
      checked: false
    })),
    required: false,
    shortcuts: { all: 'a' }
  }, { input, output });
  return selected;
}

async function chooseConnectivity(instances, { input = stdin, output = stdout }) {
  if (instances.length === 1) return instances[0];
  const selected = await checkboxPrompt({
    message: colorText('🔌 Select one Connectivity service instance', 'cyan', output),
    choices: instances.map(instance => ({ value: instance, name: `${instance.name || instance.guid} (${instance.guid})`, checked: false })),
    required: false,
    validate: values => values.length <= 1 || 'Select at most one Connectivity service instance',
    shortcuts: { all: 'a' }
  }, { input, output });
  return selected[0];
}

async function readServiceKey(instance, kind, spaceGuid, managedKeys, createdKeys, options) {
  const refs = (managedKeys || []).filter(ref => ref?.kind === kind && ref.spaceGuid === spaceGuid && ref.instanceGuid === instance.guid);
  for (const ref of refs) {
    const instanceName = ref.instanceName || instance.name || instance.guid;
    try {
      const credentials = await serviceKeyCredentials(instanceName, ref.keyName, kind, options);
      return { keyName: ref.keyName, credentials };
    } catch {
      // A stale or unreadable managed key is replaced with a fresh key; old config still owns the original until commit.
    }
  }
  const instanceName = String(instance.name || instance.guid);
  const keyName = `${KEY_PREFIX}${randomUUID()}`;
  await runCf(['create-service-key', instanceName, keyName, '--wait'], options);
  const reference = { kind, spaceGuid, instanceGuid: String(instance.guid), instanceName, keyName };
  createdKeys.push(reference);
  const credentials = await serviceKeyCredentials(instanceName, keyName, kind, options);
  return { keyName, credentials };
}

async function serviceKeyCredentials(instanceName, keyName, kind, options) {
  const raw = await runCf(['service-key', '--json', instanceName, keyName], options);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The ${kind} service key response was invalid`);
  }
  const credentials = parsed?.credentials || parsed?.service_key?.credentials || parsed;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error(`The ${kind} service key has no credentials`);
  return credentials;
}

function destinationServiceCredentials(credentials) {
  const uaa = credentials.uaa && typeof credentials.uaa === 'object' ? credentials.uaa : credentials;
  return {
    uri: text(credentials.uri || credentials.destination_service_uri),
    url: text(uaa.url || credentials.url),
    clientId: text(uaa.clientid || uaa.client_id || credentials.clientid || credentials.client_id),
    clientSecret: text(uaa.clientsecret || uaa.client_secret || credentials.clientsecret || credentials.client_secret)
  };
}

async function requestJson(url, init, fetchImpl = globalThis.fetch, failureMessage = 'Destination service request failed') {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(failureMessage);
  }
  if (!response?.ok) throw new Error(failureMessage);
  try {
    return await response.json();
  } catch {
    throw new Error(failureMessage);
  }
}

async function destinationToken(credentials, fetchImpl) {
  const config = destinationServiceCredentials(credentials);
  if (!config.uri || !config.url || !config.clientId || !config.clientSecret) throw new Error('Destination service key credentials are incomplete');
  let tokenUrl;
  try {
    tokenUrl = new URL(`${config.url.replace(/\/+$/, '')}/oauth/token`);
    if (!['http:', 'https:'].includes(tokenUrl.protocol) || tokenUrl.username || tokenUrl.password) throw new Error('invalid');
  } catch {
    throw new Error('Destination service token endpoint is invalid');
  }
  const headers = {
    authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json'
  };
  const payload = await requestJson(tokenUrl, {
    method: 'POST', headers, body: new URLSearchParams({ grant_type: 'client_credentials' })
  }, fetchImpl, 'Destination service authentication failed');
  if (typeof payload?.access_token !== 'string' || !payload.access_token) throw new Error('Destination service authentication failed');
  return { uri: config.uri.replace(/\/+$/, ''), token: payload.access_token };
}

async function destinationRecords(credentials, fetchImpl) {
  const token = await destinationToken(credentials, fetchImpl);
  let listUrl;
  try {
    listUrl = new URL(`${token.uri}/destination-configuration/v1/instanceDestinations`);
  } catch {
    throw new Error('Destination service URI is invalid');
  }
  const headers = { authorization: `Bearer ${token.token}`, accept: 'application/json' };
  const payload = await requestJson(listUrl, { headers }, fetchImpl);
  const list = listValue(payload, ['instanceDestinations', 'destinationConfigurations', 'destinations', 'data', 'resources', 'value']);
  if (!list) throw new Error('Destination service returned an invalid instance destination list');
  const records = [];
  for (const item of list) {
    const initial = normalizeRecord(item);
    if (!initial.name) {
      records.push({ record: initial, detailsFailed: false });
      continue;
    }
    const listedValues = propertyValues(item);
    const basicCredentialsMissing = canonicalAuthentication(listedValues.authentication) === 'BasicAuthentication'
      && (!text(listedValues.user) || !text(listedValues.password));
    const needsDetails = ['type', 'url', 'authentication', 'proxytype'].some(key => !text(listedValues[key])) || basicCredentialsMissing;
    if (!needsDetails) {
      records.push({ record: initial, detailsFailed: false });
      continue;
    }
    try {
      const detailUrl = new URL(`${listUrl.href.replace(/\/+$/, '')}/${encodeURIComponent(initial.name)}`);
      const detail = await requestJson(detailUrl, { headers }, fetchImpl, 'Destination detail request failed');
      const detailValues = propertyValues(detail);
      const record = normalizeRecord(detail, initial.name);
      const has = (...keys) => keys.some(key => Object.hasOwn(detailValues, keyPart(key)));
      const merged = {
        name: record.name || initial.name,
        type: has('type') ? record.type : initial.type,
        url: has('url') ? record.url : initial.url,
        urlError: has('url') ? record.urlError : initial.urlError,
        client: has('sap-client', 'client') ? record.client : initial.client,
        authentication: has('authentication') ? record.authentication : initial.authentication,
        proxyType: has('proxytype') ? record.proxyType : initial.proxyType,
        user: has('user') ? record.user : initial.user,
        password: has('password') ? record.password : initial.password,
        locationId: has('cloudconnectorlocationid') ? record.locationId : initial.locationId
      };
      records.push({ record: merged, detailsFailed: false });
    } catch {
      records.push({ record: initial, detailsFailed: true });
    }
  }
  return records;
}

function noProxyMatch(url, list) {
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return String(list || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean).some(entry => {
    if (entry === '*') return true;
    const normalized = entry.replace(/^\./, '');
    const split = normalized.match(/^(.+):(\d+)$/);
    const ruleHost = split ? split[1] : normalized;
    if (split && Number(split[2]) !== port) return false;
    return host === ruleHost || host.endsWith(`.${ruleHost}`);
  });
}

function dispatcherFor(url, env, forcedProxy) {
  const sanitized = sanitizeChildEnv(env);
  const proxy = forcedProxy || (url.protocol === 'https:' ? sanitized.HTTPS_PROXY || sanitized.https_proxy : sanitized.HTTP_PROXY || sanitized.http_proxy);
  if (!proxy || (!forcedProxy && noProxyMatch(url, sanitized.NO_PROXY || sanitized.no_proxy))) return null;
  return new ProxyAgent({ uri: proxy, proxyTunnel: false });
}

function probeResult(status) {
  if ((status >= 200 && status < 300) || status === 401 || status === 403) {
    return { status: status === 401 || status === 403 ? 'auth-required' : 'available', available: true, httpStatus: status };
  }
  return { status: 'unavailable', available: false, httpStatus: status };
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function probeRecord(record, env, { forcedProxy, fetchImpl = undiciFetch } = {}) {
  const target = new URL('/sap/bc/adt/discovery', record.url);
  const headers = { accept: 'application/xml,text/xml,*/*' };
  // Never send SAP Basic credentials over cleartext HTTP to a remote host:
  // an http:// destination URL is allowed for reachability probing, but the
  // probe runs unauthenticated then (401/403 still counts as reachable).
  const plaintextRemote = target.protocol === 'http:' && !isLoopbackHostname(target.hostname);
  if (record.authentication === 'BasicAuthentication' && !plaintextRemote) {
    headers.authorization = `Basic ${Buffer.from(`${record.user}:${record.password}`).toString('base64')}`;
  }
  let dispatcher;
  try {
    dispatcher = dispatcherFor(target, env, forcedProxy);
    const response = await fetchImpl(target, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
      ...(dispatcher ? { dispatcher } : {})
    });
    return probeResult(response.status || 0);
  } catch (error) {
    return { status: error?.name === 'TimeoutError' ? 'timeout' : 'network-error', available: false };
  } finally {
    try { await dispatcher?.destroy(); } catch {}
  }
}

async function currentUserToken(options) {
  const value = text(await runCf(['oauth-token'], options));
  const match = /(?:^|\s)bearer\s+(\S+)/i.exec(value);
  if (!match) throw new Error('Cloud Foundry user token is unavailable');
  return match[1];
}

function connectivityCredentialsValid(credentials) {
  return Boolean(
    text(credentials?.onpremise_proxy_host) &&
    Number.isInteger(Number(credentials?.onpremise_proxy_http_port)) &&
    Number(credentials.onpremise_proxy_http_port) > 0 &&
    text(credentials?.token_service_url) &&
    text(credentials?.clientid) &&
    text(credentials?.clientsecret)
  );
}

async function prepareOnPremise(record, connectivity, env, fetchImpl, options) {
  const authMode = record.authentication === 'PrincipalPropagation' ? 'principal-propagation' : 'application';
  const route = await createCfConnectivityProxy({
    destinationUrl: record.url,
    connectivityCredentials: connectivity.credentials,
    locationId: record.locationId,
    authMode,
    userTokenProvider: authMode === 'principal-propagation' ? () => currentUserToken(options) : undefined,
    fetchImpl
  });
  try {
    return await probeRecord(record, env, { forcedProxy: route.url, fetchImpl: undiciFetch });
  } finally {
    await route.close();
  }
}

function instanceSummary(instance) {
  return { guid: String(instance.guid), name: String(instance.name || instance.guid) };
}

export async function discoverCloudFoundryDestinations({
  env = process.env,
  input = stdin,
  output = stdout,
  spaceGuid,
  managedKeys = [],
  execFileImpl = nodeExecFile,
  fetchImpl = globalThis.fetch
} = {}) {
  const destinations = [];
  const createdKeys = [];
  const warnings = [];
  const options = { env, execFileImpl };
  try {
    const allInstances = await serviceInstances(spaceGuid, options);
    const destinationInstances = [];
    const connectivityInstances = [];
    for (const instance of allInstances) {
      try {
        const offering = await serviceOffering(instance, options);
        const offeringName = text(offering?.name || offering?.label).toLowerCase();
        if (offeringName === 'destination') destinationInstances.push(instanceSummary(instance));
        if (offeringName === 'connectivity') connectivityInstances.push(instanceSummary(instance));
      } catch {
        warnings.push('A Cloud Foundry service instance could not be classified; it was skipped.');
      }
    }
    if (!destinationInstances.length) {
      warnings.push('No Destination service instance exists in the current CF space; CF import was skipped.');
      return { destinations, createdKeys, warnings };
    }
    const selectedInstances = await chooseInstances(destinationInstances, { input, output, message: 'Select Destination service instances' });
    if (!selectedInstances.length) {
      warnings.push('No Destination service instance was selected; CF import was skipped.');
      return { destinations, createdKeys, warnings };
    }

    const recordsByInstance = [];
    for (const instance of selectedInstances) {
      try {
        const key = await readServiceKey(instance, 'destination', spaceGuid, managedKeys, createdKeys, options);
        const records = await destinationRecords(key.credentials, fetchImpl);
        let unnamed = 0;
        for (const item of records) {
          if (!item.record.name) unnamed += 1;
          else recordsByInstance.push({ instance, key, ...item });
        }
        if (unnamed) warnings.push(`Skipped ${unnamed} unnamed destination record${unnamed === 1 ? '' : 's'} from Destination service instance ${instance.name}.`);
      } catch {
        warnings.push(`Destination service instance ${instance.name} could not be read; its records were skipped.`);
      }
    }

    const possibleOnPremise = recordsByInstance.filter(({ record, detailsFailed }) => !detailsFailed && !reasonFor(record, true) && record.proxyType === 'OnPremise');
    let selectedConnectivity;
    let connectivity;
    if (possibleOnPremise.length) {
      if (!connectivityInstances.length) {
        warnings.push('No Connectivity service instance exists in the current CF space; OnPremise destinations were disabled.');
      } else {
        try {
          selectedConnectivity = await chooseConnectivity(connectivityInstances, { input, output });
          if (!selectedConnectivity) warnings.push('No Connectivity service instance was selected; OnPremise destinations were disabled.');
          else {
            connectivity = await readServiceKey(selectedConnectivity, 'connectivity', spaceGuid, managedKeys, createdKeys, options);
            if (!connectivityCredentialsValid(connectivity.credentials)) {
              connectivity = undefined;
              warnings.push(`Connectivity service instance ${selectedConnectivity.name} has incomplete credentials; OnPremise destinations were disabled.`);
            }
          }
        } catch {
          connectivity = undefined;
          warnings.push('Connectivity service credentials could not be read; OnPremise destinations were disabled.');
        }
      }
    }

    for (const item of recordsByInstance) {
      const { instance, key, record, detailsFailed } = item;
      const base = destinationDescriptor(record, spaceGuid, instance, key.keyName, selectedConnectivity && connectivity ? { instance: selectedConnectivity, keyName: connectivity.keyName } : undefined);
      let disabledReason = reasonFor(record, Boolean(connectivity));
      if (detailsFailed) disabledReason ||= 'Destination connection details could not be read';
      if (record.proxyType === 'OnPremise' && !connectivity) disabledReason ||= 'Connectivity service credentials are unavailable';
      if (disabledReason) {
        base.disabledReason = disabledReason;
        base.probe = { status: 'unavailable', available: false };
        destinations.push(base);
        continue;
      }
      if (record.proxyType === 'OnPremise') {
        try {
          base.probe = await prepareOnPremise(record, connectivity, env, fetchImpl, options);
        } catch {
          base.disabledReason = record.authentication === 'PrincipalPropagation'
            ? 'PrincipalPropagation or Connectivity route setup failed'
            : 'Connectivity route setup failed';
          base.probe = { status: 'unavailable', available: false };
        }
      } else {
        base.probe = await probeRecord(record, env, { fetchImpl: undiciFetch });
      }
      destinations.push(base);
    }
  } catch {
    warnings.push('Cloud Foundry Destination import failed; any usable BAS destinations remain available.');
  }
  return { destinations, createdKeys, warnings };
}

function configuredValue(env, key) {
  return text(env[key]);
}

function cfServerName(env, name) {
  return `cf:${env.BAS_CF_SPACE_GUID}:${env.BAS_CF_DESTINATION_INSTANCE_GUID}:${name}`;
}

function validateRuntimeRecord(record, connectivityAvailable) {
  const reason = reasonFor(record, connectivityAvailable);
  if (reason) throw new Error(`Configured CF destination is unavailable: ${reason}. Rerun sap-ai-dev --setup after correcting the Destination service record.`);
}

async function verifyServiceInstance(instanceGuid, instanceName, spaceGuid, kind, options) {
  let instance;
  try {
    instance = await cfJson(`/v3/service_instances/${encodeURIComponent(instanceGuid)}`, options);
  } catch {
    throw new Error(`Configured ${kind} service instance ${instanceName} is unavailable.`);
  }
  if (instance?.guid !== instanceGuid || instance?.name !== instanceName || instance?.relationships?.space?.data?.guid !== spaceGuid) {
    throw new Error(`Configured ${kind} service instance ${instanceName} does not match the configured space.`);
  }
}

export async function resolveConfiguredCloudFoundryDestination({ env = process.env, execFileImpl = nodeExecFile, fetchImpl = globalThis.fetch } = {}) {
  const spaceGuid = configuredValue(env, 'BAS_CF_SPACE_GUID');
  const destinationInstanceGuid = configuredValue(env, 'BAS_CF_DESTINATION_INSTANCE_GUID');
  const destinationInstanceName = configuredValue(env, 'BAS_CF_DESTINATION_INSTANCE');
  const destinationKeyName = configuredValue(env, 'BAS_CF_DESTINATION_KEY');
  const name = configuredValue(env, 'BAS_CF_DESTINATION_NAME') || text(brandedEnvValue(env, 'DESTINATION'));
  if (!spaceGuid || !destinationInstanceGuid || !destinationInstanceName || !destinationKeyName || !name) {
    throw new Error('Cloud Foundry destination configuration is incomplete; rerun sap-ai-dev --setup.');
  }
  const target = await getCloudFoundryTarget({ env, execFileImpl });
  if (!target.available) throw new Error(`${target.reason.replace(/; CF destinations were skipped\.$/, '')}; run cf target for the configured space and retry.`);
  if (target.spaceGuid !== spaceGuid) throw new Error(`Active Cloud Foundry space does not match configured space ${spaceGuid}; run cf target for that space and retry.`);
  const options = { env, execFileImpl };
  try {
    await verifyServiceInstance(destinationInstanceGuid, destinationInstanceName, spaceGuid, 'Destination', options);
  } catch {
    throw new Error(`Configured Destination service instance ${destinationInstanceName} is unavailable in the configured CF space; rerun sap-ai-dev --setup.`);
  }
  let destinationCredentials;
  try {
    destinationCredentials = await serviceKeyCredentials(destinationInstanceName, destinationKeyName, 'destination', options);
  } catch {
    throw new Error(`Managed Destination service key ${destinationKeyName} for ${destinationInstanceName} is unavailable; rerun sap-ai-dev --setup in the configured space.`);
  }
  let records;
  try {
    records = await destinationRecords(destinationCredentials, fetchImpl);
  } catch {
    throw new Error(`Destination service instance ${destinationInstanceName} could not be read; verify CF login and rerun sap-ai-dev --setup.`);
  }
  const found = records.find(item => item.record.name === name);
  if (!found || found.detailsFailed) throw new Error(`Destination ${name} is no longer available from instance ${destinationInstanceName}; rerun sap-ai-dev --setup.`);
  const record = found.record;
  const serverName = cfServerName(env, name);
  const isOnPremise = record.proxyType === 'OnPremise';
  validateRuntimeRecord(record, true);

  const childEnv = {};
  if (record.authentication === 'BasicAuthentication') {
    childEnv.SAP_USER = record.user;
    childEnv.SAP_PASSWORD = record.password;
    childEnv.SAP_VERBOSE = 'false';
  }
  let url = record.url;
  let close;
  if (isOnPremise) {
    const connectivityInstanceName = configuredValue(env, 'BAS_CF_CONNECTIVITY_INSTANCE');
    const connectivityKeyName = configuredValue(env, 'BAS_CF_CONNECTIVITY_KEY');
    if (!configuredValue(env, 'BAS_CF_CONNECTIVITY_INSTANCE_GUID') || !connectivityInstanceName || !connectivityKeyName) {
      throw new Error(`Configured OnPremise destination ${name} has no Connectivity service reference; rerun sap-ai-dev --setup.`);
    }
    try {
      await verifyServiceInstance(configuredValue(env, 'BAS_CF_CONNECTIVITY_INSTANCE_GUID'), connectivityInstanceName, spaceGuid, 'Connectivity', options);
    } catch {
      throw new Error(`Configured Connectivity service instance ${connectivityInstanceName} is unavailable in the configured CF space; rerun sap-ai-dev --setup.`);
    }
    let credentials;
    try {
      credentials = await serviceKeyCredentials(connectivityInstanceName, connectivityKeyName, 'connectivity', options);
    } catch {
      throw new Error(`Managed Connectivity service key ${connectivityKeyName} for ${connectivityInstanceName} is unavailable; rerun sap-ai-dev --setup in the configured space.`);
    }
    if (!connectivityCredentialsValid(credentials)) throw new Error(`Connectivity service credentials for ${connectivityInstanceName} are incomplete; rerun sap-ai-dev --setup.`);
    let route;
    try {
      const authMode = record.authentication === 'PrincipalPropagation' ? 'principal-propagation' : 'application';
      route = await createCfConnectivityProxy({
        destinationUrl: record.url,
        connectivityCredentials: credentials,
        locationId: record.locationId,
        authMode,
        userTokenProvider: authMode === 'principal-propagation' ? () => currentUserToken(options) : undefined,
        fetchImpl
      });
    } catch {
      throw new Error(`Connectivity route for destination ${name} could not be started; verify the service key and CF user identity.`);
    }
    url = record.url;
    childEnv.HTTP_PROXY = route.url;
    childEnv.HTTPS_PROXY = route.url;
    childEnv.http_proxy = route.url;
    childEnv.https_proxy = route.url;
    childEnv.NO_PROXY = '';
    childEnv.no_proxy = '';
    close = route.close;
  }
  return {
    source: 'cloud-foundry',
    name,
    serverName,
    url,
    client: record.client,
    authentication: record.authentication,
    proxyType: record.proxyType,
    childEnv,
    ...(close ? { close } : {})
  };
}
