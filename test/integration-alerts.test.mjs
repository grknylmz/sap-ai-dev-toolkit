import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { canonicalDigest } from '../src/integration-state.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const ROOT = '/cf/configuration/v1';
const SECRET = 'never-return-private@example.test';
const event = { name: 'event', propertyKey: 'eventType', predicate: 'EQUALS', propertyValue: 'TmsImportFinished' };
const node = { name: 'node', propertyKey: 'tags.nodeName', predicate: 'EQUALS', propertyValue: 'QA' };
const action = { name: 'mail', type: 'EMAIL', state: 'ENABLED', enableDeliveryStatus: true, properties: { destination: SECRET, password: SECRET }, description: SECRET };
const subscription = { name: 'transport', state: 'ENABLED', conditions: ['event', 'node'], actions: ['mail'] };
const writes = tenant => tenant.apiRequests().filter(request => request.method !== 'GET');

async function fixture(t, overrides = {}, intercept) {
  const state = Object.fromEntries(Object.entries({ condition: [event, node], action: [action], subscription: [subscription], ...overrides })
    .map(([kind, rows]) => [kind, new Map(rows.map(row => [row.name, structuredClone(row)]))]));
  const tenant = await startFakeTenant(t, request => {
    const intercepted = intercept?.(request, state);
    if (intercepted) return intercepted;
    const match = new RegExp(`^${ROOT}/(subscription|condition|action)(?:/(.+))?$`).exec(request.path);
    if (!match) return { status: 404 };
    const [, kind, encoded] = match;
    const selected = encoded ? decodeURIComponent(encoded) : undefined;
    if (request.method === 'GET') {
      if (selected) return state[kind].has(selected) ? { status: 200, json: state[kind].get(selected) } : { status: 404 };
      const rows = [...state[kind].values()];
      const page = Number(request.query.get('page'));
      const pageSize = Number(request.query.get('pageSize'));
      return { status: 200, json: { results: rows.slice(page * pageSize, (page + 1) * pageSize), metadata: { page, pageSize, totalPages: Math.ceil(rows.length / pageSize), totalResultsCount: rows.length } } };
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = JSON.parse(request.body);
      assert.equal(selected ?? body.name, body.name);
      state[kind].set(body.name, body);
      return { status: request.method === 'POST' ? 201 : 204 };
    }
    return { status: 405 };
  });
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/ans-tests', ANS_CONFIG: JSON.stringify({ url: tenant.url, username: 'ans-reader', password: SECRET }) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ans-fixture', version: '1.0.0' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return { client, tenant, state };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content[0].text);
  const output = JSON.parse(result.content[0].text);
  assert.doesNotMatch(JSON.stringify(output), /never-return-private/);
  assert.ok(Buffer.byteLength(JSON.stringify(output, null, 2)) < 96 * 1024);
  return output;
}
async function fails(client, name, args, pattern) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, pattern);
  assert.doesNotMatch(result.content[0].text, /never-return-private/);
}

for (const [tool, kind, base] of [['ans_list_subscriptions', 'subscription', subscription], ['ans_list_conditions', 'condition', event], ['ans_list_action_metadata', 'action', action]]) {
  test(`${tool} traverses 405 rows safely with native paging and signed cursors`, async t => {
    const rows = Array.from({ length: 405 }, (_, index) => ({ ...base, name: `row-${String(index).padStart(4, '0')}` }));
    const { client, tenant } = await fixture(t, { [kind]: rows });
    let cursor;
    const collected = [];
    for (let index = 0; ; index += 1) {
      assert.ok(index < 10);
      const page = await call(client, tool, { top: index ? 73 : 200, ...(cursor ? { cursor } : {}) });
      assert.equal(page.total, 405);
      assert.equal(page.returned, page.items.length);
      collected.push(...page.items.map(row => row.name));
      assert.equal(page.complete, page.stop_reason === 'end');
      if (!page.next_cursor) { assert.equal(page.complete, true); break; }
      cursor = page.next_cursor;
      if (index === 0) {
        const count = tenant.requests.length;
        await fails(client, tool, { cursor: `${cursor.slice(0, -3)}bad` }, /cursor/);
        const otherTool = kind === 'action' ? 'ans_list_conditions' : 'ans_list_action_metadata';
        await fails(client, otherTool, { cursor }, /cursor/);
        assert.equal(tenant.requests.length, count);
      }
    }
    assert.deepEqual(collected, rows.map(row => row.name));
    assert.equal(tenant.tokenRequests().length, 0);
    for (const request of tenant.requests) {
      assert.match(request.headers.authorization, /^Basic /);
      assert.equal(request.query.get('pageSize'), '200');
      assert.equal(request.query.has('$skip'), false);
      assert.equal(request.query.has('$top'), false);
    }
  });
}

