import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { redactSecrets, resultOf } from '../src/integration-common.mjs';
import { INBOX_TOOL_NAMES, registerInboxTools } from '../src/process-automation-inbox-tools.mjs';

const INBOX = '/public/workflow/odata/v1/tcm';
const TASK_ID = '7a6b5c4d-3e2f-11ef-9a8b-0242ac120003';
const RULE_ID = '82f3541d-137b-4a16-bd6f-86c82db2a763';

/** Fake MCP server + REST client; `responder(method, path, options)` returns a payload or undefined. */
function fixture(responder = () => undefined) {
  const registered = [];
  const server = { registerTool: (name, definition, handler) => {
    const schema = typeof definition.inputSchema?.parse === 'function' ? definition.inputSchema : z.object(definition.inputSchema);
    registered.push({ name, ...definition, handler: async args => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
      return handler(parsed.data);
    } });
  } };
  const register = (name, title, description, inputSchema, annotations, handler) => {
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(
      async () => redactSecrets(await handler(args)),
      { product: 'SAP Build Process Automation', fallback: 'SAP Build Process Automation request failed.' }
    ));
  };
  const requests = [];
  const rest = {
    request: async (method, path, options = {}) => {
      requests.push({ method, path, options });
      const reply = await responder(method, path, options);
      return reply === undefined ? [] : reply;
    }
  };
  registerInboxTools(register, { rest, access: { apiKey: null, environmentId: null } });
  return { requests, names: registered.map(entry => entry.name), byName: Object.fromEntries(registered.map(entry => [entry.name, entry])) };
}

const parse = result => JSON.parse(result.content[0].text);
const textOf = result => result.content.map(part => part.text).join('\n');

test('registered tool names match INBOX_TOOL_NAMES', () => {
  assert.deepEqual(fixture().names, [...INBOX_TOOL_NAMES]);
});

