import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strToU8 } from 'fflate';
import { bundleDigest } from '../src/iflow-bundle.mjs';
import { canonicalJson, canonicalDigest, stateDigest } from '../src/integration-state.mjs';
import { inspectApiProxyBundle, inspectApiProxySecurity, registerApimInspectionTools } from '../src/apim-inspection.mjs';
import { APIM_BASE, APIM_TRANSPORT } from '../src/apim-content.mjs';

const files = entries => new Map(Object.entries(entries).map(([name, value]) => [name, strToU8(value)]));
const bundle = () => files({
  'APIProxy/Orders.xml': '<p:APIProxy xmlns:p="http://www.sap.com/apimgmt"><p:policies><p:policy type="KeyValueMapOperations">Lookup</p:policy><p:policy type="VerifyJWT">JWT</p:policy><p:policy type="Javascript">Custom</p:policy><p:policy type="Quota">Unattached</p:policy></p:policies></p:APIProxy>',
  'APIProxy/Policy/Lookup.xml': '<p:KeyValueMapOperations xmlns:p="http://www.sap.com/apimgmt" mapIdentifier="Backend&amp;Auth"><p:Get><p:Key><p:Parameter>PRIVATE_ENTRY</p:Parameter></p:Key></p:Get></p:KeyValueMapOperations>',
  'APIProxy/Policy/JWT.xml': '<p:VerifyJWT xmlns:p="http://www.sap.com/apimgmt"><p:Issuer>https://issuer.example</p:Issuer><p:PublicKey><p:CertificateAlias>cert&#45;one</p:CertificateAlias></p:PublicKey><p:SecretKey ref="private.dynamic.variable"/></p:VerifyJWT>',
  'APIProxy/Policy/Custom.xml': '<Javascript><ResourceURL>jsc://private-code.js</ResourceURL></Javascript>',
  'APIProxy/Policy/Unattached.xml': '<Quota><Allow count="17"/></Quota>',
  'APIProxy/Policy/NotRegistered.xml': '<VerifyAPIKey><APIKey ref="PRIVATE_UNREGISTERED"/></VerifyAPIKey>',
  'APIProxy/APIProxyEndPoint/default.xml': '<p:ProxyEndPoint xmlns:p="http://www.sap.com/apimgmt"><p:name>default</p:name><p:preFlow><p:request><p:steps><p:step><p:policy_name>Lookup</p:policy_name><p:condition>private.header = &quot;PRIVATE_CONDITION&quot;</p:condition></p:step><p:step><p:policy_name>JWT</p:policy_name></p:step><p:step><p:policy_name>Foreign</p:policy_name></p:step></p:steps></p:request></p:preFlow></p:ProxyEndPoint>',
  'APIProxy/APITargetEndPoint/default.xml': '<TargetEndPoint><name>default</name><provider_id>ProviderOne</provider_id><preFlow><response><steps><step><policy_name>Custom</policy_name></step></steps></response></preFlow><SSLInfo><KeyAlias ref="private.alias.variable">{private.alias}</KeyAlias></SSLInfo></TargetEndPoint>',
  'APIProxy/FileResource/private-code.js': 'PRIVATE_SCRIPT_SOURCE'
});

test('bundle digest length-prefixes UTF-8 paths and bytes; map/zip member ordering is immaterial', () => {
  const a = new Map([['é', Uint8Array.of(0, 255)], ['a', Uint8Array.of(17)]]);
  const reversed = new Map([...a].reverse());
  assert.equal(bundleDigest(a), bundleDigest(reversed));
  const hash = createHash('sha256');
  for (const [path, bytes] of [...a].sort(([x], [y]) => Buffer.compare(Buffer.from(x), Buffer.from(y)))) {
    for (const part of [Buffer.from(path), bytes]) {
      const length = Buffer.alloc(4); length.writeUInt32BE(part.byteLength); hash.update(length).update(part);
    }
  }
  assert.equal(bundleDigest(a), hash.digest('hex'));
  reversed.set('é', Uint8Array.of(0, 254));
  assert.notEqual(bundleDigest(a), bundleDigest(reversed));
  assert.notEqual(bundleDigest(files({ ab: 'c' })), bundleDigest(files({ a: 'bc' })));
});

