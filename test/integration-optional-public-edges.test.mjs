import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { buildIflowBundle } from '../src/iflow-bundle.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const CLOUD = '/api/v2/missionControl/eventBrokerServices';
const SEMP = '/SEMP/v2/monitor/msgVpns/scope%2Fvpn/queues';
const PRIVATE = 'PRIVATE_OPTIONAL_VALUE';
const json = data => ({ status: 200, json: data });
const basic = `Basic ${Buffer.from(`reader:${PRIVATE}`).toString('base64')}`;

async function sdk(t, tenant, credentials) {
  const home = await mkdtemp(join(tmpdir(), 'optional-public-edges-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const origins = [];
  const runtime = createIntegrationServer({
    env: { XDG_CONFIG_HOME: home, INTEGRATION_ENVIRONMENT: 'source-fixture', ...credentials },
    fetchImpl: (input, init) => {
      const url = new URL(input);
      assert.ok([tenant.url, 'https://api.solace.cloud'].includes(url.origin), 'no alternate service or regional fallback');
      origins.push(url.origin);
      // Only this test transport routes the fixed production US authority to loopback.
      return fetch(`${tenant.url}${url.pathname}${url.search}`, init);
    }
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'optional-public-edges', version: '1' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return { client, origins, runtime };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const value = JSON.parse(result.content[0].text);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_OPTIONAL_VALUE/);
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) < 96 * 1024);
  return value;
}
async function rejectsSource(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OPTIONAL_VALUE/);
}
const aemConfig = { AEM_CONFIG: JSON.stringify({ apiToken: PRIVATE }) };
const sempConfig = tenant => ({ AEM_SEMP_CONFIG: JSON.stringify({ url: tenant.url, msgVpnName: 'scope/vpn', username: 'reader', password: PRIVATE }) });

// These calls cross the production server registration and SDK boundary, not a registrar map.
test('SDK Event Mesh named reads preserve configuration scope, slash identity and access outcomes', async t => {
  let response = json({ maxQueueSizeInBytes: 2048, enableIngress: false, maxRedeliveryCount: 'wrong-type', password: PRIVATE, messageBody: PRIVATE });
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/hub/rest/api/v1/management/messaging/queues/ns%2Fqueue%20%231');
    assert.match(request.headers.authorization, /^Bearer token-/);
    return response;
  });
  const { client } = await sdk(t, tenant, { EVENT_MESH_CONFIG: JSON.stringify({ url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'mesh', clientSecret: PRIVATE }) });
  const queue = await call(client, 'event_mesh_get_queue', { name: 'ns/queue #1' });
  assert.deepEqual(queue.configuration, { maxQueueSizeInBytes: 2048, enableIngress: false });
  assert.equal(queue.runtime_health, 'unverified');
  assert.equal(queue.scope, 'standalone_default_plan_configuration');
  assert.doesNotMatch(JSON.stringify(queue), /password|messageBody/);
  for (const [status, expected] of [[401, 'unauthenticated'], [403, 'forbidden'], [404, 'unavailable']]) {
    response = { status, body: PRIVATE };
    const failed = await call(client, 'event_mesh_get_queue', { name: 'ns/queue #1' });
    assert.equal(failed.result, expected);
    assert.equal(failed.http_status, status);
    assert.equal(Object.hasOwn(failed, 'runtime_health'), false);
  }
  response = json([]);
  assert.equal((await call(client, 'event_mesh_get_queue', { name: 'ns/queue #1' })).result, 'error');
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

