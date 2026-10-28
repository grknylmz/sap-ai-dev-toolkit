import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parseIntegrationServiceKey } from '../src/integration-config.mjs';
import { storeIntegrationKey } from '../src/integration-credentials.mjs';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { createIntegrationClients, verifyIntegrationClients } from '../src/integration-verify.mjs';
import { createServiceClient } from '../src/integration-http.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function connect(t, env) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', ...env }, pollIntervalMs: 1, readBackDelayMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-test-client', version: '1.0.0' });
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

const templateArgs = {
  package_id: 'ZPKG',
  iflow_id: 'Z_Flow',
  name: 'Flow',
  template: 'https-request-reply-http',
  template_parameters: {
    sender_path: '/flow',
    receiver_address: 'https://backend.example/api',
    receiver_proxy_type: 'internet',
    receiver_authentication: 'None'
  },
  confirmation: 'CREATE IFLOW Z_Flow'
};

test('only configured sides are registered', async t => {
  const tenant = await startFakeTenant(t);
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.equal(names.some(name => /^(?:apim_|devhub_|ans_|ctms_|event_mesh_|aem_|open_connectors_|edge_)/.test(name)), false);

  const both = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(), APIM_SERVICE_KEY: tenant.serviceKey() });
  const bothNames = (await both.listTools()).tools.map(tool => tool.name);
  assert.equal(bothNames.includes('apim_test_api'), true);
  assert.equal(bothNames.some(name => name.startsWith('ans_') || name.startsWith('devhub_')), false);
  const info = parsed(await call(both, 'integration_connection_info'));
  assert.equal(info.cpi.source, 'service-key');
  assert.equal(info.apim.host, new URL(tenant.url).host);
  assert.equal(JSON.stringify(info).includes('test-secret'), false);
});

test('SAP management queries retain literal system-option names without exposing reserved value delimiters', async t => {
  const name = 'A+B&$top=99';
  const tenant = await startFakeTenant(t, request => {
    if (/[?&]%24/i.test(request.rawQuery)) return { status: 400 };
    if (request.query.get('$filter') !== `name eq '${name}'` || request.query.get('$top') !== '1' || request.query.get('$select') !== 'name') return { status: 400 };
    return { status: 200, json: { d: { results: [{ name }] } } };
  });
  const client = createServiceClient({ label: 'APIM', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'client', clientSecret: 'secret', env: {} });
  const result = await client.request('GET', '/APIProducts', { query: { $filter: `name eq '${name}'`, $select: 'name', $top: 1 } });
  assert.deepEqual(result, [{ name }]);
});

test('wrong confirmation fails before any network request', async t => {
  const tenant = await startFakeTenant(t);
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const result = await call(client, 'cpi_create_iflow', { ...templateArgs, iflow_id: 'X', confirmation: 'CREATE IFLOW Y' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'confirmation must equal CREATE IFLOW X');
  assert.equal(tenant.requests.length, 0);
});

test('cpi_create_iflow posts a template bundle after a 404 existence check', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path.startsWith('/api/v1/IntegrationDesigntimeArtifacts(')) return { status: 404, json: { error: { message: { value: 'not found' } } } };
    if (request.method === 'POST' && request.path === '/api/v1/IntegrationDesigntimeArtifacts') return { status: 201, json: { d: { Id: 'Z_Flow' } } };
    return { status: 500 };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'cpi_create_iflow', templateArgs));
  assert.equal(result.created, true);
  assert.equal(result.version, '1.0.0');
  const [check, post] = tenant.apiRequests();
  assert.equal(check.path, "/api/v1/IntegrationDesigntimeArtifacts(Id='Z_Flow',Version='active')");
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.authorization, 'Bearer token-1');
  const body = JSON.parse(post.body);
  assert.equal(body.PackageId, 'ZPKG');
  const files = unzipSync(Buffer.from(body.ArtifactContent, 'base64'));
  assert.ok(files['src/main/resources/scenarioflows/integrationflow/Z_Flow.iflw']);
  assert.match(strFromU8(files['src/main/resources/parameters.prop']), /^Receiver_Proxy_Type=default$/m);
  assert.match(strFromU8(files['src/main/resources/parameters.prop']), /^Receiver_Method=GET$/m);
});

