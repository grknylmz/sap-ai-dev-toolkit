import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeDestination, destinationUrl, discoverDestinations, fetchDestinationList, redact, sanitizeChildEnv, slugifyDestination } from '../src/bas-discovery.mjs';

test('normalizes destination metadata case-insensitively', () => {
  const destination = normalizeDestination({
    Name: 'DEV-ABAP',
    Properties: { 'WebIDEEnabled': 'true', 'HTML5.DynamicDestination': true, 'WebIDEUsage': 'dev_abap', 'SAP-Client': '200', Authentication: 'PrincipalPropagation', URL: 'https://backend.example' }
  });
  assert.deepEqual(destination, {
    name: 'DEV-ABAP', authentication: 'PrincipalPropagation', client: '200',
    url: 'http://DEV-ABAP.dest', backendUrl: 'https://backend.example', proxyType: null, rawKeys: ['Name', 'Properties']
  });
});

test('returns every named destination regardless of ADT probe and preserves allowlists', async () => {
  const body = { DESTINATIONS: [
    { Name: 'z-system', WebIDEEnabled: true, 'HTML5.DynamicDestination': false, WebIDEUsage: 'ui5' },
    { Name: 'b-system', WebIDEEnabled: false, 'HTML5.DynamicDestination': false, WebIDEUsage: 'ui5' },
    { Name: 'a-system', WebIDEEnabled: false, 'HTML5.DynamicDestination': false, WebIDEUsage: 'ui5' }
  ] };
  const probeImpl = async url => ({ status: url.includes('a-system') ? 403 : url.includes('b-system') ? 200 : 404 });
  const allowlisted = await discoverDestinations({
    body,
    env: { SAP_AI_DEV_TOOLKIT_DESTINATION: 'a-system,b-system' },
    probeImpl
  });
  assert.deepEqual(allowlisted.map(item => [item.name, item.client, item.probe.status]), [
    ['a-system', '001', 'auth-required'],
    ['b-system', '001', 'available']
  ]);

  const all = await discoverDestinations({ body, env: {}, probeImpl });
  assert.deepEqual(all.map(item => [item.name, item.probe.status]), [
    ['a-system', 'auth-required'],
    ['b-system', 'available'],
    ['z-system', 'not-found']
  ]);
});

test('accepts the previous destination environment variable during upgrades', async () => {
  const destinations = await discoverDestinations({
    body: [{ Name: 'legacy-system' }, { Name: 'other-system' }],
    env: { BAS_VSP_DESTINATION: 'legacy-system' },
    skipProbe: true
  });
  assert.deepEqual(destinations.map(destination => destination.name), ['legacy-system']);
});
test('parses sample-style destination records and enables every ADT heartbeat response', async () => {
  const body = [
    {
      Type: 'HTTP',
      'HTML5.DynamicDestination': 'true',
      Authentication: 'PrincipalPropagation',
      'sap-client': '200',
      Name: 'DGT_200',
      WebIDEUsage: 'odata_abap,ui5_execute_abap,dev_abap',
      WebIDEEnabled: 'true'
    },
    {
      Name: 'S4D_100',
      Type: 'HTTP',
      Authentication: 'PrincipalPropagation',
      'HTML5.DynamicDestination': 'true',
      'sap-client': '100',
      WebIDEUsage: 'odata_abap',
      WebIDEEnabled: 'true'
    },
    {
      Name: 'SUP_BACKEND',
      Type: 'HTTP',
      Authentication: 'OAuth2ClientCredentials',
      'HTML5.DynamicDestination': 'true',
      WebIDEUsage: 'true',
      WebIDEEnabled: 'true'
    }
  ];
  const probed = [];
  const destinations = await discoverDestinations({
    body,
    env: {},
    probeImpl: async url => {
      probed.push(url);
      if (url.includes('DGT_200.dest')) return { status: 200 };
      if (url.includes('S4D_100.dest')) return { status: 403 };
      return { status: 404 };
    }
  });

  assert.deepEqual(probed, [
    'http://DGT_200.dest/sap/bc/adt/discovery',
    'http://S4D_100.dest/sap/bc/adt/discovery',
    'http://SUP_BACKEND.dest/sap/bc/adt/discovery'
  ]);
  assert.deepEqual(destinations.map(({ name, client, authentication, probe }) => [
    name, client, authentication, probe.status, probe.available
  ]), [
    ['DGT_200', '200', 'PrincipalPropagation', 'available', true],
    ['S4D_100', '100', 'PrincipalPropagation', 'auth-required', true],
    ['SUP_BACKEND', '001', 'OAuth2ClientCredentials', 'not-found', false]
  ]);
});

