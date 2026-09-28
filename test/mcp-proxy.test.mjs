import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { childArguments, MCPProxy, PUBLIC_VSP_TOOLS } from '../src/mcp-proxy.mjs';
import { PassThrough } from 'node:stream';

const fixture = fileURLToPath(new URL('./fixtures/fake-vsp.mjs', import.meta.url));
const HIDDEN_VSP_TOOLS = [
  'AnalyzeABAPCode', 'DebuggerListen', 'DeleteBreakpoint', 'DeleteObject', 'ExecuteABAP', 'ReleaseTransport',
  'DeleteTransport', 'SAP', 'ListSQLTraces', 'PublishServiceBinding', 'UnpublishServiceBinding'
];


async function fixtureProxy(logger = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bas-vsp-test-'));
  const log = join(directory, 'children.log');
  const destinations = ['alpha', 'beta'].map(name => ({ name, url: `http://${name}.dest`, client: '001' }));
  const proxy = new MCPProxy({ binary: fixture, destinations, env: { ...process.env, SAP_AI_DEV_TOOLKIT_DESTINATION: 'alpha', SAP_AI_DEV_TOOLKIT_MODE: 'expert', FAKE_LOG: log, SAP_ALLOW_TRANSPORTABLE_EDITS: 'true', SAP_USER: 'must-not-pass', SAP_PASSWORD: 'must-not-pass', Authorization: 'Bearer must-not-pass', Cookie: 'secret', SAP_READ_ONLY: 'true' }, log: logger });
  proxy.start();
  return { directory, log, proxy };
}
test('uses authentication-specific arguments for Cloud Foundry children', () => {
  const bas = { name: 'bas', url: 'http://bas.dest', client: '001' };
  assert.deepEqual(childArguments(bas, {}), [
    '--url', 'http://bas.dest', '--client', '001', '--mode', 'expert', '--proxy-auth', '--enable-transports'
  ]);
  const noAuth = { source: 'cloud-foundry', name: 'internet', url: 'http://sap.example', client: '100', authentication: 'NoAuthentication' };
  const basic = { ...noAuth, authentication: 'BasicAuthentication' };
  const principal = { ...noAuth, proxyType: 'OnPremise', authentication: 'PrincipalPropagation' };
  assert.equal(childArguments(noAuth, {}).includes('--proxy-auth'), false);
  assert.equal(childArguments(basic, {}).includes('--proxy-auth'), false);
  assert.equal(childArguments(principal, {}).includes('--proxy-auth'), true);
});

test('self-heals BAS destinations through a local destination relay without credentials', async t => {
  const destination = { name: 'S4H', url: 'http://S4H.dest', client: '100', authentication: 'BasicAuthentication', proxyType: 'Internet' };
  const directory = await mkdtemp(join(tmpdir(), 'bas-relay-'));
  const log = join(directory, 'children.log');
  const logs = [];
  const proxy = new MCPProxy({ binary: fixture, destinations: [destination], env: { ...process.env, FAKE_LOG: log }, log: message => logs.push(message) });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  proxy.start();
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const event = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'initialize');
  assert.equal(event.argv.includes('--proxy-auth'), true);
  assert.match(event.argv[event.argv.indexOf('--url') + 1], /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(event.env.user, undefined);
  assert.equal(event.env.password, undefined);
  assert.ok(logs.some(message => message.includes('BAS destination relay enabled')));
});

test('self-heals BAS relay children with loopback NO_PROXY and keeps --proxy-auth', async t => {
  const destination = { name: 'S4H', url: 'http://S4H.dest', client: '100', authentication: 'BasicAuthentication', proxyType: 'Internet' };
  const directory = await mkdtemp(join(tmpdir(), 'bas-relay-env-'));
  const log = join(directory, 'children.log');
  const proxy = new MCPProxy({ binary: fixture, destinations: [destination], env: { ...process.env, FAKE_LOG: log }, log: () => {} });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  proxy.start();
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const event = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'initialize');
  assert.equal(event.argv.includes('--proxy-auth'), true);
  const noProxy = String(event.env.noProxy || '').split(',').map(value => value.trim().toLowerCase());
  assert.ok(noProxy.includes('127.0.0.1'), `NO_PROXY must exempt the relay loopback: ${event.env.noProxy}`);
  assert.ok(noProxy.includes('localhost'), `NO_PROXY must exempt relay localhost: ${event.env.noProxy}`);
});

