import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOpenConnectorsClient, registerOpenConnectorsTools } from '../src/open-connectors-tools.mjs';
import { resultOf } from '../src/integration-common.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const ROOT = '/elements/api-v2';
const USER = 'PRIVATE_USER_SECRET';
const ORG = 'PRIVATE_ORGANIZATION_SECRET';
const TOKEN = 'PRIVATE_ELEMENT_TOKEN';
const NEXT = 'PRIVATE_SERVER_PAGINATION_TOKEN';
const AUTH = `User ${USER}, Organization ${ORG}`;
const instance = id => ({ id, name: `Instance ${id}`, token: TOKEN, configuration: { password: 'PRIVATE_CONFIG' }, providerData: { token: 'PRIVATE_PROVIDER' }, element: { id: 3, key: 'crm', name: 'CRM', token: 'PRIVATE_ELEMENT_METADATA' } });

async function connect(t, tenant) {
  const service = createOpenConnectorsClient({ url: `${tenant.url}${ROOT}`, userSecret: USER, organizationSecret: ORG }, { env: {} });
  const server = new McpServer({ name: 'connector-fixture', version: '1.0.0' });
  registerOpenConnectorsTools((name, title, description, inputSchema, annotations, handler) => {
    server.registerTool(name, { title, description, inputSchema, annotations }, args => resultOf(() => handler(args)));
  }, service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'connector-regression', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name: `open_connectors_${name}`, arguments: args });
    return response.isError ? { error: response.content[0].text } : JSON.parse(response.content[0].text);
  };
  return { call, service };
}

function noPrivate(value) {
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|providerData|configuration|authorization|elements-next-page-token/);
}

test('null-client enumeration is side-effect free and describes the three real operations', () => {
  const names = [];
  registerOpenConnectorsTools(name => names.push(name), null);
  assert.deepEqual(names, ['open_connectors_list_instances', 'open_connectors_get_instance', 'open_connectors_set_instance_enabled']);
});

test('pagination preserves all identities, safe projections and unknown totals without exposing server tokens', async t => {
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.method, 'GET');
    assert.equal(request.path, `${ROOT}/instances`);
    assert.equal(request.headers.authorization, AUTH);
    assert.equal(request.query.get('pageSize'), '200');
    assert.deepEqual([...request.query.keys()].sort(), request.query.has('nextPage') ? ['nextPage', 'pageSize'] : ['pageSize']);
    if (!request.query.has('nextPage')) return { status: 200, json: Array.from({ length: 200 }, (_, index) => instance(index + 1)), headers: { 'elements-next-page-token': NEXT } };
    assert.equal(request.query.get('nextPage'), NEXT);
    return { status: 200, json: Array.from({ length: 5 }, (_, index) => instance(index + 201)) };
  });
  const { call, service } = await connect(t, tenant);
  noPrivate(service);
  const ids = [];
  let cursor;
  let pages = 0;
  do {
    const page = await call('list_instances', { top: 73, ...(cursor ? { cursor } : {}) });
    assert.equal(page.error, undefined);
    noPrivate(page);
    assert.equal(page.total, null);
    assert.equal(page.returned, page.items.length);
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) < 95 * 1024);
    for (const row of page.items) {
      assert.deepEqual(Object.keys(row), ['id', 'name', 'element']);
      assert.deepEqual(Object.keys(row.element), ['id', 'key', 'name']);
    }
    ids.push(...page.items.map(row => row.id));
    if (page.next_cursor) {
      const decoded = Buffer.from(page.next_cursor.split('.')[0], 'base64url').toString();
      assert.doesNotMatch(decoded, /PRIVATE_|nextPage=/);
      assert.equal(page.complete, false);
    } else {
      assert.equal(page.complete, true);
      assert.equal(page.stop_reason, 'end');
    }
    cursor = page.next_cursor;
    assert.ok(++pages < 10);
  } while (cursor);
  assert.deepEqual(ids, Array.from({ length: 205 }, (_, index) => index + 1));
  assert.equal(tenant.requests.length, 2, 'buffered pages reuse safe projected rows, not additional token-bearing reads');
});

