import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerEdgeMonitoringTools } from '../src/edge-monitoring.mjs';
import { registerCpiMonitoringTools } from '../src/cpi-monitoring.mjs';
import { createOptionalClients } from '../src/integration-optional-tools.mjs';
import { resultOf } from '../src/integration-common.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const FROM = '2026-10-27T09:00:00.123Z';
const TO = '2026-10-28T09:00:00.456Z';
const GUID = 'edgeMessage0001';
const LOCAL = '/local/api/v1/MessageProcessingLogs';
const metadata = inner => `<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><edm:Schema xmlns:edm="http://docs.oasis-open.org/odata/ns/edm" Namespace="Edge.Operations"><edm:EntityContainer Name="Operations">${inner}</edm:EntityContainer></edm:Schema></edmx:DataServices></edmx:Edmx>`;

async function connect(t, tenant, { cpi = false } = {}) {
  const service = createOptionalClients({ edge: { url: tenant.url, clientId: 'edge-client', clientSecret: 'edge-private' } }, { env: {} }).edge;
  const server = new McpServer({ name: 'edge-fixture', version: '1.0.0' });
  const register = (name, title, description, inputSchema, annotations, handler) => server.registerTool(name, { title, description, inputSchema, annotations }, args => resultOf(() => handler(args)));
  registerEdgeMonitoringTools(register, service);
  if (cpi) registerCpiMonitoringTools(register, service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'edge-behavior', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
async function call(client, name, args = {}) {
  const reply = await client.callTool({ name, arguments: args });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  return JSON.parse(reply.content[0].text);
}
async function failure(client, name, args = {}) {
  const reply = await client.callTool({ name, arguments: args });
  assert.equal(reply.isError, true);
  return reply.content[0].text;
}
const mplRow = (id, extra = {}) => ({ MessageGuid: `edgeMessage${String(id).padStart(4, '0')}`, LogStart: FROM, Status: 'OBSERVED_FUTURE_STATUS', ...extra });

// Name discovery must not touch credentials or require a constructed client.
test('Edge registrar constructs with null and exposes only local discovery and MPL reads', () => {
  const names = [];
  registerEdgeMonitoringTools(name => names.push(name), null);
  assert.deepEqual(names, ['edge_get_api_metadata', 'edge_list_message_logs', 'edge_get_message_log']);
});

test('Edge metadata uses local Basic authority and returns names, not fields, annotations, functions or source', async t => {
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, '/local/api/eic/v1/$metadata');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('edge-client:edge-private').toString('base64')}`);
    return { status: 200, body: metadata(`
      <!-- <EntitySet Name="CommentSpoof" EntityType="Secret.Token"/> -->
      <edm:EntitySet Name="Components" EntityType="Edge.Operations.Component"><edm:Annotation String="schema-private"/></edm:EntitySet>
      <edm:EntitySet Name="Jobs" EntityType="Edge.Operations.Job"/>
      <edm:EntitySet Name="FutureDiscovery" EntityType="Edge.Operations.Future"/>
      <edm:FunctionImport Name="Restart" Function="Edge.Restart"/>
      <edm:Annotation String="password=private-annotation"/>
    `) };
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'edge_get_api_metadata');
  assert.deepEqual(result.schemas, ['Edge.Operations']);
  assert.deepEqual(result.entity_sets, [
    { name: 'Components', entity_type: 'Edge.Operations.Component' },
    { name: 'Jobs', entity_type: 'Edge.Operations.Job' },
    { name: 'FutureDiscovery', entity_type: 'Edge.Operations.Future' }
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.operational_field_contract, 'not_established');
  assert.ok(result.published_routes.includes('/local/api/eic/v1/Components/<component ID>/Pods/<pod name>/Metrics'));
  assert.ok(result.published_routes.includes('/local/api/eic/v1/Jobs/<jobId>/Schedule'));
  assert.ok(result.native_handoff.steps.some(step => step.includes('Operations Cockpit')));
  const output = JSON.stringify(result);
  for (const privateValue of ['schema-private', 'private-annotation', 'CommentSpoof', 'Edge.Restart', 'edmx:', 'clientSecret', 'edge-private']) assert.equal(output.includes(privateValue), false);
  assert.equal(tenant.tokenRequests().length, 0);
  assert.equal(tenant.requests.length, 1);
  // Metadata discovery does not register an arbitrary component/pod/job route reader.
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['edge_get_api_metadata', 'edge_get_message_log', 'edge_list_message_logs']);
});

test('Edge metadata remains bounded and malformed or schema-object responses never leak bodies', async t => {
  let body = metadata(Array.from({ length: 1500 }, (_, index) => `<edm:EntitySet Name="Entity${index}" EntityType="Edge.Operations.Entity${index}"/>`).join(''));
  const tenant = await startFakeTenant(t, () => ({ status: 200, body }));
  const client = await connect(t, tenant);
  const result = await call(client, 'edge_get_api_metadata');
  assert.equal(result.complete, false);
  assert.equal(result.stop_reason, 'source_limit');
  assert.ok(result.entity_sets.length > 0 && result.entity_sets.length < 1500);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) < 95 * 1024);
  for (const invalid of ['{"schemas":{"token":"schema-object-private"}}', '<edmx:Edmx><unexpected-private-tag></edmx:Edmx>', '<!DOCTYPE x [<!ENTITY secret "schema-private">]><Edmx/>']) {
    body = invalid;
    const text = await failure(client, 'edge_get_api_metadata');
    assert.match(text, /not a supported OData metadata document/);
    assert.equal(text.includes('private'), false);
    assert.equal(text.includes(invalid), false);
  }
});

test('Edge MPL reuses exact CPI filter, milliseconds, escaping, unknown statuses and best-effort paging', async t => {
  const fixtures = [
    mplRow(1, { LogStart: FROM, IntegrationArtifact: { Id: 'FlowA', Type: 'INTEGRATION_FLOW', Token: 'artifact-private' }, Payload: 'body-private', Attachments: [{ Value: 'attachment-private' }] }),
    mplRow(2, { LogStart: '2026-10-27T10:00:00.000Z', Status: 'PROCESSING', ApplicationMessageId: 'business-id' }),
    mplRow(3, { LogStart: TO })
  ];
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, LOCAL);
    assert.match(request.query.get('$filter'), /LogStart ge datetime'2026-10-27T09:00:00.123' and LogStart lt datetime'2026-10-28T09:00:00.456'/);
    const filtered = fixtures.filter(row => row.LogStart >= FROM && row.LogStart < TO);
    const skip = Number(request.query.get('$skip') ?? 0);
    return { status: 200, json: { d: { __count: String(filtered.length), results: filtered.slice(skip, skip + Number(request.query.get('$top'))) } } };
  });
  const client = await connect(t, tenant);
  const args = { from: FROM, to: TO, top: 1, iflow_id: 'FlowA', correlation_id: "corr'one", application_message_id: "app'one", custom_header: { name: "business'key", value: "value'one" } };
  const first = await call(client, 'edge_list_message_logs', args);
  assert.equal(first.total, 2);
  assert.equal(first.complete, false);
  assert.equal(first.consistency, 'best_effort');
  assert.equal(first.items[0].Status, 'OBSERVED_FUTURE_STATUS');
  assert.deepEqual(first.items[0].IntegrationArtifact, { Id: 'FlowA', Type: 'INTEGRATION_FLOW' });
  assert.deepEqual(first.window, { from: FROM, to: TO });
  const query = tenant.apiRequests()[0].query;
  assert.equal(query.get('$orderby'), 'LogStart desc');
  assert.equal(query.get('filterCustomHeaderProperties'), "'business''key' eq 'value''one'");
  assert.ok(query.get('$filter').includes("IntegrationArtifact/Id eq 'FlowA' and CorrelationId eq 'corr''one' and ApplicationMessageId eq 'app''one'"));
  const second = await call(client, 'edge_list_message_logs', { ...args, cursor: first.next_cursor });
  assert.equal(second.complete, true);
  assert.equal(second.items[0].Status, 'PROCESSING');
  assert.equal(Object.hasOwn(second.items[0], 'LogEnd'), false);
  assert.deepEqual([...first.items, ...second.items].map(row => row.MessageGuid), fixtures.slice(0, 2).map(row => row.MessageGuid));
  for (const secret of ['body-private', 'attachment-private', 'artifact-private']) assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(tenant.tokenRequests().length, 0);
});

test('Edge cursors freeze defaults and reject changed filters, windows, tampering and cloud-root reuse before HTTP', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { __count: '3', results: [mplRow(1), mplRow(2), mplRow(3)] } } }));
  const client = await connect(t, tenant, { cpi: true });
  const frozenNow = Date.parse(TO);
  t.mock.method(Date, 'now', () => frozenNow);
  const first = await call(client, 'edge_list_message_logs', { top: 1, status: 'FAILED' });
  t.mock.method(Date, 'now', () => frozenNow + 120000);
  const second = await call(client, 'edge_list_message_logs', { top: 1, status: 'FAILED', cursor: first.next_cursor });
  assert.deepEqual(second.window, first.window);
  const before = tenant.requests.length;
  for (const args of [
    { top: 1, status: 'COMPLETED', cursor: first.next_cursor },
    { top: 1, status: 'FAILED', from: FROM, to: TO, cursor: first.next_cursor },
    { top: 1, status: 'FAILED', cursor: `${first.next_cursor.slice(0, -2)}xx` }
  ]) assert.match(await failure(client, 'edge_list_message_logs', args), /cursor|window/i);
  assert.match(await failure(client, 'cpi_list_message_logs', { top: 1, status: 'FAILED', cursor: first.next_cursor }), /cursor/i);
  assert.equal(tenant.requests.length, before);
  for (const args of [{ from: FROM }, { from: TO, to: FROM }, { from: '2026-01-01T00:00:00Z', to: TO }]) await failure(client, 'edge_list_message_logs', args);
  assert.equal(tenant.requests.length, before);
  t.mock.method(Date, 'now', () => frozenNow + 16 * 60 * 1000);
  assert.match(await failure(client, 'edge_list_message_logs', { top: 1, status: 'FAILED', cursor: first.next_cursor }), /expired/i);
  assert.equal(tenant.requests.length, before);
});

test('Edge named MPL uses shared bounded diagnostic and header projections without attachments', async t => {
  const tenant = await startFakeTenant(t, request => {
    assert.ok(request.path.startsWith(LOCAL));
    if (request.path.endsWith('/ErrorInformation/$value')) return { status: 200, body: `password=diagnostic-private at https://user:pass@example.com/receiver?token=query-private ${'x'.repeat(17000)}` };
    if (request.path.endsWith('/CustomHeaderProperties')) return { status: 200, json: { d: { __count: '4', results: [
      { Name: 'client_secret', Value: 'header-private', Payload: 'payload-private' }, { Name: 'business-id', Value: 'safe-id' },
      { Name: 'Authorization', Value: 'Bearer authorization-private' }, { Name: 'Cookie', Value: 'session=cookie-private' }
    ] } } };
    return { status: 200, json: { d: mplRow(1, { MessageGuid: GUID, Sender: 'https://user:pass@example.com/send?secret=sender-private', Payload: 'payload-private', Token: 'message-private' }) } };
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'edge_get_message_log', { message_guid: GUID });
  assert.equal(result.log.MessageGuid, GUID);
  assert.equal(result.log.Sender, 'https://example.com/send');
  assert.equal(result.error_information_truncated, true);
  assert.ok(result.error_information.length <= 16 * 1024);
  assert.equal(result.custom_header_properties[0].Value, '[redacted]');
  assert.equal(result.custom_header_properties[1].Value, 'safe-id');
  assert.equal(result.custom_header_properties[2].Value, '[redacted]');
  assert.equal(result.custom_header_properties[3].Value, '[redacted]');
  const text = JSON.stringify(result);
  for (const secret of ['diagnostic-private', 'query-private', 'sender-private', 'header-private', 'payload-private', 'message-private', 'authorization-private', 'cookie-private', 'user:pass']) assert.equal(text.includes(secret), false);
  assert.equal(tenant.requests.length, 3);
  assert.equal(tenant.requests.every(request => request.method === 'GET' && request.path.startsWith('/local/') && !/Attachments|\$metadata/.test(request.path)), true);
  assert.equal(tenant.requests.every(request => request.headers.authorization === `Basic ${Buffer.from('edge-client:edge-private').toString('base64')}`), true);
});

