import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { IntegrationError } from '../src/integration-http.mjs';
import { PROCESS_AUTOMATION_TOOL_NAMES, registerProcessAutomationTools } from '../src/process-automation-tools.mjs';

const WORKFLOW = '/public/workflow/rest/v1';
const RULES = '/public/rule/runtime/rest/v2/rule-services';
const INSTANCE_ID = '0f1e2d3c-4b5a-11ef-8a9b-0242ac120002';
const TASK_ID = '7a6b5c4d-3e2f-11ef-9a8b-0242ac120003';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');

/** Fake MCP server + REST client; `responder(method, path, options)` returns a payload or undefined. */
function fixture(responder = () => undefined) {
  const registered = [];
  const server = { registerTool: (name, definition, handler) => {
    const schema = typeof definition.inputSchema?.parse === 'function' ? definition.inputSchema : z.object(definition.inputSchema);
    registered.push({ name, ...definition, handler: async args => handler(schema.parse(args ?? {})) });
  } };
  const requests = [];
  const rest = {
    request: async (method, path, options = {}) => {
      requests.push({ method, path, options });
      const reply = await responder(method, path, options);
      return reply === undefined ? [] : reply;
    }
  };
  const summary = { api_host: 'api.example', uaa_host: 'auth.example', auth: 'technical', source: 'environment', task_attribution: 'technical client' };
  const names = registerProcessAutomationTools(server, { rest, summary, verify: async () => ({ workflow_api: 'ok' }), now: () => NOW });
  return { names, requests, byName: Object.fromEntries(registered.map(entry => [entry.name, entry])) };
}

const parse = result => JSON.parse(result.content[0].text);
const textOf = result => result.content.map(part => part.text).join('\n');

test('registered tool names match PROCESS_AUTOMATION_TOOL_NAMES', () => {
  const f = fixture();
  assert.deepEqual(f.names, [...PROCESS_AUTOMATION_TOOL_NAMES]);
  assert.deepEqual(Object.keys(f.byName), [...PROCESS_AUTOMATION_TOOL_NAMES]);
});

test('wrong confirmation on writes returns isError and makes zero requests', async () => {
  const f = fixture();
  const calls = [
    ['bpa_start_instance', { definition_id: 'orderapproval', context: {}, confirmation: 'yes' }, `START BPA PROCESS orderapproval`],
    ['bpa_complete_task', { task_id: TASK_ID, confirmation: 'yes' }, `COMPLETE BPA TASK ${TASK_ID}`],
    ['bpa_change_instance_status', { instance_id: INSTANCE_ID, action: 'retry', confirmation: 'yes' }, `RETRY BPA INSTANCE ${INSTANCE_ID}`]
  ];
  for (const [name, args, expected] of calls) {
    const result = await f.byName[name].handler(args);
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), new RegExp(`confirmation must equal ${expected}`));
  }
  assert.equal(f.requests.length, 0);
});

test('retry on a RUNNING instance is refused without PATCH', async () => {
  const f = fixture((method, path) => (method === 'GET' && path === `${WORKFLOW}/workflow-instances/${INSTANCE_ID}` ? { id: INSTANCE_ID, status: 'RUNNING' } : undefined));
  const result = await f.byName.bpa_change_instance_status.handler({ instance_id: INSTANCE_ID, action: 'retry', confirmation: `RETRY BPA INSTANCE ${INSTANCE_ID}` });
  assert.equal(result.isError, true);
  assert.match(textOf(result), new RegExp(`instance ${INSTANCE_ID} is RUNNING; retry requires ERRONEOUS`));
  assert.equal(f.requests.some(request => request.method === 'PATCH'), false);
});

test('cancel on an ERRONEOUS instance PATCHes status CANCELED and reports before/after', async () => {
  let patched = false;
  const f = fixture((method, path) => {
    if (path !== `${WORKFLOW}/workflow-instances/${INSTANCE_ID}`) return undefined;
    if (method === 'PATCH') { patched = true; return null; }
    return { id: INSTANCE_ID, status: patched ? 'CANCELED' : 'ERRONEOUS', definitionId: 'orderapproval', internal: 'dropped' };
  });
  const result = await f.byName.bpa_change_instance_status.handler({ instance_id: INSTANCE_ID, action: 'cancel', confirmation: `CANCEL BPA INSTANCE ${INSTANCE_ID}` });
  assert.equal(result.isError, undefined);
  const patches = f.requests.filter(request => request.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, `${WORKFLOW}/workflow-instances/${INSTANCE_ID}`);
  assert.deepEqual(patches[0].options.json, { status: 'CANCELED' });
  const payload = parse(result);
  assert.equal(payload.before, 'ERRONEOUS');
  assert.equal(payload.after, 'CANCELED');
  assert.deepEqual(payload.instance, { id: INSTANCE_ID, status: 'CANCELED', definitionId: 'orderapproval' });
});