test('both documented header spellings are consumed privately and cyclic continuations fail closed', async t => {
  let second = false;
  const tenant = await startFakeTenant(t, request => {
    if (!request.query.has('nextPage')) return { status: 200, json: [instance(1)], headers: { nextPage: NEXT } };
    second = true;
    assert.equal(request.query.get('nextPage'), NEXT);
    return { status: 200, json: [instance(2)], headers: { 'elements-next-page-token': NEXT } };
  });
  const { call } = await connect(t, tenant);
  const first = await call('list_instances');
  assert.equal(first.complete, false);
  const repeated = await call('list_instances', { cursor: first.next_cursor });
  assert.equal(second, true);
  assert.match(repeated.error, /repeats a continuation/);
  noPrivate(repeated);
});

test('tampering, foreign runtimes and foreign route cursors are rejected before HTTP', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: [instance(1)], headers: { 'elements-next-page-token': NEXT } }));
  const a = await connect(t, tenant);
  const b = await connect(t, tenant);
  const page = await a.call('list_instances');
  const [payload, signature] = page.next_cursor.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url'));
  const forged = Buffer.from(JSON.stringify({ ...data, root: '/foreign', next: 'https://attacker.example/instances?nextPage=stolen' })).toString('base64url');
  const count = tenant.requests.length;
  for (const cursor of [`${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`, `${forged}.${signature}`, 'https://attacker.example/instances']) {
    const result = await a.call('list_instances', { cursor });
    assert.match(result.error, /cursor/);
    noPrivate(result);
  }
  const foreign = await b.call('list_instances', { cursor: page.next_cursor });
  assert.match(foreign.error, /cursor/);
  assert.equal(tenant.requests.length, count);
});

test('named reads return allowlisted identities only and reject mismatched or malformed resources', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/7')) return { status: 200, json: instance(7) };
    if (request.path.endsWith('/8')) return { status: 200, json: instance(9) };
    return { status: 200, json: { ...instance(10), element: { name: { token: TOKEN } } } };
  });
  const { call } = await connect(t, tenant);
  const row = await call('get_instance', { instance_id: 7 });
  assert.deepEqual(row, { id: 7, name: 'Instance 7', element: { id: 3, key: 'crm', name: 'CRM' } });
  noPrivate(row);
  assert.match((await call('get_instance', { instance_id: 8 })).error, /identity/);
  const malformed = await call('get_instance', { instance_id: 10 });
  assert.match(malformed.error, /schema/);
  noPrivate(malformed);
});

test('incorrect confirmation and invalid route identities produce zero network requests', async t => {
  const tenant = await startFakeTenant(t);
  const { call } = await connect(t, tenant);
  for (const enabled of [true, false]) {
    const result = await call('set_instance_enabled', { instance_id: 7, enabled, confirmation: 'wrong' });
    assert.match(result.error, /confirmation must equal/);
    assert.equal(tenant.requests.length, 0);
  }
  for (const instance_id of ['../instances/enabled', '/7', '7?token=x', 'enabled', 0, -1]) {
    const result = await call('set_instance_enabled', { instance_id, enabled: false, confirmation: 'DISABLE OPEN CONNECTOR INSTANCE 7' });
    assert.ok(result.error);
  }
  assert.equal(tenant.requests.length, 0);
});