test('cpi_create_iflow refuses an existing iFlow and enforces credential names for Basic', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { Id: 'Z_Flow', Version: '1.0.0' } } }));
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const existing = await call(client, 'cpi_create_iflow', templateArgs);
  assert.equal(existing.text, 'iFlow Z_Flow already exists; use cpi_update_iflow');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 0);

  const before = tenant.requests.length;
  const basic = await call(client, 'cpi_create_iflow', {
    ...templateArgs,
    template_parameters: { ...templateArgs.template_parameters, receiver_authentication: 'Basic' }
  });
  assert.equal(basic.isError, true);
  assert.match(basic.text, /receiver_credential_name is required for Basic/);
  assert.equal(tenant.requests.length, before);
});

test('cpi_update_iflow rejects a stale expected_version without writing', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { Id: 'Z_Flow', Version: '1.0.3', Name: 'Flow' } } }));
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const result = await call(client, 'cpi_update_iflow', {
    iflow_id: 'Z_Flow',
    expected_version: '1.0.2',
    files: [{ path: 'src/main/resources/script/a.groovy', content: 'x' }],
    confirmation: 'UPDATE IFLOW Z_Flow'
  });
  assert.equal(result.text, 'iFlow Z_Flow is at version 1.0.3, not 1.0.2; re-read with cpi_get_iflow');
  assert.equal(tenant.apiRequests().some(request => request.method === 'PUT'), false);
});

test('cpi_update_iflow patches files, merges parameters, and bumps the manifest version', async t => {
  const bundle = zipSync({
    'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\r\nBundle-Version: 1.0.3\r\n'),
    'src/main/resources/parameters.prop': strToU8('Old=1\n'),
    'src/main/resources/parameters.propdef': strToU8('<parameters><parameter><name>Old</name></parameter><param_references/></parameters>'),
    'keep.txt': strToU8('kept')
  });
  const configured = new Map([['Old', { ParameterKey: 'Old', ParameterValue: '1', DataType: 'xsd:string' }]]);
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path.endsWith('/$value')) return { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(bundle) };
    if (request.method === 'GET' && request.path.endsWith('/Configurations')) return { status: 200, json: { d: { results: [...configured.values()] } } };
    if (request.method === 'GET') return { status: 200, json: { d: { Id: 'Z_Flow', Version: '1.0.3', Name: 'Flow' } } };
    if (request.method === 'PUT') {
      const parameter = /Configurations\('([^']+)'\)/.exec(request.path)?.[1];
      if (parameter) configured.set(parameter, { ParameterKey: parameter, ...JSON.parse(request.body) });
      return { status: 202 };
    }
    return { status: 500 };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'cpi_update_iflow', {
    iflow_id: 'Z_Flow',
    expected_version: '1.0.3',
    files: [{ path: 'src/main/resources/script/a.groovy', content: 'println 1' }],
    parameters: { New: 'b' },
    confirmation: 'UPDATE IFLOW Z_Flow'
  }));
  assert.equal(result.new_version, '1.0.4');
  const put = tenant.apiRequests().find(request => request.method === 'PUT');
  const files = unzipSync(Buffer.from(JSON.parse(put.body).ArtifactContent, 'base64'));
  assert.equal(strFromU8(files['keep.txt']), 'kept');
  assert.equal(strFromU8(files['src/main/resources/script/a.groovy']), 'println 1');
  assert.equal(strFromU8(files['src/main/resources/parameters.prop']), 'Old=1\nNew=b\n');
  assert.match(strFromU8(files['src/main/resources/parameters.propdef']), /<name>Old<\/name>.*<name>New<\/name>/);
  assert.match(strFromU8(files['META-INF/MANIFEST.MF']), /Bundle-Version: 1\.0\.4/);
});