test('SDK AEM cloud paging retains identities and unknown states without inventing totals', async t => {
  let mode = 'rows';
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: `broker-${i}`, name: `broker-${String(i).padStart(3, '0')}`, adminState: 'FUTURE_ADMIN', creationState: 'FUTURE_CREATE', password: PRIVATE }));
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, CLOUD);
    assert.equal(request.headers.authorization, `Bearer ${PRIVATE}`);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.query.get('expand'), 'allowedActions');
    assert.equal(request.query.get('pageSize'), '100');
    if (mode === 'empty') return json({ data: [] });
    if (mode === 'oversize') return json({ data: rows });
    if (mode === 'malformed') return json({ data: {} });
    if (typeof mode === 'number') return { status: mode, body: PRIVATE };
    const offset = (Number(request.query.get('pageNumber')) - 1) * 100;
    return json({ data: rows.slice(offset, offset + 100), meta: { total: 999999 } });
  });
  const { client, origins } = await sdk(t, tenant, aemConfig);
  const first = await call(client, 'aem_list_brokers', { top: 100 });
  const second = await call(client, 'aem_list_brokers', { top: 100, cursor: first.next_cursor });
  assert.equal(first.complete, false);
  assert.equal(second.complete, false, 'a nonempty page alone does not establish source end');
  assert.equal(second.total, null);
  assert.deepEqual([...first.items, ...second.items].map(row => row.id), rows.map(row => row.id));
  const end = await call(client, 'aem_list_brokers', { top: 100, cursor: second.next_cursor });
  assert.equal(end.complete, true);
  assert.equal(end.returned, 0);
  assert.equal(first.items[0].adminState, 'FUTURE_ADMIN');
  assert.equal(first.items[0].creationState, 'FUTURE_CREATE');
  assert.equal(Object.hasOwn(first.items[0], 'health'), false);
  mode = 'empty';
  const empty = await call(client, 'aem_list_brokers');
  assert.equal(empty.returned, 0);
  assert.equal(empty.complete, true);
  assert.equal(empty.total, null);
  for (const source of ['oversize', 'malformed', 401, 403, 404]) {
    mode = source;
    await rejectsSource(client, 'aem_list_brokers');
  }
  assert.ok(origins.every(origin => origin === 'https://api.solace.cloud'));
  assert.equal(tenant.tokenRequests().length, 0);
});

test('SDK AEM named broker and operation verification rejects absent, mismatched and foreign identities', async t => {
  let brokerData = { id: 'service/1', eventBrokerServiceVersion: '10.0', adminState: 'FUTURE_ADMIN', broker: { password: PRIVATE } };
  let operationData = { id: 'op/1', resourceId: 'service/1', status: 'FUTURE_STATUS', operationType: 'FUTURE_TYPE', progressLogs: [PRIVATE] };
  let status = 200;
  const tenant = await startFakeTenant(t, request => {
    const operation = request.path === `${CLOUD}/service%2F1/operations/op%2F1`;
    assert.ok(operation || request.path === `${CLOUD}/service%2F1`);
    assert.equal(request.headers.authorization, `Bearer ${PRIVATE}`);
    assert.equal(request.query.get('expand'), operation ? null : 'broker,allowedActions,messageSpoolDetails');
    return status === 200 ? json({ data: operation ? operationData : brokerData }) : { status, body: PRIVATE };
  });
  const { client } = await sdk(t, tenant, aemConfig);
  const brokerArgs = { service_id: 'service/1' }, operationArgs = { ...brokerArgs, operation_id: 'op/1' };
  const broker = await call(client, 'aem_get_broker', brokerArgs);
  assert.equal(broker.id, 'service/1');
  assert.equal(broker.adminState, 'FUTURE_ADMIN');
  assert.equal(broker.runtime_health, 'unverified');
  const operation = await call(client, 'aem_get_broker_operation', operationArgs);
  assert.equal(operation.id, 'op/1');
  assert.equal(operation.status, 'FUTURE_STATUS');
  assert.doesNotMatch(JSON.stringify({ broker, operation }), /progressLogs|password/);
  for (const bad of [{}, [], null, { id: 'other' }, { id: 123 }]) {
    brokerData = bad; operationData = bad;
    assert.equal((await call(client, 'aem_get_broker', brokerArgs)).result, 'error');
    assert.equal((await call(client, 'aem_get_broker_operation', operationArgs)).result, 'error');
  }
  brokerData = { id: 'service/1' };
  assert.equal((await call(client, 'aem_get_broker', brokerArgs)).result, 'error');
  operationData = { id: 'op/1', resourceId: 'foreign-service', status: 'SUCCEEDED' };
  assert.equal((await call(client, 'aem_get_broker_operation', operationArgs)).result, 'error');
  // Optional operation metadata may be absent; requested identity is still verified.
  operationData = { id: 'op/1' };
  assert.equal((await call(client, 'aem_get_broker_operation', operationArgs)).result, 'ok');
  for (const [code, result] of [[401, 'unauthenticated'], [403, 'forbidden'], [404, 'unavailable']]) {
    status = code;
    for (const [name, args] of [['aem_get_broker', brokerArgs], ['aem_get_broker_operation', operationArgs]]) {
      const failed = await call(client, name, args);
      assert.equal(failed.result, result);
      assert.equal(failed.http_status, code);
      assert.equal(Object.hasOwn(failed, 'runtime_health'), false);
    }
  }
});

