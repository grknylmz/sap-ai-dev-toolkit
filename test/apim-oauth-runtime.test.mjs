import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { registerApimRuntimeTools, runApiProxyGet } from '../src/apim-runtime.mjs';
import { buildApiProxyBundle, attachPolicies } from '../src/apim-bundle.mjs';
import { readBundle, writeBundle } from '../src/iflow-bundle.mjs';

const ISSUER = 'https://identity.example/oauth/token';
const TOKEN = 'synthetic-private-bearer-token';
const CLIENT = 'synthetic!b1|private-client';
const SECRET = 'synthetic+private/secret=';
const API_KEY = 'synthetic-private-api-key';
const SCOPE = 'api.S4D_100';
const oauth = { service_instance: 'api-identity', service_key: 'consumer-key', scope: SCOPE };
const args = { oauth, proxy_name: 'Product', path: '/Products' };
const METADATA = '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><EntitySet Name="Products" EntityType="Product"/></edmx:Edmx>';

function proxyBundle(issuer) {
  const files = readBundle(buildApiProxyBundle({ name: 'Product', basePath: '/s4/product/v1', serviceType: 'odata', target: { url: 'https://backend.example/odata' } }));
  if (issuer) attachPolicies(files, 'Product', [{ name: 'VerifyIdentity', template: 'custom', params: { type: 'VerifyJWT', xml: `<VerifyJWT xmlns="http://www.sap.com/apimgmt"><Issuer>${issuer.replaceAll('&', '&amp;')}</Issuer></VerifyJWT>` } }]);
  return writeBundle(files);
}

async function fixture(t, { issuer = ISSUER, credentials = { uaa: { url: 'https://identity.example', clientid: CLIENT, clientsecret: SECRET } }, tokenStatus = 200, tokenBody, tokenScope = SCOPE, runtimeStatus = 200, networkFailure = false, cfFailure = false, withoutDevhub = false } = {}) {
  const state = { tokenRequests: 0, runtimeRequests: 0, cfReads: 0, appReads: 0, exports: 0, granted: false, unexpected: 0 };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/oauth/token') {
      state.tokenRequests++;
      const form = new URLSearchParams(body);
      const basic = `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}`;
      const valid = request.method === 'POST' && request.headers.authorization === basic && form.get('grant_type') === 'client_credentials' && form.get('scope') === SCOPE && [...form.keys()].length === 2;
      state.granted = valid && tokenStatus === 200;
      response.writeHead(valid ? tokenStatus : 401, { 'content-type': 'application/json', location: '/credential-sink' });
      response.end(tokenBody ?? JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', scope: tokenScope }));
      return;
    }
    if (url.pathname === '/s4/product/v1/Products' || url.pathname === '/s4/product/v1/$metadata') {
      state.runtimeRequests++;
      const authorized = (state.granted && request.headers.authorization === `Bearer ${TOKEN}` && !request.headers.apikey) || (request.headers.apikey === API_KEY && !request.headers.authorization);
      if (!authorized || request.method !== 'GET') { response.writeHead(403); response.end(SECRET); return; }
      if (url.pathname.endsWith('$metadata')) { response.writeHead(runtimeStatus, { 'content-type': 'application/xml' }); response.end(METADATA); return; }
      if (url.searchParams.get('$top') !== '1') { response.writeHead(400); response.end(); return; }
      const reflected = request.headers.apikey ? { [API_KEY]: 'private', [SECRET]: 'private' } : { [TOKEN]: 'private', [CLIENT]: 'private', [SECRET]: 'private' };
      response.writeHead(runtimeStatus, { 'content-type': `application/json; reflected=${request.headers.apikey ?? TOKEN}` });
      response.end(JSON.stringify({ value: [{ Product: 'business-row-must-not-escape', ...reflected }] }));
      return;
    }
    state.unexpected++;
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const apim = { request: async (method, path, options) => {
    if (method === 'GET' && path === '/apiportal/api/1.0/Transport.svc/APIProxies' && options.query.name === 'Product') { state.exports++; return proxyBundle(issuer); }
    if (method === 'GET' && path === "/apiportal/api/1.0/Management.svc/APIProxies('Product')") return { state: 'DEPLOYED', publishUrl: 'https://runtime.example/s4/product/v1', proxyEndPoints: [{ virtualhosts: [{ virtual_host: 'runtime.example' }] }] };
    throw new Error('Unexpected management operation');
  } };
  // Only the test transport maps the two trusted HTTPS origins onto loopback HTTP.
  const fetchImpl = (address, init) => {
    const url = new URL(address);
    if (url.protocol !== 'https:' || !['identity.example', 'runtime.example'].includes(url.hostname)) throw new Error('Untrusted fixture destination');
    if (networkFailure && url.hostname === 'identity.example') throw new Error(`${CLIENT} ${SECRET} ${TOKEN}`);
    return fetch(`${local}${url.pathname}${url.search}`, init);
  };
  const execFileImpl = (command, argv, options, callback) => {
    state.cfReads++;
    if (cfFailure) return callback(new Error(`${CLIENT} ${SECRET} ${TOKEN}`));
    if (command !== 'cf' || JSON.stringify(argv) !== JSON.stringify(['service-key', '--json', oauth.service_instance, oauth.service_key])) return callback(new Error(SECRET));
    callback(null, JSON.stringify({ credentials }));
  };
  const devhub = { request: async (method, path) => {
    state.appReads++;
    if (method !== 'GET' || !path.endsWith("Applications('Consumer')")) throw new Error('Unexpected consumer lookup');
    return { status: 200, data: { id: 'Consumer', app_key: API_KEY, app_secret: SECRET } };
  } };
  let probe;
  registerApimRuntimeTools((name, title, description, schema, annotations, handler) => {
    if (name === 'apim_test_api') probe = input => handler(z.object(schema).strict().parse(input));
  }, { apim, devhub: withoutDevhub ? undefined : devhub, env: {}, fetchImpl, execFileImpl });
  return { state, probe, apim, fetchImpl };
}

