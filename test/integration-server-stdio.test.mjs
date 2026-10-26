import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeTenant } from './fake-integration-tenant.mjs';
import { INTEGRATION_TOOL_NAMES } from '../src/integration-tools.mjs';

const serverScript = fileURLToPath(new URL('../src/integration-server.mjs', import.meta.url));

test('standalone Integration Suite MCP process serves tools over stdio without emitting secrets', async t => {
  const tenant = await startFakeTenant(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH || '', XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', CPI_SERVICE_KEY: tenant.serviceKey('never-emit-this-secret') },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'integration-stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), INTEGRATION_TOOL_NAMES.filter(name => !name.startsWith('apim_')).sort());
  assert.ok(listed.tools.some(tool => tool.name === 'cpi_deploy_iflow'));
  const info = await client.callTool({ name: 'integration_connection_info', arguments: {} });
  const stdoutText = JSON.stringify(listed) + JSON.stringify(info);
  assert.equal(JSON.parse(info.content[0].text).cpi.configured, true);
  assert.equal(stdoutText.includes('never-emit-this-secret'), false);
  assert.equal(stderrText.includes('never-emit-this-secret'), false);
});
