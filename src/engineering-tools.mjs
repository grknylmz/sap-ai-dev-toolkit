import { createHash, randomUUID } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { sanitizeChildEnv } from './bas-discovery.mjs';
import { redactText } from './redact.mjs';

const CHANGESET_WRITE_TOOLS = new Set(['WriteSource']);
const TRANSPORT_CHECK_TOOLS = new Set(['GetTransport', 'GetTransportInfo', 'ListDependencies', 'GetInactiveObjects', 'RunUnitTests', 'RunATCCheck']);
const MAX_CHANGE_BYTES = 128 * 1024;
const MAX_CHANGESET_SIZE = 12;
const MAX_REMOTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SUITE_CASES = 30;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function toolJson(value) {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function safeDiagnostic(value) {
  return redactText(value?.message || value || 'unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function textTool(name, description, properties, required, annotations = { readOnlyHint: true }) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations
  };
}

const changeSchema = {
  type: 'object',
  properties: {
    object_type: { type: 'string', minLength: 1 },
    object_name: { type: 'string', minLength: 1 },
    source_arguments: { type: 'object', description: 'Exact arguments for the destination GetSource tool.' },
    current_source: { type: 'string', description: 'Full source read from SAP before this proposal.' },
    replacement_source: { type: 'string', description: 'Full replacement source to stage.' },
    write_tool: { type: 'string', enum: [...CHANGESET_WRITE_TOOLS] },
    write_arguments: { type: 'object', description: 'Exact arguments for WriteSource, including the full replacement source and matching object_type/name.' }
  },
  required: ['object_type', 'object_name', 'source_arguments', 'current_source', 'replacement_source', 'write_tool', 'write_arguments'],
  additionalProperties: false
};

const TOOLS = {
  PrepareABAPChangeSet: textTool(
    'PrepareABAPChangeSet',
    'Stage a reviewable multi-object ABAP change set. This only reads current sources and stores the proposal in memory; it does not edit SAP.',
    {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      changes: { type: 'array', minItems: 1, maxItems: MAX_CHANGESET_SIZE, items: changeSchema }
    },
    ['title', 'changes']
  ),
  ApplyABAPChangeSet: textTool(
    'ApplyABAPChangeSet',
    'Apply a staged ABAP change set after re-reading every target and confirming its source still matches the reviewed version. Call only after the user approves the proposal.',
    { change_set_id: { type: 'string', minLength: 1 } },
    ['change_set_id'],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  ),
  CheckTransportReadiness: textTool(
    'CheckTransportReadiness',
    'Collect a transport request and dependency, inactive-object, ABAP Unit, and ATC evidence bundle. Only registered read/check tools are accepted; inspect findings before handoff.',
    {
      transport_id: { type: 'string', minLength: 1 },
      checks: {
        type: 'array', minItems: 1, maxItems: 12,
        items: {
          type: 'object', properties: {
            tool: { type: 'string', enum: [...TRANSPORT_CHECK_TOOLS] },
            arguments: { type: 'object' }
          }, required: ['tool', 'arguments'], additionalProperties: false
        }
      }
    },
    ['transport_id', 'checks'],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  ),
  PlanABAPCloudMigration: textTool(
    'PlanABAPCloudMigration',
    'Check SAP release-state evidence for a bounded set of object URIs and prioritize objects that need migration review. It reports SAP evidence without inventing replacement APIs.',
    {
      objects: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object', properties: {
            name: { type: 'string', minLength: 1 },
            object_uri: { type: 'string', pattern: '^/sap/bc/adt/' }
          }, required: ['name', 'object_uri'], additionalProperties: false
        }
      }
    },
    ['objects']
  ),
  GenerateRAPRegressionSuite: textTool(
    'GenerateRAPRegressionSuite',
    'Read an OData service metadata document and return a reusable, read-only smoke suite for its entity sets. Only the connected destination is contacted.',
    { service_root: { type: 'string', minLength: 1, maxLength: 1024 } },
    ['service_root']
  ),
  RunRAPRegressionSuite: textTool(
    'RunRAPRegressionSuite',
    'Run a saved RAP OData GET-only suite against this destination. Requests stay under the supplied OData service root; request bodies and custom authorization headers are not supported.',
    {
      suite: {
        type: 'object', properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          service_root: { type: 'string', minLength: 1, maxLength: 1024 },
          cases: {
            type: 'array', minItems: 1, maxItems: 30,
            items: {
              type: 'object', properties: {
                name: { type: 'string', minLength: 1, maxLength: 120 },
                path: { type: 'string', minLength: 1, maxLength: 1024 },
                expected_status: { type: 'integer', minimum: 100, maximum: 599 },
                expected_content_type: { type: 'string', enum: ['json', 'xml'] },
                assertions: {
                  type: 'array', maxItems: 20,
                  items: {
                    type: 'object', properties: {
                      json_path: { type: 'string', minLength: 1, maxLength: 256 },
                      operator: { type: 'string', enum: ['exists', 'equals', 'array'] },
                      expected: {}
                    }, required: ['json_path', 'operator'], additionalProperties: false
                  }
                }
              }, required: ['name', 'path', 'expected_status'], additionalProperties: false
            }
          }
        }, required: ['name', 'service_root', 'cases'], additionalProperties: false
      }
    },
    ['suite']
  )
};

