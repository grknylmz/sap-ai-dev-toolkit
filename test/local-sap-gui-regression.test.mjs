import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSapGuiSystems, defaultAdtUrl } from '../src/local-sap-gui.mjs';

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
