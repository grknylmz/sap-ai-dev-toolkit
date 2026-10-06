import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupPathCandidates, buildMcpEntries, buildSapDevelopmentMcpEntries, collectCloudFoundryKeyReferencesFromAllEntries, collectManagedCloudFoundryKeyReferences, decodeJsonFileBuffer, generatedServerName, installMcpConfig, loosenJsonText, readMcpConfig, repairManagedMcpConfig, resolveMcpConfigPath, writeConfigBackup } from '../src/mcp-config.mjs';

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

test('builds Windows companion MCP entries that MCP hosts can spawn', () => {
  // Windows has no npx.exe; hosts spawn commands directly without shell PATH
  // resolution, so npx-launched entries must route through cmd /c there.
  const entries = buildSapDevelopmentMcpEntries(['sap-fiori-tools', 'hana-cloud-inspector'], { platform: 'win32' });
  assert.equal(entries['sap-fiori-tools'].command, 'cmd');
  assert.deepEqual(entries['sap-fiori-tools'].args, ['/c', 'npx', '--yes', '--package=@sap-ux/fiori-mcp-server', 'fiori-mcp']);
  assert.equal(entries['hana-cloud-inspector'].command, 'cmd');
  assert.deepEqual(entries['hana-cloud-inspector'].args, ['/c', 'npx', '--yes', '--ignore-scripts', '--package=sap-ai-dev-toolkit', 'sap-ai-hana']);
});

test('Windows cmd /c npx destination entries stay managed and repairable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-win-npx-'));
  const path = join(directory, 'mcp.json');
  const env = { H2O_URL: 'http://h2o.example' };
  try {
    await writeFile(path, JSON.stringify({ servers: {
      unrelated: { type: 'stdio', command: 'other' },
      shared: {
        type: 'stdio',
        command: 'cmd',
        args: ['/c', 'npx', '--yes', '--ignore-scripts', '--package=sap-ai-dev-toolkit@0.1.0', 'sap-ai-dev'],
        env: { SAP_AI_DEV_TOOLKIT_DESTINATION: 'shared', H2O_URL: 'http://old-h2o.example' },
        BAS_EXT: 'true'
      }
    } }));
    const destination = { ...bas, serverName: 'shared', url: 'http://shared.dest' };
    // Re-running setup recognizes the cmd /c npx entry as managed and
    // replaces it instead of failing with "already exists".
    await installMcpConfig([destination], {
      env, path, command: 'cmd',
      args: ['/c', 'npx', '--yes', '--ignore-scripts', '--package=sap-ai-dev-toolkit@0.2.0', 'sap-ai-dev']
    });
    let current = await readMcpConfig(path);
    assert.deepEqual(current.servers.shared.args, ['/c', 'npx', '--yes', '--ignore-scripts', '--package=sap-ai-dev-toolkit@0.2.0', 'sap-ai-dev']);
    assert.deepEqual(current.servers.unrelated, { type: 'stdio', command: 'other' });
    // Doctor repair re-pins the package version inside the cmd /c npx form.
    const repair = await repairManagedMcpConfig([destination], { env, path, discoveryComplete: true, packageVersion: '0.3.0' });
    assert.equal(repair.repaired, 1);
    current = await readMcpConfig(path);
    assert.equal(current.servers.shared.command, 'cmd');
    assert.deepEqual(current.servers.shared.args, ['/c', 'npx', '--yes', '--ignore-scripts', '--package=sap-ai-dev-toolkit@0.3.0', 'sap-ai-dev']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  await writeFile(join(directory, 'sap-ai-dev'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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

  await installMcpConfig([bas], { env: { PATH: directory, H2O_URL: 'http://h2o.example', BAS_VSP_MCP_CONFIG: path } });
  const migrated = await readMcpConfig(path);
  assert.deepEqual(Object.keys(migrated.servers).sort(), ['shared', 'userServer']);
  assert.equal(migrated.servers.shared.command, join(directory, 'sap-ai-dev'));
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
  await writeFile(join(directory, 'sap-ai-dev'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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

  await installMcpConfig([bas], { env: { PATH: directory, H2O_URL: 'http://h2o.example' }, path });
  const migrated = await readMcpConfig(path);
  assert.deepEqual(Object.keys(migrated.servers).sort(), ['shared', 'userServer']);
  assert.equal(migrated.servers.shared.command, join(directory, 'sap-ai-dev'));
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


test('decodeJsonFileBuffer tolerates BOM and UTF-16 encodings written by Windows tools', () => {
  const json = '{"servers":{"memory":{"command":"npx"}}}';
  const utf8Bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(json, 'utf8')]);
  assert.equal(decodeJsonFileBuffer(utf8Bom), json);
  const utf16Le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(json, 'utf16le')]);
  assert.equal(decodeJsonFileBuffer(utf16Le), json);
  const utf16Be = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(json, 'utf16le').swap16()]);
  assert.equal(decodeJsonFileBuffer(utf16Be), json);
  assert.equal(decodeJsonFileBuffer(Buffer.from(json, 'utf8')), json);
  assert.equal(JSON.parse(decodeJsonFileBuffer(utf8Bom)).servers.memory.command, 'npx');
});

