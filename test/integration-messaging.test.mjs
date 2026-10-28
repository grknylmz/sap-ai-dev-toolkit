import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTenant } from './fake-integration-tenant.mjs';
import { createServiceClient, createStaticServiceClient } from '../src/integration-http.mjs';
import { registerEventMeshTools, registerAemTools, registerAemSempTools } from '../src/integration-messaging.mjs';

const ROOT = '/api/v2/missionControl/eventBrokerServices';
const SEMP = '/SEMP/v2/monitor/msgVpns/scope%2Fvpn/queues';
function tools(registrar, ...args) {
  const handlers = new Map();
  registrar((name, _title, _description, schema, _annotations, handler) => handlers.set(name, input => handler(schema.parse(input))), ...args);
  return Object.fromEntries(handlers);
}
const staticClient = tenant => createStaticServiceClient({ label: 'messaging', url: tenant.url, authorization: () => 'Basic private-credential', reuseCookies: true, env: {} });


test('Event Mesh encodes slash-containing identity once and uses management OAuth without consuming messages', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { maxQueueSizeInBytes: 1000, maxMessageSizeInBytes: 500, respectTtl: true, maxRedeliveryCount: '12', token: 'private-token', credentials: 'private-secret', arbitraryCount: 222, messageBody: 'private-message' } }));
  const client = createServiceClient({ label: 'Event Mesh', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'mesh', clientSecret: 'private-secret', env: {} });
  const result = await tools(registerEventMeshTools, client).event_mesh_get_queue({ name: 'namespace/sub/queue #1' });
  assert.equal(tenant.apiRequests()[0].path, '/hub/rest/api/v1/management/messaging/queues/namespace%2Fsub%2Fqueue%20%231');
  assert.equal(tenant.apiRequests()[0].headers.authorization, 'Bearer token-1');
  assert.equal(tenant.apiRequests().length, 1);
  assert.equal(result.http_status, 200);
  assert.deepEqual(result.configuration, { maxQueueSizeInBytes: 1000, maxMessageSizeInBytes: 500, respectTtl: true });
  assert.equal(result.runtime_health, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /private-|messageBody|credentials|"token"/);
});

test('AEM translates signed paging to one-based GA pages without guessing count metadata', async t => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: `broker-${i}`, name: `name-${i}`, adminState: 'FUTURE_STATE', creationState: 'NEW_STATE', msgVpnName: 'vpn', allowedActions: ['get'], password: 'private-password', broker: { password: 'private-broker' }, serviceConnectionEndpoints: ['https://private:secret@host/?token=secret'] }));
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, ROOT);
    assert.equal(request.query.get('pageSize'), '100');
    assert.equal(request.query.get('expand'), 'allowedActions');
    assert.equal(request.query.has('$top'), false);
    const page = Number(request.query.get('pageNumber'));
    return { status: 200, json: { data: rows.slice((page - 1) * 100, page * 100), meta: { unverifiedTotal: 205 } } };
  });
  const api = tools(registerAemTools, staticClient(tenant));
  let cursor, all = [], result;
  do {
    result = await api.aem_list_brokers({ top: 73, ...(cursor ? { cursor } : {}) });
    all.push(...result.items);
    cursor = result.next_cursor;
  } while (cursor);
  assert.equal(result.complete, true);
  assert.equal(result.total, null);
  assert.deepEqual(all.map(row => row.id), rows.map(row => row.id));
  assert.equal(all[0].adminState, 'FUTURE_STATE');
  assert.equal(all[0].creationState, 'NEW_STATE');
  assert.equal(all.some(row => Object.hasOwn(row, 'health')), false);
  assert.doesNotMatch(JSON.stringify(all), /private-|password|serviceConnectionEndpoints/);
  assert.equal(tenant.apiRequests()[0].query.get('pageNumber'), '1');
});

test('AEM named resources use only documented GA expansions and preserve unknown operation status', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/operations/op%2F1')) return { status: 200, json: { data: { id: 'op/1', operationType: 'FUTURE_TYPE', status: 'FUTURE_STATUS', error: { errorId: 'err-id', message: 'private-error-token' }, progressLogs: ['private-log'] } } };
    assert.equal(request.query.get('expand'), 'broker,allowedActions,messageSpoolDetails');
    return { status: 200, json: { data: { id: 'service/1', name: 'test', msgVpnName: 'vpn', eventBrokerServiceVersion: '10.0', broker: { managementPassword: 'private-password' }, messageSpoolDetails: { secret: 'private-spool' } } } };
  });
  const api = tools(registerAemTools, staticClient(tenant));
  const broker = await api.aem_get_broker({ service_id: 'service/1' });
  assert.equal(tenant.apiRequests()[0].path, `${ROOT}/service%2F1`);
  const operation = await api.aem_get_broker_operation({ service_id: 'service/1', operation_id: 'op/1' });
  assert.equal(tenant.apiRequests()[1].path, `${ROOT}/service%2F1/operations/op%2F1`);
  assert.equal(operation.status, 'FUTURE_STATUS');
  assert.equal(operation.errorId, 'err-id');
  assert.doesNotMatch(JSON.stringify({ broker, operation }), /private-|progressLogs|managementPassword/);
});