test('runtime status flattens CPI JSON error information into readable text', async t => {
  const errorJson = JSON.stringify({
    message: { subsystemName: 'CONTENT', messageId: 'GenerationFailed', messageText: '' },
    parameter: ['Generation and build failed for Z_Flow', 'Request Reply 1 does not have an outgoing sequence flow']
  });
  const tenant = await startFakeTenant(t, request => {
    if (request.path === "/api/v1/IntegrationRuntimeArtifacts('Z_Flow')") return { status: 200, json: { d: { Id: 'Z_Flow', Version: '1.0.0', Status: 'ERROR' } } };
    if (request.path === "/api/v1/IntegrationRuntimeArtifacts('Z_Flow')/ErrorInformation/$value") return { status: 200, body: errorJson };
    return { status: 500 };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const status = parsed(await call(client, 'cpi_get_iflow_runtime_status', { iflow_id: 'Z_Flow' }));
  assert.equal(status.error_information, 'GenerationFailed\nGeneration and build failed for Z_Flow\nRequest Reply 1 does not have an outgoing sequence flow');
});

test('iFlow names follow the CPI naming rule before any request', async t => {
  const tenant = await startFakeTenant(t);
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  for (const name of ['Café Flow', 'Flow.', '1Flow', 'a/b']) {
    const result = await call(client, 'cpi_create_iflow', { ...templateArgs, name });
    assert.equal(result.isError, true, name);
  }
  assert.equal(tenant.requests.length, 0);
});

test('transient 5xx is retried for idempotent GET/PUT but never POST, and XML error messages are extracted', async t => {
  let packageReads = 0;
  let configurationPuts = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') {
      packageReads += 1;
      return packageReads === 1 ? { status: 500, body: 'flaky' } : { status: 200, json: { d: { results: [{ Id: 'ZPKG', Name: 'P' }] } } };
    }
    if (request.method === 'PUT') {
      configurationPuts += 1;
      return configurationPuts === 1 ? { status: 500, body: 'flaky' } : { status: 202 };
    }
    return {
      status: 500,
      headers: { 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><error><code>Internal</code><message xml:lang="en">Package store &amp; index unavailable</message></error>'
    };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  assert.deepEqual(parsed(await call(client, 'cpi_list_packages')).items, [{ Id: 'ZPKG', Name: 'P' }]);
  assert.equal(packageReads, 2);

  parsed(await call(client, 'cpi_update_iflow_configuration', { iflow_id: 'Z_Flow', parameters: [{ key: 'A', value: 'b' }], confirmation: 'CONFIGURE IFLOW Z_Flow' }));
  assert.equal(configurationPuts, 2);

  const failed = await call(client, 'cpi_create_package', { package_id: 'ZPKG', name: 'P', short_text: 'P', confirmation: 'CREATE CPI PACKAGE ZPKG' });
  assert.equal(failed.text, 'CPI POST /api/v1/IntegrationPackages failed (HTTP 500): Package store & index unavailable');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
});

test('tokens are cached and a 401 retries once with a fresh token', async t => {
  let rejectNext = false;
  const tenant = await startFakeTenant(t, request => {
    if (rejectNext && request.headers.authorization === 'Bearer token-1') return { status: 401 };
    return { status: 200, json: { d: { results: [] } } };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  parsed(await call(client, 'cpi_list_packages'));
  parsed(await call(client, 'cpi_list_packages'));
  assert.equal(tenant.tokenRequests().length, 1);
  const [token] = tenant.tokenRequests();
  assert.equal(token.headers.authorization, `Basic ${Buffer.from('client:test-secret').toString('base64')}`);
  assert.equal(token.body, 'grant_type=client_credentials');

  rejectNext = true;
  parsed(await call(client, 'cpi_list_packages'));
  assert.equal(tenant.tokenRequests().length, 2);
  const last = tenant.apiRequests().at(-1);
  assert.equal(last.headers.authorization, 'Bearer token-2');
});

test('a 403 x-csrf-token Required response fetches a token and retries with token and cookie', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path === '/api/v1/') {
      return { status: 200, headers: { 'x-csrf-token': 'csrf-1', 'set-cookie': ['JSESSIONID=abc; Path=/; HttpOnly', 'route=r1; Path=/'] } };
    }
    if (request.method === 'POST' && !request.headers['x-csrf-token']) return { status: 403, headers: { 'x-csrf-token': 'Required' } };
    if (request.method === 'POST') return { status: 201, json: { d: {} } };
    return { status: 500 };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey() });
  const result = parsed(await call(client, 'cpi_create_package', { package_id: 'ZPKG', name: 'P', short_text: 'P', confirmation: 'CREATE CPI PACKAGE ZPKG' }));
  assert.equal(result.created, true);
  const [first, fetch, retry] = tenant.apiRequests();
  assert.equal(first.method, 'POST');
  assert.equal(fetch.headers['x-csrf-token'], 'Fetch');
  assert.equal(retry.headers['x-csrf-token'], 'csrf-1');
  assert.equal(retry.headers.cookie, 'JSESSIONID=abc; route=r1');
  assert.deepEqual(JSON.parse(retry.body), { Id: 'ZPKG', Name: 'P', ShortText: 'P', Description: '', Version: '1.0.0' });
});