function noCredentials(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, CLIENT, SECRET, API_KEY]) assert.equal(text.includes(secret), false, 'private credential escaped');
  assert.equal(text.includes('business-row-must-not-escape'), false);
}

test('OAuth probe acquires exactly one scope privately and reaches the APIM route without a consumer application', async t => {
  const { probe, state } = await fixture(t);
  const result = await probe(args);
  assert.equal(result.runtime_url, 'https://runtime.example/s4/product/v1');
  assert.equal(result.returned, 1);
  assert.ok(result.fields.includes('Product'));
  noCredentials(result);
  assert.deepEqual(state, { tokenRequests: 1, runtimeRequests: 1, cfReads: 1, appReads: 0, exports: 1, granted: true, unexpected: 0 });
  const metadata = await probe({ ...args, path: '/$metadata' });
  assert.equal(metadata.metadata.entity_sets[0].name, 'Products');
  assert.equal(state.exports, 2, 'issuer evidence must be fresh for each probe');
});

test('OAuth probe refuses absent or ambiguous auth sources and scopes before reading secrets or requesting tokens', async t => {
  const { probe, state } = await fixture(t);
  for (const input of [{ proxy_name: 'Product', path: '/Products' }, { ...args, application_id: 'Consumer' }, ...['', ' ', `${SCOPE} api.OTHER`, `${SCOPE}\n`, `${SCOPE}\tapi.OTHER`].map(scope => ({ ...args, oauth: { ...oauth, scope } })), { ...args, oauth: { ...oauth, access_token: TOKEN } }]) {
    await assert.rejects(async () => probe(input));
  }
  assert.equal(state.cfReads + state.tokenRequests + state.runtimeRequests + state.appReads + state.exports, 0);
});

test('wrong or missing explicit issuer never receives CF credentials', async t => {
  for (const issuer of ['https://other-identity.example/oauth/token', null]) {
    const { probe, state } = await fixture(t, { issuer });
    await assert.rejects(probe(args), error => { noCredentials(error.message); return /issuer/.test(error.message); });
    assert.equal(state.tokenRequests + state.runtimeRequests + state.appReads, 0);
  }
});

test('unsafe endpoints and certificate-only service keys cannot send a token request', async t => {
  for (const auth of [
    { url: 'http://identity.example' }, { url: 'https://user:password@identity.example' },
    { url: 'https://identity.example?private=query' }, { url: 'https://identity.example/#fragment' },
    { url: 'https://identity.example/?' }, { url: 'https://identity.example/#' }, { url: 'https://@identity.example' },
    { url: 'https://identity.example/other/path' }, { url: 'https://identity.example', clientsecret: undefined, certificate: 'synthetic-certificate' }
  ]) {
    const credentials = { oauth: { clientid: CLIENT, clientsecret: SECRET, ...auth } };
    const { probe, state } = await fixture(t, { credentials });
    await assert.rejects(probe(args), error => { noCredentials(error.message); return true; });
    assert.equal(state.tokenRequests + state.runtimeRequests, 0);
  }
});

