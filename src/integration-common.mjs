// Shared plumbing for the Integration Suite MCP tools: result shaping, OData entity cleanup,
// secret redaction, common input schemas, and a guarded read-only OData GET tool.
import { z } from 'zod';
import { INTEGRATION_CONFIG_ERROR } from './integration-config.mjs';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { strFromU8 } from './iflow-bundle.mjs';

export const INTEGRATION_MAX_OUTPUT_BYTES = 96 * 1024;
export const FILE_TEXT_CAP = 48 * 1024;
export const SINGLE_FILE_CAP = 90 * 1024;
export const ERROR_TEXT_CAP = 16 * 1024;
const TEXT_EXTENSIONS = new Set(['.iflw', '.groovy', '.gsh', '.js', '.py', '.xsl', '.xslt', '.xsd', '.wsdl', '.prop', '.propdef', '.mmap', '.json', '.xml', '.MF', '.project', '.edmx']);

export const READ_ONLY_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
export const CREATE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
export const OVERWRITE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

// ---------------------------------------------------------------- results

function jsonSafe(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { type: 'binary', bytes: value.byteLength };
  if (Array.isArray(value)) return value.map(entry => jsonSafe(entry, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, seen)]));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function jsonText(value) {
  const text = JSON.stringify(jsonSafe(value), null, 2);
  if (Buffer.byteLength(text, 'utf8') > INTEGRATION_MAX_OUTPUT_BYTES) {
    throw new IntegrationError('Integration Suite result is too large to return safely; narrow the request (for example file_path, $select or a smaller top).');
  }
  return text;
}

export function toolError(error) {
  let message = 'Integration Suite request failed. Check service-key roles and tenant reachability.';
  if (error?.name === 'IntegrationError' || (typeof error?.message === 'string' && INTEGRATION_CONFIG_ERROR.test(error.message))) {
    message = error.message;
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export async function resultOf(operation) {
  try {
    return { content: [{ type: 'text', text: jsonText(await operation()) }] };
  } catch (error) {
    return toolError(error);
  }
}

// ---------------------------------------------------------------- helpers

export const key = value => encodeURIComponent(odataKey(value));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new IntegrationError(`confirmation must equal ${expected}`);
}

export function list(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

/** Drop OData plumbing (__metadata, deferred navigation links) from an entity. */
export function entity(value) {
  if (Array.isArray(value)) return value.map(entity);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name.startsWith('__')) continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.__deferred) continue;
    result[name] = entry && typeof entry === 'object' && Array.isArray(entry.results) ? entity(entry.results) : entity(entry);
  }
  return result;
}

const PROVIDER_SECRET_KEYS = new Set(['password', 'clientSecret', 'userSecret', 'orgSecret', 'keystorePassword', 'userName', 'clientId']);

/** Remove API provider credential properties (including user and client ids) entirely. */
export function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !PROVIDER_SECRET_KEYS.has(name))
    .map(([name, entry]) => [name, withoutSecrets(entry)]));
}

export const REDACTED = '[redacted]';
const SECRET_FIELD = /password|secret|passphrase|private_?key|api_?key|app_?key|consumer_?key|secure_?param|access_?token|refresh_?token/i;
const BINARY_FIELDS = new Set(['ArtifactContent', 'ResourceContent', 'PackageContent', 'CustomTagsConfigurationContent']);

/**
 * Replace secret-looking values with [redacted] and omit base64 artifact content. Inside an object flagged
 * encrypted/isEncrypted (APIM key value maps) every nested `value` is redacted as well.
 */
export function redactSecrets(value, encrypted = false) {
  if (Array.isArray(value)) return value.map(entry => redactSecrets(entry, encrypted));
  if (!value || typeof value !== 'object') return value;
  const inEncrypted = encrypted || value.encrypted === true || value.isEncrypted === true;
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (BINARY_FIELDS.has(name)) {
      if (entry !== null && entry !== undefined && entry !== '') result[name] = '[binary omitted]';
      continue;
    }
    if (entry !== null && entry !== undefined && entry !== '' && typeof entry !== 'object'
      && (SECRET_FIELD.test(name) || (inEncrypted && name === 'value'))) {
      result[name] = REDACTED;
      continue;
    }
    result[name] = redactSecrets(entry, inEncrypted);
  }
  return result;
}

export function pick(value, names) {
  return Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
}

export function capText(text, limit) {
  if (typeof text !== 'string') return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= limit) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, limit)).replace(/\uFFFD$/, ''), truncated: true };
}

export function isoToOdataDateTime(value) {
  return new Date(value).toISOString().slice(0, 19);
}

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index);
}