test('apim_create_api_proxy checks the provider before importing and returns the runtime URL', async t => {
  let providerExists = false;
  let proxyImported = false;
  const tenant = await startFakeTenant(t, request => {
    const base = '/apiportal/api/1.0/Management.svc';
    if (request.path === `${base}/APIProviders`) return { status: 200, json: { d: { results: providerExists ? [{ name: 'S4H' }] : [] } } };
    if (request.path === `${base}/APIProxies`) return { status: 200, json: { d: { results: proxyImported ? [{ name: 'ZOrders' }] : [] } } };
    if (request.path === `${base}/APIProxies('ZOrders')`) {
      if (!proxyImported) return { status: 404 };
      return {
        status: 200,
        json: { d: { name: 'ZOrders', state: 'DEPLOYED', proxyEndPoints: { results: [{ base_path: '/s4/orders', virtualhosts: { results: [{ virtual_host: 'vh.example', virtual_port: 443, isSSL: true }] } }] } } }
      };
    }
    if (request.path === '/apiportal/api/1.0/Transport.svc/APIProxies') {
      proxyImported = true;
      return { status: 200, body: '' };
    }
    return { status: 500 };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const args = {
    name: 'ZOrders',
    base_path: '/s4/orders',
    service_type: 'odata',
    target: { provider: 'S4H', relative_path: '/sap/opu/odata4/sap/zorders/srvd/sap/zorders/0001/' },
    confirmation: 'CREATE API PROXY ZOrders'
  };
  const missing = await call(client, 'apim_create_api_proxy', args);
  assert.equal(missing.isError, true);
  assert.equal(tenant.apiRequests().some(request => request.path.includes('Transport.svc')), false);

  providerExists = true;
  const result = parsed(await call(client, 'apim_create_api_proxy', args));
  assert.equal(result.runtime_url, 'https://vh.example/s4/orders');
  assert.equal(result.state, 'DEPLOYED');

  const notOdataPath = await call(client, 'apim_create_api_proxy', { ...args, target: { provider: 'S4H', relative_path: '/api/orders' } });
  assert.equal(notOdataPath.isError, true);
  assert.match(notOdataPath.text, /\/sap\/opu\/odata/);
});

test('API proxy runtime URLs keep base paths on the virtual host with or without a leading slash', async t => {
  let basePath = 'HelloWorldAPI';
  const tenant = await startFakeTenant(t, () => ({
    status: 200,
    json: { d: {
      name: 'HelloWorldAPI',
      proxyEndPoints: { results: [{
        base_path: basePath,
        virtualhosts: { results: [{ virtual_host: 'vh.example', virtual_port: 8443, isSSL: true }] }
      }] }
    } }
  }));
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  for (const path of ['HelloWorldAPI', '/HelloWorldAPI', '']) {
    basePath = path;
    const proxy = parsed(await call(client, 'apim_get_api_proxy', { name: 'HelloWorldAPI' }));
    assert.equal(proxy.runtime_url, `https://vh.example:8443${path ? '/HelloWorldAPI' : '/'}`);
    assert.equal(new URL(proxy.runtime_url).host, 'vh.example:8443');
  }
});

test('API provider reads never return credential properties', async t => {
  const tenant = await startFakeTenant(t, () => ({
    status: 200,
    json: { d: { name: 'S4H', host: 'h', password: 'pw', clientSecret: 'cs', userName: 'u', authentication: { clientId: 'x', password: 'nested' } } }
  }));
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const text = (await call(client, 'apim_get_api_provider', { name: 'S4H' })).text;
  const provider = JSON.parse(text);
  assert.equal(provider.host, 'h');
  assert.doesNotMatch(text, /"(?:password|clientSecret|userName|clientId)"/);
});

test('apim_create_api_provider rejects reserved names and sends no credentials', async t => {
  const tenant = await startFakeTenant(t, request => (request.method === 'POST'
    ? { status: 201, json: { d: {} } }
    : { status: 200, json: { d: { name: 'ZS4H', destType: 'ON_PREMISE' } } }));
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const reserved = await call(client, 'apim_create_api_provider', { name: 'TC_X', type: 'internet', host: 'h.example', port: 443, confirmation: 'CREATE API PROVIDER TC_X' });
  assert.equal(reserved.text, 'API provider name TC_X is reserved by API Management');
  assert.equal(tenant.requests.length, 0);

  const result = parsed(await call(client, 'apim_create_api_provider', {
    name: 'ZS4H', type: 'on_premise', host: 's4h-virtual', port: 44300, location_id: 'LOC1', sap_client: '100', confirmation: 'CREATE API PROVIDER ZS4H'
  }));
  assert.equal(result.created, true);
  const posts = tenant.apiRequests().filter(request => request.method === 'POST');
  assert.deepEqual(posts.map(request => request.path), [
    '/apiportal/api/1.0/Management.svc/APIProviders',
    '/apiportal/api/1.0/Management.svc/APIProviderAdditionalPropertys'
  ]);
  assert.deepEqual(JSON.parse(posts[0].body), {
    name: 'ZS4H',
    title: 'ZS4H',
    description: '',
    destType: 'ON_PREMISE',
    host: 's4h-virtual',
    port: 44300,
    useSSL: false,
    isOnPremise: true,
    authType: 'NONE',
    cloudConnectorLocation: 'LOC1'
  });
  assert.deepEqual(JSON.parse(posts[1].body), { entityId: 'ZS4H', name: 'sap-client', value: '100' });
});

test('generic readers authorize metadata projections, not functions, payloads or secret routes', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/$metadata')) {
      return { status: 200, body: '<edmx:Edmx><EntitySet Name="Applications" EntityType="apiportal.Application"/><FunctionImport Name="OAuthTokenFromCode" m:HttpMethod="GET"/></edmx:Edmx>' };
    }
    if (request.path === '/apiportal/api/1.0/Management.svc/KeyMapEntries') {
      return { status: 200, json: { d: { __count: '1', results: [{ name: 'Backend', encrypted: 'false', keyMapEntryValues: { results: [{ name: 'user', value: 'alice-private' }] } }] } } };
    }
    if (request.path.endsWith('/KeyMapEntryValues')) return { status: 200, json: { d: { results: [{ name: 'password', value: 'direct-private' }] } } };
    if (request.path.endsWith('/Configurations')) return { status: 200, json: { d: { results: [{ ParameterKey: 'Password', ParameterValue: 'config-private', DataType: 'xsd:string' }] } } };
    if (request.path.endsWith('/MessageProcessingLogs/$count')) return { status: 200, body: 'not-a-count' };
    if (request.path.endsWith("/Applications('A1')")) return { status: 200, json: { d: { id: 'A1', title: 'App', app_key: 'k-private', app_secret: 's-private' } } };
    return { status: 404 };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(), APIM_SERVICE_KEY: tenant.serviceKey() });
  for (const path of ["/APIProxies('X')/$value", '/$batch', "/APIProxies('X')/$links/apiProducts", '/APIProxies?$top=1', '/../oauth/token', "/OAuthTokenFromCode('code')", '/UnprojectedRoot']) {
    assert.equal((await call(client, 'apim_odata_get', { path })).isError, true, path);
  }
  for (const query of [{ $format: 'xml' }, { $expand: 'targetEndPoints/credentials' }, { $top: '1000000' }, { arbitrary: 'secret' }]) {
    assert.equal((await call(client, 'apim_odata_get', { path: '/APIProxies', query })).isError, true);
  }
  assert.equal(tenant.requests.length, 0);
  const metadata = parsed(await call(client, 'apim_odata_get', { path: '/$metadata' }));
  assert.equal(metadata.function_imports[0].name, 'OAuthTokenFromCode');
  const maps = parsed(await call(client, 'apim_odata_get', { path: '/KeyMapEntries', query: { $expand: 'keyMapEntryValues' } }));
  assert.equal(maps.items[0].keyMapEntryValues[0].value, '[redacted]');
  const direct = await call(client, 'apim_odata_get', { path: '/KeyMapEntryValues' });
  const configs = await call(client, 'cpi_odata_get', { path: "/IntegrationDesigntimeArtifacts(Id='X',Version='active')/Configurations" });
  const app = await call(client, 'apim_odata_get', { path: "/Applications('A1')" });
  assert.doesNotMatch([JSON.stringify(maps), direct.text, configs.text, app.text].join(''), /alice-private|direct-private|config-private|k-private|s-private/);
  assert.equal(parsed(configs).items[0].ParameterKey, 'Password');
  assert.equal((await call(client, 'cpi_odata_get', { path: '/MessageProcessingLogs/$count' })).isError, true);
});

