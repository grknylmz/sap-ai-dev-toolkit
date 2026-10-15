import { execFile, spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'undici';

const execFileAsync = promisify(execFile);

// Edge leads: Entra device-based Conditional Access only completes in a browser bridged to the Windows account broker.
const BROWSERS = [
  { windows: 'Microsoft\\Edge\\Application\\msedge.exe', appPath: 'msedge.exe', mac: 'Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  { windows: 'Google\\Chrome\\Application\\chrome.exe', appPath: 'chrome.exe', mac: 'Google Chrome', linux: ['google-chrome', 'google-chrome-stable'] },
  { windows: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', appPath: 'brave.exe', mac: 'Brave Browser', linux: ['brave-browser'] },
  { windows: 'Vivaldi\\Application\\vivaldi.exe', appPath: 'vivaldi.exe', mac: 'Vivaldi', linux: ['vivaldi'] },
  { windows: 'Chromium\\Application\\chrome.exe', mac: 'Chromium', linux: ['chromium', 'chromium-browser'] }
];

function envValue(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function ssoBrowserName(path) {
  const lower = String(path).toLowerCase();
  if (lower.includes('edge')) return 'Microsoft Edge';
  if (lower.includes('brave')) return 'Brave';
  if (lower.includes('vivaldi')) return 'Vivaldi';
  if (lower.includes('chromium')) return 'Chromium';
  if (lower.includes('chrome')) return 'Google Chrome';
  return 'browser';
}

// Localized Windows names the default value "(Standard)" and the like, so it is found by its type.
export function parseAppPath(output, env = {}) {
  const value = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(output))?.[1];
  if (!value) return '';
  return value.replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (match, name) => envValue(env, name) ?? match);
}

async function registeredAppPaths(exe, env) {
  const found = await Promise.all(['HKLM', 'HKCU'].map(async hive => {
    try {
      const { stdout } = await execFileAsync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { windowsHide: true, timeout: 5000 });
      return parseAppPath(stdout, env);
    } catch {
      return '';
    }
  }));
  return found.filter(Boolean);
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function remoteDebuggingEndpoint(output) {
  return /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)?.[1] || '';
}

function waitForRemoteDebuggingEndpoint(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error, endpoint) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(endpoint);
    };
    const onData = chunk => {
      output = `${output}${chunk}`.slice(-8192);
      const endpoint = remoteDebuggingEndpoint(output);
      if (endpoint) finish(null, endpoint);
    };
    const onError = error => finish(error);
    const onClose = (code, signal) => finish(new Error(`browser exited before exposing DevTools (code ${code ?? 'unknown'}, signal ${signal || 'none'})`));
    const timer = setTimeout(() => finish(new Error(`browser did not expose DevTools within ${timeoutMs}ms`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function controlBrowser(endpoint, timeoutMs) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('browser exposed a non-local DevTools endpoint');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url.href);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`DevTools command timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })));
    socket.addEventListener('message', event => {
      let response;
      try { response = JSON.parse(event.data); }
      catch { return finish(new Error('DevTools returned an invalid response')); }
      if (response.id !== 1) return;
      if (response.error) return finish(new Error(response.error.message || 'DevTools rejected Browser.getVersion'));
      if (!response.result?.product) return finish(new Error('DevTools returned no browser version'));
      finish();
    });
    socket.addEventListener('error', () => finish(new Error('could not connect to the browser DevTools endpoint')));
    socket.addEventListener('close', () => {
      if (!settled) finish(new Error('browser closed the DevTools connection'));
    });
  });
}

function waitForClose(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

async function stopBrowser(child, platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  if (await waitForClose(child, 1000)) return;
  try {
    if (platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
  await waitForClose(child, 1000);
}

export async function probeSsoBrowser(browser, {
  platform = process.platform,
  timeoutMs = 5000,
  spawnBrowser = spawn,
  controlRemote = controlBrowser
} = {}) {
  let profile;
  let child;
  try {
    profile = await mkdtemp(join(tmpdir(), 'sap-ai-dev-sso-probe-'));
    child = spawnBrowser(browser.path, [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32' });
    const endpoint = await waitForRemoteDebuggingEndpoint(child, timeoutMs);
    await controlRemote(endpoint, timeoutMs);
    return { usable: true };
  } catch (error) {
    const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240);
    return { usable: false, reason };
  } finally {
    await stopBrowser(child, platform);
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}

export async function findRemoteControllableSsoBrowsers({ probe = probeSsoBrowser, ...options } = {}) {
  const candidates = await findSsoBrowsers(options);
  const results = await Promise.all(candidates.map(async browser => ({ browser, ...await probe(browser) })));
  return {
    browsers: results.filter(result => result.usable).map(result => result.browser),
    unavailable: results.filter(result => !result.usable).map(({ browser, reason }) => ({ ...browser, reason }))
  };
}

// Every Chromium-based browser the runtime can drive, best first; SAP_BROWSER_EXEC pins one ahead of the rest.
export async function findSsoBrowsers({ env = process.env, platform = process.platform, exists = fileExists, appPaths = registeredAppPaths } = {}) {
  const candidates = [];
  const pinned = envValue(env, 'SAP_BROWSER_EXEC');
  if (pinned) candidates.push(pinned);
  if (platform === 'win32') {
    const roots = [envValue(env, 'ProgramFiles') || 'C:\\Program Files', envValue(env, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)', envValue(env, 'LOCALAPPDATA')].filter(Boolean);
    const registered = await Promise.all(BROWSERS.map(browser => (browser.appPath ? appPaths(browser.appPath, env) : [])));
    BROWSERS.forEach((browser, index) => candidates.push(...roots.map(root => win32.join(root, browser.windows)), ...registered[index]));
  } else if (platform === 'darwin') {
    const home = envValue(env, 'HOME') || homedir();
    for (const browser of BROWSERS) {
      for (const root of ['/Applications', posix.join(home, 'Applications')]) candidates.push(posix.join(root, `${browser.mac}.app`, 'Contents', 'MacOS', browser.mac));
    }
  } else {
    const directories = String(envValue(env, 'PATH') || '').split(':').filter(Boolean);
    for (const browser of BROWSERS) for (const command of browser.linux) candidates.push(...directories.map(directory => posix.join(directory, command)));
  }
  const seen = new Set();
  const browsers = [];
  for (const path of candidates) {
    const key = platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    // A pinned browser is kept even when missing, so its failure shows up in the log.
    if (path === pinned || await exists(path)) browsers.push({ name: ssoBrowserName(path), path });
  }
  return browsers;
}
