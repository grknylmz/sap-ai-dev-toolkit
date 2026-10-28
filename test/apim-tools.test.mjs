import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';
import { importApiProxyBundle } from '../src/apim-content.mjs';

const BASE = '/apiportal/api/1.0/Management.svc';
const TRANSPORT = '/apiportal/api/1.0/Transport.svc/APIProxies';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

async function connect(t, env) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', ...env }, pollIntervalMs: 1, readBackDelayMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'apim-test-client', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await runtime.close();
  });
  return client;
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return { isError: response.isError === true, text: response.content[0].text };
}

function parsed(result) {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
}

/** Fake APIM serving one exported proxy bundle; records the re-imported bundle. */
async function proxyTenant(t, bundle) {
  const state = { uploaded: null };
  const tenant = await startFakeTenant(t, request => {
    if (request.path === TRANSPORT && request.method === 'GET') {
      const current = state.uploaded ?? bundle;
      return current ? { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(zipSync(current)) } : { status: 404 };
    }
    if (request.path === TRANSPORT && request.method === 'POST') {
      state.uploaded = unzipSync(Buffer.from(request.body, 'base64'));
      return { status: 200, body: '' };
    }
    if (request.path === `${BASE}/APIProviders`) return { status: 200, json: { d: { results: [{ name: 'S4H' }] } } };
    if (request.path === `${BASE}/APIProxies('ZOrders')`) {
      return { status: 200, json: { d: { name: 'ZOrders', state: 'DEPLOYED', proxyEndPoints: { results: [{ base_path: '/orders', virtualhosts: { results: [{ virtual_host: 'vh.example', virtual_port: 443, isSSL: true }] } }] } } } };
    }
    return { status: 500 };
  });
  return { tenant, state, file: path => strFromU8(state.uploaded[path]) };
}

const files = entries => Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)]));

/** [policy_name, sequence] pairs of one endpoint flow phase. */
function steps(xml, flow, phase) {
  const flowXml = new RegExp(`<${flow}>([\\s\\S]*?)</${flow}>`).exec(xml)?.[1] ?? '';
  const phaseXml = new RegExp(`<${phase}>([\\s\\S]*?)</${phase}>`).exec(flowXml)?.[1] ?? '';
  return [...phaseXml.matchAll(/<step><policy_name>([^<]*)<\/policy_name><condition>[^<]*<\/condition><sequence>(\d+)<\/sequence><\/step>/g)]
    .map(match => [match[1], Number(match[2])]);
}

const existingBundle = () => files({
  'APIProxy/ZOrders.xml': `${XML}<APIProxy><name>ZOrders</name><title>Orders</title><description>Old</description><service_code>REST</service_code>`
    + '<policies><policy type="VerifyAPIKey">checkKey</policy></policies><fileResources/></APIProxy>',
  'APIProxy/APIProxyEndPoint/default.xml': `${XML}<ProxyEndPoint default="true"><name>default</name><base_path>/orders</base_path><properties/>`
    + '<preFlow><name>PreFlow</name><request><isRequest>true</isRequest><steps>'
    + '<step><policy_name>checkKey</policy_name><condition></condition><sequence>1</sequence></step></steps></request></preFlow>'
    + '<postFlow><name>PostFlow</name></postFlow><conditionalFlows/></ProxyEndPoint>',
  'APIProxy/APITargetEndPoint/default.xml': `${XML}<TargetEndPoint><name>default</name><url>https://backend.example</url><provider_id>NONE</provider_id>`
    + '<additionalAPIProviders/><isDefault>true</isDefault><properties/><preFlow/><postFlow><name>PostFlow</name></postFlow>'
    + '<loadBalancerConfigurations><isRetry>false</isRetry></loadBalancerConfigurations></TargetEndPoint>',
  'APIProxy/Policy/checkKey.xml': '<VerifyAPIKey xmlns="http://www.sap.com/apimgmt"><APIKey ref="request.header.old"/></VerifyAPIKey>'
});