export function fileEntry(path, bytes, limit) {
  const entry = { path, bytes: bytes.byteLength };
  if (TEXT_EXTENSIONS.has(extensionOf(path))) {
    const { text, truncated } = capText(strFromU8(bytes), limit);
    entry.text = text;
    if (truncated) entry.truncated = true;
  }
  return entry;
}

/** Files of an unzipped bundle (Map path → bytes), or one file when filePath is set. */
export function bundleFiles(bundle, filePath) {
  if (filePath) {
    const bytes = bundle.get(filePath);
    if (!bytes) throw new IntegrationError('file_path not found in the bundle');
    return { file: fileEntry(filePath, bytes, SINGLE_FILE_CAP) };
  }
  return {
    files: [...bundle.entries()]
      .filter(([name]) => !name.endsWith('/'))
      .map(([name, bytes]) => fileEntry(name, bytes, FILE_TEXT_CAP))
  };
}

// ---------------------------------------------------------------- schemas

export const confirmation = z.string().min(1).max(300);
export const isoDate = z.string().max(40).refine(value => !Number.isNaN(Date.parse(value)), 'must be an ISO-8601 date/time');
export const top = (max = 200, fallback = 100) => z.number().int().min(1).max(max).default(fallback);
export const secretValue = z.string().min(1).max(4096)
  .describe('Write-only: sent to the tenant once and never echoed back by any tool.');

// ---------------------------------------------------------------- read-only OData GET

const ODATA_SEGMENT = String.raw`[A-Za-z][A-Za-z0-9_]{0,99}(?:\([^/?#]{0,400}\))?`;
const ODATA_PATH = new RegExp(String.raw`^(?:/\$metadata|/${ODATA_SEGMENT}(?:/(?:${ODATA_SEGMENT}|\$count))*)$`);
const ODATA_OPTIONS = ['$filter', '$select', '$expand', '$orderby', '$top', '$skip', '$inlinecount'];

/** Summarize an OData $metadata document into entity sets and function imports. */
export function metadataSummary(xml) {
  const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const entitySets = [...String(xml).matchAll(/<EntitySet\b[^>]*>/g)]
    .map(([tag]) => ({ name: attribute(tag, 'Name'), entity_type: attribute(tag, 'EntityType') }))
    .filter(entry => entry.name);
  const functionImports = [...String(xml).matchAll(/<FunctionImport\b[^>]*>/g)]
    .map(([tag]) => ({ name: attribute(tag, 'Name'), http_method: attribute(tag, 'm:HttpMethod') ?? null, return_type: attribute(tag, 'ReturnType') ?? null }))
    .filter(entry => entry.name);
  return { entity_sets: entitySets, function_imports: functionImports };
}

/**
 * Register a guarded read-only GET over one OData service. Media ($value), $batch and $links
 * are rejected so payloads and binary content stay out of reach; secrets are redacted.
 */
export function registerODataReader(register, { name, title, service, request, examples }) {
  register(name, title,
    `Read-only GET against the ${service} OData API for entity sets without a dedicated tool. path is relative to the service root, e.g. ${examples}. Use /$metadata to list entity sets and function imports. Media streams ($value), $batch and $links are not allowed; secret-like fields and artifact content are redacted.`,
    {
      path: z.string().max(1000).regex(ODATA_PATH, 'must be /$metadata or /EntitySet[(key)][/Navigation...][/$count] without $value, query string or ..')
        .refine(value => !value.includes('..'), 'must not contain ..'),
      query: z.record(z.string().regex(/^(?:\$[a-z]+|[A-Za-z][A-Za-z0-9_]{0,40})$/), z.string().max(2000)).optional()
        .describe(`OData system options (${ODATA_OPTIONS.join(', ')}) and service-specific custom parameters (e.g. keystoreName).`)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ path, query = {} }) => {
      for (const option of Object.keys(query)) {
        if (option.startsWith('$') && !ODATA_OPTIONS.includes(option)) throw new IntegrationError(`query option ${option} is not allowed`);
      }
      if (path === '/$metadata') {
        return metadataSummary(await request('GET', path, { accept: 'application/xml', responseType: 'text' }));
      }
      if (path.endsWith('/$count')) {
        const text = await request('GET', path, { query, accept: 'text/plain', responseType: 'text' });
        return { count: Number(String(text).trim()) };
      }
      const parsed = await request('GET', path, { query, unwrap: false });
      const data = parsed?.d ?? parsed;
      const total = Number(data?.__count);
      const results = Array.isArray(data?.results) ? data.results : null;
      const cleaned = redactSecrets(entity(results ?? data));
      return results
        ? { total: Number.isFinite(total) ? total : null, returned: results.length, more: Boolean(data?.__next), results: cleaned }
        : cleaned;
    });
}
