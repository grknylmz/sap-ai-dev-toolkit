import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMcpConfig, npxMcpLauncher } from '../src/mcp-config.mjs';
import { adtCandidate, parseSapClientList, runSetup } from '../src/setup.mjs';
import { parseIntegrationServiceKey } from '../src/integration-config.mjs';
import { storeIntegrationKey } from '../src/integration-credentials.mjs';
import { OPTIONAL_COMPONENT_KEYS } from '../src/integration-optional-config.mjs';
import { spawnWithPty } from './pty.mjs';
import { isolatedWindowsEnv, isWindows, pathEntry, withoutIntegrationCredentials, writeFakeCli } from './fake-bin.mjs';

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

const INTEGRATION_SUITE_QUESTION = 'Add the SAP Integration Suite tools?';

function runSetupVisibilityInPty(fixture, env, keys = '\r') {
  return new Promise((resolve, reject) => {
    // stty shrinks the pty so layout wrapping is asserted on Unix; the Windows
    // pty adapter takes the same size through spawn options instead.
    const command = isWindows
      ? `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`
      : `stty cols 48 rows 12; ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
    const child = spawnWithPty(command, { env: withoutIntegrationCredentials(env), stdio: ['pipe', 'pipe', 'pipe'], cols: 48, rows: 12 });
    let stdout = '';
    let stderr = '';
    let selectionSent = false;
    let integrationAnswerSent = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!selectionSent && stdout.includes('Select destinations')) {
        selectionSent = true;
        setTimeout(() => child.stdin.write(keys), 500);
      }
      if (!integrationAnswerSent && stdout.includes(INTEGRATION_SUITE_QUESTION)) {
        integrationAnswerSent = true;
        setTimeout(() => child.stdin.write('\r'), 500);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, selectionSent, integrationAnswerSent });
    });
  });
}

test('parseSapClientList handles defaults, whitespace, duplicates, and invalid clients', () => {
  assert.deepEqual(parseSapClientList('', '100'), ['100']);
  assert.deepEqual(parseSapClientList('   ', '200'), ['200']);
  assert.deepEqual(parseSapClientList(undefined, '000'), ['000']);
  assert.deepEqual(parseSapClientList('100, 200,100,001'), ['100', '200', '001']);
  assert.deepEqual(parseSapClientList(' 066 '), ['066']);
  for (const invalid of ['1', '01', '0000', 'abc', '10a', '100;200', '100 200']) {
    assert.throws(() => parseSapClientList(invalid, '100'), /3 digits/);
  }
  assert.throws(() => parseSapClientList('', 'abc'), /3 digits/);
});

function runPostinstallInPty(env, keys, assetsAnswer = '\r', wizardAnswer = 'e\r') {
  return new Promise((resolve, reject) => {
    // Unix redirects stdin from /dev/null so postinstall's controlling-
    // terminal recovery (/dev/tty) is what drives the prompts. Windows has
    // no controlling-terminal recovery, so the pty stays on stdin directly.
    const command = isWindows
      ? `${JSON.stringify(process.execPath)} scripts\\postinstall.mjs`
      : `stty cols 100 rows 30; ${JSON.stringify(process.execPath)} scripts/postinstall.mjs </dev/null | cat`;
    const child = spawnWithPty(command, { env: withoutIntegrationCredentials(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let selectionSent = false;
    let assetsAnswerSent = false;
    let wizardAnswerSent = false;
    let integrationAnswerSent = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!wizardAnswerSent && stdout.includes('Configure an SAP system manually?')) {
        // No systems were detected and setup offers the manual entry wizard;
        // the default answer declines so postinstall continues.
        wizardAnswerSent = true;
        setTimeout(() => child.stdin.write(wizardAnswer), 500);
      }
      if (!selectionSent && stdout.includes('Select destinations')) {
        selectionSent = true;
        child.stdin.write(keys);
      }
      if (!integrationAnswerSent && stdout.includes(INTEGRATION_SUITE_QUESTION)) {
        integrationAnswerSent = true;
        setTimeout(() => child.stdin.write('\r'), 500);
      }
      if (!assetsAnswerSent && stdout.includes('Install bundled agents and skills for')) {
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
    'integration-suite-delivery',
    'rap-development',
    'rap-service-delivery',
    'sap-integration-architect',
    'sap-sdlc-orchestration',
    'sap-standard-api-analysis',
    'sap-transport-release'
  ]);
  for (const skillName of skillNames) {
    assert.equal((await stat(join(copilotRoot, 'skills', skillName, 'SKILL.md'))).isFile(), true);
  }
}

async function assertUserClaudeAssets(home) {
  const claudeRoot = join(home, '.claude');
  const agentNames = (await readdir(join(claudeRoot, 'agents'))).sort();
  assert.deepEqual(agentNames, [
    'abap-developer.md',
    'abap-runtime-debugger.md',
    'hana-cloud-hdi-specialist.md',
    'rap-service-developer.md',
    'sap-integration-architect.md',
    'sap-integration-developer.md',
    'sap-solution-architect.md'
  ]);
  const architect = await readFile(join(claudeRoot, 'agents', 'sap-solution-architect.md'), 'utf8');
  assert.match(architect, /^---\nname: [^\n]+\ndescription: [^\n]+\n---\n/s);
  assert.doesNotMatch(architect, /(^|\n)(target|user-invocable):/);
  const skillNames = (await readdir(join(claudeRoot, 'skills'))).sort();
  assert.equal(skillNames.length, 16);
  for (const skillName of skillNames) {
    assert.equal((await stat(join(claudeRoot, 'skills', skillName, 'SKILL.md'))).isFile(), true);
  }
  assert.equal((await stat(join(claudeRoot, '.sap-ai-dev-toolkit-assets.json'))).isFile(), true);
}

test('adds generated entries while preserving existing managed and unrelated MCP config', async () => {
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
    await installMcpConfig(destinations.slice(0, 1), { env: { H2O_URL: 'http://new-h2o' }, path, additive: true });
    await installMcpConfig(destinations.slice(1, 2), { env: { H2O_URL: 'http://new-h2o' }, path, additive: true });
    const config = JSON.parse(await readFile(path, 'utf8'));
    const generated = Object.entries(config.servers).filter(([, entry]) => entry.BAS_EXT === 'true');
    assert.equal(config.custom, true);
    assert.deepEqual(config.inputs, [{ id: 'keep-me' }]);
    assert.deepEqual(Object.keys(config.servers).sort(), ['alpha-system', 'beta-system', 'unrelated']);
    assert.deepEqual(generated.map(([name]) => name).sort(), ['alpha-system', 'beta-system']);
    assert.equal(generated.length, 2);
    assert.deepEqual(generated.map(([, entry]) => entry.env.SAP_AI_DEV_TOOLKIT_DESTINATION).sort(), ['alpha-system', 'beta-system']);
    assert.deepEqual(generated.map(([, entry]) => entry.env.H2O_URL), ['http://new-h2o', 'http://new-h2o']);
    // No sap-ai-dev launcher is on PATH here (pure npx scenario), so the
    // generated entries pin the package through npx instead of writing a
    // command no MCP host could spawn; Windows routes through cmd /c.
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const npxLauncher = npxMcpLauncher();
    for (const [, entry] of generated) assert.deepEqual([entry.command, entry.args], [
      npxLauncher.command,
      [...npxLauncher.prefixArgs, '--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${version}`, 'sap-ai-dev']
    ]);
    assert.deepEqual(generated.map(([, entry]) => entry.env.SAP_ALLOW_TRANSPORTABLE_EDITS).sort(), ['true', 'true']);
    assert.equal(new Set(generated.map(([name]) => name)).size, 2);

    await installMcpConfig([], { env: { H2O_URL: 'http://new-h2o' }, path });
    const cleared = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(cleared.servers), ['unrelated']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('setup run through npx pins the npx launcher instead of the disposable npx cache path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-npx-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // npx puts its cache bin dir, holding this package's own sap-ai-dev, first on PATH.
  const npxBin = join(directory, '_npx', '0123456789abcdef', 'node_modules', '.bin');
  await mkdir(npxBin, { recursive: true });
  await writeFile(join(npxBin, isWindows ? 'sap-ai-dev.cmd' : 'sap-ai-dev'), '', { mode: 0o755 });
  const installed = await installMcpConfig(destinations.slice(0, 1), { env: { H2O_URL: 'http://new-h2o', PATH: npxBin }, path: join(directory, 'mcp.json') });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const npxLauncher = npxMcpLauncher();
  const entry = installed.servers['alpha-system'];
  assert.deepEqual([entry.command, entry.args], [
    npxLauncher.command,
    [...npxLauncher.prefixArgs, '--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${version}`, 'sap-ai-dev']
  ]);
});
test('setup pins its version and keeps a global sap-ai-dev only when it is that version', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-global-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // npm's Windows layout: the shim sits next to node_modules/<package>.
  const command = join(directory, isWindows ? 'sap-ai-dev.cmd' : 'sap-ai-dev');
  const manifest = join(directory, 'node_modules', 'sap-ai-dev-toolkit', 'package.json');
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(command, '', { mode: 0o755 });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const install = () => installMcpConfig(destinations.slice(0, 1), { env: { H2O_URL: 'http://new-h2o', PATH: directory }, path: join(directory, 'mcp.json') });

  await writeFile(manifest, JSON.stringify({ name: 'sap-ai-dev-toolkit', version }));
  const current = await install();
  assert.equal(current.servers['alpha-system'].command, command);
  assert.equal(current.servers['alpha-system'].env.SAP_AI_DEV_TOOLKIT_VERSION, version);
  assert.deepEqual(current.warnings, []);

  await writeFile(manifest, JSON.stringify({ name: 'sap-ai-dev-toolkit', version: '0.0.1' }));
  const stale = await install();
  const npxLauncher = npxMcpLauncher();
  const entry = stale.servers['alpha-system'];
  assert.deepEqual([entry.command, entry.args], [
    npxLauncher.command,
    [...npxLauncher.prefixArgs, '--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${version}`, 'sap-ai-dev']
  ]);
  assert.ok(stale.warnings.some(warning => warning.includes(`sap-ai-dev-toolkit 0.0.1, not ${version}`) && warning.includes(`npm install -g sap-ai-dev-toolkit@${version}`)), stale.warnings.join('\n'));
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


test('additive install rejects collisions with previously managed destination names', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-managed-collision-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = { ...destinations[0], name: 'ABAP Dev', serverName: 'ABAP Dev' };
  const second = { ...destinations[0], name: 'ABAP_Dev', serverName: 'ABAP_Dev', url: 'http://other.dest' };
  await installMcpConfig([first], { env: { H2O_URL: 'http://h2o.example' }, path, command: 'sap-ai-dev' });
  const before = await readFile(path, 'utf8');
  await assert.rejects(
    () => installMcpConfig([second], { env: { H2O_URL: 'http://h2o.example' }, path, command: 'sap-ai-dev', additive: true }),
    /conflicts with a different managed destination/
  );
  assert.equal(await readFile(path, 'utf8'), before, 'a collision must not rewrite the existing configuration');
});

test('additive install rejects destination names that collide with companion servers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-companion-collision-'));
  const path = join(directory, 'mcp.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await installMcpConfig([], { env: { H2O_URL: 'http://h2o.example' }, path, sapDevelopmentServers: ['sap-fiori-tools'] });
  const destination = { ...destinations[0], name: 'sap-fiori-tools', serverName: 'sap-fiori-tools' };
  await assert.rejects(
    () => installMcpConfig([destination], { env: { H2O_URL: 'http://h2o.example' }, path, additive: true }),
    /conflicts with a different managed destination or companion server/
  );
});