test('attaching policies keeps existing steps, replaces a re-attached policy and increments sequences', async t => {
  const { tenant, state, file } = await proxyTenant(t, existingBundle());
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const policies = [
    { name: 'checkKey', template: 'verify_api_key', params: { key_ref: 'request.header.x-key' } },
    { name: 'limit', template: 'spike_arrest', params: { rate: '30ps' }, condition: 'request.verb = "GET"' },
    { name: 'cacheIt', template: 'response_cache', params: { timeout_seconds: 60 } },
    { name: 'logic', template: 'javascript', params: { file: 'helper', script: 'var ok = 1 < 2;' } }
  ];

  const unconfirmed = await call(client, 'apim_attach_api_proxy_policies', { name: 'ZOrders', policies, confirmation: 'UPDATE API PROXY ZOrders' });
  assert.equal(unconfirmed.text, 'confirmation must equal UPDATE API PROXY POLICIES ZOrders');
  const corsOnRequest = await call(client, 'apim_attach_api_proxy_policies', {
    name: 'ZOrders',
    policies: [{ name: 'cors', template: 'cors', phase: 'request', params: { allow_methods: 'GET', allow_headers: 'apikey' } }],
    confirmation: 'UPDATE API PROXY POLICIES ZOrders'
  });
  assert.equal(corsOnRequest.isError, true);
  assert.equal(tenant.requests.length, 0);

  const result = parsed(await call(client, 'apim_attach_api_proxy_policies', { name: 'ZOrders', policies, confirmation: 'UPDATE API PROXY POLICIES ZOrders' }));
  assert.deepEqual(result.policies, ['checkKey', 'limit', 'cacheIt', 'logic']);
  assert.equal(result.steps_added, 4);
  assert.equal(result.state, 'DEPLOYED');
  assert.equal(result.accepted, true);
  assert.equal(result.content_verified, true);
  assert.equal(result.runtime_verified, false);
  assert.equal(result.outcome, 'unverified');
  assert.ok(state.uploaded);

  const proxy = file('APIProxy/APIProxyEndPoint/default.xml');
  assert.deepEqual(steps(proxy, 'preFlow', 'request'), [['checkKey', 1], ['limit', 2], ['cacheIt', 3], ['logic', 4]]);
  assert.deepEqual(steps(proxy, 'postFlow', 'response'), [['cacheIt', 1]]);
  assert.match(proxy, /<postFlow><name>PostFlow<\/name><response><isRequest>false<\/isRequest><steps>/);
  assert.match(proxy, /<condition>request\.verb = &quot;GET&quot;<\/condition>/);

  const root = file('APIProxy/ZOrders.xml');
  assert.equal(root.match(/>checkKey</g).length, 1);
  assert.match(root, /<policies><policy type="VerifyAPIKey">checkKey<\/policy><policy type="SpikeArrest">limit<\/policy><policy type="ResponseCache">cacheIt<\/policy><policy type="Javascript">logic<\/policy><\/policies>/);
  assert.match(root, /<fileResources><fileResource type="js">helper<\/fileResource><\/fileResources>/);
  assert.match(file('APIProxy/Policy/checkKey.xml'), /<APIKey ref="request\.header\.x-key"\/>/);
  assert.match(file('APIProxy/Policy/limit.xml'), /<SpikeArrest [^>]*xmlns="http:\/\/www\.sap\.com\/apimgmt"><Rate>30ps<\/Rate><\/SpikeArrest>/);
  assert.match(file('APIProxy/Policy/logic.xml'), /<ResourceURL>jsc:\/\/helper\.js<\/ResourceURL>/);
  assert.equal(file('APIProxy/FileResource/helper.js'), 'var ok = 1 < 2;');
  assert.equal(file('APIProxy/APITargetEndPoint/default.xml'), strFromU8(existingBundle()['APIProxy/APITargetEndPoint/default.xml']));
});

