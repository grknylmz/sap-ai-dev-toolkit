import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { monitoringReadiness, registerMonitoringReadinessTools, registerIntegrationAnalysisTools } from '../src/integration-analysis.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const SECRET = 'readiness-private-secret';
const EVENTS = ['TmsImportStarted', 'TmsImportFinished', 'TmsTransportRequestAdded', 'TmsNodeImportJobDeactivated', 'TmsStorageQuotaUsage'];
const ROOT = '/cf/configuration/v1/';

async function connect(t, env) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/integration-monitoring-readiness', INTEGRATION_ENVIRONMENT: 'monitoring-fixture', ...env } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'monitoring-readiness-test', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close().catch(() => {}); await runtime.close(); });
  return client;
}
async function readiness(client, args = {}) {
  const response = await client.callTool({ name: 'integration_monitoring_readiness', arguments: args });
  assert.notEqual(response.isError, true, response.content[0].text);
  return JSON.parse(response.content[0].text);
}
function ctmsConfig(url) {
  return JSON.stringify({ uri: url, uaa: { url, clientid: 'ctms-reader', clientsecret: SECRET } });
}
function ansConfig(url) { return JSON.stringify({ url, username: 'ans-reader', password: SECRET }); }
function rules() {
  return {
    subscription: [{ name: 'TransportChanges', state: 'ENABLED', conditions: ['Node', ...EVENTS], actions: ['Mail'] }],
    condition: [{ name: 'Node', propertyKey: 'tags.nodeName', predicate: 'EQUALS', propertyValue: 'CIDev' },
      ...EVENTS.map(event => ({ name: event, propertyKey: 'eventType', predicate: 'EQUALS', propertyValue: event }))],
    action: [{ name: 'Mail', state: 'ENABLED', type: 'EMAIL', properties: { recipients: 'private-person@example.test', password: SECRET } }]
  };
}
function fixture(data = rules(), override = () => null) {
  return request => {
    const overridden = override(request);
    if (overridden) return overridden;
    if (request.path.startsWith(ROOT)) {
      const [kind, encodedName] = request.path.slice(ROOT.length).split('/');
      const rows = data[kind] ?? [];
      if (encodedName !== undefined) {
        const item = rows.find(row => row.name === decodeURIComponent(encodedName));
        return item ? { status: 200, json: item } : { status: 404, body: SECRET };
      }
      const page = Number(request.query.get('page') ?? 0);
      const pageSize = Number(request.query.get('pageSize') ?? 100);
      return { status: 200, json: { results: rows.slice(page * pageSize, (page + 1) * pageSize),
        metadata: { page, pageSize, totalPages: Math.ceil(rows.length / pageSize), totalResultsCount: rows.length } } };
    }
    if (request.path === '/v2/nodes') return { status: 200, json: { nodes: [{ name: 'CIDev', id: 1, private: SECRET }] } };
    if (request.path.endsWith('/$count')) return { status: 200, body: '0' };
    if (request.path === '/api/v1/KeystoreEntries') return { status: 200, json: { d: { results: [{ Alias: 'Cert', ValidNotBefore: '2025-01-01T00:00:00Z', ValidNotAfter: '2030-01-01T00:00:00Z', SubjectDN: 'private-person@example.test' }] } } };
    return { status: 200, json: { d: { results: [] } } };
  };
}
function assertReadOnly(tenant) {
  assert.ok(tenant.requests.every(request => request.method === 'GET' || request.method === 'POST' && request.path === '/oauth/token'));
  assert.equal(tenant.requests.some(request => /(?:service_instances|service_keys|destinations|deploy|Validate|SaveAsVersion)/i.test(request.path)), false);
}
function assertPrivate(result) {
  const text = JSON.stringify(result);
  for (const value of [SECRET, 'private-person@example.test']) assert.equal(text.includes(value), false, value);
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, entry] of Object.entries(value)) {
      assert.equal(['properties', 'recipients', 'SubjectDN', 'access_token'].includes(name), false, name);
      inspect(entry);
    }
  };
  inspect(result);
}

