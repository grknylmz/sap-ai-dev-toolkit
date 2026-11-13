import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const serverScript = fileURLToPath(new URL('../src/datasphere-server.mjs', import.meta.url));

test('standalone Datasphere MCP process serves tools over stdio without emitting secrets', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path === '/api/v1/datasphere/consumption/catalog/spaces') {
      return { status: 200, json: { value: [{ name: 'SALES' }] } };
    }
    return { status: 404 };
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test',
      DATASPHERE_URL: tenant.url,
      DATASPHERE_TOKEN_URL: `${tenant.url}/oauth/token`,
      DATASPHERE_CLIENT_ID: 'sb-datasphere-test-client',
      DATASPHERE_CLIENT_SECRET: 'never-emit-this-datasphere-secret'
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'datasphere-stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'datasphere_connection_info'));
  assert.equal(listed.tools.some(tool => tool.name === 'datasphere_sql_query'), false, 'SQL tools absent without DATASPHERE_SQL_*');
  const info = await client.callTool({ name: 'datasphere_connection_info', arguments: {} });
  const payload = JSON.parse(info.content[0].text);
  assert.equal(payload.tenant_host, new URL(tenant.url).host);
  assert.equal(payload.auth, 'technical');
  assert.equal(payload.sql, null);
  assert.equal(payload.cli_package_version, '2026.22.0');
  const spaces = await client.callTool({ name: 'datasphere_list_spaces', arguments: {} });
  assert.deepEqual(JSON.parse(spaces.content[0].text), [{ name: 'SALES' }]);
  const tokenRequest = tenant.tokenRequests()[0];
  assert.equal(tokenRequest.headers['x-sap-sac-custom-auth'], 'true');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenRequest.body)), { grant_type: 'client_credentials', response_type: 'token' });
  const allOutput = JSON.stringify(listed) + JSON.stringify(info) + JSON.stringify(spaces);
  assert.equal(allOutput.includes('never-emit-this-datasphere-secret'), false);
  assert.equal(stderrText.includes('never-emit-this-datasphere-secret'), false);
});

test('missing configuration exits non-zero with the Configure Datasphere guidance', async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, [serverScript], {
      env: { PATH: process.env.PATH || '', XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test' },
      timeout: 30000
    }),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(`${error.stdout}${error.stderr}`, /Configure Datasphere \(DATASPHERE_URL\/DATASPHERE_TOKEN_URL\/DATASPHERE_CLIENT_ID\/DATASPHERE_CLIENT_SECRET\)/);
      return true;
    }
  );
});
