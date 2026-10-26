import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

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
      return bundle ? { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(zipSync(bundle)) } : { status: 404 };
    }
    if (request.path === TRANSPORT && request.method === 'POST') {
      state.uploaded = unzipSync(Buffer.from(request.body, 'base64'));
      return { status: 200, body: '' };
    }
    if (request.path === `${BASE}/APIProviders('S4H')`) return { status: 200, json: { d: { name: 'S4H' } } };
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
  assert.match(kvm, /<Get assignTo="private\.backendAuth\.user"><Key><Parameter>user<\/Parameter><\/Key><\/Get><Get assignTo="private\.backendAuth\.password"><Key><Parameter>pw<\/Parameter><\/Key><\/Get><Scope>environment<\/Scope>/);
  const basic = file('APIProxy/Policy/backendAuth.xml');
  assert.match(basic, /<Operation>Encode<\/Operation>[\s\S]*<User ref="private\.backendAuth\.user"><\/User><Password ref="private\.backendAuth\.password"><\/Password><AssignTo createNew="false">request\.header\.Authorization<\/AssignTo>/);
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

test('apim_create_api_product refuses missing proxies and deep-inserts proxies; update sends a flat merged PUT', async t => {
  const products = new Map([['Existing', { name: 'Existing', title: 'Old', description: 'd', version: '1', scope: '', isPublished: true, status_code: 'PUBLISHED', quotaCount: 5, quotaInterval: 1, quotaTimeUnit: 'minute', apiProxies: { __deferred: {} } }]]);
  const tenant = await startFakeTenant(t, request => {
    const proxy = /^\/apiportal\/api\/1\.0\/Management\.svc\/APIProxies\('([^']+)'\)$/.exec(request.path);
    if (proxy) return proxy[1] === 'Missing' ? { status: 404 } : { status: 200, json: { d: { name: proxy[1] } } };
    const product = /^\/apiportal\/api\/1\.0\/Management\.svc\/APIProducts\('([^']+)'\)$/.exec(request.path);
    if (product && request.method === 'GET') {
      const value = products.get(product[1]);
      return value ? { status: 200, json: { d: { ...value, apiProxies: { results: [{ name: 'ZOrders' }] } } } } : { status: 404 };
    }
    if (product && request.method === 'PUT') return { status: 204 };
    if (request.path === `${BASE}/APIProducts` && request.method === 'POST') {
      const body = JSON.parse(request.body);
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

  parsed(await call(client, 'apim_update_api_product', { name: 'Existing', description: 'new', quota: null, confirmation: 'UPDATE API PRODUCT Existing' }));
  const put = tenant.apiRequests().find(request => request.method === 'PUT');
  assert.equal(put.path, `${BASE}/APIProducts('Existing')`);
  assert.deepEqual(JSON.parse(put.body), {
    name: 'Existing', title: 'Old', description: 'new', version: '1', scope: '', isPublished: true, status_code: 'PUBLISHED',
    quotaCount: -99, quotaInterval: -99, quotaTimeUnit: null
  });
});

test('key value maps: create body shape, entries routed to PUT or POST, values never returned', async t => {
  const secrets = ['s3cr3t-alpha', 'p@ss "beta"', 'gamma-value', 'delta-value'];
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${BASE}/KeyMapEntries('New')`) return { status: 404 };
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
  assert.deepEqual(parsed(created), { created: true, name: 'New', encrypted: true, entries: ['user', 'password'] });
  assert.deepEqual(JSON.parse(tenant.apiRequests().find(request => request.method === 'POST').body), {
    name: 'New', encrypted: true, scope: 'ENV',
    keyMapEntryValues: [{ name: 'user', map_name: 'New', value: secrets[0] }, { name: 'password', map_name: 'New', value: secrets[1] }]
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
