import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runDatasphereCommand } from '../src/datasphere-command.mjs';
import { spawnWithPty } from './pty.mjs';

const host = 'https://tenant.eu20.hcs.cloud.sap';
const codeUrl = 'https://tenant.authentication.eu20.hana.ondemand.com/passcode';
const launcher = fileURLToPath(new URL('../src/launcher.mjs', import.meta.url));

function stream() {
  const value = new PassThrough();
  let text = '';
  value.on('data', chunk => { text += chunk.toString(); });
  value.text = () => text;
  return value;
}

async function fixture(t, scripts = []) {
  const home = await mkdtemp(join(tmpdir(), 'datasphere-command-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env.PATH || '' };
  const output = stream();
  const errorOutput = stream();
  const input = new PassThrough();
  input.isTTY = true;
  const calls = [];
  const spawnImpl = (file, argv, options) => {
    const index = argv.indexOf('--options-file');
    const call = { file, argv, options };
    if (index >= 0) {
      call.record = JSON.parse(readFileSync(argv[index + 1], 'utf8'));
      call.mode = statSync(argv[index + 1]).mode & 0o777;
    }
    calls.push(call);
    const script = scripts.shift() ?? { stdout: '' };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    child.kill = signal => { if (!closed) { closed = true; child.emit('close', null, signal || 'SIGTERM'); } };
    setImmediate(() => {
      if (script.error) { child.emit('error', script.error); return; }
      if (argv.slice(1, 4).join(' ') === 'config cache init' && !script.code) {
        const cache = join(options.env.HOME, '.@sap', 'datasphere-cli', '.cache');
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, 'discovery-fixture.json'), JSON.stringify({ paths: { '/views': { get: { operationId: 'objects views list' } } } }));
        writeFileSync(join(cache, 'discovery-metadata.json'), '{}');
        writeFileSync(join(cache, 'secrets.json'), 'must-not-persist');
      }
      if (typeof options.stdio[1]?.write === 'function') options.stdio[1].write(script.stdout || '');
      else child.stdout.write(script.stdout || '');
      if (typeof options.stdio[2]?.write === 'function') options.stdio[2].write(script.stderr || '');
      else child.stderr.write(script.stderr || '');
      if (!closed) { closed = true; child.emit('close', script.code ?? 0, script.signal ?? null); }
    });
    return child;
  };
  const prompts = [];
  const opened = [];
  const prompt = async options => {
    prompts.push(options);
    return options.secret ? (prompts.filter(prompt => prompt.secret).length === 1 ? 'browser-init-code' : 'browser-code-1_with-symbols') : `${host}/dwaas-core/index.html#/connections`;
  };
  return { home, env, input, output, errorOutput, calls, prompts, opened, options: { env, input, output, errorOutput, spawnImpl, prompt, openUrl: url => opened.push(url) } };
}

test('first CLI command asks for tenant and separate one-use browser codes, initializes automatically and preserves native arguments', async t => {
  const f = await fixture(t, [{ stdout: `${codeUrl}\n` }, {}, { stdout: '[{"technicalName":"VIEW_1"}]\n' }]);
  const result = await runDatasphereCommand(['objects', 'views', 'list', '--space', 'AI_SPACE', '--filter', 'businessName eq \'A B\''], { ...f.options, cwd: f.home });
  assert.equal(result, 0);
  assert.deepEqual(f.prompts.map(prompt => prompt.secret === true), [false, true, true]);
  assert.deepEqual(f.opened, [codeUrl, codeUrl]);
  assert.deepEqual(f.calls[1].argv.slice(1, 4), ['config', 'cache', 'init']);
  assert.deepEqual(f.calls[2].argv.slice(1, 9), ['objects', 'views', 'list', '--space', 'AI_SPACE', '--filter', 'businessName eq \'A B\'', '--host']);
  assert.equal(f.calls[2].options.cwd, f.home, 'relative input/output paths keep the caller working directory');
  assert.equal(f.output.text(), '[{"technicalName":"VIEW_1"}]\n');
  assert.match(f.errorOutput.text(), /Sign in at https:/);
  const saved = JSON.parse(await readFile(join(f.home, '.config', 'sap-ai-dev-toolkit', 'datasphere-cli.json'), 'utf8'));
  assert.deepEqual(saved, { url: host });
  const records = f.calls.filter(call => call.record);
  assert.equal(records[0].record.passcode, 'browser-init-code');
  assert.equal(records[1].record.passcode, 'browser-code-1_with-symbols');
  for (const call of records) {
    assert.equal(call.record.host, host);
    if (process.platform !== 'win32') assert.equal(call.mode, 0o600);
    assert.equal(JSON.stringify(call.argv).includes('browser-code-1_with-symbols'), false);
  }
  assert.equal(existsSync(f.calls[0].options.env.HOME), false, 'temporary authentication and cache files are removed');
  const cacheRoot = join(f.home, '.config', 'sap-ai-dev-toolkit', 'datasphere-cli-cache');
  const files = await readdir(cacheRoot, { recursive: true });
  assert.equal(files.filter(name => /discovery-.*\.json$/.test(name)).length, 2);
  assert.ok(files.every(name => !/secrets|options|token/i.test(name)), 'only discovery metadata is retained');
});

