import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingDistBinaries } from '../scripts/publish-npm.mjs';
import { packagedBinaryAssets } from '../src/binary.mjs';

test('packagedBinaryAssets lists every platform the platformMap supports', () => {
  assert.deepEqual(packagedBinaryAssets(), [
    'vsp-linux-x64',
    'vsp-linux-arm64',
    'vsp-darwin-x64',
    'vsp-darwin-arm64',
    'vsp-win32-x64.exe'
  ]);
});

test('missingDistBinaries reports every asset when checksums.txt is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publish-npm-'));
  try {
    assert.equal((await missingDistBinaries(directory)).length, packagedBinaryAssets().length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missingDistBinaries reports only assets without a checksum entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publish-npm-'));
  try {
    await mkdir(join(directory, 'dist'), { recursive: true });
    await writeFile(join(directory, 'dist', 'checksums.txt'), 'abc123  vsp-linux-x64\n');
    assert.deepEqual(await missingDistBinaries(directory), [
      'vsp-linux-arm64',
      'vsp-darwin-x64',
      'vsp-darwin-arm64',
      'vsp-win32-x64.exe'
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missingDistBinaries is empty when every asset is listed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publish-npm-'));
  try {
    await mkdir(join(directory, 'dist'), { recursive: true });
    const checksums = packagedBinaryAssets().map(asset => `0000000000000000000000000000000000000000000000000000000000000000  ${asset}`).join('\n');
    await writeFile(join(directory, 'dist', 'checksums.txt'), `${checksums}\n`);
    assert.deepEqual(await missingDistBinaries(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