test('list tasks builds one $filter, sends $format=json and strips OData metadata', async () => {
  const f = fixture(() => [{ __metadata: { uri: 'x' }, InstanceID: TASK_ID, Status: 'READY', TaskDefinitionData: { __deferred: { uri: 'y' } }, Description: { __metadata: {}, Description: 'Hi' } }]);
  const result = await f.byName.bpa_inbox_list_tasks.handler({
    status: ['READY', 'RESERVED'],
    task_definition_id: ["approve@o'rder"],
    priority: ['HIGH'],
    created_from: '2026-11-01',
    due_up_to: '2026-11-30T18:30:00+01:00',
    custom_attributes: [{ name: 'ProjectId', value: 'PRO_247' }],
    expand: ['Description', 'CustomAttributeData'],
    top: 10
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(f.requests.length, 1);
  const [request] = f.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, `${INBOX}/TaskCollection`);
  assert.deepEqual(request.options.query, {
    $filter: "(Status eq 'READY' or Status eq 'RESERVED') and TaskDefinitionID eq 'approve@o''rder' and Priority eq 'HIGH'"
      + " and CreatedOn ge datetime'2026-11-01T00:00:00' and CompletionDeadLine le datetime'2026-11-30T17:30:00'"
      + " and (CustomAttributeData/Name eq 'ProjectId' and CustomAttributeData/Value eq 'PRO_247')",
    $orderby: 'CreatedOn desc',
    $expand: 'Description,CustomAttributeData',
    $top: 10,
    $skip: 0,
    $format: 'json'
  });
  assert.deepEqual(parse(result), { tasks: [{ InstanceID: TASK_ID, Status: 'READY', Description: { Description: 'Hi' } }] });
});

test('list tasks count_only calls $count as text and returns a number', async () => {
  const f = fixture(() => '7\n');
  const result = await f.byName.bpa_inbox_list_tasks.handler({ status: ['READY'], count_only: true });
  assert.deepEqual(parse(result), { count: 7 });
  assert.equal(f.requests[0].path, `${INBOX}/TaskCollection/$count`);
  assert.equal(f.requests[0].options.responseType, 'text');
  assert.deepEqual(f.requests[0].options.query, { $filter: "Status eq 'READY'" });
});

test('list tasks rejects TaskDefinitionName as second sort key without a request', async () => {
  const f = fixture();
  const result = await f.byName.bpa_inbox_list_tasks.handler({ orderby: ['CreatedOn desc', 'TaskDefinitionName asc'] });
  assert.equal(result.isError, true);
  assert.equal(f.requests.length, 0);
});

test('get task reads the keyed entity and each requested navigation', async () => {
  const f = fixture((method, path) => (path.endsWith('/WorkflowLogs') ? [{ Action: 'CREATED' }] : { InstanceID: TASK_ID }));
  const result = await f.byName.bpa_inbox_get_task.handler({ origin: 'NA', instance_id: TASK_ID, include: ['workflow_logs', 'custom_attributes'] });
  const key = `${INBOX}/TaskCollection(SAP__Origin='NA',InstanceID='${TASK_ID}')`;
  assert.deepEqual(f.requests.map(request => request.path), [key, `${key}/WorkflowLogs`, `${key}/CustomAttributeData`]);
  assert.ok(f.requests.every(request => request.options.query.$format === 'json'));
  assert.deepEqual(Object.keys(parse(result)), ['task', 'workflow_logs', 'custom_attributes']);
});

test('task definitions: both-or-neither key, custom attribute definitions, $count', async () => {
  const f = fixture((method, path) => (path.endsWith('$count') ? '3' : [{ Name: 'ProjectId' }]));
  const partial = await f.byName.bpa_inbox_list_task_definitions.handler({ origin: 'NA' });
  assert.equal(partial.isError, true);
  assert.equal(f.requests.length, 0);

  await f.byName.bpa_inbox_list_task_definitions.handler({ origin: 'NA', task_definition_id: 'approve@order' });
  assert.equal(f.requests[0].path, `${INBOX}/TaskDefinitionCollection(SAP__Origin='NA',TaskDefinitionID='approve%40order')/CustomAttributeDefinitionData`);
  assert.deepEqual(parse(await f.byName.bpa_inbox_list_task_definitions.handler({ count_only: true })), { count: 3 });
  assert.equal(f.requests[1].path, `${INBOX}/TaskDefinitionCollection/$count`);
});

test('task actions are confirmation-gated and POST function imports with quoted literals', async () => {
  const f = fixture(() => ({ InstanceID: TASK_ID, Status: 'RESERVED' }));
  const wrong = await f.byName.bpa_inbox_task_action.handler({ origin: 'NA', instance_id: TASK_ID, action: 'claim', confirmation: 'yes' });
  assert.equal(wrong.isError, true);
  assert.match(textOf(wrong), new RegExp(`confirmation must equal CLAIM BPA INBOX TASK ${TASK_ID}`));
  const missingTarget = await f.byName.bpa_inbox_task_action.handler({ origin: 'NA', instance_id: TASK_ID, action: 'forward', confirmation: `FORWARD BPA INBOX TASK ${TASK_ID}` });
  assert.equal(missingTarget.isError, true);
  assert.equal(f.requests.length, 0);

  const result = await f.byName.bpa_inbox_task_action.handler({
    origin: 'NA', instance_id: TASK_ID, action: 'forward', forward_to: "o'brien@example.com", confirmation: `FORWARD BPA INBOX TASK ${TASK_ID}`
  });
  assert.equal(result.isError, undefined, textOf(result));
  const [request] = f.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `${INBOX}/Forward`);
  assert.deepEqual(request.options.query, { SAP__Origin: "'NA'", InstanceID: `'${TASK_ID}'`, ForwardTo: "'o''brien@example.com'", $format: 'json' });
  assert.deepEqual(request.options.expect, [200, 202, 204]);
});

