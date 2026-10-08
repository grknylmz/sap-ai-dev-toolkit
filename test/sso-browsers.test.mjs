import test from 'node:test';
import assert from 'node:assert/strict';
import { findSsoBrowsers, parseAppPath } from '../src/sso-browsers.mjs';

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