test('SDK SEMP uses independent VPN Basic sessions and refuses off-scope continuations', async t => {
  let mode = 'pages';
  let link = `${SEMP}?count=100&cursor=opaque`;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${CLOUD}/cloud`) {
      assert.equal(request.headers.authorization, `Bearer ${PRIVATE}`);
      assert.equal(request.headers.cookie, undefined);
      return json({ data: { id: 'cloud', eventBrokerServiceVersion: '10.0' } });
    }
    assert.equal(request.path, SEMP);
    assert.equal(request.headers.authorization, basic);
    assert.equal(request.query.get('count'), '100');
    if (typeof mode === 'number') return { status: mode, body: PRIVATE };
    if (mode === 'malformed') return json({ data: {} });
    if (mode === 'empty') return json({ data: [], meta: {} });
    if (request.query.has('cursor')) {
      assert.equal(request.query.get('cursor'), 'opaque');
      assert.equal(request.headers.cookie, `JSESSIONID=${PRIVATE}`);
      return json({ data: [{ queueName: 'q2', msgVpnName: 'scope/vpn', spooledMsgCount: 0, egressEnabled: false }], meta: {} });
    }
    return { ...json({ data: [{ queueName: 'q1', msgVpnName: 'scope/vpn', spooledMsgCount: 13, ingressEnabled: true, arbitraryNumber: 42, password: PRIVATE }], meta: { paging: { nextPageUri: link } } }), headers: { 'set-cookie': `JSESSIONID=${PRIVATE}; Path=/SEMP; HttpOnly` } };
  });
  const { client } = await sdk(t, tenant, { ...aemConfig, ...sempConfig(tenant) });
  const first = await call(client, 'aem_list_queues', { top: 1 });
  const second = await call(client, 'aem_list_queues', { top: 1, cursor: first.next_cursor });
  assert.deepEqual(first.items, [{ queueName: 'q1', msgVpnName: 'scope/vpn', spooledMsgCount: 13, ingressEnabled: true }]);
  assert.deepEqual(second.items, [{ queueName: 'q2', msgVpnName: 'scope/vpn', spooledMsgCount: 0, egressEnabled: false }]);
  assert.equal(second.complete, true);
  assert.equal(second.total, null);
  assert.equal((await call(client, 'aem_get_broker', { service_id: 'cloud' })).id, 'cloud');
  for (const invalid of ['https://foreign.example/queues?cursor=x', '/SEMP/v2/monitor/msgVpns/foreign/queues?cursor=x', `${SEMP}/messages?cursor=x`]) {
    link = invalid;
    const before = tenant.requests.length;
    await rejectsSource(client, 'aem_list_queues');
    assert.equal(tenant.requests.length, before + 1);
  }
  for (const status of [401, 403, 529]) {
    mode = status;
    const failure = await call(client, 'aem_list_queues');
    assert.equal(failure.complete, false);
    assert.equal(failure.total, null);
    assert.equal(failure.source_result.http_status, status);
    assert.equal(failure.source_result.setup_status, status === 529 ? 'no_session_slots' : 'needs_admin_confirmation');
  }
  mode = 404;
  await rejectsSource(client, 'aem_list_queues');
  mode = 'malformed';
  await rejectsSource(client, 'aem_list_queues');
  mode = 'empty';
  assert.equal((await call(client, 'aem_list_queues')).complete, true);
  assert.equal(tenant.tokenRequests().length, 0);
});

test('SDK cTMS local pages preserve large inventories, source failures and binding', async t => {
  let rows = Array.from({ length: 205 }, (_, i) => ({ id: i, name: `Node${i}`, credentials: PRIVATE, uploadAllowed: true }));
  let response;
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, '/v2/nodes');
    assert.equal(request.rawQuery, '');
    assert.match(request.headers.authorization, /^Bearer token-/);
    return response ?? json({ nodes: rows });
  });
  const credentials = { CTMS_SERVICE_KEY: JSON.stringify({ uri: tenant.url, uaa: { url: tenant.url, clientid: 'ctms', clientsecret: PRIVATE } }) };
  const { client } = await sdk(t, tenant, credentials);
  const first = await call(client, 'ctms_list_nodes', { top: 200 });
  const second = await call(client, 'ctms_list_nodes', { top: 200, cursor: first.next_cursor });
  assert.deepEqual([...first.items, ...second.items].map(row => row.id), rows.map(row => row.id));
  assert.equal(first.total, 205);
  assert.equal(second.complete, true);
  assert.equal(second.items[0].import_eligibility, 'unknown');
  assert.equal(second.items[0].upload_eligibility, 'unknown');
  const other = await sdk(t, tenant, credentials);
  const before = tenant.requests.length;
  await rejectsSource(other.client, 'ctms_list_nodes', { cursor: first.next_cursor });
  assert.equal(tenant.requests.length, before);
  rows = [];
  assert.equal((await call(client, 'ctms_list_nodes')).total, 0);
  for (const status of [401, 403, 404]) { response = { status, body: PRIVATE }; await rejectsSource(client, 'ctms_list_nodes'); }
  response = json({ nodes: {} });
  await rejectsSource(client, 'ctms_list_nodes');
});

test('SDK transport readiness traverses >20 iFlows, private backups and exact target without claiming promotion', async t => {
  const flows = Array.from({ length: 21 }, (_, i) => ({ Id: `Flow${i}`, Version: '1.2.3' }));
  const archives = new Map(flows.map(row => [row.Id, buildIflowBundle({ id: row.Id, name: row.Id, version: row.Version, template: 'https-request-reply-http', templateParameters: { sender_path: '/synthetic', receiver_address: 'https://backend.example', receiver_method: 'GET', receiver_authentication: 'None', receiver_timeout_ms: 60000 } })]));
  let changed = false, mixed = false, failed = false, counted = true, nodeName = 'QA';
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/v2/nodes') return json({ nodes: [{ id: 17, name: nodeName, password: PRIVATE }] });
    if (request.path.startsWith('/api/v1/IntegrationPackages(')) {
      const group = request.path.split('/').at(-1);
      if (failed && group === 'MessageMappingDesigntimeArtifacts') return { status: 403, body: PRIVATE };
      const data = group === 'IntegrationDesigntimeArtifacts' ? flows : mixed && group === 'ValueMappingDesigntimeArtifacts' ? [{ Id: 'Codes', Version: '2.0.0' }] : [];
      const offset = Number(request.query.get('$skip') ?? 0), page = data.slice(offset, offset + 7);
      return json({ d: { results: page, ...(counted ? { __count: String(data.length) } : {}), ...(offset + page.length < data.length ? { __next: `${request.path}?$skip=${offset + page.length}` } : {}) } });
    }
    if (request.path === '/api/v1/ValidateIntegrationDesigntimeArtifact') return { status: 202, body: 'Checkexecutionresult: Passed' };
    if (request.path.startsWith('/api/v1/IntegrationDesigntimeArtifacts(')) {
      const id = /Id='([^']+)'/.exec(request.path)?.[1];
      if (request.path.endsWith('/$value')) return { status: 200, body: Buffer.from(archives.get(id)) };
      if (request.path.endsWith('/Configurations')) return json({ d: { results: [{ ParameterKey: 'Business', ParameterValue: changed ? `${PRIVATE}_changed` : PRIVATE, DataType: 'xsd:string' }] } });
      return json({ d: { Id: id, Name: id, Version: '1.2.3' } });
    }
    if (['/api/v1/UserCredentials', '/api/v1/OAuth2ClientCredentials', '/api/v1/KeystoreEntries'].includes(request.path)) return json({ d: { results: [] } });
    return { status: 404 };
  });
  const { client, runtime } = await sdk(t, tenant, { CPI_SERVICE_KEY: tenant.serviceKey(), CTMS_SERVICE_KEY: JSON.stringify({ uri: tenant.url, uaa: { url: tenant.url, clientid: 'ctms', clientsecret: PRIVATE } }) });
  for (const flow of flows) {
    const validation = await call(client, 'cpi_validate_iflow', { iflow_id: flow.Id, version: 'active', confirmation: `VALIDATE IFLOW ${flow.Id} VERSION active` });
    assert.equal(validation.passed, true);
  }
  for (let offset = 0; offset < flows.length; offset += 20) {
    const targets = flows.slice(offset, offset + 20).map(row => ({ kind: 'cpi_iflow', id: row.Id }));
    const preview = await call(client, 'integration_snapshot_content', { targets });
    await call(client, 'integration_snapshot_content', { targets, dry_run: false, confirmation: preview.required_confirmation });
  }
  const input = { source_package_ids: ['Orders'], target_node_name: 'QA' };
  const before = tenant.apiRequests().length;
  const ready = await call(client, 'integration_transport_readiness', input);
  assert.equal(ready.readiness, 'needs_admin_confirmation');
  assert.equal(ready.enumeration_complete, true);
  assert.equal(ready.checked_iflows, 21);
  assert.equal(ready.members.find(row => row.id === 'Flow20').readiness, 'ready');
  assert.equal(ready.snapshots.items.length, 2);
  assert.equal(ready.target_node.id, 17);
  assert.equal(ready.target_node.import_eligibility, 'unknown');
  assert.equal(ready.target_verification, 'requires_independent_target_bound_server');
  assert.equal(ready.source_hosts.cpi, new URL(tenant.url).host);
  assert.equal(runtime.connectionSummary.environment, 'source-fixture');
  assert.ok(tenant.apiRequests().slice(before).every(request => request.method === 'GET'));
  changed = true;
  const stale = await call(client, 'integration_transport_readiness', input);
  assert.equal(stale.readiness, 'blocked');
  assert.ok(stale.blockers.includes('matching_verified_snapshot_required'));
  changed = false; mixed = true; failed = true; counted = false; nodeName = 'DifferentTarget';
  const blocked = await call(client, 'integration_transport_readiness', input);
  assert.equal(blocked.enumeration_complete, false);
  assert.ok(blocked.blockers.includes('source_enumeration_incomplete'));
  assert.ok(blocked.blockers.includes('unchecked_non_iflow_members'));
  assert.ok(blocked.blockers.includes('target_node_missing_or_identity_unverified'));
  assert.equal(blocked.packages[0].groups.message_mappings.source_result.result, 'forbidden');
  assert.equal(blocked.members.find(row => row.id === 'Codes').readiness, 'native_review_required');
});
