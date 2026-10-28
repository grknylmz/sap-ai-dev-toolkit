import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTenant } from './fake-integration-tenant.mjs';
import { createOptionalClients, verifyOptionalClients, OPTIONAL_CLIENT_KEYS } from '../src/integration-optional-tools.mjs';
import { createIntegrationClients, verifyIntegrationClients } from '../src/integration-verify.mjs';
import { resolveIntegrationConfig } from '../src/integration-config.mjs';
import { capabilityCatalog } from '../src/integration-capabilities.mjs';

const SECRET = 'optional-private-secret';
const basic = (user, password = SECRET) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const metadata = '<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"></edmx:Edmx>';

function configs(url) {
  return {
    ctms: { url: `${url}/transport`, tokenUrl: `${url}/oauth/token`, clientId: 'transport-client', clientSecret: SECRET },
    ans: { url, username: 'alerts-user', password: SECRET },
    event_mesh: { url, tokenUrl: `${url}/binding/exact-token`, clientId: 'mesh-client', clientSecret: SECRET, probeQueueName: 'namespace/orders/incoming' },
    aem: { apiToken: SECRET },
    aem_semp: { url, msgVpnName: 'vpn/one', username: 'vpn-reader', password: SECRET },
    open_connectors: { url: `${url}/elements/api-v2`, userSecret: SECRET, organizationSecret: 'organization-private' },
    edge: { url, clientId: 'local-client', clientSecret: SECRET }
  };
}

function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const privateValue of [SECRET, 'organization-private', 'response-token', 'person@example.test', 'providerData', 'source-script-private']) assert.equal(text.includes(privateValue), false, privateValue);
}

test('all seven optional auth schemes issue only fixed documented read probes', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/binding/exact-token') return { status: 200, json: { access_token: 'mesh-bearer', expires_in: 300 } };
    if (request.path === '/transport/v2/nodes') return { status: 200, json: { nodes: [] } };
    if (request.path.startsWith('/cf/configuration/v1/')) return { status: 200, json: { results: [], metadata: { page: 0, pageSize: 1, totalPages: 0, totalResultsCount: 0 } } };
    if (request.path.startsWith('/hub/rest/api/v1/management/messaging/queues/')) return { status: 200, json: { name: 'namespace/orders/incoming', maxQueueSizeInBytes: 1024 } };
    if (request.path.startsWith('/SEMP/')) return { status: 200, json: { data: [], meta: { count: 0 } }, headers: { 'set-cookie': 'SEMPSESSION=session-private; HttpOnly' } };
    if (request.path === '/elements/api-v2/instances') return { status: 200, json: [] };
    if (request.path === '/local/api/eic/v1/$metadata') return { status: 200, body: metadata };
    return { status: 404 };
  });
  const aemRequests = [];
  const fetchImpl = async (url, options) => {
    if (new URL(url).hostname === 'api.solace.cloud') {
      aemRequests.push({ url: String(url), ...options });
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, options);
  };
  const clients = createOptionalClients(configs(tenant.url), { env: {}, fetchImpl });
  const evidence = await verifyOptionalClients(clients);
  assert.deepEqual(evidence.optional_completeness.configured, OPTIONAL_CLIENT_KEYS);
  assert.equal(evidence.optional_completeness.complete, true);
  for (const key of OPTIONAL_CLIENT_KEYS) {
    assert.equal(evidence[key].result, 'ok', key);
    assert.equal(evidence[key].activation, 'unknown');
    assert.equal(evidence[key].entitlement, 'unknown');
  }
  const requestAt = path => tenant.requests.find(request => request.path === path);
  assert.equal(requestAt('/transport/v2/nodes').headers.authorization, 'Bearer token-1');
  assert.equal(requestAt('/cf/configuration/v1/action').headers.authorization, basic('alerts-user'));
  assert.equal(requestAt('/cf/configuration/v1/action').query.get('page'), '0');
  assert.equal(requestAt('/cf/configuration/v1/action').query.get('pageSize'), '1');
  const queuePath = '/hub/rest/api/v1/management/messaging/queues/namespace%2Forders%2Fincoming';
  assert.equal(requestAt(queuePath).headers.authorization, 'Bearer mesh-bearer');
  assert.equal(requestAt('/binding/exact-token').method, 'POST');
  assert.equal(requestAt('/binding/exact-token').headers.authorization, basic('mesh-client'));
  assert.equal(requestAt('/SEMP/v2/monitor/msgVpns/vpn%2Fone/queues').headers.authorization, basic('vpn-reader'));
  await clients.aem_semp.request('GET', '/SEMP/v2/monitor/msgVpns/vpn%2Fone/queues');
  assert.equal(tenant.requests.at(-1).headers.cookie, 'SEMPSESSION=session-private');
  assert.equal(requestAt('/elements/api-v2/instances').headers.authorization, `User ${SECRET}, Organization organization-private`);
  assert.equal(requestAt('/local/api/eic/v1/$metadata').headers.authorization, basic('local-client'));
  assert.equal(aemRequests.length, 1);
  const aemUrl = new URL(aemRequests[0].url);
  assert.equal(aemUrl.origin, 'https://api.solace.cloud');
  assert.equal(aemUrl.pathname, '/api/v2/missionControl/eventBrokerServices');
  assert.equal(aemUrl.searchParams.get('pageNumber'), '1');
  assert.equal(aemUrl.searchParams.get('expand'), 'allowedActions');
  assert.equal(aemRequests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(tenant.requests.every(request => request.method === 'GET' || (request.method === 'POST' && ['/oauth/token', '/binding/exact-token'].includes(request.path))), true);
  assert.equal(JSON.stringify(evidence).includes('SEMPSESSION'), false);
  assertPrivate(evidence);
});

