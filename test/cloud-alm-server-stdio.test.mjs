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

const serverScript = fileURLToPath(new URL('../src/cloud-alm-server.mjs', import.meta.url));
const SECRET = 'never-emit-this-calm-secret';
const LMS_ID = '3f2b8c1e-5d4a-4b6f-9e7d-1a2b3c4d5e6f';

async function emptyHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'sap-ai-calm-stdio-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('standalone Cloud ALM MCP process serves tools over stdio without emitting secrets', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path === '/calm-landscape/v1/landscapeObjects') {
      return { status: 200, json: [{ lmsId: LMS_ID, name: 'PRD', role: 'PROD', objectType: 'TechnicalSystem', logonUrl: 'https://prd.example/logon' }] };
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
      CLOUD_ALM_SERVICE_KEY: JSON.stringify({
        endpoints: { Api: tenant.url },
        uaa: { url: tenant.url, clientid: 'sb-calm-test!b1', clientsecret: SECRET }
      })
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'cloud-alm-stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'calm_connection_info'));
  const info = await client.callTool({ name: 'calm_connection_info', arguments: {} });
  const summary = JSON.parse(info.content[0].text);
  assert.equal(summary.source, 'service-key');
  assert.equal(summary.auth, 'client_credentials');
  const landscape = await client.callTool({ name: 'calm_list_landscape', arguments: {} });
  assert.deepEqual(JSON.parse(landscape.content[0].text).objects, [{ lmsId: LMS_ID, name: 'PRD', role: 'PROD', objectType: 'TechnicalSystem' }]);
  const apiRequest = tenant.apiRequests().find(request => request.path === '/calm-landscape/v1/landscapeObjects');
  assert.equal(apiRequest.query.get('limit'), '100');
  assert.equal(apiRequest.headers.authorization, 'Bearer token-1');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tenant.tokenRequests()[0].body)), { grant_type: 'client_credentials' });
  const allOutput = JSON.stringify(listed) + JSON.stringify(info) + JSON.stringify(landscape);
  assert.equal(allOutput.includes(SECRET), false);
  assert.equal(stderrText.includes(SECRET), false);
});

test('missing configuration exits non-zero with the Configure SAP Cloud ALM guidance', async t => {
  const home = await emptyHome(t);
  await assert.rejects(
    promisify(execFile)(process.execPath, [serverScript], {
      env: { PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
      timeout: 30000
    }),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(`${error.stdout}${error.stderr}`, /Configure SAP Cloud ALM/);
      return true;
    }
  );
});
