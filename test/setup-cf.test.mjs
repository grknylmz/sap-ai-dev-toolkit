import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatedServerName, installMcpConfig } from '../src/mcp-config.mjs';
import { destinationTable } from '../scripts/postinstall.mjs';
import { spawnWithPty } from './pty.mjs';
import { pathEntry, writeFakeCli } from './fake-bin.mjs';

const setupModule = pathToFileURL(fileURLToPath(new URL('../src/setup.mjs', import.meta.url))).href;

function cloudFoundryDestination({ name, serverName, instanceGuid, instanceName, keyName }) {
  return {
    source: 'cloud-foundry',
    name,
    serverName,
    client: '100',
    authentication: 'Basic',
    proxyType: 'Internet',
    probe: { status: 'available', available: true, httpStatus: 401 },
    cf: {
      spaceGuid: 'space-one',
      destinationInstanceGuid: instanceGuid,
      destinationInstanceName: instanceName,
      destinationKeyName: keyName
    }
  };
}

function cloudFoundryOnPremiseDestination() {
  const destination = cloudFoundryDestination({
    name: 'shared-name',
    serverName: 'cf:space-one:cf-destination:shared-name',
    instanceGuid: 'cf-destination',
    instanceName: 'destination-service',
    keyName: 'destination-key'
  });
  destination.authentication = 'BasicAuthentication';
  destination.proxyType = 'OnPremise';
  destination.cf.connectivityInstanceGuid = 'cf-connectivity';
  destination.cf.connectivityInstanceName = 'connectivity-service';
  destination.cf.connectivityKeyName = 'connectivity-key';
  return destination;
}

