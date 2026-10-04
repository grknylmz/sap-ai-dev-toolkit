import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathEntry, writeFakeCli } from './fake-bin.mjs';

const launcher = fileURLToPath(new URL('../src/launcher.mjs', import.meta.url));
const fakeVsp = fileURLToPath(new URL('./fixtures/fake-vsp.mjs', import.meta.url));
const SPACE_GUID = 'runtime-space-guid';
const INSTANCE_GUID = 'runtime-destination-guid';
const INSTANCE_NAME = 'runtime-destination-service';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function runLauncher(env, args = [], messages = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (messages.length) child.stdin.end(`${messages.map(message => JSON.stringify(message)).join('\n')}\n`);
    else child.stdin.end();
  });
}

async function fakeCfExecutable(directory, origin, callLog, { connectivityProxyPort = 0, connectivityTokenUrl = `${origin}/connectivity/oauth/token` } = {}) {
  const cfEnv = {
    PATH: pathEntry(directory),
    CF_TEST_ORIGIN: origin,
    CF_TEST_SPACE_GUID: SPACE_GUID,
    CF_TEST_INSTANCE_GUID: INSTANCE_GUID,
    CF_TEST_INSTANCE_NAME: INSTANCE_NAME,
    CF_TEST_CONNECTIVITY_GUID: 'runtime-connectivity-guid',
    CF_TEST_CONNECTIVITY_NAME: 'runtime-connectivity-service',
    CF_TEST_CONNECTIVITY_PROXY_PORT: String(connectivityProxyPort),
    CF_TEST_CONNECTIVITY_TOKEN_URL: connectivityTokenUrl,
    CF_CALL_LOG: callLog
  };
  await writeFakeCli(directory, 'cf', `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.CF_CALL_LOG) fs.appendFileSync(process.env.CF_CALL_LOG, JSON.stringify(args) + '\\n');
const origin = process.env.CF_TEST_ORIGIN;
const spaceGuid = process.env.CF_TEST_SPACE_GUID;
const instanceGuid = process.env.CF_TEST_INSTANCE_GUID;
const instanceName = process.env.CF_TEST_INSTANCE_NAME;
const connectivityGuid = process.env.CF_TEST_CONNECTIVITY_GUID;
const connectivityName = process.env.CF_TEST_CONNECTIVITY_NAME;
if (args[0] === 'version') process.stdout.write('cf version 8.18.0+test\\n');
else if (args[0] === 'target') process.stdout.write('space: MASS\\n');
else if (args[0] === 'space' && args[1] === 'MASS' && args[2] === '--guid') process.stdout.write(spaceGuid + '\\n');
else if (args[0] === 'oauth-token') process.stdout.write('bearer current-cf-user-jwt\\n');
else if (args[0] === 'curl' && args[1].startsWith('/v3/service_instances/')) {
  const guid = args[1].split('/').at(-1);
  const name = guid === connectivityGuid ? connectivityName : instanceName;
  process.stdout.write(JSON.stringify({ guid, name, relationships: { space: { data: { guid: spaceGuid } } } }));
}
else if (args[0] === 'service-key' && args[1] === '--json' && args[2] === connectivityName) {
  process.stdout.write(JSON.stringify({ credentials: {
    onpremise_proxy_host: '127.0.0.1',
    onpremise_proxy_http_port: Number(process.env.CF_TEST_CONNECTIVITY_PROXY_PORT),
    token_service_url: process.env.CF_TEST_CONNECTIVITY_TOKEN_URL,
    clientid: 'connectivity-client',
    clientsecret: 'connectivity-key-secret'
  } }));
}
else if (args[0] === 'service-key' && args[1] === '--json') process.stdout.write(JSON.stringify({ credentials: { uri: origin, url: origin + '/uaa', clientid: 'destination-client', clientsecret: 'destination-key-secret' } }));
else process.exitCode = 2;
`, cfEnv);
  return cfEnv;
}

function destinationServiceServer({ destinationName = 'cf-basic', client = '321' } = {}) {
  const observed = { token: [], list: [] };
  const server = createServer((request, response) => {
    if (request.url === '/uaa/oauth/token') {
      observed.token.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'destination-api-token', expires_in: 300 }));
      return;
    }
    if (request.url === '/destination-configuration/v1/instanceDestinations') {
      observed.list.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{
        Name: destinationName,
        Type: 'HTTP',
        URL: 'https://sap.example:443',
        Authentication: 'BasicAuthentication',
        ProxyType: 'Internet',
        Properties: [
          { Key: 'sap-client', Value: client },
          { Key: 'User', Value: 'destination-user' },
          { Key: 'Password', Value: 'destination-sap-password' }
        ]
      }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return { server, observed };
}