test('creating a secured proxy includes API-key and backend-auth policies in its first deployment', async t => {
  let imported = false;
  let uploaded = null;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === TRANSPORT && request.method === 'GET') return { status: 200, body: uploaded };
    if (request.path === `${BASE}/APIProviders`) return { status: 200, json: { d: { results: [{ name: 'S4H' }] } } };
    if (request.path === `${BASE}/APIProxies`) return { status: 200, json: { d: { results: imported ? [{ name: 'ZOrders' }] : [] } } };
    if (request.path === `${BASE}/APIProxies('ZOrders')`) return imported
      ? { status: 200, json: { d: { name: 'ZOrders', state: 'DEPLOYED' } } }
      : { status: 404 };
    if (request.path === TRANSPORT && request.method === 'POST') {
      const bundle = unzipSync(Buffer.from(request.body, 'base64'));
      const text = path => strFromU8(bundle[path]);
      assert.deepEqual(steps(text('APIProxy/APIProxyEndPoint/default.xml'), 'preFlow', 'request'), [['checkKey', 1]]);
      assert.deepEqual(steps(text('APIProxy/APITargetEndPoint/default.xml'), 'preFlow', 'request'), [['backendAuth_kvm', 1], ['backendAuth', 2]]);
      assert.match(text('APIProxy/Policy/checkKey.xml'), /<APIKey ref="request\.header\.apikey"\/>/);
      assert.match(text('APIProxy/Policy/backendAuth_kvm.xml'), /mapIdentifier="S4Creds"/);
      assert.match(text('APIProxy/Policy/backendAuth.xml'), /<AssignTo[^>]*>request\.header\.Authorization<\/AssignTo>/);
      imported = true;
      uploaded = Buffer.from(request.body, 'base64');
      return { status: 200, body: '' };
    }
    if (request.path === `${BASE}/VirtualHosts`) return { status: 200, json: { d: { results: [] } } };
    return { status: 500 };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'apim_create_api_proxy', {
    name: 'ZOrders', base_path: '/s4/orders', service_type: 'odata',
    target: { provider: 'S4H', relative_path: '/sap/opu/odata/sap/API_SALES_ORDER_SRV' },
    policies: [
      { name: 'checkKey', template: 'verify_api_key', params: {} },
      { name: 'backendAuth', template: 'basic_auth_from_kvm', params: { kvm: 'S4Creds', user_key: 'username', password_key: 'password' } }
    ],
    confirmation: 'CREATE API PROXY ZOrders'
  }));
  assert.equal(result.state, 'DEPLOYED');
  assert.equal(result.content_verified, true);
  assert.equal(result.runtime_verified, false);
  assert.equal(tenant.apiRequests().filter(request => request.path === TRANSPORT && request.method === 'POST').length, 1);
});

test('basic_auth_from_kvm adds two ordered target steps; self-closing lists and missing request phases are created', async t => {
  const { tenant, file } = await proxyTenant(t, files({
    'APIProxy/ZOrders.xml': `${XML}<APIProxy><name>ZOrders</name><policies/><fileResources/></APIProxy>`,
    'APIProxy/APIProxyEndPoint/default.xml': '<ProxyEndPoint><name>default</name><base_path>/orders</base_path>'
      + '<preFlow><name>PreFlow</name><response><isRequest>false</isRequest><steps/></response></preFlow><conditionalFlows/></ProxyEndPoint>',
    'APIProxy/APITargetEndPoint/default.xml': '<TargetEndPoint><name>default</name><url>https://b.example</url>'
      + '<preFlow><name>PreFlow</name></preFlow><postFlow><name>PostFlow</name></postFlow></TargetEndPoint>'
  }));
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'apim_attach_api_proxy_policies', {
    name: 'ZOrders',
    policies: [
      { name: 'backendAuth', template: 'basic_auth_from_kvm', params: { kvm: 'S4Creds', user_key: 'user', password_key: 'pw' } },
      { name: 'tagRequest', template: 'assign_headers', params: { message: 'request', set: { 'x-note': 'a<b & "c"' }, remove: ['Cookie'] } }
    ],
    confirmation: 'UPDATE API PROXY POLICIES ZOrders'
  }));
  assert.deepEqual(result.policies, ['backendAuth_kvm', 'backendAuth', 'tagRequest']);

  const target = file('APIProxy/APITargetEndPoint/default.xml');
  assert.deepEqual(steps(target, 'preFlow', 'request'), [['backendAuth_kvm', 1], ['backendAuth', 2]]);
  assert.match(target, /<preFlow><name>PreFlow<\/name><request><isRequest>true<\/isRequest><steps>/);

  const proxy = file('APIProxy/APIProxyEndPoint/default.xml');
  assert.match(proxy, /<preFlow><name>PreFlow<\/name><request><isRequest>true<\/isRequest><steps><step><policy_name>tagRequest<\/policy_name><condition><\/condition><sequence>1<\/sequence><\/step><\/steps><\/request><response>/);

  assert.match(file('APIProxy/ZOrders.xml'), /<policies><policy type="KeyValueMapOperations">backendAuth_kvm<\/policy><policy type="BasicAuth">backendAuth<\/policy><policy type="AssignMessage">tagRequest<\/policy><\/policies><fileResources\/>/);
  const kvm = file('APIProxy/Policy/backendAuth_kvm.xml');
  assert.match(kvm, /mapIdentifier="S4Creds"/);
  assert.match(file('APIProxy/Policy/tagRequest.xml'), /<Remove><Headers><Header name="Cookie"\/><\/Headers><\/Remove><Set><Headers><Header name="x-note">a&lt;b &amp; &quot;c&quot;<\/Header><\/Headers><\/Set>/);
});