test('integration_connection_info verify signs in and classifies every area without leaking secrets', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/api/v1/UserCredentials') return { status: 403, body: 'Forbidden' };
    if (request.path === "/api/v1/JmsBrokers('Broker1')") return { status: 404 };
    if (request.path.startsWith('/apiportal/api/1.0/Management.svc/KeyMapEntries')) return { status: 403 };
    if (request.path === '/apiportal/api/1.0/Management.svc/APIProxies') return { status: 200, json: { d: { results: [{ name: 'ZOrders' }] } } };
    if (request.path === '/apiportal/api/1.0/Transport.svc/APIProxies') {
      return request.query.get('name') === 'ZOrders' ? { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(zipSync({ 'APIProxy/ZOrders.xml': strToU8('<APIProxy/>') })) } : { status: 404 };
    }
    return { status: 200, json: { d: { results: [] } } };
  });
  const client = await connect(t, { CPI_SERVICE_KEY: tenant.serviceKey(), APIM_SERVICE_KEY: tenant.serviceKey() });
  const plain = parsed(await call(client, 'integration_connection_info'));
  assert.equal(plain.verification, undefined);
  assert.equal(tenant.apiRequests().length, 0);

  const text = (await call(client, 'integration_connection_info', { verify: true })).text;
  const { verification } = JSON.parse(text);
  assert.equal(verification.ok, true);
  const byArea = side => Object.fromEntries(side.checks.map(check => [check.area, check.result]));
  assert.equal(byArea(verification.cpi)['Packages and iFlows'], 'ok');
  assert.equal(byArea(verification.cpi)['Security material'], 'forbidden');
  assert.equal(byArea(verification.cpi)['JMS queues'], 'unavailable');
  assert.equal(byArea(verification.apim)['Key value maps'], 'forbidden');
  assert.equal(byArea(verification.apim)['Policies (proxy bundle export)'], 'ok');
  assert.equal(tenant.apiRequests().every(request => request.method === 'GET'), true);
  assert.doesNotMatch(text, /test-secret/);
});