function validateObject(value, label, allowed) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  if (allowed) {
    const unexpected = Object.keys(value).find(key => !allowed.includes(key));
    if (unexpected) throw new Error(`${label} contains unsupported field ${unexpected}`);
  }
}

function lineDiff(before, after) {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  if (left.length > 1000 || right.length > 1000) return 'Diff omitted: each source is limited to 1,000 lines for inline preview.';
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      rows[i][j] = left[i] === right[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const output = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      output.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (i < left.length && (j === right.length || rows[i + 1][j] >= rows[i][j + 1])) {
      output.push(`-${left[i++]}`);
    } else {
      output.push(`+${right[j++]}`);
    }
  }
  return output.join('\n');
}

function sourceFromResult(result) {
  const candidates = [result?.structuredContent, result?.result, result];
  for (const candidate of candidates) {
    if (object(candidate)) {
      for (const key of ['source', 'sourceCode', 'source_code']) {
        if (typeof candidate[key] === 'string') return candidate[key];
      }
    }
  }
  const content = Array.isArray(result?.content) ? result.content.filter(item => item?.type === 'text').map(item => item.text) : [];
  if (content.length !== 1) return undefined;
  const text = content[0];
  try {
    const parsed = JSON.parse(text);
    if (object(parsed)) {
      for (const key of ['source', 'sourceCode', 'source_code']) if (typeof parsed[key] === 'string') return parsed[key];
    }
  } catch {}
  return text;
}

function resultData(result) {
  if (Array.isArray(result?.content)) {
    return result.content.filter(item => item?.type === 'text').map(item => item.text).join('\n');
  }
  return result?.structuredContent ?? result ?? null;
}

