import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function connect(t, env) {
  const runtime = createIntegrationServer({ env });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'context-test', version: '1' });
  await runtime.server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  return { runtime, call };
}

test('runtime report labels and tenant bindings cannot switch after server construction', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { __count: '0', results: [] } } }));
  const env = { XDG_CONFIG_HOME: '/nonexistent/context-test', CPI_SERVICE_KEY: tenant.serviceKey(), INTEGRATION_ENVIRONMENT: 'quality', ANS_CONFIG: '{invalid-private-value' };
  const { runtime, call } = await connect(t, env);
  env.INTEGRATION_ENVIRONMENT = 'production';
  env.CPI_SERVICE_KEY = JSON.stringify({ oauth: { url: 'https://different.example', tokenurl: 'https://different.example/oauth/token', clientid: 'x', clientsecret: 'private' } });
  const info = await call('integration_connection_info');
  assert.equal(tenant.requests.length, 0);
  assert.equal(info.environment, 'quality');
  assert.equal(info.cpi.host, new URL(tenant.url).host);
  assert.equal(info.common_subaccount, 'unverified');
  for (const name of ['cpi', 'apim', 'devhub', 'ans', 'ctms', 'event_mesh', 'aem', 'aem_semp', 'open_connectors', 'edge', 'cloud_alm', 'tpm']) assert.ok(info.capabilities[name]);
  assert.equal(info.ans.configured, false);
  assert.ok(info.optional_config_errors.some(error => error.component === 'ans'));
  assert.equal(JSON.stringify(info).includes('invalid-private-value'), false);
  const packages = await call('cpi_list_packages');
  assert.equal(packages.environment, 'quality');
  assert.equal(packages.complete, true);
  assert.equal(runtime.connectionSummary.environment, 'quality');
  assert.equal(tenant.tokenRequests().length, 1);
});

test('optional-only configuration exposes its access/catalog without inventing configured core access', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { results: [], metadata: { page: 0, pageSize: 1, totalPages: 0, totalResultsCount: 0 } } }));
  const { call } = await connect(t, { XDG_CONFIG_HOME: '/nonexistent/context-test', ANS_CONFIG: JSON.stringify({ url: tenant.url, username: 'technical', password: 'private-ans' }) });
  const info = await call('integration_connection_info', { verify: true });
  assert.equal(info.verification.ok, false);
  assert.equal(info.verification.ans.configured, true);
  assert.equal(info.verification.ans.result, 'ok');
  assert.equal(info.verification.cpi.configured, false);
  assert.equal(info.capabilities.ans.entitlement, 'unknown');
  assert.equal(JSON.stringify(info).includes('private-ans'), false);
  assert.ok(tenant.requests.every(request => request.method === 'GET'));
});
