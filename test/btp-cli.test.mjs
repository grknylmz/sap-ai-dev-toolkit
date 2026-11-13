import test from 'node:test';
import assert from 'node:assert/strict';
import { createBtpCli, resolveBtpCliSettings } from '../src/btp-cli.mjs';

const SA = '11111111-2222-3333-4444-555555555555';

function recordingExec(lines) {
  const calls = [];
  const execFileImpl = (file, argv, options, callback) => {
    const call = { file, argv, options, done: false };
    calls.push(call);
    const script = lines.shift() ?? { stdout: '{}' };
    const finish = () => {
      call.done = true;
      callback(script.error ?? null, script.stdout ?? '', script.stderr ?? '');
    };
    if (script.delay) setTimeout(finish, script.delay);
    else setImmediate(finish);
    return { stdin: { end() {} } };
  };
  return { calls, execFileImpl };
}

const failure = () => Object.assign(new Error('Command failed'), { code: 1 });

test('json puts --format json first and flattens flags in insertion order', async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: '[]' }]);
  const cli = createBtpCli({ cli: '/opt/btp', env: {}, execFileImpl });
  assert.deepEqual(await cli.json(['list', 'services/instance'], { subaccount: SA, 'fields-filter': undefined, 'show-parameters': true }), []);
  assert.equal(calls[0].file, '/opt/btp');
  assert.deepEqual(calls[0].argv, ['--format', 'json', 'list', 'services/instance', '--subaccount', SA, '--show-parameters']);
});

test('an expired session maps to BTP_LOGIN_REQUIRED', async () => {
  const { execFileImpl } = recordingExec([{ error: failure(), stderr: 'Authorization failed\n\nUnknown session. Please log in.\n\n✗ ERROR' }]);
  const cli = createBtpCli({ cli: 'btp', env: {}, execFileImpl });
  await assert.rejects(cli.json(['get', 'accounts/global-account']), error => {
    assert.equal(error.name, 'IntegrationError');
    assert.equal(error.code, 'BTP_LOGIN_REQUIRED');
    assert.match(error.message, /btp login --sso/);
    return true;
  });
});

test('a missing executable points at the installer and setup', async () => {
  const { execFileImpl } = recordingExec([{ error: Object.assign(new Error('spawn btp ENOENT'), { code: 'ENOENT' }) }]);
  const cli = createBtpCli({ cli: 'btp', env: {}, execFileImpl });
  await assert.rejects(cli.json(['get', 'accounts/global-account']), error => {
    assert.match(error.message, /btp CLI not found/);
    assert.match(error.message, /sap-ai-dev --setup-btp/);
    assert.equal(error.code, 'BTP_CLI_MISSING');
    return true;
  });
});

test('generic failures keep the stderr text without the CLI error marker', async () => {
  const { execFileImpl } = recordingExec([{ error: failure(), stderr: 'Subaccount not found\n\n✗ ERROR' }]);
  const cli = createBtpCli({ cli: 'btp', env: {}, execFileImpl });
  await assert.rejects(cli.json(['get', 'services/binding'], { subaccount: SA }), {
    message: 'btp CLI "get services/binding" failed: Subaccount not found'
  });
});

test('JSON followed by an update notice still parses', async () => {
  const { execFileImpl } = recordingExec([{ stdout: '{"a":1}\nA new version of the btp CLI is available' }]);
  const cli = createBtpCli({ cli: 'btp', env: {}, execFileImpl });
  assert.deepEqual(await cli.json(['get', 'x']), { a: 1 });
});

test('calls are serialized', async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: '1', delay: 30 }, { stdout: '2' }]);
  const cli = createBtpCli({ cli: 'btp', env: {}, execFileImpl });
  const first = cli.json(['get', 'a']);
  const second = cli.json(['get', 'b']);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(calls.length, 2);
});

test('a configured client config file reaches the child environment', async () => {
  const { calls, execFileImpl } = recordingExec([{ stdout: 'SAP BTP command line interface (client v2.116.3)' }]);
  const cli = createBtpCli({ cli: 'btp', config: '/x/btp/config.json', env: { HOME: '/home/u' }, execFileImpl });
  assert.equal(await cli.version(), '2.116.3');
  assert.equal(calls[0].options.env.BTP_CLIENTCONFIG, '/x/btp/config.json');
  assert.equal(calls[0].options.env.HOME, '/home/u');
  assert.deepEqual(calls[0].argv, ['--version']);
});

test('resolveBtpCliSettings: environment beats stored beats PATH', () => {
  assert.deepEqual(
    { ...resolveBtpCliSettings({ BTP_CLI: ' /env/btp ' }, { stored: { cli: '/stored/btp' } }) },
    { cli: '/env/btp', cliSource: 'environment', config: null }
  );
  assert.deepEqual(
    { ...resolveBtpCliSettings({}, { stored: { cli: '/stored/btp', config: '/c.json' } }) },
    { cli: '/stored/btp', cliSource: 'stored', config: '/c.json' }
  );
  assert.deepEqual(
    { ...resolveBtpCliSettings({ BTP_CLIENTCONFIG: '/env.json' }, { stored: {} }) },
    { cli: 'btp', cliSource: 'PATH', config: '/env.json' }
  );
});