test('launches a CF Basic destination with per-child credentials and no proxy-auth argument', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-cf-runtime-'));
  const api = destinationServiceServer();
  const origin = await listen(api.server);
  const callLog = join(directory, 'cf-calls.jsonl');
  const cfEnv = await fakeCfExecutable(directory, origin, callLog);
  const childLog = join(directory, 'vsp-children.jsonl');
  t.after(async () => {
    await new Promise(resolve => api.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    ...cfEnv,
    SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
    SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'cloud-foundry',
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'cf-basic',
    BAS_CF_SPACE_GUID: SPACE_GUID,
    BAS_CF_DESTINATION_INSTANCE_GUID: INSTANCE_GUID,
    BAS_CF_DESTINATION_INSTANCE: INSTANCE_NAME,
    BAS_CF_DESTINATION_KEY: 'managed-destination-key',
    BAS_CF_DESTINATION_NAME: 'cf-basic',
    H2O_URL: 'http://retained-for-checks.example',
    SAP_USER: 'parent-user-secret',
    SAP_PASSWORD: 'parent-password-secret',
    Authorization: 'Bearer parent-token-secret',
    Cookie: 'parent-cookie-secret',
    FAKE_LOG: childLog,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost'
  };
  const result = await runLauncher(env, [], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const events = (await readFile(childLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const initialized = events.find(event => event.event === 'initialize');
  assert.ok(initialized);
  assert.equal(initialized.argv[initialized.argv.indexOf('--url') + 1], 'https://sap.example/');
  assert.equal(initialized.argv.includes('--proxy-auth'), false);
  assert.equal(JSON.stringify(initialized.argv).includes('destination-sap-password'), false);
  assert.equal(JSON.stringify(initialized.argv).includes('destination-user'), false);
  assert.deepEqual([initialized.env.user, initialized.env.password, initialized.env.verbose], [
    'destination-user', 'destination-sap-password', 'false'
  ]);
  assert.equal(initialized.env.authorization, undefined);
  assert.equal(initialized.env.cookie, undefined);
  for (const secret of [
    'destination-key-secret', 'destination-api-token', 'destination-sap-password', 'destination-user',
    'parent-user-secret', 'parent-password-secret', 'parent-token-secret', 'parent-cookie-secret'
  ]) {
    assert.equal(`${result.stdout}\\n${result.stderr}\\n${JSON.stringify(initialized.argv)}`.includes(secret), false, `${secret} must not appear in output or argv`);
  }
  assert.deepEqual(api.observed.token, [`Basic ${Buffer.from('destination-client:destination-key-secret').toString('base64')}`]);
  assert.deepEqual(api.observed.list, ['Bearer destination-api-token']);
  const cliCalls = (await readFile(callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(cliCalls.some(args => args[0] === 'service-key' && args.at(-1) === 'managed-destination-key'));
  assert.equal(JSON.stringify(cliCalls).includes('destination-key-secret'), false);
});
test('routes a PrincipalPropagation MCP call through CF Connectivity to the SAP target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-cf-principal-'));
  const observed = { destinationToken: [], destinationList: [], connectivityToken: [], proxy: [], target: [] };
  const target = createServer((request, response) => {
    observed.target.push({ path: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('SAP system information: user=cf-user-42');
  });
  const targetOrigin = await listen(target);
  const service = createServer(async (request, response) => {
    if (request.url === '/uaa/oauth/token') {
      observed.destinationToken.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'destination-api-token', expires_in: 300 }));
    } else if (request.url === '/destination-configuration/v1/instanceDestinations') {
      observed.destinationList.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{
        Name: 'pp-target',
        Type: 'HTTP',
        URL: targetOrigin,
        Authentication: 'PrincipalPropagation',
        ProxyType: 'OnPremise',
        Properties: [
          { Key: 'sap-client', Value: '100' },
          { Key: 'CloudConnectorLocationId', Value: 'scc-north' }
        ]
      }]));
    } else if (request.url === '/connectivity/oauth/token') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      observed.connectivityToken.push({
        authorization: request.headers.authorization,
        body: new URLSearchParams(Buffer.concat(chunks).toString())
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'user-exchange-token', expires_in: 300 }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const serviceOrigin = await listen(service);
  const connectivityProxy = createServer((request, response) => {
    observed.proxy.push({
      authorization: request.headers['proxy-authorization'],
      location: request.headers['sap-connectivity-scc-location_id'],
      path: request.url
    });
    if (request.headers['proxy-authorization'] !== 'Bearer user-exchange-token' || request.headers['sap-connectivity-scc-location_id'] !== 'scc-north') {
      response.writeHead(403);
      response.end('Connectivity authorization rejected');
      request.resume();
      return;
    }
    const targetUrl = new URL(request.url);
    const headers = { ...request.headers, host: targetUrl.host };
    delete headers['proxy-authorization'];
    delete headers['sap-connectivity-scc-location_id'];
    delete headers.connection;
    const upstream = httpRequest({
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port || 80),
      method: request.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    upstream.end();
    request.resume();
  });
  const connectivityProxyOrigin = await listen(connectivityProxy);
  const connectivityProxyPort = Number(new URL(connectivityProxyOrigin).port);
  const cfCalls = join(directory, 'cf-calls.jsonl');
  const cfEnv = await fakeCfExecutable(directory, serviceOrigin, cfCalls, {
    connectivityProxyPort,
    connectivityTokenUrl: `${serviceOrigin}/connectivity/oauth/token`
  });
  const childLog = join(directory, 'vsp-children.jsonl');
  t.after(async () => {
    await new Promise(resolve => service.close(resolve));
    await new Promise(resolve => target.close(resolve));
    await new Promise(resolve => connectivityProxy.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const result = await runLauncher({
    ...process.env,
    ...cfEnv,
    SAP_AI_DEV_TOOLKIT_BINARY: fakeVsp,
    SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'cloud-foundry',
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'pp-target',
    BAS_CF_SPACE_GUID: SPACE_GUID,
    BAS_CF_DESTINATION_INSTANCE_GUID: INSTANCE_GUID,
    BAS_CF_DESTINATION_INSTANCE: INSTANCE_NAME,
    BAS_CF_DESTINATION_KEY: 'managed-destination-key',
    BAS_CF_DESTINATION_NAME: 'pp-target',
    BAS_CF_CONNECTIVITY_INSTANCE_GUID: 'runtime-connectivity-guid',
    BAS_CF_CONNECTIVITY_INSTANCE: 'runtime-connectivity-service',
    BAS_CF_CONNECTIVITY_KEY: 'managed-connectivity-key',
    H2O_URL: 'http://retained-for-checks.example',
    SAP_USER: 'parent-user-secret',
    SAP_PASSWORD: 'parent-password-secret',
    FAKE_LOG: childLog,
    FAKE_CF_ADT_TEST: 'true',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost'
  }, [], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_system_info', arguments: {} } }
  ]);
  assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`);
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(responses.at(-1).result, `${result.stdout}\n${result.stderr}`);
  assert.match(responses.at(-1).result.content[0].text, /SAP system information: user=cf-user-42/);
  assert.deepEqual(observed.destinationToken, [`Basic ${Buffer.from('destination-client:destination-key-secret').toString('base64')}`]);
  assert.deepEqual(observed.destinationList, ['Bearer destination-api-token']);
  assert.equal(observed.connectivityToken.length, 1);
  assert.equal(observed.connectivityToken[0].authorization, `Basic ${Buffer.from('connectivity-client:connectivity-key-secret').toString('base64')}`);
  assert.deepEqual(Object.fromEntries(observed.connectivityToken[0].body), {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: 'current-cf-user-jwt',
    token_format: 'jwt',
    response_type: 'token'
  });
  assert.deepEqual(observed.proxy.map(request => [request.authorization, request.location]), [['Bearer user-exchange-token', 'scc-north']]);
  assert.deepEqual(observed.target, [{ path: '/sap/bc/adt/discovery', authorization: undefined }]);
  const events = (await readFile(childLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const initialized = events.find(event => event.event === 'initialize');
  assert.equal(initialized.argv.includes('--proxy-auth'), true);
  assert.equal(initialized.env.user, '');
  assert.equal(initialized.env.password, '');
  for (const secret of ['destination-key-secret', 'destination-api-token', 'connectivity-key-secret', 'user-exchange-token', 'current-cf-user-jwt', 'parent-user-secret', 'parent-password-secret']) {
    assert.equal(`${result.stdout}\\n${result.stderr}\\n${JSON.stringify(initialized.argv)}`.includes(secret), false, `${secret} must not appear in output or argv`);
  }
});


test('CF list-destinations clears the CF name filter and remains BAS-only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-cf-list-'));
  const callLog = join(directory, 'cf-calls.jsonl');
  const api = createServer((request, response) => {
    if (request.url === '/api/listDestinations') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ Name: 'bas-only', 'SAP-Client': '101' }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const origin = await listen(api);
  const cfEnv = await fakeCfExecutable(directory, origin, callLog);
  t.after(async () => {
    await new Promise(resolve => api.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const result = await runLauncher({
    ...process.env,
    ...cfEnv,
    SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'cloud-foundry',
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'cf-name-not-in-bas',
    H2O_URL: origin,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
    SAP_AI_DEV_TOOLKIT_SKIP_PROBE: 'true'
  }, ['--list-destinations', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ name: 'bas-only', client: '101', authentication: 'Unknown', probe: 'skipped' }]);
  await assert.rejects(() => readFile(callLog, 'utf8'), { code: 'ENOENT' });
});