test('self-heals malformed MCP JSON with a backup instead of failing setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-mcp-config-heal-'));
  const path = join(directory, 'mcp.json');
  const original = '{ malformed';
  await writeFile(path, original);
  try {
    const result = await installMcpConfig([], { env: { H2O_URL: 'http://h2o.example' }, path });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /backed up/);
    const backups = (await readdir(directory)).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(directory, backups[0]), 'utf8'), original);
    const healed = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(healed.servers, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup destination picker filters a prefix in a narrow live TTY without spinner artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-setup-visibility-'));
  const fixture = join(directory, 'visibility-fixture.mjs');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const fixtureEnv = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, '.config'),
    H2O_URL: 'http://h2o.example',
    PATH: pathEntry(bin)
  };
  await writeFakeCli(bin, 'cf', 'process.exitCode = 1;', fixtureEnv);
  await writeFile(fixture, `
import { runSetup } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/setup.mjs')).href)};
const destinations = [
  { name: 'QAS', client: '100', authentication: 'Basic', probe: { status: 'available', available: true } },
  { name: 'T33', client: '200', authentication: 'Basic', probe: { status: 'available', available: true } },
  { name: 'TST', client: '300', authentication: 'Basic', probe: { status: 'available', available: true } }
];
await runSetup({
  env: process.env,
  discover: async () => destinations,
  install: async selected => {
    console.log('Selected destinations: ' + selected.map(destination => destination.name).join(','));
    return { path: process.env.SAP_AI_DEV_TOOLKIT_MCP_CONFIG, servers: Object.fromEntries(selected.map(destination => [destination.name, { env: { SAP_AI_DEV_TOOLKIT_DESTINATION: destination.name } }])) };
  }
});
`);
  try {
    const env = {
      ...fixtureEnv,
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(directory, 'mcp.json'),
      FORCE_COLOR: '1'
    };
    delete env.NO_COLOR;
    const result = await runSetupVisibilityInPty(fixture, env, 'T \r');
    const logs = `${result.stdout}\n${result.stderr}`;
    const visible = stripVTControlCharacters(logs);
    assert.equal(result.code, 0, logs);
    assert.equal(result.selectionSent, true, logs);
    assert.match(visible, /Search: T/u, visible);
    assert.match(visible, /Selected destinations: T33/u, visible);
    assert.match(visible, /Configured 1 MCP server/u, visible);
    assert.doesNotMatch(logs, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, logs);
    assert.doesNotMatch(logs, /⏳/u, logs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function manualWizardOutput() {
  const output = outputStream();
  output.columns = 80;
  output.rows = 24;
  return output;
}

async function answerManualWizard(input, answers) {
  for (const answer of answers) {
    await new Promise(resolve => setTimeout(resolve, 25));
    input.write(answer);
  }
}

test('local setup with no SAP GUI systems offers the manual wizard and skips when declined', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  let installCalls = 0;
  const pending = runSetup({
    env: { HOME: '/tmp/no-sap-gui-test' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    install: async () => { installCalls += 1; }
  });
  await answerManualWizard(input, ['e', '\r']);
  const result = await pending;
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-destinations');
  assert.equal(installCalls, 0);
  assert.match(output.text(), /No SAP GUI systems were found/);
  assert.match(output.text(), /💡 No systems were detected\. Configure an SAP system manually\?/);
  assert.match(output.text(), /✍️ {1,2}Start manual entry wizard/);
  assert.match(output.text(), /Exit setup/);
});

test('setup advertises the manual option before discovery starts', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const pending = runSetup({
    env: { HOME: '/tmp/manual-tip-test' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    install: async () => ({})
  });
  await answerManualWizard(input, ['e', '\r']);
  await pending;
  const text = output.text();
  assert.match(text, /Tip: you can skip auto-discovery and add a system manually — press m in the destination picker/);
});

test('manual entry wizard configures a system when nothing was detected', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const pending = runSetup({
    env: { HOME: '/tmp/manual-entry-test' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    install: async selected => {
      installed.push(...selected);
      return { path: '/tmp/manual-entry-test/mcp.json', servers: Object.fromEntries(selected.map(destination => [destination.name, { env: { SAP_AI_DEV_TOOLKIT_DESTINATION: destination.name } }])) };
    }
  });
  // Offer prompt accepts the 'manual' default with Enter; then name, ADT URL,
  // two clients, and 'no' at the add-another prompt. Non-Windows runs skip
  // the authentication prompt (password is the default).
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example:44300\r', '100,200\r', 'n\r', '\r']);
  const result = await pending;
  assert.equal(result.skipped, undefined);
  assert.equal(installed.length, 2);
  assert.deepEqual(installed.map(destination => destination.name), ['Q7C 100', 'Q7C 200']);
  for (const destination of installed) {
    assert.equal(destination.source, 'sap-gui-local');
    assert.equal(destination.url, 'https://q7c.example:44300');
    assert.equal(destination.proxyType, 'Internet');
    assert.equal(destination.authentication, 'Basic');
    assert.equal(destination.authMode, 'basic');
    assert.equal(destination.childEnv.SAP_AUTH_MODE, 'basic');
    assert.match(destination.childEnv.SAP_USER, /^\$\{input:sap-ai-dev-q7c-(?:100|200)-user\}$/u);
    assert.deepEqual(destination.inputs.map(input => input.type), ['promptString', 'promptString']);
    assert.equal(destination.inputs[1].password, true);
  }
  assert.match(output.text(), /Manual system entry/);
  assert.match(output.text(), /Added Q7C \(clients 100, 200\)/);
  assert.match(output.text(), /Configured 2 MCP servers/);
});

// Drives the manual-entry wizard to the Integration Suite step and answers it with `answers`.
// Online verification is replaced by `verifyIntegration` (default: every configured side signs in).
async function runWizardToIntegrationStep(env, answers = [], { verifyIntegration = fakeVerification(), integrationCloudFoundry = { getTarget: async () => ({ available: false }) } } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installs = [];
  const pending = runSetup({
    env: { XDG_CONFIG_HOME: join(env.HOME, '.config'), ...env },
    input,
    output,
    discoverLocalSapGui: async () => [],
    verifyIntegration,
    integrationCloudFoundry,
    install: async (selected, options) => {
      installs.push(options.sapDevelopmentServers);
      return { path: join(env.HOME, 'mcp.json'), servers: {} };
    }
  });
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example:44300\r', '100\r', 'n\r', ...answers]);
  await pending;
  return { installs, text: stripVTControlCharacters(output.text()), verifyIntegration };
}

function fakeVerification({ signedIn = true } = {}) {
  const calls = [];
  const side = config => (config ? { configured: true, signed_in: signedIn, ok: signedIn, error: signedIn ? undefined : 'CPI token request failed (HTTP 401)', checks: signedIn ? [{ area: 'Packages and iFlows', status: 200, result: 'ok' }, { area: 'Security material', status: 403, result: 'forbidden', detail: 'HTTP 403: the service key lacks the role for this area' }] : [] } : { configured: false });
  const verify = async config => {
    calls.push(config);
    const result = Object.fromEntries(['cpi', 'apim', 'devhub', ...OPTIONAL_COMPONENT_KEYS].map(key => [key, { ...side(config[key]), result: config[key] ? signedIn ? 'ok' : 'unauthenticated' : 'untested' }]));
    const core = [result.cpi, result.apim, result.devhub].filter(entry => entry.configured);
    return { ...result, ok: core.length > 0 && core.every(entry => entry.ok), optional_completeness: { complete: OPTIONAL_COMPONENT_KEYS.filter(key => config[key]).every(key => result[key].ok) } };
  };
  verify.calls = calls;
  return verify;
}

const CPI_KEY_FOR_WIZARD = JSON.stringify({ oauth: { url: 'https://tenant.it-cpi.example', tokenurl: 'https://auth.example/oauth/token', clientid: 'id', clientsecret: 'wizard-secret-value' } });

test('Integration Suite step: detected credentials are verified online and Enter adds the server', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-yes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { installs, text, verifyIntegration } = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(home, 'mcp.json'), CPI_SERVICE_KEY: CPI_KEY_FOR_WIZARD }, ['\r', '\r']);
  assert.deepEqual(installs, [['integration-suite']]);
  assert.equal(verifyIntegration.calls.length, 1);
  assert.doesNotMatch(text, /wizard-secret-value/);
});

