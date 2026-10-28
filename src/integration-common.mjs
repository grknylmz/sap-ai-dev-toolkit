// Shared plumbing for the Integration Suite MCP tools: result shaping, OData entity cleanup,
// secret redaction, common input schemas, and a guarded read-only OData GET tool.
import { z } from 'zod';
import { INTEGRATION_CONFIG_ERROR } from './integration-config.mjs';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { strFromU8 } from './iflow-bundle.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';

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
  if (Array.isArray(value?.value)) return value.value;
  if (Array.isArray(value?.d?.results)) return value.d.results;
  if (Array.isArray(value?.d)) return value.d;
  return [];
}

/** Drop OData plumbing (__metadata, deferred navigation links) from an entity. */
export function entity(value) {
  if (Array.isArray(value)) return value.map(entity);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name.startsWith('__') || name.startsWith('@odata.') || name === '@count') continue;
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
  const semanticName = value.Name ?? value.name ?? value.ParameterKey;
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !PROVIDER_SECRET_KEYS.has(name))
    .map(([name, entry]) => [name, /^(?:value|ParameterValue)$/i.test(name) && typeof semanticName === 'string'
      && /password|secret|token|username|clientid|authorization/i.test(semanticName) ? REDACTED : withoutSecrets(entry)]));
}

export const REDACTED = '[redacted]';
const SECRET_FIELD = /password|secret|passphrase|private[_-]?key|api[_-]?key|app[_-]?key|consumer[_-]?key|secure[_-]?param|access[_-]?token|refresh[_-]?token|authorization|cookie|(?:^|[_-])token(?:$|[_-])|csrf[_-]?token/i;
const BINARY_FIELDS = new Set(['ArtifactContent', 'ResourceContent', 'PackageContent', 'CustomTagsConfigurationContent']);

/** Redact known credential fields and semantic name/value pairs, not arbitrary source text. */
export function redactSecrets(value, encrypted = false) {
  if (Array.isArray(value)) return value.map(entry => redactSecrets(entry, encrypted));
  if (!value || typeof value !== 'object') return value;
  const inEncrypted = encrypted || value.encrypted === true || value.encrypted === 'true' || value.isEncrypted === true || value.isEncrypted === 'true';
  const semanticName = value.Name ?? value.name ?? value.ParameterKey;
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (BINARY_FIELDS.has(name)) {
      if (entry !== null && entry !== undefined && entry !== '') result[name] = '[binary omitted]';
      continue;
    }
    if (entry !== null && entry !== undefined && entry !== '' && typeof entry !== 'object'
      && (SECRET_FIELD.test(name) || ((inEncrypted || (typeof semanticName === 'string' && SECRET_FIELD.test(semanticName))) && /^(?:value|ParameterValue)$/i.test(name)))) {
      result[name] = REDACTED;
      continue;
    }
    result[name] = redactSecrets(entry, inEncrypted || name === 'keyMapEntryValues');
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
  return new Date(value).toISOString().slice(0, -1);
}

/** Shared UTC half-open window for monitoring; milliseconds remain significant. */
export function timeWindow(from, to) {
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw new IntegrationError('from and to must both be valid UTC timestamps');
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (end <= start) throw new IntegrationError('to must be after from');
  if (end - start > 31 * 24 * 60 * 60 * 1000) throw new IntegrationError('The monitoring window must not exceed 31 days');
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
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
export const isoDate = z.string().max(40)
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/, 'must be an explicit UTC timestamp')
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), 'must be a valid UTC date/time');
export const top = (max = 200, fallback = 100) => z.number().int().min(1).max(max).default(fallback);
export const secretValue = z.string().min(1).max(4096)
  .describe('Write-only: sent to the tenant once and never echoed back by any tool.');

// ---------------------------------------------------------------- read-only OData GET

const ODATA_SEGMENT = String.raw`[A-Za-z][A-Za-z0-9_]{0,99}(?:\([^/?#]{0,400}\))?`;
const ODATA_PATH = new RegExp(String.raw`^(?:/\$metadata|/${ODATA_SEGMENT}(?:/(?:${ODATA_SEGMENT}|\$count))*)$`);
const ODATA_OPTIONS = ['$filter', '$select', '$expand', '$orderby', '$top', '$skip', '$inlinecount'];

