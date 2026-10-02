import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMcpEntries, buildSapDevelopmentMcpEntries, collectCloudFoundryKeyReferencesFromAllEntries, collectManagedCloudFoundryKeyReferences, generatedServerName, installMcpConfig, readMcpConfig, repairManagedMcpConfig, resolveMcpConfigPath } from '../src/mcp-config.mjs';

const bas = {
  source: 'bas', name: 'shared', serverName: 'shared', url: 'http://shared.dest',
  client: '001', authentication: 'NoAuthentication', probe: { status: 'available', available: true }
};

function cfDestination(spaceGuid, destinationInstanceGuid, keyName, proxyType = 'Internet') {
  return {
    source: 'cloud-foundry',
    name: 'shared',
    serverName: `cf:${spaceGuid}:${destinationInstanceGuid}:shared`,
    client: '100',
    authentication: 'BasicAuthentication',
    proxyType,
    probe: { status: 'auth-required', available: true },
    cf: {
      spaceGuid,
      destinationInstanceGuid,
      destinationInstanceName: `destination-${destinationInstanceGuid}`,
      destinationKeyName: keyName,
      ...(proxyType === 'OnPremise' ? {
        connectivityInstanceGuid: 'connectivity-guid',
        connectivityInstanceName: 'connectivity-service',
        connectivityKeyName: 'connectivity-key'
      } : {})
    }
  };
}

test('writes source-qualified CF entries beside same-named BAS destinations', () => {
  const first = cfDestination('space-one', 'instance-one', 'key-one');
  const second = cfDestination('space-one', 'instance-two', 'key-two');
  const entries = buildMcpEntries([bas, first, second], { H2O_URL: 'http://h2o.example' });
  assert.deepEqual(Object.keys(entries).sort(), [
    'cf-space-one-instance-one-shared',
    'cf-space-one-instance-two-shared',
    'shared'
  ]);
  assert.deepEqual(entries['cf-space-one-instance-one-shared'].env, {
    H2O_URL: 'http://h2o.example',
    SAP_ALLOW_TRANSPORTABLE_EDITS: 'true',
    SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'cloud-foundry',
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'shared',
    BAS_CF_SPACE_GUID: 'space-one',
    BAS_CF_DESTINATION_INSTANCE_GUID: 'instance-one',
    BAS_CF_DESTINATION_INSTANCE: 'destination-instance-one',
    BAS_CF_DESTINATION_KEY: 'key-one',
    BAS_CF_DESTINATION_NAME: 'shared'
  });
  assert.equal(entries.shared.env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'shared');
  assert.equal(JSON.stringify(entries).includes('shared.dest'), false);
  assert.equal(JSON.stringify(entries).includes('Password'), false);

  const onPremise = buildMcpEntries([cfDestination('space-one', 'onprem-instance', 'destination-key', 'OnPremise')], { H2O_URL: 'http://h2o.example' });
  assert.equal(onPremise['cf-space-one-onprem-instance-shared'].env.BAS_CF_CONNECTIVITY_KEY, 'connectivity-key');
});

test('local SAP GUI config rejects missing ADT URLs and mixed non-local entries without BAS', () => {
  assert.throws(() => buildMcpEntries([{ source: 'sap-gui-local', name: 'Local Missing URL', client: '100' }], {}), /missing an ADT URL/);
  assert.throws(() => buildMcpEntries([
    { source: 'sap-gui-local', name: 'Local Dev', url: 'https://abap.example.com:44300', client: '100' },
    bas
  ], {}), /H2O_URL is required/);
});

test('local SAP GUI entries detect normalized name collisions', () => {
  assert.throws(() => buildMcpEntries([
    { source: 'sap-gui-local', name: 'Local Dev', url: 'https://one.example.com', client: '100' },
    { source: 'sap-gui-local', name: 'Local_Dev', url: 'https://two.example.com', client: '200' }
  ], {}), /Duplicate MCP destination server name/);
});