test('setup reads mcp.json written with a UTF-8 BOM and preserves unrelated servers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-bom-'));
  const path = join(directory, 'mcp.json');
  const memory = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
  // PowerShell `>` / Notepad "UTF-8 with BOM" form; JSON.parse alone rejects
  // the leading U+FEFF ("Unexpected token ''").
  await writeFile(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ servers: { memory } }, null, 2))]));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const local = {
    source: 'sap-gui-local', name: 'Dev ABAP', serverName: 'Dev ABAP',
    url: 'https://abap.example.com:44300', client: '200', systemId: 'A4H'
  };
  const result = await installMcpConfig([local], { env: { PATH: directory }, path });
  assert.deepEqual(result.warnings, []);
  const config = await readMcpConfig(path);
  assert.deepEqual(config.servers.memory, memory);
  assert.ok(config.servers['a4h-200']);
  const written = await readFile(path);
  assert.equal(written[0], 0x7B, 'the rewritten config must be UTF-8 without a BOM');
});

test('setup reads mcp.json written as UTF-16 LE (PowerShell redirection)', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-utf16-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify({ servers: { memory: { command: 'npx' } } }), 'utf16le')]));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await installMcpConfig([], { env: { PATH: directory }, path });
  const config = await readMcpConfig(path);
  assert.equal(config.servers.memory.command, 'npx');
  assert.equal((await readFile(path))[0], 0x7B, 'the rewritten config must be UTF-8');
});

test('setup self-heals an unreadable mcp.json by backing it up and starting fresh', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-heal-'));
  const path = join(directory, 'mcp.json');
  const broken = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"servers": ')]);
  await writeFile(path, broken);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const local = {
    source: 'sap-gui-local', name: 'Dev ABAP', serverName: 'Dev ABAP',
    url: 'https://abap.example.com:44300', client: '200', systemId: 'A4H'
  };
  const result = await installMcpConfig([local], { env: { PATH: directory }, path });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /backed up to .*\.bak/);
  const files = (await readdir(directory)).filter(name => name.endsWith('.bak'));
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(directory, files[0])), broken, 'the backup must preserve the original bytes');
  const config = await readMcpConfig(path);
  assert.deepEqual(Object.keys(config.servers), ['a4h-200']);
});

test('doctor repair tolerates a UTF-8 BOM in mcp.json', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-doctor-bom-'));
  const path = join(directory, 'mcp.json');
  const entry = buildMcpEntries([bas], { H2O_URL: 'http://old-h2o.example' }).shared;
  await writeFile(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ servers: { shared: entry } }))]));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await repairManagedMcpConfig([bas], { env: { H2O_URL: 'http://current-h2o.example' }, path, discoveryComplete: true });
  assert.equal(result.changed, true);
  assert.equal(result.repaired, 1);
  const healed = await readFile(path);
  assert.equal(healed[0], 0x7B, 'repair rewrites the config as UTF-8 without a BOM');
});