test('Integration Suite step: without credentials Enter skips it and y still adds it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-no-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const skipped = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(home, 'mcp.json') }, ['\r']);
  assert.deepEqual(skipped.installs, [[]]);

  // y, then Done ("c" + Enter) in the credential menu.
  const added = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(home, 'mcp.json') }, ['y\r', 'c\r']);
  assert.deepEqual(added.installs, [['integration-suite']]);
  assert.equal(added.verifyIntegration.calls.length, 0);
});

test('Integration Suite step: a pasted multi-line CPI key is verified, saved user-only, and never echoed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-paste-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pastedKey = JSON.stringify(JSON.parse(CPI_KEY_FOR_WIZARD), null, 2);
  // y = add; Enter = default "paste"; Enter = default key type (CPI); the paste (with line breaks); then Done.
  const { installs, text, verifyIntegration } = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(home, 'mcp.json') }, ['y\r', '\r', '\r', `${pastedKey}\r`, '\r']);
  assert.deepEqual(installs, [['integration-suite']]);
  assert.deepEqual(verifyIntegration.calls.map(config => Object.keys(config)), [['cpi']]);
  assert.equal(verifyIntegration.calls[0].cpi.clientSecret, 'wizard-secret-value');
  const storePath = join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json');
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')), {
    cpi: { oauth: { url: 'https://tenant.it-cpi.example', tokenurl: 'https://auth.example/oauth/token', clientid: 'id', clientsecret: 'wizard-secret-value' } }
  });
  assert.doesNotMatch(text, /wizard-secret-value/);
});