test('local SAP GUI generated inputs replace stale managed inputs but preserve user inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-stale-inputs-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({
    inputs: [
      { id: 'keep-me', type: 'promptString' },
      { id: 'sap-ai-dev-local-dev-user', type: 'promptString', description: 'old user' },
      { id: 'sap-ai-dev-local-dev-password', type: 'promptString', description: 'old password', password: true }
    ],
    servers: {
      'local-dev': {
        type: 'stdio',
        command: 'sap-ai-dev',
        BAS_EXT: 'true',
        env: {
          SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
          SAP_AI_DEV_TOOLKIT_DESTINATION: 'Local Dev',
          SAP_URL: 'https://old.example.com',
          SAP_USER: '${input:sap-ai-dev-local-dev-user}',
          SAP_PASSWORD: '${input:sap-ai-dev-local-dev-password}'
        }
      }
    }
  }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installMcpConfig([{
    source: 'sap-gui-local',
    name: 'Local Dev',
    url: 'https://new.example.com',
    client: '200',
    childEnv: { SAP_USER: '${input:sap-ai-dev-local-dev-user}', SAP_PASSWORD: '${input:sap-ai-dev-local-dev-password}' },
    inputs: [
      { id: 'sap-ai-dev-local-dev-user', type: 'promptString', description: 'SAP user for Local Dev' },
      { id: 'sap-ai-dev-local-dev-password', type: 'promptString', description: 'SAP password for Local Dev', password: true }
    ]
  }], { env: {}, path, command: 'sap-ai-dev' });
  const config = await readMcpConfig(path);
  assert.equal(config.servers['local-dev'].env.SAP_URL, 'https://new.example.com');
  assert.deepEqual(config.inputs, [
    { id: 'keep-me', type: 'promptString' },
    { id: 'sap-ai-dev-local-dev-user', type: 'promptString', description: 'SAP user for Local Dev' },
    { id: 'sap-ai-dev-local-dev-password', type: 'promptString', description: 'SAP password for Local Dev', password: true }
  ]);
});

test('writes local SAP GUI entries with VS Code login inputs and no BAS dependency', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path, JSON.stringify({ inputs: [{ id: 'keep-me', type: 'promptString' }], servers: { userServer: { command: 'custom-server' } } }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const local = {
    source: 'sap-gui-local',
    name: 'Dev ABAP',
    serverName: 'Dev ABAP',
    url: 'https://abap.example.com:44300',
    client: '100',
    systemId: 'A4H',
    childEnv: { SAP_USER: '${input:sap-ai-dev-dev-abap-user}', SAP_PASSWORD: '${input:sap-ai-dev-dev-abap-password}' },
    inputs: [
      { id: 'sap-ai-dev-dev-abap-user', type: 'promptString', description: 'SAP user for Dev ABAP' },
      { id: 'sap-ai-dev-dev-abap-password', type: 'promptString', description: 'SAP password for Dev ABAP', password: true }
    ]
  };
  const installed = await installMcpConfig([local], { env: { PATH: directory }, path });
  assert.equal(installed.servers['a4h-100'].env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE, 'sap-gui-local');
  assert.equal(installed.servers['a4h-100'].env.SAP_URL, 'https://abap.example.com:44300');
  assert.equal(installed.servers['a4h-100'].env.H2O_URL, undefined);
  let config = await readMcpConfig(path);
  assert.deepEqual(config.inputs.map(input => input.id), ['keep-me', 'sap-ai-dev-dev-abap-user', 'sap-ai-dev-dev-abap-password']);

  await installMcpConfig([], { env: { PATH: directory }, path });
  config = await readMcpConfig(path);
  assert.deepEqual(Object.keys(config.servers), ['userServer']);
  assert.deepEqual(config.inputs, [{ id: 'keep-me', type: 'promptString' }]);
});

test('writes local SAP GUI Windows SSO entries without username or password inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-sso-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const installed = await installMcpConfig([{
    source: 'sap-gui-local',
    name: 'SSO ABAP',
    serverName: 'SSO ABAP',
    url: 'https://sso.example.com:44300',
    client: '100',
    systemId: 'S4H',
    authentication: 'WindowsSSO',
    childEnv: { SAP_AUTH_MODE: 'windows-sso' },
    inputs: []
  }], { env: { PATH: directory }, path });

  assert.equal(installed.servers['s4h-100'].env.SAP_AUTH_MODE, 'windows-sso');
  assert.equal(installed.servers['s4h-100'].env.SAP_USER, undefined);
  assert.equal(installed.servers['s4h-100'].env.SAP_PASSWORD, undefined);
  const config = await readMcpConfig(path);
  assert.deepEqual(config.inputs || [], []);
});