test('unnamed Event Mesh probe is untested without token or management request', async t => {
  const tenant = await startFakeTenant(t);
  const { probeQueueName, ...event_mesh } = configs(tenant.url).event_mesh;
  const evidence = await verifyOptionalClients(createOptionalClients({ event_mesh }, { env: {} }));
  assert.equal(evidence.event_mesh.configured, true);
  assert.equal(evidence.event_mesh.result, 'untested');
  assert.equal(evidence.event_mesh.signed_in, false);
  assert.equal(evidence.optional_completeness.complete, false);
  assert.deepEqual(tenant.requests, []);
  assertPrivate(evidence);
});

for (const [status, result] of [[401, 'unauthenticated'], [403, 'forbidden'], [404, 'unavailable'], [501, 'unavailable'], [529, 'error']]) {
  test(`optional HTTP ${status} remains ${result} without entitlement inference or error body`, async t => {
    const tenant = await startFakeTenant(t, () => ({ status, json: { token: SECRET, detail: 'person@example.test', source: 'source-script-private' } }));
    const evidence = await verifyOptionalClients(createOptionalClients({ aem_semp: configs(tenant.url).aem_semp }, { env: {} }));
    assert.equal(evidence.aem_semp.result, result);
    assert.equal(evidence.aem_semp.checks[0].status, status);
    assert.equal(evidence.aem_semp.entitlement, 'unknown');
    assert.equal(evidence.aem_semp.activation, 'unknown');
    if (status === 529) assert.match(evidence.aem_semp.error, /session slot/);
    assertPrivate(evidence);
  });
}

test('token rejection is not signed-in access and token response remains private', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 401, json: { access_token: SECRET, message: 'person@example.test' } }));
  const event_mesh = { ...configs(tenant.url).event_mesh, tokenUrl: `${tenant.url}/rejected-token` };
  const evidence = await verifyOptionalClients(createOptionalClients({ event_mesh }, { env: {} }));
  assert.equal(evidence.event_mesh.result, 'unauthenticated');
  assert.equal(evidence.event_mesh.signed_in, false);
  assert.equal(evidence.event_mesh.checks[0].source.phase, 'token');
  assert.deepEqual(tenant.requests.map(request => request.path), ['/rejected-token']);
  assertPrivate(evidence);
});

