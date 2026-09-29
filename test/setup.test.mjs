import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMcpConfig } from '../src/mcp-config.mjs';
import { runSetup } from '../src/setup.mjs';
import { spawnWithPty } from './pty.mjs';

const destinations = [
  { name: 'alpha-system', client: '100', authentication: 'Basic', probe: { status: 'available', available: true } },
  { name: 'beta-system', client: '200', authentication: 'PrincipalPropagation', probe: { status: 'auth-required', available: true } },
  { name: 'offline-system', client: '300', authentication: 'Basic', probe: { status: 'network-error', available: false } }
];

function outputStream() {
  const output = new PassThrough();
  const chunks = [];
  output.isTTY = true;
  output.on('data', chunk => chunks.push(chunk.toString()));
  output.text = () => chunks.join('');
  output.resume();
  return output;
}

function runSetupVisibilityInPty(fixture, env, keys = '\r') {
  return new Promise((resolve, reject) => {
    const command = `stty cols 48 rows 12; ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
    const child = spawnWithPty(command, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let selectionSent = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!selectionSent && stdout.includes('Select destinations')) {
        selectionSent = true;
        setTimeout(() => child.stdin.write(keys), 500);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, selectionSent });
    });
  });
}

function runPostinstallInPty(env, keys, assetsAnswer = '\r') {
  return new Promise((resolve, reject) => {
    const command = `${JSON.stringify(process.execPath)} scripts/postinstall.mjs </dev/null | cat`;
    const child = spawnWithPty(command, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let selectionSent = false;
    let assetsAnswerSent = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!selectionSent && stdout.includes('Select destinations')) {
        selectionSent = true;
        child.stdin.write(keys);
      }
      if (!assetsAnswerSent && stdout.includes('Install the bundled agents and all skills')) {
        assetsAnswerSent = true;
        child.stdin.write(assetsAnswer);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, selectionSent, assetsAnswerSent });
    });
  });
}

async function assertUserCopilotAssets(home) {
  const copilotRoot = join(home, '.copilot');
  assert.equal((await stat(join(copilotRoot, 'agents', 'abap-developer.agent.md'))).isFile(), true);
  assert.equal((await stat(join(copilotRoot, 'agents', 'hana-cloud-hdi-specialist.agent.md'))).isFile(), true);
  const skillNames = (await readdir(join(copilotRoot, 'skills'))).sort();
  assert.deepEqual(skillNames, [
    'abap-debugging',
    'abap-development',
    'abap-runtime-analysis',
    'abap-testing-quality',
    'cds-development',
    'clean-core-extensibility',
    'hana-cloud-inspection',
    'hana-cloud-native-development',
    'hana-cloud-validation',
    'rap-development',
    'rap-service-delivery',
    'sap-sdlc-orchestration',
    'sap-standard-api-analysis',
    'sap-transport-release'
  ]);
  for (const skillName of skillNames) {
    assert.equal((await stat(join(copilotRoot, 'skills', skillName, 'SKILL.md'))).isFile(), true);
  }
}

test('reconciles generated entries while preserving unrelated MCP config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-config-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({
    inputs: [{ id: 'keep-me' }],
    custom: true,
    servers: {
      unrelated: { type: 'stdio', command: 'other' },
      sapAiDev_stale: { type: 'stdio', command: 'old' }
    }
  }));
  try {
    await installMcpConfig(destinations.slice(0, 2), { env: { H2O_URL: 'http://new-h2o' }, path });
    const config = JSON.parse(await readFile(path, 'utf8'));
    const generated = Object.entries(config.servers).filter(([, entry]) => entry.BAS_EXT === 'true');
    assert.equal(config.custom, true);
    assert.deepEqual(config.inputs, [{ id: 'keep-me' }]);
    assert.deepEqual(Object.keys(config.servers).sort(), ['alpha-system', 'beta-system', 'unrelated']);
    assert.deepEqual(generated.map(([name]) => name), ['alpha-system', 'beta-system']);
    assert.equal(generated.length, 2);
    assert.deepEqual(generated.map(([, entry]) => entry.env.SAP_AI_DEV_TOOLKIT_DESTINATION), ['alpha-system', 'beta-system']);
    assert.deepEqual(generated.map(([, entry]) => entry.env.H2O_URL), ['http://new-h2o', 'http://new-h2o']);
    assert.deepEqual(generated.map(([, entry]) => entry.command), ['sap-ai-dev', 'sap-ai-dev']);
    assert.deepEqual(generated.map(([, entry]) => entry.env.SAP_ALLOW_TRANSPORTABLE_EDITS), ['true', 'true']);
    assert.equal(new Set(generated.map(([name]) => name)).size, 2);

    await installMcpConfig([], { env: { H2O_URL: 'http://new-h2o' }, path });
    const cleared = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(cleared.servers), ['unrelated']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('does not overwrite an unrelated server with the destination name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-config-collision-'));
  const path = join(directory, 'mcp.json');
  const unrelated = { type: 'stdio', command: 'other' };
  await writeFile(path, JSON.stringify({ servers: { 'alpha-system': unrelated } }));
  try {
    await assert.rejects(
      () => installMcpConfig(destinations.slice(0, 1), { env: { H2O_URL: 'http://new-h2o' }, path }),
      /already exists and is not managed/
    );
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(config.servers['alpha-system'], unrelated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('does not overwrite malformed MCP JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-config-'));
  const path = join(directory, 'mcp.json');
  const original = '{ malformed';
  await writeFile(path, original);
  try {
    await assert.rejects(() => installMcpConfig([], { env: { H2O_URL: 'http://h2o.example' }, path }), /invalid JSON/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup checkbox remains visible in a narrow live TTY without spinner artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-setup-visibility-'));
  const fixture = join(directory, 'visibility-fixture.mjs');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'cf'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(fixture, `
import { runSetup } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/setup.mjs')).href)};
const destinations = [
  { name: 'S4H', client: '100', authentication: 'Basic', probe: { status: 'available', available: true } },
  { name: 'VeryLongDestinationNameForWrapping', client: '200', authentication: 'Basic', probe: { status: 'available', available: true } }
];
await runSetup({
  env: { ...process.env, H2O_URL: 'http://h2o.example', PATH: ${JSON.stringify(`${bin}:${process.env.PATH || ''}`)} },
  discover: async () => destinations,
  install: async selected => ({ path: process.env.SAP_AI_DEV_TOOLKIT_MCP_CONFIG, servers: Object.fromEntries(selected.map(destination => [destination.name, { env: { SAP_AI_DEV_TOOLKIT_DESTINATION: destination.name } }])) })
});
`);
  try {
    const env = {
      ...process.env,
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(directory, 'mcp.json'),
      FORCE_COLOR: '1',
      PATH: `${bin}:${process.env.PATH || ''}`
    };
    delete env.NO_COLOR;
    const result = await runSetupVisibilityInPty(fixture, env, '\r');
    const logs = `${result.stdout}\n${result.stderr}`;
    const visible = stripVTControlCharacters(logs);
    assert.equal(result.code, 0, logs);
    assert.equal(result.selectionSent, true, logs);
    assert.match(visible, /[❯>]\s*✗ S4H \(BAS, client 100, ok:available\)/u, visible);
    assert.match(visible, /Configured 0 MCP servers/u, visible);
    assert.doesNotMatch(logs, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, logs);
    assert.doesNotMatch(logs, /⏳/u, logs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-TTY setup skips without writing config', async () => {
  const input = new PassThrough();
  input.isTTY = false;
  const output = outputStream();
  let installCalls = 0;
  const result = await runSetup({
    env: { H2O_URL: 'http://h2o.example' },
    input,
    output,
    discover: async () => destinations,
    install: async () => { installCalls += 1; }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'non-tty');
  assert.equal(installCalls, 0);
});

test('global postinstall completes BAS selection before default Copilot asset installation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-wizard-'));
  const config = join(directory, 'mcp.json');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const cfCli = join(bin, 'cf');
  await writeFile(cfCli, '#!/bin/sh\nexit 1\n');
  await chmod(cfCli, 0o755);
  const server = createServer((request, response) => {
    if (request.url === '/api/listDestinations') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([
        { Name: 'alpha-system', Client: '100', Authentication: 'Basic' },
        { Name: 'beta-system', Client: '200', Authentication: 'PrincipalPropagation' },
        { Name: 'gamma-system', Client: '300', Authentication: 'Basic' }
      ]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    HOME: directory,
    PATH: `${bin}:${process.env.PATH || ''}`,
    BAS_VSP_BINARY: '/bin/true',
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config,
    SAP_AI_DEV_TOOLKIT_SKIP_PROBE: 'true',
    H2O_URL: `http://127.0.0.1:${server.address().port}`,
    HTTP_PROXY: '',
    http_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
    FORCE_COLOR: '1'
  };
  delete env.NO_COLOR;
  delete env.npm_config_ignore_scripts;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const declined = await runPostinstallInPty(env, '\r', 'n\r');
  assert.equal(declined.code, 0, `${declined.stdout}\n${declined.stderr}`);
  assert.equal(declined.selectionSent, true, declined.stdout);
  assert.equal(declined.assetsAnswerSent, true, declined.stdout);
  const declineLogs = `${declined.stdout}\n${declined.stderr}`;
  assert.match(declineLogs, /Configured 0 MCP servers/);
  assert.match(declineLogs, /\[Y\/n\]/);
  assert.match(declineLogs, /Type n then press Enter to skip installing or updating the bundled files/);
  assert.match(declineLogs, /🤖 sap-ai-dev-toolkit/);
  assert.match(declineLogs, /\u001b\[1;35m/);
  assert.match(declineLogs, /Bundled Copilot agents and skills are installed by default/);
  assert.match(declineLogs, /Copilot agent and skills were skipped\. Your files were not changed/);
  assert.ok(declineLogs.indexOf('Bundled Copilot agents and skills are installed by default') > declineLogs.indexOf('Configured 0 MCP servers'), declineLogs);
  assert.ok(declineLogs.indexOf('Install the bundled agents and all skills') > declineLogs.indexOf('Bundled Copilot agents and skills are installed by default'), declineLogs);
  assert.ok(declineLogs.indexOf('No MCP server entries are configured for this add-on.') > declineLogs.indexOf('Copilot agent and skills were skipped'), declineLogs);
  assert.ok(declineLogs.includes(`MCP config file: ${config}`), declineLogs);
  const configAfterDecline = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(Object.values(configAfterDecline.servers).filter(entry => entry.BAS_EXT === 'true').length, 0);
  await assert.rejects(stat(join(directory, '.copilot')), { code: 'ENOENT' });

  const accepted = await runPostinstallInPty(env, ' \r', '\r');
  assert.equal(accepted.code, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(accepted.selectionSent, true, accepted.stdout);
  assert.equal(accepted.assetsAnswerSent, true, accepted.stdout);
  const acceptLogs = `${accepted.stdout}\n${accepted.stderr}`;
  assert.ok(acceptLogs.indexOf('Install the bundled agents and all skills') > acceptLogs.indexOf('Configured 1 MCP server'), acceptLogs);
  assert.match(acceptLogs, /Installed 19 Copilot files/);
  assert.ok(acceptLogs.indexOf('Installation configuration summary') > acceptLogs.indexOf('Installed 19 Copilot files'), acceptLogs);
  assert.ok(acceptLogs.includes(`MCP config file: ${config}`), acceptLogs);
  assert.ok(acceptLogs.includes('Destination: BAS · alpha-system · client 100 · Basic'), acceptLogs);
  assert.match(acceptLogs, /Launch: stdio · (?:[^\r\n]*[\\/])?sap-ai-dev(?:\.cmd)?(?:\r?\n|$)/, acceptLogs);
  assert.ok(acceptLogs.includes('Environment keys: H2O_URL, SAP_AI_DEV_TOOLKIT_DESTINATION, SAP_ALLOW_TRANSPORTABLE_EDITS'), acceptLogs);
  const configAfterAccept = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(Object.values(configAfterAccept.servers)
    .filter(entry => entry.BAS_EXT === 'true')
    .map(entry => entry.env.SAP_AI_DEV_TOOLKIT_DESTINATION), ['alpha-system']);
  await assertUserCopilotAssets(directory);

});



test('non-TTY postinstall skips setup and installs Copilot assets by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-non-tty-'));
  const env = {
    ...process.env,
    HOME: directory,
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true',
    H2O_URL: 'http://bas.example'
  };
  delete env.npm_config_ignore_scripts;

  try {
    for (const original of [undefined, JSON.stringify({ servers: { unrelated: { command: 'other' } } })]) {
      const config = join(directory, original === undefined ? 'new.json' : 'existing.json');
      env.SAP_AI_DEV_TOOLKIT_MCP_CONFIG = config;
      if (original !== undefined) await writeFile(config, original);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/postinstall.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      if (original === undefined) {
        await assert.rejects(readFile(config), { code: 'ENOENT' });
      } else {
        assert.equal(await readFile(config, 'utf8'), original);
      }
    }
    await assertUserCopilotAssets(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('postinstall installs Copilot assets without an interactive terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-'));
  const config = join(directory, 'mcp.json');
  const env = {
    ...process.env,
    HOME: join(directory, 'home'),
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true',
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
  };
  delete env.H2O_URL;
  delete env.npm_config_ignore_scripts;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/postinstall.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const logs = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, logs);
    assert.match(logs, /Installing bundled agents and skills by default because no interactive terminal is available/);
    await assertUserCopilotAssets(join(directory, 'home'));
    await assert.rejects(stat(join(directory, '.github')), { code: 'ENOENT' });
    await assert.rejects(readFile(config), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('postinstall runs when invoked through a symlinked install path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-postinstall-symlink-'));
  const alias = join(directory, 'postinstall.mjs');
  await symlink(join(process.cwd(), 'scripts', 'postinstall.mjs'), alias);
  const env = {
    ...process.env,
    HOME: directory,
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true'
  };
  delete env.H2O_URL;
  delete env.npm_config_ignore_scripts;
  delete env.NPM_CONFIG_IGNORE_SCRIPTS;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [alias], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const logs = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, logs);
    assert.match(logs, /BAS destination setup was skipped because H2O_URL is not set/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