test('loosenJsonText strips JSONC comments and trailing commas without touching string contents', () => {
  const jsonc = [
    '{',
    '  // line comment with "quotes" and : colons',
    '  "name": "http://example.com", /* block, */ "items": [1, 2,],',
    '  "tricky": "a \\" /* not a comment */ b",',
    '  "empty": { /* nothing */ },',
    '  "comma": "x,y}",',
    '  /* multi',
    '     line */',
    '}',
  ].join('\n');
  assert.deepEqual(JSON.parse(loosenJsonText(jsonc)), {
    name: 'http://example.com',
    items: [1, 2],
    tricky: 'a " /* not a comment */ b',
    empty: {},
    comma: 'x,y}'
  });
  assert.equal(loosenJsonText('{"a":1}'), '{"a":1}', 'already-strict text passes through unchanged');
  assert.throws(() => JSON.parse(loosenJsonText('{"a": "unterminated')), 'unrecoverable text still fails strict parsing');
});

test('setup treats a blank or BOM-only mcp.json as a clean slate without backups', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-blank-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('  \n\t ')]));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await installMcpConfig([], { env: { PATH: directory }, path });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.bak')), []);
  assert.deepEqual((await readMcpConfig(path)).servers, {});
});

test('setup recovers mcp.json with VS Code style comments instead of resetting it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-jsonc-'));
  const path = join(directory, 'mcp.json');
  const original = [
    '{',
    '  // my servers',
    '  "servers": {',
    '    "memory": { "command": "npx", },',
    '  },',
    '}',
  ].join('\n');
  await writeFile(path, original);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const local = {
    source: 'sap-gui-local', name: 'Dev ABAP', serverName: 'Dev ABAP',
    url: 'https://abap.example.com:44300', client: '200', systemId: 'A4H'
  };
  const result = await installMcpConfig([local], { env: { PATH: directory }, path });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /comments.*backed up|backed up.*comments/);
  const backups = (await readdir(directory)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /\.healed-.*\.bak$/);
  assert.equal(await readFile(join(directory, backups[0]), 'utf8'), original, 'the backup preserves the commented original');
  const config = JSON.parse(await readFile(path, 'utf8'), 'strict parse must now succeed');
  assert.ok(config.servers.memory);
  assert.ok(config.servers['a4h-200']);
});

test('setup repairs only broken fields and keeps unrelated config keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-fields-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({ servers: null, inputs: 'broken', userFlag: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const local = {
    source: 'sap-gui-local', name: 'Dev ABAP', serverName: 'Dev ABAP',
    url: 'https://abap.example.com:44300', client: '200', systemId: 'A4H'
  };
  const result = await installMcpConfig([local], { env: { PATH: directory }, path });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /"servers"/);
  assert.match(result.warnings[0], /"inputs"/);
  const backups = (await readdir(directory)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /\.repaired-.*\.bak$/);
  const config = await readMcpConfig(path);
  assert.equal(config.userFlag, true, 'unrelated top-level keys survive field repair');
  assert.deepEqual(Object.keys(config.servers), ['a4h-200']);
  assert.equal(config.inputs, undefined, 'a non-array inputs value is removed');
});

test('setup replaces a structurally invalid mcp.json and keeps an invalid backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-shape-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, '["not", "a", "config"]');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await installMcpConfig([], { env: { PATH: directory }, path });
  assert.equal(result.warnings.length, 1);
  const backups = (await readdir(directory)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /\.invalid-.*\.bak$/);
  assert.deepEqual((await readMcpConfig(path)).servers, {});
});