test('ANS rejects inconsistent pagination instead of manufacturing completeness', async t => {
  const { client } = await fixture(t, {}, request => request.path === `${ROOT}/condition` ? { status: 200, json: { results: [event], metadata: { page: 0, pageSize: 200, totalPages: 1, totalResultsCount: 201 } } } : null);
  await fails(client, 'ans_list_conditions', {}, /paging metadata/);
});

test('native rules resolve fallbacks and report disabled, missing, snoozed and unknown states without properties', async t => {
  const subscriptions = [subscription,
    { ...subscription, name: 'disabled', state: 'DISABLED' },
    { ...subscription, name: 'snoozed', snoozeTimestamp: Date.now() + 60000 },
    { ...subscription, name: 'missing', conditions: ['missing-condition'], actions: ['missing-action'] },
    { ...subscription, name: 'unknown', state: 'NEW_STATE' }];
  const { client, tenant } = await fixture(t, { subscription: subscriptions, action: [{ ...action, fallbackAction: 'fallback' }, { name: 'fallback', type: 'WEBHOOK', state: 'DISABLED', properties: { secret: SECRET } }] });
  const report = await call(client, 'ans_validate_native_rules', { node_names: ['QA'] });
  assert.equal(report.complete, true);
  assert.equal(report.outcome, 'blocked');
  assert.equal(report.delivery, 'needs_admin_confirmation');
  const byName = Object.fromEntries(report.items.map(row => [row.name, row]));
  assert.ok(byName.disabled.findings.some(row => row.code === 'subscription_disabled'));
  assert.ok(byName.snoozed.findings.some(row => row.code === 'subscription_snoozed'));
  assert.ok(byName.missing.findings.some(row => row.code === 'condition_missing'));
  assert.ok(byName.missing.findings.some(row => row.code === 'action_missing'));
  assert.ok(byName.unknown.findings.some(row => row.code === 'subscription_state_unknown'));
  assert.ok(byName.transport.findings.some(row => row.code === 'action_disabled'));
  assert.ok(tenant.requests.some(request => request.path.endsWith('/action/fallback')));
  assert.equal(JSON.stringify(report).includes('properties'), false);
  assert.equal(JSON.stringify(report).includes('propertyValue'), false);
});

test('same-property OR cannot certify broad cTMS scope; mandatory exact conditions can narrow it', async t => {
  const broad = { name: 'broad', propertyKey: 'eventType', predicate: 'CONTAINS', propertyValue: 'Tms' };
  const { client, state } = await fixture(t, { condition: [event, node, broad], subscription: [{ ...subscription, conditions: ['event', 'broad', 'node'] }] });
  let report = await call(client, 'ans_validate_native_rules', { subscription_names: ['transport'], node_names: ['QA'] });
  assert.equal(report.outcome, 'needs_review');
  assert.equal(report.items[0].scope.verified, false);
  assert.ok(report.items[0].findings.some(row => row.code === 'event_scope_unsafe'));
  state.condition.set('event', { ...event, mandatory: true });
  report = await call(client, 'ans_validate_native_rules', { subscription_names: ['transport'], node_names: ['QA'] });
  assert.equal(report.outcome, 'needs_review', 'a non-mandatory node cannot establish mandatory node scope');
  state.condition.set('node', { ...node, mandatory: true });
  report = await call(client, 'ans_validate_native_rules', { subscription_names: ['transport'], node_names: ['QA'] });
  assert.equal(report.outcome, 'rules_validated');
  assert.equal(report.items[0].scope.verified, true);
  assert.equal(report.delivery, 'needs_admin_confirmation');
  state.condition.set('node', { ...node, mandatory: false });
  report = await call(client, 'ans_validate_native_rules', { subscription_names: ['transport'] });
  assert.equal(report.outcome, 'needs_review');
  assert.ok(report.items[0].findings.some(row => row.code === 'explicit_optional_semantics_unverified'));
});