test('token failures, redirects, invalid responses and broadened scope withhold reflected credentials', async t => {
  for (const options of [
    { tokenStatus: 302, tokenBody: `${CLIENT} ${SECRET} ${TOKEN}` },
    { tokenStatus: 307, tokenBody: `${CLIENT} ${SECRET} ${TOKEN}` },
    { tokenStatus: 401, tokenBody: `${CLIENT} ${SECRET} ${TOKEN}` },
    { tokenBody: `${CLIENT} ${SECRET} ${TOKEN}` },
    { tokenBody: JSON.stringify({ access_token: TOKEN, token_type: SECRET }) },
    { tokenScope: `${SCOPE} api.OTHER` },
    { runtimeStatus: 503 }
  ]) {
    const { probe, state } = await fixture(t, options);
    await assert.rejects(probe(args), error => { noCredentials(error.message); return true; });
    assert.equal(state.tokenRequests, 1);
    assert.equal(state.unexpected, 0, 'redirect destination must not be contacted');
    assert.equal(state.runtimeRequests, options.runtimeStatus ? 1 : 0);
  }
});

test('native API-key mode still requires the private application key and never contacts OAuth', async t => {
  const { probe, state } = await fixture(t);
  const result = await probe({ application_id: 'Consumer', proxy_name: 'Product', path: '/Products' });
  assert.equal(result.application_id, 'Consumer');
  assert.equal(result.returned, 1);
  // Application key and secret stay private even when reflected in summary fields.
  assert.equal(JSON.stringify(result).includes(API_KEY) || JSON.stringify(result).includes(SECRET), false);
  assert.equal(state.appReads, 1);
  assert.equal(state.runtimeRequests, 1);
  assert.equal(state.cfReads + state.tokenRequests + state.exports, 0);
});

test('runtime rejects missing or competing private credentials before touching the route', async () => {
  let requests = 0;
  const apim = { request: async () => { requests++; throw new Error('should not be reached'); } };
  for (const credentials of [{}, { consumerKey: API_KEY, bearerToken: TOKEN }, { bearerToken: '' }, { bearerToken: `${TOKEN}\r\nInjected: value` }]) {
    await assert.rejects(runApiProxyGet({ apim, ...credentials, proxyName: 'Product', path: '/Products', env: {} }), /exactly one private/);
  }
  assert.equal(requests, 0);
});

test('CF and token transport errors cannot return raw credential-bearing diagnostics', async t => {
  for (const options of [{ cfFailure: true }, { networkFailure: true }]) {
    const { probe, state } = await fixture(t, options);
    await assert.rejects(probe(args), error => { noCredentials(error.message); return /withheld/.test(error.message); });
    assert.equal(state.runtimeRequests + state.tokenRequests, 0);
  }
});

test('malformed token JSON uses the credential-withholding error boundary', async t => {
  for (const tokenBody of ['null', '[]', '{}', 'true', '200', JSON.stringify({ access_token: TOKEN, token_type: null })]) {
    const { probe, state } = await fixture(t, { tokenBody });
    await assert.rejects(probe(args), error => {
      noCredentials(error.message);
      assert.match(error.message, /usable bearer token; response withheld/);
      return true;
    });
    assert.equal(state.runtimeRequests, 0);
  }
});

test('OAuth keys may use oauth or raw credential shapes without exposing their contents', async t => {
  for (const credentials of [
    { oauth: { url: 'https://identity.example', clientid: CLIENT, clientsecret: SECRET } },
    { tokenurl: ISSUER, client_id: CLIENT, client_secret: SECRET }
  ]) {
    const { probe, state } = await fixture(t, { credentials });
    const result = await probe({ ...args, path: '/$metadata' });
    assert.equal(result.metadata.entity_sets[0].name, 'Products');
    noCredentials(result);
    assert.equal(state.tokenRequests, 1);
    assert.equal(state.runtimeRequests, 1);
    assert.equal(state.appReads, 0);
  }
});

test('APIM-only OAuth works without DEVHUB while API-key mode fails before credential or runtime access', async t => {
  const { probe, state } = await fixture(t, { withoutDevhub: true });
  const result = await probe(args);
  assert.equal(result.returned, 1);
  noCredentials(result);
  const before = { ...state };
  await assert.rejects(probe({ application_id: 'Consumer', proxy_name: 'Product', path: '/$metadata' }));
  assert.deepEqual(state, before);
  assert.equal(state.appReads, 0);
});
