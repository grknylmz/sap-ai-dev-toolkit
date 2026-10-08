import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isolatedWindowsEnv, isWindows, pathEntry, writeFakeCli } from './fake-bin.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npxMcpLauncher } from '../src/mcp-config.mjs';
import { spawnWithPty } from './pty.mjs';

const launcher = fileURLToPath(new URL('../src/launcher.mjs', import.meta.url));
const fakeVsp = fileURLToPath(new URL('./fixtures/fake-vsp.mjs', import.meta.url));
const exec = promisify(execFile);

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
function runLauncherTty(env, input, args = ['--setup'], wizardAnswer = 'e\r') {
  return new Promise((resolve, reject) => {
    // Quoted paths: the Windows node install lives under "C:\Program Files".
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} ${args.join(' ')}`;
    const child = spawnWithPty(command, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let inputSent = false;
    let wizardAnswerSent = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!wizardAnswerSent && stdout.includes('Configure an SAP system manually?')) {
        // Discovery found nothing and setup offers the manual entry wizard;
        // the default answer declines so the legacy skip flow completes.
        wizardAnswerSent = true;
        setTimeout(() => child.stdin.write(wizardAnswer), 400);
      }
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

// On Windows the local setup flow asks for the authentication mode after the
// ADT URL prompt (Windows SSO is offered there); Unix never shows that prompt.
function windowsAuthStep(label, options = {}) {
  return { when: `Authentication for ${label}`, input: 'p\r', ...options };
}

function runLauncherTtyScripted(env, steps, args = ['--setup']) {
  return new Promise((resolve, reject) => {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} ${args.join(' ')}`;
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
          // A short delay lets the target prompt finish rendering before the
          // keys arrive; ConPTY re-renders in chunks and an immediate write
          // can land before the field is listening.
          setTimeout(() => {
            child.stdin.write(step.input);
            if (sent.size === steps.length && step.end !== false) child.stdin.end();
          }, 400);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, sent: sent.size }); });
  });
}

