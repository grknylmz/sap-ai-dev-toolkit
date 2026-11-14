// Records relay mode: pairing the SAP AI WebGUI Relay extension and driving a
// WebGUI tab in "your own" Chrome (Chrome for Testing with the unpacked
// extension stands in for it). Needs CHROME (a Chromium that accepts
// --load-extension), FFMPEG, SAP_URL, SAP_CLIENT, SAP_USER, SAP_PASSWORD
// (only to sign the stand-in browser in), optional SAP_TLS_SERVER_NAMES.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdp, mcpServer, screencast } from './lib.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.SAP_AI_DEV_TOOLKIT_WEBGUI_BINARY
  || [`${root}dist/sap-ai-webgui-${process.platform}-${process.arch}`, `${root}native/webgui/target/debug/sap-ai-webgui`].find(existsSync);
const extension = join(root, 'extension', 'sap-webgui-relay');
const port = 9339;
const token = randomBytes(32).toString('hex');
const sapUrl = new URL(process.env.SAP_URL);
const host = process.env.SAP_TLS_SERVER_NAMES?.split(',')[0] || sapUrl.hostname;
const webgui = `${sapUrl.protocol}//${host}:${sapUrl.port}/sap/bc/gui/sap/its/webgui?sap-client=${process.env.SAP_CLIENT}&sap-language=EN`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'relay-demo-'));
// Headed on purpose: it stands in for the user's own Chrome (the SAP logon form ignores synthetic input in headless).
const chrome = spawn(process.env.CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let extensionId;
for (let i = 0; i < 100 && !extensionId; i++) {
  await sleep(200);
  try {
    // Chrome for Testing runs component extensions too; pick ours by manifest name.
    for (const worker of (await targets()).filter(t => t.type === 'service_worker')) {
      const sw = await cdp(worker.webSocketDebuggerUrl);
      const name = (await sw.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true })).result?.result?.value;
      sw.close();
      if (name === 'SAP AI WebGUI Relay') extensionId = worker.url.split('/')[2];
    }
  } catch {}
}
if (!extensionId) throw new Error('relay extension did not load');

// "You are signed in to SAP in your own browser": sign the stand-in tab in once.
const sapTab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(webgui)}`, { method: 'PUT' })).json();
const tab = await cdp(sapTab.webSocketDebuggerUrl);
const evaluate = async expression => (await tab.send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
// Headless tabs have no OS focus; without focus emulation the logon form drops typed text.
await tab.send('Page.bringToFront');
await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await tab.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 100 && await evaluate('!!document.getElementById("sap-password")') !== true; i++) await sleep(200);
await sleep(2500); // UR finishes rendering the logon form after the fields appear
for (const [id, text] of [['sap-user', process.env.SAP_USER], ['sap-password', process.env.SAP_PASSWORD]]) {
  await evaluate(`document.getElementById('${id}').focus()`);
  await tab.send('Input.insertText', { text });
}
for (const type of ['keyDown', 'keyUp']) await tab.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
for (let i = 0; i < 100 && await evaluate('!document.getElementById("sap-password")') !== true; i++) await sleep(200);
if (await evaluate('!!document.getElementById("sap-password")')) {
  writeFileSync(join(tmpdir(), 'relay-demo-signin.png'), Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  throw new Error('stand-in browser sign-in failed; see relay-demo-signin.png in the temp directory');
}
await sleep(1500);

// 20: pairing in the extension options page while the server waits.
const server = mcpServer(binary, [], { SAP_USER: '', SAP_PASSWORD: '', SAP_AI_DEV_TOOLKIT_WEBGUI_MODE: 'relay', SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_TOKEN: token });
await server.init();
const optionsTarget = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extensionId}/options.html`, { method: 'PUT' })).json();
const options = await cdp(optionsTarget.webSocketDebuggerUrl);
await options.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
await sleep(800);
let rec = await screencast(optionsTarget.webSocketDebuggerUrl);
rec.caption('SAP AI WebGUI Relay  ·  extension options, not paired yet');
await rec.hold(2);
rec.caption('Paste the pairing token from sap-ai-dev --setup-webgui');
await options.send('Runtime.evaluate', { expression: "document.getElementById('token').focus()" });
for (const chunk of token.match(/.{1,8}/g)) {
  await options.send('Input.insertText', { text: chunk });
  await sleep(60);
}
await rec.hold(1);
rec.caption('Save  →  the extension pairs with the local sap-ai-webgui server');
await options.send('Runtime.evaluate', { expression: "document.getElementById('save').click()" });
await rec.hold(4);
await rec.stop('20-relay-extension-pairing');

// 21: the agent drives the already signed-in tab; no credentials reach the toolkit.
rec = await screencast(sapTab.webSocketDebuggerUrl);
rec.caption('Relay mode  ·  your own signed-in Chrome tab, no SAP credentials in the toolkit');
await rec.hold(2.5);
rec.caption('webgui_open  ·  attaches to the open WebGUI tab (Chrome shows "being debugged")');
const opened = await server.call('webgui_open');
if (opened.isError) throw new Error(opened.text);
await rec.hold(2);
rec.caption('webgui_run_recipe se16n_table  table=T000');
const ran = await server.call('webgui_run_recipe', { name: 'se16n_table', params: { table: 'T000' } });
if (ran.isError) throw new Error(ran.text);
await rec.hold(3);
rec.caption('webgui_close  ·  releases the tab; your session stays signed in');
await server.call('webgui_close');
await rec.hold(2);
await rec.stop('21-relay-drives-your-chrome');

server.close();
await tab.send('Runtime.evaluate', { expression: "UCF_Automation.Actions.ComboBox.EnterValue('ToolbarOkCode','/nex')" });
await sleep(1500);
chrome.kill();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
