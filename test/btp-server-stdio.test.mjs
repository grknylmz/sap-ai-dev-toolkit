import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isWindows, writeFakeCli } from './fake-bin.mjs';

const serverScript = fileURLToPath(new URL('../src/btp-server.mjs', import.meta.url));
const SECRET = 'never-emit-this-btp-secret';
const SA = '11111111-2222-3333-4444-555555555555';
const skip = isWindows && 'the Windows fake is a node.exe copy that consumes leading -- options';

const FAKE_BTP = `
const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  console.log('SAP BTP command line interface (client v2.116.3)');
} else if (args === '--format json get accounts/global-account') {
  console.log(JSON.stringify({ guid: 'ga-guid', displayName: 'Fake GA', subdomain: 'fake-ga' }));
} else if (args.startsWith('--format json get services/binding')) {
  console.log(JSON.stringify({ id: 'b1', name: 'k1', service_instance_id: 'i1', ready: true, credentials: { clientid: 'sb-fake', clientsecret: '${SECRET}', url: 'https://auth.example' } }));
} else {
  process.stderr.write('Unknown command\\n\\n\\u2717 ERROR\\n');
  process.exitCode = 1;
}
`;

const EXPIRED_BTP = `
if (process.argv[2] === '--format') {
  process.stderr.write('Authorization failed\\n\\nUnknown session. Please log in.\\n\\n\\u2717 ERROR\\n');
  process.exitCode = 1;
} else {
  console.log('SAP BTP command line interface (client v2.116.3)');
}
`;

async function fakeEnvironment(t, body) {
  const home = await mkdtemp(join(tmpdir(), 'sap-ai-btp-stdio-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binDir = join(home, 'bin');
  await mkdir(binDir);
  const cli = await writeFakeCli(binDir, 'btp', body);
  return { PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), BTP_CLI: cli };
}

test('standalone BTP MCP process serves tools over stdio without emitting secrets', { skip }, async t => {
  const env = await fakeEnvironment(t, FAKE_BTP);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverScript], cwd: process.cwd(), env, stderr: 'pipe' });
  const client = new Client({ name: 'btp-stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderrText += chunk; });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'btp_connection_info'));
  const info = await client.callTool({ name: 'btp_connection_info', arguments: { verify: true } });
  const summary = JSON.parse(info.content[0].text);
  assert.equal(summary.cli_source, 'environment');
  assert.equal(summary.verification.cli_version, '2.116.3');
  assert.match(summary.verification.global_account, /Fake GA/);
  const key = await client.callTool({ name: 'btp_get_service_key', arguments: { subaccount: SA, name: 'k1' } });
  assert.equal(JSON.parse(key.content[0].text).credentials.clientsecret, '[redacted]');
  const allOutput = JSON.stringify(listed) + JSON.stringify(info) + JSON.stringify(key);
  assert.equal(allOutput.includes(SECRET), false);
  assert.equal(stderrText.includes(SECRET), false);
});

test('--check exits non-zero with btp login guidance when the session expired', { skip }, async t => {
  const env = await fakeEnvironment(t, EXPIRED_BTP);
  await assert.rejects(
    promisify(execFile)(process.execPath, [serverScript, '--check'], { env, timeout: 30000 }),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stdout, /cli_version: 2\.116\.3/);
      assert.match(error.stdout, /btp login --sso/);
      return true;
    }
  );
});