test('accessible CPI APIs remain unverified continuous monitoring with administrator ALM handoff', async t => {
  const tenant = await startFakeTenant(t, fixture());
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(SECRET) });
  const result = await readiness(client);
  assert.equal(result.environment, 'monitoring-fixture');
  assert.equal(result.hosts.cpi, new URL(tenant.url).host);
  assert.ok(Number.isFinite(Date.parse(result.evaluated_at)));
  assert.equal(result.readiness, 'needs_admin_confirmation');
  assert.equal(result.continuous_monitoring, 'unverified');
  assert.equal(result.collection, 'needs_admin_confirmation');
  assert.equal(result.delivery, 'needs_admin_confirmation');
  assert.equal(result.complete, false);
  assert.equal(result.evidence_complete, true);
  assert.deepEqual(result.items.map(item => item.component), ['cpi']);
  const cpi = result.items[0];
  assert.ok(cpi.sources.every(source => source.result === 'ok' && source.method === 'GET'));
  assert.deepEqual(cpi.monitoring_permissions, ['MonitoringDataRead', 'MonitoringArtifactsDeploy', 'HealthCheckMonitoringDataRead']);
  assert.equal(cpi.permission_effect, 'setup_requirements_only_no_grants');
  assert.ok(cpi.native_handoff[0].steps.some(step => step.includes('Landscape Management')));
  assert.ok(cpi.native_handoff[0].steps.some(step => step.includes('Integration & Exception Monitoring')));
  assert.ok(cpi.native_handoff[0].steps.some(step => step.includes('Health Monitoring')));
  assertPrivate(result);
  assertReadOnly(tenant);
});

for (const [status, expected] of [[403, 'forbidden'], [404, 'unavailable']]) {
  test(`required monitoring source HTTP ${status} blocks without hiding healthy source evidence`, async t => {
    const tenant = await startFakeTenant(t, fixture(undefined, request => request.path === '/api/v1/Queues' ? { status, body: SECRET } : null));
    const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(SECRET) });
    const result = await readiness(client, { components: ['cpi'] });
    assert.equal(result.readiness, 'blocked');
    assert.equal(result.evidence_complete, false);
    const sources = result.items[0].sources;
    assert.equal(sources.find(source => source.area === 'Queue metadata').result, expected);
    assert.equal(sources.find(source => source.area === 'Message logs').result, 'ok');
    assert.equal(result.items[0].entitlement, 'unknown');
    assertPrivate(result);
    assertReadOnly(tenant);
  });
}

test('unsupported and explicitly unconfigured components are distinct and cannot inherit core success', async t => {
  const tenant = await startFakeTenant(t, fixture());
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(SECRET) });
  const result = await readiness(client, { components: ['cpi', 'ans', 'not_supported', 'constructor'] });
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.items.find(item => item.component === 'cpi').readiness, 'needs_admin_confirmation');
  assert.equal(result.items.find(item => item.component === 'ans').configuration, 'absent');
  assert.ok(result.items.find(item => item.component === 'ans').sources.every(source => source.result === 'unconfigured'));
  for (const component of ['not_supported', 'constructor']) assert.equal(result.items.find(item => item.component === component).configuration, 'unsupported');
  assertReadOnly(tenant);
});

test('configured forbidden ANS stays a default required component despite healthy core access', async t => {
  const tenant = await startFakeTenant(t, fixture(undefined, request => request.path.startsWith(ROOT) ? { status: 403, body: SECRET } : null));
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(SECRET), ANS_CONFIG: ansConfig(tenant.url) });
  const result = await readiness(client);
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.items.find(item => item.component === 'cpi').readiness, 'needs_admin_confirmation');
  assert.equal(result.items.find(item => item.component === 'ans').readiness, 'blocked');
  assert.equal(result.native_rules.complete, false);
  assert.ok(result.native_rules.findings.length);
  assertPrivate(result);
  assertReadOnly(tenant);
});

test('cTMS requires separately configured ANS even when node management reads succeed', async t => {
  const tenant = await startFakeTenant(t, fixture());
  const client = await connect(t, { CTMS_SERVICE_KEY: ctmsConfig(tenant.url) });
  const result = await readiness(client, { components: ['ctms'], node_names: ['CIDev'] });
  assert.equal(result.readiness, 'blocked');
  const ctms = result.items[0];
  assert.equal(ctms.sources.find(source => source.component === 'ctms').result, 'ok');
  assert.ok(ctms.findings.some(finding => finding.code === 'ans_configuration_required'));
  assert.equal(result.hosts.ctms, new URL(tenant.url).host);
  assertReadOnly(tenant);
});

