import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { bundleJwtIssuers } from '../src/apim-bundle.mjs';
import { parseApiDocumentation, summarizeApiDocumentation } from '../src/apim-documentation.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const BASE = '/apiportal/api/1.0/Management.svc';
const TRANSPORT = '/apiportal/api/1.0/Transport.svc/APIProxies';
const DOC = 'APIProxy/Documentation/SWAGGER_JSON_en.html';
const specification = () => ({
  openapi: '3.0.3', info: { title: 'Orders', version: '2.1.0' }, servers: [{ url: 'https://gateway.example.com/orders' }],
  security: [{ access: ['orders.read'] }],
  components: { securitySchemes: { access: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://identity.example.com/oauth/token', scopes: { 'orders.read': 'Read orders' } } } } } },
  paths: { '/Orders': { get: { operationId: 'listOrders', summary: 'List orders', parameters: [{ name: '$top', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Orders', content: { 'application/json': { example: { privateExample: 'never returned' } } } } } } } }
});
const bundle = () => Object.fromEntries(Object.entries({
  'APIProxy/Orders.xml': '<ns0:APIProxy xmlns:ns0="http://www.sap.com/apimgmt"><ns0:name>Orders</ns0:name><ns0:proxyEndPoints><ns0:proxyEndPoint><ns0:proxyEndPointName>default</ns0:proxyEndPointName><ns0:apiResourceName>SWAGGER_JSON</ns0:apiResourceName></ns0:proxyEndPoint></ns0:proxyEndPoints><ns0:policies><ns0:policy type="VerifyJWT">access</ns0:policy><ns0:policy type="BasicAuthentication">backend</ns0:policy></ns0:policies></ns0:APIProxy>',
  'APIProxy/APIResource/SWAGGER_JSON.xml': '<APIResource xmlns="http://www.sap.com/apimgmt"><name>SWAGGER_JSON</name><canShowGet>false</canShowGet><canShowPost>false</canShowPost><canShowPut>false</canShowPut><canShowDelete>false</canShowDelete><canShowHead>false</canShowHead><canShowOption>false</canShowOption><canShowPatch>false</canShowPatch><isGetChecked>false</isGetChecked><isPostChecked>false</isPostChecked><isPutChecked>false</isPutChecked><isDeleteChecked>false</isDeleteChecked><isHeadChecked>false</isHeadChecked><isOptionChecked>false</isOptionChecked><isPatchChecked>false</isPatchChecked><resource_path>SWAGGER_JSON</resource_path><proxyEndPointName>default</proxyEndPointName><documentations><documentation locale="en" mimeType="json">SWAGGER_JSON</documentation></documentations></APIResource>',
  [DOC]: JSON.stringify({ ...specification(), info: { title: 'Old orders', version: '1.0.0' } }),
  'APIProxy/Policy/access.xml': '<VerifyJWT xmlns="http://www.sap.com/apimgmt"><Issuer>https://identity.example.com/oauth/token</Issuer></VerifyJWT>',
  'APIProxy/Policy/backend.xml': '<BasicAuthentication><Operation>Encode</Operation><User ref="private.backend.user"/><Password ref="private.backend.password"/></BasicAuthentication>',
  'APIProxy/APITargetEndPoint/default.xml': '<TargetEndPoint><provider_id>BackendProvider</provider_id><relativePath>/sap/opu/odata/service/</relativePath><properties><property name="keep">yes</property></properties></TargetEndPoint>',
  'APIProxy/FileResource/route.js': 'var route = "fixed-allowlist";',
  'unknown.bin': 'untouched unknown data'
}).map(([path, text]) => [path, strToU8(text)]));

async function setup(t, { source = bundle(), readBack, batchResponse, proxyMetadata = {} } = {}) {
  let current = source;
  const state = { imports: 0, exports: 0, uploaded: null };
  const tenant = await startFakeTenant(t, request => {
    if (request.path === TRANSPORT && request.method === 'GET') {
      state.exports += 1;
      return { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(zipSync(current)) };
    }
    if (request.path === TRANSPORT && request.method === 'POST') {
      state.imports += 1;
      state.uploaded = unzipSync(Buffer.from(request.body, 'base64'));
      current = typeof readBack === 'function' ? readBack(state.uploaded) : readBack ?? state.uploaded;
      return { status: 200, body: '' };
    }
    if (request.path === `${BASE}/APIProxies('Orders')`) return { status: 200, json: { d: { name: 'Orders', state: 'DEPLOYED', publishUrl: 'https://gateway.example.com/orders', proxyEndPoints: { results: [{ virtualhosts: { results: [{ virtual_host: 'gateway.example.com' }] } }] }, ...proxyMetadata } } };
    if (request.path === `${BASE}/APIProducts('Orders')`) return { status: 200, json: { d: { name: 'Orders', title: 'Old', isPublished: false, apiProxies: { results: [{ name: 'Orders' }] } } } };
    if (request.path === `${BASE}/$batch`) return { status: 202, headers: { 'content-type': 'multipart/mixed; boundary=result' }, body: batchResponse };
    return { status: 500 };
  });
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', APIM_SERVICE_KEY: tenant.serviceKey() }, readBackDelayMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'documentation-consumer', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await runtime.close(); });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, text: result.content[0].text };
  };
  return { call, state, tenant };
}

const update = (call, spec = specification(), confirmation = 'UPDATE API DOCUMENTATION Orders') => call('apim_update_api_documentation', { name: 'Orders', openapi_json: JSON.stringify(spec), confirmation });

test('documentation update preserves backend security, routing and unknown bytes; getter decodes real JSON', async t => {
  const source = bundle();
  const { call, state } = await setup(t, { source });
  const response = await update(call);
  assert.equal(response.error, false, response.text);
  const result = JSON.parse(response.text);
  assert.equal(result.read_back_verified, true);
  assert.equal(result.operation_count, 1);
  assert.equal(result.version, '2.1.0');
  assert.match(result.submitted_sha256, /^[a-f0-9]{64}$/);
  assert.equal(state.imports, 1);
  assert.equal(state.exports, 2);
  for (const [path, bytes] of Object.entries(source)) if (path !== DOC) assert.deepEqual(state.uploaded[path], bytes, path);
  assert.deepEqual(JSON.parse(strFromU8(state.uploaded[DOC])), specification());
  const read = await call('apim_get_api_documentation', { name: 'Orders', path: '/Orders', method: 'get' });
  assert.equal(read.error, false, read.text);
  const summary = JSON.parse(read.text);
  assert.equal(summary.title, 'Orders');
  assert.equal(summary.security_schemes[0].type, 'oauth2');
  assert.deepEqual(summary.operation.parameters, [{ name: '$top', in: 'query', required: false, type: 'integer', ref: null }]);
  assert.deepEqual(summary.operation.response_statuses, ['200']);
  assert.equal(read.text.includes('privateExample'), false);
});

test('confirmation and external references fail before network; mismatched runtime fails before mutation', async t => {
  const { call, state, tenant } = await setup(t);
  assert.equal((await update(call, specification(), 'UPDATE API PROXY Orders')).error, true);
  assert.equal(tenant.requests.length, 0);
  const oversized = await call('apim_update_api_documentation', { name: 'Orders', openapi_json: ' '.repeat(1024 * 1024 + 1), confirmation: 'UPDATE API DOCUMENTATION Orders' });
  assert.equal(oversized.error, true);
  assert.equal(tenant.requests.length, 0);
  const external = specification();
  external.paths['/Orders'].get.responses['200'] = { $ref: 'https://schemas.example.com/orders.json' };
  assert.equal((await update(call, external)).error, true);
  assert.equal(tenant.requests.length, 0);
  for (const url of ['https://elsewhere.example.com/orders', 'https://gateway.example.com/other', 'https://user:password@gateway.example.com/orders']) {
    const mismatch = specification(); mismatch.servers[0].url = url;
    assert.equal((await update(call, mismatch)).error, true, url);
  }
  assert.equal(state.imports, 0);
});

test('unregistered, mismatched or ambiguous documentation layouts never import', async t => {
  for (const change of [
    source => { delete source['APIProxy/APIResource/SWAGGER_JSON.xml']; },
    source => { source['APIProxy/APIResource/SWAGGER_JSON.xml'] = strToU8('<APIResource><name>OTHER</name><documentations/></APIResource>'); },
    source => { source['APIProxy/Orders.xml'] = strToU8('<APIProxy><name>Orders</name><proxyEndPoints/></APIProxy>'); },
    source => { source['APIProxy/APIResource/SWAGGER_JSON.xml'] = strToU8(strFromU8(source['APIProxy/APIResource/SWAGGER_JSON.xml']).replace('locale="en"', 'locale="de"')); },
    source => { source['APIProxy/APIResource/SWAGGER_JSON.xml'] = strToU8(strFromU8(source['APIProxy/APIResource/SWAGGER_JSON.xml']).replace('<resource_path>SWAGGER_JSON</resource_path>', '<resource_path>OTHER</resource_path>')); },
    source => { source['APIProxy/Other.xml'] = strToU8('<APIProxy><name>Other</name></APIProxy>'); },
    source => { source['APIProxy/APIResource/SWAGGER_JSON.xml'] = strToU8(strFromU8(source['APIProxy/APIResource/SWAGGER_JSON.xml']).replace('</documentations>', '<documentation locale="en" mimeType="json">OTHER</documentation></documentations>')); }
  ]) {
    const source = bundle(); change(source);
    const { call, state } = await setup(t, { source });
    const result = await update(call);
    assert.equal(result.error, true, result.text);
    assert.equal(state.imports, 0);
  }
});

test('readback mismatch retains acceptance without claiming a successful update', async t => {
  const { call, state } = await setup(t, { readBack: bundle() });
  const response = await update(call);
  assert.equal(response.error, false, response.text);
  const result = JSON.parse(response.text);
  assert.equal(result.accepted, true);
  assert.equal(result.updated, false);
  assert.equal(result.content_verified, false);
  assert.equal(result.runtime_verified, false);
  assert.equal(result.outcome, 'unverified');
  assert.match(result.content_read_back_error, /read-back differs/);
  assert.equal(state.imports, 1);
  const observed = await call('apim_get_api_documentation', { name: 'Orders' });
  assert.equal(observed.error, false, observed.text);
  assert.equal(JSON.parse(observed.text).title, 'Old orders');
});

test('portal metadata synchronization is verified without accepting operation or server changes', async t => {
  for (const mutation of ['portal', 'response', 'server', 'example']) {
    const spec = specification();
    spec.paths['/Orders'].get.description = 'Read orders.\n\nExactly one system scope.';
    spec.components.schemas = { Order: { type: 'object', description: 'API result -> order' } };
    spec.paths['/Orders'].get.parameters[0].description = 'Page size.\n\nOne request.';
    const { call } = await setup(t, {
      proxyMetadata: { title: 'Portal orders', description: 'Portal description' },
      readBack: uploaded => {
        const actual = JSON.parse(strFromU8(uploaded[DOC]));
        actual.info.title = 'Portal orders';
        actual.info.description = 'Portal description';
        actual.info['x-targetEndpoint'] = 'https://gateway.example.com:443/orders';
        actual.servers = [{ url: 'https://gateway.example.com:443/orders' }];
        actual.paths['/Orders'].get.description = 'Read orders. Exactly one system scope.';
        if (mutation === 'response') actual.paths['/Orders'].get.responses['200'].content = {};
        actual.components.schemas.Order.description = 'API result -&gt; order';
        if (mutation === 'server') actual.servers[0].url = 'https://elsewhere.example.com/orders';
        if (mutation === 'example') actual.paths['/Orders'].get.responses['200'].content['application/json'].example.privateExample = 'changed';
        return { ...uploaded, [DOC]: strToU8(JSON.stringify(actual)) };
      }
    });
    const response = await update(call, spec);
    assert.equal(response.error, false, response.text);
    const result = JSON.parse(response.text);
    assert.equal(result.accepted, true);
    assert.equal(result.updated, mutation === 'portal');
    assert.equal(result.content_verified, mutation === 'portal');
    if (mutation === 'portal') assert.equal(result.read_back_normalized, true);
    else assert.match(result.content_read_back_error, /read-back differs/);
  }
});

test('OpenAPI 2 retains internal references and rejects non-HTTPS and unversioned documents', () => {
  const spec = { swagger: '2.0', info: { title: 'Orders', version: '1' }, host: 'gateway.example.com', basePath: '/orders', schemes: ['https'], paths: { '/Orders': { get: { responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Order' } } } } } }, definitions: { Order: { type: 'object' } } };
  assert.equal(parseApiDocumentation(JSON.stringify(spec), 'https://gateway.example.com/orders').spec.swagger, '2.0');
  assert.throws(() => parseApiDocumentation(JSON.stringify({ ...spec, schemes: ['http'] })));
  assert.throws(() => parseApiDocumentation(JSON.stringify({ ...spec, info: { title: 'Orders' } })));
});

test('outer batch acceptance cannot conceal embedded product update failure or missing status', async t => {
  for (const body of [
    '--result\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":{"message":{"value":"rejected"}}}\r\n--result--\r\n',
    '--result\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"error":{"message":{"value":"rejected"}}}\r\n--result--\r\n',
    '--result--\r\n'
  ]) {
    const { call, tenant } = await setup(t, { batchResponse: body });
    const result = await call('apim_update_api_product', { name: 'Orders', publish: true, confirmation: 'UPDATE API PRODUCT Orders' });
    assert.equal(result.error, true, result.text);
    assert.equal(result.text.includes('"updated": true'), false);
    assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
    assert.equal(tenant.apiRequests().filter(request => request.method === 'PUT').length, 0);
  }
});

test('JWT issuer discovery trusts registered VerifyJWT XML only and rejects dynamic or credential URLs', () => {
  const files = new Map(Object.entries(bundle()));
  files.set('APIProxy/Policy/unregistered.xml', strToU8('<VerifyJWT><Issuer>https://attacker.example.com/oauth/token</Issuer></VerifyJWT>'));
  files.set('APIProxy/Policy/backend.xml', strToU8('<BasicAuthentication><Issuer>https://attacker.example.com/oauth/token</Issuer></BasicAuthentication>'));
  assert.deepEqual(bundleJwtIssuers(files, 'Orders'), ['https://identity.example.com/oauth/token']);
  files.set('APIProxy/Policy/access.xml', strToU8('<jwt:VerifyJWT xmlns:jwt="http://www.sap.com/apimgmt"><jwt:Issuer ref="private.issuer">https://attacker.example.com</jwt:Issuer><jwt:Issuer>https://user:password@attacker.example.com</jwt:Issuer><jwt:Issuer>https://identity.example.com/oauth/token</jwt:Issuer><jwt:Issuer>https://identity.example.com/oauth/token</jwt:Issuer></jwt:VerifyJWT>'));
  assert.deepEqual(bundleJwtIssuers(files, 'Orders'), ['https://identity.example.com/oauth/token']);
});

test('documentation inventory paginates without dropping operations and resolves local parameter references', async t => {
  const spec = specification();
  const operation = spec.paths['/Orders'].get;
  spec.components.parameters = { Top: { name: '$top', in: 'query', schema: { type: 'integer' } } };
  operation.parameters = [{ $ref: '#/components/parameters/Top' }];
  spec.paths = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`/Orders${index}`, { get: operation }]));
  const source = bundle();
  source[DOC] = strToU8(JSON.stringify(spec));
  const { call } = await setup(t, { source });
  const first = await call('apim_get_api_documentation', { name: 'Orders' });
  assert.equal(first.error, false, first.text);
  assert.equal(JSON.parse(first.text).operations.length, 100);
  assert.equal(JSON.parse(first.text).next_operation_offset, 100);
  const last = await call('apim_get_api_documentation', { name: 'Orders', operation_offset: 100, path: '/Orders100', method: 'get' });
  assert.equal(last.error, false, last.text);
  const result = JSON.parse(last.text);
  assert.equal(result.operations.length, 1);
  assert.equal(result.next_operation_offset, null);
  assert.equal(result.operation_count, 101);
  assert.equal(result.operation.parameters[0].name, '$top');
  assert.equal(result.operation.parameters[0].type, 'integer');
});

test('legacy unversioned documentation remains inspectable but cannot be submitted as an update', async t => {
  const legacy = specification();
  delete legacy.info.version;
  legacy.paths = {};
  const source = bundle();
  source[DOC] = strToU8(JSON.stringify(legacy));
  const { call, state } = await setup(t, { source });
  const read = await call('apim_get_api_documentation', { name: 'Orders' });
  assert.equal(read.error, false, read.text);
  assert.equal(JSON.parse(read.text).version, null);
  assert.equal(JSON.parse(read.text).operation_count, 0);
  const write = await update(call, legacy);
  assert.equal(write.error, true);
  assert.equal(state.imports, 0);
});

test('selected operation parameters override path parameters without losing distinct locations', () => {
  const spec = specification();
  spec.components.parameters = { Top: { name: '$top', in: 'query', required: true, schema: { type: 'integer' } } };
  spec.paths['/Orders'].parameters = [
    { name: '$top', in: 'query', schema: { type: 'string' } },
    { name: '$top', in: 'header', schema: { type: 'string' } }
  ];
  spec.paths['/Orders'].get.parameters = [{ $ref: '#/components/parameters/Top' }];
  const { operation } = summarizeApiDocumentation(JSON.stringify(spec), { path: '/Orders', method: 'get' });
  assert.deepEqual(operation.parameters, [
    { name: '$top', in: 'query', required: true, type: 'integer', ref: null },
    { name: '$top', in: 'header', required: false, type: 'string', ref: null }
  ]);
});

test('OpenAPI 2 operation inspection inherits consumes and honors operation overrides', () => {
  const spec = {
    swagger: '2.0', info: { title: 'Orders', version: '1' },
    host: 'gateway.example.com', basePath: '/orders', schemes: ['https'], consumes: ['application/json'],
    paths: { '/Orders': { post: { responses: { 201: { description: 'Created' } } } } }
  };
  const summarize = () => summarizeApiDocumentation(JSON.stringify(spec), { path: '/Orders', method: 'post' }).operation;
  assert.deepEqual(summarize().request_content_types, ['application/json']);
  spec.paths['/Orders'].post.consumes = ['application/xml'];
  assert.deepEqual(summarize().request_content_types, ['application/xml']);
  spec.paths['/Orders'].post.consumes = [];
  assert.deepEqual(summarize().request_content_types, []);
});

test('self-contained root references are accepted and malformed local pointers are rejected', () => {
  const spec = specification();
  spec.openapi = '3.1.0';
  spec.components.schemas = { Recursive: { type: 'object', properties: { document: { $ref: '#' } } } };
  assert.equal(parseApiDocumentation(JSON.stringify(spec)).spec.openapi, '3.1.0');
  for (const ref of ['#/components/schemas/%', '#/components/schemas/bad~2pointer', '#/components/schemas/Missing']) {
    spec.components.schemas.Recursive.properties.document.$ref = ref;
    assert.throws(() => parseApiDocumentation(JSON.stringify(spec)), /API documentation .*reference/);
  }
});