test('writes local SAP GUI Windows SSO entries with Basic fallback inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-sso-fallback-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installMcpConfig([{
    source: 'sap-gui-local',
    name: 'SSO ABAP',
    serverName: 'SSO ABAP',
    url: 'https://sso.example.com:44300',
    client: '100',
    systemId: 'S4H',
    authentication: 'WindowsSSO',
    childEnv: {
      SAP_AUTH_MODE: 'windows-sso',
      SAP_AUTH_FALLBACK_MODE: 'basic',
      SAP_USER: '${input:sap-ai-dev-sso-abap-user}',
      SAP_PASSWORD: '${input:sap-ai-dev-sso-abap-password}'
    },
    inputs: [
      { id: 'sap-ai-dev-sso-abap-user', type: 'promptString', description: 'SAP user for SSO ABAP' },
      { id: 'sap-ai-dev-sso-abap-password', type: 'promptString', description: 'SAP password for SSO ABAP', password: true }
    ]
  }], { env: { PATH: directory }, path });

  const config = await readMcpConfig(path);
  assert.equal(config.servers['s4h-100'].env.SAP_AUTH_MODE, 'windows-sso');
  assert.equal(config.servers['s4h-100'].env.SAP_AUTH_FALLBACK_MODE, 'basic');
  assert.equal(config.servers['s4h-100'].env.SAP_USER, '${input:sap-ai-dev-sso-abap-user}');
  assert.deepEqual(config.inputs.map(input => input.id), ['sap-ai-dev-sso-abap-user', 'sap-ai-dev-sso-abap-password']);
});

test('writes local SAP GUI Windows credential UI entries without password inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-win-ui-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installMcpConfig([{
    source: 'sap-gui-local',
    name: 'SSO ABAP',
    serverName: 'SSO ABAP',
    url: 'https://sso.example.com:44300',
    client: '100',
    systemId: 'S4H',
    authentication: 'WindowsSSO',
    childEnv: { SAP_AUTH_MODE: 'windows-sso', SAP_AI_DEV_TOOLKIT_WINDOWS_CREDENTIAL_UI: 'true' },
    inputs: []
  }], { env: { PATH: directory }, path });

  const config = await readMcpConfig(path);
  assert.equal(config.servers['s4h-100'].env.SAP_AUTH_MODE, 'windows-sso');
  assert.equal(config.servers['s4h-100'].env.SAP_AI_DEV_TOOLKIT_WINDOWS_CREDENTIAL_UI, 'true');
  assert.equal(config.servers['s4h-100'].env.SAP_USER, undefined);
  assert.deepEqual(config.inputs || [], []);
});

test('writes local SAP GUI browser SAML entries without credential inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-browser-saml-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installMcpConfig([{
    source: 'sap-gui-local',
    name: 'Browser ABAP',
    serverName: 'Browser ABAP',
    url: 'https://browser.example.com:44300',
    client: '100',
    systemId: 'B4H',
    authentication: 'BrowserSAML',
    childEnv: { SAP_AUTH_MODE: 'browser-saml', SAP_BROWSER_AUTH: 'true', SAP_SAML_AUTH: 'true' },
    inputs: []
  }], { env: { PATH: directory }, path });

  const config = await readMcpConfig(path);
  assert.equal(config.servers['b4h-100'].env.SAP_AUTH_MODE, 'browser-saml');
  assert.equal(config.servers['b4h-100'].env.SAP_BROWSER_AUTH, 'true');
  assert.equal(config.servers['b4h-100'].env.SAP_SAML_AUTH, 'true');
  assert.deepEqual(config.inputs || [], []);
});

test('writes local SAP GUI SAML password entries with SAML-only input ids', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-gui-saml-password-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installMcpConfig([{
    source: 'sap-gui-local',
    name: 'SAML ABAP',
    serverName: 'SAML ABAP',
    url: 'https://saml.example.com:44300',
    client: '100',
    systemId: 'M4H',
    authentication: 'SAML',
    childEnv: {
      SAP_AUTH_MODE: 'saml-password',
      SAP_SAML_AUTH: 'true',
      SAP_SAML_USER: '${input:sap-ai-dev-saml-abap-user}',
      SAP_SAML_PASSWORD: '${input:sap-ai-dev-saml-abap-password}'
    },
    inputs: [
      { id: 'sap-ai-dev-saml-abap-user', type: 'promptString', description: 'SAP user for SAML ABAP' },
      { id: 'sap-ai-dev-saml-abap-password', type: 'promptString', description: 'SAP password for SAML ABAP', password: true }
    ]
  }], { env: { PATH: directory }, path });

  const config = await readMcpConfig(path);
  assert.equal(config.servers['m4h-100'].env.SAP_AUTH_MODE, 'saml-password');
  assert.equal(config.servers['m4h-100'].env.SAP_SAML_USER, '${input:sap-ai-dev-saml-abap-user}');
  assert.equal(config.servers['m4h-100'].env.SAP_USER, undefined);
  assert.deepEqual(config.inputs.map(input => input.id), ['sap-ai-dev-saml-abap-user', 'sap-ai-dev-saml-abap-password']);
});

