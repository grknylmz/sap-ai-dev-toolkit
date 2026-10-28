import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { createServiceClient } from '../src/integration-http.mjs';
import { readCpiDataStores, readCpiVariables, readCpiJmsBrokerStatus } from '../src/cpi-async-monitoring.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', CPI_SERVICE_KEY: tenant.serviceKey() }, pollIntervalMs: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'async-monitoring-test', version: '1.0.0' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content[0].text);
  const value = JSON.parse(result.content[0].text);
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) < 96 * 1024);
  return value;
}
const service = tenant => createServiceClient({ label: 'async-fixture', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'client', clientSecret: 'private', env: {}, retryDelayMs: 0 });
const collection = results => ({ status: 200, json: { d: { results } } });
const noOptions = request => request.query.size === 0;

// These endpoints reject all OData options, including top/filter/count. The toolkit must page locally.
test('global datastore key accepts empty IntegrationFlow; entry pages never imply backlog totals or MPL resolution', async t => {
  const entries = Array.from({ length: 205 }, (_, index) => ({ Id: `ENTRY${index}`, Status: 'Waiting', MessageId: `GUID${index}`,
    CreatedAt: '/Date(1760000000000)/', Body: 'PRIVATE_ENTRY_BODY' }));
  const store = { DataStoreName: "global's", IntegrationFlow: '', Type: '', Visibility: 'Global', NumberOfMessages: '6834', NumberOfOverdueMessages: '6377', Value: 'PRIVATE_STORE_VALUE' };
  const tenant = await startFakeTenant(t, request => {
    if (!noOptions(request)) return { status: 400, body: 'OData options unsupported' };
    const path = decodeURIComponent(request.path);
    const base = "/api/v1/DataStores(DataStoreName='global''s',IntegrationFlow='',Type='')";
    if (path === `${base}/Entries`) return collection(entries);
    if (path === base) return { status: 200, json: { d: store } };
    return { status: 404, body: 'Unexpected route' };
  });
  const client = await connect(t, tenant);
  const ids = [];
  let cursor;
  let page;
  do {
    page = await call(client, 'cpi_list_data_store_entries', { data_store: "global's", integration_flow: '', top: 100, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map(row => row.Id));
    assert.equal(page.total, null, 'no invented count from a local source');
    assert.equal(page.store.NumberOfMessages, 6834);
    assert.equal(page.store.NumberOfOverdueMessages, 6377);
    assert.equal(page.source_results.store.result, 'ok');
    assert.ok(page.items.every(row => row.message_log_link === 'unverified'));
    assert.equal(JSON.stringify(page).includes('PRIVATE_'), false);
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(page.complete, true);
  assert.equal(page.returned, 5);
  assert.deepEqual(ids, entries.map(row => row.Id));
  assert.ok(tenant.apiRequests().every(request => noOptions(request) && request.method === 'GET'));
  assert.equal(tenant.apiRequests().some(request => /MessageProcessingLogs|\$value|Messages|Payload/.test(request.path)), false);
});

test('205 filtered store and variable identities use bounded local pages and bind exact filter values before requests', async t => {
  const stores = Array.from({ length: 205 }, (_, index) => ({ DataStoreName: `STORE${index}`, IntegrationFlow: '', Type: '', Visibility: 'Global', NumberOfMessages: 20, NumberOfOverdueMessages: 3 }));
  const variables = stores.map((row, index) => ({ VariableName: `VAR${index}`, IntegrationFlow: '', Visibility: 'Global', Value: 'PRIVATE_VARIABLE' }));
  const tenant = await startFakeTenant(t, request => {
    if (!noOptions(request)) return { status: 400 };
    if (request.path === '/api/v1/DataStores') return collection([...stores, { ...stores[0], DataStoreName: 'not-global', IntegrationFlow: 'Flow', Visibility: 'Local' }]);
    if (request.path === '/api/v1/Variables') return collection([...variables, { ...variables[0], VariableName: 'not-global', IntegrationFlow: 'Flow' }]);
    return { status: 404 };
  });
  const client = await connect(t, tenant);
  for (const [name, field] of [['cpi_list_data_stores', 'DataStoreName'], ['cpi_list_variables', 'VariableName']]) {
    const args = { integration_flow: '', visibility: 'Global', top: 100, ...(name === 'cpi_list_data_stores' ? { overdue_only: true } : {}) };
    let page = await call(client, name, args);
    const firstCursor = page.next_cursor;
    const ids = page.items.map(row => row[field]);
    assert.equal(page.total, null);
    assert.equal(page.complete, false);
    const requestCount = tenant.requests.length;
    for (const changed of [{ integration_flow: 'Flow' }, { visibility: 'Local' }]) {
      const error = await client.callTool({ name, arguments: { ...args, ...changed, cursor: firstCursor } });
      assert.equal(error.isError, true);
      assert.match(error.content[0].text, /cursor/);
    }
    assert.equal(tenant.requests.length, requestCount, 'filter mismatch rejected before token/network access');
    while (page.next_cursor) {
      page = await call(client, name, { ...args, cursor: page.next_cursor });
      ids.push(...page.items.map(row => row[field]));
      assert.equal(JSON.stringify(page).includes('PRIVATE_VARIABLE'), false);
    }
    assert.equal(page.complete, true);
    assert.equal(ids.length, 205);
    assert.equal(new Set(ids).size, 205);
  }
  assert.ok(tenant.apiRequests().every(noOptions));
});

test('JMS queue metadata preserves healthy/warning/critical and unknown flags without reading message bodies', async t => {
  const queues = [
    { Name: 'healthy', State: 0, Active: true, Exclusive: '0', NumbOfMsgs: '42', Size: '12', Type: 'NON_EXCLUSIVE', FillGrade: '3' },
    { Name: 'warning', State: '1', Active: '1', Exclusive: false },
    { Name: 'critical', State: 2, Active: 0, Exclusive: 'true' },
    { Name: 'unknown', State: 'unexpected', Active: 'invalid', Exclusive: null }
  ].map(row => ({ ...row, MessageBody: 'PRIVATE_MESSAGE_BODY', Password: 'PRIVATE_PASSWORD' }));
  const tenant = await startFakeTenant(t, request => request.path === '/api/v1/Queues' && noOptions(request) ? collection(queues) : { status: 400 });
  const client = await connect(t, tenant);
  const page = await call(client, 'cpi_list_jms_queues');
  assert.equal(page.complete, true);
  assert.deepEqual(page.items.map(row => row.state), ['healthy', 'warning', 'critical', 'unknown']);
  assert.deepEqual(page.items.map(row => row.Active), [1, 1, 0, null]);
  assert.deepEqual(page.items.map(row => row.Exclusive), [0, 0, 1, null]);
  assert.equal(page.items[0].NumbOfMsgs, 42);
  assert.equal(page.items[3].State, null);
  assert.equal(JSON.stringify(page).includes('PRIVATE_'), false);
  const found = await call(client, 'cpi_get_jms_queue', { name: 'unknown' });
  assert.equal(found.found, true);
  assert.equal(found.queue.state, 'unknown');
  const missing = await call(client, 'cpi_get_jms_queue', { name: 'absent' });
  assert.equal(missing.found, false);
  assert.ok(tenant.apiRequests().every(request => request.path === '/api/v1/Queues' && noOptions(request)));
});

test('broker warning/critical and stopped identities are independent; missing/unrecognized capacity flags stay unknown', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (decodeURIComponent(request.path) !== "/api/v1/JmsBrokers('Broker1')" || request.query.size !== 1) return { status: 400 };
    const common = { Capacity: '10', MaxCapacity: '100', CapacityOk: '0', CapacityWarning: '1', CapacityError: 'not-a-flag', IsQueuesHigh: true, Password: 'PRIVATE_BROKER' };
    if (request.query.get('$expand') === 'QueueStates') return { status: 200, json: { d: { ...common, QueueStates: { results: [
      { Name: 'healthy', State: 0 }, { Name: 'warning', State: 1 }, { Name: 'critical', State: '2' }, { Name: 'unknown', State: 8 }, { Name: 'missing' }
    ] } } } };
    if (request.query.get('$expand') === 'InactiveQueues') return { status: 200, json: { d: { ...common, InactiveQueues: { results: [{ Name: 'stopped', Value: 'PRIVATE_QUEUE' }] } } } };
    return { status: 400 };
  });
  const client = await connect(t, tenant);
  const report = await call(client, 'cpi_get_jms_broker_status');
  assert.equal(report.complete, true);
  assert.equal(report.queue_count, 5);
  assert.equal(report.unhealthy_queue_count, 2);
  assert.equal(report.unknown_queue_count, 2);
  assert.equal(report.stopped_queue_count, 1);
  assert.deepEqual(report.unhealthy_queues.items.map(row => row.Name), ['warning', 'critical']);
  assert.deepEqual(report.stopped_queues.items, [{ Name: 'stopped', stopped: true }]);
  assert.equal(report.broker.CapacityWarning, 1);
  assert.equal(report.broker.CapacityError, null);
  assert.equal(report.broker.IsConsumersHigh, null);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.deepEqual(tenant.apiRequests().map(request => request.query.get('$expand')).sort(), ['InactiveQueues', 'QueueStates']);
});