test('completing a COMPLETED task is refused without PATCH', async () => {
  const f = fixture((method, path) => (method === 'GET' && path === `${WORKFLOW}/task-instances/${TASK_ID}` ? { id: TASK_ID, status: 'COMPLETED' } : undefined));
  const result = await f.byName.bpa_complete_task.handler({ task_id: TASK_ID, decision: 'approve', confirmation: `COMPLETE BPA TASK ${TASK_ID}` });
  assert.equal(result.isError, true);
  assert.match(textOf(result), new RegExp(`task ${TASK_ID} is COMPLETED; only open tasks can be completed`));
  assert.equal(f.requests.some(request => request.method === 'PATCH'), false);
});

test('bpa_list_instances sends statuses as repeated parameters (OR semantics), newest first', async () => {
  const f = fixture((method, path) => (path === `${WORKFLOW}/workflow-instances` ? [{ id: INSTANCE_ID, status: 'RUNNING', extra: 'x' }] : undefined));
  const result = await f.byName.bpa_list_instances.handler({ status: ['RUNNING', 'ERRONEOUS'] });
  assert.equal(f.requests.length, 1);
  const { method, path, options } = f.requests[0];
  assert.equal(method, 'GET');
  assert.equal(path, `${WORKFLOW}/workflow-instances`);
  assert.deepEqual(options.query.status, ['RUNNING', 'ERRONEOUS']);
  assert.equal(options.query.$orderby, 'startedAt desc');
  assert.equal(options.query.$top, 50);
  assert.equal(options.query.$skip, 0);
  assert.deepEqual(parse(result), [{ id: INSTANCE_ID, status: 'RUNNING' }]);
});

test('async workflow operations return the job id from the Location header and dedupe instance ids', async () => {
  const f = fixture((method, path, options) => (method === 'PATCH' && path === `${WORKFLOW}/workflow-instances`
    ? { status: 202, data: null, responseHeaders: { location: '/public/workflow/rest/v1/jobs/job-42' } }
    : undefined));
  const result = await f.byName.bpa_delete_instances.handler({ instance_ids: [INSTANCE_ID, INSTANCE_ID, TASK_ID], confirmation: 'DELETE BPA INSTANCES 2' });
  assert.deepEqual(parse(result), { requested: 2, status: 202, job_id: 'job-42' });
  assert.deepEqual(f.requests[0].options.json, [{ id: INSTANCE_ID, deleted: true }, { id: TASK_ID, deleted: true }]);
  assert.deepEqual(f.requests[0].options.responseHeaders, ['location']);
});

test('instance roles map to the API names and only given roles are sent', async () => {
  const f = fixture((method, path) => (method === 'GET' ? { viewerUsers: ['a@x'] } : undefined));
  await f.byName.bpa_update_instance_roles.handler({ instance_id: INSTANCE_ID, viewer_users: ['a@x'], context_admin_groups: [], confirmation: `UPDATE BPA ROLES ${INSTANCE_ID}` });
  assert.deepEqual(f.requests[0].options.json, { viewerUsers: ['a@x'], contextAdminGroups: [] });
  const none = await f.byName.bpa_update_instance_roles.handler({ instance_id: INSTANCE_ID, confirmation: `UPDATE BPA ROLES ${INSTANCE_ID}` });
  assert.equal(none.isError, true);
  assert.equal(f.requests.length, 2);
});

test('bulk task updates use the API property names and refuse id-only entries before any call', async () => {
  const f = fixture(() => ({ status: 202, data: null, responseHeaders: {} }));
  await f.byName.bpa_update_tasks.handler({
    updates: [{ id: TASK_ID, processor: '', due_date: '2026-12-01T00:00:00Z', recipient_groups: 'APPROVERS', priority: 'HIGH' }],
    confirmation: 'UPDATE BPA TASKS 1'
  });
  assert.deepEqual(f.requests[0].options.json, [{ id: TASK_ID, processor: '', priority: 'HIGH', recipientGroups: 'APPROVERS', dueDate: '2026-12-01T00:00:00Z' }]);
  const idOnly = await f.byName.bpa_update_tasks.handler({ updates: [{ id: TASK_ID }], confirmation: 'UPDATE BPA TASKS 1' });
  assert.equal(idOnly.isError, true);
  assert.equal(f.requests.length, 1);
});

test('a context path reads one fragment instead of the whole context', async () => {
  const f = fixture((method, path) => (path.endsWith('/context/order/items') ? { qty: 1 } : { id: INSTANCE_ID }));
  const result = parse(await f.byName.bpa_get_instance.handler({ instance_id: INSTANCE_ID, include: ['context'], context_path: 'order/items' }));
  assert.deepEqual(f.requests.map(request => request.path), [`${WORKFLOW}/workflow-instances/${INSTANCE_ID}`, `${WORKFLOW}/workflow-instances/${INSTANCE_ID}/context/order/items`]);
  assert.deepEqual(result.context, { qty: 1 });
});