test('stores and reconciles the MCP launcher executable location', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-launcher-location-'));
  const path = join(directory, 'mcp.json');
  const command = join(directory, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path, JSON.stringify({ servers: { userServer: { command: 'custom-server' } } }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const env = { H2O_URL: 'http://h2o.example', PATH: directory };
  const installed = await installMcpConfig([bas], { env, path });
  assert.equal(installed.servers.shared.command, command);
  assert.equal((await readMcpConfig(path)).servers.shared.command, command);

  await installMcpConfig([], { env, path });
  assert.deepEqual(Object.keys((await readMcpConfig(path)).servers), ['userServer']);
});

test('resolves documented, toolkit, and legacy MCP config paths in order', async () => {
  assert.equal(await resolveMcpConfigPath({
    SAP_AI_DEV_MCP_CONFIG: '/tmp/documented-mcp.json',
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: '/tmp/toolkit-mcp.json',
    BAS_VSP_MCP_CONFIG: '/tmp/legacy-mcp.json'
  }), '/tmp/documented-mcp.json');
  assert.equal(await resolveMcpConfigPath({
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: '/tmp/toolkit-mcp.json',
    BAS_VSP_MCP_CONFIG: '/tmp/legacy-mcp.json'
  }), '/tmp/toolkit-mcp.json');
  assert.equal(await resolveMcpConfigPath({ BAS_VSP_MCP_CONFIG: '/tmp/legacy-mcp.json' }), '/tmp/legacy-mcp.json');
});

test('resolves BAS MCP fallback path before local VS Code path inside BAS when no config exists', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-bas-vscode-fallback-'));
  const appData = join(directory, 'AppData', 'Roaming');
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(
    await resolveMcpConfigPath({ HOME: directory, APPDATA: appData, H2O_URL: 'http://bas.example' }),
    join(directory, '.vscode', 'data', 'User', 'mcp.json')
  );
});

test('resolves a local VS Code MCP fallback path outside BAS when no config exists', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-vscode-fallback-'));
  const appData = join(directory, 'AppData', 'Roaming');
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(
    await resolveMcpConfigPath({ HOME: directory, APPDATA: appData }),
    join(appData, 'Code', 'User', 'mcp.json')
  );
});

test('resolves local VS Code MCP config paths before BAS server paths outside BAS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-vscode-config-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const localConfig = join(appData, 'Code', 'User', 'mcp.json');
  const basConfig = join(directory, '.vscode', 'data', 'User', 'mcp.json');
  await mkdir(join(appData, 'Code', 'User'), { recursive: true });
  await mkdir(join(directory, '.vscode', 'data', 'User'), { recursive: true });
  await writeFile(localConfig, JSON.stringify({ servers: {} }));
  await writeFile(basConfig, JSON.stringify({ servers: {} }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await resolveMcpConfigPath({ HOME: directory, APPDATA: appData }), localConfig);
  assert.equal(await resolveMcpConfigPath({ HOME: directory, APPDATA: appData, H2O_URL: 'http://bas.example' }), basConfig);
});

test('doctor repair updates only discovered toolkit BAS entries and is idempotent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-repair-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cf = cfDestination('space-one', 'instance-one', 'cf-key');
  const strictDestination = { ...bas, name: 'strict', serverName: 'strict', url: 'http://strict.dest' };
  const managed = buildMcpEntries([bas], { H2O_URL: 'http://old-h2o.example' }).shared;
  const strictManaged = buildMcpEntries([strictDestination], { H2O_URL: 'http://old-h2o.example' }).strict;
  const cfEntry = buildMcpEntries([cf], { H2O_URL: 'http://cf-h2o.example' })[generatedServerName(cf.serverName)];
  const companion = buildSapDevelopmentMcpEntries(['sap-fiori-tools'])['sap-fiori-tools'];
  const unrelated = { type: 'stdio', command: 'external-server' };
  const unverifiedManaged = {
    ...managed,
    env: { ...managed.env, SAP_AI_DEV_TOOLKIT_DESTINATION: 'temporarily-unavailable' }
  };
  const config = {
    userFlag: true,
    servers: {
      shared: { ...managed, env: { ...managed.env, H2O_URL: 'http://old-h2o.example' } },
      strict: { ...strictManaged, env: { ...strictManaged.env, SAP_ALLOW_TRANSPORTABLE_EDITS: 'false' } },
      'temporarily-unavailable': unverifiedManaged,
      [generatedServerName(cf.serverName)]: cfEntry,
      'sap-fiori-tools': companion,
      ActionS4D_100: unrelated
    }
  };
  await writeFile(path, JSON.stringify(config, null, 2));

  const first = await repairManagedMcpConfig([bas, strictDestination], { env: { H2O_URL: 'http://current-h2o.example' }, path, discoveryComplete: true });
  assert.equal(first.changed, true);
  assert.equal(first.repaired, 2);
  const repaired = await readMcpConfig(path);
  assert.equal(repaired.userFlag, true);
  assert.equal(repaired.servers.shared.env.H2O_URL, 'http://current-h2o.example');
  assert.equal(repaired.servers.shared.env.SAP_ALLOW_TRANSPORTABLE_EDITS, 'true');
  assert.equal(repaired.servers.strict.env.SAP_ALLOW_TRANSPORTABLE_EDITS, 'false', "doctor must preserve a user's restricted write setting");
  assert.deepEqual(repaired.servers['temporarily-unavailable'], unverifiedManaged);
  assert.deepEqual(repaired.servers[generatedServerName(cf.serverName)], cfEntry);
  assert.deepEqual(repaired.servers['sap-fiori-tools'], companion);
  assert.deepEqual(repaired.servers.ActionS4D_100, unrelated);
  assert.equal(repaired.servers.newDestination, undefined, 'repair must not add unselected destinations');

  const beforeSecondRepair = await readFile(path, 'utf8');
  const second = await repairManagedMcpConfig([bas, strictDestination], { env: { H2O_URL: 'http://current-h2o.example' }, path, discoveryComplete: true });
  assert.equal(second.changed, false);
  assert.equal(second.repaired, 0);
  assert.equal(await readFile(path, 'utf8'), beforeSecondRepair, 'an already-healed config must not be rewritten');
});

