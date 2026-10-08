import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';

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

// Every Chromium-based browser VSP can drive, best first; SAP_BROWSER_EXEC pins one ahead of the rest.
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