test('canonical hashing removes only OData plumbing and binds configuration values and types', () => {
  assert.equal(canonicalJson({ z: 2, a: { b: 1, a: 0 }, list: [2, 1], __metadata: { uri: 'private' }, '@odata.context': 'private' }), '{"a":{"a":0,"b":1},"list":[2,1],"z":2}');
  assert.equal(canonicalDigest({ b: 1, a: 2 }), canonicalDigest({ a: 2, b: 1 }));
  assert.notEqual(canonicalDigest([1, 2]), canonicalDigest([2, 1]));
  const config = [{ ParameterKey: 'z', ParameterValue: 'private', DataType: 'xsd:string' }, { ParameterKey: 'a', ParameterValue: '1', DataType: 'xsd:int' }];
  assert.equal(stateDigest('bundle', config), stateDigest('bundle', [...config].reverse()));
  assert.notEqual(stateDigest('bundle', config), stateDigest('bundle', [{ ...config[0], ParameterValue: 'changed' }, config[1]]));
  assert.notEqual(stateDigest('bundle', config), stateDigest('bundle', [{ ...config[0], DataType: 'different' }, config[1]]));
  assert.equal(stateDigest('bundle'), canonicalDigest({ bundle_sha256: 'bundle', configurations: [] }));
});

test('static inspection distinguishes registrations, attachments, files and literal dependencies without source', () => {
  const result = inspectApiProxyBundle(bundle(), 'Orders');
  assert.deepEqual(result.unattached_policies, ['Unattached']);
  assert.deepEqual(result.unregistered_policy_files, ['NotRegistered']);
  assert.equal(result.policies.find(item => item.name === 'JWT').type, 'VerifyJWT');
  assert.deepEqual(result.references, [
    { source: 'Lookup', kind: 'kvm', name: 'Backend&Auth' },
    { source: 'JWT', kind: 'certificate', name: 'cert-one' },
    { source: 'target:default', kind: 'provider', name: 'ProviderOne' }
  ]);
  assert.deepEqual(result.jwt_issuers, ['https://issuer.example']);
  assert.equal(result.attachments[0].condition_present, true);
  assert.equal(result.attachments[1].condition_present, false);
  assert.equal(result.attachments[2].registered, false);
  assert.equal(result.attachments[3].endpoint, 'target');
  assert.equal(result.attachments[3].phase, 'response');
  assert.ok(result.unresolved.some(item => item.reason === 'dynamic_or_unrecognized_certificate'));
  assert.ok(result.unresolved.some(item => item.source === 'Custom'));
  assert.equal(result.state_sha256, stateDigest(result.bundle_sha256));
  assert.equal(result.effective_authentication, 'unverified');
  assert.equal(result.certificate_trust, 'unverified');
  const serialized = JSON.stringify(result);
  for (const forbidden of ['PRIVATE_', 'private.header', 'private.alias', '<p:', 'ResourceURL', 'private-code.js']) assert.ok(!serialized.includes(forbidden), forbidden);
});