test('keeps T4D destinations when their ADT probes fail', async () => {
  const destinations = await discoverDestinations({
    body: [
      { Name: 'T4D_100', 'sap-client': '100' },
      { Name: 'T4D_200', 'sap-client': '200' }
    ],
    env: {},
    probeImpl: async url => ({ status: url.includes('T4D_100') ? 503 : 404 })
  });

  assert.deepEqual(destinations.map(({ name, client, probe }) => [
    name, client, probe.status, probe.httpStatus, probe.available
  ]), [
    ['T4D_100', '100', 'unavailable', 503, false],
    ['T4D_200', '200', 'not-found', 404, false]
  ]);
});


test('rejects invalid destination URL names and creates deterministic collision slugs', () => {
  assert.equal(destinationUrl('A-1_2'), 'http://A-1_2.dest');
  assert.throws(() => destinationUrl('backend.example/path'), /Invalid BAS destination name/);
  const used = new Map();
  assert.deepEqual(['Dev System', 'dev-system', 'DEV_SYSTEM'].map(name => slugifyDestination(name, used)), ['dev-system', 'dev-system-2', 'dev-system-3']);
});

test('sanitizes child identity material and preserves caller proxy safety settings', () => {
  const env = sanitizeChildEnv({ HTTP_PROXY: 'http://proxy:8887', NO_PROXY: 'localhost,.dest,127.0.0.1', Authorization: 'Bearer secret', Cookie: 'SAP_SESSION=secret', SAP_USER: 'alice', SAP_PASSWORD: 'secret', SAP_READ_ONLY: 'true' });
  assert.equal(env.SAP_PROXY_CONTEXTID_GUARD, 'true');
  assert.equal(env.HTTP_PROXY, 'http://proxy:8887');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(env.SAP_READ_ONLY, 'true');
  assert.equal(env.Authorization, undefined);
  assert.equal(env.Cookie, undefined);
  assert.equal(env.SAP_USER, undefined);
  assert.equal(env.SAP_PASSWORD, undefined);
});

test('probes .dest only through configured HTTP proxy and accepts proxy-auth responses', async () => {
  const requests = [];
  const proxy = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    response.writeHead(401);
    response.end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  const found = await discoverDestinations({
    body: [{ Name: 'proxy-system' }],
    env: { HTTP_PROXY: `http://127.0.0.1:${port}` }
  });
  await new Promise(resolve => proxy.close(resolve));
  assert.equal(found[0].probe.status, 'auth-required');
  assert.deepEqual(requests, [{ host: 'proxy-system.dest', path: 'http://proxy-system.dest/sap/bc/adt/discovery' }]);
});

test('fetches BAS destination lists through configured HTTP and HTTPS proxies', async t => {
  const proxyRequests = [];
  const directRequests = [];
  const target = createServer((request, response) => {
    directRequests.push({ method: request.method, host: request.headers.host, path: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ Name: 'direct-system' }]));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const proxy = createServer((request, response) => {
    proxyRequests.push({ method: request.method, host: request.headers.host, path: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ Name: 'proxied-system' }]));
  });
  proxy.on('connect', (request, socket) => {
    proxyRequests.push({ method: request.method, host: request.url });
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const env = { http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: '' };
  const body = await fetchDestinationList('http://bas.example', { env, timeoutMs: 1000 });
  assert.deepEqual(body, [{ Name: 'proxied-system' }]);
  await assert.rejects(fetchDestinationList('https://bas.example', { env, timeoutMs: 1000 }));
  assert.deepEqual(proxyRequests, [
    { method: 'GET', host: 'bas.example', path: 'http://bas.example/api/listDestinations' },
    { method: 'CONNECT', host: 'bas.example:443' }
  ]);
  const directBody = await fetchDestinationList(`http://127.0.0.1:${target.address().port}`, {
    env: { HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' },
    timeoutMs: 1000
  });
  assert.deepEqual(directBody, [{ Name: 'direct-system' }]);
  assert.deepEqual(directRequests, [{
    method: 'GET',
    host: `127.0.0.1:${target.address().port}`,
    path: '/api/listDestinations'
  }]);
  assert.equal(proxyRequests.length, 2);
});

test('redacts credential-bearing diagnostics without exposing payloads', () => {
  const value = redact({ name: 'dev', password: 'secret', authorization: 'Bearer abc', nested: { cookie: 'x', ok: 'visible' } });
  assert.deepEqual(value, { name: 'dev', password: '[redacted]', authorization: '[redacted]', nested: { cookie: '[redacted]', ok: 'visible' } });
});