test('exact node selection never accepts unknown events, another node, node ANY or credential-shaped scope', async t => {
  const { client, state } = await fixture(t);
  let report = await call(client, 'ans_validate_native_rules', { node_names: ['PROD'] });
  assert.equal(report.items[0].scope.verified, false);
  for (const replacement of [{ ...node, predicate: 'ANY' }, { ...node, propertyValue: SECRET }]) {
    state.condition.set('node', replacement);
    report = await call(client, 'ans_validate_native_rules', { node_names: ['QA'] });
    assert.equal(report.outcome, 'needs_review');
    assert.deepEqual(report.items[0].scope.node_names, []);
  }
  state.condition.set('node', node);
  state.condition.set('event', { ...event, propertyValue: 'TmsFutureUnknownEvent' });
  report = await call(client, 'ans_validate_native_rules');
  assert.equal(report.outcome, 'needs_review');
  assert.deepEqual(report.items[0].scope.event_types, []);
});

test('forbidden references and fallback cycles stay partial or require review', async t => {
  const { client, state } = await fixture(t, { action: [{ ...action, fallbackAction: 'mail' }] }, request => request.path.endsWith('/condition/node') ? { status: 403, body: SECRET } : null);
  const report = await call(client, 'ans_validate_native_rules', { subscription_names: ['transport', 'absent'] });
  assert.equal(report.complete, false);
  assert.equal(report.outcome, 'blocked');
  assert.ok(report.findings.some(row => row.code === 'subscription_missing'));
  assert.ok(report.items[0].findings.some(row => row.source_result?.result === 'forbidden'));
  assert.ok(report.items[0].findings.some(row => row.code === 'action_fallback_cycle'));
  assert.equal(state.action.size, 1);
});

test('wrong confirmations and invalid predicate never make authentication or API requests', async t => {
  const { client, tenant } = await fixture(t);
  await fails(client, 'ans_set_condition', { condition: event, confirmation: 'WRONG' }, /confirmation/);
  await fails(client, 'ans_set_subscription', { ...subscription, confirmation: 'WRONG' }, /confirmation/);
  await fails(client, 'ans_set_condition', { condition: { ...event, predicate: 'GREATHER_THAN' }, confirmation: 'SET ALERT CONDITION event' }, /Invalid|enum|predicate/);
  assert.equal(tenant.requests.length, 0);
});

test('condition updates require fresh digest, preserve metadata and return only safe canonical readback', async t => {
  const original = { ...event, id: 'condition-id', description: SECRET, labels: ['native-owned'], mandatory: true };
  const { client, tenant, state } = await fixture(t, { condition: [original, node] });
  const args = { condition: { ...event, predicate: 'GREATER_THAN', propertyValue: '5' }, confirmation: 'SET ALERT CONDITION event' };
  await fails(client, 'ans_set_condition', args, /expected_digest/);
  await fails(client, 'ans_set_condition', { ...args, expected_digest: '0'.repeat(64) }, /expected_digest/);
  assert.equal(writes(tenant).length, 0);
  const page = await call(client, 'ans_list_conditions');
  const expected_digest = page.items.find(row => row.name === 'event').configuration_digest;
  assert.equal(expected_digest, canonicalDigest(original));
  const result = await call(client, 'ans_set_condition', { ...args, expected_digest });
  assert.equal(result.verified, true);
  assert.equal(result.operation, 'update');
  assert.equal(result.configuration.configuration_digest, canonicalDigest(state.condition.get('event')));
  assert.equal(state.condition.get('event').id, original.id);
  assert.equal(state.condition.get('event').description, SECRET);
  assert.deepEqual(state.condition.get('event').labels, original.labels);
  assert.equal(state.condition.get('event').mandatory, true);
  assert.equal(writes(tenant)[0].method, 'PUT');
  assert.equal(writes(tenant)[0].path, `${ROOT}/condition/event`);
  assert.notEqual(result.configuration.configuration_digest, expected_digest);
});