test('restarts a crashed VSP child and retries the tool call once', async t => {
  const { directory, log, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const entry = proxy.children[0];
  const originalChild = entry.child;
  // Kill the child behind the proxy's back to simulate a crash.
  const exit = once(originalChild.process, 'exit');
  originalChild.process.kill('SIGKILL');
  await exit;
  const response = await proxy.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'alpha__GetSystemInfo', arguments: {} } });
  assert.equal(response?.error, undefined, `self-healing must recover the call: ${JSON.stringify(response?.error)}`);
  assert.notEqual(proxy.children[0].child, originalChild, 'a replacement child must have been spawned');
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(row => row.event === 'initialize' && row.destination === 'alpha'), 'replacement child must re-initialize');
  assert.ok(events.some(row => row.event === 'call' && row.name === 'GetSystemInfo'), 'the retried call must reach the child');
});

test('closes each Cloud Foundry route after child exit and on startup failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-cf-child-lifecycle-'));
  const log = join(directory, 'children.log');
  let closeCount = 0;
  const destination = {
    source: 'cloud-foundry',
    name: 'runtime',
    url: 'http://runtime.dest',
    client: '001',
    authentication: 'BasicAuthentication',
    childEnv: { SAP_USER: 'destination-user', SAP_PASSWORD: 'destination-password', SAP_VERBOSE: 'false' },
    async close() { closeCount += 1; }
  };
  const proxy = new MCPProxy({
    binary: fixture,
    destinations: [destination],
    env: { ...process.env, FAKE_LOG: log, SAP_USER: 'parent-user', SAP_PASSWORD: 'parent-password' },
    log: () => {}
  });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  proxy.start();
  const initialized = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.ok(initialized.result);
  const child = proxy.children[0].child;
  const exit = once(child.process, 'exit');
  child.process.kill('SIGTERM');
  await exit;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeCount, 1);
  const event = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'initialize');
  assert.equal(event.argv.includes('--proxy-auth'), false);
  assert.deepEqual([event.env.user, event.env.password, event.env.verbose], ['destination-user', 'destination-password', 'false']);
  await proxy.close();
  assert.equal(closeCount, 1);

  let failedStartCloseCount = 0;
  const failedProxy = new MCPProxy({
    binary: fixture,
    destinations: [{ ...destination, async close() { failedStartCloseCount += 1; } }],
    spawn: () => { throw new Error('spawn denied'); },
    log: () => {}
  });
  failedProxy.start();
  await assert.rejects(() => failedProxy.starting, /No destination child could be started/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failedStartCloseCount, 1);
});

