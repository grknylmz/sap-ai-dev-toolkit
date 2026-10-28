import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function installation(t, { version = pkg.version, link } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'sap-install-verify-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const prefix = join(temporary, 'global');
  const executableDir = join(temporary, 'commands');
  const installed = process.platform === 'win32'
    ? join(prefix, 'node_modules', pkg.name)
    : join(prefix, 'lib', 'node_modules', pkg.name);
  const binary = process.platform === 'win32' ? join(prefix, 'sap-ai-dev.cmd') : join(prefix, 'bin', 'sap-ai-dev');
  await mkdir(dirname(installed), { recursive: true });
  await mkdir(dirname(binary), { recursive: true });
  await mkdir(executableDir, { recursive: true });
  if (link) {
    const target = link === 'workspace' ? root : join(temporary, 'other-workspace');
    if (link !== 'workspace') {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ name: pkg.name, version }));
    }
    await symlink(target, installed, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: pkg.name, version }));
  }
  await writeFile(binary, '', { mode: 0o755 });
  const fixture = join(executableDir, 'npm-fixture.mjs');
  const fixtureSource = `if(process.argv[2]==='prefix')console.log(process.env.TEST_NPM_PREFIX);else if(process.argv[2]==='list')console.log(process.env.TEST_NPM_MODULE);else process.exitCode=2;`;
  await writeFile(fixture, fixtureSource);
  const npm = join(executableDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  await writeFile(npm, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!${process.execPath}\n${fixtureSource}\n`, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/install-local.mjs'), '--verify'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${executableDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, TEST_NPM_PREFIX: prefix, TEST_NPM_MODULE: installed }
  });
  return { run, installed };
}

test('verification refuses an outdated global snapshot without modifying it', async t => {
  const { run, installed } = await installation(t, { version: '0.0.0' });
  const before = await readFile(join(installed, 'package.json'), 'utf8');
  assert.equal(run().status, 1);
  assert.equal(await readFile(join(installed, 'package.json'), 'utf8'), before);
});

test('verification accepts a matching global snapshot', async t => {
  const { run } = await installation(t);
  assert.equal(run().status, 0);
});

test('verification refuses a link to a different checkout even with the same version', async t => {
  const { run } = await installation(t, { link: 'other' });
  assert.equal(run().status, 1);
});

test('verification accepts the live workspace link', async t => {
  const { run } = await installation(t, { link: 'workspace' });
  assert.equal(run().status, 0);
});
