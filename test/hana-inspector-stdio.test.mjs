import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverScript = fileURLToPath(new URL('../src/hana-inspector.mjs', import.meta.url));

test('standalone HANA MCP process lists tools through stdio without emitting secrets or diagnostics on stdout', async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      HANA_RO_HOST: 'hana.example.test',
      HANA_RO_PORT: '443',
      HANA_RO_USER: 'INSPECTOR',
      HANA_RO_PASSWORD: 'never-emit-this-secret',
      HANA_RO_SCHEMA: 'HDI_SCHEMA'
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'hana-stdio-smoke', version: '1.0.0' });
  const stderr = transport.stderr;
  let stderrText = '';
  stderr?.setEncoding('utf8');
  stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'hana_connection_info',
    'hana_describe_object',
    'hana_list_objects',
    'hana_read_rows'
  ]);
  assert.equal(stderrText.includes('never-emit-this-secret'), false);
  assert.equal(stderrText.includes('HANA_RO_PASSWORD='), false);
});