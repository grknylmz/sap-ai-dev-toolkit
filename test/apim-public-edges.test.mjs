import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strFromU8, strToU8 } from 'fflate';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { buildApiProxyBundle, attachPolicies } from '../src/apim-bundle.mjs';
import { readBundle, writeBundle } from '../src/iflow-bundle.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const BASE = '/apiportal/api/1.0/Management.svc';
const TRANSPORT = '/apiportal/api/1.0/Transport.svc/APIProxies';
const PRIVATE = 'synthetic-private-metadata-value';
const CLIENT = 'synthetic-private-client';
const SECRET = 'synthetic-private-client-secret';
const TOKEN = 'synthetic-private-runtime-bearer';
const API_KEY = 'synthetic-private-consumer-key';
const BUSINESS = 'business-row-must-not-escape';
const ISSUER = 'https://identity.example/oauth/token';
const oauth = { service_instance: 'identity', service_key: 'consumer', scope: 'api.read' };
const probe = { proxy_name: 'Orders', path: '/Orders', oauth };

async function connect(t, tenant, { devhub = false, ...options } = {}) {
  const runtime = createIntegrationServer({
    env: { XDG_CONFIG_HOME: '/nonexistent/apim-public-edges', APIM_SERVICE_KEY: tenant.serviceKey(), ...(devhub ? { DEVHUB_SERVICE_KEY: tenant.serviceKey() } : {}) },
    readBackDelayMs: 1,
    ...options
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'apim-public-edges', version: '1.0.0' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { error: response.isError === true, text: response.content[0].text };
  };
}

function parsed(response) {
  assert.equal(response.error, false, response.text);
  return JSON.parse(response.text);
}

function privateValuesAbsent(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  for (const value of [PRIVATE, CLIENT, SECRET, TOKEN, API_KEY, BUSINESS]) assert.equal(text.includes(value), false, 'private data escaped');
}

function proxyMetadata(extra = {}) {
  return { name: 'Orders', state: 'DEPLOYED', version: '7', publishUrl: 'https://runtime.example/orders', proxyEndPoints: [{ name: 'default', base_path: '/orders', virtualhosts: [{ virtual_host: 'runtime.example', isSSL: true }] }], ...extra };
}

function securityBundle(issuer = ISSUER) {
  const files = readBundle(buildApiProxyBundle({ name: 'Orders', basePath: '/orders', serviceType: 'odata', target: { url: 'https://backend.example/odata' } }));
  attachPolicies(files, 'Orders', [
    { name: 'Identity', template: 'custom', params: { type: 'VerifyJWT', xml: `<VerifyJWT xmlns="http://www.sap.com/apimgmt"><Issuer>${issuer}</Issuer></VerifyJWT>` }, condition: 'request.verb = "GET"' },
    { name: 'Backend', template: 'custom', params: { type: 'KeyValueMapOperations', xml: '<KeyValueMapOperations xmlns="http://www.sap.com/apimgmt" mapIdentifier="BackendCredentials"><Get assignTo="private.password"><Key><Parameter>password</Parameter></Key></Get></KeyValueMapOperations>' } },
    { name: 'Logic', template: 'javascript', params: { file: 'logic', script: `var privateData = '${PRIVATE}';` } }
  ]);
  const root = 'APIProxy/Orders.xml';
  files.set(root, strToU8(strFromU8(files.get(root)).replace('</policies>', '<policy type="Quota">Idle</policy></policies>')));
  files.set('APIProxy/Policy/Idle.xml', strToU8('<Quota xmlns="http://www.sap.com/apimgmt"><Interval>1</Interval></Quota>'));
  files.set('APIProxy/Policy/Unregistered.xml', strToU8(`<RaiseFault><Payload>${PRIVATE}</Payload></RaiseFault>`));
  return files;
}

test('public proxy status sanitizes URLs and reports observed deployments without inventing runtime health', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/APIProxies('Orders')`) return { status: 200, json: { d: proxyMetadata({
      state: 'FUTURE_STATE', publishUrl: `https://user:${PRIVATE}@runtime.example/orders?token=${PRIVATE}#private`,
      deploymentInfo: { results: [{ state: 'DEPLOYED', revision: 12, deployedAt: '2026-10-28T09:00:00Z', access_token: PRIVATE }] }
    }) } };
    return { status: request.path.includes("'Denied'") ? 403 : 404 };
  });
  const call = await connect(t, tenant);
  const status = parsed(await call('apim_get_api_proxy_status', { name: 'Orders' }));
  assert.equal(status.state, 'FUTURE_STATE');
  assert.equal(status.version, '7');
  assert.equal(status.runtime_url, 'https://runtime.example/orders');
  assert.equal(status.runtime_health, 'unverified');
  assert.deepEqual(status.deployment_metadata, [{ state: 'DEPLOYED', revision: 12, deployedAt: '2026-10-28T09:00:00Z' }]);
  privateValuesAbsent(status);
  const missing = await call('apim_get_api_proxy_status', { name: 'Missing' });
  assert.equal(missing.error, true);
  assert.match(missing.text, /does not exist/);
  const denied = await call('apim_get_api_proxy_status', { name: 'Denied' });
  assert.equal(denied.error, true);
  assert.match(denied.text, /403/);
  assert.doesNotMatch(denied.text, /does not exist/);
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

