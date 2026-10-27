import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeTenant } from './fake-integration-tenant.mjs';
import { INTEGRATION_TOOL_NAMES } from '../src/integration-tools.mjs';
import { parseIntegrationServiceKey } from '../src/integration-config.mjs';
import { storeIntegrationKey } from '../src/integration-credentials.mjs';

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

test('live scenario runner uses saved credentials without requiring service-key environment variables', async t => {
  const tenant = await startFakeTenant(t);
  const directory = await mkdtemp(join(tmpdir(), 'integration-live-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH || '',
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    RUN: 'REGRESS',
    ONLY: 'S72'
  };
  await storeIntegrationKey('CPI', parseIntegrationServiceKey('CPI', tenant.serviceKey('saved-runner-secret')), env);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../scripts/run-live-integration.mjs', import.meta.url))
  ], { env, timeout: 30000 });
  assert.doesNotMatch(stdout + stderr, /saved-runner-secret/);
  assert.deepEqual(tenant.apiRequests().map(request => [request.method, request.path]), [
    ['GET', "/api/v1/MessageProcessingLogs('AAAAAAAAAAAAAAAAAAAAAAAAAAAA')"]
  ]);
});
