import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adtBaseUrl, adtPort, adtVerdict, discoverSapGuiSystems, defaultAdtUrl, detectAdtUrl, hasExplicitPort, hasPathPrefix, messageServerAppServers, parseMessageServerServers } from '../src/local-sap-gui.mjs';

const fakeVsp = fileURLToPath(new URL('./fixtures/fake-vsp.mjs', import.meta.url));

async function fixture(t, filename, content) {
  const dir = await mkdtemp(join(tmpdir(), 'sap-logon-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, filename);
  await writeFile(path, content);
  return discoverSapGuiSystems({ paths: [path] });
}

test('standard dispatcher addresses produce HTTP candidates, not DIAG URLs', async t => {
  const systems = await fixture(t, 'landscape.xml', `<Landscape>
    <Service type="SAPGUI" name="Dev" server="dev.example:3201" systemid="DEV" />
    <Service type="SAPGUI" name="Dev" server="dev.example:3202" systemid="DEV" />
    <Service type="SAPGUI" name="IPv6" server="[::1]:3200" />
  </Landscape>`);
  assert.equal(systems.length, 3);
  assert.deepEqual(systems.filter(s => s.name === 'Dev').map(defaultAdtUrl), ['https://dev.example:44301', 'https://dev.example:44302']);
  assert.equal(defaultAdtUrl(systems.find(s => s.name === 'IPv6')), 'https://[::1]:44300');
  assert.equal(defaultAdtUrl({ host: '/H/router/S/3299/H/backend', instance: '00' }), '');
});

test('message-server UUID resolves logon groups without deriving an instance from UUID', async t => {
  const systems = await fixture(t, 'landscape.xml', `<Landscape>
    <Service type="SAPGUI" name="Balanced" server="PUBLIC" msid="12345678" systemid="DEV" />
    <Service type="SAPGUI" name="Unresolved" server="PUBLIC" msid="missing" />
    <!-- <Service type="SAPGUI" name="Deleted" server="old.example" /> -->
    <Messageserver uuid="12345678" host="msg.example" port="3601" />
  </Landscape>`);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].host, 'msg.example');
  assert.equal(systems[0].instance, '');
  assert.equal(defaultAdtUrl(systems[0]), 'https://msg.example');
  // The message server's HTTP port (81NN) lists the application servers that serve ADT.
  assert.deepEqual(systems[0].messageServer, { host: 'msg.example', httpPort: 8101 });
});

test('UTF-16 SAP Logon INI retains instance and SNC metadata', async t => {
  const content = '[Description]\r\nItem1=Development\r\n[Server]\r\nItem1=dev.example\r\n[Database]\r\nItem1=DEV\r\n[SystemNumber]\r\nItem1=03\r\n[SNC]\r\nItem1=0\r\n';
  const systems = await fixture(t, 'saplogon.ini', Buffer.concat([Buffer.from([255, 254]), Buffer.from(content, 'utf16le')]));
  assert.equal(systems.length, 1);
  assert.equal(defaultAdtUrl(systems[0]), 'https://dev.example:44303');
  assert.equal(systems[0].ssoHint, false);
});

test('Java connections can be a regular file rather than a directory', async t => {
  const systems = await fixture(t, 'connections', 'Java Dev;java.example;DEV\n');
  assert.equal(systems.length, 1);
  assert.equal(systems[0].host, 'java.example');
});

test('explicitly disabled SNC/SSO flags are not positive hints', async t => {
  const systems = await fixture(t, 'landscape.xml', '<Service type="SAPGUI" name="Basic" host="dev.example" sncmode="0" sso="false" use_sso="no" />');
  assert.equal(systems[0].ssoHint, false);
});

test('hasExplicitPort reads the port from the URL text, including default ports', () => {
  for (const url of ['https://host:443', 'https://host:44300/', 'http://host:8000?x=1', 'https://[::1]:44300']) assert.equal(hasExplicitPort(url), true, url);
  for (const url of ['https://host', 'https://host/', 'https://[::1]', 'https://user:1@host', '']) assert.equal(hasExplicitPort(url), false, url);
});

