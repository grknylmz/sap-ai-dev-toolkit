import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--link', '--verify']);

function usage() {
  return [
    'Usage: npm run install:local [-- --link] [--verify]',
    '',
    '  (default)  Packs the workspace and installs the tarball globally, then',
    '             runs the normal postinstall wizard (binary provisioning,',
    '             BAS destination setup, optional Copilot assets).',
    '  --link     Installs with npm link instead of a tarball; edits to src/',
    '             and scripts/ take effect immediately without reinstalling.',
    '  --verify   Verifies the global sap-ai-dev command resolves to this',
    '             workspace installation.'
  ].join('\n');
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? `${command}.cmd` : command, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      ...(process.platform === 'win32' ? { shell: true } : {}),
      ...options
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `${command} terminated by ${signal}` : `${command} exited with status ${code}`));
    });
  });
}

async function resolveGlobalBinaryPath() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      cwd: root,
      env: process.env,
      ...(process.platform === 'win32' ? { shell: true } : {})
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`npm prefix -g exited with status ${code}`));
    });
  });
}

async function verify() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const prefix = await resolveGlobalBinaryPath();
  const expected = resolvePath(prefix, 'lib', 'node_modules', pkg.name);
  const installedRoot = await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['list', '-g', pkg.name, '--parseable'], {
      cwd: root,
      env: process.env,
      ...(process.platform === 'win32' ? { shell: true } : {})
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve(code === 0 ? stdout.trim().split('\n').filter(Boolean).pop() : null));
  });
  console.log(`Global prefix:      ${prefix}`);
  console.log(`Installed location: ${installedRoot || '(not installed)'}`);
  console.log(`Workspace root:     ${root}`);
  if (!installedRoot) throw new Error(`${pkg.name} is not installed globally`);
  if (installedRoot !== expected) {
    console.log(`Expected location:  ${expected}`);
    throw new Error('Global installation does not match the expected npm layout');
  }
  const stats = await lstat(installedRoot).catch(() => null);
  console.log(`Install mode:       ${stats?.isSymbolicLink() ? 'npm link (live workspace)' : 'tarball (snapshot)'}`);
  return 0;
}

async function main() {
  for (const argument of args) {
    if (!allowedArgs.has(argument)) throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
  }
  if (args.has('--verify')) return verify();

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (args.has('--link')) {
    console.error(`install:local: linking ${pkg.name}@${pkg.version} from this workspace...`);
    await run('npm', ['link']);
    console.error('install:local: npm link complete; src/ and scripts/ edits apply immediately');
    return verify();
  }

  const tarball = `${pkg.name}-${pkg.version}.tgz`;
  console.error(`install:local: packing ${pkg.name}@${pkg.version}...`);
  await run('npm', ['pack', '--quiet']);
  console.error(`install:local: installing ${tarball} globally...`);
  await run('npm', ['install', '--global', join(root, tarball)]);
  console.error('install:local: installation complete');
  await verify();
}

main().catch(error => {
  console.error(`install:local: ${error.message}`);
  process.exitCode = 1;
});