test('verification reports a rejected client secret once as a sign-in failure', async t => {
  const tenant = await startFakeTenant(t);
  const badKey = JSON.parse(tenant.serviceKey());
  badKey.oauth.tokenurl = `${tenant.url}/oauth/rejected`;
  const report = await verifyIntegrationClients(createIntegrationClients({ cpi: parseIntegrationServiceKey('CPI', badKey) }, { env: {} }));
  assert.equal(report.ok, false);
  assert.equal(report.cpi.signed_in, false);
  assert.match(report.cpi.error, /CPI token request failed \(HTTP 404\)/);
  assert.equal(tenant.apiRequests().filter(request => request.path.startsWith('/api/v1')).length, 0);
});

test('a key stored by the setup wizard is used only when the environment has none', async t => {
  const tenant = await startFakeTenant(t);
  const configHome = await mkdtemp(join(tmpdir(), 'integration-store-'));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const path = await storeIntegrationKey('APIM', parseIntegrationServiceKey('APIM', tenant.serviceKey('stored-secret')), { XDG_CONFIG_HOME: configHome });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const storedOnly = createIntegrationServer({ env: { XDG_CONFIG_HOME: configHome } });
  assert.equal(storedOnly.connectionSummary.apim.source, 'stored-key');
  assert.equal(storedOnly.connectionSummary.cpi.configured, false);
  const fromEnvironment = createIntegrationServer({ env: { XDG_CONFIG_HOME: configHome, APIM_SERVICE_KEY: tenant.serviceKey() } });
  assert.equal(fromEnvironment.connectionSummary.apim.source, 'service-key');
  await storedOnly.close();
  await fromEnvironment.close();
});

test('policy readiness is untested without a proxy and forbidden when export is refused', async t => {
  let proxies = [];
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/apiportal/api/1.0/Transport.svc/APIProxies') return { status: 403 };
    if (request.path === '/apiportal/api/1.0/Management.svc/APIProxies') return { status: 200, json: { d: { results: proxies } } };
    return { status: 200, json: { d: { results: [] } } };
  });
  const client = await connect(t, { APIM_SERVICE_KEY: tenant.serviceKey() });
  const policyArea = async () => JSON.parse((await call(client, 'integration_connection_info', { verify: true })).text)
    .verification.apim.checks.find(check => check.area === 'Policies (proxy bundle export)');
  assert.equal((await policyArea()).result, 'untested');
  assert.equal(tenant.apiRequests().some(request => request.path.includes('Transport.svc')), false);
  proxies = [{ name: 'ZOrders' }];
  assert.equal((await policyArea()).result, 'forbidden');
});
