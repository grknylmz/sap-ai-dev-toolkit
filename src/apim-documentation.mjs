// Bounded, self-contained consumer documentation. Never return examples or arbitrary extension payloads.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { IntegrationError } from './integration-http.mjs';

export const MAX_DOCUMENTATION_BYTES = 1024 * 1024;
export const DOCUMENTATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new IntegrationError(`API documentation ${message}`); };

function localReference(spec, ref) {
  if (typeof ref !== 'string' || !(ref === '#' || ref.startsWith('#/'))) fail('must be self-contained; external references are not allowed');
  if (ref === '#') return spec;
  let pointer;
  try { pointer = decodeURIComponent(ref.slice(2)); } catch { fail('contains an invalid local reference'); }
  let target = spec;
  for (const token of pointer.split('/')) {
    if (/~(?:[^01]|$)/.test(token)) fail('contains an invalid local reference');
    const part = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if ((!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, part)) fail('contains an unresolved local reference');
    target = target[part];
  }
  return target;
}

function resolve(spec, value) {
  const seen = new Set();
  while (object(value) && typeof value.$ref === 'string') {
    const { $ref: ref, ...siblings } = value;
    if (seen.has(ref)) fail('contains a cyclic structural reference');
    seen.add(ref);
    const target = localReference(spec, ref);
    value = object(target) ? { ...target, ...siblings } : target;
  }
  return value;
}

function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('must use an absolute HTTPS public runtime URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) {
    fail('must use a credential-free HTTPS public runtime URL without query or fragment');
  }
  return url.href.replace(/\/$/, '');
}