async function createCertificate(directory, dnsName = 'sap-auto.example.test') {
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const config = join(directory, 'openssl.cnf');
  await writeFile(config, `[req]\ndistinguished_name=req_distinguished_name\nx509_extensions=v3_req\nprompt=no\n[req_distinguished_name]\nCN=${dnsName}\n[v3_req]\nsubjectAltName=@alt_names\n[alt_names]\nDNS.1=${dnsName}\n`);
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

async function startCertificateServer(directory) {
  const material = await createCertificate(directory);
  const server = https.createServer({ key: material.key, cert: material.cert, SNICallback: (_name, callback) => callback(null, tls.createSecureContext({ key: material.key, cert: material.cert })) }, (_request, response) => response.end('<ok/>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('package bin exposes the package-name executable for npx', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // `npx sap-ai-dev-toolkit` resolves the executable by package name when a
  // package ships several bins; without this alias npx aborts with
  // "could not determine executable to run".
  assert.equal(packageJson.bin['sap-ai-dev-toolkit'], packageJson.bin['sap-ai-dev']);
});

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

test('doctor reports missing BAS configuration as redacted JSON', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'bas-doctor-missing-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const result = await runLauncher(['--doctor', '--json'], {
    ...process.env,
    ...isolatedWindowsEnv(scratch),
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

test('runtime starts a configured local SAP GUI destination through TLS server-name self-healing proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-tls-runtime-'));
  const log = join(directory, 'children.log');
  try {
    const result = await runLauncher(['--doctor', '--json'], {
      ...process.env,
      SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
      SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
      SAP_AI_DEV_TOOLKIT_DESTINATION: 'Local TLS',
      SAP_URL: 'https://196.218.200.67:44300',
      SAP_TLS_SERVER_NAME: 'sapprd.company.local',
      SAP_CLIENT: '001',
      SAP_USER: 'local-user',
      SAP_PASSWORD: 'local-password',
      H2O_URL: '',
      FAKE_LOG: log
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const entries = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const init = entries.find(entry => entry.event === 'initialize');
    const url = init.argv[init.argv.indexOf('--url') + 1];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(JSON.stringify(init).includes('196.218.200.67'), false);
    assert.equal(init.env.user, 'local-user');
    assert.equal(init.env.password, 'local-password');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime starts a configured local SAP GUI SSO destination with VSP browser SSO and no credentials', async () => {
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
      SAP_SYSTEM_ID: 'S4H',
      SAP_AUTH_MODE: 'sso',
      SAP_USER: 'must-not-pass',
      SAP_PASSWORD: 'must-not-pass',
      H2O_URL: '',
      FAKE_LOG: log
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const entries = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const init = entries.find(entry => entry.event === 'initialize');
    assert.equal(init.argv[init.argv.indexOf('--url') + 1], 'https://abap.example.com:44300');
    assert.equal(init.argv.includes('--proxy-auth'), false);
    assert.equal(init.env.sso, 'true');
    assert.equal(init.env.ssoSystem, 's4h-100');
    assert.equal(JSON.stringify(init).includes('must-not-pass'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime maps legacy browser-saml and windows-sso entries to VSP browser SSO', async () => {
  for (const legacy of [
    { SAP_AUTH_MODE: 'browser-saml', SAP_BROWSER_AUTH: 'true', SAP_SAML_AUTH: 'true' },
    { SAP_AUTH_MODE: 'windows-sso', SAP_AI_DEV_TOOLKIT_WINDOWS_CREDENTIAL_UI: 'true' }
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-legacy-sso-'));
    const log = join(directory, 'children.log');
    try {
      const result = await runLauncher(['--doctor', '--json'], {
        ...process.env,
        SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
        SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
        SAP_AI_DEV_TOOLKIT_DESTINATION: 'Legacy SSO',
        SAP_URL: 'https://abap.example.com',
        SAP_CLIENT: '100',
        ...legacy,
        H2O_URL: '',
        FAKE_LOG: log
      });
      assert.equal(result.code, 0, result.stderr);
      const entries = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      const init = entries.find(entry => entry.event === 'initialize');
      assert.equal(init.env.sso, 'true', legacy.SAP_AUTH_MODE);
      assert.equal(init.env.ssoSystem, 'abap.example.com-100');
      assert.equal(init.env.browserAuth, undefined);
      assert.equal(init.env.samlAuth, '');
      assert.equal(init.argv.includes('--proxy-auth'), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('setup subprocess writes one isolated MCP entry per selected destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-launcher-setup-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFakeCli(bin, 'cf', 'process.exitCode = 1;');
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
  const env = { ...process.env, PATH: pathEntry(bin), H2O_URL: `http://127.0.0.1:${server.address().port}`, SAP_AI_DEV_TOOLKIT_SKIP_PROBE: 'true', SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config };
  try {
    const first = await runLauncherTty(env, 'a\r', ['--setup', '--npx']);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    let current = JSON.parse(await readFile(config, 'utf8'));
    let generated = Object.entries(current.servers).filter(([, entry]) => entry.BAS_EXT === 'true');
    assert.deepEqual(generated.map(([, entry]) => entry.env.SAP_AI_DEV_TOOLKIT_DESTINATION), ['alpha-system', 'beta-system'], `${first.stdout}\n${first.stderr}`);
    assert.equal(current.servers['alpha-system'].env.BAS_VSP_DESTINATION, undefined);
    assert.equal(generated.every(([, entry]) => entry.env.H2O_URL === env.H2O_URL), true);
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const npxLauncher = npxMcpLauncher();
    assert.deepEqual(generated.map(([, entry]) => [entry.command, entry.args]), generated.map(() => [
      npxLauncher.command,
      [...npxLauncher.prefixArgs, '--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${packageJson.version}`, 'sap-ai-dev']
    ]));
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

test('interactive local no-arg launcher starts setup instead of VSP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-noarg-'));
  const env = {
    ...process.env,
    ...isolatedWindowsEnv(directory),
    HOME: directory,
    APPDATA: join(directory, 'AppData', 'Roaming'),
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: join(directory, 'mcp.json')
  };
  delete env.H2O_URL;
  try {
    const result = await runLauncherTty(env, '', []);
    const logs = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, logs);
    assert.match(logs, /starting local interactive setup/);
    assert.match(logs, /Looking for local SAP GUI system configuration/);
    assert.match(logs, /No SAP GUI systems were found on this computer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interactive local launcher starts the manual entry wizard when no SAP GUI systems exist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-wizard-'));
  const config = join(directory, 'mcp.json');
  const env = {
    ...process.env,
    ...isolatedWindowsEnv(directory),
    HOME: directory,
    APPDATA: join(directory, 'AppData', 'Roaming'),
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
  };
  delete env.H2O_URL;
  try {
    const result = await runLauncherTtyScripted(env, [
      { when: 'Configure an SAP system manually?', input: '\r' },
      { when: 'System name', input: 'Q7C\r' },
      { when: 'ADT URL for Q7C', input: 'https://q7c.example:44300\r' },
      { when: 'SAP client(s) for Q7C', input: '\r' },
      ...(isWindows ? [{ when: 'Authentication for Q7C', input: 'p\r' }] : []),
      { when: 'Add another system?', input: 'n\r' }
    ], ['--setup']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(Object.keys(current.servers), ['q7c']);
    assert.equal(current.servers.q7c.env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE, 'sap-gui-local');
    assert.equal(current.servers.q7c.env.SAP_URL, 'https://q7c.example:44300');
    assert.equal(current.servers.q7c.env.SAP_CLIENT, '001');
    assert.equal(current.servers.q7c.env.SAP_AUTH_MODE, 'basic');
    assert.equal(current.servers.q7c.env.SAP_USER, '${input:sap-ai-dev-q7c-user}');
    assert.match(`${result.stdout}\n${result.stderr}`, /Added Q7C \(client 001\)/);
  } finally {
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
      ...isolatedWindowsEnv(directory),
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: ' \r', end: false },
      { when: 'SAP client(s) for Local ABAP', input: '\r', end: false },
      { when: 'ADT URL for Local ABAP', input: '\r', end: false },
      ...(isWindows ? [windowsAuthStep('Local ABAP')] : [])
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, isWindows ? 4 : 3);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(Object.keys(current.servers).sort(), ['a4h-100', 'unrelated']);
    assert.equal(current.servers['a4h-100'].env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE, 'sap-gui-local');
    assert.equal(current.servers['a4h-100'].env.SAP_AUTH_MODE, 'basic');
    assert.equal(current.servers['a4h-100'].env.SAP_URL, 'https://abap.example.com:44300');
    assert.equal(current.servers['a4h-100'].env.SAP_CLIENT, '100');
    assert.equal(current.servers['a4h-100'].env.SAP_SYSTEM_ID, 'A4H');
    assert.equal(current.servers['a4h-100'].env.SAP_USER, '${input:sap-ai-dev-local-abap-user}');
    assert.equal(current.servers['a4h-100'].env.SAP_PASSWORD, '${input:sap-ai-dev-local-abap-password}');
    assert.deepEqual(current.inputs.map(input => input.id), ['keep-me', 'sap-ai-dev-local-abap-user', 'sap-ai-dev-local-abap-password']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup creates separate MCP entries for multiple entered SAP clients', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-multi-client-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const sapCommon = join(appData, 'SAP', 'Common');
  await mkdir(sapCommon, { recursive: true });
  await writeFile(join(sapCommon, 'SAPUILandscape.xml'), `<?xml version="1.0"?><Landscape><Services><Service type="SAPGUI" name="Multi ABAP" server="abap.example.com" systemid="A4H" instancenumber="00" client="100" /></Services></Landscape>`);
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ inputs: [], servers: {} }));
  try {
    const result = await runLauncherTtyScripted({
      ...process.env,
      ...isolatedWindowsEnv(directory),
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: ' \r', end: false },
      { when: 'SAP client(s) for Multi ABAP', input: ' 100, 200,100 \r', end: false },
      { when: 'ADT URL for Multi ABAP', input: '\r', end: false },
      ...(isWindows ? [windowsAuthStep('Multi ABAP')] : [])
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, isWindows ? 4 : 3);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(Object.keys(current.servers).sort(), ['a4h-100', 'a4h-200']);
    assert.equal(current.servers['a4h-100'].env.SAP_CLIENT, '100');
    assert.equal(current.servers['a4h-200'].env.SAP_CLIENT, '200');
    assert.equal(current.servers['a4h-100'].env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'Multi ABAP 100');
    assert.equal(current.servers['a4h-200'].env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'Multi ABAP 200');
    assert.deepEqual(current.inputs.map(input => input.id).sort(), [
      'sap-ai-dev-multi-abap-100-password',
      'sap-ai-dev-multi-abap-100-user',
      'sap-ai-dev-multi-abap-200-password',
      'sap-ai-dev-multi-abap-200-user'
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup disambiguates duplicate SAP GUI system names before writing MCP entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-duplicate-names-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const sapCommon = join(appData, 'SAP', 'Common');
  await mkdir(sapCommon, { recursive: true });
  await writeFile(join(sapCommon, 'SAPUILandscape.xml'), `<?xml version="1.0"?><Landscape><Services><Service type="SAPGUI" name="Duplicate ABAP" server="one.example.com" systemid="A4H" instancenumber="00" client="100" /><Service type="SAPGUI" name="Duplicate ABAP" server="two.example.com" systemid="B4H" instancenumber="01" client="100" /></Services></Landscape>`);
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ inputs: [], servers: {} }));
  try {
    const result = await runLauncherTtyScripted({
      ...process.env,
      ...isolatedWindowsEnv(directory),
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: 'a\r', end: false },
      { when: 'SAP client(s) for Duplicate ABAP (A4H one.example.com 00)', input: '\r', end: false },
      { when: 'ADT URL for Duplicate ABAP (A4H one.example.com 00)', input: '\r', end: false },
      ...(isWindows ? [windowsAuthStep('Duplicate ABAP (A4H one.example.com 00)', { end: false })] : []),
      { when: 'SAP client(s) for Duplicate ABAP (B4H two.example.com 01)', input: '\r', end: false },
      { when: 'ADT URL for Duplicate ABAP (B4H two.example.com 01)', input: '\r', end: false },
      ...(isWindows ? [windowsAuthStep('Duplicate ABAP (B4H two.example.com 01)')] : [])
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, isWindows ? 7 : 5);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(Object.keys(current.servers).sort(), [
      'a4h-100',
      'b4h-100'
    ]);
    assert.equal(current.servers['a4h-100'].env.SAP_URL, 'https://one.example.com:44300');
    assert.equal(current.servers['b4h-100'].env.SAP_URL, 'https://two.example.com:44301');
    assert.equal(current.servers['a4h-100'].env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'Duplicate ABAP 100 A4H one.example.com 00');
    assert.equal(current.servers['b4h-100'].env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'Duplicate ABAP 100 B4H two.example.com 01');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup auto-discovers TLS certificate DNS names when ADT URL uses an IP address', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-local-tls-setup-'));
  const appData = join(directory, 'AppData', 'Roaming');
  const sapCommon = join(appData, 'SAP', 'Common');
  await mkdir(sapCommon, { recursive: true });
  await writeFile(join(sapCommon, 'SAPUILandscape.xml'), `<?xml version="1.0"?><Landscape><Services><Service type="SAPGUI" name="IP ABAP" server="196.218.200.67" systemid="IP1" instancenumber="00" client="001" /></Services></Landscape>`);
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ inputs: [], servers: {} }));
  const certificateServer = await startCertificateServer(directory);
  try {
    const adtUrl = `https://127.0.0.1:${certificateServer.address().port}`;
    const result = await runLauncherTtyScripted({
      ...process.env,
      ...isolatedWindowsEnv(directory),
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: ' \r', end: false },
      { when: 'SAP client(s) for IP ABAP', input: '\r', end: false },
      { when: 'ADT URL for IP ABAP', input: `${adtUrl}\r`, end: false },
      { when: 'Use discovered certificate DNS name', input: '\r', end: false },
      ...(isWindows ? [windowsAuthStep('IP ABAP')] : [])
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, isWindows ? 5 : 4);
    assert.match(result.stdout, /TLS self-heal/);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(current.servers['ip1-001'].env.SAP_URL, adtUrl);
    assert.equal(current.servers['ip1-001'].env.SAP_TLS_SERVER_NAMES, 'sap-auto.example.test');
    assert.equal(current.servers['ip1-001'].env.SAP_TLS_SERVER_NAME, undefined);
    assert.equal(current.servers['ip1-001'].env.SAP_AUTH_MODE, 'basic');
  } finally {
    await new Promise(resolve => certificateServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup can write SSO auth mode without login inputs', async () => {
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
      ...isolatedWindowsEnv(directory),
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: appData,
      H2O_URL: '',
      SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP: 'true',
      SAP_AI_DEV_TOOLKIT_MCP_CONFIG: config
    }, [
      { when: 'Select destinations', input: ' \r', end: false },
      { when: 'SAP client(s) for SSO ABAP', input: '\r', end: false },
      { when: 'ADT URL for SSO ABAP', input: '\r', end: false },
      { when: 'Authentication for SSO ABAP', input: '\r' }
    ], ['--setup', '--npx']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.sent, 4);
    const current = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(current.servers['s4h-100'].env.SAP_AUTH_MODE, 'sso');
    assert.equal(current.servers['s4h-100'].env.SAP_USER, undefined);
    assert.equal(current.servers['s4h-100'].env.SAP_PASSWORD, undefined);
    assert.equal(current.servers['s4h-100'].env.SAP_URL, 'https://sso.example.com:44300');
    assert.deepEqual(current.inputs.map(input => input.id), ['keep-me']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-BAS list mode reports the required discovery boundary', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'bas-list-boundary-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const result = await runLauncher(['--list-destinations', '--json'], { ...process.env, ...isolatedWindowsEnv(scratch), H2O_URL: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /H2O_URL is required/);
});