test('detectAdtUrl takes the TLS ADT port from VSP detect and never downgrades https', async () => {
  const findings = [
    { port: 8000, url: 'http://sap.example:8000', kind: 'adt', status: 401, secure: false },
    { port: 44310, url: 'https://sap.example:44310', kind: 'adt', status: 302, secure: true },
    { port: 443, url: '', kind: 'open', secure: false }
  ];
  const env = findings => ({ ...process.env, FAKE_DETECT_JSON: JSON.stringify({ host: 'sap.example', findings }) });
  assert.deepEqual(await detectAdtUrl(fakeVsp, { url: 'https://sap.example', client: '100', env: env(findings) }), { url: 'https://sap.example:44310', reason: '' });
  assert.match((await detectAdtUrl(fakeVsp, { url: 'https://sap.example', env: env(findings.slice(0, 1)) })).reason, /only plain HTTP answers ADT \(http:\/\/sap\.example:8000\)/);
  assert.equal((await detectAdtUrl(fakeVsp, { url: 'http://sap.example', env: env(findings.slice(0, 1)) })).url, 'http://sap.example:8000');
  assert.deepEqual(await detectAdtUrl(fakeVsp, { url: 'https://sap.example', env: env(null) }), { url: '', reason: 'no port answered on sap.example' });
  assert.deepEqual(await detectAdtUrl(fakeVsp, { url: 'https://sap.example', env: { ...process.env, FAKE_DETECT_JSON: 'not json' } }), { url: '', reason: 'VSP detect returned unreadable output' });
  assert.match((await detectAdtUrl(join(tmpdir(), 'missing-vsp-binary'), { url: 'https://sap.example' })).reason, /^VSP detect could not run \(ENOENT\) from /);
});

test('adtVerdict explains every way a scan can come back without ADT', () => {
  const verdict = findings => adtVerdict({ host: 'sap.example', findings });
  assert.equal(verdict([
    { port: 443, url: 'https://sap.example:443', kind: 'adt', status: 302, secure: true },
    { port: 44310, url: 'https://sap.example:44310', kind: 'adt', status: 401, secure: true }
  ]).url, 'https://sap.example:44310');
  assert.deepEqual(adtVerdict({ host: 'sap.example', findings: null, unsearched: [{ object: 'sap.example', reason: 'the name does not resolve: no such host' }] }), { url: '', unresolved: true, reason: 'sap.example does not resolve; connect to the company network or VPN' });
  assert.match(verdict([{ port: 44300, url: 'https://sap.example:44300', kind: 'sap-without-adt', status: 404, secure: true }]).reason, /\/sap\/bc\/adt is not active; ask basis to activate it in SICF/);
  assert.match(verdict([{ port: 443, kind: 'tls-name-mismatch', detail: 'remote error: tls: certificate required', secure: false }]).reason, /port 443 demands a client certificate \(smart card\)/);
  assert.match(verdict([{ port: 443, kind: 'tls-name-mismatch', certHost: 'sap.corp.example', detail: 'x509: certificate is valid for sap.corp.example', secure: false }]).reason, /port 443 presents a certificate for sap\.corp\.example/);
  assert.equal(verdict([{ port: 443, kind: 'open' }, { port: 8443, kind: 'http', status: 200 }]).reason, 'ports 443, 8443 on sap.example accept connections but none answered as ADT');
});

test('ADT base URLs drop pasted ADT paths but keep gateway prefixes and explicit ports', () => {
  assert.equal(adtBaseUrl(' https://sap.example:443/sap/bc/adt/discovery?sap-client=100 '), 'https://sap.example:443');
  assert.equal(adtBaseUrl('https://gw.example/t4d/sap/bc/adt/'), 'https://gw.example/t4d');
  assert.equal(hasPathPrefix('https://gw.example/t4d/'), true);
  assert.equal(hasPathPrefix('https://sap.example:44300/sap/bc/adt'), false);
  assert.deepEqual(['https://sap.example', 'http://sap.example', 'https://sap.example:44310'].map(adtPort), [443, 80, 44310]);
});

test('message server server lists yield application hosts of the same system', async t => {
  const body = 'version\t1.2\nsapt4dci_T4D_10\tsapt4dci\t3210\nsapt4dap.other.example_T4D_11\nsapq4dci_Q4D_00\n';
  assert.deepEqual(parseMessageServerServers(body, { host: 's4hana-t4d.siemens.example', systemId: 'T4D' }), [
    { host: 'sapt4dci.siemens.example', instance: '10' },
    { host: 'sapt4dap.other.example', instance: '11' }
  ]);
  const server = createServer((request, response) => {
    if (request.url === '/msgserver/text/logon') response.end(body);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(await messageServerAppServers({ host: '127.0.0.1', httpPort: server.address().port, systemId: 'T4D' }), [
    { host: 'sapt4dci', instance: '10' },
    { host: 'sapt4dap.other.example', instance: '11' }
  ]);
  assert.deepEqual(await messageServerAppServers({ host: '127.0.0.1', httpPort: 1 }), []);
});
