import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createDatasphereCli } from '../src/datasphere-cli.mjs';

const require = createRequire(import.meta.url);
const entry = require.resolve('@sap/datasphere-cli/package.json').replace(/package\.json$/, 'terminal.js');

function recordingExec(lines) {
  const calls = [];
  const execFileImpl = (file, argv, options, callback) => {
    calls.push({ file, argv, options });
    const script = lines.shift() ?? { stdout: '{}' };
    setImmediate(() => callback(script.error ?? null, script.stdout ?? '', script.stderr ?? ''));
    return { stdin: { end() {} } };
  };
  return { calls, execFileImpl };
}

const config = {
  auth: 'technical',
  url: 'https://tenant.example',
  tokenUrl: 'https://tenant.example/oauth/token',
  clientId: 'sb-cli!t1',
  clientSecret: 'never-echo-this',
  refreshToken: null,
  sql: null,
  source: 'environment'
};

test('init runs once, then commands reuse it; argv carries host and secrets-file after the words', async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: '{}' }, { stdout: '[]' }]);
  const cli = createDatasphereCli({ config, secrets: async () => ({ client_id: 'sb-cli!t1' }), execFileImpl });
  await cli.init();
  await cli.run(['objects', 'views', 'list'], { space: 'SALES' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].argv, [entry, 'config', 'cache', 'init', '--host', config.url, '--secrets-file', `${cli.stateDir()}/secrets.json`]);
  assert.deepEqual(calls[1].argv, [entry, 'objects', 'views', 'list', '--space', 'SALES', '--host', config.url, '--secrets-file', `${cli.stateDir()}/secrets.json`]);
  assert.equal(calls[0].file, process.execPath);
  await cli.close();
});

test('the child environment is an allowlist and HOME/USERPROFILE point at the state dir', async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: '[]' }]);
  const cli = createDatasphereCli({
    config,
    secrets: async () => ({}),
    execFileImpl,
    env: { PATH: '/bin', HOME: '/real/home', HOST: 'evil.example', CLIENT_ID: 'evil', DATASPHERE_URL: 'https://evil.example', TMPDIR: '/tmp', LANG: 'C' }
  });
  await cli.run(['spaces', 'list']);
  const env = calls[0].options.env;
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USERPROFILE']);
  assert.equal(env.HOME, cli.stateDir());
  assert.equal(env.USERPROFILE, cli.stateDir());
  assert.equal(calls[0].options.cwd, cli.stateDir());
  assert.equal(calls[0].options.timeout, 180_000);
  assert.equal(calls[0].options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(calls[0].options.windowsHide, true);
  await cli.close();
});

test('secrets are rewritten before each process with mode 0600', { skip: process.platform === 'win32' }, async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: '[]' }, { stdout: '[]' }]);
  let flip = false;
  const cli = createDatasphereCli({
    config,
    secrets: async () => {
      flip = !flip;
      return flip
        ? { client_id: 'a', client_secret: 'one', token_url: 't', authorization_flow: 'client_credentials', host: config.url, tenantUrl: config.url }
        : { client_id: 'b', client_secret: 'two', token_url: 't', authorization_flow: 'client_credentials', host: config.url, tenantUrl: config.url };
    },
    execFileImpl
  });
  await cli.run(['spaces', 'list']);
  await cli.run(['spaces', 'users', 'list']);
  const first = JSON.parse(await readFile(`${cli.stateDir()}/secrets.json`, 'utf8'));
  assert.equal(first.client_secret, 'two');
  const { mode } = await import('node:fs').then(fs => fs.statSync(`${cli.stateDir()}/secrets.json`));
  assert.equal(mode & 0o777, 0o600);
  assert.equal(calls.length, 2);
  await cli.close();
});