test('merges paged tools and routes calls to the selected child', async t => {
  const { directory, log, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });

  const initialized = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(initialized.result.serverInfo.name, 'alpha');
  const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = new Set(listed.result.tools.map(tool => tool.name));
  const queryTool = listed.result.tools.find(tool => tool.name === 'beta__RunQuery');
  assert.deepEqual(queryTool.inputSchema, {
    type: 'object',
    properties: { sql_query: { type: 'string' }, max_rows: { type: 'number' }, all_rows: { type: 'boolean' } },
    required: ['sql_query']
  });
  assert.equal(queryTool.description, 'RunQuery [destination: beta]');
  const lintTool = listed.result.tools.find(tool => tool.name === 'alpha__LintABAP');
  assert.deepEqual(Object.keys(lintTool.inputSchema.properties).sort(), ['config', 'files']);
  assert.deepEqual(lintTool.inputSchema.required, ['files']);
  assert.deepEqual(lintTool.inputSchema.properties.files.items.required, ['filename', 'source']);

  const localWorkflowTools = [
    'LintABAP', 'GetApplicationLog', 'PrepareABAPChangeSet', 'ApplyABAPChangeSet',
    'CheckTransportReadiness', 'PlanABAPCloudMigration', 'GenerateRAPRegressionSuite', 'RunRAPRegressionSuite'
  ];
  for (const destination of ['alpha', 'beta']) {
    for (const toolName of PUBLIC_VSP_TOOLS) {
      assert.ok(names.has(`${destination}__${toolName}`), `${destination} exposes curated ${toolName}`);
    }
    for (const toolName of localWorkflowTools) {
      assert.ok(names.has(`${destination}__${toolName}`), `${destination} exposes local ${toolName}`);
    }
    for (const hiddenTool of HIDDEN_VSP_TOOLS) {
      assert.equal(names.has(`${destination}__${hiddenTool}`), false, `${destination} hides ${hiddenTool}`);
    }
  }
  assert.equal(listed.result.tools.filter(tool => tool.name.startsWith('alpha__')).length, PUBLIC_VSP_TOOLS.size + localWorkflowTools.length);
  assert.equal(PUBLIC_VSP_TOOLS.size + localWorkflowTools.length, 59);

  const requiredArguments = {
    GetFeatures: [],
    GetAPIReleaseState: ['object_uri'],
    PrettyPrint: ['source'],
    ListTransports: [],
    GetTransport: ['transport'],
    GetUserTransports: [],
    GetTransportInfo: ['object_url', 'dev_class'],
    ActivateMultiple: ['objects'],
    GetApplicationLog: []
  };
  for (const [toolName, required] of Object.entries(requiredArguments)) {
    const tool = listed.result.tools.find(entry => entry.name === `alpha__${toolName}`);
    assert.deepEqual(tool.inputSchema.required, required);
  }
  const applicationLog = listed.result.tools.find(entry => entry.name === 'alpha__GetApplicationLog');
  assert.deepEqual(Object.keys(applicationLog.inputSchema.properties).sort(), [
    'from', 'max_results', 'messages', 'object', 'program', 'subobject', 'to', 'user'
  ]);

  const read = await proxy.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'beta__GetSource', arguments: { object: 'ZREAD' } } });
  const write = await proxy.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'alpha__WriteSource', arguments: { source: 'WRITE' } } });
  const query = await proxy.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'beta__RunQuery', arguments: { sql_query: 'SELECT * FROM T000' } } });
  const system = await proxy.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'alpha__GetSystemInfo', arguments: {} } });
  assert.equal(read.result.content[0].text, 'beta:GetSource');
  assert.equal(write.result.content[0].text, 'alpha:WriteSource');
  assert.equal(query.result.content[0].text, 'beta:RunQuery');
  assert.equal(system.result.content[0].text, 'alpha:GetSystemInfo');

  const additionalCalls = [
    ['GetFeatures', {}],
    ['GetAPIReleaseState', { object_uri: '/sap/bc/adt/oo/classes/cl_abap_typedescr' }],
    ['PrettyPrint', { source: 'WRITE / 1.' }],
    ['ListTransports', {}],
    ['GetTransport', { transport: 'A4HK900094' }],
    ['GetUserTransports', { user_name: 'DEVUSER' }],
    ['GetTransportInfo', { object_url: '/sap/bc/adt/oo/classes/zcl_demo', dev_class: 'ZPKG' }],
    ['GetApplicationLog', {
      program: 'ZDEMO_POST',
      user: 'TESTUSER',
      object: 'ZDEMO_LOG',
      subobject: 'POST',
      from: '2026-08-01',
      to: '2026-08-31',
      max_results: 20,
      messages: true,
      action: 'delete',
      type: 'delete',
      params: { type: 'delete' }
    }],
    ['ActivateMultiple', { objects: ['PROG ZDEMO'] }],
    ['CreateTransport', {}]
  ];
  for (const [index, [name, arguments_]] of additionalCalls.entries()) {
    const response = await proxy.handle({
      jsonrpc: '2.0',
      id: 7 + index,
      method: 'tools/call',
      params: { name: `alpha__${name}`, arguments: arguments_ }
    });
    assert.equal(response.result.content[0].text, name === 'GetApplicationLog' ? 'alpha:SAP' : `alpha:${name}`);
  }

  const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const calls = entries.filter(entry => entry.event === 'call');
  assert.deepEqual(calls.map(call => [call.destination, call.name]), [
    ['beta', 'GetSource'], ['alpha', 'WriteSource'], ['beta', 'RunQuery'], ['alpha', 'GetSystemInfo'],
    ...additionalCalls.map(([name]) => ['alpha', name === 'GetApplicationLog' ? 'SAP' : name])
  ]);
  assert.deepEqual(calls.map(call => call.arguments), [
    { object: 'ZREAD' }, { source: 'WRITE' }, { sql_query: 'SELECT * FROM T000' }, {},
    ...additionalCalls.map(([name, arguments_]) => name === 'GetApplicationLog'
      ? {
          action: 'analyze',
          params: {
            type: 'application_log',
            program: arguments_.program,
            user: arguments_.user,
            object: arguments_.object,
            subobject: arguments_.subobject,
            from: arguments_.from,
            to: arguments_.to,
            max_results: arguments_.max_results,
            messages: arguments_.messages
          }
        }
      : arguments_)
  ]);

  for (const init of entries.filter(entry => entry.event === 'initialize')) {
    assert.equal(init.env.guard, 'true');
    assert.equal(init.env.authorization, undefined);
    assert.equal(init.env.cookie, undefined);
    assert.equal(init.env.user, undefined);
    assert.equal(init.env.password, undefined);
    assert.equal(init.env.allowTransportableEdits, 'true');
  }
});
test('runs LintABAP locally and returns parser findings', async t => {
  const { directory, log, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });

  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(listed.result.tools.some(tool => tool.name === 'alpha__LintABAP'));
  const called = await proxy.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'alpha__LintABAP',
      arguments: { files: [{ filename: 'zparser_error.prog.abap', source: 'blah blah.' }] }
    }
  });
  assert.equal(called.result.isError, false);
  const report = JSON.parse(called.result.content[0].text);
  assert.equal(report.status, 'issues');
  assert.ok(report.issues.some(issue =>
    issue.rule === 'parser_error' &&
    issue.filename === 'zparser_error.prog.abap' &&
    issue.start.line === 1
  ));

  const entries = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(entries.some(entry => entry.event === 'call' && entry.name === 'LintABAP'), false);
});
test('exposes local lint when a destination tool listing fails', async t => {
  const { directory, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });

  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const alpha = proxy.children.find(entry => entry.destination.name === 'alpha');
  alpha.child.listTools = async () => { throw new Error('fixture tools/list failure'); };

  const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(listed.result.tools.some(tool => tool.name === 'alpha__LintABAP'));
  assert.equal(listed.result.tools.some(tool => tool.name === 'alpha__GetSource'), false);
  const called = await proxy.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'alpha__LintABAP', arguments: { files: [{ filename: 'zparser_error.prog.abap', source: 'blah blah.' }] } }
  });
  assert.equal(called.result.isError, false);
});