function releaseClassification(result) {
  const candidates = [result?.structuredContent, result];
  for (const candidate of candidates) {
    if (!object(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      const field = key.toLowerCase().replace(/[^a-z]/g, '');
      if (field === 'isreleased' || field === 'released') {
        if (value === true) return 'released';
        if (value === false) return 'not-released';
      }
      if (!['releasestate', 'apireleasestate', 'status', 'state'].includes(field) || typeof value !== 'string') continue;
      const state = value.toLowerCase().replace(/[_-]+/g, ' ').trim();
      if (['released', 'released for cloud', 'released for cloud development', 'released for use in cloud development'].includes(state)) return 'released';
      if (['not released', 'unreleased', 'not released for cloud', 'not released for cloud development'].includes(state)) return 'not-released';
    }
  }
  const text = resultData(result);
  if (typeof text === 'string') {
    try { return releaseClassification({ structuredContent: JSON.parse(text) }); } catch {}
  }
  return 'unknown';
}

function hashSource(source) {
  return createHash('sha256').update(source).digest('hex');
}

function containsSource(value, source) {
  if (typeof value === 'string') return value === source;
  if (Array.isArray(value)) return value.some(entry => containsSource(entry, source));
  if (object(value)) return Object.values(value).some(entry => containsSource(entry, source));
  return false;
}

function validateChangeSet(args, writableTools) {
  validateObject(args, 'arguments', ['title', 'changes']);
  if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 120) throw new Error('title must be 1–120 characters');
  if (!Array.isArray(args.changes) || args.changes.length < 1 || args.changes.length > MAX_CHANGESET_SIZE) throw new Error(`changes must contain 1–${MAX_CHANGESET_SIZE} objects`);
  const seen = new Set();
  for (const [index, change] of args.changes.entries()) {
    validateObject(change, `changes[${index}]`, ['object_type', 'object_name', 'source_arguments', 'current_source', 'replacement_source', 'write_tool', 'write_arguments']);
    for (const key of ['object_type', 'object_name', 'current_source', 'replacement_source', 'write_tool']) {
      if (typeof change[key] !== 'string' || !change[key].length) throw new Error(`changes[${index}].${key} must be a nonempty string`);
    }
    validateObject(change.source_arguments, `changes[${index}].source_arguments`);
    validateObject(change.write_arguments, `changes[${index}].write_arguments`);
    if (!writableTools.has(change.write_tool) || !CHANGESET_WRITE_TOOLS.has(change.write_tool)) throw new Error(`changes[${index}].write_tool is unavailable or not permitted`);
    if (String(change.source_arguments.object_type || '').toUpperCase() !== change.object_type.toUpperCase() ||
        String(change.source_arguments.name || '').toUpperCase() !== change.object_name.toUpperCase()) {
      throw new Error(`changes[${index}].source_arguments must identify the same object`);
    }
    if (String(change.write_arguments.object_type || '').toUpperCase() !== change.object_type.toUpperCase() ||
        String(change.write_arguments.name || '').toUpperCase() !== change.object_name.toUpperCase()) {
      throw new Error(`changes[${index}].write_arguments must identify the same object`);
    }
    if (!containsSource(change.write_arguments, change.replacement_source)) throw new Error(`changes[${index}].write_arguments must contain the exact replacement_source`);
    for (const key of ['current_source', 'replacement_source']) {
      if (Buffer.byteLength(change[key], 'utf8') > MAX_CHANGE_BYTES) throw new Error(`changes[${index}].${key} exceeds ${MAX_CHANGE_BYTES} bytes`);
      if (change[key].split(/\r?\n/).length > 1000) throw new Error(`changes[${index}].${key} exceeds the 1,000-line review limit`);
    }
    if (change.current_source === change.replacement_source) throw new Error(`changes[${index}] does not change the source`);
    const identity = `${change.object_type.toUpperCase()}\0${change.object_name.toUpperCase()}`;
    if (seen.has(identity)) throw new Error(`Change set contains duplicate object ${change.object_type} ${change.object_name}`);
    seen.add(identity);
  }
}