test('forbidden broker sources preserve independent healthy evidence and withhold raw tenant errors', async t => {
  for (const forbidden of ['QueueStates', 'InactiveQueues']) {
    const tenant = await startFakeTenant(t, request => {
      const expand = request.query.get('$expand');
      if (expand === forbidden) return { status: 403, body: 'PRIVATE_ERROR_BODY token=SECRET' };
      return { status: 200, json: { d: { Capacity: 5, [expand]: { results: expand === 'QueueStates' ? [{ Name: 'warn', State: 1 }] : [{ Name: 'stopped' }] } } } };
    });
    const report = await readCpiJmsBrokerStatus(service(tenant));
    assert.equal(report.complete, false);
    const failed = forbidden === 'QueueStates' ? 'queue_states' : 'inactive_queues';
    const succeeded = forbidden === 'QueueStates' ? 'inactive_queues' : 'queue_states';
    assert.equal(report.source_results[failed].result, 'forbidden');
    assert.equal(report.source_results[succeeded].result, 'ok');
    assert.equal(forbidden === 'QueueStates' ? report.queue_count : report.stopped_queue_count, null);
    assert.equal(forbidden === 'QueueStates' ? report.stopped_queue_count : report.unhealthy_queue_count, 1);
    assert.equal(report.broker.Capacity, 5);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
    assert.equal(tenant.apiRequests().length, 2);
  }
});