/** Validate input without dereferencing URLs or returning document content in errors. */
export function parseApiDocumentation(text, runtimeUrl, { allowMissingVersion = false } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DOCUMENTATION_BYTES) fail('JSON exceeds the 1 MiB limit');
  let spec;
  try { spec = JSON.parse(text); } catch { fail('must be valid OpenAPI JSON'); }
  if (!object(spec) || !(spec.swagger === '2.0' || /^3\.(?:0|1)\.\d+$/.test(spec.openapi ?? ''))) fail('requires swagger 2.0 or openapi 3.0.x/3.1.x');
  if (!object(spec.info) || typeof spec.info.title !== 'string' || !spec.info.title.trim()) fail('requires info.title');
  if ((!allowMissingVersion || spec.info.version !== undefined)
    && (typeof spec.info.version !== 'string' || !spec.info.version.trim())) fail('requires info.version');
  if (!object(spec.paths)) fail('requires an object paths');
  const expected = runtimeUrl === undefined ? undefined : publicUrl(runtimeUrl);
  const checkUrl = value => {
    const canonical = publicUrl(value);
    if (expected !== undefined && canonical !== expected) fail('runtime URL does not match the named proxy');
    return canonical;
  };
  const checkServers = value => {
    if (value === undefined) return;
    if (!Array.isArray(value) || !value.length) fail('servers must be a nonempty array');
    for (const server of value) {
      if (!object(server) || typeof server.url !== 'string' || /[{}]/.test(server.url)) fail('requires concrete runtime servers without variables');
      checkUrl(server.url);
    }
  };
  let servers;
  if (spec.swagger === '2.0') {
    if (!Array.isArray(spec.schemes) || spec.schemes.length !== 1 || spec.schemes[0] !== 'https'
      || typeof spec.host !== 'string' || /[\/?#@]/.test(spec.host)
      || typeof spec.basePath !== 'string' || !spec.basePath.startsWith('/')) fail('requires HTTPS schemes, host and basePath');
    servers = [checkUrl(`https://${spec.host}${spec.basePath}`)];
  } else {
    if (!Array.isArray(spec.servers) || !spec.servers.length) fail('requires explicit runtime servers');
    servers = spec.servers.map(server => {
      if (!object(server) || typeof server.url !== 'string' || /[{}]/.test(server.url)) fail('requires concrete runtime servers without variables');
      return checkUrl(server.url);
    });
  }
  const stack = [spec];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref') localReference(spec, item);
      if (item && typeof item === 'object') stack.push(item);
    }
  }
  for (const [path, original] of Object.entries(spec.paths)) {
    if (path.startsWith('x-')) continue;
    const item = resolve(spec, original);
    if (!path.startsWith('/') || path.length > 2048 || /[?#\r\n]/.test(path) || !object(item)) fail('contains an invalid or overlong path item');
    checkServers(item.servers);
    for (const method of DOCUMENTATION_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      if (!object(operation) || !object(operation.responses)) fail('operations require an object responses');
      checkServers(operation.servers);
    }
  }
  return { spec, servers: [...new Set(servers)] };
}

const bounded = value => typeof value === 'string' ? value.slice(0, 512) : undefined;
const security = value => Array.isArray(value) ? value.filter(object).map(requirement => Object.fromEntries(
  Object.entries(requirement).map(([name, scopes]) => [name, Array.isArray(scopes) ? scopes.filter(scope => typeof scope === 'string').map(bounded) : []])
)) : [];

/** Safe structural summary, with an optional selected operation instead of raw schemas or examples. */
export function summarizeApiDocumentation(text, { path, method, operationOffset = 0 } = {}) {
  const { spec, servers } = parseApiDocumentation(text, undefined, { allowMissingVersion: true });
  const schemes = spec.swagger === '2.0' ? spec.securityDefinitions : spec.components?.securitySchemes;
  const inventory = [];
  for (const [itemPath, original] of Object.entries(spec.paths)) {
    if (itemPath.startsWith('x-')) continue;
    const item = resolve(spec, original);
    for (const verb of DOCUMENTATION_METHODS) if (object(item[verb])) inventory.push({ path: itemPath, method: verb.toUpperCase(), operation_id: bounded(item[verb].operationId) ?? null });
  }
  const result = {
    title: bounded(spec.info.title), version: bounded(spec.info.version) ?? null, openapi_version: spec.openapi ?? spec.swagger,
    sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), servers,
    path_count: Object.keys(spec.paths).filter(value => !value.startsWith('x-')).length, operation_count: inventory.length,
    security_schemes: Object.entries(object(schemes) ? schemes : {}).map(([name, original]) => {
      const scheme = resolve(spec, original);
      return {
        name, type: bounded(scheme?.type) ?? null, scheme: bounded(scheme?.scheme) ?? null,
        in: bounded(scheme?.in) ?? null, parameter_name: bounded(scheme?.name) ?? null,
        flows: object(scheme?.flows) ? Object.keys(scheme.flows) : [],
        scopes: Object.keys(scheme?.scopes ?? {}).concat(...Object.values(scheme?.flows ?? {}).map(flow => Object.keys(flow?.scopes ?? {})))
      };
    }),
    security: security(spec.security), operations: inventory.slice(operationOffset, operationOffset + 100),
    operation_offset: operationOffset, next_operation_offset: operationOffset + 100 < inventory.length ? operationOffset + 100 : null
  };
  if (path !== undefined || method !== undefined) {
    const verb = method?.toLowerCase();
    const item = resolve(spec, spec.paths[path]);
    const operation = item?.[verb];
    if (!DOCUMENTATION_METHODS.includes(verb) || !object(operation)) fail('selected operation does not exist');
    const parameters = new Map();
    for (const original of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
      const parameter = resolve(spec, original);
      parameters.set(JSON.stringify([parameter?.in, parameter?.name]), parameter);
    }
    result.operation = {
      path, method: verb.toUpperCase(), operation_id: bounded(operation.operationId) ?? null,
      summary: bounded(operation.summary) ?? null, security: security(operation.security ?? spec.security),
      parameters: [...parameters.values()]
        .map(parameter => ({ name: bounded(parameter?.name) ?? null, in: bounded(parameter?.in) ?? null, required: parameter?.required === true, type: bounded(parameter?.type ?? resolve(spec, parameter?.schema)?.type) ?? null, ref: bounded(parameter?.$ref) ?? null })),
      request_content_types: spec.swagger === '2.0' ? (operation.consumes ?? spec.consumes ?? []).filter(value => typeof value === 'string').map(bounded) : Object.keys(resolve(spec, operation.requestBody)?.content ?? {}),
      response_statuses: Object.keys(operation.responses)
    };
    if (Buffer.byteLength(JSON.stringify(result.operation)) > 32 * 1024) fail('selected operation summary exceeds 32 KiB');
  }
  return result;
}