test('Integration Suite step: a key that cannot sign in is not saved unless confirmed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-badkey-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // y = add; Enter = paste; Enter = CPI; paste; Enter = do not save; c = done without credentials.
  const { text } = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(home, 'mcp.json') }, ['y\r', '\r', '\r', `${CPI_KEY_FOR_WIZARD}\r`, '\r', 'c\r'], { verifyIntegration: fakeVerification({ signedIn: false }) });
  await assert.rejects(stat(join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json')), { code: 'ENOENT' });
});

test('Integration Suite step: an existing entry is kept without asking and still verified', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'integration-step-existing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ servers: { 'integration-suite': { type: 'stdio', command: 'npx', BAS_EXT: 'true', BAS_EXT_KIND: 'sap-development-companion' } } }));
  const { installs, text, verifyIntegration } = await runWizardToIntegrationStep({ HOME: directory, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config, CPI_SERVICE_KEY: CPI_KEY_FOR_WIZARD }, ['\r']);
  assert.deepEqual(installs, [['integration-suite']]);
  assert.match(text, /Already configured in this MCP config; keeping it/);
  assert.doesNotMatch(text, /Add the SAP Integration Suite tools\?/);
  assert.equal(verifyIntegration.calls.length, 1);
});

test('manual entry wizard validates a missing ADT URL and repeats the prompt', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const pending = runSetup({
    env: { HOME: '/tmp/manual-entry-validate-test' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    install: async selected => {
      installed.push(...selected);
      return { path: '/tmp/manual-entry-validate-test/mcp.json', servers: {} };
    }
  });
  // Enter at the URL prompt without typing anything must re-prompt with the
  // validation error; the retry then completes with a single client.
  await answerManualWizard(input, ['\r', 'S4H\r', '\r', 'https://s4h.example:44300\r', '\r', 'n\r', '\r']);
  await pending;
  assert.equal(installed.length, 1);
  assert.equal(installed[0].client, '001');
  assert.equal(installed[0].url, 'https://s4h.example:44300');
  assert.match(output.text(), /Enter an ADT base URL/);
});

test('manual SSO entry without a port takes the ADT URL that port detection found', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const probes = [];
  const pending = runSetup({
    env: { HOME: '/tmp/manual-sso-port-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    discoverSsoBrowsers: async () => ({ browsers: [{ name: 'Microsoft Edge', path: '/browser/edge' }], unavailable: [] }),
    detectAdtUrl: async target => { probes.push(target); return { url: 'https://q7c.example:44310', reason: '' }; },
    install: async selected => { installed.push(...selected); return { servers: {} }; }
  });
  // Enter at the authentication prompt keeps the SSO default.
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example/sap/bc/adt/\r', '100\r', '\r', 'n\r', '\r']);
  await pending;
  assert.deepEqual(probes, [{ url: 'https://q7c.example', client: '100' }]);
  assert.equal(installed[0].childEnv.SAP_AUTH_MODE, 'sso');
  assert.equal(installed[0].childEnv.SAP_BROWSER_EXEC, '/browser/edge');
  assert.equal(installed[0].url, 'https://q7c.example:44310');
  assert.match(output.text(), /ADT answers at https:\/\/q7c\.example:44310/);
});

test('SSO setup offers remotely controllable browsers and applies the choice to every SAP client', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const pending = runSetup({
    env: { HOME: '/tmp/manual-sso-browser-choice-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    discoverSsoBrowsers: async () => ({
      browsers: [
        { name: 'Microsoft Edge', path: '/browser/edge' },
        { name: 'Google Chrome', path: '/browser/chrome' }
      ],
      unavailable: [{ name: 'Brave', path: '/browser/brave', reason: 'DevTools is disabled' }]
    }),
    detectAdtUrl: async () => ({ url: 'https://q7c.example:44310', reason: '' }),
    install: async selected => { installed.push(...selected); return { servers: {} }; }
  });
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example:44310\r', '100,200\r', '\r', '2\r', 'n\r', '\r']);
  await pending;
  assert.equal(installed.length, 2);
  assert.deepEqual(installed.map(destination => destination.client), ['100', '200']);
  assert.deepEqual(installed.map(destination => destination.childEnv.SAP_BROWSER_EXEC), ['/browser/chrome', '/browser/chrome']);
  assert.match(output.text(), /Browser for SSO \(Q7C\)/);
});

test('SSO setup warns and continues without pinning when no browser is remotely controllable', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const pending = runSetup({
    env: { HOME: '/tmp/manual-sso-no-browser-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    discoverSsoBrowsers: async () => ({
      browsers: [],
      unavailable: [{ name: 'Microsoft Edge', path: '/browser/edge', reason: 'DevTools is disabled' }]
    }),
    detectAdtUrl: async () => ({ url: 'https://q7c.example:44310', reason: '' }),
    install: async selected => { installed.push(...selected); return { servers: {} }; }
  });
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example:44310\r', '100\r', '\r', 'n\r', '\r']);
  await pending;
  assert.equal(installed.length, 1);
  assert.equal(installed[0].childEnv.SAP_BROWSER_EXEC, undefined);
  assert.match(output.text(), /No remotely controllable SSO browser was found/);
});

test('discovered local SSO destinations persist the selected remotely controllable browser', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const pending = runSetup({
    env: { HOME: '/tmp/discovered-sso-browser-choice-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [{ name: 'A4H', host: 'a4h.example', systemId: 'A4H', instance: '00', client: '100' }],
    discoverSsoBrowsers: async () => ({ browsers: [
      { name: 'Microsoft Edge', path: '/browser/edge' },
      { name: 'Google Chrome', path: '/browser/chrome' }
    ], unavailable: [] }),
    detectAdtUrl: async () => ({ url: 'https://a4h.example:44300', reason: '' }),
    install: async selected => { installed.push(...selected); return { servers: {} }; }
  });
  await answerManualWizard(input, [' \r', '100\r', 'https://a4h.example:44300\r', '\r', '2\r', '\r']);
  await pending;
  assert.equal(installed.length, 1);
  assert.equal(installed[0].authentication, 'SSO');
  assert.equal(installed[0].childEnv.SAP_BROWSER_EXEC, '/browser/chrome');
});