test('static inspection exposes attached, idle and unregistered policy evidence but never policy/script contents', async t => {
  let bundle = writeBundle(securityBundle());
  const tenant = await startFakeTenant(t, request => {
    if (request.path !== TRANSPORT || request.method !== 'GET') return { status: 404 };
    if (request.query.get('name') === 'Missing') return { status: 404 };
    if (request.query.get('name') === 'Denied') return { status: 403 };
    if (request.query.get('name') === 'Malformed') return { status: 200, body: 'not a zip' };
    return { status: 200, body: Buffer.from(bundle) };
  });
  const call = await connect(t, tenant);
  const report = parsed(await call('apim_inspect_api_proxy_security', { name: 'Orders' }));
  assert.equal(report.evidence, 'static_bundle');
  assert.deepEqual(report.policies.map(policy => [policy.name, policy.type, policy.document_present]), [['Identity', 'VerifyJWT', true], ['Backend', 'KeyValueMapOperations', true], ['Logic', 'Javascript', true], ['Idle', 'Quota', true]]);
  assert.ok(report.attachments.some(item => item.policy_name === 'Identity' && item.endpoint === 'proxy' && item.flow === 'preFlow' && item.phase === 'request' && item.condition_present && item.registered));
  assert.deepEqual(report.unattached_policies, ['Idle']);
  assert.deepEqual(report.unregistered_policy_files, ['Unregistered']);
  assert.ok(report.references.some(item => item.kind === 'kvm' && item.name === 'BackendCredentials'));
  assert.ok(report.unresolved.some(item => item.reason === 'custom_or_dynamic_behavior'));
  assert.equal(report.effective_authentication, 'unverified');
  assert.equal(report.effective_rate_limiting, 'unverified');
  assert.equal(report.certificate_trust, 'unverified');
  assert.match(report.bundle_sha256, /^[a-f0-9]{64}$/);
  privateValuesAbsent(report);
  const changed = securityBundle();
  changed.set('APIProxy/FileResource/logic.js', strToU8('var changed = true;'));
  bundle = writeBundle(changed);
  assert.notEqual(parsed(await call('apim_inspect_api_proxy_security', { name: 'Orders' })).bundle_sha256, report.bundle_sha256, 'source changes invalidate the inspection digest');
  for (const [name, error] of [['Missing', /does not exist/], ['Denied', /403/], ['Malformed', /not a readable zip/]]) {
    const response = await call('apim_inspect_api_proxy_security', { name });
    assert.equal(response.error, true);
    assert.match(response.text, error);
    privateValuesAbsent(response);
  }
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

test('product getter preserves quota, publishing and exact proxy membership while dropping credential-bearing expansion data', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path !== `${BASE}/APIProducts('Orders')`) return { status: 404 };
    assert.equal(request.query.get('$expand'), 'apiProxies');
    return { status: 200, json: { d: { name: 'Orders', title: 'Order API', version: '2', isPublished: true, status_code: 'PUBLISHED', quotaCount: 900, quotaInterval: 2, quotaTimeUnit: 'hour', scope: 'orders.read',
      app_secret: PRIVATE, internal: { access_token: PRIVATE }, apiProxies: { results: [{ name: 'North', app_key: PRIVATE }, { name: 'South', targetEndPoints: [{ password: PRIVATE }] }] }
    } } };
  });
  const call = await connect(t, tenant);
  const product = parsed(await call('apim_get_api_product', { name: 'Orders' }));
  assert.deepEqual(product.api_proxies, ['North', 'South']);
  assert.equal(product.isPublished, true);
  assert.equal(product.quotaCount, 900);
  assert.equal(product.quotaInterval, 2);
  assert.equal(product.quotaTimeUnit, 'hour');
  assert.equal(product.scope, 'orders.read');
  assert.equal('internal' in product, false);
  privateValuesAbsent(product);
});