test('bpa_find_stuck_instances keeps only RUNNING rows older than the cutoff', async () => {
  const old = { id: '11111111-1111-11ef-8111-111111111111', status: 'RUNNING', startedAt: '2026-11-05T09:00:00.000Z' };
  const recent = { id: '22222222-2222-11ef-8222-222222222222', status: 'RUNNING', startedAt: '2026-11-05T11:30:00.000Z' };
  const erroneous = { id: '33333333-3333-11ef-8333-333333333333', status: 'ERRONEOUS', startedAt: '2026-11-04T00:00:00.000Z' };
  const suspended = { id: '44444444-4444-11ef-8444-444444444444', status: 'SUSPENDED', startedAt: '2026-11-04T00:00:00.000Z' };
  const f = fixture((method, path, options) => {
    if (path === `${WORKFLOW}/workflow-instances`) {
      return { RUNNING: [old, recent], ERRONEOUS: [erroneous], SUSPENDED: [suspended] }[options.query.status];
    }
    if (path === `${WORKFLOW}/workflow-instances/${erroneous.id}/error-messages`) return [{ message: 'Service task failed' }];
    return undefined;
  });
  const payload = parse(await f.byName.bpa_find_stuck_instances.handler({ running_longer_than_minutes: 60 }));
  assert.deepEqual(payload.long_running.map(row => row.id), [old.id]);
  assert.deepEqual(payload.suspended.map(row => row.id), [suspended.id]);
  assert.deepEqual(payload.erroneous[0].error_messages, [{ message: 'Service task failed' }]);
  assert.equal(payload.cutoff, '2026-11-05T11:00:00.000Z');
  const listQueries = f.requests.filter(request => request.path === `${WORKFLOW}/workflow-instances`).map(request => request.options.query);
  assert.deepEqual(listQueries.map(query => query.status), ['ERRONEOUS', 'SUSPENDED', 'RUNNING']);
  assert.ok(listQueries.every(query => query.$orderby === 'startedAt asc' && query.$top === 25));
});

test('bpa_test_decision reports subset mismatches and continues after a per-case HTTP error', async () => {
  const f = fixture((method, path, options) => {
    if (method !== 'POST' || path !== RULES) return undefined;
    const amount = options.json.Vocabulary[0].Order.Amount;
    if (amount === 0) throw new IntegrationError('PROCESS_AUTOMATION request failed: HTTP 400');
    return { Result: [{ Discount: { Percent: amount > 100 ? 10 : 5, Reason: 'tier' } }] };
  });
  const payload = parse(await f.byName.bpa_test_decision.handler({
    rule_service_id: 'discount_rules',
    cases: [
      { name: 'big order', vocabulary: [{ Order: { Amount: 500 } }], expected: { Discount: { Percent: 10 } } },
      { name: 'small order', vocabulary: [{ Order: { Amount: 50 } }], expected: { Discount: { Percent: 10 } } },
      { name: 'broken', vocabulary: [{ Order: { Amount: 0 } }], expected: { Discount: { Percent: 0 } } },
      { name: 'array form', vocabulary: [{ Order: { Amount: 500 } }], expected: [{ Discount: { Percent: 10 } }] }
    ]
  }));
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[0].options.json, { RuleServiceId: 'discount_rules', Vocabulary: [{ Order: { Amount: 500 } }] });
  assert.equal(payload.passed, 2);
  assert.equal(payload.failed, 2);
  assert.deepEqual(payload.cases.map(entry => entry.pass), [true, false, false, true]);
  assert.deepEqual(payload.cases[1].mismatches, [{ path: '$[0].Discount.Percent', expected: 10, actual: 5 }]);
  assert.match(payload.cases[2].error, /HTTP 400/);
  assert.equal(payload.cases[2].mismatches, undefined);
});

test('bpa_get_instance truncates a context larger than 48 KiB', async () => {
  const bigContext = { order: { notes: 'x'.repeat(49 * 1024) }, customer: 'ACME' };
  const f = fixture((method, path) => {
    if (path === `${WORKFLOW}/workflow-instances/${INSTANCE_ID}`) return { id: INSTANCE_ID, status: 'RUNNING' };
    if (path === `${WORKFLOW}/workflow-instances/${INSTANCE_ID}/context`) return bigContext;
    return undefined;
  });
  const payload = parse(await f.byName.bpa_get_instance.handler({ instance_id: INSTANCE_ID, include: ['context'] }));
  assert.equal(payload.context_truncated, true);
  assert.equal(payload.context, undefined);
  assert.deepEqual(payload.context_keys, ['order', 'customer']);
  assert.ok(payload.context_bytes > 48 * 1024);
  assert.deepEqual(payload.instance, { id: INSTANCE_ID, status: 'RUNNING' });
});
