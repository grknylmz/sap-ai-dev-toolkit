import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const serverScript = fileURLToPath(new URL('../src/process-automation-server.mjs', import.meta.url));
const SECRET = 'never-emit-this-bpa-secret';

async function emptyHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'sap-ai-bpa-stdio-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('standalone Process Automation MCP process serves tools over stdio without emitting secrets', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path === '/public/workflow/rest/v1/workflow-definitions') {
      return { status: 200, json: [{ id: 'orderapproval', name: 'Order Approval', version: '3', internal: 'dropped' }] };
    }
    return { status: 404 };
  });
  const home = await emptyHome(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify({
        endpoints: { api: tenant.url },
        uaa: { url: tenant.url, clientid: 'sb-bpa-test!b1', clientsecret: SECRET }
      })
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'process-automation-stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'bpa_connection_info'));
  const info = await client.callTool({ name: 'bpa_connection_info', arguments: {} });
  const summary = JSON.parse(info.content[0].text);
  assert.equal(summary.auth, 'technical');
  assert.equal(summary.source, 'service-key');
  const definitions = await client.callTool({ name: 'bpa_list_process_definitions', arguments: {} });
  assert.deepEqual(JSON.parse(definitions.content[0].text), [{ id: 'orderapproval', name: 'Order Approval', version: '3' }]);
  const apiRequest = tenant.apiRequests().find(request => request.path === '/public/workflow/rest/v1/workflow-definitions');
  assert.equal(apiRequest.query.get('$top'), '100');
  assert.equal(apiRequest.headers.authorization, 'Bearer token-1');
  const tokenRequest = tenant.tokenRequests()[0];
  assert.equal(tokenRequest.headers['x-sap-sac-custom-auth'], undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenRequest.body)), { grant_type: 'client_credentials' });
  const allOutput = JSON.stringify(listed) + JSON.stringify(info) + JSON.stringify(definitions);
  assert.equal(allOutput.includes(SECRET), false);
  assert.equal(stderrText.includes(SECRET), false);
});

test('missing configuration exits non-zero with the Configure SAP Build Process Automation guidance', async t => {
  const home = await emptyHome(t);
  await assert.rejects(
    promisify(execFile)(process.execPath, [serverScript], {
      env: { PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
      timeout: 30000
    }),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(`${error.stdout}${error.stderr}`, /Configure SAP Build Process Automation/);
      return true;
    }
  );
});
