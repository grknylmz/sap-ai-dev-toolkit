import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: {
    XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-diagnostic-test', CPI_SERVICE_KEY: tenant.serviceKey()
  } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'diagnostic-edge-test', version: '1.0.0' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close().catch(() => {}); await runtime.close(); });
  return client;
}
async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content[0].text;
  return { isError: response.isError === true, text, data: response.isError ? null : JSON.parse(text) };
}
const guid = 'MPL_REQUESTED_01';
const path = `/api/v1/MessageProcessingLogs('${guid}')`;

test('public MPL read bounds Unicode diagnostics, strips credentials and never reads payloads', async t => {
  const secret = 'private-diagnostic-credential';
  const tenant = await startFakeTenant(t, request => {
    if (request.path === path) return { status: 200, json: { d: {
      MessageGuid: guid, Status: 'NEW_PLATFORM_STATUS', Sender: `https://user:${secret}@backend.example/receiver?token=${secret}#fragment`,
      Payload: secret, PrivateKey: secret
    } } };
    if (request.path === `${path}/ErrorInformation/$value`) return { status: 200,
      body: `password=${secret} at https://user:${secret}@backend.example/receiver?token=${secret}#fragment ${'\u{1D11E}'.repeat(6000)}` };
    if (request.path === `${path}/CustomHeaderProperties`) return { status: 200, json: { d: { results: [
      { Name: 'Authorization', Value: `Bearer ${secret}` }, { Name: 'X-API-Key', Value: secret }, { Name: 'team', Value: 'operations' }
    ] } } };
    return { status: 404 };
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_get_message_log', { message_guid: guid });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.data.log.Status, 'NEW_PLATFORM_STATUS');
  assert.equal(result.data.log.Sender, 'https://backend.example/receiver');
  assert.equal(result.data.error_information_truncated, true);
  assert.ok(Buffer.byteLength(result.data.error_information) <= 16 * 1024);
  assert.equal(result.data.error_information.includes('\uFFFD'), false);
  assert.equal(result.text.includes(secret), false);
  assert.equal(result.data.custom_header_properties.find(row => row.Name === 'Authorization').Value, '[redacted]');
  assert.equal(result.data.custom_header_properties.find(row => row.Name === 'X-API-Key').Value, '[redacted]');
  assert.equal(result.data.custom_header_properties.find(row => row.Name === 'team').Value, 'operations');
  assert.deepEqual(tenant.apiRequests().map(request => `${request.method} ${request.path}`), [
    `GET ${path}`, `GET ${path}/ErrorInformation/$value`, `GET ${path}/CustomHeaderProperties`
  ]);
});

test('foreign or missing named MPL identity stops before diagnostic and correlation reads', async t => {
  let identity = 'MPL_UNRELATED_02';
  const tenant = await startFakeTenant(t, request => request.path === path
    ? { status: 200, json: { d: { MessageGuid: identity, Status: 'COMPLETED', CorrelationId: 'unrelated-correlation' } } }
    : { status: 200, json: { d: { results: [] } } });
  const client = await connect(t, tenant);
  for (const value of [identity, undefined]) {
    identity = value;
    const result = await call(client, 'cpi_get_message_log', { message_guid: guid });
    assert.equal(result.isError, true);
  }
  assert.equal(tenant.apiRequests().length, 2);
  assert.ok(tenant.apiRequests().every(request => request.path === path));
});

test('public certificate pages retain expired and unknown evidence and bind evaluation and keystore', async t => {
  const secret = 'private-certificate-content';
  const tenant = await startFakeTenant(t, request => request.path === '/api/v1/KeystoreEntries'
    ? { status: 200, json: { d: { results: [
      { Alias: 'expired', ValidNotBefore: '1970-01-01T00:00:00Z', ValidNotAfter: '1970-01-02T00:00:00Z', PrivateKey: secret },
      { Alias: 'unknown', ValidNotBefore: 'not-a-date', ValidNotAfter: null, Certificate: secret },
      { Alias: 'future', ValidNotBefore: '2099-01-01T00:00:00Z', ValidNotAfter: '2100-01-01T00:00:00Z', Certificate: secret }
    ] } } }
    : { status: 404 });
  const client = await connect(t, tenant);
  const first = await call(client, 'cpi_get_certificate_health', { top: 1, warning_days: 30 });
  assert.equal(first.isError, false, first.text);
  assert.equal(first.data.items[0].validity, 'expired');
  assert.equal(first.data.complete, false);
  const second = await call(client, 'cpi_get_certificate_health', { top: 2, warning_days: 30, cursor: first.data.next_cursor });
  assert.equal(second.isError, false, second.text);
  assert.deepEqual(second.data.items.map(row => row.validity), ['unknown', 'not_yet_valid']);
  assert.equal(second.data.items[0].days_remaining, null);
  assert.equal(second.data.items[0].ValidNotBefore, null);
  assert.equal(second.data.evaluated_at, first.data.evaluated_at);
  assert.equal(second.data.complete, true);
  assert.equal(first.text.includes(secret) || second.text.includes(secret), false);
  const requests = tenant.apiRequests().length;
  const changed = await call(client, 'cpi_get_certificate_health', { top: 1, keystore: 'KeyRenewal', cursor: first.data.next_cursor });
  assert.equal(changed.isError, true);
  assert.equal(tenant.apiRequests().length, requests);
  assert.ok(tenant.apiRequests().every(request => request.query.get('keystoreName') === 'system'));
});
