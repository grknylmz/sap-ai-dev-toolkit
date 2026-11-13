// Datasphere command discovery: the tenant OpenAPI discovery document drives the
// generic CLI tools. Primary source is the REST tenant (same document the CLI
// itself uses); fallback is the CLI's local discovery cache after `config cache init`.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IntegrationError } from './integration-http.mjs';

const DISCOVERY_PATH = '/dwaas-core/api/v1/discovery';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const TECHNICAL_USER_PREFIXES = ['configuration certificates', 'marketplace', 'objects', 'spaces connections', 'tasks'];
const DESCRIPTION_CAP = 300;

const kebab = name => String(name)
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

function resolveRef(document, ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = document;
  for (const segment of ref.slice(2).split('/')) {
    node = node?.[segment];
    if (node === undefined) return null;
  }
  return node || null;
}

function bodyPropertyNames(document, requestBody) {
  const body = requestBody?.$ref ? (resolveRef(document, requestBody.$ref) || requestBody) : requestBody;
  const schema = body?.content?.['application/json']?.schema;
  const resolved = schema?.$ref ? (resolveRef(document, schema.$ref) || schema) : schema;
  const properties = resolved?.properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.keys(properties);
}

function catalogEntry(document, op, method, command) {
  const parameters = [];
  for (const parameter of Array.isArray(op.parameters) ? op.parameters : []) {
    const resolved = parameter?.$ref ? (resolveRef(document, parameter.$ref) || parameter) : parameter;
    if (!resolved?.name || !['path', 'query', 'header'].includes(resolved.in)) continue;
    parameters.push({
      name: resolved.name,
      in: resolved.in,
      required: Boolean(resolved.required),
      option: `--${kebab(resolved.name)}`
    });
  }
  const fileBodyOnly = Boolean(op['x-requestbody-fileonly']);
  const hasBody = Boolean(op.requestBody) || fileBodyOnly;
  if (hasBody) {
    for (const name of bodyPropertyNames(document, op.requestBody)) {
      parameters.push({ name, in: 'body', required: false, option: `--${kebab(name)}` });
    }
  }
  return {
    command,
    method,
    summary: typeof op.summary === 'string' ? op.summary : '',
    description: String(op.description || op.summary || '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CAP),
    deprecated: Boolean(op.deprecated),
    confirm_required: Boolean(op['x-user-to-confirm']),
    file_body_only: fileBodyOnly,
    has_body: hasBody,
    access: method === 'get' ? 'read' : method === 'delete' ? 'delete' : 'write',
    technical_user_supported: TECHNICAL_USER_PREFIXES.some(prefix => command.startsWith(prefix)),
    parameters
  };
}

function catalogFromDocument(document) {
  const entries = [];
  for (const item of Object.values(document?.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    const sharedParameters = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const withShared = sharedParameters.length ? { ...op, parameters: [...sharedParameters, ...(op.parameters || [])] } : op;
      const ids = Array.isArray(op.operationId) ? op.operationId : [op.operationId];
      for (const id of ids) {
        if (typeof id === 'string') {
          entries.push(catalogEntry(document, withShared, method, id.split(' ').filter(Boolean).join(' ')));
        } else if (id && typeof id === 'object' && typeof id.operationId === 'string') {
          const merged = { ...withShared, ...id };
          entries.push(catalogEntry(document, merged, method, id.operationId.split(' ').filter(Boolean).join(' ')));
        }
      }
    }
  }
  const seen = new Map();
  for (const entry of entries.filter(entry => entry.command)) seen.set(`${entry.command} ${entry.method}`, entry);
  return [...seen.values()].sort((a, b) => a.command.localeCompare(b.command));
}

async function newestCacheFile(stateDir) {
  const root = join(stateDir, '.@sap');
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    if (typeof entry.isDirectory === 'function' ? entry.isDirectory() : true) continue;
    const base = String(entry.name).split(/[\\/]/).pop();
    if (!base.startsWith('discovery-') || !base.endsWith('.json') || base === 'discovery-metadata.json') continue;
    const path = join(entry.parentPath || entry.path, entry.name);
    const mtime = (await stat(path).catch(() => null))?.mtimeMs;
    if (mtime !== undefined && (!newest || mtime > newest.mtime)) newest = { path, mtime };
  }
  return newest?.path || null;
}

/**
 * Load the Datasphere CLI command catalog from the tenant discovery document
 * (REST), falling back to the CLI's cached discovery JSON.
 */
export async function loadDatasphereCommands({ rest, cli } = {}) {
  const failures = [];
  if (rest) {
    try {
      const document = await rest.request('GET', DISCOVERY_PATH, { accept: 'application/json' });
      const catalog = catalogFromDocument(document);
      if (catalog.length) return catalog;
      failures.push('discovery document contained no commands');
    } catch (error) {
      failures.push(error?.message || String(error));
    }
  } else {
    failures.push('no REST client');
  }
  if (cli) {
    try {
      await cli.init();
      const path = await newestCacheFile(cli.stateDir());
      if (!path) throw new Error('no cached discovery document');
      const catalog = catalogFromDocument(JSON.parse(await readFile(path, 'utf8')));
      if (catalog.length) return catalog;
      failures.push('cached discovery document contained no commands');
    } catch (error) {
      failures.push(error?.message || String(error));
    }
  } else {
    failures.push('no CLI runtime');
  }
  throw new IntegrationError(`Datasphere command discovery is unavailable: ${failures.join('; ')}`);
}
