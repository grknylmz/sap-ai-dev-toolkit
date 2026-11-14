// Records the headless SAP GUI for HTML demos (one session, read-only).
// FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg SAP_URL=... SAP_CLIENT=... SAP_USER=... SAP_PASSWORD=... \
//   [SAP_TLS_SERVER_NAMES=...] node docs/gifs/source/record-webgui.mjs [scenario ...]
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mcpServer, screencast, waitForManagedPage } from './lib.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.SAP_AI_DEV_TOOLKIT_WEBGUI_BINARY
  || [`${root}dist/sap-ai-webgui-${process.platform}-${process.arch}`, `${root}native/webgui/target/release/sap-ai-webgui`, `${root}native/webgui/target/debug/sap-ai-webgui`].find(existsSync);
const only = new Set(process.argv.slice(2));
const want = name => only.size === 0 || only.has(name);

const server = mcpServer(binary, [], { SAP_AI_DEV_TOOLKIT_WEBGUI_MODE: 'headless' });
await server.init();

// 01: logon, including the Logon Status Check page (other logons are kept).
const started = Date.now() - 1000;
const opening = server.call('webgui_open');
const pageUrl = await waitForManagedPage(started);
let rec = await screencast(pageUrl);
rec.caption('webgui_open  ·  headless browser signs in to SAP GUI for HTML');
await new Promise(r => setTimeout(r, 2500));
rec.caption('Logon Status Check: "Cancel all existing logons" is unticked, your other sessions survive');
const opened = await opening;
if (opened.isError) throw new Error(opened.text);
rec.caption('Session ready  ·  SAP Easy Access');
await rec.hold(2.5);
if (want('01-webgui-headless-logon')) await rec.stop('01-webgui-headless-logon');

async function scene(name, steps) {
  if (!want(name)) return;
  const r = await screencast(pageUrl);
  for (const [caption, action, hold = 2.5] of steps) {
    r.caption(caption);
    if (action) {
      const result = await action();
      if (result?.isError && !result.expectedError) throw new Error(`${name}: ${result.text}`);
    }
    await r.hold(hold);
  }
  await r.stop(name);
}

const recipe = (name, params = {}) => () => server.call('webgui_run_recipe', { name, params });
const refused = async (tool, args) => {
  const result = await server.call(tool, args);
  if (!result.isError || !/read-only mode/.test(result.text)) throw new Error(`expected a refusal, got ${result.text.slice(0, 200)}`);
  return { ...result, expectedError: true };
};

await scene('02-recipe-sm37-job-overview', [
  ['webgui_run_recipe sm37_jobs  ·  background jobs of all users since yesterday', recipe('sm37_jobs', { from_date: '13.11.2026' }), 4],
  ['ABAP list returned as text lines with the total row count', null, 2.5]
]);
await scene('03-abap-list-paging', [
  ['webgui_table page=next  ·  pages a 15,000-row ABAP list on the server', () => server.call('webgui_table', { ref: 'g1', page: 'next' }), 2],
  ['webgui_table page=next', () => server.call('webgui_table', { ref: 'g1', page: 'next' }), 2],
  ['webgui_table page=last', () => server.call('webgui_table', { ref: 'g1', page: 'last' }), 3]
]);
await scene('04-recipe-st22-short-dumps', [
  ['webgui_run_recipe st22_dumps  ·  short dumps since 01.11 for SAPSYS', recipe('st22_dumps', { user: 'SAPSYS', from_date: '01.11.2026' }), 4],
  ['ALV grid rows come back with DDIC column ids (DATUM, ERRORID, GPROGRAM …)', null, 2.5]
]);
await scene('05-recipe-su53-authorization-check', [
  ['webgui_run_recipe su53_auth_check  ·  last failed authorization checks', recipe('su53_auth_check'), 4]
]);
await scene('06-recipe-se16n-table-display', [
  ['webgui_run_recipe se16n_table  table=T000  ·  clients of the system', recipe('se16n_table', { table: 'T000' }), 4],
  ['Each step checks the expected screen (SAPLSE16N/0120 → 0200) before acting', null, 2.5]
]);
await scene('07-recipe-al11-directories', [
  ['webgui_run_recipe al11_directories  ·  application server directories', recipe('al11_directories'), 4]
]);
await scene('08-recipe-sm12-lock-entries', [
  ['webgui_run_recipe sm12_locks  user=BGRFC_SUSR  ·  current enqueue locks', recipe('sm12_locks', { user: 'BGRFC_SUSR' }), 4]
]);
await scene('09-generic-transaction-driving', [
  ['webgui_start_transaction SE16  ·  any display transaction, no recipe needed', () => server.call('webgui_start_transaction', { tcode: 'SE16' }), 2],
  ['webgui_set_fields DATABROWSE-TABLENAME=T005  ·  fields addressed by DDIC name', () => server.call('webgui_set_fields', { values: { 'DATABROWSE-TABLENAME': 'T005' } }), 2],
  ['webgui_press fkey=F7  ·  Table Contents', () => server.call('webgui_press', { fkey: 'F7' }), 2.5],
  ['webgui_press fkey=F8  ·  Execute', () => server.call('webgui_press', { fkey: 'F8' }), 3.5]
]);
await scene('10-read-only-guard', [
  ['Job overview has write buttons: Release, Stop, Delete job …', recipe('sm37_jobs', { from_date: '13.11.2026' }), 2.5],
  ['webgui_press "Delete job from database"  →  refused: read-only mode', () => refused('webgui_press', { ref: 'Delete job from database' }), 3],
  ['webgui_start_transaction SE38  →  refused: runs arbitrary programs', () => refused('webgui_start_transaction', { tcode: 'SE38' }), 3],
  ['webgui_press okcode=/11 (Save)  →  refused before anything reaches SAP', () => refused('webgui_press', { okcode: '/11' }), 3]
]);
await scene('11-webgui-logoff', [
  ['webgui_close  ·  /nex logs off, no SAP session is left behind', () => server.call('webgui_close'), 3]
]);
if (!want('11-webgui-logoff')) await server.call('webgui_close');
server.close();