test('missing registered documents and conditional/fault assignments remain explicit static evidence', () => {
  const content = bundle();
  content.delete('APIProxy/Policy/Unattached.xml');
  content.set('APIProxy/APIProxyEndPoint/conditional.xml', strToU8('<ProxyEndPoint><name>conditional</name><conditionalFlows><flow><condition>PRIVATE_FLOW</condition><response><steps><step><policy_name>Unattached</policy_name></step></steps></response></flow></conditionalFlows><faultRules><faultRule><steps><step><policy_name>JWT</policy_name></step></steps></faultRule></faultRules></ProxyEndPoint>'));
  const result = inspectApiProxyBundle(content, 'Orders');
  assert.equal(result.policies.find(item => item.name === 'Unattached').document_present, false);
  assert.ok(result.unresolved.some(item => item.reason === 'missing_policy_document'));
  assert.ok(result.attachments.some(item => item.flow === 'conditionalFlows' && item.condition_present));
  assert.ok(result.attachments.some(item => item.flow === 'faultRules'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_FLOW'));
});

test('status projection strips URL credentials, query, fragment and unrelated tenant fields', async () => {
  const tools = new Map();
  const requests = [];
  const client = { request: async (method, path) => {
    requests.push({ method, path });
    if (path === `${APIM_BASE}/APIProxies('Orders')`) return { status: 200, data: {
      name: 'Orders', state: 'DEPLOYED', version: '2', publishUrl: 'https://private:secret@runtime.example/orders?token=PRIVATE_QUERY#PRIVATE_FRAGMENT',
      developerName: 'PRIVATE_PERSON', targetEndPoints: [{ url: 'https://backend?secret=PRIVATE_TARGET' }],
      proxyEndPoints: [{ virtualhosts: [{ virtual_host: 'runtime.example' }] }],
      deploymentInfo: [{ version: '2', state: 'DEPLOYED', publishUrl: 'PRIVATE_URL', secret: 'PRIVATE_DEPLOYMENT' }]
    } };
    throw new Error(`Unexpected ${path}`);
  } };
  registerApimInspectionTools((name, title, description, schema, annotations, handler) => tools.set(name, handler), client);
  const result = await tools.get('apim_get_api_proxy_status')({ name: 'Orders' });
  assert.equal(result.runtime_url, 'https://runtime.example/orders');
  assert.equal(result.runtime_health, 'unverified');
  assert.equal(result.state, 'DEPLOYED');
  assert.equal(result.version, '2');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(requests.length, 1);
});

test('private security reader forwards deadline and does not fall back to other routes for absent bundle', async () => {
  const requests = [];
  await assert.rejects(inspectApiProxySecurity({ request: async (...args) => { requests.push(args); return { status: 404, data: null }; } }, 'Orders', { deadline: 12345 }), /does not exist/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'GET');
  assert.equal(requests[0][1], APIM_TRANSPORT);
  assert.equal(requests[0][2].deadline, 12345);
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { createServiceClient } from '../src/integration-http.mjs';
import { buildIflowBundle, writeBundle, readBundle } from '../src/iflow-bundle.mjs';
import { readCpiContent, cpiArtifactPath } from '../src/cpi-content.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function lifecycleClient(t, tenant, { apim = false } = {}) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/lifecycle-test',
    CPI_SERVICE_KEY: tenant.serviceKey(), ...(apim ? { APIM_SERVICE_KEY: tenant.serviceKey() } : {}) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lifecycle-test', version: '1' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return client;
}
async function lifecycleCall(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
const templateArchive = (auth = 'Basic', credential = 'DefaultAlias') => buildIflowBundle({
  id: 'Orders', name: 'PRIVATE_ARTIFACT_NAME', version: '1.2.3', template: 'https-request-reply-http',
  templateParameters: { sender_path: '/PRIVATE_SENDER', receiver_address: 'https://backend.example/PRIVATE_ADDRESS?token=PRIVATE_QUERY',
    receiver_method: 'GET', receiver_authentication: auth, receiver_credential_name: credential, receiver_timeout_ms: 60000 }
});
const configuration = (ParameterKey, ParameterValue) => ({ ParameterKey, ParameterValue, DataType: 'xsd:string' });
const cert = (Alias, ValidNotBefore = '2000-01-01T00:00:00Z', ValidNotAfter = '2099-01-01T00:00:00Z') =>
  ({ Alias, Type: 'Certificate', KeyType: 'RSA', ValidNotBefore, ValidNotAfter, Subject: 'PRIVATE_PERSON' });
function contentFixture(state, request) {
  if (request.path.startsWith('/api/v1/IntegrationDesigntimeArtifacts(')) {
    if (request.path.includes("Id='Unreadable'")) return { status: 403, body: 'PRIVATE_SOURCE_ERROR' };
    if (request.path.endsWith('/$value')) return { status: 200, body: Buffer.from(state.archive) };
    if (request.path.endsWith('/Configurations')) return { status: 200, json: { d: { results: state.configurations ?? [] } } };
    return { status: 200, json: { d: { Id: /Id='([^']+)'/.exec(request.path)?.[1], Name: 'PRIVATE_ARTIFACT_NAME', Version: '1.2.3', Description: 'PRIVATE_DESCRIPTION' } } };
  }
  if (request.path.startsWith('/api/v1/IntegrationRuntimeArtifacts(')) return { status: 404 };
  if (request.path === '/api/v1/UserCredentials') return state.credentialError
    ? { status: 403, body: 'PRIVATE_SECURITY_ERROR' } : { status: 200, json: { d: { results: state.credentials ?? [] } } };
  if (request.path === '/api/v1/OAuth2ClientCredentials') return { status: 200, json: { d: { results: state.oauth ?? [] } } };
  if (request.path === '/api/v1/KeystoreEntries') return { status: 200, json: { d: { results: state.certificates ?? [] } } };
}
function assertPrivate(result) {
  const text = JSON.stringify(result);
  for (const forbidden of ['PRIVATE_', 'ParameterValue', '<bpmn', 'parameters.prop', 'receiver_address', 'ArtifactContent', 'Subject']) assert.ok(!text.includes(forbidden), forbidden);
}

test('readiness resolves fresh configured aliases over bundle defaults and configuration-only changes alter state', async t => {
  const state = { archive: templateArchive(), configurations: [configuration('Receiver_Credential_Name', 'CurrentAlias'), configuration('BusinessSecret', 'PRIVATE_VALUE_ONE')],
    credentials: Array.from({ length: 205 }, (_, index) => ({ Name: index === 204 ? 'CurrentAlias' : `Alias${index}`, User: 'PRIVATE_USER', Password: 'PRIVATE_PASSWORD' })),
    certificates: [cert('UnrelatedExpired', '2000-01-01T00:00:00Z', '2001-01-01T00:00:00Z')] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const args = { cpi_iflow_ids: ['Orders'], expected_versions: { 'cpi_iflow:Orders': '1.2.3' } };
  const first = await lifecycleCall(client, 'integration_check_release_readiness', args);
  assert.equal(first.readiness, 'needs_review');
  assert.equal(first.items[0].validation.result, 'missing');
  assert.equal(first.environment, 'default');
  assert.equal(first.hosts.cpi, new URL(tenant.url).host);
  assert.deepEqual(first.items[0].dependencies.map(item => [item.name, item.existence]), [['CurrentAlias', 'present']]);
  assert.ok(first.items[0].parameter_names.includes('BusinessSecret'));
  state.configurations[1] = configuration('BusinessSecret', 'PRIVATE_VALUE_TWO');
  const second = await lifecycleCall(client, 'integration_check_release_readiness', args);
  assert.equal(second.items[0].bundle_sha256, first.items[0].bundle_sha256);
  assert.notEqual(second.items[0].state_sha256, first.items[0].state_sha256);
  assertPrivate(first); assertPrivate(second);
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
  assert.equal(tenant.apiRequests().some(request => request.path === '/api/v1/KeystoreEntries'), false, 'unreferenced certificates are not release blockers');
});

test('literal missing aliases and version mismatches block without broadening the selected target set', async t => {
  const state = { archive: templateArchive(), credentials: [] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const result = await lifecycleCall(client, 'integration_check_release_readiness', { cpi_iflow_ids: ['Orders'], expected_versions: { 'cpi_iflow:Orders': '9.0.0' } });
  assert.equal(result.readiness, 'blocked');
  assert.ok(result.items[0].blockers.includes('missing_required_dependency'));
  assert.ok(result.items[0].blockers.includes('version_mismatch'));
  assert.equal(result.items[0].dependencies[0].name, 'DefaultAlias');
  assertPrivate(result);
});

test('only referenced expired, future or missing certificates block; valid references ignore unrelated expiry', async t => {
  const state = { archive: templateArchive('Client Certificate', 'ReceiverCert'), certificates: [cert('ReceiverCert'), cert('Unrelated', '2000-01-01T00:00:00Z', '2001-01-01T00:00:00Z')] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const args = { cpi_iflow_ids: ['Orders'] };
  assert.equal((await lifecycleCall(client, 'integration_check_release_readiness', args)).readiness, 'needs_review');
  for (const referenced of [cert('ReceiverCert', '2000-01-01T00:00:00Z', '2001-01-01T00:00:00Z'), cert('ReceiverCert', '2090-01-01T00:00:00Z', '2099-01-01T00:00:00Z')]) {
    state.certificates[0] = referenced;
    const result = await lifecycleCall(client, 'integration_check_release_readiness', args);
    assert.equal(result.readiness, 'blocked');
    assert.ok(result.items[0].blockers.includes('referenced_certificate_invalid'));
    assertPrivate(result);
  }
  state.certificates.shift();
  assert.equal((await lifecycleCall(client, 'integration_check_release_readiness', args)).items[0].dependencies[0].existence, 'missing');
});

test('dynamic credentials, custom content and unreadable sources require review while retaining independent target evidence', async t => {
  const archive = readBundle(templateArchive());
  archive.set('src/main/resources/script/private.groovy', strToU8('PRIVATE_SCRIPT'));
  const state = { archive: writeBundle(archive), configurations: [configuration('Receiver_Credential_Name', '${property.PRIVATE_DYNAMIC}')] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const result = await lifecycleCall(client, 'integration_check_release_readiness', { cpi_iflow_ids: ['Orders', 'Unreadable'] });
  assert.equal(result.readiness, 'needs_review');
  const readable = result.items.find(item => item.id === 'Orders');
  assert.ok(readable.bundle_sha256);
  assert.ok(readable.unresolved.some(item => item.reason === 'dynamic_or_unrecognized_user_credential'));
  assert.ok(readable.unresolved.some(item => item.reason === 'custom_or_shared_content'));
  assert.equal(readable.dependencies.length, 0, 'dynamic credential is not falsely classified missing');
  assert.equal(result.items.find(item => item.id === 'Unreadable').sources[0].result, 'forbidden');
  assert.equal(result.complete, false);
  assertPrivate(result);
});

test('unreadable required alias inventory stays unknown rather than missing', async t => {
  const state = { archive: templateArchive(), credentialError: true };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const result = await lifecycleCall(client, 'integration_check_release_readiness', { cpi_iflow_ids: ['Orders'] });
  assert.equal(result.readiness, 'needs_review');
  assert.equal(result.items[0].dependencies[0].existence, 'unknown');
  assert.equal(result.items[0].dependencies[0].source_result.result, 'forbidden');
  assert.equal(result.complete, false);
  assertPrivate(result);
});

test('dependency pages resume with frozen evaluation time and reject tampered/changed targets before network', async t => {
  const state = { archive: templateArchive('Client Certificate', 'ReceiverCert'), certificates: [cert('ReceiverCert')] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const args = { cpi_iflow_ids: ['Orders', 'Second'], top: 1 };
  const first = await lifecycleCall(client, 'integration_inspect_dependencies', args);
  assert.equal(first.complete, false);
  assert.equal(first.returned, 1);
  assert.ok(first.next_cursor);
  const second = await lifecycleCall(client, 'integration_inspect_dependencies', { ...args, cursor: first.next_cursor });
  assert.equal(second.complete, true);
  assert.deepEqual([first.items[0].id, second.items[0].id], ['Orders', 'Second']);
  assert.equal(first.items[0].dependencies[0].certificate.evaluated_at, second.items[0].dependencies[0].certificate.evaluated_at);
  const count = tenant.requests.length;
  for (const changed of [{ ...args, cpi_iflow_ids: ['Orders'], cursor: first.next_cursor }, { ...args, cursor: `${first.next_cursor}x` }]) {
    const response = await client.callTool({ name: 'integration_inspect_dependencies', arguments: changed });
    assert.equal(response.isError, true);
    assert.equal(tenant.requests.length, count);
  }
});

test('explicit target and expected-version key validation happens before requests', async t => {
  const tenant = await startFakeTenant(t);
  const client = await lifecycleClient(t, tenant);
  for (const [name, args] of [['integration_inspect_dependencies', {}], ['integration_check_release_readiness', {}],
    ['integration_check_release_readiness', { cpi_iflow_ids: ['Orders'], expected_versions: { 'apim_proxy:Other': '1' } }],
    ['integration_check_release_readiness', { cpi_iflow_ids: Array.from({ length: 21 }, (_, index) => `Flow${index}`) }]]) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true);
  }
  assert.equal(tenant.requests.length, 0);
});

test('private CPI content preserves original bytes, named selectors and fresh complete typed configurations', async t => {
  const archive = readBundle(templateArchive());
  archive.set('src/main/resources/binary.bin', Uint8Array.of(0, 255, 17, 128));
  const state = { archive: writeBundle(archive), configurations: [configuration('Secret', 'PRIVATE_CONFIG')] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const service = createServiceClient({ label: 'CPI', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'client', clientSecret: 'PRIVATE_SECRET', env: {} });
  const result = await readCpiContent(service, 'Orders', '1.2.3');
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(state.archive));
  assert.deepEqual([...result.files.get('src/main/resources/binary.bin')], [0, 255, 17, 128]);
  assert.equal(result.selector, '1.2.3');
  assert.equal(result.resolved_version, '1.2.3');
  assert.equal(result.configurations[0].ParameterValue, 'PRIVATE_CONFIG');
  assert.ok(tenant.apiRequests().every(request => request.path.startsWith(`/api/v1${cpiArtifactPath('Orders', '1.2.3')}`)));
});

test('APIM dependencies use exact provider/KVM identities and certificate-reference metadata without private content', async t => {
  const apimBundle = files({
    'APIProxy/Orders.xml': '<APIProxy><policies><policy type="KeyValueMapOperations">Lookup</policy><policy type="VerifyJWT">JWT</policy></policies></APIProxy>',
    'APIProxy/Policy/Lookup.xml': '<KeyValueMapOperations mapIdentifier="BackendMap"><Get><Key><Parameter>PRIVATE_ENTRY</Parameter></Key></Get></KeyValueMapOperations>',
    'APIProxy/Policy/JWT.xml': '<VerifyJWT><PublicKey><CertificateAlias>SigningCert</CertificateAlias></PublicKey></VerifyJWT>',
    'APIProxy/APIProxyEndPoint/default.xml': '<ProxyEndPoint><name>default</name><preFlow><request><steps><step><policy_name>JWT</policy_name></step></steps></request></preFlow></ProxyEndPoint>',
    'APIProxy/APITargetEndPoint/default.xml': '<TargetEndPoint><name>default</name><provider_id>BackendProvider</provider_id><preFlow><request><steps><step><policy_name>Lookup</policy_name></step></steps></request></preFlow></TargetEndPoint>'
  });
  let missingMap = false;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === APIM_TRANSPORT) return { status: 200, body: Buffer.from(writeBundle(apimBundle)) };
    if (request.path === `${APIM_BASE}/APIProxies('Orders')`) return { status: 200, json: { d: {
      name: 'Orders', version: '7', state: 'DEPLOYED', proxyEndPoints: { results: [{ virtualhosts: { results: [{ virtual_host: 'runtime.example' }] } }] }
    } } };
    if (request.path === `${APIM_BASE}/APIProviders('BackendProvider')`) return { status: 200, json: { d: { name: 'BackendProvider', password: 'PRIVATE_PROVIDER' } } };
    if (request.path === `${APIM_BASE}/KeyMapEntries('BackendMap')`) return missingMap ? { status: 404 } : { status: 200, json: { d: { name: 'BackendMap', encrypted: 'false', keyMapEntryValues: { results: [{ name: 'password', value: 'PRIVATE_KVM' }] } } } };
    if (request.path === `${APIM_BASE}/CertificateStoreReferences`) return { status: 200, json: { d: { results: [{ alias: 'SigningCert', name: 'SigningCert', type: 'Certificate',
      ValidNotBefore: '2000-01-01T00:00:00Z', ValidNotAfter: '2001-01-01T00:00:00Z', secret: 'PRIVATE_CERT' }] } } };
  });
  const client = await lifecycleClient(t, tenant, { apim: true });
  const args = { apim_proxy_names: ['Orders'], expected_versions: { 'apim_proxy:Orders': '7' } };
  const result = await lifecycleCall(client, 'integration_check_release_readiness', args);
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.items[0].version, '7');
  assert.ok(result.items[0].blockers.includes('referenced_certificate_invalid'));
  assert.deepEqual(result.items[0].dependencies.map(item => [item.kind, item.existence]), [['kvm', 'present'], ['certificate', 'present'], ['provider', 'present']]);
  assert.equal(result.items[0].policy_attachment.attachments.length, 2);
  missingMap = true;
  const next = await lifecycleCall(client, 'integration_check_release_readiness', args);
  assert.ok(next.items[0].blockers.includes('missing_required_dependency'));
  assertPrivate(result); assertPrivate(next);
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

test('sender clientCertificates externalization is resolved from fresh configuration and unresolved aliases remain review-only', async t => {
  const content = readBundle(templateArchive('None', ''));
  content.set('src/main/resources/scenarioflows/integrationflow/Orders.iflw', strToU8(
    '<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd"><bpmn2:collaboration><bpmn2:messageFlow><bpmn2:extensionElements>'
    + '<ifl:property><key>ComponentType</key><value>HTTPS</value></ifl:property>'
    + '<ifl:property><key>clientCertificates</key><value>{{AllowedCert}}</value></ifl:property>'
    + '</bpmn2:extensionElements></bpmn2:messageFlow></bpmn2:collaboration></bpmn2:definitions>'
  ));
  const state = { archive: writeBundle(content), configurations: [configuration('AllowedCert', 'SenderCert')], certificates: [cert('SenderCert')] };
  const tenant = await startFakeTenant(t, request => contentFixture(state, request));
  const client = await lifecycleClient(t, tenant);
  const args = { cpi_iflow_ids: ['Orders'] };
  const valid = await lifecycleCall(client, 'integration_check_release_readiness', args);
  assert.equal(valid.readiness, 'needs_review');
  assert.equal(valid.items[0].dependencies[0].name, 'SenderCert');
  state.certificates = [];
  assert.equal((await lifecycleCall(client, 'integration_check_release_readiness', args)).readiness, 'blocked');
  state.configurations = [configuration('AllowedCert', '${property.PRIVATE_CERT_DYNAMIC}')];
  const dynamic = await lifecycleCall(client, 'integration_check_release_readiness', args);
  assert.equal(dynamic.readiness, 'needs_review');
  assert.equal(dynamic.items[0].dependencies.length, 0);
  assertPrivate(dynamic);
});
