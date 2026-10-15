import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { findRemoteControllableSsoBrowsers, findSsoBrowsers, parseAppPath, probeSsoBrowser } from '../src/sso-browsers.mjs';

function fakeBrowserProcess(endpoint = 'ws://127.0.0.1:43127/devtools/browser/test') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    child.exitCode = 0;
    child.signalCode = signal;
    child.emit('close', 0, signal);
    return true;
  };
  queueMicrotask(() => child.stderr.write(`DevTools listening on ${endpoint}\n`));
  return child;
}

test('finds Windows SSO browsers in machine, per-user and App Paths locations, Edge first', async () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
  const present = new Set([
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'D:\\Tools\\Vivaldi\\vivaldi.exe'
  ]);
  const registered = {
    'msedge.exe': ['C:\\PROGRAM FILES (X86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    'vivaldi.exe': ['D:\\Tools\\Vivaldi\\vivaldi.exe']
  };
  const browsers = await findSsoBrowsers({ env, platform: 'win32', exists: async path => present.has(path), appPaths: async exe => registered[exe] || [] });
  assert.deepEqual(browsers, [
    { name: 'Microsoft Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'Google Chrome', path: 'C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Vivaldi', path: 'D:\\Tools\\Vivaldi\\vivaldi.exe' }
  ]);
});

test('keeps a pinned SAP_BROWSER_EXEC first, even when it is missing', async () => {
  const env = { SAP_BROWSER_EXEC: 'E:\\Portable\\Chrome\\chrome.exe', ProgramFiles: 'C:\\Program Files' };
  const edge = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  const browsers = await findSsoBrowsers({ env, platform: 'win32', exists: async path => path === edge, appPaths: async () => [] });
  assert.deepEqual(browsers, [
    { name: 'Google Chrome', path: 'E:\\Portable\\Chrome\\chrome.exe' },
    { name: 'Microsoft Edge', path: edge }
  ]);
});

test('finds macOS SSO browsers in /Applications and ~/Applications', async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const brave = '/Users/dev/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  const browsers = await findSsoBrowsers({ env: { HOME: '/Users/dev' }, platform: 'darwin', exists: async path => [chrome, brave].includes(path) });
  assert.deepEqual(browsers, [{ name: 'Google Chrome', path: chrome }, { name: 'Brave', path: brave }]);
});

test('finds Linux SSO browsers on PATH', async () => {
  const browsers = await findSsoBrowsers({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', exists: async path => path === '/usr/bin/chromium' });
  assert.deepEqual(browsers, [{ name: 'Chromium', path: '/usr/bin/chromium' }]);
});

test('reads App Paths values on localized Windows and expands variables', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files' };
  assert.equal(parseAppPath('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Standard)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"\r\n\r\n', env), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(parseAppPath('    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe\r\n', env), 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
  assert.equal(parseAppPath('ERROR: The system was unable to find the specified registry key or value.', env), '');
});

test('probes remote control with an isolated profile and always closes the browser', async () => {
  const child = fakeBrowserProcess();
  let profile;
  let controlledEndpoint;
  const result = await probeSsoBrowser({ name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, {
    spawnBrowser: (_path, args) => {
      profile = args.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      assert.ok(profile);
      assert.ok(args.includes('--remote-debugging-port=0'));
      assert.ok(args.includes('--headless=new'));
      return child;
    },
    controlRemote: async endpoint => { controlledEndpoint = endpoint; }
  });
  assert.deepEqual(result, { usable: true });
  assert.equal(controlledEndpoint, 'ws://127.0.0.1:43127/devtools/browser/test');
  assert.equal(child.signalCode, 'SIGTERM');
  await assert.rejects(access(profile));
});

test('rejects a browser when its remote debugging endpoint cannot be controlled', async () => {
  const child = fakeBrowserProcess();
  const result = await probeSsoBrowser({ name: 'Google Chrome', path: '/browser' }, {
    spawnBrowser: () => child,
    controlRemote: async () => { throw new Error('DevTools connection refused'); }
  });
  assert.equal(result.usable, false);
  assert.match(result.reason, /DevTools connection refused/);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('uses platform-appropriate process options for Windows, macOS, and Linux probes', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const child = fakeBrowserProcess();
    let options;
    const result = await probeSsoBrowser({ name: 'Browser', path: '/browser' }, {
      platform,
      spawnBrowser: (_path, _args, spawnOptions) => {
        options = spawnOptions;
        return child;
      },
      controlRemote: async () => {}
    });
    assert.deepEqual(result, { usable: true }, platform);
    assert.equal(options.windowsHide, true, platform);
    assert.equal(options.detached, platform !== 'win32', platform);
    assert.equal(child.signalCode, 'SIGTERM', platform);
  }
});

test('only returns SSO browsers whose remote control probe succeeds', async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const result = await findRemoteControllableSsoBrowsers({
    env: { HOME: '/Users/dev' },
    platform: 'darwin',
    exists: async path => [chrome, edge].includes(path),
    probe: async browser => browser.path === edge ? { usable: true } : { usable: false, reason: 'DevTools is disabled' }
  });
  assert.deepEqual(result.browsers, [{ name: 'Microsoft Edge', path: edge }]);
  assert.deepEqual(result.unavailable, [{ name: 'Google Chrome', path: chrome, reason: 'DevTools is disabled' }]);
});