test('a remembered tenant removes the host prompt and explicit host overrides it', async t => {
  const f = await fixture(t, [{}, { stdout: `${codeUrl}\n` }, {}]);
  const path = join(f.home, '.config', 'sap-ai-dev-toolkit', 'datasphere-cli.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ url: host }));
  await runDatasphereCommand(['config', 'cache', 'init', '--host', host, '--passcode', 'initialize-code'], f.options);
  await runDatasphereCommand(['spaces', 'connections', 'list', '--space', 'AI_SPACE'], f.options);
  assert.deepEqual(f.prompts.map(prompt => prompt.secret), [true]);
  assert.equal(f.calls[2].record.host, host);
  const explicit = await fixture(t, [{}, {}]);
  await runDatasphereCommand(['--host=https://other.eu20.hcs.cloud.sap/#/home', '--passcode=-code_with-symbols', 'config', 'cache', 'init'], explicit.options);
  assert.equal(explicit.calls[0].record.host, 'https://other.eu20.hcs.cloud.sap');
  assert.equal(explicit.calls[0].record.passcode, '-code_with-symbols');
  assert.equal(explicit.prompts.length, 0);
});

test('OAuth sign-in can supply the tenant URL without sending OAuth credentials to the CLI', async t => {
  const f = await fixture(t, [{ stdout: `${codeUrl}\n` }, {}, {}]);
  const path = join(f.home, '.config', 'sap-ai-dev-toolkit', 'datasphere.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ url: host, clientid: 'private-client', clientsecret: 'private-secret' }));
  await runDatasphereCommand(['spaces', 'list'], f.options);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts.every(prompt => prompt.secret));
  assert.equal(f.calls[1].record.host, host);
  assert.doesNotMatch(JSON.stringify(f.calls.map(call => call.record)), /private-client|private-secret/);
});

test('stdin automation accepts a browser code without opening a browser or adding credentials to arguments', async t => {
  const f = await fixture(t, [{}, { stdout: '[]\n', code: 7 }]);
  await runDatasphereCommand(['config', 'cache', 'init', '--host', host, '--passcode-stdin'], { ...f.options, input: Readable.from(['initialization-code\n']) });
  const input = Readable.from([' code-from-', 'stdin_with-symbols\r\n']);
  const result = await runDatasphereCommand(['objects', 'views', 'list', '-H', host, '--passcode-stdin'], { ...f.options, input });
  assert.equal(result, 7, 'native exit code is propagated');
  assert.equal(f.opened.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].record, { host, passcode: 'code-from-stdin_with-symbols' });
  assert.equal(existsSync(f.calls[0].options.env.HOME), false);
});

test('a shell environment cannot override the tenant or inject authentication into the child', async t => {
  const f = await fixture(t, [{}, {}]);
  await runDatasphereCommand(['config', 'cache', 'init', '--passcode', 'code'], { ...f.options, env: { ...f.env, DATASPHERE_URL: host, HOST: 'https://evil.example', CLIENT_ID: 'evil', ACCESS_TOKEN: 'private-token', NODE_OPTIONS: '--inspect' } });
  const env = f.calls[0].options.env;
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'USERPROFILE']);
  assert.equal(env.HOME, env.USERPROFILE);
  assert.notEqual(env.HOME, f.home);
  assert.equal(f.calls[0].record.host, host);
});