test('provider/proxy readers remove nested credentials and URL query data without losing operational connection identity', async t => {
  const unsafeUrl = `https://user:${PRIVATE}@backend.example/odata?token=${PRIVATE}#fragment`;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/APIProviders('Orders')`) return { status: 200, json: { d: { name: 'Orders', host: 'backend.example', port: 443, useSSL: true, authType: 'NONE', userName: PRIVATE,
      nested: { clientSecret: PRIVATE, access_token: PRIVATE, endpoint: unsafeUrl, properties: [{ Name: 'Authorization', Value: PRIVATE }] }
    } } };
    if (request.path === `${BASE}/APIProviders('Orders')/additionalProperties`) return { status: 200, json: { d: { results: [{ name: 'sap-client', value: '100' }, { name: 'clientSecret', value: PRIVATE }] } } };
    if (request.path === `${BASE}/APIProxies('Orders')`) return { status: 200, json: { d: proxyMetadata({ publishUrl: unsafeUrl,
      targetEndPoints: [{ name: 'default', url: unsafeUrl, properties: [{ ParameterKey: 'password', ParameterValue: PRIVATE }], credentials: { app_key: PRIVATE } }]
    }) } };
    return { status: 404 };
  });
  const call = await connect(t, tenant);
  const provider = parsed(await call('apim_get_api_provider', { name: 'Orders' }));
  assert.equal(provider.host, 'backend.example');
  assert.equal(provider.port, 443);
  assert.equal(provider.nested.endpoint, 'https://backend.example/odata');
  assert.equal(provider.additionalProperties.find(item => item.name === 'sap-client').value, '100');
  assert.equal(provider.additionalProperties.find(item => item.name === 'clientSecret').value, '[redacted]');
  privateValuesAbsent(provider);
  const proxy = parsed(await call('apim_get_api_proxy', { name: 'Orders' }));
  assert.equal(proxy.state, 'DEPLOYED');
  assert.equal(proxy.runtime_url, 'https://backend.example/odata');
  assert.equal(proxy.publishUrl, 'https://backend.example/odata');
  assert.equal(proxy.targetEndPoints[0].url, 'https://backend.example/odata');
  assert.equal(proxy.proxyEndPoints[0].virtualhosts[0].virtual_host, 'runtime.example');
  privateValuesAbsent(proxy);
});

test('named management reads distinguish absent, forbidden and malformed entity metadata', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/VirtualHosts')) return { status: 200, json: { d: { results: [] } } };
    if (request.path.includes("'Missing'")) return { status: 404 };
    if (request.path.includes("'Denied'")) return { status: 403 };
    if (request.path.includes("'Malformed'")) return { status: 200, json: { d: { unexpected: PRIVATE } } };
    return { status: 404 };
  });
  const call = await connect(t, tenant);
  for (const tool of ['apim_get_api_provider', 'apim_get_api_proxy', 'apim_get_api_product', 'apim_get_key_value_map', 'apim_set_key_value_map_entries']) {
    for (const [name, pattern] of [['Missing', /does not exist/], ['Denied', /403/], ['Malformed', /malformed metadata/]]) {
      const args = tool === 'apim_set_key_value_map_entries' ? { name, entries: [{ name: 'credential', value: SECRET }], confirmation: `UPDATE KEY VALUE MAP ${name}` } : { name };
      const response = await call(tool, args);
      assert.equal(response.error, true, `${tool} ${name}`);
      assert.match(response.text, pattern);
      if (name !== 'Missing') assert.doesNotMatch(response.text, /does not exist/);
      privateValuesAbsent(response);
    }
  }
  assert.equal(tenant.apiRequests().some(request => request.path.endsWith('/additionalProperties')), false, 'invalid provider metadata must not trigger dependent reads');
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'), 'unreadable map metadata must stop before every KVM write');
});

test('explicit bundle export returns selected source members, keeps binary opaque and makes truncation/size failures visible', async t => {
  const files = securityBundle();
  files.set('APIProxy/FileResource/logic.js', strToU8('var syntheticFixture = true;'));
  files.set('APIProxy/Policy/Unregistered.xml', strToU8('<RaiseFault><Payload>synthetic fixture</Payload></RaiseFault>'));
  files.set('APIProxy/FileResource/binary.bin', new Uint8Array([0, 255, 1, 128]));
  files.set('APIProxy/FileResource/large.js', strToU8('x'.repeat(120 * 1024)));
  let bundle = writeBundle(files);
  const tenant = await startFakeTenant(t, request => {
    if (request.path !== TRANSPORT) return { status: 404 };
    if (request.query.get('name') === 'Missing') return { status: 404 };
    if (request.query.get('name') === 'Denied') return { status: 403 };
    if (request.query.get('name') === 'Malformed') return { status: 200, body: 'invalid archive' };
    return { status: 200, body: Buffer.from(bundle) };
  });
  const call = await connect(t, tenant);
  const whole = parsed(await call('apim_export_api_proxy', { name: 'Orders' }));
  privateValuesAbsent(whole);
  assert.equal(whole.files.find(file => file.path === 'APIProxy/FileResource/binary.bin').bytes, 4);
  assert.equal('text' in whole.files.find(file => file.path.endsWith('binary.bin')), false);
  assert.ok(whole.files.find(file => file.path.endsWith('large.js')).truncated);
  // This is the explicit authoring boundary: policy/script source is intentional,
  // unlike the static inspection result above. Do not claim arbitrary source redaction.
  assert.match(whole.files.find(file => file.path === 'APIProxy/Policy/Identity.xml').text, /<VerifyJWT/);
  const member = parsed(await call('apim_export_api_proxy', { name: 'Orders', file_path: 'APIProxy/Policy/Identity.xml' }));
  assert.equal(member.file.text, strFromU8(files.get(member.file.path)));
  privateValuesAbsent(member);
  const largeResponse = await call('apim_export_api_proxy', { name: 'Orders', file_path: 'APIProxy/FileResource/large.js' });
  const large = parsed(largeResponse);
  assert.equal(large.file.bytes, 120 * 1024);
  assert.equal(large.file.truncated, true);
  assert.ok(Buffer.byteLength(largeResponse.text) < 96 * 1024);
  for (const file_path of ['missing.xml', '../outside.xml']) {
    const response = await call('apim_export_api_proxy', { name: 'Orders', file_path });
    assert.equal(response.error, true);
    assert.match(response.text, /file_path not found/);
  }
  for (const [name, pattern] of [['Missing', /does not exist/], ['Denied', /403/], ['Malformed', /not a readable zip/]]) {
    const response = await call('apim_export_api_proxy', { name });
    assert.equal(response.error, true);
    assert.match(response.text, pattern);
  }
  for (let index = 0; index < 4; index++) files.set(`APIProxy/FileResource/oversize${index}.js`, strToU8('y'.repeat(60 * 1024)));
  bundle = writeBundle(files);
  const oversized = await call('apim_export_api_proxy', { name: 'Orders' });
  assert.equal(oversized.error, true);
  assert.match(oversized.text, /(?:large|size|KiB|limit)/i);
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

test('documentation export failures distinguish access, absent proxy, invalid archive and invalid document', async t => {
  const malformed = new Map([
    ['APIProxy/Orders.xml', strToU8('<APIProxy><name>Orders</name><proxyEndPoints><proxyEndPoint><proxyEndPointName>default</proxyEndPointName><apiResourceName>SWAGGER_JSON</apiResourceName></proxyEndPoint></proxyEndPoints></APIProxy>')],
    ['APIProxy/APIResource/SWAGGER_JSON.xml', strToU8('<APIResource><name>SWAGGER_JSON</name><resource_path>SWAGGER_JSON</resource_path><proxyEndPointName>default</proxyEndPointName><documentations><documentation locale="en" mimeType="json">SWAGGER_JSON</documentation></documentations></APIResource>')],
    ['APIProxy/Documentation/SWAGGER_JSON_en.html', strToU8(`invalid-json-${PRIVATE}`)]
  ]);
  const tenant = await startFakeTenant(t, request => {
    const name = request.query.get('name');
    if (name === 'Missing') return { status: 404 };
    if (name === 'Denied') return { status: 403 };
    return { status: 200, body: name === 'Archive' ? 'not zip' : Buffer.from(writeBundle(malformed)) };
  });
  const call = await connect(t, tenant);
  for (const [name, pattern] of [['Missing', /does not exist/], ['Denied', /403/], ['Archive', /not a readable zip/], ['Orders', /JSON/]]) {
    const response = await call('apim_get_api_documentation', { name });
    assert.equal(response.error, true);
    assert.match(response.text, pattern);
    privateValuesAbsent(response);
  }
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

test('KVM updates stop at the failed member, preserve unrelated state and never read/write before confirmation', async t => {
  const values = new Map([['existing', 'old'], ['untouched', PRIVATE]]);
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/KeyMapEntries('Credentials')`) return { status: 200, json: { d: { name: 'Credentials', encrypted: false, scope: 'ENV', keyMapEntryValues: { results: [...values].map(([name, value]) => ({ name, value })) } } } };
    if (request.method === 'PUT' && request.path.includes('/KeyMapEntryValues(')) {
      const entry = JSON.parse(request.body);
      values.set(entry.name, entry.value);
      return { status: 204 };
    }
    if (request.method === 'POST' && request.path === `${BASE}/KeyMapEntryValues`) {
      const entry = JSON.parse(request.body);
      if (entry.name === 'blocked') return { status: 409, json: { error: { message: { value: `conflict ${entry.value}` } } } };
      values.set(entry.name, entry.value);
      return { status: 201 };
    }
    return { status: 404 };
  });
  const call = await connect(t, tenant);
  const entries = [{ name: 'existing', value: SECRET }, { name: 'created', value: TOKEN }, { name: 'blocked', value: PRIVATE }, { name: 'never-sent', value: API_KEY }];
  const wrong = await call('apim_set_key_value_map_entries', { name: 'Credentials', entries, confirmation: 'UPDATE KEY VALUE MAP Other' });
  assert.equal(wrong.error, true);
  assert.equal(tenant.requests.length, 0);
  const result = parsed(await call('apim_set_key_value_map_entries', { name: 'Credentials', entries, confirmation: 'UPDATE KEY VALUE MAP Credentials' }));
  assert.deepEqual(result.updated, ['existing']);
  assert.deepEqual(result.created, ['created']);
  assert.equal(result.failed.name, 'blocked');
  assert.match(result.failed.error, /409/);
  assert.equal(values.get('existing'), SECRET);
  assert.equal(values.get('created'), TOKEN);
  assert.equal(values.get('untouched'), PRIVATE);
  assert.equal(values.has('blocked') || values.has('never-sent'), false);
  privateValuesAbsent(result);
  const read = parsed(await call('apim_get_key_value_map', { name: 'Credentials' }));
  assert.deepEqual(read.entries.map(entry => entry.name), ['existing', 'untouched', 'created']);
  assert.ok(read.entries.every(entry => entry.value === '[redacted]'));
  privateValuesAbsent(read);
  const mutations = tenant.apiRequests().filter(request => request.method !== 'GET');
  assert.equal(mutations.length, 3);
  assert.ok(mutations.every(request => !request.body.includes('never-sent')));
});