test('SSO port detection sweeps every port, then asks until a port answers', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const probes = [];
  const pending = runSetup({
    env: { HOME: '/tmp/manual-sso-port-loop-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    discoverSsoBrowsers: async () => ({ browsers: [{ name: 'Microsoft Edge', path: '/browser/edge' }], unavailable: [] }),
    detectAdtUrl: async target => {
      probes.push(target);
      return target.ports?.[0] === 8422 ? { url: 'https://q7c.example:8422', reason: '' } : { url: '', reason: 'no port answered on q7c.example' };
    },
    install: async selected => { installed.push(...selected); return { servers: {} }; }
  });
  // Enter picks "enter the port" twice: 44399 does not answer, 8422 does.
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example\r', '100\r', '\r', '\r', '44399\r', '\r', '8422\r', 'n\r', '\r']);
  await pending;
  assert.deepEqual(probes, [
    { url: 'https://q7c.example', client: '100' },
    { url: 'https://q7c.example', client: '100', exhaustive: true },
    { url: 'https://q7c.example:44399', client: '100', ports: [44399] },
    { url: 'https://q7c.example:8422', client: '100', ports: [8422] }
  ]);
  assert.equal(installed[0].url, 'https://q7c.example:8422');
  assert.match(output.text(), /Scanning the remaining conventional SAP ports on q7c\.example/);
  assert.match(output.text(), /No ADT answer for Q7C: no port answered on q7c\.example/);
});

test('long port scans show a short spinner with elapsed time instead of a frozen line', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const pending = runSetup({
    env: { HOME: '/tmp/manual-sso-port-spinner-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    discoverSsoBrowsers: async () => ({ browsers: [{ name: 'Microsoft Edge', path: '/browser/edge' }], unavailable: [] }),
    detectAdtUrl: () => new Promise(resolve => setTimeout(() => resolve({ url: 'https://q7c.example:44310', reason: '' }), 1300)),
    install: async () => ({ servers: {} })
  });
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example\r', '100\r', '\r', 'n\r', '\r']);
  await pending;
  assert.match(output.text(), /ADT: Scanning the usual ADT ports on q7c\.example \(1 s\)/);
});

test('SSO port detection lets the user skip a system that never answers', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  let installCalls = 0;
  const pending = runSetup({
    env: { HOME: '/tmp/manual-sso-port-skip-test', SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true' },
    input,
    output,
    discoverLocalSapGui: async () => [],
    detectAdtUrl: async () => ({ url: '', reason: 'q7c.example does not resolve; connect to the company network or VPN', unresolved: true }),
    install: async () => { installCalls += 1; return { servers: {} }; }
  });
  await answerManualWizard(input, ['\r', 'Q7C\r', 'https://q7c.example\r', '100\r', '\r', 's', '\r', 'n\r']);
  const result = await pending;
  assert.equal(result.reason, 'no-destinations');
  assert.equal(installCalls, 0);
  assert.match(output.text(), /does not resolve; connect to the company network or VPN/);
  assert.match(output.text(), /Skipped Q7C/);
});

