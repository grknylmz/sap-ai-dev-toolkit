// Cross-builds the native sap-ai-aem MCP server (native/aem) for every packaged
// platform with cargo-zigbuild into dist/, then records checksums.
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDistChecksums } from './dist-checksums.mjs';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const manifest = join(root, 'native', 'aem', 'Cargo.toml');
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

async function preflight() {
  const zig = await succeeds('zig', ['version']) || await succeeds('python3', ['-m', 'ziglang', 'version']);
  if (!zig || !await succeeds('cargo', ['--version']) || !await succeeds('cargo', ['zigbuild', '--help'])) {
    throw new Error('sap-ai-aem cross build needs cargo, cargo-zigbuild and zig: install Rust from https://rustup.rs, then run cargo install --locked cargo-zigbuild@0.24.1 and python3 -m pip install --user ziglang==0.17.1');
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await preflight();
  await exec('rustup', ['target', 'add', ...targets.map(([triple]) => triple)], { cwd: root });
  await mkdir(dist, { recursive: true });
  const assets = [];
  for (const [triple, os, arch, extension] of targets) {
    await exec('cargo', ['zigbuild', '--release', '--locked', '--manifest-path', manifest, '--target', triple], {
      cwd: root,
      env: { ...process.env, SAP_AI_AEM_BUILD_VERSION: pkg.version },
      stdio: 'inherit',
      maxBuffer: 64 * 1024 * 1024
    });
    const asset = `sap-ai-aem-${os}-${arch}${extension}`;
    await copyFile(join(root, 'native', 'aem', 'target', triple, 'release', `sap-ai-aem${extension}`), join(dist, asset));
    await chmod(join(dist, asset), 0o755);
    assets.push(asset);
  }
  await writeDistChecksums(dist, assets);
  console.error(`Built ${assets.length} sap-ai-aem executables at ${dist}`);
}

main().catch(error => { console.error(`sap-ai-aem build: ${error.message}`); process.exitCode = 1; });