test('doctor repair leaves malformed config untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-repair-invalid-'));
  const path = join(directory, 'mcp.json');
  const malformed = '{ "servers": ';
  await writeFile(path, malformed);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => repairManagedMcpConfig([bas], { env: { H2O_URL: 'http://h2o.example' }, path, discoveryComplete: true }),
    /invalid JSON/
  );
  assert.equal(await readFile(path, 'utf8'), malformed);
});

test('doctor repair skips config changes if destination discovery is incomplete', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-repair-incomplete-'));
  const path = join(directory, 'mcp.json');
  const entry = buildMcpEntries([bas], { H2O_URL: 'http://old-h2o.example' }).shared;
  const initial = JSON.stringify({ servers: { shared: entry } });
  await writeFile(path, initial);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await repairManagedMcpConfig([bas], { env: { H2O_URL: 'http://new-h2o.example' }, path });
  assert.equal(result.changed, false);
  assert.match(result.skipped, /incomplete/);
  assert.equal(await readFile(path, 'utf8'), initial);
});

test('doctor repair refreshes stale toolkit launchers without changing npx behavior', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-launcher-repair-'));
  const path = join(directory, 'mcp.json');
  const bin = join(directory, 'bin');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
  const command = join(bin, 'sap-ai-dev');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npx = {
    ...buildMcpEntries([bas], { H2O_URL: 'http://old-h2o.example' }).shared,
    command: 'npx',
    args: ['--yes', '--package=sap-ai-dev-toolkit@0.4.2', 'sap-ai-dev'],
    env: {
      ...buildMcpEntries([bas], { H2O_URL: 'http://old-h2o.example' }).shared.env,
      SAP_AI_DEV_TOOLKIT_DESTINATION: 'shared',
      OPERATOR_SETTING: 'preserve'
    }
  };
  const direct = {
    ...buildMcpEntries([bas], { H2O_URL: 'http://old-h2o.example' }).shared,
    command: 'stale-sap-ai-dev'
  };
  await writeFile(path, JSON.stringify({ servers: { shared: npx, other: { ...direct, env: { ...direct.env, SAP_AI_DEV_TOOLKIT_DESTINATION: 'other' } }, userServer: { command: 'other' } } }));

  const result = await repairManagedMcpConfig([bas], {
    env: { H2O_URL: 'http://current-h2o.example', PATH: bin },
    path,
    discoveryComplete: true,
    packageVersion: '0.4.5'
  });
  assert.equal(result.repaired, 1, 'only the entry that maps to the discovered destination is repaired');
  const repaired = await readMcpConfig(path);
  assert.equal(repaired.servers.shared.command, 'npx');
  assert.deepEqual(repaired.servers.shared.args, ['--yes', '--package=sap-ai-dev-toolkit@0.4.5', 'sap-ai-dev']);
  assert.equal(repaired.servers.shared.env.OPERATOR_SETTING, 'preserve');
  assert.equal(repaired.servers.shared.env.H2O_URL, 'http://current-h2o.example');
  assert.equal(repaired.servers.other.command, 'stale-sap-ai-dev', 'unmatched toolkit entry must remain untouched');
  assert.deepEqual(repaired.servers.userServer, { command: 'other' });
});