test('adtCandidate range-checks ports and strips pasted ADT paths', () => {
  assert.equal(adtCandidate('44310', 'https://q7c.example'), 'https://q7c.example:44310');
  assert.equal(adtCandidate(' 8000 ', 'http://[::1]'), 'http://[::1]:8000');
  assert.equal(adtCandidate('https://q7c.example:44300/sap/bc/adt/discovery', 'https://other.example'), 'https://q7c.example:44300');
  for (const port of ['0', '65536', '99999']) assert.throws(() => adtCandidate(port, 'https://q7c.example'), /between 1 and 65535/);
  assert.throws(() => adtCandidate('ftp://q7c.example', 'https://q7c.example'), /http/);
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
  const postinstallEnv = { ...process.env, PATH: pathEntry(bin) };
  await writeFakeCli(bin, 'cf', 'process.exitCode = 1;', postinstallEnv);
  // A global install puts sap-ai-dev on PATH; without one (CI runners) setup writes the npx launcher.
  const globalLauncher = join(bin, isWindows ? 'sap-ai-dev.cmd' : 'sap-ai-dev');
  await writeFile(globalLauncher, '', { mode: 0o755 });
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
    ...postinstallEnv,
    HOME: directory,
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

  const declined = await runPostinstallInPty(env, '\r\r', 'aa\r');
  assert.equal(declined.code, 0, `${declined.stdout}\n${declined.stderr}`);
  assert.equal(declined.selectionSent, true, declined.stdout);
  assert.equal(declined.assetsAnswerSent, true, declined.stdout);
  const declineLogs = `${declined.stdout}\n${declined.stderr}`;
  assert.match(declineLogs, /Configured 0 MCP servers/);
  assert.match(declineLogs, /The bundled agents and skills can be installed for several AI coding harnesses/);
  assert.match(declineLogs, /Space = select or deselect · a = toggle all · Enter = confirm/);
  assert.match(declineLogs, /🤖 sap-ai-dev-toolkit/);
  // Magenta header: terminals receive either one combined SGR sequence or
  // separate color+bold sequences depending on the platform writer.
  assert.match(declineLogs, /\u001b\[1;35m|\u001b\[35m\u001b\[1m/);
  assert.match(declineLogs, /GitHub Copilot \(skills \+ agents\)/);
  assert.match(declineLogs, /Gemini CLI \(skills\)/);
  assert.match(declineLogs, /Bundled agents and skills were skipped\. Your files were not changed/);
  assert.ok(declineLogs.indexOf('The bundled agents and skills can be installed for several AI coding harnesses') > declineLogs.indexOf('Configured 0 MCP servers'), declineLogs);
  assert.ok(declineLogs.indexOf('Install bundled agents and skills for') > declineLogs.indexOf('The bundled agents and skills can be installed for several AI coding harnesses'), declineLogs);
  assert.ok(declineLogs.indexOf('No MCP server entries are configured for this add-on.') > declineLogs.indexOf('Bundled agents and skills were skipped'), declineLogs);
  assert.ok(declineLogs.includes(`MCP config file: ${config}`), declineLogs);
  const configAfterDecline = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(Object.values(configAfterDecline.servers).filter(entry => entry.BAS_EXT === 'true').length, 0);
  await assert.rejects(stat(join(directory, '.copilot')), { code: 'ENOENT' });
  await assert.rejects(stat(join(directory, '.claude')), { code: 'ENOENT' });

  const accepted = await runPostinstallInPty(env, ' \r', '\r');
  assert.equal(accepted.code, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(accepted.selectionSent, true, accepted.stdout);
  assert.equal(accepted.assetsAnswerSent, true, accepted.stdout);
  const acceptLogs = `${accepted.stdout}\n${accepted.stderr}`;
  assert.ok(acceptLogs.indexOf('Install bundled agents and skills for') > acceptLogs.indexOf('Configured 1 MCP server'), acceptLogs);
  assert.match(acceptLogs, /GitHub Copilot: 23 files installed or updated in [^\n]*\.copilot; 0 already current/);
  assert.match(acceptLogs, /Claude Code: 23 files installed or updated in [^\n]*\.claude; 0 already current/);
  assert.match(acceptLogs, /Installed 46 files across 2 harnesses/);
  assert.ok(acceptLogs.indexOf('Installation configuration summary') > acceptLogs.indexOf('Installed 46 files across 2 harnesses'), acceptLogs);
  assert.ok(acceptLogs.includes(`MCP config file: ${config}`), acceptLogs);
  assert.ok(acceptLogs.includes('Destination: BAS · alpha-system · client 100 · Basic'), acceptLogs);
  assert.ok(acceptLogs.split(/\r?\n/).some(line => line.trim() === `Launch: stdio · ${globalLauncher}`), acceptLogs);
  assert.ok(acceptLogs.includes('Environment keys: H2O_URL, SAP_AI_DEV_TOOLKIT_DESTINATION, SAP_AI_DEV_TOOLKIT_VERSION, SAP_ALLOW_TRANSPORTABLE_EDITS'), acceptLogs);
  const configAfterAccept = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(Object.values(configAfterAccept.servers)
    .filter(entry => entry.BAS_EXT === 'true')
    .map(entry => entry.env.SAP_AI_DEV_TOOLKIT_DESTINATION), ['alpha-system']);
  await assertUserCopilotAssets(directory);
  await assertUserClaudeAssets(directory);

  const extendedHome = join(directory, 'home-extended');
  env.HOME = extendedHome;
  const extended = await runPostinstallInPty(env, ' \r', 'jjj \r');
  assert.equal(extended.code, 0, `${extended.stdout}\n${extended.stderr}`);
  assert.equal(extended.assetsAnswerSent, true, extended.stdout);
  const extendedLogs = `${extended.stdout}\n${extended.stderr}`;
  assert.match(extendedLogs, /Cursor: 16 files installed or updated in [^\n]*\.cursor; 0 already current/);
  assert.match(extendedLogs, /Installed 62 files across 3 harnesses/);
  await assertUserCopilotAssets(extendedHome);
  await assertUserClaudeAssets(extendedHome);
  const cursorSkills = (await readdir(join(extendedHome, '.cursor', 'skills'))).sort();
  assert.equal(cursorSkills.length, 16);
  await assert.rejects(stat(join(extendedHome, '.cursor', 'agents')), { code: 'ENOENT' });

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
    await assert.rejects(stat(join(directory, '.claude')), { code: 'ENOENT' });
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
    assert.match(logs, /Installing bundled agents and skills for GitHub Copilot by default because no interactive terminal is available/);
    await assertUserCopilotAssets(join(directory, 'home'));
    await assert.rejects(stat(join(directory, '.github')), { code: 'ENOENT' });
    await assert.rejects(readFile(config), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-TTY postinstall honors the harness environment override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-harness-env-'));
  const env = {
    ...process.env,
    HOME: directory,
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true',
    SAP_AI_DEV_TOOLKIT_HARNESSES: 'claude-code,gemini-cli,omp,cline,roo-code,windsurf',
    XDG_CONFIG_HOME: join(directory, 'xdg-config')
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
    assert.match(logs, /Installing bundled agents and skills for Claude Code, Gemini CLI, Oh My Pi \(OMP\), Cline, Roo Code, Windsurf \/ Devin Desktop by default because no interactive terminal is available/);
    await assertUserClaudeAssets(directory);
    const geminiSkills = (await readdir(join(directory, '.gemini', 'skills'))).sort();
    assert.equal(geminiSkills.length, 16);
    for (const root of [join(directory, '.omp', 'agent'), join(directory, '.cline'), join(directory, '.roo'), join(directory, 'xdg-config', 'devin')]) {
      assert.equal((await readdir(join(root, 'skills'))).length, 16, root);
      assert.equal((await stat(join(root, 'skills', 'abap-development', 'SKILL.md'))).isFile(), true, root);
    }
    await assert.rejects(stat(join(directory, '.copilot')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-TTY postinstall warns about an unknown harness override and falls back to Copilot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-harness-invalid-'));
  const env = {
    ...process.env,
    HOME: directory,
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true',
    SAP_AI_DEV_TOOLKIT_HARNESSES: 'unknown-harness'
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
    assert.match(logs, /Unknown harness id: unknown-harness\. Valid harness ids: github-copilot, claude-code, codex, cursor, gemini-cli, opencode, pi-coding-agent, omp, cline, roo-code, windsurf\. Ignoring SAP_AI_DEV_TOOLKIT_HARNESSES/);
    await assertUserCopilotAssets(directory);
    await assert.rejects(stat(join(directory, '.claude')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('postinstall harness selection honors the environment override in a live TTY', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-harness-pty-'));
  const env = {
    ...process.env,
    ...isolatedWindowsEnv(directory),
    HOME: directory,
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true',
    SAP_AI_DEV_TOOLKIT_HARNESSES: 'gemini-cli',
    FORCE_COLOR: '1'
  };
  delete env.H2O_URL;
  delete env.NO_COLOR;
  delete env.npm_config_ignore_scripts;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runPostinstallInPty(env, '', '\r');
  const logs = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, logs);
  assert.equal(result.assetsAnswerSent, true, logs);
  assert.match(logs, /Gemini CLI: 16 files installed or updated in [^\n]*\.gemini; 0 already current/);
  assert.match(logs, /Installed 16 files across 1 harness/);
  const geminiSkills = (await readdir(join(directory, '.gemini', 'skills'))).sort();
  assert.equal(geminiSkills.length, 16);
  await assert.rejects(stat(join(directory, '.copilot')), { code: 'ENOENT' });
  await assert.rejects(stat(join(directory, '.claude')), { code: 'ENOENT' });
});

test('postinstall harness selection skips without changes when interrupted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-postinstall-harness-interrupt-'));
  const env = {
    ...process.env,
    ...isolatedWindowsEnv(directory),
    HOME: directory,
    SAP_AI_DEV_TOOLKIT_BINARY: '/bin/true',
    FORCE_COLOR: '1'
  };
  delete env.H2O_URL;
  delete env.NO_COLOR;
  delete env.npm_config_ignore_scripts;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runPostinstallInPty(env, '', '\u0003');
  const logs = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, logs);
  assert.equal(result.assetsAnswerSent, true, logs);
  assert.match(logs, /Bundled agents and skills were skipped because the prompt was interrupted\. Your files were not changed/);
  await assert.rejects(stat(join(directory, '.copilot')), { code: 'ENOENT' });
  await assert.rejects(stat(join(directory, '.claude')), { code: 'ENOENT' });
});

test('postinstall runs when invoked through a symlinked install path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-postinstall-symlink-'));
  let alias;
  try {
    alias = join(directory, 'postinstall.mjs');
    await symlink(join(process.cwd(), 'scripts', 'postinstall.mjs'), alias);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    // File symlinks on Windows need Developer Mode or admin rights. A
    // directory junction requires no privileges and preserves the property
    // under test: postinstall starts from an install path outside the repo
    // and must still resolve its entry point through the link.
    const linkRoot = join(directory, 'install');
    await mkdir(linkRoot, { recursive: true });
    await symlink(join(process.cwd(), 'scripts'), join(linkRoot, 'scripts'), 'junction');
    alias = join(linkRoot, 'scripts', 'postinstall.mjs');
  }
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
      // detached drops the controlling console/terminal so postinstall takes
      // its documented non-interactive path instead of waiting on a prompt
      // this test never answers.
      const child = spawn(process.execPath, [alias], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

test('destination picker m shortcut adds a manual system without re-prompting discovered ones', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = manualWizardOutput();
  const installed = [];
  const pending = runSetup({
    env: { HOME: '/tmp/picker-manual-test' },
    input,
    output,
    discoverLocalSapGui: async () => [{ name: 'A4H', host: 'a4h.example', systemId: 'A4H', instance: '00', client: '100' }],
    install: async selected => {
      installed.push(...selected);
      return { path: '/tmp/picker-manual-test/mcp.json', servers: Object.fromEntries(selected.map(destination => [destination.name, { env: { SAP_AI_DEV_TOOLKIT_DESTINATION: destination.name } }])) };
    }
  });
  // m opens the wizard next to the discovered A4H entry; the configured
  // system joins the picker pre-selected and Enter confirms the selection.
  await answerManualWizard(input, ['m', 'Q7C\r', 'https://q7c.example:44300\r', '100\r', 'n\r', '\r', '\r']);
  await pending;
  // A single client keeps the base system name; the client rides in SAP_CLIENT.
  assert.deepEqual(installed.map(destination => destination.name), ['Q7C']);
  assert.equal(installed[0].configuredManually, true);
  assert.equal(installed[0].url, 'https://q7c.example:44300');
  assert.equal(installed[0].client, '100');
  assert.equal(installed[0].childEnv.SAP_AUTH_MODE, 'basic');
  const text = output.text();
  // After the wizard reports the added system, the discovery confirmation
  // flow must not re-ask its prompts for the manual entry.
  const [, afterManualEntry] = text.split('Added Q7C');
  assert.match(text, /ADT URL for Q7C/);
  assert.match(text, /SAP client\(s\) for Q7C/);
  assert.doesNotMatch(afterManualEntry, /ADT URL for|SAP client\(s\) for/);
  assert.match(text, /m = add a system manually/);
  assert.match(text, /💡 No system listed, or need an extra one\? Press m to skip discovery and add any SAP system manually\./);
  assert.match(text, /skip discovery, add your SAP system directly/);
  assert.match(text, /Q7C \(manual, client 100\)/);
  assert.match(text, /Configured 1 MCP server in/);
});

test('Integration Suite step: the logged-in CF space supplies the key and a role-less instance is replaced by a dedicated one', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-cf-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const keyFor = instance => ({ oauth: { url: 'https://tenant.it-cpi.example', tokenurl: 'https://auth.example/oauth/token', clientid: `id-${instance}`, clientsecret: 'cf-secret-value' } });
  const integrationCloudFoundry = {
    getTarget: async () => ({ available: true, spaceGuid: 'space-1', orgName: 'acme', spaceName: 'dev' }),
    findInstances: async ({ spaceGuid }) => {
      calls.push(['find', spaceGuid]);
      return { CPI: [{ guid: 'g1', name: 'isuite-api' }], APIM: [] };
    },
    serviceKey: async instance => {
      calls.push(['key', instance]);
      return { keyName: 'sap-ai-dev-integration', created: true, credentials: keyFor(instance) };
    },
    createInstance: async side => {
      calls.push(['create', side]);
      return { name: 'sap-ai-dev-integration-cpi' };
    }
  };
  // The pre-existing instance signs in but cannot read packages; the dedicated one has every role.
  const verifyIntegration = async config => {
    const ok = config.cpi.clientId === 'id-sap-ai-dev-integration-cpi';
    return {
      ok,
      cpi: { configured: true, signed_in: true, ok, checks: [{ area: 'Packages and iFlows', status: ok ? 200 : 403, result: ok ? 'ok' : 'forbidden', detail: 'HTTP 403: the service key lacks the role for this area' }] },
      apim: { configured: false }
    };
  };
  // y = add; Enter = default "Use the logged-in Cloud Foundry space"; y = create dedicated CPI instance;
  // Enter = do not create an APIM instance; Enter = do not create a DEVHUB instance; Enter = Continue.
  const { installs, text } = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(home, 'mcp.json') }, ['y\r', '\r', 'y\r', '\r', '\r', '\r'], { verifyIntegration, integrationCloudFoundry });
  assert.deepEqual(installs, [['integration-suite']]);
  assert.deepEqual(calls, [['find', 'space-1'], ['key', 'isuite-api'], ['create', 'CPI'], ['key', 'sap-ai-dev-integration-cpi']]);
  assert.match(text, /AuthGroup_IntegrationDeveloper/);
  const stored = JSON.parse(await readFile(join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json'), 'utf8'));
  assert.equal(stored.cpi.oauth.clientid, 'id-sap-ai-dev-integration-cpi');
  assert.doesNotMatch(text, /cf-secret-value/);
});

test('Integration Suite step: a saved key without roles makes "create a dedicated instance" the default fix', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-roleless-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keyFor = id => ({ oauth: { url: 'https://tenant.it-cpi.example', tokenurl: 'https://auth.example/oauth/token', clientid: id, clientsecret: 'cf-secret-value' } });
  await storeIntegrationKey('CPI', parseIntegrationServiceKey('CPI', keyFor('old-instance-key')), { XDG_CONFIG_HOME: join(home, '.config') });
  const config = join(home, 'mcp.json');
  await writeFile(config, JSON.stringify({ servers: { 'integration-suite': { type: 'stdio', command: 'npx', BAS_EXT: 'true', BAS_EXT_KIND: 'sap-development-companion' } } }));
  const created = [];
  const integrationCloudFoundry = {
    getTarget: async () => ({ available: true, spaceGuid: 'space-1', orgName: 'acme', spaceName: 'CIDev' }),
    createInstance: async side => {
      created.push(side);
      return { name: 'sap-ai-dev-integration-cpi' };
    },
    serviceKey: async instance => ({ keyName: 'sap-ai-dev-integration', created: true, credentials: keyFor(`id-${instance}`) })
  };
  const verifyIntegration = async ({ cpi }) => {
    const ok = cpi.clientId === 'id-sap-ai-dev-integration-cpi';
    return {
      ok,
      cpi: { configured: true, signed_in: true, ok, checks: [{ area: 'Packages and iFlows', status: ok ? 200 : 403, result: ok ? 'ok' : 'forbidden', detail: 'HTTP 403: the service key lacks the role for this area' }] },
      apim: { configured: false }
    };
  };
  // Enter = default fix (create the dedicated CPI instance); Enter = Continue once the new key is healthy.
  const { installs, text } = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config }, ['\r', '\r'], { verifyIntegration, integrationCloudFoundry });
  assert.deepEqual(installs, [['integration-suite']]);
  assert.deepEqual(created, ['CPI']);
  assert.match(text, /❯● Create sap-ai-dev-integration-cpi in acme \/ CIDev/);
  const stored = JSON.parse(await readFile(join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json'), 'utf8'));
  assert.equal(stored.cpi.oauth.clientid, 'id-sap-ai-dev-integration-cpi');
});

test('Integration Suite step: a pasted DEVHUB key is checked, stored user-only and never echoed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-devhub-paste-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const key = JSON.stringify({ url: 'https://devhub.example', tokenUrl: 'https://auth.example/oauth/token', clientId: 'devhub-id', clientSecret: 'devhub-wizard-secret' });
  // y = add; p = paste; d = Developer Hub; the key; Enter = Done.
  const { installs, text, verifyIntegration } = await runWizardToIntegrationStep({ HOME: home }, ['y\r', 'p\r', 'd\r', `${key}\r`, '\r']);
  assert.deepEqual(installs, [['integration-suite']]);
  assert.deepEqual(verifyIntegration.calls.map(config => Object.keys(config)), [['devhub']]);
  const path = join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.devhub.oauth.url, 'https://devhub.example');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(text, /DEVHUB: configured from stored-key, host devhub\.example/);
  assert.match(text, /AuthGroup\.API\.Admin/);
  assert.doesNotMatch(text, /devhub-wizard-secret/);
});

test('Integration Suite step: CF Developer Hub discovery obtains no key without approval', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-devhub-decline-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const writes = [];
  const integrationCloudFoundry = {
    getTarget: async () => ({ available: true, spaceGuid: 'space-1', orgName: 'acme', spaceName: 'dev' }),
    findInstances: async () => ({ CPI: [], APIM: [], DEVHUB: [{ guid: 'hub-1', name: 'hub-access' }] }),
    serviceKey: async () => { writes.push('key'); },
    createInstance: async side => { writes.push(side); }
  };
  const { text } = await runWizardToIntegrationStep({ HOME: home }, ['y\r', '\r', '\r', '\r', '\r', 'c\r'], { integrationCloudFoundry });
  assert.deepEqual(writes, []);
  assert.match(text, /Use hub-access and create or reuse its sap-ai-dev-integration service key/);
  await assert.rejects(stat(join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json')), { code: 'ENOENT' });
});

test('Integration Suite step: approved CF Developer Hub creation uses the admin plan and stores its key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-devhub-create-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const writes = [];
  const integrationCloudFoundry = {
    getTarget: async () => ({ available: true, spaceGuid: 'space-1', orgName: 'acme', spaceName: 'dev' }),
    findInstances: async () => ({ CPI: [], APIM: [], DEVHUB: [] }),
    createInstance: async side => { writes.push(['instance', side]); return { name: 'sap-ai-dev-integration-devhub' }; },
    serviceKey: async instance => {
      writes.push(['key', instance]);
      return { keyName: 'sap-ai-dev-integration', created: true, credentials: { url: 'https://devhub.example', tokenUrl: 'https://auth.example/oauth/token', clientId: 'hub-id', clientSecret: 'private-hub-secret' } };
    }
  };
  const { installs, text } = await runWizardToIntegrationStep({ HOME: home }, ['y\r', '\r', '\r', '\r', 'y\r', 'c\r'], { integrationCloudFoundry });
  assert.deepEqual(installs, [['integration-suite']]);
  assert.deepEqual(writes, [['instance', 'DEVHUB'], ['key', 'sap-ai-dev-integration-devhub']]);
  assert.match(text, /apimanagement-devportal, plan devportal-apiaccess.*AuthGroup\.API\.Admin/);
  const stored = JSON.parse(await readFile(join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json'), 'utf8'));
  assert.equal(stored.devhub.oauth.clientid, 'hub-id');
  assert.doesNotMatch(text, /private-hub-secret/);
});

test('Integration Suite step: a role-less DEVHUB stored key offers its dedicated admin instance', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-step-devhub-roleless-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keyFor = clientId => ({ url: 'https://devhub.example', tokenUrl: 'https://auth.example/oauth/token', clientId, clientSecret: 'private-hub-secret' });
  await storeIntegrationKey('DEVHUB', parseIntegrationServiceKey('DEVHUB', keyFor('old-hub')), { XDG_CONFIG_HOME: join(home, '.config') });
  const config = join(home, 'mcp.json');
  await writeFile(config, JSON.stringify({ servers: { 'integration-suite': { type: 'stdio', command: 'npx', BAS_EXT: 'true', BAS_EXT_KIND: 'sap-development-companion' } } }));
  const created = [];
  const integrationCloudFoundry = {
    getTarget: async () => ({ available: true, spaceGuid: 'space-1', orgName: 'acme', spaceName: 'dev' }),
    createInstance: async side => { created.push(side); return { name: 'sap-ai-dev-integration-devhub' }; },
    serviceKey: async instance => ({ keyName: 'sap-ai-dev-integration', created: true, credentials: keyFor(instance) })
  };
  const verifyIntegration = async ({ devhub }) => {
    const ok = devhub.clientId === 'sap-ai-dev-integration-devhub';
    return { ok, cpi: { configured: false }, apim: { configured: false }, devhub: { configured: true, signed_in: true, ok, checks: [{ area: 'Registered developers', status: ok ? 200 : 403, result: ok ? 'ok' : 'forbidden', detail: 'HTTP 403: the service key lacks the role for this area' }] } };
  };
  const { text } = await runWizardToIntegrationStep({ HOME: home, SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config }, ['\r', '\r'], { verifyIntegration, integrationCloudFoundry });
  assert.deepEqual(created, ['DEVHUB']);
  assert.match(text, /Create sap-ai-dev-integration-devhub in acme \/ dev/);
  const stored = JSON.parse(await readFile(join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json'), 'utf8'));
  assert.equal(stored.devhub.oauth.clientid, 'sap-ai-dev-integration-devhub');
  assert.doesNotMatch(text, /private-hub-secret/);
});

test('optional hidden setup stores typed existing ANS credentials without CF discovery, key creation or provisioning', async t => {
  const home = await mkdtemp(join(tmpdir(), 'optional-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const forbidden = async () => { calls.push('forbidden'); throw new Error('Optional setup must not use CF mutation/discovery wrappers'); };
  const integrationCloudFoundry = { getTarget: async () => ({ available: false }), findInstances: forbidden, serviceKey: forbidden, createInstance: forbidden };
  const value = { url: 'https://alerts.example', username: 'technical-client', password: 'hidden-optional-password' };
  // y = add; p = paste; n = Alert Notification (optional); the config; Enter = Done.
  const { installs, text } = await runWizardToIntegrationStep({ HOME: home }, ['y\r', 'p\r', 'n\r', `${JSON.stringify(value)}\r`, '\r'], { integrationCloudFoundry });
  assert.deepEqual(installs, [['integration-suite']]);
  assert.deepEqual(calls, []);
  const path = join(home, '.config', 'sap-ai-dev-toolkit', 'integration-suite.json');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).ans, value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(text, /hidden-optional-password/);
});