// Version 1: only implemented metadata projections authorize data access. Metadata discovery
// does not authorize raw reads of newly discovered roots or GET function imports.
const fields = names => value => pick(entity(value), names.split(','));
const CPI_PROJECTORS = {
  IntegrationPackages: fields('Id,Name,ShortText,Version,Mode'),
  IntegrationDesigntimeArtifacts: fields('Id,Name,Version,Description,PackageId'),
  ValueMappingDesigntimeArtifacts: fields('Id,Name,Version,Description,PackageId'),
  ScriptCollectionDesigntimeArtifacts: fields('Id,Name,Version,Description,PackageId'),
  MessageMappingDesigntimeArtifacts: fields('Id,Name,Version,Description,PackageId'),
  Configurations: fields('ParameterKey,DataType'),
  IntegrationRuntimeArtifacts: fields('Id,Name,Version,Type,Status,DeployedOn'),
  MessageProcessingLogs: fields('MessageGuid,CorrelationId,ApplicationMessageId,IntegrationFlowName,Status,CustomStatus,LogStart,LogEnd'),
  Runs: fields('Id,RunId,MessageGuid,LogStart,LogEnd,Status'),
  MessageProcessingLogRuns: fields('Id,RunId,MessageGuid,LogStart,LogEnd,Status'),
  RunSteps: fields('StepId,ModelStepId,Activity,Status,StepStart,StepStop'),
  CustomHeaderProperties: fields('Name'),
  JmsBrokers: fields('Name,Capacity,MaxCapacity,CapacityOk,CapacityWarning,CapacityError,QueueNumber,MaxQueueNumber,IsQueuesHigh,IsMessageSpoolHigh,IsTransactedSessionsHigh,IsConsumersHigh,IsProducersHigh'),
  QueueStates: fields('Name,State'),
  InactiveQueues: fields('Name,State'),
  Queues: fields('Name,NumbOfMsgs,Size,Type,State,FillGrade,Active,Exclusive'),
  DataStores: fields('DataStoreName,IntegrationFlow,Type,Visibility,NumberOfMessages,NumberOfOverdueMessages'),
  Entries: fields('Id,Status,MessageId,DueAt,CreatedAt,RetainUntil'),
  Variables: fields('Name,IntegrationFlow,Visibility,UpdatedAt,RetainUntil'),
  UserCredentials: fields('Name,Kind,DeployedOn,Status'),
  OAuth2ClientCredentials: fields('Name,Status'),
  KeystoreEntries: fields('Alias,Type,KeyType,ValidNotBefore,ValidNotAfter'),
  NumberRanges: fields('Name,Description,MinValue,MaxValue,CurrentValue,Rotate,FieldLength'),
  StringParameters: fields('Pid,Id'),
  BinaryParameters: fields('Pid,Id,ContentType')
};
const APIM_PROJECTORS = {
  APIProviders: fields('name,title,destType,host,port,useSSL,isOnPremise,cloudConnectorLocation,pathPrefix'),
  APIProviderAdditionalPropertys: value => ({ ...pick(value, ['entityId', 'name']), ...(/^(?:sap-client)$/i.test(value?.name ?? '') ? pick(value, ['value']) : {}) }),
  APIProxies: fields('name,title,service_code,state,version,provider_name'),
  APIProducts: fields('name,title,status,scope,quotaCount,quotaInterval,quotaTimeUnit'),
  VirtualHosts: fields('id,name,virtual_host,virtual_port,isSSL,isDefault'),
  KeyMapEntries: fields('name,encrypted,scope'),
  keyMapEntryValues: value => ({ ...pick(value, ['name']), value: REDACTED }),
  KeyMapEntryValues: value => ({ ...pick(value, ['name']), value: REDACTED }),
  Applications: fields('id,title,version,status,status_code'),
  Developers: fields('id,status,status_code'),
  CertificateStoreReferences: fields('id,name,alias,type')
};
const CPI_NAVIGATIONS = {
  IntegrationPackages: ['IntegrationDesigntimeArtifacts', 'ValueMappingDesigntimeArtifacts', 'ScriptCollectionDesigntimeArtifacts', 'MessageMappingDesigntimeArtifacts'],
  IntegrationDesigntimeArtifacts: ['Configurations'],
  MessageProcessingLogs: ['Runs', 'CustomHeaderProperties'],
  MessageProcessingLogRuns: ['RunSteps'],
  DataStores: ['Entries'],
  JmsBrokers: ['QueueStates', 'InactiveQueues']
};
const APIM_NAVIGATIONS = { KeyMapEntries: ['keyMapEntryValues'] };
const LOCAL_ROOTS = new Set(['DataStores', 'Entries', 'Variables', 'Queues', 'JmsBrokers', 'QueueStates', 'InactiveQueues', 'NumberRanges', 'UserCredentials', 'OAuth2ClientCredentials', 'KeystoreEntries']);
const COUNT_ROOTS = new Set(['MessageProcessingLogs', 'IntegrationPackages', 'IntegrationRuntimeArtifacts', 'APIProxies', 'APIProviders', 'APIProducts', 'KeyMapEntries']);

