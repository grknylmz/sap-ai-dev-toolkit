import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithPty } from './pty.mjs';

const launcher = fileURLToPath(new URL('../src/launcher.mjs', import.meta.url));
const fakeVsp = fileURLToPath(new URL('./fixtures/fake-vsp.mjs', import.meta.url));

function runLauncher(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
function runLauncherTty(env, input, args = ['--setup']) {
  return new Promise((resolve, reject) => {
    const command = `${process.execPath} ${launcher} ${args.join(' ')}`;
    const child = spawnWithPty(command, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let inputSent = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!inputSent && stdout.includes('Select destinations')) {
        inputSent = true;
        child.stdin.end(input);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, inputSent }); });
  });
}

function runLauncherTtyScripted(env, steps, args = ['--setup']) {
  return new Promise((resolve, reject) => {
    const command = `${process.execPath} ${launcher} ${args.join(' ')}`;
    const child = spawnWithPty(command, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const sent = new Set();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      for (const [index, step] of steps.entries()) {
        if (!sent.has(index) && stdout.includes(step.when)) {
          sent.add(index);
          child.stdin.write(step.input);
          if (sent.size === steps.length && step.end !== false) child.stdin.end();
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, sent: sent.size }); });
  });
}

test('help exits before BAS destination discovery', async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end('[]');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await runLauncher(['--help'], { ...process.env, H2O_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: sap-ai-dev/);
  assert.match(result.stdout, /Use an MCP client to call server tools/);
  assert.equal(requests, 0);
});

test('doctor reports missing BAS configuration as redacted JSON', async () => {
  const result = await runLauncher(['--doctor', '--json'], {
    ...process.env,
    H2O_URL: '',
    SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: '',
    BAS_VSP_DESTINATION_SOURCE: ''
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    destinations: 0,
    checks: [{
      name: '-',
      stage: 'destination discovery',
      status: 'failed',
      detail: 'H2O_URL is required for BAS destination discovery'
    }]
  });
});

test('doctor calls GetSystemInfo directly through the configured destination without a CSRF preflight', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-doctor-direct-destination-'));
  const configPath = join(directory, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ servers: {} }));
  const requests = [];
  const server = createServer((request, response) => {
    let requestPath;
    try { requestPath = new URL(request.url, `http://${request.headers.host}`).pathname; }
    catch { requestPath = request.url; }
    requests.push({ method: request.method, path: requestPath, host: request.headers.host, csrf: request.headers['x-csrf-token'] });
    if (request.url === '/api/listDestinations') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{
        Name: 'doctor-system',
        WebIDEEnabled: true,
        'HTML5.DynamicDestination': true,
        WebIDEUsage: 'dev_abap',
        Authentication: 'BasicAuthentication'
      }]));
      return;
    }
    response.writeHead(200);
    response.end('<ok/>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const result = await runLauncher(['--doctor', '--json'], {
    ...process.env,
    SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
    FAKE_DIRECT_DESTINATION_TEST: 'true',
    SAP_AI_DEV_MCP_CONFIG: configPath,
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'doctor-system',
    H2O_URL: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  });
  assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some(check => check.stage === 'SAP system check' && check.status === 'passed'));
  assert.ok(report.checks.some(check => check.stage === 'MCP tools/list' && /total MCP tools returned; chat-picker binding is host-managed/.test(check.detail)));
  assert.ok(requests.some(request => request.method === 'GET' && request.path === '/sap/bc/adt/discovery' && request.host === 'doctor-system.dest' && request.csrf === undefined));
  assert.equal(requests.some(request => request.csrf === 'Fetch'), false);
});