async function makeFixture(t, { version = 'cf version 8.18.0', space = 'space-one', deleteMode = 'success' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bas-cf-setup-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const configPath = join(directory, 'mcp.json');
  const callLog = join(directory, 'cf-calls.jsonl');
  const discoveryLog = join(directory, 'cf-discovery.json');
  const env = {
    ...process.env,
    HOME: directory,
    PATH: pathEntry(bin),
    H2O_URL: 'http://h2o.example',
    SAP_AI_DEV_TOOLKIT_MCP_CONFIG: configPath,
    CF_CALL_LOG: callLog,
    CF_DISCOVERY_LOG: discoveryLog,
    TEST_CF_VERSION: version,
    TEST_CF_SPACE: space,
    TEST_CF_DELETE_MODE: deleteMode,
    TEST_INSTALL_FAIL: 'false',
    TEST_BAS_DESTINATIONS: JSON.stringify([]),
    TEST_CF_RESULT: JSON.stringify({ destinations: [], createdKeys: [], warnings: [] }),
    TEST_ONPREM_CSRF_RESULT: JSON.stringify({ httpStatus: 200, tokenReceived: true, cookieCount: 1 })
  };
  await writeFakeCli(bin, 'cf', `
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.CF_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'version') process.stdout.write(process.env.TEST_CF_VERSION + '\\n');
else if (args[0] === 'target') {
  process.stdout.write(process.env.TEST_CF_SPACE === 'not-targeted' ? 'space: <none>\\n' : 'space: ' + process.env.TEST_CF_SPACE + '\\n');
} else if (args[0] === 'space' && args.at(-1) === '--guid') {
  if (process.env.TEST_CF_SPACE === 'not-targeted') { process.stderr.write('No targeted space\\n'); process.exitCode = 1; }
  else process.stdout.write(process.env.TEST_CF_SPACE + '\\n');
} else if (args[0] === 'delete-service-key' && process.env.TEST_CF_DELETE_MODE === 'missing') {
  process.stderr.write('Service key not found\\n');
  process.exitCode = 1;
} else if (args[0] === 'delete-service-key') process.stdout.write('deleted\\n');
else process.exitCode = 1;
`, env);
  const harness = join(directory, 'setup-runner.mjs');
  await writeFile(harness, `import { writeFile } from 'node:fs/promises';
import { runSetup } from ${JSON.stringify(setupModule)};
await runSetup({
  env: process.env,
  discover: async () => JSON.parse(process.env.TEST_BAS_DESTINATIONS),
  discoverCf: async ({ spaceGuid, managedKeys }) => {
    await writeFile(process.env.CF_DISCOVERY_LOG, JSON.stringify({ spaceGuid, managedKeys }));
    return JSON.parse(process.env.TEST_CF_RESULT);
  },
  verifyOnPremCredentialRoute: async () => JSON.parse(process.env.TEST_ONPREM_CSRF_RESULT),
  ...(process.env.TEST_INSTALL_FAIL === 'true' ? {
    install: async () => { throw new Error('simulated config write failure'); }
  } : {})
});
`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, configPath, callLog, discoveryLog, harness, env };
}

function runSetupInPty(fixture, { importAnswer = 'y\r', selection = ' \r', selectionSequence = null, promptAnswers = [] } = {}) {
  return new Promise((resolve, reject) => {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture.harness)}`;
    const child = spawnWithPty(command, { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let importSent = false;
    let selectionSent = false;
    let selectionStepIndex = 0;
    let promptAnswerIndex = 0;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const send = (chunk, done = false) => {
      // A short delay lets the target prompt finish rendering before the keys
      // arrive; ConPTY re-renders in chunks and an immediate write can land
      // before the field is listening.
      setTimeout(() => {
        if (done) child.stdin.end(chunk);
        else child.stdin.write(chunk);
      }, 400);
    };
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!importSent && stdout.includes("Include destinations from the current CF space's Destination service?")) {
        importSent = true;
        send(importAnswer);
      }
      if (selectionSequence?.length) {
        // Multi-key selection: send each key only after its confirmation text
        // (e.g. the checked row) actually rendered. ConPTY re-emits screen
        // state rather than raw bytes, so an erased render cannot be matched
        // after the fact the way a raw Unix pty stream allows.
        const step = selectionSequence[selectionStepIndex];
        if (step && stdout.includes(step.when)) {
          selectionStepIndex += 1;
          const finished = selectionStepIndex === selectionSequence.length;
          selectionSent = selectionSent || finished;
          send(step.input, finished && !promptAnswers.length);
        }
      } else if (!selectionSent && stdout.includes('Select destinations')) {
        selectionSent = true;
        send(selection, !promptAnswers.length);
      }
      if (selectionSent && promptAnswerIndex < promptAnswers.length) {
        const answer = promptAnswers[promptAnswerIndex];
        if (stdout.includes(answer.when)) {
          promptAnswerIndex++;
          send(answer.value, promptAnswerIndex === promptAnswers.length);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, importSent, selectionSent, promptAnswersSent: promptAnswerIndex });
    });
  });
}

test('imports selected CF destinations, passes managed key references, and removes only orphaned keys', async t => {
  const fixture = await makeFixture(t);
  const previous = cloudFoundryDestination({
    name: 'old-destination', serverName: 'cf:space-one:old-instance:old-destination',
    instanceGuid: 'old-instance', instanceName: 'old-destination-service', keyName: 'old-key'
  });
  await installMcpConfig([previous], { env: fixture.env, path: fixture.configPath });
  const created = {
    kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'new-instance',
    instanceName: 'new-destination-service', keyName: 'new-key'
  };
  fixture.env.TEST_CF_RESULT = JSON.stringify({
    destinations: [cloudFoundryDestination({
      name: 'new-destination', serverName: 'cf:space-one:new-instance:new-destination',
      instanceGuid: 'new-instance', instanceName: 'new-destination-service', keyName: 'new-key'
    })],
    createdKeys: [created],
    warnings: []
  });

  const result = await runSetupInPty(fixture, {
    // Confirm only after the checked row rendered: on Windows, ConPTY erases
    // the checkbox render on confirm, so a post-hoc /✓/ match would look at
    // screen state that no longer exists in the output stream.
    selectionSequence: [
      { when: 'Select destinations', input: ' ' },
      { when: '✓', input: '\r' }
    ]
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.importSent, true, result.stdout);
  assert.equal(result.selectionSent, true, result.stdout);
  assert.match(result.stdout, /✗/, 'unselected destinations use a red X');
  assert.match(result.stdout, /✓/, 'selected destinations use a green checkmark');
  assert.doesNotMatch(result.stdout, /override SAP credentials|SAP user|SAP password/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SECRET|clientSecret|Password/);

  const snapshot = JSON.parse(await readFile(fixture.discoveryLog, 'utf8'));
  assert.equal(snapshot.spaceGuid, 'space-one');
  assert.deepEqual(snapshot.managedKeys, [{
    kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'old-instance',
    instanceName: 'old-destination-service', keyName: 'old-key'
  }]);
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  assert.deepEqual(Object.keys(config.servers), ['cf-space-one-new-instance-new-destination']);
  assert.equal(config.servers['cf-space-one-new-instance-new-destination'].env.BAS_CF_DESTINATION_KEY, 'new-key');
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => args[0] === 'delete-service-key'), [[
    'delete-service-key', '-f', '--wait', 'old-destination-service', 'old-key'
  ]]);
  assert.equal(calls.some(args => args.at(-1) === 'new-key'), false);
});


test('declining CF import keeps BAS setup and does not create CF keys', async t => {
  const fixture = await makeFixture(t);
  fixture.env.TEST_BAS_DESTINATIONS = JSON.stringify([{
    name: 'bas-system', url: 'https://bas.example', client: '100', authentication: 'Basic',
    probe: { status: 'available', available: true }
  }]);
  fixture.env.TEST_CF_RESULT = JSON.stringify({
    destinations: [], createdKeys: [{ kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'unused', instanceName: 'unused', keyName: 'unused' }], warnings: []
  });

  const result = await runSetupInPty(fixture, { importAnswer: 'n\r' });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.importSent, true, result.stdout);
  assert.equal(result.selectionSent, true, result.stdout);
  assert.match(result.stdout, /import was not confirmed/);
  assert.doesNotMatch(result.stdout, /Select Destination service instances/);
  assert.equal(await readFile(fixture.discoveryLog, 'utf8').then(() => true, () => false), false);
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  assert.deepEqual(Object.keys(config.servers), ['bas-system']);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.some(args => args[0] === 'delete-service-key'), false);
});

test('old CF keys are preserved when the CLI targets a different space', async t => {
  const fixture = await makeFixture(t, { space: 'space-two' });
  const previous = cloudFoundryDestination({
    name: 'old-destination', serverName: 'cf:space-one:old-instance:old-destination',
    instanceGuid: 'old-instance', instanceName: 'old-destination-service', keyName: 'old-key'
  });
  await installMcpConfig([previous], { env: fixture.env, path: fixture.configPath });
  fixture.env.TEST_BAS_DESTINATIONS = JSON.stringify([{
    name: 'bas-system', url: 'https://bas.example', client: '100', authentication: 'Basic', probe: { status: 'available' }
  }]);

  const result = await runSetupInPty(fixture, { importAnswer: 'n\r' });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /requires targeting CF space space-one; it was left untouched/);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.some(args => args[0] === 'delete-service-key'), false);
});

test('old CF CLI version skips import before prompting', async t => {
  const fixture = await makeFixture(t, { version: 'cf version 8.17.0' });
  fixture.env.TEST_BAS_DESTINATIONS = JSON.stringify([{
    name: 'bas-system', url: 'https://bas.example', client: '100', authentication: 'Basic', probe: { status: 'available' }
  }]);

  const result = await runSetupInPty(fixture);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.importSent, false, result.stdout);
  assert.match(result.stdout, /Cloud Foundry CLI 8\.18 or newer is required/);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[0]), ['version']);
});

test('untargeted CF CLI skips the import prompt', async t => {
  const fixture = await makeFixture(t, { space: 'not-targeted' });
  fixture.env.TEST_BAS_DESTINATIONS = JSON.stringify([{
    name: 'bas-system', url: 'https://bas.example', client: '100', authentication: 'Basic', probe: { status: 'available' }
  }]);

  const result = await runSetupInPty(fixture);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.importSent, false, result.stdout);
  assert.match(result.stdout, /not authenticated to a targeted space/);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[0]), ['version', 'target']);
  await assert.rejects(readFile(fixture.discoveryLog, 'utf8'), { code: 'ENOENT' });
});

test('missing service keys are treated as removed without exposing CLI stderr', async t => {
  const fixture = await makeFixture(t, { deleteMode: 'missing' });
  const previous = cloudFoundryDestination({
    name: 'old-destination', serverName: 'cf:space-one:old-instance:old-destination',
    instanceGuid: 'old-instance', instanceName: 'old-destination-service', keyName: 'old-key'
  });
  await installMcpConfig([previous], { env: fixture.env, path: fixture.configPath });
  fixture.env.TEST_BAS_DESTINATIONS = JSON.stringify([{
    name: 'bas-system', url: 'https://bas.example', client: '100', authentication: 'Basic', probe: { status: 'available' }
  }]);

  const result = await runSetupInPty(fixture, { importAnswer: 'n\r' });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Service key not found/);
  assert.doesNotMatch(result.stdout, /Could not delete managed destination service key/);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => args[0] === 'delete-service-key'), [[
    'delete-service-key', '-f', '--wait', 'old-destination-service', 'old-key'
  ]]);
});

test('no selectable records leave MCP config unchanged and remove only new keys', async t => {
  const fixture = await makeFixture(t);
  const previous = cloudFoundryDestination({
    name: 'old-destination', serverName: 'cf:space-one:old-instance:old-destination',
    instanceGuid: 'old-instance', instanceName: 'old-destination-service', keyName: 'old-key'
  });
  await installMcpConfig([previous], { env: fixture.env, path: fixture.configPath });
  const created = {
    kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'new-instance',
    instanceName: 'new-destination-service', keyName: 'new-key'
  };
  fixture.env.TEST_CF_RESULT = JSON.stringify({
    destinations: [], createdKeys: [created], warnings: ['No Destination service instance exists in the current CF space; CF import was skipped.']
  });

  const result = await runSetupInPty(fixture);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.selectionSent, false, result.stdout);
  assert.match(result.stdout, /No Destination service instance exists/);
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  assert.deepEqual(Object.keys(config.servers), [generatedServerName(previous.serverName)]);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => args[0] === 'delete-service-key'), [[
    'delete-service-key', '-f', '--wait', 'new-destination-service', 'new-key'
  ]]);
});

test('failed config writes remove only unreferenced keys created by that attempt', async t => {
  const fixture = await makeFixture(t);
  const previous = cloudFoundryDestination({
    name: 'old-destination', serverName: 'cf:space-one:old-instance:old-destination',
    instanceGuid: 'old-instance', instanceName: 'old-destination-service', keyName: 'old-key'
  });
  await installMcpConfig([previous], { env: fixture.env, path: fixture.configPath });
  const created = {
    kind: 'destination', spaceGuid: 'space-one', instanceGuid: 'new-instance',
    instanceName: 'new-destination-service', keyName: 'new-key'
  };
  fixture.env.TEST_CF_RESULT = JSON.stringify({
    destinations: [cloudFoundryDestination({
      name: 'new-destination', serverName: 'cf:space-one:new-instance:new-destination',
      instanceGuid: 'new-instance', instanceName: 'new-destination-service', keyName: 'new-key'
    })],
    createdKeys: [created],
    warnings: []
  });
  fixture.env.TEST_INSTALL_FAIL = 'true';

  const result = await runSetupInPty(fixture);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /MCP config writing failed: simulated config write failure/);
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  assert.deepEqual(Object.keys(config.servers), [generatedServerName(previous.serverName)]);
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => args[0] === 'delete-service-key'), [[
    'delete-service-key', '-f', '--wait', 'new-destination-service', 'new-key'
  ]]);
});

test('preserves old CF keys referenced by an unrelated remaining MCP entry', async t => {
  const fixture = await makeFixture(t);
  const previous = cloudFoundryDestination({
    name: 'old-destination', serverName: 'cf:space-one:old-instance:old-destination',
    instanceGuid: 'old-instance', instanceName: 'old-destination-service', keyName: 'old-key'
  });
  await installMcpConfig([previous], { env: fixture.env, path: fixture.configPath });
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  config.servers.customServer = {
    command: 'custom-launcher',
    env: { ...config.servers[generatedServerName(previous.serverName)].env, SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: undefined }
  };
  await writeFile(fixture.configPath, JSON.stringify(config));
  fixture.env.TEST_BAS_DESTINATIONS = JSON.stringify([{
    name: 'bas-system', url: 'https://bas.example', client: '100', authentication: 'Basic', probe: { status: 'available' }
  }]);

  const result = await runSetupInPty(fixture, { importAnswer: 'n\r' });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const written = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  assert.equal(written.servers.customServer.env.BAS_CF_DESTINATION_KEY, 'old-key');
  const calls = (await readFile(fixture.callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.some(args => args[0] === 'delete-service-key'), false);
});

test('setup report labels CF source and matches registration by generated server name without leaking diagnostics', () => {
  const report = destinationTable([{
    source: 'cloud-foundry',
    name: 'friendly-destination',
    serverName: 'cf:space-one:destination-instance:friendly-destination',
    client: '100',
    authentication: 'Basic',
    cf: { destinationInstanceName: 'destination-service' },
    probe: {
      status: 'network-error',
      available: false,
      error: 'https://user:secret@backend.example/path token=SECRET'
    }
  }], new Set(['cf-space-one-destination-instance-friendly-destination']));
  const row = report.split('\n').find(line => line.includes('friendly-destination'));
  assert.match(report, /Destination.*Source/);
  assert.match(row, /CF destination-service/);
  assert.match(row, /REGISTERED/);
  assert.doesNotMatch(row, /NOT REGISTERED/);
  assert.equal(report.includes('https://'), false);
  assert.doesNotMatch(report, /user:secret|SECRET/);
});