test('AEM forged, foreign-runtime and foreign-collection cursors fail before network access', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { data: Array.from({ length: 100 }, (_, i) => ({ id: `${i}` })) } }));
  const client = staticClient(tenant);
  const api = tools(registerAemTools, client);
  const page = await api.aem_list_brokers({ top: 1 });
  const count = tenant.requests.length;
  const [payload, signature] = page.next_cursor.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  data.next = 'https://attacker.example/elsewhere';
  const forged = `${Buffer.from(JSON.stringify(data)).toString('base64url')}.${signature}`;
  await assert.rejects(api.aem_list_brokers({ cursor: forged }), /cursor/);
  await assert.rejects(tools(registerAemTools, staticClient(tenant)).aem_list_brokers({ cursor: page.next_cursor }), /cursor/);
  await assert.rejects(tools(registerAemSempTools, client, { sempVpnName: 'scope/vpn' }).aem_list_queues({ cursor: page.next_cursor }), /cursor/);
  assert.equal(tenant.requests.length, count);
});

test('SEMP pages exact configured VPN with private session reuse and numeric/boolean projection', async t => {
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, SEMP);
    assert.equal(request.query.get('count'), '100');
    if (!request.query.has('cursor')) return { status: 200, headers: { 'set-cookie': 'JSESSIONID=private-session; Path=/; HttpOnly' }, json: { data: [{ queueName: 'q1', msgVpnName: 'scope/vpn', spooledMsgCount: 10, ingressEnabled: true, arbitraryNumber: 77, password: 'private-password' }], meta: { paging: { nextPageUri: `${SEMP}?count=100&cursor=next-token` } } } };
    assert.equal(request.query.get('cursor'), 'next-token');
    assert.match(request.headers.cookie, /JSESSIONID=private-session/);
    return { status: 200, json: { data: [{ queueName: 'q2', spooledMsgCount: 0, egressEnabled: false, spooledByteCount: 'wrong-type' }], meta: {} } };
  });
  const api = tools(registerAemSempTools, staticClient(tenant), { sempVpnName: 'scope/vpn' });
  const first = await api.aem_list_queues({ top: 1 });
  assert.equal(first.complete, false);
  assert.deepEqual(first.items, [{ queueName: 'q1', msgVpnName: 'scope/vpn', spooledMsgCount: 10, ingressEnabled: true }]);
  const second = await api.aem_list_queues({ top: 1, cursor: first.next_cursor });
  assert.equal(second.complete, true);
  assert.equal(second.total, null, 'the last page does not establish a server-side total');
  assert.deepEqual(second.items, [{ queueName: 'q2', spooledMsgCount: 0, egressEnabled: false }]);
  assert.doesNotMatch(JSON.stringify([first, second]), /private-|password/);
});

test('SEMP rejects cross-origin, different-VPN and message continuations before following them', async t => {
  for (const link of ['https://attacker.example/SEMP/v2/monitor/msgVpns/scope%2Fvpn/queues?cursor=x', '/SEMP/v2/monitor/msgVpns/other/queues?cursor=x', `${SEMP}/messages?cursor=x`, `${SEMP}?cursor=x&password=secret`]) {
    const tenant = await startFakeTenant(t, () => ({ status: 200, json: { data: [{ queueName: 'q' }], meta: { paging: { nextPageUri: link } } } }));
    await assert.rejects(tools(registerAemSempTools, staticClient(tenant), { sempVpnName: 'scope/vpn' }).aem_list_queues({}), /continuation/);
    assert.equal(tenant.apiRequests().length, 1);
  }
});

test('SEMP no-session-slot and Basic access failures remain incomplete setup evidence, never empty success', async t => {
  for (const status of [529, 401, 403]) {
    const tenant = await startFakeTenant(t, () => ({ status, json: { password: 'private-password', message: 'private-message' } }));
    const result = await tools(registerAemSempTools, staticClient(tenant), { sempVpnName: 'scope/vpn' }).aem_list_queues({});
    assert.equal(result.complete, false);
    assert.equal(result.total, null);
    assert.equal(result.source_result.http_status, status);
    assert.equal(result.source_result.setup_status, status === 529 ? 'no_session_slots' : 'needs_admin_confirmation');
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    assert.equal(tenant.tokenRequests().length, 0);
  }
});

test('SEMP cursor binds the configured VPN before any request', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { data: [{ queueName: 'q1' }], meta: { paging: { nextPageUri: `${SEMP}?count=100&cursor=next-token` } } } }));
  const client = staticClient(tenant);
  const first = await tools(registerAemSempTools, client, { sempVpnName: 'scope/vpn' }).aem_list_queues({ top: 1 });
  const calls = tenant.requests.length;
  await assert.rejects(tools(registerAemSempTools, client, { sempVpnName: 'other-vpn' }).aem_list_queues({ cursor: first.next_cursor }), /cursor/);
  assert.equal(tenant.requests.length, calls);
});