test('apim_update_api_proxy patches the exported bundle and keeps policies, steps and other target settings', async t => {
  const { tenant, file } = await proxyTenant(t, existingBundle());
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'apim_update_api_proxy', {
    name: 'ZOrders',
    description: 'New & improved',
    base_path: '/v2/orders',
    service_type: 'odata',
    target: { provider: 'S4H', relative_path: '/sap/opu/odata/sap/ZORDERS_SRV' },
    confirmation: 'UPDATE API PROXY ZOrders'
  }));
  assert.equal(result.updated, true);
  assert.deepEqual(result.preserved_policies, ['checkKey']);

  const root = file('APIProxy/ZOrders.xml');
  assert.match(root, /<title>Orders<\/title><description>New &amp; improved<\/description><service_code>ODATA<\/service_code><policies><policy type="VerifyAPIKey">checkKey<\/policy><\/policies>/);
  assert.match(file('APIProxy/Policy/checkKey.xml'), /request\.header\.old/);
  const proxy = file('APIProxy/APIProxyEndPoint/default.xml');
  assert.match(proxy, /<base_path>\/v2\/orders<\/base_path>/);
  assert.deepEqual(steps(proxy, 'preFlow', 'request'), [['checkKey', 1]]);
  assert.equal(file('APIProxy/APITargetEndPoint/default.xml'), `${XML}<TargetEndPoint><name>default</name><provider_id>S4H</provider_id>`
    + '<relativePath>/sap/opu/odata/sap/ZORDERS_SRV</relativePath><additionalAPIProviders/><isDefault>true</isDefault><properties/><preFlow/>'
    + '<postFlow><name>PostFlow</name></postFlow><loadBalancerConfigurations><isRetry>false</isRetry></loadBalancerConfigurations></TargetEndPoint>');
});

test('apim_update_api_proxy and export report a missing proxy without importing', async t => {
  const { tenant } = await proxyTenant(t, null);
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const update = await call(client, 'apim_update_api_proxy', {
    name: 'ZOrders', base_path: '/orders', service_type: 'rest', target: { url: 'https://b.example' }, confirmation: 'UPDATE API PROXY ZOrders'
  });
  assert.equal(update.text, 'API proxy ZOrders does not exist; use apim_create_api_proxy');
  assert.equal((await call(client, 'apim_export_api_proxy', { name: 'ZOrders' })).text, 'API proxy ZOrders does not exist');
  assert.equal(tenant.apiRequests().some(request => request.method === 'POST'), false);
});