test('condition creation requires absent digest and uses encoded named routes without exposing private values', async t => {
  const { client, tenant, state } = await fixture(t);
  const condition = { name: 'private/condition', propertyKey: 'tags.userEmail', predicate: 'EQUALS', propertyValue: SECRET };
  await fails(client, 'ans_set_condition', { condition, expected_digest: '0'.repeat(64), confirmation: `SET ALERT CONDITION ${condition.name}` }, /create requires/);
  assert.equal(writes(tenant).length, 0);
  const result = await call(client, 'ans_set_condition', { condition, confirmation: `SET ALERT CONDITION ${condition.name}` });
  assert.equal(result.verified, true);
  assert.equal(result.configuration.property_value, 'withheld');
  assert.equal(state.condition.get(condition.name).propertyValue, SECRET);
  assert.equal(writes(tenant)[0].method, 'POST');
  assert.equal(writes(tenant)[0].path, `${ROOT}/condition`);
  assert.ok(tenant.requests.some(row => row.path === `${ROOT}/condition/private%2Fcondition`));
});

test('subscription updates preserve native metadata and require complete safe references before a write', async t => {
  const original = { ...subscription, id: 'sub-id', labels: ['preserve'], description: SECRET, snoozeTimestamp: 0 };
  const { client, tenant, state } = await fixture(t, { subscription: [original] });
  const args = { ...subscription, state: 'DISABLED', expected_digest: canonicalDigest(original), confirmation: 'SET ALERT SUBSCRIPTION transport' };
  for (const conditions of [['event'], ['event', 'missing']]) {
    await fails(client, 'ans_set_subscription', { ...args, conditions }, /references|scope/);
  }
  state.action.set('mail', { ...action, fallbackAction: 'absent-fallback' });
  await fails(client, 'ans_set_subscription', args, /references|scope/);
  assert.equal(writes(tenant).length, 0);
  state.action.set('mail', action);
  const result = await call(client, 'ans_set_subscription', args);
  assert.equal(result.verified, true);
  assert.equal(state.subscription.get('transport').state, 'DISABLED');
  assert.equal(state.subscription.get('transport').description, SECRET);
  assert.equal(state.subscription.get('transport').snoozeTimestamp, 0);
  assert.deepEqual(state.subscription.get('transport').labels, ['preserve']);
  assert.equal(result.configuration.configuration_digest, canonicalDigest(state.subscription.get('transport')));
  await fails(client, 'ans_set_subscription', args, /expected_digest/);
  assert.equal(writes(tenant).length, 1);
});

test('subscription creation uses POST and readback failures retain accepted mutation outcome', async t => {
  let accepted = false;
  const { client, tenant } = await fixture(t, { subscription: [] }, request => {
    if (request.method === 'POST') { accepted = true; return { status: 202 }; }
    if (accepted && request.path.endsWith('/subscription/transport')) return { status: 403, body: SECRET };
    return null;
  });
  const result = await call(client, 'ans_set_subscription', { ...subscription, confirmation: 'SET ALERT SUBSCRIPTION transport' });
  assert.equal(result.accepted, true);
  assert.equal(result.status, 202);
  assert.equal(result.verified, false);
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.source_result.result, 'forbidden');
  assert.equal(writes(tenant).length, 1);
  assert.equal(writes(tenant)[0].path, `${ROOT}/subscription`);
});

test('large rule inventories return bounded partial evidence rather than losing the whole report', async t => {
  const rows = Array.from({ length: 405 }, (_, index) => ({ ...subscription, name: `subscription-${index}` }));
  const { client } = await fixture(t, { subscription: rows });
  const result = await call(client, 'ans_validate_native_rules');
  assert.equal(result.complete, false);
  assert.ok(result.items.length > 0 && result.items.length < rows.length);
  assert.ok(result.findings.some(row => row.code === 'rule_output_limit'));
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) < 64 * 1024);
});