test('Edge denied reads retain HTTP/access evidence, never tenant bodies or no-traffic/healthy success', async t => {
  let denied = 401;
  let deniedPath = 'all';
  const tenant = await startFakeTenant(t, request => {
    if (deniedPath === 'headers' && !request.path.endsWith('/CustomHeaderProperties')) return request.path.endsWith('/ErrorInformation/$value') ? { status: 204 } : { status: 200, json: { d: mplRow(1) } };
    return { status: denied, body: 'token=tenant-private <schema>schema-private</schema>' };
  });
  const client = await connect(t, tenant);
  for (const status of [401, 403, 404]) {
    denied = status;
    for (const [name, args] of [['edge_get_api_metadata', {}], ['edge_list_message_logs', { from: FROM, to: TO }], ['edge_get_message_log', { message_guid: GUID }]]) {
      const text = await failure(client, name, args);
      assert.match(text, new RegExp(`HTTP ${status}`));
      assert.match(text, /entitlement remain unknown/);
      assert.equal(text.includes('tenant-private'), false);
      assert.equal(text.includes('schema-private'), false);
      if (status === 401) assert.match(text, /missing \/local/);
      if (status === 403) assert.match(text, /unsupported local endpoint/);
    }
  }
  denied = 403;
  deniedPath = 'headers';
  const partial = await failure(client, 'edge_get_message_log', { message_guid: GUID });
  assert.match(partial, /HTTP 403/);
  assert.equal(tenant.tokenRequests().length, 0);
});

