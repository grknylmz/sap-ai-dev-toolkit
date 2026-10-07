import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDestination, destinationUrl, discoverDestinations, fetchDestinationList, redact, sanitizeChildEnv, slugifyDestination } from '../src/bas-discovery.mjs';
import { defaultAdtUrl, discoverSapGuiSystems, sapGuiLandscapeCandidates } from '../src/local-sap-gui.mjs';
import { isolatedWindowsEnv } from './fake-bin.mjs';

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

test('probes destinations concurrently while preserving order', async () => {
  const body = [{ Name: 'c-system' }, { Name: 'a-system' }, { Name: 'b-system' }];
  const started = [];
  const release = [];
  const probeImpl = url => new Promise(resolve => {
    started.push(url);
    release.push(() => resolve({ status: 200 }));
  });
  const discovery = discoverDestinations({ body, env: {}, probeImpl });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(started.length, 3, 'all probes must be in flight at once');
  assert.deepEqual(started, [
    'http://a-system.dest/sap/bc/adt/discovery',
    'http://b-system.dest/sap/bc/adt/discovery',
    'http://c-system.dest/sap/bc/adt/discovery'
  ], 'probes start in sorted destination order');
  for (const resolve of release) resolve();
  const destinations = await discovery;
  assert.deepEqual(destinations.map(destination => [destination.name, destination.probe.status]), [
    ['a-system', 'available'],
    ['b-system', 'available'],
    ['c-system', 'available']
  ]);
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

test('discovers SAP GUI landscape XML entries for local setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-landscape-'));
  const landscape = join(directory, 'SAPUILandscape.xml');
  await writeFile(landscape, `<?xml version="1.0"?><Landscape><Services><Service type="SAPGUI" name="Dev ABAP" server="abap.example.com" systemid="A4H" instancenumber="00" client="100" /></Services></Landscape>`);
  try {
    const systems = await discoverSapGuiSystems({ paths: [landscape] });
    assert.equal(systems.length, 1);
    assert.equal(systems[0].source, 'sap-gui-local');
    assert.equal(systems[0].name, 'Dev ABAP');
    assert.equal(systems[0].host, 'abap.example.com');
    assert.equal(systems[0].systemId, 'A4H');
    assert.equal(systems[0].client, '100');
    assert.equal(systems[0].authentication, 'Basic');
    assert.equal(systems[0].ssoHint, false);
    assert.equal(defaultAdtUrl(systems[0]), 'https://abap.example.com:44300');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery handles candidates, INI files, XML decoding, duplicates, and defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-edge-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const candidates = sapGuiLandscapeCandidates({ HOME: directory, USERPROFILE: directory, APPDATA: appData });
  assert.ok(candidates.some(path => path.endsWith(join('SAP', 'Common', 'SAPUILandscape.xml'))));
  assert.ok(candidates.some(path => path.endsWith(join('SAP', 'SAPUILandscape.xml'))));
  assert.ok(candidates.some(path => path.endsWith(join('SAP', 'Common', 'saplogon.ini'))));
  assert.ok(candidates.some(path => path.includes(join('Library', 'Preferences', 'SAP'))));

  const landscape = join(directory, 'landscape.xml');
  const ini = join(directory, 'saplogon.ini');
  await writeFile(landscape, `<?xml version="1.0"?>
    <Landscape><Services>
      <Service type="SAPGUI" name="QA &amp; DEV" messageserver="msg.example.com" systemid="QAD" client="" sncname="p/host@example.com" />
      <Service type="SAPGUI" name="QA &amp; DEV" messageserver="msg.example.com" systemid="QAD" client="001" />
      <Service type="WEB" name="Portal" server="portal.example.com" />
    </Services></Landscape>`);
  await writeFile(ini, `[Description]\nItem1=Prod System\n[Server]\nItem1=prod.example.com\n[Database]\nItem1=PRD\n[Client]\nItem1=200\n`);
  try {
    const systems = await discoverSapGuiSystems({ paths: [join(directory, 'missing.xml'), landscape, ini] });
    assert.deepEqual(systems.map(system => system.name), ['Prod System', 'QA & DEV']);
    const qa = systems.find(system => system.name === 'QA & DEV');
    assert.equal(qa.host, 'msg.example.com');
    assert.equal(qa.client, '001');
    assert.equal(qa.ssoHint, true);
    assert.equal(qa.authentication, 'Basic/SSO hint');
    assert.equal(defaultAdtUrl(qa), 'https://msg.example.com');
    const prod = systems.find(system => system.name === 'Prod System');
    assert.equal(prod.host, 'prod.example.com');
    assert.equal(prod.systemId, 'PRD');
    assert.equal(prod.client, '200');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery supports single-quoted attributes and filters incomplete records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-single-quote-'));
  const landscape = join(directory, 'landscape.xml');
  await writeFile(landscape, `<Landscape><Services>
    <Service type='SAPGUI' name='Single Quote' server='single.example.com' sid='SGL' sysnr='02' />
    <Service type='SAPGUI' name='Missing Host' sid='BAD' />
  </Services></Landscape>`);
  try {
    const systems = await discoverSapGuiSystems({ paths: [landscape] });
    assert.equal(systems.length, 1);
    assert.equal(systems[0].name, 'Single Quote');
    assert.equal(systems[0].host, 'single.example.com');
    assert.equal(systems[0].systemId, 'SGL');
    assert.equal(defaultAdtUrl(systems[0]), 'https://single.example.com:44302');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery de-duplicates case-insensitive duplicate records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-case-duplicate-'));
  const landscape = join(directory, 'landscape.xml');
  await writeFile(landscape, `<Landscape><Services>
    <Service type="SAPGUI" name="Case Dev" server="case.example.com" systemid="CSE" client="100" />
    <Service type="SAPGUI" name="case dev" server="CASE.EXAMPLE.COM" systemid="cse" client="100" />
  </Services></Landscape>`);
  try {
    const systems = await discoverSapGuiSystems({ paths: [landscape] });
    assert.equal(systems.length, 1);
    assert.equal(systems[0].name, 'Case Dev');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery ignores INI entries without servers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-incomplete-ini-'));
  const ini = join(directory, 'saplogon.ini');
  await writeFile(ini, `[Description]\nItem1=No Server\n[Database]\nItem1=NSV\n`);
  try {
    assert.deepEqual(await discoverSapGuiSystems({ paths: [ini] }), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery self-heals by scanning standard SAP config roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-self-heal-'));
  const nested = join(directory, 'AppData', 'Roaming', 'SAP', 'Odd', 'Nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'SAPUILandscape.xml'), `<Landscape><Services>
    <Service type="SAPGUI" name="Self Heal" server="heal.example.com" systemid="HL1" instancenumber="03" client="123" />
  </Services></Landscape>`);
  try {
    const systems = await discoverSapGuiSystems({ env: isolatedWindowsEnv(directory) });
    assert.equal(systems.length, 1);
    assert.equal(systems[0].name, 'Self Heal');
    assert.equal(systems[0].host, 'heal.example.com');
    assert.equal(defaultAdtUrl(systems[0]), 'https://heal.example.com:44303');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery falls back to a broad profile scan when standard roots miss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-broad-heal-'));
  const odd = join(directory, 'CompanyProfile', 'RoamedConfig');
  await mkdir(odd, { recursive: true });
  await writeFile(join(odd, 'SAPUILandscape.xml'), `<Landscape><Services>
    <Service type="SAPGUI" name="Broad Heal" server="broad.example.com" systemid="BRD" instancenumber="04" client="321" />
  </Services></Landscape>`);
  try {
    const systems = await discoverSapGuiSystems({ env: isolatedWindowsEnv(directory) });
    assert.equal(systems.length, 1);
    assert.equal(systems[0].name, 'Broad Heal');
    assert.equal(systems[0].host, 'broad.example.com');
    assert.equal(defaultAdtUrl(systems[0]), 'https://broad.example.com:44304');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SAP GUI discovery reads connection directories and ignores unreadable garbage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-connection-dir-'));
  const connections = join(directory, 'connections');
  await mkdir(connections, { recursive: true });
  await writeFile(join(connections, 'java.xml'), `<Landscape><Item type="SAPGUI" name="Java GUI" host="java.example.com" sid="JAV" instance="01" client="300" /></Landscape>`);
  await writeFile(join(connections, 'notes.txt'), 'not enough fields');
  try {
    const systems = await discoverSapGuiSystems({ paths: [connections] });
    assert.equal(systems.length, 1);
    assert.equal(systems[0].name, 'Java GUI');
    assert.equal(systems[0].host, 'java.example.com');
    assert.equal(systems[0].systemId, 'JAV');
    assert.equal(systems[0].client, '300');
    assert.equal(defaultAdtUrl(systems[0]), 'https://java.example.com:44301');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses the documented branded HTTP proxy for destination probes and respects explicit direct mode', async t => {
  const requests = [];
  const proxy = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    response.writeHead(200);
    response.end('<ok/>');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const found = await discoverDestinations({
    body: [{ Name: 'branded-proxy-system' }],
    env: { HTTP_PROXY: 'http://127.0.0.1:1', SAP_AI_DEV_TOOLKIT_HTTP_PROXY: proxyUrl }
  });
  assert.equal(found[0].probe.status, 'available');
  assert.deepEqual(requests, [{ host: 'branded-proxy-system.dest', path: 'http://branded-proxy-system.dest/sap/bc/adt/discovery' }]);

  const direct = await discoverDestinations({
    body: [{ Name: 'direct-system' }],
    env: { HTTP_PROXY: proxyUrl, SAP_AI_DEV_TOOLKIT_HTTP_PROXY: '' },
    probeImpl: async (_url, options) => {
      assert.equal(options.proxyUrl, '', 'explicit empty branded proxy must bypass the configured proxy');
      return { status: 200 };
    }
  });
  assert.equal(direct[0].probe.status, 'available');
  assert.equal(requests.length, 1);
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

test('branded HTTP proxy takes precedence over HTTPS_PROXY for secure BAS discovery', async () => {
  let capturedDispatcher = 'not-called';
  const body = await fetchDestinationList('https://bas.example', {
    env: {
      SAP_AI_DEV_TOOLKIT_HTTP_PROXY: '',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1'
    },
    fetchImpl: async (_url, options) => {
      capturedDispatcher = options.dispatcher;
      return new Response(JSON.stringify([{ Name: 'secure-system' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.deepEqual(body, [{ Name: 'secure-system' }]);
  assert.equal(capturedDispatcher, undefined, 'explicit branded empty proxy must disable inherited HTTPS_PROXY too');
});

test('redacts credential-bearing diagnostics without exposing payloads', () => {
  const value = redact({ name: 'dev', password: 'secret', authorization: 'Bearer abc', nested: { cookie: 'x', ok: 'visible' } });
  assert.deepEqual(value, { name: 'dev', password: '[redacted]', authorization: '[redacted]', nested: { cookie: '[redacted]', ok: 'visible' } });
});

test('nested destination properties never overwrite the top-level destination name', async () => {
  // Regression: BAS wraps Cloud Connector metadata in `properties`; its
  // `Name` (system name `_SIDCLNTOX`) used to clobber the real destination
  // name and abort the whole discovery with "Invalid BAS destination name".
  const destination = normalizeDestination({ name: 'S4H_DEV', type: 'HTTP', properties: { Name: '_SIDCLNTOX', URL: 'https://s4h.example', 'sap-client': '100' } });
  assert.equal(destination.name, 'S4H_DEV');
  assert.equal(destination.url, 'http://S4H_DEV.dest');
  assert.equal(destination.client, '100');

  const probed = [];
  const destinations = await discoverDestinations({
    body: [{ name: 'S4H_DEV', properties: { Name: '_SIDCLNTOX' } }],
    env: {},
    probeImpl: async url => { probed.push(url); return { status: 200 }; }
  });
  assert.deepEqual(probed, ['http://S4H_DEV.dest/sap/bc/adt/discovery']);
  assert.deepEqual(destinations.map(item => item.name), ['S4H_DEV']);
});

test('nested properties fill gaps without a top-level name', () => {
  const destination = normalizeDestination({ type: 'HTTP', properties: { Name: 'S4H_DEV', 'sap-client': '100' } });
  assert.equal(destination.name, 'S4H_DEV');
  assert.equal(destination.client, '100');
});

test('leading-underscore destination names stay probeable end to end', async () => {
  assert.equal(destinationUrl('_SIDCLNTOX'), 'http://_SIDCLNTOX.dest');
  const probed = [];
  const destinations = await discoverDestinations({
    body: [{ Name: '_SIDCLNTOX' }],
    env: {},
    probeImpl: async url => { probed.push(url); return { status: 403 }; }
  });
  assert.deepEqual(probed, ['http://_SIDCLNTOX.dest/sap/bc/adt/discovery']);
  assert.deepEqual(destinations.map(item => [item.name, item.probe.status]), [['_SIDCLNTOX', 'auth-required']]);
});

test('one malformed destination degrades to an invalid-name probe instead of failing discovery', async () => {
  const destinations = await discoverDestinations({
    body: [
      { Name: 'good-system' },
      { Name: 'bad name/with.slashes:and@ats' },
      { Name: '   ' },
      'garbage-string-entry',
      null
    ],
    env: {},
    probeImpl: async () => ({ status: 200 })
  });
  assert.deepEqual(destinations.map(item => [item.name, item.url, item.probe.status]), [
    ['bad name/with.slashes:and@ats', null, 'invalid-name'],
    ['good-system', 'http://good-system.dest', 'available']
  ]);
});

test('heals name-keyed destination maps and extended list wrappers', async () => {
  const fromMap = await discoverDestinations({
    body: { DESTINATIONS: { S4H_DEV: { properties: { 'sap-client': '100' } }, 'A_SYSTEM': { properties: { 'sap-client': '200' } } } },
    env: {},
    skipProbe: true
  });
  assert.deepEqual(fromMap.map(item => [item.name, item.client]), [['A_SYSTEM', '200'], ['S4H_DEV', '100']]);

  const fromItems = await discoverDestinations({ body: { items: [{ Name: 'items-system' }] }, env: {}, skipProbe: true });
  assert.deepEqual(fromItems.map(item => item.name), ['items-system']);

  const fromValue = await discoverDestinations({ body: { value: [{ Name: 'odata-system' }] }, env: {}, skipProbe: true });
  assert.deepEqual(fromValue.map(item => item.name), ['odata-system']);
});

test('fetchDestinationList tolerates BOMs and text/plain payloads and diagnoses unparsable bodies', async () => {
  const bomBody = await fetchDestinationList('https://bas.example', {
    env: {},
    fetchImpl: async () => new Response(`\uFEFF${JSON.stringify([{ Name: 'bom-system' }])}`, { status: 200, headers: { 'content-type': 'text/plain' } })
  });
  assert.deepEqual(bomBody, [{ Name: 'bom-system' }]);

  await assert.rejects(
    fetchDestinationList('https://bas.example', {
      env: {},
      fetchImpl: async () => new Response('<html>login page</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }),
    /unparsable JSON: <html>login page<\/html>/
  );
});