function readPolicy(name, path, query) {
  const cpi = name === 'cpi_odata_get';
  const projectors = cpi ? CPI_PROJECTORS : APIM_PROJECTORS;
  const navigations = cpi ? CPI_NAVIGATIONS : APIM_NAVIGATIONS;
  const parts = path.slice(1).split('/');
  const count = parts.at(-1) === '$count';
  if (count) parts.pop();
  if (parts.length > 2) throw new IntegrationError('Only one documented metadata navigation level is allowed');
  const roots = parts.map(part => /^([A-Za-z][A-Za-z0-9_]*)(?:\([^/]*\))?$/.exec(part)?.[1]);
  const [root, navigation] = roots;
  if (!root || !projectors[root] || (navigation && !navigations[root]?.includes(navigation))) {
    throw new IntegrationError('This route has no safe metadata projector; use /$metadata for discovery or a dedicated tool');
  }
  if (count && (navigation || !COUNT_ROOTS.has(root))) throw new IntegrationError('A count contract is not established for this route');
  for (const [option, value] of Object.entries(query)) {
    if (!ODATA_OPTIONS.includes(option) && !(cpi && root === 'KeystoreEntries' && option === 'keystoreName')) throw new IntegrationError(`query option ${option} is not allowed`);
    if (option === '$top' && !/^(?:[1-9]\d?|1\d\d|200)$/.test(value)) throw new IntegrationError('$top must be an integer from 1 to 200');
    if (option === '$skip' && (!/^\d{1,7}$/.test(value) || Number(value) > 1_000_000)) throw new IntegrationError('$skip must be a bounded nonnegative integer');
    if (option === '$inlinecount' && !['allpages', 'none'].includes(value)) throw new IntegrationError('$inlinecount must be allpages or none');
    if (option === 'keystoreName' && !['system', 'backup_admin_system', 'KeyRenewal'].includes(value)) throw new IntegrationError('Unknown keystoreName');
    if (option === '$select' && !/^[A-Za-z][A-Za-z0-9_]*(?:,[A-Za-z][A-Za-z0-9_]*)*$/.test(value)) throw new IntegrationError('$select must contain plain field names');
    if (option === '$expand' && value.split(',').some(entry => !navigations[navigation ?? root]?.includes(entry))) throw new IntegrationError('$expand is not an allowed metadata navigation');
    if (option === '$orderby' && !/^[A-Za-z][A-Za-z0-9_]*(?: (?:asc|desc))?$/.test(value)) throw new IntegrationError('$orderby must contain one plain field');
  }
  const selected = navigation ?? root;
  const project = value => {
    const result = projectors[selected](value);
    for (const child of (query.$expand ?? '').split(',').filter(Boolean)) {
      const raw = value?.[child];
      if (raw !== undefined) result[child] = list(raw).map(projectors[child]);
    }
    return redactSecrets(withoutSecrets(result));
  };
  return { project, collection: parts.length === 2 || !parts[0].includes('('), mode: LOCAL_ROOTS.has(selected) ? 'local' : 'odata', count };
}

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

/** A metadata-only, versioned route allowlist; never an arbitrary GET passthrough. */
export function registerODataReader(register, { name, title, service, request, client, root, examples }) {
  const pager = createCollectionPager(client ?? request, { root, request });
  register(name, title,
    `Read allowlisted operational metadata from ${service}. Discover entity/path names with /$metadata; only implemented safe projectors authorize reads. No function imports, payloads, source, arbitrary expansions, configuration values or secrets. Examples: ${examples}. Collections use signed bounded cursors.`,
    {
      path: z.string().max(1000).regex(ODATA_PATH, 'must be /$metadata or a metadata entity path without query string or media')
        .refine(value => !value.includes('..'), 'must not contain ..'),
      query: z.record(z.string().max(50), z.string().max(2000)).optional(),
      top: top(),
      cursor: cursorSchema
    },
    READ_ONLY_ANNOTATIONS,
    async ({ path, query = {}, top: pageSize, cursor }) => {
      if (path === '/$metadata') {
        if (cursor || Object.keys(query).length) throw new IntegrationError('Metadata discovery accepts no cursor or query options');
        return metadataSummary(await request('GET', path, { accept: 'application/xml', responseType: 'text' }));
      }
      const policy = readPolicy(name, path, query);
      if (policy.count) {
        if (cursor) throw new IntegrationError('Count reads accept no cursor');
        const text = await request('GET', path, { query, accept: 'text/plain', responseType: 'text' });
        const trimmed = String(text).trim();
        if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) throw new IntegrationError('Count endpoint returned invalid nonnegative integer text');
        return { count: Number(trimmed) };
      }
      if (policy.collection) {
        return pager.page({ path, query, top: Number(query.$top ?? pageSize), cursor, project: policy.project, mode: policy.mode, orderBy: query.$orderby });
      }
      if (cursor) throw new IntegrationError('Named metadata reads accept no cursor');
      return policy.project(await request('GET', path, { query }));
    });
}
