// Shared cross-build for the native Rust MCP servers under native/<crate>:
// builds every packaged platform with cargo-zigbuild into dist/, then records
// checksums.
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDistChecksums } from './dist-checksums.mjs';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const targets = [
  ['x86_64-unknown-linux-musl', 'linux', 'x64', ''],
  ['aarch64-unknown-linux-musl', 'linux', 'arm64', ''],
  ['x86_64-apple-darwin', 'darwin', 'x64', ''],
  ['aarch64-apple-darwin', 'darwin', 'arm64', ''],
  ['x86_64-pc-windows-gnu', 'win32', 'x64', '.exe']
];

async function succeeds(command, args) {
  try {
    await exec(command, args, { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function preflight(bin) {
  const zig = await succeeds('zig', ['version']) || await succeeds('python3', ['-m', 'ziglang', 'version']);
  if (!zig || !await succeeds('cargo', ['--version']) || !await succeeds('cargo', ['zigbuild', '--help'])) {
    throw new Error(`${bin} cross build needs cargo, cargo-zigbuild and zig: install Rust from https://rustup.rs, then run cargo install --locked cargo-zigbuild@0.24.1 and python3 -m pip install --user ziglang==0.17.1`);
  }
}

/**
 * Builds native/<crate> (binary `bin`) for every platform; `versionEnv` names
 * the env var the crate reads its build version from.
 */
export async function buildNative({ crate, bin, versionEnv }) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = join(root, 'native', crate, 'Cargo.toml');
  await preflight(bin);
  await exec('rustup', ['target', 'add', ...targets.map(([triple]) => triple)], { cwd: root });
  await mkdir(dist, { recursive: true });
  const assets = [];
  for (const [triple, os, arch, extension] of targets) {
    await exec('cargo', ['zigbuild', '--release', '--locked', '--manifest-path', manifest, '--target', triple], {
      cwd: root,
      env: { ...process.env, [versionEnv]: pkg.version },
      stdio: 'inherit',
      maxBuffer: 64 * 1024 * 1024
    });
    const asset = `${bin}-${os}-${arch}${extension}`;
    await copyFile(join(root, 'native', crate, 'target', triple, 'release', `${bin}${extension}`), join(dist, asset));
    await chmod(join(dist, asset), 0o755);
    assets.push(asset);
  }
  await writeDistChecksums(dist, assets);
  console.error(`Built ${assets.length} ${bin} executables at ${dist}`);
}

export function runBuild(options) {
  buildNative(options).catch(error => { console.error(`${options.bin} build: ${error.message}`); process.exitCode = 1; });
}