test('product creation checks membership; batch updates preserve existing product fields and membership', async t => {
  const products = new Map([['Existing', { name: 'Existing', title: 'Old', description: 'd', version: '1', scope: '', isPublished: true, status_code: 'PUBLISHED', quotaCount: 5, quotaInterval: 1, quotaTimeUnit: 'minute', apiProxies: { __deferred: {} } }]]);
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/APIProxies`) {
      const missing = request.query.get('$filter') === "name eq 'Missing'";
      return { status: 200, json: { d: { results: missing ? [] : [{ name: 'ZOrders' }] } } };
    }
    if (request.path === `${BASE}/APIProducts` && request.method === 'GET') {
      const name = /^name eq '([^']+)'$/.exec(request.query.get('$filter'))?.[1];
      return { status: 200, json: { d: { results: products.has(name) ? [{ name }] : [] } } };
    }
    const product = /^\/apiportal\/api\/1\.0\/Management\.svc\/APIProducts\('([^']+)'\)$/.exec(request.path);
    if (product && request.method === 'GET') {
      const value = products.get(product[1]);
      return value ? { status: 200, json: { d: { ...value, apiProxies: { results: [{ name: 'ZOrders' }] } } } } : { status: 404 };
    }
    if (request.path === `${BASE}/$batch` && request.method === 'POST') {
      const match = /PUT APIProducts\(name='([^']+)'\) HTTP\/1\.1\r\nContent-Type: application\/json\r\nAccept: application\/json\r\n\r\n([^\r\n]*)\r\n--/.exec(request.body);
      if (!match || !request.headers['content-type'].startsWith('multipart/mixed; boundary=')
        || /(?<!\r)\n/.test(request.body)) return { status: 400 };
      products.set(match[1], { ...products.get(match[1]), ...JSON.parse(match[2]) });
      return { status: 202, headers: { 'content-type': 'multipart/mixed; boundary=batch_response' }, body: '--batch_response\r\nContent-Type: multipart/mixed; boundary=changeset_response\r\n\r\n--changeset_response\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n\r\n--changeset_response--\r\n--batch_response--\r\n' };
    }
    if (request.path === `${BASE}/APIProducts` && request.method === 'POST') {
      const body = JSON.parse(request.body);
      if (!['DRAFT', 'PUBLISHED'].includes(body.status_code)) return { status: 500 };
      products.set(body.name, body);
      return { status: 201, json: { d: body } };
    }
    return { status: 500 };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });

  const missing = await call(client, 'apim_create_api_product', { name: 'Orders', proxies: ['ZOrders', 'Missing'], confirmation: 'CREATE API PRODUCT Orders' });
  assert.equal(missing.text, 'API proxy Missing does not exist; nothing was created');
  assert.equal(tenant.apiRequests().some(request => request.method !== 'GET'), false);

  const created = parsed(await call(client, 'apim_create_api_product', {
    name: 'Orders', title: 'Orders API', proxies: ['ZOrders'], quota: { count: 100, interval: 1, time_unit: 'hour' }, confirmation: 'CREATE API PRODUCT Orders'
  }));
  assert.deepEqual(created.product.api_proxies, ['ZOrders']);
  const post = tenant.apiRequests().find(request => request.method === 'POST');
  assert.equal(post.path, `${BASE}/APIProducts`);
  assert.deepEqual(JSON.parse(post.body), {
    name: 'Orders', title: 'Orders API', description: '', version: '1', scope: '', isPublished: true, status_code: 'PUBLISHED',
    quotaCount: 100, quotaInterval: 1, quotaTimeUnit: 'hour',
    apiProxies: [{ __metadata: { uri: "APIProxies(name='ZOrders')" } }]
  });

  const draft = parsed(await call(client, 'apim_create_api_product', {
    name: 'DraftOrders', proxies: ['ZOrders'], publish: false, confirmation: 'CREATE API PRODUCT DraftOrders'
  }));
  assert.equal(draft.product.isPublished, false);
  assert.equal(draft.product.status_code, 'DRAFT');
  const unpublished = parsed(await call(client, 'apim_update_api_product', { name: 'Orders', publish: false, confirmation: 'UPDATE API PRODUCT Orders' }));
  assert.equal(unpublished.product.isPublished, false);
  assert.equal(unpublished.product.status_code, 'DRAFT');

  const updated = parsed(await call(client, 'apim_update_api_product', { name: 'Existing', description: 'new', quota: null, confirmation: 'UPDATE API PRODUCT Existing' }));
  assert.equal(updated.updated, true);
  assert.equal(updated.product.description, 'new');
  assert.equal(updated.product.title, 'Old');
  assert.equal(updated.product.isPublished, true);
  assert.equal(updated.product.quotaCount, -99);
  assert.equal(updated.product.quotaInterval, -99);
  assert.equal(updated.product.quotaTimeUnit, null);
  assert.deepEqual(updated.product.api_proxies, ['ZOrders']);
  assert.equal(tenant.apiRequests().some(request => request.method === 'PUT'), false);
});

test('encrypted maps can be created without collection filtering; entry failures stop later writes and secrets stay private', async t => {
  const secrets = ['s3cr3t-alpha', 'p@ss "beta"', 'gamma-value', 'delta-value'];
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/KeyMapEntries` && request.method === 'GET') return { status: 500 };
    if (request.path === `${BASE}/KeyMapEntries('New')` && request.method === 'GET') return { status: 404 };
    if (request.path === `${BASE}/KeyMapEntries` && request.method === 'POST') return { status: 201, json: { d: JSON.parse(request.body) } };
    if (request.path === `${BASE}/KeyMapEntries('Creds')`) {
      return { status: 200, json: { d: { name: 'Creds', encrypted: true, scope: 'ENV', keyMapEntryValues: { results: [{ name: 'a', map_name: 'Creds', value: secrets[0] }, { name: 'b', map_name: 'Creds', value: secrets[2] }] } } } };
    }
    if (request.path === `${BASE}/KeyMapEntryValues(map_name='Creds',name='a')`) return { status: 204 };
    if (request.path === `${BASE}/KeyMapEntryValues` && request.method === 'POST') return { status: 201, json: { d: {} } };
    if (request.path === `${BASE}/KeyMapEntryValues(map_name='Creds',name='b')`) {
      return { status: 400, json: { error: { message: { value: `invalid value ${JSON.parse(request.body).value}` } } } };
    }
    return { status: 500 };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });

  const created = await call(client, 'apim_create_key_value_map', {
    name: 'New', entries: [{ name: 'user', value: secrets[0] }, { name: 'password', value: secrets[1] }], confirmation: 'CREATE KEY VALUE MAP New'
  });

  const read = await call(client, 'apim_get_key_value_map', { name: 'Creds' });
  assert.deepEqual(parsed(read).entries, [{ name: 'a', value: '[redacted]' }, { name: 'b', value: '[redacted]' }]);

  const before = tenant.apiRequests().length;
  const set = await call(client, 'apim_set_key_value_map_entries', {
    name: 'Creds',
    entries: [{ name: 'a', value: secrets[1] }, { name: 'c', value: secrets[3] }, { name: 'b', value: secrets[2] }, { name: 'd', value: 'never-sent' }],
    confirmation: 'UPDATE KEY VALUE MAP Creds'
  });
  const result = parsed(set);
  assert.deepEqual(result.updated, ['a']);
  assert.deepEqual(result.created, ['c']);
  assert.equal(result.failed.name, 'b');
  assert.match(result.failed.error, /HTTP 400/);
  const writes = tenant.apiRequests().slice(before).filter(request => request.method !== 'GET');
  assert.deepEqual(writes.map(request => `${request.method} ${request.path.slice(BASE.length)}`), [
    "PUT /KeyMapEntryValues(map_name='Creds',name='a')",
    'POST /KeyMapEntryValues',
    "PUT /KeyMapEntryValues(map_name='Creds',name='b')"
  ]);
  assert.deepEqual(JSON.parse(writes[1].body), { map_name: 'Creds', name: 'c', value: secrets[3] });

  for (const text of [created.text, read.text, set.text]) {
    for (const secret of secrets) assert.equal(text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)), false, `${secret} leaked`);
  }
});