test('enable and disable obtain fresh tokens, restrict Element auth to the exact route, and return accepted-unverified', async t => {
  let reads = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') {
      assert.equal(request.path, `${ROOT}/instances/7`);
      assert.equal(request.headers.authorization, AUTH);
      return { status: 200, json: { ...instance(7), token: `${TOKEN}_${++reads}`, enabled: true, healthy: true } };
    }
    assert.equal(request.path, `${ROOT}/instances/enabled`);
    assert.ok(['PUT', 'DELETE'].includes(request.method));
    assert.equal(request.headers.authorization, `${AUTH}, Element ${TOKEN}_${reads}`);
    assert.equal(request.body, '');
    assert.equal(request.headers['content-type'], undefined);
    assert.equal(request.rawQuery, '');
    return { status: request.method === 'PUT' ? 202 : 204, ...(request.method === 'PUT' ? { json: { enabled: true, token: TOKEN, providerData: 'PRIVATE_PROVIDER' } } : {}) };
  });
  const { call } = await connect(t, tenant);
  for (const enabled of [true, false, true]) {
    const response = await call('set_instance_enabled', { instance_id: 7, enabled, confirmation: `${enabled ? 'ENABLE' : 'DISABLE'} OPEN CONNECTOR INSTANCE 7` });
    assert.deepEqual(response, { instance_id: 7, requested_enabled: enabled, accepted: true, http_status: enabled ? 202 : 204, effective_state: 'unverified', provider_health: 'unverified' });
    noPrivate(response);
  }
  assert.equal(reads, 3);
  assert.deepEqual(tenant.requests.map(row => row.method), ['GET', 'PUT', 'GET', 'DELETE', 'GET', 'PUT']);
  assert.equal(tenant.requests.some(row => row.method === 'DELETE' && row.path.endsWith('/7')), false);
});

test('tenant rejection and missing private tokens never claim success or leak error bodies', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') return { status: 200, json: request.path.endsWith('/8') ? { ...instance(8), token: null } : instance(7) };
    return { status: 403, json: { error: `${AUTH}, Element ${TOKEN}`, configuration: 'PRIVATE_CONFIG' } };
  });
  const { call } = await connect(t, tenant);
  const rejected = await call('set_instance_enabled', { instance_id: 7, enabled: false, confirmation: 'DISABLE OPEN CONNECTOR INSTANCE 7' });
  assert.match(rejected.error, /HTTP 403/);
  assert.equal(rejected.accepted, undefined);
  noPrivate(rejected);
  const missing = await call('set_instance_enabled', { instance_id: 8, enabled: true, confirmation: 'ENABLE OPEN CONNECTOR INSTANCE 8' });
  assert.match(missing.error, /no usable private token/);
  noPrivate(missing);
  assert.deepEqual(tenant.requests.map(row => row.method), ['GET', 'DELETE', 'GET']);
});

test('output-limited safe metadata resumes without losing identities or repeating remote reads', async t => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    ...instance(index + 1), name: 'n'.repeat(512), element: { id: 3, key: 'k'.repeat(512), name: 'e'.repeat(512) }
  }));
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: rows }));
  const { call } = await connect(t, tenant);
  const ids = [];
  let cursor;
  let limited = false;
  do {
    const page = await call('list_instances', { top: 200, ...(cursor ? { cursor } : {}) });
    assert.equal(page.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 95 * 1024);
    noPrivate(page);
    ids.push(...page.items.map(row => row.id));
    limited ||= page.stop_reason === 'output_limit';
    cursor = page.next_cursor;
    if (!cursor) assert.equal(page.complete, true);
    assert.ok(ids.length <= 200);
  } while (cursor);
  assert.equal(limited, true);
  assert.deepEqual(ids, Array.from({ length: 200 }, (_, index) => index + 1));
  assert.equal(tenant.requests.length, 1);
});

test('ambiguous pagination headers and credential-shaped error bodies are withheld', async t => {
  const tenant = await startFakeTenant(t, request => request.path.endsWith('/7')
    ? { status: 401, body: `${AUTH}, Element ${TOKEN}` }
    : { status: 200, json: [instance(1)], headers: { nextPage: 'another-private-page', 'elements-next-page-token': NEXT } });
  const { call } = await connect(t, tenant);
  const ambiguous = await call('list_instances');
  assert.match(ambiguous.error, /pagination metadata is invalid/);
  noPrivate(ambiguous);
  const denied = await call('get_instance', { instance_id: 7 });
  assert.match(denied.error, /HTTP 401/);
  noPrivate(denied);
  assert.equal(tenant.requests.length, 2);
});
