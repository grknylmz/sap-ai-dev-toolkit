import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { redactSecrets, resultOf } from '../src/integration-common.mjs';
import { VISIBILITY_TOOL_NAMES, registerVisibilityTools } from '../src/process-automation-visibility-tools.mjs';

const REST = '/public/visibility/runtime/rest/v1';
const ODATA = '/public/visibility/runtime/odata/v1';

function fixture(responder = () => undefined) {
  const tools = {};
  const names = [];
  const register = (name, title, description, inputSchema, annotations, handler) => {
    names.push(name);
    const schema = typeof inputSchema?.parse === 'function' ? inputSchema : z.object(inputSchema);
    tools[name] = { annotations, handler: async args => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
      return resultOf(async () => redactSecrets(await handler(parsed.data)),
        { product: 'SAP Build Process Automation', fallback: 'request failed' });
    } };
  };
  const requests = [];
  const rest = { request: async (method, path, options = {}) => {
    requests.push({ method, path, options });
    const reply = await responder(method, path, options);
    return reply === undefined ? {} : reply;
  } };
  registerVisibilityTools(register, { rest, access: { apiKey: null, environmentId: null } });
  return { names, tools, requests };
}

const parse = result => JSON.parse(result.content[0].text);
const textOf = result => result.content.map(part => part.text).join('\n');

test('registers all visibility tools in order', () => {
  assert.deepEqual(fixture().names, [...VISIBILITY_TOOL_NAMES]);
});

test('wrong confirmations fail with zero requests', async () => {
  const f = fixture();
  const event = { processDefinitionId: 'p', processInstanceId: 'i', eventType: 'START', timestamp: '2026-11-05T10:00:00Z' };
  for (const [name, args, expected] of [
    ['bpa_process_visibility_scenario', { scenario_id: 'sc.1', confirmation: 'x' }, 'PROCESS BPA VISIBILITY sc.1'],
    ['bpa_clear_visibility_data', { scenario_id: 'sc.1', instance_ids: ['a'], confirmation: 'x' }, 'CLEAR BPA VISIBILITY DATA sc.1'],
    ['bpa_push_visibility_events', { events: [event, event], confirmation: 'x' }, 'PUSH BPA VISIBILITY EVENTS 2']
  ]) {
    const result = await f.tools[name].handler(args);
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), new RegExp(`confirmation must equal ${expected}`));
  }
  assert.equal(f.requests.length, 0);
});

test('scenario reads, process and clear hit spec paths', async () => {
  const f = fixture((method, path) => (method === 'POST' ? { status: 202 } : undefined));
  await f.tools.bpa_get_visibility_scenario.handler({ scenario_id: 'sc.1', include: ['model', 'executions'], execution_status: 'FAILED' });
  await f.tools.bpa_process_visibility_scenario.handler({ scenario_id: 'sc.1', confirmation: 'PROCESS BPA VISIBILITY sc.1' });
  await f.tools.bpa_clear_visibility_data.handler({ scenario_id: 'sc.1', instance_ids: ['a', 'b'], confirmation: 'CLEAR BPA VISIBILITY DATA sc.1' });
  assert.deepEqual(f.requests.map(r => `${r.method} ${r.path}`), [
    `GET ${REST}/scenario-definitions/sc.1`,
    `GET ${REST}/scenario-definitions/sc.1/model`,
    `GET ${REST}/scenario-definitions/sc.1/data-executions`,
    `POST ${REST}/scenario-definitions/sc.1/data-executions`,
    `PATCH ${REST}/scenario-definitions/sc.1/data`
  ]);
  assert.deepEqual(f.requests[2].options.query, { status: 'FAILED' });
  assert.deepEqual(f.requests[3].options.expect, [202]);
  assert.deepEqual(f.requests[4].options.json, [{ id: 'a', deleted: true }, { id: 'b', deleted: true }]);
});

test('list events maps spec query names and rejects foreign params', async () => {
  const f = fixture();
  await f.tools.bpa_list_visibility_events.handler({ process_definition_id: 'p', acquired_from: '2026-11-01', acquired_up_to: '2026-11-05T00:00:00Z' });
  await f.tools.bpa_list_visibility_events.handler({ kind: 'errors', log_id: 'L1', start_date_time: '2026-11-01' });
  assert.equal(f.requests[0].path, `${REST}/data-acquisition/data`);
  assert.equal(f.requests[0].options.query.acquiredUpto, '2026-11-05T00:00:00Z');
  assert.equal(f.requests[0].options.query.processDefinitionId, 'p');
  assert.equal(f.requests[1].path, `${REST}/data-acquisition/error-messages`);
  assert.equal(f.requests[1].options.query.logId, 'L1');
  assert.equal(f.requests[1].options.query.startDateTime, '2026-11-01');
  const bad = await f.tools.bpa_list_visibility_events.handler({ kind: 'errors', event_type: 'START' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /event_type not allowed with kind errors/);
  assert.equal(f.requests.length, 2);
});

test('push events posts the array with 204', async () => {
  const f = fixture();
  const event = { processDefinitionId: 'p', processInstanceId: 'i', eventType: 'START', timestamp: '2026-11-05T10:00:00Z', context: { a: 1 } };
  const result = await f.tools.bpa_push_visibility_events.handler({ events: [event], confirmation: 'PUSH BPA VISIBILITY EVENTS 1' });
  assert.deepEqual(parse(result), { pushed: 1 });
  assert.deepEqual(f.requests[0].options.json, [event]);
  assert.deepEqual(f.requests[0].options.expect, [204]);
});

test('workspace instance list and detail use OData options and quoted keys', async () => {
  const f = fixture();
  await f.tools.bpa_list_visibility_instances.handler({ scenario_id: 'sc.1', filter: "status eq 'RUNNING'", search: "o'k", inline_count: true });
  assert.equal(f.requests[0].path, `${ODATA}/sc.1/Instances`);
  assert.deepEqual(Object.fromEntries(Object.entries(f.requests[0].options.query).filter(([, v]) => v !== undefined)), {
    $filter: "status eq 'RUNNING'", search: "'o''k'", $top: 50, $skip: 0, $inlinecount: 'allpages', $format: 'json'
  });
  await f.tools.bpa_get_visibility_instance.handler({ scenario_id: 'sc.1', instance_id: "a/b'c", include: ['phases', 'steps'] });
  const key = `Instances(${encodeURIComponent("'a/b''c'")})`;
  assert.deepEqual(f.requests.slice(1).map(r => r.path), [`${ODATA}/sc.1/${key}`, `${ODATA}/sc.1/${key}/Phases`, `${ODATA}/sc.1/${key}/Steps`]);
  await f.tools.bpa_list_visibility_workspace_scenarios.handler({});
  assert.equal(f.requests.at(-1).path, `${ODATA}/metadata/Scenarios`);
});