test('strict readers still reject JSONC and shape errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-strict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jsoncPath = join(directory, 'mcp.json');
  await writeFile(jsoncPath, '{ "servers": {} // comment\n }');
  await assert.rejects(() => readMcpConfig(jsoncPath), /invalid JSON/);
  const shapePath = join(directory, 'shape.json');
  await writeFile(shapePath, JSON.stringify({ servers: null }));
  await assert.rejects(() => readMcpConfig(shapePath), /non-object servers/);
  // inputs-only damage stays tolerated by strict readers (previous behavior)
  const inputsPath = join(directory, 'inputs.json');
  await writeFile(inputsPath, JSON.stringify({ servers: {}, inputs: 'weird' }));
  assert.equal((await readMcpConfig(inputsPath)).inputs, 'weird');
});

test('backups never overwrite an existing backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-backup-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = new Date('2025-01-02T03:04:05.678Z');
  const [first, second, third] = backupPathCandidates(path, 'invalid', now);
  await writeFile(first, 'first backup');
  assert.equal(await writeConfigBackup(path, Buffer.from('second'), { kind: 'invalid', now }), second);
  await writeFile(second, 'occupied');
  assert.equal(await writeConfigBackup(path, Buffer.from('third'), { kind: 'invalid', now }), third);
  assert.equal(await readFile(first, 'utf8'), 'first backup');
  assert.equal(await readFile(second, 'utf8'), 'occupied');
});

test('a torn read from a concurrent editor save is retried before healing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-torn-'));
  const path = join(directory, 'mcp.json');
  const full = Buffer.from(JSON.stringify({ servers: { memory: { command: 'npx' } } }));
  const torn = full.subarray(0, full.indexOf('npx'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reads = 0;
  const readFileImpl = async readPath => {
    reads += 1;
    assert.equal(readPath, path);
    return reads === 1 ? torn : full;
  };

  const config = await readMcpConfig(path, { readFileImpl, retryDelayMs: 1 });
  assert.equal(reads, 2, 'the torn first read must trigger exactly one re-read');
  assert.equal(config.servers.memory.command, 'npx');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.bak')), [], 'no backup must be created for a transient torn read');
});

test('a symlinked mcp.json is healed in place and its backup lands next to the real file', async t => {
  if (process.platform === 'win32') return t.skip('creating symlinks on Windows needs elevated privileges');
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-toolkit-mcp-symlink-'));
  const realDirectory = join(directory, 'real');
  const linkDirectory = join(directory, 'link');
  await mkdir(realDirectory, { recursive: true });
  await mkdir(linkDirectory, { recursive: true });
  const realPath = join(realDirectory, 'mcp.json');
  const linkPath = join(linkDirectory, 'mcp.json');
  await writeFile(realPath, JSON.stringify({ servers: { memory: { command: 'npx' } } }));
  await symlink(realPath, linkPath);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = {
    source: 'sap-gui-local', name: 'Dev ABAP', serverName: 'Dev ABAP',
    url: 'https://abap.example.com:44300', client: '200', systemId: 'A4H'
  };

  const result = await installMcpConfig([local], { env: { PATH: directory }, path: linkPath });
  assert.deepEqual(result.warnings, []);
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true, 'the symlink must survive the atomic rewrite');
  assert.deepEqual((await readdir(linkDirectory)).filter(name => name !== 'mcp.json'), [], 'no temp or backup files beside the link');
  const config = JSON.parse(await readFile(realPath, 'utf8'));
  assert.deepEqual(Object.keys(config.servers).sort(), ['a4h-200', 'memory']);

  await writeFile(realPath, '{ broken');
  const healed = await installMcpConfig([local], { env: { PATH: directory }, path: linkPath });
  assert.equal(healed.warnings.length, 1);
  assert.match(healed.warnings[0], /real.*\.bak/);
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.ok((await readdir(realDirectory)).some(name => name.endsWith('.bak')), 'the backup must sit next to the real file');
});