test('extracts key references only from package-managed Cloud Foundry entries', () => {
  const cloudFoundry = buildMcpEntries([
    cfDestination('space-one', 'instance-one', 'destination-key', 'OnPremise')
  ], { H2O_URL: 'http://h2o.example' })['cf-space-one-instance-one-shared'];
  const managedNpx = {
    ...cloudFoundry,
    command: 'npx',
    args: ['--yes', '--package=sap-ai-dev-toolkit@0.1.0', 'sap-ai-dev']
  };
  const config = { servers: {
    first: cloudFoundry,
    duplicate: managedNpx,
    unmanaged: { ...cloudFoundry, BAS_EXT: undefined },
    otherPackage: { ...cloudFoundry, command: 'other' },
    otherSource: { ...cloudFoundry, env: { ...cloudFoundry.env, SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'bas' } }
  } };
  assert.deepEqual(collectManagedCloudFoundryKeyReferences(config), [
    { kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'instance-one', instanceName: 'destination-instance-one', keyName: 'destination-key' },
    { kind: 'connectivity', spaceGuid: 'space-one', instanceGuid: 'connectivity-guid', instanceName: 'connectivity-service', keyName: 'connectivity-key' }
  ]);
  const userConfig = { servers: {
    customServer: { command: 'custom-launcher', env: { ...cloudFoundry.env, SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: undefined } },
    noEnvironment: { command: 'custom-launcher' }
  } };
  assert.deepEqual(collectCloudFoundryKeyReferencesFromAllEntries(userConfig), [
    { kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'instance-one', instanceName: 'destination-instance-one', keyName: 'destination-key' },
    { kind: 'connectivity', spaceGuid: 'space-one', instanceGuid: 'connectivity-guid', instanceName: 'connectivity-service', keyName: 'connectivity-key' }
  ]);
});

test('builds SAP development companion MCP entries', () => {
  const entries = buildSapDevelopmentMcpEntries(['sap-fiori-tools', 'ui5-tools']);
  assert.deepEqual(Object.keys(entries), ['sap-fiori-tools', 'ui5-tools']);
  assert.deepEqual(entries['sap-fiori-tools'].args, ['--yes', '--package=@sap-ux/fiori-mcp-server', 'fiori-mcp']);
  assert.equal(entries['ui5-tools'].command, 'npx');
  assert.equal(entries['ui5-tools'].BAS_EXT_KIND, 'sap-development-companion');
  assert.throws(() => buildSapDevelopmentMcpEntries(['missing-tool']), /Unknown SAP development MCP server id/);
});

test('configures the HANA inspector without persisting credentials', () => {
  const entry = buildSapDevelopmentMcpEntries(['hana-cloud-inspector'])['hana-cloud-inspector'];
  assert.equal(entry.command, 'npx');
  assert.deepEqual(entry.args, ['--yes', '--ignore-scripts', '--package=sap-ai-dev-toolkit', 'sap-ai-hana']);
  assert.equal(entry.BAS_EXT_KIND, 'sap-development-companion');
  assert.equal(entry.displayName, 'HANA Cloud inspector');
  assert.equal(entry.env, undefined);
  assert.doesNotMatch(JSON.stringify(entry), /"(?:HANA_RO_PASSWORD|VCAP_SERVICES)"\s*:/);
  assert.doesNotMatch(JSON.stringify(entry), /"(?:password|pwd)"\s*:/i);
});

test('installs and removes SAP development companion entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-tools-config-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({ servers: { userServer: { type: 'stdio', command: 'custom-server' } } }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await installMcpConfig([], {
    env: { H2O_URL: 'http://h2o.example' },
    path,
    sapDevelopmentServers: ['sap-fiori-tools', 'cap-tools']
  });
  assert.deepEqual(Object.keys(result.servers).sort(), ['cap-tools', 'sap-fiori-tools']);
  const written = await readMcpConfig(path);
  assert.deepEqual(Object.keys(written.servers).sort(), ['cap-tools', 'sap-fiori-tools', 'userServer']);

  await installMcpConfig([], { env: { H2O_URL: 'http://h2o.example' }, path });
  const cleared = await readMcpConfig(path);
  assert.deepEqual(Object.keys(cleared.servers), ['userServer']);
});