test('partial ANS rule findings survive cTMS readiness and action properties remain private', async t => {
  const data = rules();
  data.subscription.push({ name: 'Broken', state: 'DISABLED', conditions: ['Missing'], actions: ['Disabled'] });
  data.action.push({ name: 'Disabled', state: 'DISABLED', type: 'EMAIL', properties: { recipients: SECRET } });
  const tenant = await startFakeTenant(t, fixture(data));
  const client = await connect(t, { CTMS_SERVICE_KEY: ctmsConfig(tenant.url), ANS_CONFIG: ansConfig(tenant.url) });
  const result = await readiness(client, { components: ['ctms', 'ans'], node_names: ['CIDev'] });
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.native_rules.outcome, 'blocked');
  assert.ok(result.native_rules.items.some(item => item.name === 'TransportChanges'));
  const broken = result.native_rules.items.find(item => item.name === 'Broken');
  assert.ok(broken.findings.some(finding => finding.code === 'condition_missing'));
  assert.ok(broken.findings.length > 1);
  assert.equal(result.native_rules.delivery, 'needs_admin_confirmation');
  assertPrivate(result);
  assertReadOnly(tenant);
});

test('denied named ANS reference blocks even when all collection probes are readable', async t => {
  const tenant = await startFakeTenant(t, fixture(undefined, request => request.path === `${ROOT}action/Mail` ? { status: 403, body: SECRET } : null));
  const client = await connect(t, { ANS_CONFIG: ansConfig(tenant.url) });
  const result = await readiness(client, { components: ['ans'] });
  assert.ok(result.items[0].sources.every(source => source.result === 'ok'));
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.native_rules.complete, false);
  assert.ok(result.items[0].findings.some(finding => finding.code === 'required_rule_source_unavailable'));
  assert.ok(result.native_rules.items[0].findings.some(finding => finding.source_result?.result === 'forbidden'));
  assertPrivate(result);
  assertReadOnly(tenant);
});

test('intentional cTMS event and node rules still do not prove collection or delivery', async t => {
  const tenant = await startFakeTenant(t, fixture());
  const client = await connect(t, { CTMS_SERVICE_KEY: ctmsConfig(tenant.url), ANS_CONFIG: ansConfig(tenant.url) });
  const result = await readiness(client, { components: ['ctms'], node_names: ['CIDev'] });
  assert.equal(result.readiness, 'needs_admin_confirmation');
  assert.equal(result.continuous_monitoring, 'unverified');
  assert.equal(result.items[0].integration, 'trusted_internal_ans');
  assert.deepEqual(result.items[0].event_types, EVENTS);
  assert.equal(result.items[0].findings.some(finding => finding.code === 'ctms_event_coverage_unconfirmed'), false);
  assert.equal(result.items[0].findings.some(finding => finding.code === 'ctms_node_coverage_unconfirmed'), false);
  assert.equal(result.common_subaccount, 'unverified');
  assert.ok(result.items[0].native_handoff[0].post_action_verification.length);
  assertReadOnly(tenant);
});

test('APIM analytics access is separate from native anomaly-event readiness', async t => {
  const tenant = await startFakeTenant(t, fixture());
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey(SECRET) });
  const result = await readiness(client);
  assert.equal(result.items[0].component, 'apim');
  assert.equal(result.items[0].analytics_polling, 'ok');
  assert.equal(result.items[0].anomaly_events, 'needs_admin_confirmation');
  assert.equal(result.readiness, 'needs_admin_confirmation');
  assert.equal(result.delivery, 'needs_admin_confirmation');
  assertReadOnly(tenant);
});

test('optional-only server registers monitoring readiness without target-core analysis tools', async t => {
  const tenant = await startFakeTenant(t, fixture());
  const client = await connect(t, { ANS_CONFIG: ansConfig(tenant.url) });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('integration_monitoring_readiness'));
  assert.equal(names.includes('integration_check_release_readiness'), false);
  assert.equal(names.includes('integration_inspect_dependencies'), false);
  const result = await readiness(client);
  assert.deepEqual(result.items.map(item => item.component), ['ans']);
  assert.equal(result.continuous_monitoring, 'unverified');
  assertReadOnly(tenant);
});

test('verification callback failure is safe partial source evidence rather than success or leaked exception', async () => {
  const result = await monitoringReadiness({ summary: { cpi: { configured: true, host: 'cpi.example' } }, verify: async () => { throw new Error(SECRET); } }, { components: ['cpi'] });
  assert.equal(result.readiness, 'blocked');
  assert.ok(result.items[0].sources.every(source => source.result === 'error'));
  assertPrivate(result);
});

test('separate registrar preserves the existing dependency and release tool registrations', () => {
  const targetNames = [];
  registerIntegrationAnalysisTools(name => targetNames.push(name));
  assert.deepEqual(targetNames, ['integration_inspect_dependencies', 'integration_check_release_readiness']);
  const monitoringNames = [];
  registerMonitoringReadinessTools(name => monitoringNames.push(name));
  assert.deepEqual(monitoringNames, ['integration_monitoring_readiness']);
});