test('initialization failures stop the native command, scrub the code and remove temporary files', async t => {
  const f = await fixture(t, [{ code: 1, stdout: 'invalid passcode private-code' }]);
  await assert.rejects(runDatasphereCommand(['objects', 'views', 'list', '--host', host, '--passcode', 'private-code'], f.options), error => {
    assert.match(error.message, /initialization failed.*\[redacted\]/);
    assert.doesNotMatch(error.message, /private-code/);
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(existsSync(f.calls[0].options.env.HOME), false);
});

test('browser-open failures keep the printed login URL usable', async t => {
  const f = await fixture(t, [{ stdout: `${codeUrl}\n` }, {}, {}]);
  const result = await runDatasphereCommand(['spaces', 'list', '--host', host], { ...f.options, openUrl: async () => { throw new Error('no browser on remote host'); } });
  assert.equal(result, 0);
  assert.match(f.errorOutput.text(), /tenant\.authentication\.eu20.*passcode/);
  assert.equal(f.prompts.at(-1).secret, true);
});

test('missing noninteractive inputs, invalid tenants and competing auth options fail before spawning', async t => {
  const f = await fixture(t);
  const cases = [
    { argv: ['spaces', 'list'], message: /Supply --host/ },
    { argv: ['spaces', 'list', '--host', host], message: /needs a terminal/ },
    { argv: ['spaces', 'list', '--host', 'http://remote.example'], message: /must use https/ },
    { argv: ['spaces', 'list', '--host', 'https://user:secret@tenant.example'], message: /must not contain credentials/ },
    { argv: ['spaces', 'list', '--host'], message: /Missing value/ },
    { argv: ['spaces', 'list', '--options-file', 'other.json'], message: /browser-code authentication/ },
    { argv: ['spaces', 'list', '--client-secret=secret'], message: /browser-code authentication/ },
    { argv: ['spaces', 'list', '--passcode-stdin', '--passcode', 'code'], message: /either --passcode/ }
  ];
  for (const { argv, message } of cases) await assert.rejects(runDatasphereCommand(argv, { ...f.options, input: Readable.from([]) }), message);
  assert.equal(f.calls.length, 0);
});

test('empty, multiline and oversized stdin codes are rejected before any tenant command', async t => {
  for (const value of ['', 'code1\ncode2\n', 'x'.repeat(4097)]) {
    const f = await fixture(t);
    await assert.rejects(runDatasphereCommand(['config', 'cache', 'init', '--host', host, '--passcode-stdin'], { ...f.options, input: Readable.from([value]) }), /authentication code|too long/);
    assert.equal(f.calls.length, 0);
  }
});

test('fresh noninteractive commands explain one-time initialization without consuming the code', async t => {
  const f = await fixture(t);
  await assert.rejects(runDatasphereCommand(['objects', 'views', 'list', '--host', host, '--passcode-stdin'], { ...f.options, input: Readable.from(['private-code\n']) }), /catalog needs one-time initialization/);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(f.output.text() + f.errorOutput.text(), /private-code/);
});

test('cancelling after catalog initialization keeps only metadata and the next command needs one code', async t => {
  const f = await fixture(t, [{ stdout: `${codeUrl}\n` }, {}, { stdout: '[]\n' }]);
  let prompts = 0;
  await assert.rejects(runDatasphereCommand(['objects', 'views', 'list', '--host', host], {
    ...f.options,
    prompt: async () => { if (++prompts === 2) throw new Error('Prompt interrupted'); return 'initialization-code'; }
  }), /Prompt interrupted/);
  assert.equal(existsSync(f.calls[0].options.env.HOME), false);
  const result = await runDatasphereCommand(['objects', 'views', 'list', '--passcode-stdin'], { ...f.options, input: Readable.from(['new-command-code\n']) });
  assert.equal(result, 0);
  assert.equal(f.calls.length, 3, 'the next invocation executes directly without reinitializing');
  assert.equal(f.calls.at(-1).record.passcode, 'new-command-code');
});

test('help and version bypass BAS discovery and all sign-in prompts in the real launcher', async () => {
  const exec = promisify(execFile);
  const help = await exec(process.execPath, [launcher, '--datasphere', '--help'], { env: { ...process.env, H2O_URL: 'http://127.0.0.1:1' } });
  assert.match(help.stdout, /Usage: sap-ai-dev --datasphere/);
  assert.match(help.stdout, /--passcode-stdin/);
  assert.doesNotMatch(help.stdout, /--list-destinations/);
  const version = await exec(process.execPath, [launcher, '--datasphere', '--version']);
  assert.match(version.stdout, /^\d{4}\.\d+\.\d+/m);
});

test('a real terminal completes browser-code login with hidden input and keeps relative file output', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const harness = fileURLToPath(new URL('./fixtures/datasphere-command-harness.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawnWithPty(`${JSON.stringify(process.execPath)} ${JSON.stringify(harness)} objects views list --space AI_SPACE --output result.json`, { env: { ...process.env, ...f.env }, cwd: f.home, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let hostSent = false;
    let initCodeSent = false;
    let codeSent = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const answer = chunk => {
      stdout += chunk.toString();
      if (!hostSent && stdout.includes('Datasphere tenant URL')) {
        hostSent = true;
        child.stdin.write(`${host}\r`);
      }
      if (!initCodeSent && stdout.includes('Temporary authentication code (input is hidden)')) {
        initCodeSent = true;
        child.stdin.write('fixture-init-code\r');
      }
      if (!codeSent && stdout.includes('Catalog initialized. A fresh browser code') && chunk.toString().includes('Temporary authentication code (input is hidden)')) {
        codeSent = true;
        child.stdin.write('fixture-code_A-1\r');
      }
    };
    child.stdout.on('data', answer);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); answer(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr, hostSent, initCodeSent, codeSent }); });
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.hostSent, true);
  assert.equal(result.initCodeSent, true);
  assert.equal(result.codeSent, true);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-code_A-1|fixture-init-code/);
  const output = JSON.parse(await readFile(join(f.home, 'result.json'), 'utf8'));
  assert.deepEqual(output.rows, [{ technicalName: 'V1' }]);
  if (process.platform !== 'win32') assert.equal(output.mode, 0o600);
  assert.equal(existsSync(output.optionsPath), false);
});