test('installs and removes the HANA inspector without changing unrelated MCP servers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-hana-config-'));
  const path = join(directory, 'mcp.json');
  const initial = {
    custom: true,
    servers: { userServer: { type: 'stdio', command: 'custom-server' } }
  };
  await writeFile(path, JSON.stringify(initial));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const installed = await installMcpConfig([], {
    env: { H2O_URL: 'http://h2o.example' },
    path,
    sapDevelopmentServers: ['hana-cloud-inspector']
  });
  assert.deepEqual(Object.keys(installed.servers), ['hana-cloud-inspector']);
  const configured = await readMcpConfig(path);
  assert.deepEqual(Object.keys(configured.servers).sort(), ['hana-cloud-inspector', 'userServer']);
  assert.equal(configured.custom, true);
  assert.equal(configured.servers['hana-cloud-inspector'].env, undefined);
  assert.doesNotMatch(JSON.stringify(configured), /"(?:HANA_RO_PASSWORD|VCAP_SERVICES)"\s*:/);
  assert.doesNotMatch(JSON.stringify(configured), /"(?:password|pwd)"\s*:/i);

  await installMcpConfig([], { env: { H2O_URL: 'http://h2o.example' }, path });
  const removed = await readMcpConfig(path);
  assert.deepEqual(removed.servers, initial.servers);
  assert.equal(removed.custom, true);
});

test('installs and removes CF entries without deleting unrelated MCP servers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-cf-config-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({
    unrelated: true,
    servers: { userServer: { type: 'stdio', command: 'custom-server' } }
  }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await installMcpConfig([bas, cfDestination('space-one', 'instance-one', 'managed-key')], {
    env: { H2O_URL: 'http://h2o.example' },
    path,
    command: 'npx',
    args: ['--yes', '--package=sap-ai-dev-toolkit@0.1.0', 'sap-ai-dev']
  });
  assert.deepEqual(Object.keys(result.servers).sort(), ['cf-space-one-instance-one-shared', 'shared']);
  const written = await readMcpConfig(path);
  assert.equal(written.unrelated, true);
  assert.deepEqual(Object.keys(written.servers).sort(), ['cf-space-one-instance-one-shared', 'shared', 'userServer']);
  assert.deepEqual(collectManagedCloudFoundryKeyReferences(written), [
    { kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'instance-one', instanceName: 'destination-instance-one', keyName: 'managed-key' }
  ]);

  await installMcpConfig([], { env: { H2O_URL: 'http://h2o.example' }, path });
  const cleared = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(cleared.servers), ['userServer']);
});

test('wizard replaces legacy launcher entries with the branded command and environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-migration-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({
    servers: {
      shared: {
        type: 'stdio',
        command: 'bas-vsp-mcp',
        env: { H2O_URL: 'http://h2o.example', BAS_VSP_DESTINATION: 'shared' },
        BAS_EXT: 'true'
      },
      userServer: { type: 'stdio', command: 'custom-server' }
    }
  }));

  await installMcpConfig([bas], { env: { H2O_URL: 'http://h2o.example', BAS_VSP_MCP_CONFIG: path } });
  const migrated = await readMcpConfig(path);
  assert.deepEqual(Object.keys(migrated.servers).sort(), ['shared', 'userServer']);
  assert.equal(migrated.servers.shared.command, 'sap-ai-dev');
  assert.equal(migrated.servers.shared.env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'shared');
  assert.equal(migrated.servers.shared.env.BAS_VSP_DESTINATION, undefined);
  assert.equal(migrated.servers.userServer.command, 'custom-server');
});

test('recognizes old npx Cloud Foundry entries so setup can reuse their service keys', () => {
  const current = buildMcpEntries([cfDestination('space-one', 'instance-one', 'old-key')], { H2O_URL: 'http://h2o.example' })['cf-space-one-instance-one-shared'];
  const legacy = {
    ...current,
    command: 'npx',
    args: ['--yes', '--package=bas-mcp-addon@0.1.0', 'bas-vsp-mcp'],
    env: {
      ...current.env,
      BAS_VSP_DESTINATION_SOURCE: current.env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE,
      BAS_VSP_DESTINATION: current.env.SAP_AI_DEV_TOOLKIT_DESTINATION
    }
  };
  delete legacy.BAS_EXT;
  delete legacy.env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE;
  delete legacy.env.SAP_AI_DEV_TOOLKIT_DESTINATION;
  assert.deepEqual(collectManagedCloudFoundryKeyReferences({ servers: { legacy } }), [
    { kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'instance-one', instanceName: 'destination-instance-one', keyName: 'old-key' }
  ]);
});

