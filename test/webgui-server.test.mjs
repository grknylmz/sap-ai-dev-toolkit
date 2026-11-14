import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const shim = fileURLToPath(new URL('../src/webgui-server.mjs', import.meta.url));
const binary = fileURLToPath(new URL(`../native/webgui/target/debug/sap-ai-webgui${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const TOOLS = [
  'webgui_close',
  'webgui_connection_info',
  'webgui_list_recipes',
  'webgui_open',
  'webgui_press',
  'webgui_run_recipe',
  'webgui_screen',
  'webgui_screenshot',
  'webgui_set_fields',
  'webgui_start_transaction',
  'webgui_table'
];

async function emptyHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'sap-ai-webgui-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function isolatedEnv(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), ...extra };
}

test('WebGUI shim passes a pinned browser through and honors the binary override', { skip: process.platform === 'win32' && 'shebang fake binary' }, async t => {
  const home = await emptyHome(t);
  const fake = join(home, 'fake-webgui');
  await writeFile(fake, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ browser: process.env.SAP_AI_WEBGUI_BROWSER, args: process.argv.slice(2) }));\n`);
  await chmod(fake, 0o755);
  const { stdout } = await exec(process.execPath, [shim, '--version'], {
    env: isolatedEnv(home, { SAP_AI_DEV_TOOLKIT_WEBGUI_BINARY: fake, SAP_AI_WEBGUI_BROWSER: '/opt/pinned/chrome' })
  });
  assert.deepEqual(JSON.parse(stdout), { browser: '/opt/pinned/chrome', args: ['--version'] });
});

test('native WebGUI MCP server lists its read-only tools over stdio', { skip: !existsSync(binary) && 'run cargo build --manifest-path native/webgui/Cargo.toml' }, async t => {
  const home = await emptyHome(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [shim],
    env: isolatedEnv(home, { SAP_AI_DEV_TOOLKIT_WEBGUI_BINARY: binary, SAP_AI_WEBGUI_BROWSER: join(home, 'no-browser') }),
    stderr: 'pipe'
  });
  const client = new Client({ name: 'webgui-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), TOOLS);
});