test('interactive secrets carry access_token and integer expires_after', async () => {
  const { execFileImpl } = recordingExec([{ stdout: '[]' }]);
  const interactiveConfig = { ...config, auth: 'interactive', refreshToken: 'r0' };
  const cli = createDatasphereCli({
    config: interactiveConfig,
    secrets: async () => ({ client_id: 'c', client_secret: 's', token_url: 't', authorization_url: 'a', access_token: 'AT', refresh_token: 'RT', expires_after: 123, authorization_flow: 'authorization_code', host: config.url, tenantUrl: config.url }),
    execFileImpl
  });
  await cli.run(['spaces', 'list']);
  const stored = JSON.parse(await readFile(`${cli.stateDir()}/secrets.json`, 'utf8'));
  assert.equal(stored.authorization_flow, 'authorization_code');
  assert.equal(stored.access_token, 'AT');
  assert.ok(Number.isInteger(stored.expires_after));
  await cli.close();
});

test('option values containing spaces stay one argv element', async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: '[]' }]);
  const cli = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl });
  await cli.run(['spaces', 'users', 'add'], { 'user-email': 'a b@example.com' });
  assert.ok(calls[0].argv.includes('a b@example.com'));
  await cli.close();
});

test('failing exits scrub the client secret and surface an IntegrationError', async () => {
  const { execFileImpl } = recordingExec([{ error: Object.assign(new Error('failed'), { killed: false }), stderr: `login failed for ${config.clientSecret}` }]);
  const cli = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl });
  await assert.rejects(() => cli.run(['users', 'list']), error => {
    assert.equal(error.name, 'IntegrationError');
    assert.match(error.message, /Datasphere CLI "users list" failed/);
    assert.ok(error.message.includes('[redacted]'), error.message);
    assert.doesNotMatch(error.message, /never-echo-this/);
    return true;
  });
  await cli.close();
});

test('input becomes a --file-path JSON file that is deleted afterwards', async () => {
  let inputPath = null;
  let inputContent = null;
  const calls = [];
  const execFileImpl = (file, argv, options, callback) => {
    calls.push({ file, argv, options });
    const index = argv.indexOf('--file-path');
    if (index >= 0) {
      inputPath = argv[index + 1];
      inputContent = readFileSync(inputPath, 'utf8');
    }
    setImmediate(() => callback(null, '{}', ''));
    return { stdin: { end() {} } };
  };
  const cli = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl });
  await cli.run(['objects', 'views', 'create'], { space: 'SALES' }, { input: { definitions: { V1: { kind: 'entity' } } } });
  assert.ok(inputPath, '--file-path present');
  assert.deepEqual(JSON.parse(inputContent), { definitions: { V1: { kind: 'entity' } } });
  assert.equal(existsSync(inputPath), false, 'input file deleted after the call');
  assert.equal(calls[0].argv.includes('--input'), false, '--input is never used');
  await cli.close();
});

test('init falls back to login with the authorization flow and memoizes the failure', async () => {
  const { calls, execFileImpl } = recordingExec([
    { error: new Error('cache init failed') },
    { stdout: 'logged in' },
    { stdout: 'ok' }
  ]);
  const cli = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl });
  await cli.init();
  assert.equal(calls[1].argv[1], 'login');
  assert.equal(calls[1].argv.includes('--authorization-flow'), true);
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--authorization-flow') + 1], 'client_credentials');
  await cli.init();
  assert.equal(calls.length, 2, 'init is memoized after success');
  await cli.close();

  const failing = recordingExec([
    { error: new Error('cache init failed') },
    { error: new Error('login failed') }
  ]);
  const cli2 = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl: failing.execFileImpl });
  await assert.rejects(() => cli2.init(), /login failed/);
  await assert.rejects(() => cli2.init(), /login failed/);
  assert.equal(failing.calls.length, 2, 'the failed init is not retried');
  await cli2.close();
});

test('close removes the state directory', async () => {
  const { execFileImpl } = recordingExec([{ stdout: '[]' }]);
  const cli = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl });
  await cli.run(['spaces', 'list']);
  const dir = cli.stateDir();
  assert.equal(existsSync(dir), true);
  await cli.close();
  assert.equal(existsSync(dir), false);
});

test('version returns the trimmed CLI version', async () => {
  const { execFileImpl } = recordingExec([{ stdout: '2026.22.0\n' }]);
  const cli = createDatasphereCli({ config, secrets: async () => ({}), execFileImpl });
  assert.equal(await cli.version(), '2026.22.0');
  await cli.close();
});