test('list-destinations JSON is redacted and probes through the BAS proxy', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    if (request.url === '/api/listDestinations') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ Name: 'launch-system', WebIDEEnabled: true, 'HTML5.DynamicDestination': true, WebIDEUsage: 'dev_abap', Authentication: 'PrincipalPropagation', Password: 'do-not-print' }]));
      return;
    }
    response.writeHead(403);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const result = await runLauncher(['--list-destinations', '--json'], { ...process.env, H2O_URL: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: '127.0.0.1' });
  await new Promise(resolve => server.close(resolve));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ name: 'launch-system', client: '001', authentication: 'PrincipalPropagation', probe: 'auth-required' }]);
  assert.deepEqual(requests, [
    { host: `127.0.0.1:${port}`, path: '/api/listDestinations' },
    { host: 'launch-system.dest', path: 'http://launch-system.dest/sap/bc/adt/discovery' }
  ]);
  assert.equal(result.stdout.includes('do-not-print'), false);
});
test('runtime starts destinations even when their ADT probes fail', async () => {
  const server = createServer((request, response) => {
    if (request.url.includes('/api/listDestinations')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ Name: 'launch-system', WebIDEEnabled: true, 'HTML5.DynamicDestination': true, WebIDEUsage: 'dev_abap' }]));
      return;
    }
    response.writeHead(503);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runLauncher([], {
      ...process.env,
      SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
      H2O_URL: 'http://bas.example',
      SAP_AI_DEV_TOOLKIT_DESTINATION: 'launch-system',
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      NO_PROXY: '',
      no_proxy: ''
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /launch-system: probe=unavailable \(HTTP 503\)/);
    assert.match(result.stderr, /starting MCP proxy for launch-system \(client=001\)/);
    assert.match(result.stderr, /\[launch-system\] starting VSP child/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
test('configured local SAP GUI runtime fails clearly without ADT URL', async () => {
  const result = await runLauncher([], {
    ...process.env,
    SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'Local Missing URL',
    H2O_URL: ''
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SAP_URL is required for local SAP GUI MCP entries/);
  assert.doesNotMatch(result.stderr, /H2O_URL is required/);
});

test('runtime starts a configured local SAP GUI destination without BAS discovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-runtime-'));
  const log = join(directory, 'children.log');
  try {
    const result = await runLauncher([], {
      ...process.env,
      SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
      SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
      SAP_AI_DEV_TOOLKIT_DESTINATION: 'Local Dev',
      SAP_URL: 'https://abap.example.com:44300',
      SAP_CLIENT: '100',
      SAP_USER: 'local-user',
      SAP_PASSWORD: 'local-password',
      H2O_URL: '',
      FAKE_LOG: log
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[Local Dev\] starting VSP child \(client=100\)/);
    assert.equal(result.stderr.includes('H2O_URL is required'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime starts a configured local SAP GUI Windows SSO destination through loopback proxy without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-sso-runtime-'));
  const log = join(directory, 'children.log');
  try {
    const result = await runLauncher(['--doctor', '--json'], {
      ...process.env,
      SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
      SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
      SAP_AI_DEV_TOOLKIT_DESTINATION: 'Local SSO',
      SAP_URL: 'https://abap.example.com:44300',
      SAP_CLIENT: '100',
      SAP_AUTH_MODE: 'windows-sso',
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_USER: 'must-not-pass',
      SAP_PASSWORD: 'must-not-pass',
      H2O_URL: '',
      FAKE_LOG: log
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.match(result.stderr, /\[Local SSO\] starting VSP child \(client=100\)/);
    const entries = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const init = entries.find(entry => entry.event === 'initialize');
    assert.ok(init, 'fake VSP initialize log is present');
    const url = init.argv[init.argv.indexOf('--url') + 1];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(init.argv.includes('--proxy-auth'), 'SSO proxy owns authentication; VSP must not prompt or load .env credentials');
    assert.equal(init.env.user, '');
    assert.equal(init.env.password, '');
    assert.equal(JSON.stringify(init).includes('must-not-pass'), false);
    assert.equal(JSON.stringify(init).includes('abap.example.com'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup subprocess writes one isolated MCP entry per selected destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-launcher-setup-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const cfCli = join(bin, 'cf');
  await writeFile(cfCli, '#!/bin/sh\nexit 1\n');
  await chmod(cfCli, 0o755);
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ inputs: [], servers: {
    unrelated: { type: 'stdio', command: 'other' },
    'alpha-system': {
      type: 'stdio',
      command: 'bas-vsp-mcp',
      env: { H2O_URL: 'http://old-h2o.example', BAS_VSP_DESTINATION: 'alpha-system' },
      BAS_EXT: 'true'
    }
  } }));
  const server = createServer((request, response) => {
    if (request.url === '/api/listDestinations') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([
        { Name: 'alpha-system', WebIDEEnabled: true, 'HTML5.DynamicDestination': true, WebIDEUsage: 'dev_abap', 'SAP-Client': '100' },
        { Name: 'beta-system', WebIDEEnabled: true, 'HTML5.DynamicDestination': true, WebIDEUsage: 'dev_abap', 'SAP-Client': '200' }
      ]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ''}`, H2O_URL: `http://127.0.0.1:${server.address().port}`, SAP_AI_DEV_TOOLKIT_SKIP_PROBE: 'true', SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config };
  try {
    const first = await runLauncherTty(env, 'a\r', ['--setup', '--npx']);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    let current = JSON.parse(await readFile(config, 'utf8'));
    let generated = Object.entries(current.servers).filter(([, entry]) => entry.BAS_EXT === 'true');
    assert.deepEqual(generated.map(([, entry]) => entry.env.SAP_AI_DEV_TOOLKIT_DESTINATION), ['alpha-system', 'beta-system'], `${first.stdout}\n${first.stderr}`);
    assert.equal(current.servers['alpha-system'].env.BAS_VSP_DESTINATION, undefined);
    assert.equal(generated.every(([, entry]) => entry.env.H2O_URL === env.H2O_URL), true);
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.deepEqual(generated.map(([, entry]) => [entry.command, entry.args]), [
      ['npx', ['--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${packageJson.version}`, 'sap-ai-dev']],
      ['npx', ['--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${packageJson.version}`, 'sap-ai-dev']]
    ]);
    const second = await runLauncherTty(env, '\r', ['--setup', '--npx']);
    assert.equal(second.code, 0, `${second.stdout}\\n${second.stderr}`);
    current = JSON.parse(await readFile(config, 'utf8'));
    generated = Object.keys(current.servers).filter(name => name !== 'unrelated');
    assert.deepEqual(generated, []);
    assert.deepEqual(current.servers.unrelated, { type: 'stdio', command: 'other' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup discovers SAP GUI systems, prompts for ADT URL, and writes login inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-setup-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const sapCommon = join(appData, 'SAP', 'Common');
  await mkdir(sapCommon, { recursive: true });
  await writeFile(join(sapCommon, 'SAPUILandscape.xml'), `<?xml version="1.0"?><Landscape><Services><Service type="SAPGUI" name="Local ABAP" server="abap.example.com" systemid="A4H" instancenumber="00" client="100" /></Services></Landscape>`);
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ inputs: [{ id: 'keep-me', type: 'promptString' }], servers: { unrelated: { command: 'other' } } }));
  try {
    const result = await runLauncherTtyScripted({
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: ' \r', end: false },
      { when: 'ADT URL for Local ABAP', input: '\r' }
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, 2);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(Object.keys(current.servers).sort(), ['local-abap', 'unrelated']);
    assert.equal(current.servers['local-abap'].env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE, 'sap-gui-local');
    assert.equal(current.servers['local-abap'].env.SAP_AUTH_MODE, 'basic');
    assert.equal(current.servers['local-abap'].env.SAP_URL, 'https://abap.example.com:44300');
    assert.equal(current.servers['local-abap'].env.SAP_CLIENT, '100');
    assert.equal(current.servers['local-abap'].env.SAP_USER, '${input:sap-ai-dev-local-abap-user}');
    assert.equal(current.servers['local-abap'].env.SAP_PASSWORD, '${input:sap-ai-dev-local-abap-password}');
    assert.deepEqual(current.inputs.map(input => input.id), ['keep-me', 'sap-ai-dev-local-abap-user', 'sap-ai-dev-local-abap-password']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup can write Windows SSO auth mode without login inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-sso-setup-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const sapCommon = join(appData, 'SAP', 'Common');
  await mkdir(sapCommon, { recursive: true });
  await writeFile(join(sapCommon, 'SAPUILandscape.xml'), `<?xml version="1.0"?><Landscape><Services><Service type="SAPGUI" name="SSO ABAP" server="sso.example.com" systemid="S4H" instancenumber="00" client="100" sncname="p/sso@example.com" /></Services></Landscape>`);
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ inputs: [{ id: 'keep-me', type: 'promptString' }], servers: { unrelated: { command: 'other' } } }));
  try {
    const result = await runLauncherTtyScripted({
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: ' \r', end: false },
      { when: 'ADT URL for SSO ABAP', input: '\r', end: false },
      { when: 'Authentication for SSO ABAP', input: 'sso\r' }
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, 3);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(current.servers['sso-abap'].env.SAP_AUTH_MODE, 'windows-sso');
    assert.equal(current.servers['sso-abap'].env.SAP_USER, undefined);
    assert.equal(current.servers['sso-abap'].env.SAP_PASSWORD, undefined);
    assert.equal(current.servers['sso-abap'].env.SAP_URL, 'https://sso.example.com:44300');
    assert.deepEqual(current.inputs.map(input => input.id), ['keep-me']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-BAS list mode reports the required discovery boundary', async () => {
  const result = await runLauncher(['--list-destinations', '--json'], { ...process.env, H2O_URL: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /H2O_URL is required/);
});
