import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { childArguments, MCPProxy } from '../src/mcp-proxy.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-vsp.mjs', import.meta.url));

async function fixtureProxy(extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-hardening-'));
  const log = join(directory, 'children.log');
  const destinations = ['alpha'].map(name => ({ name, url: `http://${name}.dest`, client: '001' }));
  const env = {
    ...process.env,
    SAP_AI_DEV_TOOLKIT_DESTINATION: 'alpha',
    SAP_AI_DEV_TOOLKIT_MODE: 'expert',
    SAP_ALLOW_TRANSPORTABLE_EDITS: 'true',
    FAKE_LOG: log,
    ...extraEnv
  };
  const proxy = new MCPProxy({ binary: fixture, destinations, env, log: () => {} });
  proxy.start();
  return { directory, log, proxy };
}

async function fixtureLogs(log) {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('childArguments switches to --transport-read-only in read-only mode', () => {
  const destination = { name: 'bas', url: 'http://bas.dest', client: '001' };
  const writable = childArguments(destination, {});
  assert.ok(writable.includes('--enable-transports'));
  assert.ok(!writable.includes('--transport-read-only'));
  const readOnly = childArguments(destination, { SAP_AI_DEV_TOOLKIT_READ_ONLY: 'true' });
  assert.ok(readOnly.includes('--transport-read-only'));
  assert.ok(!readOnly.includes('--enable-transports'));
});

test('read-only mode hides state-changing tools and starts VSP read-only', async t => {
  const { directory, log, proxy } = await fixtureProxy({ SAP_AI_DEV_TOOLKIT_READ_ONLY: 'true' });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = listed.result.tools.map(tool => tool.name);
  for (const hidden of ['write_source', 'edit_source', 'create_transport', 'activate', 'activate_multiple', 'set_breakpoint', 'prepare_abap_change_set', 'apply_abap_change_set']) {
    assert.equal(names.includes(hidden), false, `${hidden} must be hidden in read-only mode`);
  }
  for (const visible of ['get_source', 'run_query', 'get_system_info', 'lint_abap', 'check_transport_readiness']) {
    assert.equal(names.includes(visible), true, `${visible} must remain available in read-only mode`);
  }
  const events = await fixtureLogs(log);
  const initialize = events.find(event => event.event === 'initialize');
  assert.ok(initialize.argv.includes('--transport-read-only'), 'VSP child must start with --transport-read-only');
  assert.equal(initialize.argv.includes('--enable-transports'), false);
});

test('a request racing the first tools/list still resolves through the namespace', async t => {
  const { directory, proxy } = await fixtureProxy();
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const input = new PassThrough();
  const output = [];
  const serving = proxy.serve(input, line => output.push(JSON.parse(line)));
  input.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_source', arguments: {} } }
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  await serving;
  const call = output.find(message => message.id === 3);
  assert.ok(call, 'the racing tools/call must be answered');
  assert.equal(call.error, undefined);
  assert.equal(call.result.content[0].text, 'alpha:GetSource');
});

test('a slow tools/call does not block other requests', async t => {
  const { directory, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  const input = new PassThrough();
  const output = [];
  const serving = proxy.serve(input, line => output.push(JSON.parse(line)));
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await new Promise(resolve => setTimeout(resolve, 150));
  const child = proxy.children[0].child;
  const original = child.request.bind(child);
  child.request = (method, params) => (method === 'tools/call' && params?.name === 'GetSource')
    ? new Promise(resolve => setTimeout(resolve, 250)).then(() => original(method, params))
    : original(method, params);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_source', arguments: {} } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`);
  const deadline = Date.now() + 10000;
  while ((!output.some(m => m.id === 2) || !output.some(m => m.id === 3)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  input.end();
  await serving;
  const slowAt = output.findIndex(message => message.id === 2);
  const fastAt = output.findIndex(message => message.id === 3);
  assert.ok(slowAt >= 0 && fastAt >= 0, 'both requests must be answered');
  assert.ok(fastAt < slowAt, 'the fast request must not wait for the slow one');
});

test('writing to a dying child rejects the request instead of crashing the server', async t => {
  const { directory, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const child = proxy.children[0].child;
  child.process.kill('SIGKILL');
  // Write immediately, before the exit event flips `exited`: the EPIPE on
  // stdin must surface as a rejection, never as an uncaught exception.
  await assert.rejects(
    () => child.request('tools/list', {}),
    /child is not running|child stdin failed|child exited/
  );
  const after = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(after.error, undefined, 'the proxy must survive the dead child');
});

test('per-request timeouts fail only the stalled request and leave the child usable', async t => {
  // The timeout must stay comfortably above a real fixture round trip so a
  // loaded parallel test run cannot time out the legitimate warm-up calls.
  const { directory, proxy } = await fixtureProxy({ SAP_AI_DEV_TOOLKIT_REQUEST_TIMEOUT_MS: '400' });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  // Let the post-initialize warm-up finish before swallowing stdin frames.
  await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const child = proxy.children[0].child;
  const realWrite = child.process.stdin.write.bind(child.process.stdin);
  child.process.stdin.write = () => true; // swallow the frame: no answer will come
  const stalled = await proxy.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_source', arguments: {} } });
  child.process.stdin.write = realWrite;
  assert.ok(stalled.error, 'the stalled call must fail');
  assert.match(stalled.error.message, /did not answer tools\/call within 400ms/);
  const recovered = await proxy.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_source', arguments: {} } });
  assert.equal(recovered.error, undefined, 'the child must still answer after a timeout');
  assert.equal(recovered.result.content[0].text, 'alpha:GetSource');
});

test('state-changing tools are not retried after a child crash', async t => {
  const { directory, log, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const entry = proxy.children[0];
  const deadChild = entry.child;
  const exit = once(deadChild.process, 'exit');
  deadChild.process.kill('SIGKILL');
  await exit;
  const response = await proxy.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_source', arguments: {} } });
  assert.ok(response.error, 'a crashed-child write must surface an error');
  assert.equal(entry.child, deadChild, 'a state-changing tool must not trigger a restart+retry');
  const events = await fixtureLogs(log);
  assert.equal(events.filter(event => event.event === 'call' && event.name === 'WriteSource').length, 0,
    'the write must never have reached a child');
});

test('self-healing restarts share one restart and respect the restart budget', async t => {
  const { directory, proxy } = await fixtureProxy();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const entry = proxy.children[0];
  for (let crash = 1; crash <= 6; crash += 1) {
    const exit = once(entry.child.process, 'exit');
    entry.child.process.kill('SIGKILL');
    await exit;
    const response = await proxy.handle({ jsonrpc: '2.0', id: 10 + crash, method: 'tools/call', params: { name: 'get_source', arguments: {} } });
    if (crash <= 5) {
      assert.equal(response.error, undefined, `heal cycle ${crash} must succeed: ${JSON.stringify(response.error)}`);
    } else {
      assert.ok(response.error, 'the sixth crash in the window must exceed the budget');
      assert.match(response.error.message, /restart budget exhausted/);
    }
  }
});