test('creating an existing encrypted map refuses to overwrite its credentials', async t => {
  let writes = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/KeyMapEntries('Creds')` && request.method === 'GET') {
      return { status: 200, json: { d: { name: 'Creds', encrypted: true, scope: 'ENV' } } };
    }
    if (request.method !== 'GET') writes += 1;
    return { status: 500 };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const result = await call(client, 'apim_create_key_value_map', {
    name: 'Creds', entries: [{ name: 'password', value: 'replacement-secret' }], confirmation: 'CREATE KEY VALUE MAP Creds'
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /already exists/);
  assert.equal(result.text.includes('replacement-secret'), false);
  assert.equal(writes, 0);
});

test('apim_update_api_provider merges the current provider and refuses credentialed providers', async t => {
  const providers = {
    S4H: { name: 'S4H', title: 'S4', description: 'd', destType: 'OnPremise', authType: 'NOAUTH', host: 's4h-virtual', port: '44300', useSSL: false, isOnPremise: true, cloudConnectorLocation: 'LOC1' },
    Basic: { name: 'Basic', destType: 'Internet', authType: 'BASIC', host: 'b.example', port: 443 }
  };
  const tenant = await startFakeTenant(t, request => {
    const match = /^\/apiportal\/api\/1\.0\/Management\.svc\/APIProviders\('([^']+)'\)(\/additionalProperties)?$/.exec(request.path);
    if (match && request.method === 'GET') return match[2] ? { status: 200, json: { d: { results: [] } } } : { status: 200, json: { d: providers[match[1]] } };
    if (match && request.method === 'PUT') return { status: 204 };
    return { status: 500 };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const refused = await call(client, 'apim_update_api_provider', { name: 'Basic', port: 8443, confirmation: 'UPDATE API PROVIDER Basic' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /authType BASIC/);

  parsed(await call(client, 'apim_update_api_provider', { name: 'S4H', port: 44301, confirmation: 'UPDATE API PROVIDER S4H' }));
  const puts = tenant.apiRequests().filter(request => request.method === 'PUT');
  assert.deepEqual(puts.map(request => request.path), [`${BASE}/APIProviders('S4H')`]);
  assert.deepEqual(JSON.parse(puts[0].body), {
    name: 'S4H', title: 'S4', description: 'd', destType: 'ON_PREMISE', host: 's4h-virtual', port: 44301, useSSL: false, isOnPremise: true, authType: 'NONE', cloudConnectorLocation: 'LOC1'
  });
});

test('provider creation reports a completed write separately from failed read-back', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST' && request.path === `${BASE}/APIProviders`) return { status: 201, json: { d: { name: 'S4H' } } };
    if (request.method === 'POST' && request.path === `${BASE}/APIProviderAdditionalPropertys`) return { status: 201 };
    return { status: 400, json: { error: { message: { value: 'Read-back unavailable' } } } };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'apim_create_api_provider', {
    name: 'S4H', type: 'on_premise', host: 's4h-virtual', port: 1443,
    sap_client: '100', confirmation: 'CREATE API PROVIDER S4H'
  }));
  assert.equal(result.created, true);
  assert.equal(result.name, 'S4H');
  assert.equal(result.provider, null);
  assert.match(result.read_back_error, /HTTP 400.*Read-back unavailable/);
  assert.deepEqual(tenant.apiRequests().filter(request => request.method === 'POST').map(request => request.path), [
    `${BASE}/APIProviders`, `${BASE}/APIProviderAdditionalPropertys`
  ]);
});

test('APIM lists preserve counts and resume V2 pages without server next links', async t => {
  const fixtures = Array.from({ length: 25 }, (_, index) => ({
    name: `Object${String(index).padStart(2, '0')}`, title: `Object ${index}`, encrypted: false, scope: 'ENV',
    password: 'provider-password-private', keyMapEntryValues: [{ name: 'credential', value: 'kvm-value-private' }]
  }));
  const collections = new Map([
    ['/APIProviders', 'apim_list_api_providers'],
    ['/APIProxies', 'apim_list_api_proxies'],
    ['/APIProducts', 'apim_list_api_products'],
    ['/KeyMapEntries', 'apim_list_key_value_maps']
  ]);
  const tenant = await startFakeTenant(t, request => {
    if (!collections.has(request.path.slice(BASE.length))) return { status: 404 };
    const skip = Number(request.query.get('$skip') ?? 0);
    const size = Math.min(Number(request.query.get('$top') ?? 100), 3);
    return { status: 200, json: { d: { __count: '25', results: fixtures.slice(skip, skip + size) } } };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  for (const name of collections.values()) {
    const seen = [];
    let cursor;
    do {
      const result = await call(client, name, { top: 3, ...(cursor ? { cursor } : {}) });
      const page = parsed(result);
      assert.equal(page.total, 25);
      assert.equal(page.returned, page.items.length);
      assert.ok(page.returned > 0 && page.returned <= 3);
      assert.equal(page.complete, page.next_cursor === null);
      assert.equal(page.stop_reason, page.complete ? 'end' : 'more');
      assert.equal(result.text.includes('provider-password-private'), false);
      assert.equal(result.text.includes('kvm-value-private'), false);
      seen.push(...page.items.map(item => item.name));
      cursor = page.next_cursor;
      assert.ok(seen.length <= 25, 'listing must make forward progress without duplicates');
    } while (cursor);
    assert.deepEqual(seen, fixtures.map(item => item.name));
  }
});

test('virtual hosts use bounded local pages without invented OData options or totals', async t => {
  const hosts = Array.from({ length: 205 }, (_, id) => ({ id, virtual_host: `host${id}.example`, privateKey: 'host-key-private' }));
  const tenant = await startFakeTenant(t, request => {
    if (request.path !== `${BASE}/VirtualHosts`) return { status: 404 };
    assert.equal(request.query.size, 0);
    return { status: 200, json: { d: { results: hosts } } };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const first = parsed(await call(client, 'apim_list_virtual_hosts'));
  assert.equal(first.returned, 100);
  assert.equal(first.total, null);
  assert.equal(first.complete, false);
  const secondResult = await call(client, 'apim_list_virtual_hosts', { cursor: first.next_cursor, top: 200 });
  const second = parsed(secondResult);
  assert.equal(second.returned, 105);
  assert.equal(second.complete, true);
  assert.equal(second.next_cursor, null);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), hosts.map(item => item.id));
  assert.equal(secondResult.text.includes('host-key-private'), false);
});

test('key value map values remain write-only for every encryption representation', async t => {
  const flags = [true, false, 'true', 'false'];
  const privateValue = 'unencrypted-map-value-private';
  const tenant = await startFakeTenant(t, request => {
    const match = /\/KeyMapEntries\('Map([0-3])'\)$/.exec(request.path);
    if (!match) return { status: 404 };
    return { status: 200, json: { d: {
      name: `Map${match[1]}`, encrypted: flags[Number(match[1])], scope: 'ENV',
      keyMapEntryValues: { results: [{ name: 'credential', value: privateValue }] }
    } } };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  for (let index = 0; index < flags.length; index++) {
    const result = await call(client, 'apim_get_key_value_map', { name: `Map${index}` });
    assert.equal(result.text.includes(privateValue), false);
  }
});

test('import evidence distinguishes stale content, full resources and old deployed metadata', async () => {
  const source = existingBundle();
  source['APIProxy/FileResource/binary.bin'] = new Uint8Array([0, 255, 1, 128]);
  const intended = { ...source, 'APIProxy/Policy/checkKey.xml': strToU8('<VerifyAPIKey>new</VerifyAPIKey>') };
  for (const scenario of ['stale', 'exact', 'lost_binary', 'extra_resource', 'read_failure']) {
    let posts = 0;
    let exports = 0;
    let reads = 0;
    let observed = scenario === 'stale' ? source : { ...intended };
    if (scenario === 'lost_binary') delete observed['APIProxy/FileResource/binary.bin'];
    if (scenario === 'extra_resource') observed['APIProxy/FileResource/unexpected.js'] = strToU8('private source');
    const client = { request: async (method, path, options) => {
      if (method === 'POST') {
        posts += 1;
        assert.equal(path, TRANSPORT);
        assert.deepEqual(unzipSync(Buffer.from(options.body, 'base64')), intended);
        return { status: 201, data: '' };
      }
      if (path === TRANSPORT) {
        exports += 1;
        if (scenario === 'read_failure') throw new Error('private configuration token');
        return { status: 200, data: zipSync(observed) };
      }
      reads += 1;
      return { status: 200, data: { name: 'ZOrders', state: 'DEPLOYED', publishUrl: 'https://gateway.example/orders?private=secret', proxyEndPoints: { results: [{ virtualhosts: { results: [{ virtual_host: 'gateway.example' }] } }] } } };
    } };
    const result = await importApiProxyBundle(client, 'ZOrders', zipSync(intended), { readBackDelayMs: 0 });
    assert.equal(posts, 1, scenario);
    assert.equal(result.accepted, true, scenario);
    assert.equal(result.content_verified, scenario === 'exact', scenario);
    assert.equal(result.read_back_verified, scenario === 'exact', scenario);
    assert.equal(result.runtime_verified, false, scenario);
    assert.equal(result.outcome, 'unverified', scenario);
    assert.equal(result.runtime_url, 'https://gateway.example/orders', scenario);
    assert.ok(exports <= 4 && reads <= 4, scenario);
    assert.equal(JSON.stringify(result).includes('private configuration token'), false);
    assert.equal(JSON.stringify(result).includes('private source'), false);
    assert.equal(JSON.stringify(result).includes('private=secret'), false);
    assert.deepEqual(result.effects, { draft_created_or_replaced: true, new_revision_imported: true, deployment_requested: true });
  }
});

test('import acceptance survives metadata failure and read-back deadline without another POST', async () => {
  let posts = 0;
  const bytes = zipSync(existingBundle());
  const client = { request: async (method, path) => {
    if (method === 'POST') { posts += 1; return { status: 200, data: '' }; }
    if (path === TRANSPORT) return { status: 200, data: bytes };
    throw new Error('private echoed request');
  } };
  const exact = await importApiProxyBundle(client, 'ZOrders', bytes, { readBackDelayMs: 0 });
  assert.equal(exact.accepted, true);
  assert.equal(exact.content_verified, true);
  assert.equal(exact.runtime_verified, false);
  assert.match(exact.runtime_read_back_error, /withheld/);
  const expired = await importApiProxyBundle(client, 'ZOrders', bytes, { deadline: Date.now() - 1 });
  assert.equal(expired.accepted, true);
  assert.equal(expired.content_verified, false);
  assert.equal(expired.stop_reason, 'deadline');
  assert.equal(expired.read_back_attempts, 0);
  assert.equal(posts, 2);
});