test('queue/store/variable permission failures stay unknown, and internal deadlines propagate without requests', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 403, body: 'PRIVATE_ACCESS_DETAIL' }));
  const client = await connect(t, tenant);
  for (const name of ['cpi_list_jms_queues', 'cpi_list_data_stores', 'cpi_list_variables']) {
    const page = await call(client, name);
    assert.equal(page.complete, false);
    assert.equal(page.total, null);
    assert.equal(page.source_result.result, 'forbidden');
    assert.equal(JSON.stringify(page).includes('PRIVATE_ACCESS_DETAIL'), false);
  }
  const queue = await call(client, 'cpi_get_jms_queue', { name: 'restricted' });
  assert.equal(queue.found, null);
  const internalClient = service(tenant);
  const count = tenant.requests.length;
  for (const helper of [readCpiDataStores, readCpiVariables]) {
    const result = await helper(internalClient, { deadline: Date.now() - 1 });
    assert.equal(result.complete, false);
    assert.equal(result.stop_reason, 'deadline');
  }
  const broker = await readCpiJmsBrokerStatus(internalClient, { deadline: Date.now() - 1 });
  assert.equal(broker.complete, false);
  assert.equal(broker.source_results.queue_states.stop_reason, 'deadline');
  assert.equal(broker.source_results.inactive_queues.stop_reason, 'deadline');
  assert.equal(tenant.requests.length, count);
});

test('entry evidence survives forbidden store totals; no zero backlog or resolved message link is invented', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (!noOptions(request)) return { status: 400 };
    if (request.path.endsWith('/Entries')) return collection([{ Id: 'ENTRY', MessageId: 'unresolved-message', Payload: 'PRIVATE_PAYLOAD' }]);
    return { status: 403, body: 'PRIVATE_BACKLOG_ERROR' };
  });
  const client = await connect(t, tenant);
  const page = await call(client, 'cpi_list_data_store_entries', { data_store: 'global', integration_flow: '' });
  assert.equal(page.returned, 1);
  assert.equal(page.items[0].MessageId, 'unresolved-message');
  assert.equal(page.items[0].message_log_link, 'unverified');
  assert.equal(page.store, null);
  assert.equal(page.source_results.entries.result, 'ok');
  assert.equal(page.source_results.store.result, 'forbidden');
  assert.equal(JSON.stringify(page).includes('PRIVATE_'), false);
  assert.ok(tenant.apiRequests().every(noOptions));
  assert.equal(tenant.apiRequests().length, 2);
});

test('205 queue identities remain locally resumable; oversized broker snapshots remain bounded and incomplete', async t => {
  const queues = Array.from({ length: 205 }, (_, index) => ({ Name: `QUEUE${index}`, State: 1, Active: 1 }));
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/api/v1/Queues' && noOptions(request)) return collection(queues);
    const expand = request.query.get('$expand');
    if (request.query.size === 1 && ['QueueStates', 'InactiveQueues'].includes(expand)) {
      return { status: 200, json: { d: { [expand]: { results: queues } } } };
    }
    return { status: 400 };
  });
  const client = await connect(t, tenant);
  const names = [];
  let page = await call(client, 'cpi_list_jms_queues', { top: 100 });
  for (;;) {
    names.push(...page.items.map(row => row.Name));
    if (!page.next_cursor) break;
    page = await call(client, 'cpi_list_jms_queues', { top: 100, cursor: page.next_cursor });
  }
  assert.equal(page.complete, true);
  assert.deepEqual(names, queues.map(row => row.Name));
  const broker = await call(client, 'cpi_get_jms_broker_status');
  assert.equal(broker.unhealthy_queue_count, 205);
  assert.equal(broker.stopped_queue_count, 205);
  assert.equal(broker.complete, false);
  assert.equal(broker.unhealthy_queues.stop_reason, 'source_limit');
  assert.equal(broker.unhealthy_queues.next_cursor, null, 'no unusable cursor for a single snapshot');
  assert.ok(broker.unhealthy_queues.returned <= 200);
  assert.equal(broker.stopped_queues.stop_reason, 'source_limit');
});