test('setup removes untagged legacy bas-mcp-addon launchers that expose the full VSP surface', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-untagged-legacy-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({
    servers: {
      shared: {
        type: 'stdio',
        command: 'npx',
        args: ['--yes', '--package=bas-mcp-addon@0.2.0', 'bas-vsp-mcp'],
        env: { H2O_URL: 'http://old-h2o.example', BAS_VSP_DESTINATION: 'shared' }
      },
      legacyCommand: {
        type: 'stdio',
        command: 'bas-vsp-mcp',
        env: { H2O_URL: 'http://old-h2o.example', BAS_VSP_DESTINATION: 'other' }
      },
      userServer: { type: 'stdio', command: 'custom-server' }
    }
  }));

  await installMcpConfig([bas], { env: { H2O_URL: 'http://h2o.example' }, path });
  const migrated = await readMcpConfig(path);
  assert.deepEqual(Object.keys(migrated.servers).sort(), ['shared', 'userServer']);
  assert.equal(migrated.servers.shared.command, 'sap-ai-dev');
  assert.equal(migrated.servers.shared.env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'shared');
});

test('install registers mixed-case destinations under lowercase server names', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-lowercase-install-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = { ...bas, name: 'ActionS4D', serverName: 'ActionS4D', url: 'http://ActionS4D.dest' };
  await writeFile(path, JSON.stringify({ servers: {} }));

  const result = await installMcpConfig([destination], { env: { H2O_URL: 'http://h2o.example' }, path });
  assert.deepEqual(Object.keys(result.servers), ['actions4d']);
  assert.match(Object.keys(result.servers)[0], /^[a-z0-9-]+$/, 'server names must be lowercase slugs');
  assert.equal(result.servers.actions4d.env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'ActionS4D');

  // Re-running setup replaces a legacy mixed-case managed entry with the slug key.
  const legacy = { ...result.servers.actions4d };
  await writeFile(path, JSON.stringify({ servers: { ActionS4D: legacy, userServer: { command: 'other' } } }));
  await installMcpConfig([destination], { env: { H2O_URL: 'http://h2o.example' }, path });
  const written = await readMcpConfig(path);
  assert.deepEqual(Object.keys(written.servers).sort(), ['actions4d', 'userServer']);

  // Destination names that only differ in case or punctuation now collide.
  assert.throws(
    () => buildMcpEntries([destination, { ...bas, name: 'actions4d' }], { H2O_URL: 'http://h2o.example' }),
    /normalize to the same lowercase server name/
  );
});

test('doctor repair renames legacy mixed-case managed entries to the lowercase slug', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-rename-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = { ...bas, name: 'ActionS4D', serverName: 'ActionS4D', url: 'http://ActionS4D.dest' };
  const legacy = buildMcpEntries([destination], { H2O_URL: 'http://old-h2o.example' }).actions4d;
  const unrelated = { type: 'stdio', command: 'third-party' };
  await writeFile(path, JSON.stringify({ servers: { ActionS4D: legacy, ActionS4D_100: unrelated } }));

  const first = await repairManagedMcpConfig([destination], { env: { H2O_URL: 'http://current-h2o.example' }, path, discoveryComplete: true });
  assert.equal(first.changed, true);
  assert.equal(first.repaired, 1);
  const renamed = await readMcpConfig(path);
  assert.equal(renamed.servers.ActionS4D, undefined, 'the legacy mixed-case key must be removed');
  assert.equal(renamed.servers.actions4d.env.H2O_URL, 'http://current-h2o.example');
  assert.equal(renamed.servers.actions4d.env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'ActionS4D');
  assert.deepEqual(renamed.servers.ActionS4D_100, unrelated);

  const beforeSecond = await readFile(path, 'utf8');
  const second = await repairManagedMcpConfig([destination], { env: { H2O_URL: 'http://current-h2o.example' }, path, discoveryComplete: true });
  assert.equal(second.changed, false);
  assert.equal(second.repaired, 0);
  assert.equal(await readFile(path, 'utf8'), beforeSecond, 'the rename must be idempotent');
});

test('doctor repair keeps the legacy entry when a user-owned server holds the slug key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-rename-blocked-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = { ...bas, name: 'ActionS4D', serverName: 'ActionS4D', url: 'http://ActionS4D.dest' };
  const legacy = buildMcpEntries([destination], { H2O_URL: 'http://old-h2o.example' }).actions4d;
  const userOwned = { type: 'stdio', command: 'user-server' };
  const initial = { servers: { ActionS4D: legacy, actions4d: userOwned } };
  await writeFile(path, JSON.stringify(initial));

  const result = await repairManagedMcpConfig([destination], { env: { H2O_URL: 'http://current-h2o.example' }, path, discoveryComplete: true });
  assert.equal(result.repaired, 0, 'a user-owned entry on the slug key must block the rename');
  const config = await readMcpConfig(path);
  assert.deepEqual(config, initial);
});