test('Edge changing MPL evidence is partial, and off-local continuations never authorize cloud reads', async t => {
  let mode = 'drift';
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.path, LOCAL);
    const skip = Number(request.query.get('$skip') ?? 0);
    if (mode === 'foreign') return { status: 200, json: { d: { __count: '3', results: [mplRow(1)], __next: `${tenant.url}/api/v1/MessageProcessingLogs?$skip=1` } } };
    return { status: 200, json: { d: { __count: skip ? '4' : '3', results: skip ? [mplRow(1), mplRow(3)] : [mplRow(1), mplRow(2)] } } };
  });
  const client = await connect(t, tenant);
  const args = { from: FROM, to: TO, top: 1 };
  const first = await call(client, 'edge_list_message_logs', args);
  const changed = await call(client, 'edge_list_message_logs', { ...args, cursor: first.next_cursor });
  assert.equal(changed.complete, false);
  assert.equal(changed.stop_reason, 'source_changed');
  assert.equal(changed.next_cursor, null);
  assert.equal(changed.items[0].MessageGuid, first.items[0].MessageGuid);
  assert.equal(changed.total, 4);
  for (const unsupportedClaim of ['health', 'failure_rate', 'entitlement', 'no_traffic']) assert.equal(Object.hasOwn(changed, unsupportedClaim), false);
  mode = 'foreign';
  const before = tenant.requests.length;
  assert.match(await failure(client, 'edge_list_message_logs', args), /continuation/);
  assert.equal(tenant.requests.length, before + 1);
  assert.equal(tenant.requests.every(request => request.path === LOCAL), true);
});
