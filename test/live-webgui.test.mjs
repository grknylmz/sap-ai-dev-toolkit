// Live SAP GUI for HTML suite (read-only): headless mode against a real system.
// SAP_URL=https://host:44300 SAP_CLIENT=100 SAP_USER=... SAP_PASSWORD=... npm run test:live:webgui
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `npm run test:live:webgui` enables it on every OS; plain `npm test` skips it.
const LIVE = process.env.npm_lifecycle_event === 'test:live:webgui' || /^(1|true|yes)$/iu.test(process.env.SAP_AI_DEV_LIVE_WEBGUI || '');
const binary = process.env.SAP_AI_DEV_TOOLKIT_WEBGUI_BINARY
  || fileURLToPath(new URL(`../native/webgui/target/debug/sap-ai-webgui${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const skip = !LIVE ? 'set SAP_AI_DEV_LIVE_WEBGUI=1 (plus SAP_URL, SAP_CLIENT, SAP_USER, SAP_PASSWORD) to run against a live system'
  : !existsSync(binary) ? `build ${binary} first (cargo build --manifest-path native/webgui/Cargo.toml)` : false;

function startServer() {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, SAP_AI_DEV_TOOLKIT_WEBGUI_MODE: 'headless' } });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const { result, error } = await request('tools/call', { name, arguments: args });
    assert.equal(error, undefined, `${name}: ${JSON.stringify(error)}`);
    return { isError: result.isError === true, text: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), content: result.content };
  };
  return { child, request, call };
}

test('live WebGUI: recipes, guard and logoff in headless mode', { skip, timeout: 600_000 }, async t => {
  const server = startServer();
  t.after(() => server.child.kill('SIGTERM'));
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-webgui', version: '1' } });
  server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const opened = await server.call('webgui_open');
  assert.equal(opened.isError, false, opened.text);
  assert.equal(JSON.parse(opened.text).mode, 'headless');

  const user = process.env.SAP_USER;
  for (const [name, params, check] of [
    ['sm37_jobs', {}, s => s.tcode === 'SM37'],
    ['st22_dumps', {}, s => s.screen === 'RSSHOWRABAX/0100'],
    ['su53_auth_check', {}, s => s.tcode === 'SU53'],
    ['su01d_user', { user }, s => s.fields.some(f => f.name === 'SUID_ST_BNAME-BNAME' && f.value === user)],
    ['se16n_table', { table: 'T000' }, s => s.tables?.[0]?.columns?.includes('MANDT') && s.tables[0].rows.length > 0],
    ['al11_directories', {}, s => s.tables?.[0]?.rows.length > 0],
    ['sm12_locks', {}, s => s.tcode === 'SM12']
  ]) {
    const run = await server.call('webgui_run_recipe', { name, params });
    // sm37/st22 stay on the selection screen when nothing matches today; that is a valid answer.
    if (run.isError && /sm37_jobs|st22_dumps/.test(name) && /ended on/.test(run.text)) continue;
    assert.equal(run.isError, false, `${name}: ${run.text.slice(0, 600)}`);
    assert.ok(check(JSON.parse(run.text).screen), `${name} returned an unexpected screen`);
  }

  await server.call('webgui_start_transaction', { tcode: 'SE16N' });
  const edit = await server.call('webgui_press', { okcode: '&SAP_EDIT' });
  assert.equal(edit.isError, true);
  assert.match(edit.text, /read-only mode/);
  const blocked = await server.call('webgui_start_transaction', { tcode: 'SE38' });
  assert.match(blocked.text, /read-only mode/);

  const shot = await server.call('webgui_screenshot');
  assert.ok(shot.content.some(c => c.type === 'image' && c.data.length > 1000));

  const closed = await server.call('webgui_close');
  assert.deepEqual(JSON.parse(closed.text), { closed: true });
});
