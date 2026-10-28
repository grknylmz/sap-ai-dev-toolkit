import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function fixture(t) {
  const state = { total: 2, failed: 0, retry: 0, overdue: 0, runtime: 'STARTED', active: 'true', expired: false, forbidden: false, unknownFlag: false };
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/MessageProcessingLogs/$count')) {
      const status = /Status eq '([^']+)'/.exec(request.query.get('$filter'))?.[1];
      return { status: 200, body: String(status === undefined ? state.total : status === 'FAILED' ? state.failed : status === 'RETRY' ? state.retry : status === 'COMPLETED' ? state.total - state.failed - state.retry : 0) };
    }
    if (request.path.endsWith('/IntegrationRuntimeArtifacts')) return { status: 200, json: { d: { __count: '1', results: [{ Id: 'ZFlow', Version: '1.0.0', Status: state.runtime }] } } };
    if (request.path.endsWith('/DataStores')) return { status: 200, json: { d: { results: [{ DataStoreName: 'Global', IntegrationFlow: '', Type: '', NumberOfMessages: 100, NumberOfOverdueMessages: state.overdue }] } } };
    if (request.path.endsWith('/Queues')) return { status: 200, json: { d: { results: [{ Name: 'Q', State: '0', NumbOfMsgs: '42', Active: state.active, Exclusive: false }] } } };
    if (request.path.includes('/JmsBrokers(')) {
      const expand = request.query.get('$expand');
      return { status: 200, json: { d: { CapacityWarning: '0', CapacityError: '0', IsQueuesHigh: state.unknownFlag ? 'unrecognized' : '0', IsMessageSpoolHigh: '0', IsTransactedSessionsHigh: '0', IsConsumersHigh: '0', IsProducersHigh: '0', [expand]: { results: [] } } } };
    }
    if (request.path.endsWith('/KeystoreEntries')) return state.forbidden ? { status: 403, body: 'secret-private-error' } : { status: 200, json: { d: { results: [{ Alias: 'Receiver', Type: 'Certificate', ValidNotBefore: '2020-01-01T00:00:00Z', ValidNotAfter: state.expired ? '2021-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', SubjectDN: 'personal-private' }] } } };
    return { status: 404 };
  });
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/operations-test', CPI_SERVICE_KEY: tenant.serviceKey() }, pollIntervalMs: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'operations-test', version: '1' });
  await runtime.server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  const call = async () => {
    const response = await client.callTool({ name: 'cpi_get_operational_summary', arguments: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z', iflow_ids: ['ZFlow'] } });
    assert.notEqual(response.isError, true, response.content[0].text);
    assert.doesNotMatch(response.content[0].text, /personal-private|secret-private/);
    return JSON.parse(response.content[0].text);
  };
  return { state, tenant, call };
}

test('operational health distinguishes no issues, no traffic, inaccessible and degraded evidence', async t => {
  const { state, tenant, call } = await fixture(t);
  assert.equal((await call()).health, 'no_issues_observed', 'ordinary positive queue depth is not degraded');
  state.total = 0;
  assert.equal((await call()).health, 'unknown', 'no traffic is not healthy');
  state.total = 2; state.forbidden = true;
  const inaccessible = await call();
  assert.equal(inaccessible.health, 'unknown');
  assert.equal(inaccessible.sources.certificates.result, 'forbidden');
  state.failed = 1;
  const partial = await call();
  assert.equal(partial.health, 'degraded', 'observed failure wins over inaccessible independent source');
  assert.equal(partial.health_scope, 'observed_management_signals');
  assert.equal(partial.continuous_monitoring, 'unverified');
  assert.equal(tenant.apiRequests().every(request => request.method === 'GET' && !request.path.includes('$value')), true);
});

test('operational summary retains distinct retry, store, stopped queue, certificate and unknown flag signals', async t => {
  const { state, call } = await fixture(t);
  state.retry = 1; state.overdue = 7; state.active = 'false'; state.expired = true;
  const report = await call();
  assert.equal(report.health, 'degraded');
  assert.equal(report.counts.overdue_messages, 7);
  assert.equal(report.counts.queues_stopped, 1);
  assert.equal(report.counts.certificates_expired, 1);
  assert.ok(report.findings.some(item => item.kind === 'message_status' && item.status === 'RETRY'));
  state.retry = 0; state.overdue = 0; state.active = 'true'; state.expired = false; state.unknownFlag = true;
  assert.equal((await call()).health, 'unknown', 'unrecognized resource flags do not become healthy');
});
