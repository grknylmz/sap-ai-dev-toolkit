import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { redactSecrets, resultOf } from '../src/integration-common.mjs';
import { AUTOMATION_TOOL_NAMES, registerAutomationTools } from '../src/process-automation-automation-tools.mjs';

const UNIFIED = '/public/unified/v1';
const IRPA = '/public/irpa/runtime/v1';
const MONITORING = '/public/irpa/monitoring/v1';
const KEY = 'never-emit-this-irpa-key';
const INSTANCE_ID = '0f1e2d3c-4b5a-11ef-8a9b-0242ac120002';

function fixture({ access = { apiKey: KEY, environmentId: null }, responder = () => undefined } = {}) {
  const tools = {};
  const names = [];
  const register = (name, title, description, inputSchema, annotations, handler) => {
    names.push(name);
    const schema = typeof inputSchema?.parse === 'function' ? inputSchema : z.object(inputSchema);
    tools[name] = { annotations, handler: async args => resultOf(
      async () => redactSecrets(await handler(schema.parse(args ?? {}))),
      { product: 'SAP Build Process Automation', fallback: 'SAP Build Process Automation request failed.' }
    ) };
  };
  const requests = [];
  const rest = { request: async (method, path, options = {}) => {
    requests.push({ method, path, options });
    const reply = await responder(method, path, options);
    return reply === undefined ? [] : reply;
  } };
  registerAutomationTools(register, { rest, access });
  return { names, tools, requests };
}

const textOf = result => result.content.map(part => part.text).join('\n');
const parse = result => JSON.parse(result.content[0].text);

test('registers AUTOMATION_TOOL_NAMES in order', () => {
  assert.deepEqual(fixture().names, [...AUTOMATION_TOOL_NAMES]);
});

test('unified list sends $filter/$expand, environmentId and optional api-key header', async () => {
  const f = fixture({ access: { apiKey: null, environmentId: 'env-default' } });
  await f.tools.bpa_list_api_triggers.handler({ filter: "name eq 'x'", expand: 'definition' });
  await f.tools.bpa_get_api_trigger.handler({ trigger_uid: 'proj.trig', environment_id: 'env-2' });
  assert.deepEqual(f.requests.map(r => [r.method, r.path, r.options.query, r.options.headers]), [
    ['GET', `${UNIFIED}/triggers/api`, { environmentId: 'env-default', $filter: "name eq 'x'", $expand: 'definition' }, {}],
    ['GET', `${UNIFIED}/triggers/api/proj.trig`, { environmentId: 'env-2' }, {}]
  ]);
});

test('execute API trigger posts inputs/businessKey/executionId and returns status', async () => {
  const f = fixture({ responder: () => ({ status: 202, data: { id: INSTANCE_ID } }) });
  const result = await f.tools.bpa_execute_api_trigger.handler({
    trigger_uid: 'trig-1', inputs: { a: 1 }, business_key: 'BK1', execution_id: INSTANCE_ID, confirmation: 'EXECUTE BPA TRIGGER trig-1'
  });
  assert.deepEqual(parse(result), { status: 202, data: { id: INSTANCE_ID } });
  const [request] = f.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `${UNIFIED}/triggers/api/trig-1`);
  assert.deepEqual(request.options.json, { inputs: { a: 1 }, businessKey: 'BK1', executionId: INSTANCE_ID });
  assert.deepEqual(request.options.headers, { 'api-key': KEY });
  assert.equal(request.options.withStatus, true);
  assert.doesNotMatch(textOf(result), new RegExp(KEY));
});

test('wrong confirmation makes zero requests', async () => {
  const f = fixture();
  const a = await f.tools.bpa_execute_api_trigger.handler({ trigger_uid: 't1', confirmation: 'yes' });
  const b = await f.tools.bpa_start_automation.handler({ trigger_uid: 't1', confirmation: 'yes' });
  assert.match(textOf(a), /confirmation must equal EXECUTE BPA TRIGGER t1/);
  assert.match(textOf(b), /confirmation must equal START BPA AUTOMATION t1/);
  assert.equal(a.isError && b.isError, true);
  assert.equal(f.requests.length, 0);
});

test('irpa tools fail without API key and make zero requests', async () => {
  const f = fixture({ access: { apiKey: null, environmentId: null } });
  const calls = [
    ['bpa_list_automation_triggers', {}],
    ['bpa_get_automation_trigger', { trigger_uid: 't1' }],
    ['bpa_list_automation_jobs', { trigger_uid: 't1' }],
    ['bpa_start_automation', { trigger_uid: 't1', confirmation: 'START BPA AUTOMATION t1' }],
    ['bpa_export_automation_data', { kind: 'bam' }]
  ];
  for (const [name, args] of calls) {
    const result = await f.tools[name].handler(args);
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /environment API key/);
  }
  assert.equal(f.requests.length, 0);
});

test('irpa runtime paths and key only in header', async () => {
  const f = fixture({ responder: () => ({ jobUid: 'j1', echo: KEY }) });
  await f.tools.bpa_list_automation_triggers.handler({});
  await f.tools.bpa_get_automation_trigger.handler({ trigger_uid: 't1' });
  await f.tools.bpa_list_automation_jobs.handler({ trigger_uid: 't1' });
  await f.tools.bpa_list_automation_jobs.handler({ trigger_uid: 't1', job_uid: 'j1' });
  const started = await f.tools.bpa_start_automation.handler({ trigger_uid: 't1', input: { x: 1 }, invocation_context: { tx: 'a' }, confirmation: 'START BPA AUTOMATION t1' });
  assert.deepEqual(f.requests.map(r => [r.method, r.path]), [
    ['GET', `${IRPA}/apiTriggers`],
    ['GET', `${IRPA}/apiTriggers/t1`],
    ['GET', `${IRPA}/apiTriggers/t1/runs`],
    ['GET', `${IRPA}/apiTriggers/t1/runs/j1`],
    ['POST', `${IRPA}/apiTriggers/t1/runs`]
  ]);
  for (const r of f.requests) assert.deepEqual(r.options.headers, { 'irpa-api-key': KEY });
  assert.deepEqual(f.requests[4].options.json, { input: { x: 1 }, invocationContext: { tx: 'a' } });
  assert.deepEqual(f.requests[4].options.expect, [201]);
  assert.equal(JSON.stringify(f.requests[4].options.json).includes(KEY), false);
  assert.equal(started.isError, undefined);
});

test('export returns csv inline or writes a new 0600 file', async () => {
  const f = fixture({ responder: () => 'a;b\n1;2\n' });
  const inline = await f.tools.bpa_export_automation_data.handler({ kind: 'archived_jobs', from: '2026-01-01T00:00:00Z' });
  assert.deepEqual(parse(inline), { csv: 'a;b\n1;2\n' });
  assert.equal(f.requests[0].path, `${MONITORING}/jobs/archived/export`);
  assert.deepEqual(f.requests[0].options.query, { from: '2026-01-01T00:00:00Z' });
  assert.equal(f.requests[0].options.responseType, 'text');
  const file = join(await mkdtemp(join(tmpdir(), 'bpa-export-')), 'bam.csv');
  const written = await f.tools.bpa_export_automation_data.handler({ kind: 'bam', region: 'de', output_file: file });
  assert.deepEqual(parse(written), { output_file: file, bytes: 8 });
  assert.equal(f.requests[1].path, `${MONITORING}/bam/export`);
  assert.equal(await readFile(file, 'utf8'), 'a;b\n1;2\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const again = await f.tools.bpa_export_automation_data.handler({ kind: 'bam', output_file: file });
  assert.match(textOf(again), /already exists/);
});
