import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const shim = fileURLToPath(new URL('../src/aem-server.mjs', import.meta.url));
const binary = fileURLToPath(new URL(`../native/aem/target/debug/sap-ai-aem${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const TOKEN_SECRET = 'never-emit-this-aem-token';
const SEMP_SECRET = 'never-emit-this-semp-password';

async function emptyHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'sap-ai-aem-stdio-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function startFake(t, handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname, rawPath: request.url.split('?')[0], query: url.searchParams, headers: request.headers });
    const reply = handler({ method: request.method, rawPath: request.url.split('?')[0] }) || { status: 404, json: { message: 'not found' } };
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.json ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('native AEM MCP server serves tools over stdio, gates writes and never emits secrets', async t => {
  assert.ok(existsSync(binary), 'run cargo build --manifest-path native/aem/Cargo.toml');
  const fake = await startFake(t, ({ method, rawPath }) => {
    if (method === 'GET' && rawPath === '/api/v2/missionControl/eventBrokerServices') {
      return {
        status: 200,
        json: {
          data: [{ id: 'svc1', name: 'orders', serviceClassId: 'DEVELOPER', broker: { msgVpns: [{ missionControlManagerLoginCredential: { username: 'u', password: SEMP_SECRET } }] } }],
          meta: { pagination: { pageNumber: 1, count: 1, pageSize: 25, totalPages: 1 } }
        }
      };
    }
    if (method === 'GET' && rawPath === '/SEMP/v2/config/msgVpns/default/queues') {
      return { status: 200, json: { data: [{ queueName: 'q/a' }], meta: { responseCode: 200, paging: { cursorQuery: 'cur1' } } } };
    }
    if (method === 'DELETE' && rawPath === '/SEMP/v2/config/msgVpns/default/queues/q%2Fa') {
      return { status: 200, json: { meta: { responseCode: 200 } } };
    }
    return null;
  });
  const home = await emptyHome(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [shim],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      AEM_API_URL: fake.url,
      AEM_API_TOKEN: TOKEN_SECRET,
      AEM_SEMP_URL: fake.url,
      AEM_SEMP_MSG_VPN: 'default',
      AEM_SEMP_USERNAME: 'admin',
      AEM_SEMP_PASSWORD: SEMP_SECRET,
      SAP_AI_DEV_TOOLKIT_AEM_BINARY: binary
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'aem-stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 29);
  assert.ok(listed.tools.some(tool => tool.name === 'aem_list_services'));

  const services = await client.callTool({ name: 'aem_list_services', arguments: {} });
  assert.deepEqual(JSON.parse(services.content[0].text).items[0], { id: 'svc1', name: 'orders', serviceClassId: 'DEVELOPER' });
  const cloudRequest = fake.requests.find(request => request.path === '/api/v2/missionControl/eventBrokerServices');
  assert.equal(cloudRequest.headers.authorization, `Bearer ${TOKEN_SECRET}`);

  const queues = await client.callTool({ name: 'aem_semp_list_objects', arguments: { object_type: 'queue' } });
  assert.deepEqual(JSON.parse(queues.content[0].text), { items: [{ queueName: 'q/a' }], next_cursor: 'cur1' });
  const sempRequest = fake.requests.find(request => request.path === '/SEMP/v2/config/msgVpns/default/queues');
  assert.equal(sempRequest.query.get('count'), '50');
  assert.equal(sempRequest.headers.authorization, `Basic ${Buffer.from(`admin:${SEMP_SECRET}`).toString('base64')}`);

  const refused = await client.callTool({ name: 'aem_semp_delete_object', arguments: { object_type: 'queue', key: ['q/a'], confirmation: 'wrong' } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /confirmation must equal DELETE AEM QUEUE default\/q\/a/);
  assert.equal(fake.requests.some(request => request.method === 'DELETE'), false);

  const deleted = await client.callTool({
    name: 'aem_semp_delete_object',
    arguments: { object_type: 'queue', key: ['q/a'], confirmation: 'DELETE AEM QUEUE default/q/a' }
  });
  assert.deepEqual(JSON.parse(deleted.content[0].text), { deleted: true, object_type: 'queue', key: ['q/a'] });
  assert.ok(fake.requests.some(request => request.method === 'DELETE' && request.rawPath === '/SEMP/v2/config/msgVpns/default/queues/q%2Fa'));

  const allOutput = JSON.stringify([listed, services, queues, refused, deleted]) + stderrText;
  assert.equal(allOutput.includes(TOKEN_SECRET), false);
  assert.equal(allOutput.includes(SEMP_SECRET), false);
});

test('native AEM MCP server refuses to start without credentials', async t => {
  assert.ok(existsSync(binary), 'run cargo build --manifest-path native/aem/Cargo.toml');
  const home = await emptyHome(t);
  const result = await promisify(execFile)(process.execPath, [shim], {
    env: { PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), SAP_AI_DEV_TOOLKIT_AEM_BINARY: binary }
  }).then(() => ({ code: 0, stderr: '' }), error => error);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Configure SAP Integration Suite, advanced event mesh/);
});