test('returns JSON-RPC errors for unknown namespaces and logs child failures', async t => {
  const logs = [];
  const { directory, proxy } = await fixtureProxy(message => logs.push(message));
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const unknown = await proxy.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing__GetSource' } });
  assert.equal(unknown.error.code, -32602);
  const remoteError = await proxy.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'alpha__GetSource', arguments: { object: 'RPC_ERROR' } } });
  assert.equal(remoteError.error.code, -32042);
  assert.ok(logs.some(message => message.includes('backend connection refused') && message.includes('password=[redacted]') && !message.includes('must-not-log')));
  const toolError = await proxy.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'beta__GetSource', arguments: { object: 'TOOL_ERROR' } } });
  assert.equal(toolError.result.isError, true);
  assert.ok(logs.some(message => message.includes('backend timeout') && message.includes('token=[redacted]') && !message.includes('must-not-log')));
  const success = await proxy.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'alpha__WriteSource', arguments: { source: 'must-not-log' } } });
  assert.equal(success.result.content[0].text, 'alpha:WriteSource');
  assert.ok(logs.some(message => /\[alpha\] tools\/call WriteSource completed in \d+ms/.test(message)));
  assert.equal(logs.some(message => message.includes('must-not-log')), false);
  const child = proxy.children.find(entry => entry.destination.name === 'alpha').child;
  child.process.kill('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 25));
  // A crashed child no longer fails the call: self-healing restarts it and
  // retries once, so the request goes through to a fresh child.
  const healed = await proxy.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'alpha__GetSource' } });
  assert.equal(healed?.error, undefined, `call must heal after child crash: ${JSON.stringify(healed?.error)}`);
  assert.equal(healed.result.content[0].text, 'alpha:GetSource');
  assert.ok(logs.some(message => message.includes('alpha') && message.includes('tools/call GetSource failed')));
  assert.ok(logs.some(message => message.includes('self-healing restart complete')), 'restart must be logged');
});
test('stdin EOF shuts down every child process and forwards child logs', async t => {
  const { directory, log, proxy } = await fixtureProxy();
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const input = new PassThrough();
  const output = [];
  const serving = proxy.serve(input, line => output.push(JSON.parse(line)));
  input.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'alpha__GetSource', arguments: { emitNotification: true } } }
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  await serving;
  assert.ok(output.some(message => message.method === 'notifications/message' && message.params?.data === 'fixture log notification'));
  const entries = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.event === 'initialize').length, 2);
  assert.deepEqual([...new Set(entries.filter(entry => entry.event === 'term').map(entry => entry.destination))].sort(), ['alpha', 'beta']);
});


test('keeps healthy children when one destination fails initialization', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-vsp-test-'));
  const log = join(directory, 'children.log');
  const proxy = new MCPProxy({ binary: fixture, destinations: ['broken', 'healthy'].map(name => ({ name, url: `http://${name}.dest`, client: '001' })), env: { ...process.env, FAKE_LOG: log }, log: () => {} });
  proxy.start();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(listed.result.tools.every(tool => tool.name.startsWith('healthy__')));
});