test('substitution rules: scope selects the collection', async () => {
  const f = fixture();
  await f.byName.bpa_inbox_list_substitution_rules.handler({});
  await f.byName.bpa_inbox_list_substitution_rules.handler({ scope: 'substituting_for' });
  assert.deepEqual(f.requests.map(request => request.path), [`${INBOX}/SubstitutionRuleCollection`, `${INBOX}/SubstitutesRuleCollection`]);
});

test('create substitution rule sends /Date()/ UTC dates and mode-consistent IsEnabled', async () => {
  const f = fixture(() => ({ SubstitutionRuleID: RULE_ID }));
  const args = { user: 'deputy@example.com', begin_date: '2026-11-10T08:00:00', end_date: '2026-11-20', mode: 'RECEIVE_TASKS' };
  const wrong = await f.byName.bpa_inbox_create_substitution_rule.handler({ ...args, confirmation: 'yes' });
  assert.match(textOf(wrong), /confirmation must equal CREATE BPA SUBSTITUTION FOR deputy@example.com/);
  const inconsistent = await f.byName.bpa_inbox_create_substitution_rule.handler({ ...args, enabled: false, confirmation: 'CREATE BPA SUBSTITUTION FOR deputy@example.com' });
  assert.equal(inconsistent.isError, true);
  assert.equal(f.requests.length, 0);

  const result = await f.byName.bpa_inbox_create_substitution_rule.handler({ ...args, confirmation: 'CREATE BPA SUBSTITUTION FOR deputy@example.com' });
  assert.deepEqual(parse(result), { rule: { SubstitutionRuleID: RULE_ID } });
  assert.equal(f.requests[0].path, `${INBOX}/SubstitutionRuleCollection`);
  assert.deepEqual(f.requests[0].options.json, {
    SAP__Origin: 'NA',
    User: 'deputy@example.com',
    BeginDate: `/Date(${Date.parse('2026-11-10T08:00:00Z')})/`,
    EndDate: `/Date(${Date.parse('2026-11-20T00:00:00Z')})/`,
    Mode: 'RECEIVE_TASKS',
    IsEnabled: true
  });

  await f.byName.bpa_inbox_create_substitution_rule.handler({ user: 'deputy', begin_date: '2026-11-10', mode: 'TAKE_OVER', confirmation: 'CREATE BPA SUBSTITUTION FOR deputy' });
  assert.equal(f.requests[1].options.json.IsEnabled, false);
  assert.equal('EndDate' in f.requests[1].options.json, false);
});

test('change substitution rule maps enable/disable/delete to function imports', async () => {
  const f = fixture(() => null);
  const wrong = await f.byName.bpa_inbox_change_substitution_rule.handler({ rule_id: RULE_ID, action: 'delete', confirmation: 'yes' });
  assert.match(textOf(wrong), new RegExp(`confirmation must equal DELETE BPA SUBSTITUTION ${RULE_ID}`));
  assert.equal(f.requests.length, 0);
  for (const action of ['enable', 'disable', 'delete']) {
    const result = await f.byName.bpa_inbox_change_substitution_rule.handler({ rule_id: RULE_ID, action, confirmation: `${action.toUpperCase()} BPA SUBSTITUTION ${RULE_ID}` });
    assert.equal(result.isError, undefined, textOf(result));
  }
  assert.deepEqual(f.requests.map(({ method, path, options }) => [method, path, options.query]), [
    ['POST', `${INBOX}/EnableSubstitutionRule`, { SubstitutionRuleID: `'${RULE_ID}'`, Enabled: 'true', $format: 'json' }],
    ['POST', `${INBOX}/EnableSubstitutionRule`, { SubstitutionRuleID: `'${RULE_ID}'`, Enabled: 'false', $format: 'json' }],
    ['POST', `${INBOX}/DeleteSubstitutionRule`, { SubstitutionRuleID: `'${RULE_ID}'`, $format: 'json' }]
  ]);
});