async function runtimeFixture(t, { devhub = false } = {}) {
  const state = { issuer: ISSUER, tokenStatus: 200, tokenScope: oauth.scope, runtimeStatus: 200, runtimeKind: 'rows', deployed: true, appPresent: true, cfReads: 0, tokenReads: 0, runtimeReads: 0, appReads: 0, unexpected: 0 };
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path === TRANSPORT) return { status: 200, body: Buffer.from(writeBundle(securityBundle(state.issuer))) };
    if (request.method === 'GET' && request.path === `${BASE}/APIProxies('Orders')`) return { status: 200, json: { d: proxyMetadata({ state: state.deployed ? 'DEPLOYED' : 'DRAFT' }) } };
    if (request.method === 'GET' && request.path === "/odata/1.0/data.svc/APIMgmt.Applications('Consumer')") {
      state.appReads++;
      return state.appPresent ? { status: 200, json: { d: { id: 'Consumer', app_key: API_KEY, app_secret: SECRET } } } : { status: 404 };
    }
    if (request.path === '/identity-token') {
      state.tokenReads++;
      const form = new URLSearchParams(request.body);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}`);
      assert.deepEqual([...form], [['grant_type', 'client_credentials'], ['scope', oauth.scope]]);
      assert.equal(request.headers.apikey, undefined);
      return { status: state.tokenStatus, headers: { location: '/credential-sink' }, json: { access_token: TOKEN, token_type: 'Bearer', scope: state.tokenScope } };
    }
    if (request.path === '/orders/Orders' || request.path === '/orders/$metadata') {
      state.runtimeReads++;
      assert.equal(request.method, 'GET');
      assert.ok((request.headers.authorization === `Bearer ${TOKEN}` && !request.headers.apikey) || (request.headers.apikey === API_KEY && !request.headers.authorization));
      if (state.runtimeStatus !== 200) return { status: state.runtimeStatus, headers: { location: '/credential-sink' }, body: `${PRIVATE} ${TOKEN} ${API_KEY}` };
      if (request.path.endsWith('$metadata')) return { status: 200, headers: { 'content-type': 'application/xml' }, body: '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><EntitySet Name="Orders" EntityType="Order"/></edmx:Edmx>' };
      assert.equal(request.query.get('$top'), '1');
      const credential = request.headers.apikey ?? TOKEN;
      const reflected = request.headers.apikey ? { [API_KEY]: PRIVATE, [SECRET]: PRIVATE } : { [TOKEN]: PRIVATE, [CLIENT]: PRIVATE, [SECRET]: PRIVATE };
      return { status: 200, headers: { 'content-type': `application/json; reflected=${credential}` }, json: state.runtimeKind === 'rows' ? { value: [{ OrderId: BUSINESS, ...reflected }] } : { value: [{ OrderId: BUSINESS }, { OrderId: BUSINESS }] } };
    }
    state.unexpected++;
    return { status: 404 };
  });
  // Only this private test transport maps the pinned HTTPS origins to loopback;
  // production validation still sees their real HTTPS origin/path identities.
  const fetchImpl = (address, init) => {
    const url = new URL(address);
    if (url.origin === tenant.url) return fetch(address, init);
    if (url.origin === 'https://identity.example' && url.pathname === '/oauth/token') return fetch(`${tenant.url}/identity-token`, init);
    if (url.origin === 'https://runtime.example' && ['/orders/Orders', '/orders/$metadata'].includes(url.pathname)) return fetch(`${tenant.url}${url.pathname}${url.search}`, init);
    throw new Error('Untrusted test transport destination');
  };
  const execFileImpl = (command, argv, options, callback) => {
    state.cfReads++;
    assert.equal(command, 'cf');
    assert.deepEqual(argv, ['service-key', '--json', oauth.service_instance, oauth.service_key]);
    callback(null, JSON.stringify({ credentials: { uaa: { url: 'https://identity.example', clientid: CLIENT, clientsecret: SECRET } } }));
  };
  return { tenant, state, call: await connect(t, tenant, { devhub, fetchImpl, execFileImpl }) };
}

test('production APIM-only OAuth probe privately reads an existing CF key and exercises bounded loopback entities/metadata', async t => {
  const { tenant, state, call } = await runtimeFixture(t);
  const result = parsed(await call('apim_test_api', probe));
  assert.equal(result.runtime_url, 'https://runtime.example/orders');
  assert.equal(result.returned, 1);
  assert.equal(result.status, 200);
  assert.ok(result.fields.includes('OrderId'));
  privateValuesAbsent(result);
  const metadata = parsed(await call('apim_test_api', { ...probe, path: '/$metadata' }));
  assert.deepEqual(metadata.metadata.entity_sets.map(item => item.name), ['Orders']);
  privateValuesAbsent(metadata);
  assert.equal(state.cfReads, 2);
  assert.equal(state.tokenReads, 2);
  assert.equal(state.runtimeReads, 2);
  assert.equal(state.appReads + state.unexpected, 0);
  assert.equal(tenant.apiRequests().filter(request => request.path === TRANSPORT).length, 2, 'issuer evidence is re-exported for every OAuth invocation');
  const before = tenant.requests.length;
  const unavailable = await call('apim_test_api', { proxy_name: 'Orders', path: '/Orders', application_id: 'Consumer' });
  assert.equal(unavailable.error, true);
  assert.match(unavailable.text, /Developer Hub/);
  assert.equal(tenant.requests.length, before, 'APIM-only API-key mode cannot fetch a credential or reach runtime');
});

test('production runtime probes reject issuer mismatch, redirected tokens/runtime, broadened scope and ignored bounds', async t => {
  const { state, call } = await runtimeFixture(t);
  for (const change of [
    { issuer: 'https://untrusted.example/oauth/token', tokenReads: 0, runtimeReads: 0, pattern: /issuer/ },
    { tokenStatus: 302, tokenReads: 1, runtimeReads: 0, pattern: /302/ },
    { tokenScope: `${oauth.scope} other.scope`, tokenReads: 1, runtimeReads: 0, pattern: /exactly the requested scope/ },
    { runtimeStatus: 307, tokenReads: 1, runtimeReads: 1, pattern: /307/ },
    { runtimeKind: 'too_many', tokenReads: 1, runtimeReads: 1, pattern: /bounded/ },
    { deployed: false, tokenReads: 1, runtimeReads: 0, pattern: /not deployed/ }
  ]) {
    Object.assign(state, { issuer: ISSUER, tokenStatus: 200, tokenScope: oauth.scope, runtimeStatus: 200, runtimeKind: 'rows', deployed: true });
    const before = { ...state };
    for (const key of ['issuer', 'tokenStatus', 'tokenScope', 'runtimeStatus', 'runtimeKind', 'deployed']) if (key in change) state[key] = change[key];
    const response = await call('apim_test_api', probe);
    assert.equal(response.error, true);
    assert.match(response.text, change.pattern);
    privateValuesAbsent(response);
    assert.equal(state.tokenReads - before.tokenReads, change.tokenReads);
    assert.equal(state.runtimeReads - before.runtimeReads, change.runtimeReads);
    assert.equal(state.unexpected, 0, 'redirect destinations are never contacted');
  }
});

test('production API-key mode reads the private Developer Hub key once and does not read CF credentials or obtain OAuth', async t => {
  const { state, tenant, call } = await runtimeFixture(t, { devhub: true });
  const args = { proxy_name: 'Orders', path: '/Orders', application_id: 'Consumer' };
  const result = parsed(await call('apim_test_api', args));
  assert.equal(result.application_id, 'Consumer');
  assert.equal(result.returned, 1);
  assert.ok(result.fields.includes('OrderId'));
  privateValuesAbsent(result);
  assert.equal(state.appReads, 1);
  assert.equal(state.runtimeReads, 1);
  assert.equal(state.cfReads + state.tokenReads, 0);
  assert.equal(tenant.apiRequests().filter(request => request.path === TRANSPORT).length, 0);
  state.appPresent = false;
  const missing = await call('apim_test_api', args);
  assert.equal(missing.error, true);
  assert.match(missing.text, /does not exist/);
  assert.equal(state.runtimeReads, 1);
  assert.equal(state.unexpected, 0);
});

test('production probe rejects competing auth and multiple input scopes before token, key or management access', async t => {
  const { tenant, state, call } = await runtimeFixture(t, { devhub: true });
  for (const args of [
    { ...probe, application_id: 'Consumer' },
    { proxy_name: 'Orders', path: '/Orders' },
    { ...probe, oauth: { ...oauth, scope: 'api.read other.scope' } },
    { ...probe, query: { $top: 11 } },
    { ...probe, path: '/Orders?private=query' }
  ]) {
    const response = await call('apim_test_api', args);
    assert.equal(response.error, true);
    privateValuesAbsent(response);
  }
  assert.equal(state.cfReads, 0);
  assert.equal(tenant.requests.length, 0);
});