test('malformed success contracts and metadata do not become verified access', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { unexpected: [], token: SECRET } }));
  const { ans, open_connectors, edge } = configs(tenant.url);
  const evidence = await verifyOptionalClients(createOptionalClients({ ans, open_connectors, edge }, { env: {} }));
  for (const key of ['ans', 'open_connectors', 'edge']) assert.equal(evidence[key].result, 'error');
  assertPrivate(evidence);
});

test('an expired optional deadline makes no token or API requests', async t => {
  const tenant = await startFakeTenant(t);
  const { ctms, ans } = configs(tenant.url);
  const evidence = await verifyOptionalClients(createOptionalClients({ ctms, ans }, { env: {} }), { deadline: Date.now() - 1 });
  assert.equal(evidence.ctms.result, 'error');
  assert.equal(evidence.ans.result, 'error');
  assert.equal(evidence.ctms.checks[0].stop_reason, 'deadline');
  assert.deepEqual(tenant.requests, []);
});

test('optional absent malformed or forbidden never changes configured core ok', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path.startsWith('/cf/')) return { status: 403, body: SECRET };
    if (request.path.endsWith('/$count')) return { status: 200, body: '0' };
    return { status: 200, json: { d: { results: [] } } };
  });
  for (const ANS_CONFIG of [undefined, '{malformed-private', JSON.stringify(configs(tenant.url).ans)]) {
    const config = resolveIntegrationConfig({ CPI_SERVICE_KEY: tenant.serviceKey(), ...(ANS_CONFIG === undefined ? {} : { ANS_CONFIG }) });
    const evidence = await verifyIntegrationClients(createIntegrationClients(config, { env: {} }));
    assert.equal(evidence.ok, true);
    assert.equal(evidence.ok_scope, 'configured_core_access');
    assert.equal(evidence.ans.result, ANS_CONFIG?.startsWith('{"') ? 'forbidden' : 'untested');
    assert.equal(evidence.ans.configured, ANS_CONFIG?.startsWith('{"') ?? false);
    assertPrivate(evidence);
    assert.equal(JSON.stringify(evidence).includes('malformed-private'), false);
  }
});

test('catalog always includes native boundaries and derives actions only from actual registrations', () => {
  const empty = capabilityCatalog();
  const keys = ['cpi', 'apim', 'devhub', ...OPTIONAL_CLIENT_KEYS, 'cloud_alm', 'suite_event_mesh', 'tpm', 'integration_advisor', 'integration_assessment', 'migration_assessment', 'integration_cell_api_mcp'];
  assert.deepEqual(Object.keys(empty), keys);
  for (const entry of Object.values(empty)) {
    assert.equal(entry.configured, false);
    assert.equal(entry.access, 'untested');
    assert.equal(entry.activation, 'unknown');
    assert.equal(entry.entitlement, 'unknown');
    assert.deepEqual(entry.supported_actions, []);
    assert.ok(entry.source_links.every(url => url.startsWith('https://')));
    assert.ok(entry.setup_requirements.length);
    assert.ok(entry.native_handoff.every(handoff => handoff.steps.length && handoff.safety && handoff.post_action_verification.length));
  }
  const catalog = capabilityCatalog({
    summary: { aem: { configured: true, source: 'stored-key' }, aem_semp: { configured: true }, ans: { configured: false } },
    verification: { aem: { configured: true, result: 'forbidden', entitlement: 'entitled', activation: 'active' } },
    toolNames: ['aem_list_brokers', 'aem_list_queues', 'cpi_list_packages', 'integration_connection_info'],
    optional_config_errors: [{ component: 'ans', message: SECRET }]
  });
  assert.deepEqual(catalog.aem.supported_actions, ['aem_list_brokers']);
  assert.deepEqual(catalog.aem_semp.supported_actions, ['aem_list_queues']);
  assert.equal(catalog.aem.access, 'forbidden');
  assert.equal(catalog.aem.entitlement, 'unknown');
  assert.equal(catalog.aem.activation, 'unknown');
  assert.equal(catalog.ans.configuration, 'invalid');
  assert.equal(catalog.integration_assessment.public_contract, 'documented_reference_inaccessible');
  assert.equal(catalog.ctms.contract_boundaries[0].public_contract, 'documented_reference_inaccessible');
  assertPrivate(catalog);
});