function sanitizeServiceRoot(value, destinationUrl) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new Error('service_root must be an absolute path on the connected SAP destination');
  }
  const base = new URL(destinationUrl);
  const service = new URL(value, base);
  if (service.origin !== base.origin || service.search || service.hash || !service.pathname.toLowerCase().startsWith('/sap/opu/odata')) {
    throw new Error('service_root must be a query-free /sap/opu/odata path on the connected destination');
  }
  const segments = service.pathname.split('/');
  let rawSegments;
  try { rawSegments = decodeURIComponent(value.split(/[?#]/, 1)[0]).split('/'); }
  catch { throw new Error('service_root path encoding is invalid'); }
  if (segments.includes('..') || segments.includes('.') || rawSegments.includes('..') || rawSegments.includes('.')) throw new Error('service_root must not contain dot segments');
  service.pathname = `${service.pathname.replace(/\/+$/, '')}/`;
  return service.pathname;
}

function parseEntitySets(xml) {
  const names = new Set();
  const expression = /<(?:[A-Za-z_][\w.-]*:)?EntitySet\b([^>]*)>/gi;
  let match;
  while ((match = expression.exec(xml))) {
    const name = /\bName\s*=\s*(["'])(.*?)\1/i.exec(match[1])?.[2];
    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

async function readBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REMOTE_BODY_BYTES) {
        await reader.cancel();
        throw new Error('SAP response exceeded the 2 MiB read limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function responseForDemo(path) {
  if (path.endsWith('$metadata')) {
    return {
      status: 200,
      contentType: 'application/xml',
      body: '<?xml version="1.0"?><edmx:Edmx><edmx:DataServices><Schema><EntityContainer><EntitySet Name="Orders"/><EntitySet Name="OrderItems"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>'
    };
  }
  return { status: 200, contentType: 'application/json', body: JSON.stringify({ value: [{ ID: '10000001', Description: 'Sample order' }] }) };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// OData reads follow the same egress rules as the relay: loopback targets
// (the local BAS relay the child talks to) must go direct, NO_PROXY
// exemptions are honored, and everything else uses the configured proxy.
function proxyUrlFor(target, env) {
  if (isLoopbackHost(target.hostname)) return '';
  const host = target.hostname.toLowerCase();
  const noProxy = String(env.NO_PROXY || env.no_proxy || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (noProxy.some(entry => entry === '*' || host === entry || host.endsWith(entry.startsWith('.') ? entry : `.${entry}`))) return '';
  return String(env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy || '');
}

async function fetchOData(entry, path, accept, env) {
  if (entry.destination.demo) return responseForDemo(path);
  const childEnv = { ...sanitizeChildEnv(env), ...(entry.destination.childEnv || {}) };
  const target = new URL(path, entry.destination.url);
  const base = new URL(entry.destination.url);
  if (target.origin !== base.origin || target.username || target.password || target.hash) throw new Error('OData request escaped the connected destination');
  const proxyUrl = proxyUrlFor(target, childEnv);
  if (!proxyUrl && /\.dest$/i.test(target.hostname)) throw new Error('No HTTP proxy is configured for the .dest destination');
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const response = await undiciFetch(target, {
      method: 'GET',
      headers: { accept },
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual'
    });
    const body = await readBody(response);
    return { status: response.status, contentType: response.headers.get('content-type') || '', body };
  } finally {
    await dispatcher?.close();
  }
}

function pathValue(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (!segment || ['__proto__', 'prototype', 'constructor'].includes(segment)) return undefined;
    if (current === null || current === undefined || (typeof current !== 'object' && !Array.isArray(current))) return undefined;
    current = current[segment];
  }
  return current;
}

function validateSuite(suite, destinationUrl) {
  validateObject(suite, 'suite', ['name', 'service_root', 'cases']);
  if (typeof suite.name !== 'string' || !suite.name.trim() || suite.name.length > 120) throw new Error('suite.name must be 1–120 characters');
  const root = sanitizeServiceRoot(suite.service_root, destinationUrl);
  if (!Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > 30) throw new Error('suite.cases must contain 1–30 cases');
  const cases = suite.cases.map((testCase, index) => {
    validateObject(testCase, `suite.cases[${index}]`, ['name', 'path', 'expected_status', 'expected_content_type', 'assertions']);
    if (typeof testCase.name !== 'string' || !testCase.name.trim()) throw new Error(`suite.cases[${index}].name is required`);
    if (typeof testCase.path !== 'string' || !testCase.path || testCase.path.startsWith('/') || testCase.path.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(testCase.path) || testCase.path.includes('\\') || testCase.path.includes('#')) throw new Error(`suite.cases[${index}].path is invalid`);
    let decodedPath;
    try { decodedPath = decodeURIComponent(testCase.path.split('?', 1)[0]); }
    catch { throw new Error(`suite.cases[${index}].path encoding is invalid`); }
    if (decodedPath.split('/').some(segment => segment === '.' || segment === '..')) throw new Error(`suite.cases[${index}].path must not contain dot segments`);
    if (!Number.isInteger(testCase.expected_status) || testCase.expected_status < 100 || testCase.expected_status > 599) throw new Error(`suite.cases[${index}].expected_status must be an HTTP status`);
    if (testCase.expected_content_type !== undefined && !['json', 'xml'].includes(testCase.expected_content_type)) throw new Error(`suite.cases[${index}].expected_content_type must be json or xml`);
    if (testCase.assertions !== undefined && (!Array.isArray(testCase.assertions) || testCase.assertions.length > 20)) throw new Error(`suite.cases[${index}].assertions must contain at most 20 checks`);
    for (const [assertionIndex, assertion] of (testCase.assertions || []).entries()) {
      validateObject(assertion, `suite.cases[${index}].assertions[${assertionIndex}]`, ['json_path', 'operator', 'expected']);
      if (typeof assertion.json_path !== 'string' || !assertion.json_path || !['exists', 'equals', 'array'].includes(assertion.operator)) throw new Error(`suite.cases[${index}].assertions[${assertionIndex}] is invalid`);
      if (assertion.operator === 'equals' && !Object.hasOwn(assertion, 'expected')) throw new Error(`suite.cases[${index}].assertions[${assertionIndex}].expected is required for equals`);
    }
    const target = new URL(testCase.path, new URL(root, destinationUrl));
    const base = new URL(destinationUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith(root) || target.username || target.password || target.hash) throw new Error(`suite.cases[${index}].path must remain under service_root`);
    return testCase;
  });
  return { name: suite.name, service_root: root, cases };
}

async function remoteTool(entry, name, args, availableTools, log) {
  const definition = availableTools.get(name);
  if (!definition) throw new Error(`Destination does not expose required tool ${name}`);
  const startedAt = Date.now();
  log?.(`[${entry.destination.name}] workflow call ${name} started`);
  try {
    const response = await entry.child.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(response.error.message || `${name} failed`);
    if (response.result?.isError) throw new Error(resultData(response.result) || `${name} failed`);
    log?.(`[${entry.destination.name}] workflow call ${name} completed in ${Date.now() - startedAt}ms`);
    return response.result;
  } catch (error) {
    log?.(`[${entry.destination.name}] workflow call ${name} failed: ${safeDiagnostic(error)}`);
    throw error;
  }
}

export function createEngineeringTools(entry, upstreamTools, { env = process.env, log } = {}) {
  const available = new Map(upstreamTools.map(tool => [tool.name, tool]));
  entry.engineeringState ||= { proposals: new Map() };
  const { proposals } = entry.engineeringState;
  const definitions = [];
  const handlers = new Map();
  const add = (definition, handler) => {
    if (available.has(definition.name)) return;
    definitions.push(definition);
    handlers.set(definition.name, async args => {
      try {
        return await handler(args);
      } catch (error) {
        return toolError(safeDiagnostic(error));
      }
    });
  };

  if (available.has('GetSource') && [...available.keys()].some(name => CHANGESET_WRITE_TOOLS.has(name))) {
    add(TOOLS.PrepareABAPChangeSet, async args => {
      validateChangeSet(args, new Set(available.keys()));
      if (proposals.size >= 32) {
        const completed = [...proposals].find(([, proposal]) => proposal.status === 'applied');
        if (completed) proposals.delete(completed[0]);
        else throw new Error('This MCP session already has 32 unapplied change sets. Resolve or restart the session before staging another.');
      }
      const id = randomUUID();
      const changes = args.changes.map(change => ({
        ...change,
        applied: false,
        expected_sha256: hashSource(change.current_source)
      }));
      proposals.set(id, { title: args.title.trim(), changes, status: 'staged' });
      return toolJson({
        change_set_id: id,
        title: args.title.trim(),
        status: 'staged',
        destination: entry.destination.name,
        changes: changes.map(change => ({
          object_type: change.object_type,
          object_name: change.object_name,
          expected_sha256: change.expected_sha256,
          diff: lineDiff(change.current_source, change.replacement_source)
        })),
        next_step: 'Review every diff, then call ApplyABAPChangeSet only after approval.'
      });
    });

    add(TOOLS.ApplyABAPChangeSet, async args => {
      validateObject(args, 'arguments', ['change_set_id']);
      if (typeof args.change_set_id !== 'string') throw new Error('change_set_id is required');
      const proposal = proposals.get(args.change_set_id);
      if (!proposal) throw new Error('Change set was not found in this MCP session');
      if (proposal.status === 'applied') throw new Error('Change set has already been applied');
      if (proposal.status === 'conflict') throw new Error('Source conflict was already detected; prepare and review a new change set.');
      const failures = [];
      for (const change of proposal.changes) {
        if (change.applied) continue;
        try {
          const currentResult = await remoteTool(entry, 'GetSource', change.source_arguments, available, log);
          const current = sourceFromResult(currentResult);
          if (current === undefined) throw new Error(`GetSource did not return source text for ${change.object_type} ${change.object_name}`);
          if (current !== change.current_source || hashSource(current) !== change.expected_sha256) {
            failures.push({ object_type: change.object_type, object_name: change.object_name, status: 'conflict', message: 'Source changed since review; prepare a new change set.' });
            proposal.status = 'conflict';
            break;
          }
          await remoteTool(entry, change.write_tool, change.write_arguments, available, log);
          change.applied = true;
        } catch (error) {
          failures.push({ object_type: change.object_type, object_name: change.object_name, status: 'failed', message: safeDiagnostic(error) });
          proposal.status = proposal.changes.some(item => item.applied) ? 'partially-applied' : 'failed';
          break;
        }
      }
      const applied = proposal.changes.filter(change => change.applied).map(change => ({ object_type: change.object_type, object_name: change.object_name, status: 'applied' }));
      if (failures.length) {
        return toolJson({ change_set_id: args.change_set_id, status: proposal.status, applied, failures, remaining: proposal.changes.filter(change => !change.applied).length });
      }
      proposal.status = 'applied';
      return toolJson({ change_set_id: args.change_set_id, status: proposal.status, applied, failures: [] });
    });
  }

  if (available.has('GetTransport')) {
    add(TOOLS.CheckTransportReadiness, async args => {
      validateObject(args, 'arguments', ['transport_id', 'checks']);
      if (typeof args.transport_id !== 'string' || !args.transport_id.trim()) throw new Error('transport_id is required');
      if (!Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > 12) throw new Error('checks must contain 1–12 checks');
      const transportChecks = args.checks.filter(check => check?.tool === 'GetTransport');
      if (transportChecks.length !== 1 || transportChecks[0].arguments?.transport !== args.transport_id) {
        throw new Error('checks must include exactly one GetTransport call for transport_id');
      }
      const results = [];
      for (const [index, check] of args.checks.entries()) {
        validateObject(check, `checks[${index}]`, ['tool', 'arguments']);
        if (!TRANSPORT_CHECK_TOOLS.has(check.tool) || !object(check.arguments)) throw new Error(`checks[${index}] must use a supported read/check tool and object arguments`);
        try {
          const result = await remoteTool(entry, check.tool, check.arguments, available, log);
          results.push({ tool: check.tool, status: 'completed', evidence: resultData(result) });
        } catch (error) {
          results.push({ tool: check.tool, status: 'failed', error: safeDiagnostic(error) });
        }
      }
      const failures = results.filter(result => result.status !== 'completed').length;
      return toolJson({
        transport_id: args.transport_id,
        destination: entry.destination.name,
        status: failures ? 'evidence-incomplete' : 'evidence-collected',
        checks_completed: results.length - failures,
        checks_failed: failures,
        checks: results,
        interpretation: 'Completed calls can still contain findings. Review every evidence item before declaring the transport ready.'
      });
    });
  }

  if (available.has('GetAPIReleaseState')) {
    add(TOOLS.PlanABAPCloudMigration, async args => {
      validateObject(args, 'arguments', ['objects']);
      if (!Array.isArray(args.objects) || args.objects.length < 1 || args.objects.length > 50) throw new Error('objects must contain 1–50 entries');
      const results = [];
      for (const [index, item] of args.objects.entries()) {
        validateObject(item, `objects[${index}]`, ['name', 'object_uri']);
        if (typeof item.name !== 'string' || !item.name.trim() || typeof item.object_uri !== 'string' || !/^\/sap\/bc\/adt\//i.test(item.object_uri)) {
          results.push({ name: typeof item.name === 'string' ? item.name : `object-${index + 1}`, status: 'invalid', error: 'Expected an object name and SAP ADT object URI.' });
          continue;
        }
        try {
          const result = await remoteTool(entry, 'GetAPIReleaseState', { object_uri: item.object_uri }, available, log);
          results.push({ name: item.name, object_uri: item.object_uri, status: 'checked', release_state: releaseClassification(result), evidence: resultData(result) });
        } catch (error) {
          results.push({ name: item.name, object_uri: item.object_uri, status: 'failed', error: safeDiagnostic(error) });
        }
      }
      return toolJson({
        destination: entry.destination.name,
        assessed: results.length,
        failures: results.filter(result => result.status !== 'checked').length,
        results,
        migration_review_order: results.filter(result => result.status === 'checked').sort((a, b) => {
          const order = { 'not-released': 0, unknown: 1, released: 2 };
          return order[a.release_state] - order[b.release_state];
        }).map(result => ({ name: result.name, release_state: result.release_state })),
        note: 'Release status is SAP evidence for this system. Candidate replacements require separate verification against the target release.'
      });
    });
  }

  add(TOOLS.GenerateRAPRegressionSuite, async args => {
    validateObject(args, 'arguments', ['service_root']);
    const serviceRoot = sanitizeServiceRoot(args.service_root, entry.destination.url);
    const metadataPath = `${serviceRoot}$metadata`;
    const response = await fetchOData(entry, metadataPath, 'application/xml,text/xml', env);
    if (response.status < 200 || response.status >= 300) throw new Error(`OData metadata request returned HTTP ${response.status}`);
    const entitySets = parseEntitySets(response.body);
    if (!entitySets.length) throw new Error('OData metadata did not contain entity sets');
    // Cap generation so the emitted suite is always accepted by
    // RunRAPRegressionSuite's own 30-case limit; report what was omitted.
    const included = entitySets.slice(0, MAX_SUITE_CASES - 1);
    return toolJson({
      suite: {
        name: `${entry.destination.name} RAP smoke suite`,
        service_root: serviceRoot,
        cases: [
          { name: 'OData metadata', path: '$metadata', expected_status: 200, expected_content_type: 'xml' },
          ...included.map(name => ({ name: `Read ${name}`, path: `${name}?$top=1`, expected_status: 200, expected_content_type: 'json' }))
        ]
      },
      entity_set_count: entitySets.length,
      destination: entry.destination.name,
      ...(entitySets.length > included.length
        ? { note: `${entitySets.length - included.length} entity sets were omitted to keep the suite within the ${MAX_SUITE_CASES}-case limit; generate targeted suites for them separately.` }
        : {})
    });
  });

  add(TOOLS.RunRAPRegressionSuite, async args => {
    validateObject(args, 'arguments', ['suite']);
    const suite = validateSuite(args.suite, entry.destination.url);
    const results = [];
    for (const testCase of suite.cases) {
      const fullPath = new URL(testCase.path, new URL(suite.service_root, entry.destination.url));
      let response;
      try {
        response = await fetchOData(entry, fullPath.pathname + fullPath.search, testCase.expected_content_type === 'xml' ? 'application/xml,text/xml' : 'application/json', env);
      } catch (error) {
        results.push({ name: testCase.name, status: 'failed', error: safeDiagnostic(error) });
        continue;
      }
      const checks = [];
      checks.push({ check: 'status', passed: response.status === testCase.expected_status });
      if (testCase.expected_content_type) {
        const expected = testCase.expected_content_type === 'json' ? 'json' : 'xml';
        const actual = response.contentType.toLowerCase();
        checks.push({ check: 'content-type', passed: expected === 'json' ? actual.includes('json') : (actual.includes('xml') || fullPath.pathname.endsWith('$metadata')) });
      }
      if (testCase.assertions?.length) {
        let parsed;
        try { parsed = JSON.parse(response.body); } catch {}
        for (const assertion of testCase.assertions) {
          const actual = parsed === undefined ? undefined : pathValue(parsed, assertion.json_path);
          const passed = assertion.operator === 'exists'
            ? actual !== undefined
            : assertion.operator === 'array'
              ? Array.isArray(actual)
              : assertion.operator === 'equals' && JSON.stringify(actual) === JSON.stringify(assertion.expected);
          checks.push({ check: `json:${assertion.json_path}:${assertion.operator}`, passed });
        }
      }
      results.push({
        name: testCase.name,
        status: checks.every(check => check.passed) ? 'passed' : 'failed',
        http_status: response.status,
        checks
      });
    }
    const failed = results.filter(result => result.status !== 'passed').length;
    return toolJson({ suite: suite.name, destination: entry.destination.name, status: failed ? 'failed' : 'passed', passed: results.length - failed, failed, results });
  });

  return definitions.map(definition => ({
    definition,
    handler: handlers.get(definition.name)
  }));
}
