import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureGo } from './ensure-go.mjs';
import { UPSTREAM_COMMIT } from '../src/binary.mjs';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, '.build', 'vibing-steampunk');
const dist = join(root, 'dist');
const commit = UPSTREAM_COMMIT;
const upstream = 'https://github.com/oisee/vibing-steampunk.git';
const targets = [
  ['linux', 'amd64', 'linux', 'x64', ''],
  ['linux', 'arm64', 'linux', 'arm64', ''],
  ['darwin', 'amd64', 'darwin', 'x64', ''],
  ['darwin', 'arm64', 'darwin', 'arm64', ''],
  ['windows', 'amd64', 'win32', 'x64', '.exe']
];

async function run(command, args, options = {}) {
  return exec(command, args, { cwd: root, stdio: 'inherit', ...options });
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!pkg.repository?.url) throw new Error('package.json repository.url is required before publishing binaries');
  const goPath = await ensureGo();
  await rm(join(root, '.build'), { recursive: true, force: true });
  await mkdir(dirname(source), { recursive: true });
  await run('git', ['clone', '--filter=blob:none', upstream, source]);
  await run('git', ['-C', source, 'checkout', '--detach', commit]);
  await run('patch', ['-p1', '-i', join(root, 'patches', 'vsp-bas-proxy-auth.patch')], { cwd: source });
  await mkdir(dist, { recursive: true });
  const checksums = [];
  for (const [goos, goarch, os, arch, extension] of targets) {
    const output = join(dist, `vsp-${os}-${arch}${extension}`);
    await exec(goPath, ['build', '-trimpath', '-ldflags', `-s -w -X main.Commit=${commit}`, '-o', output, './cmd/vsp'], {
      cwd: source,
      env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
      stdio: 'inherit'
    });
    const bytes = await (await import('node:fs/promises')).readFile(output);
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${output.slice(dist.length + 1)}`);
  }
  await writeFile(join(dist, 'checksums.txt'), `${checksums.join('\n')}\n`);
  console.error(`Built ${targets.length} patched VSP binaries at ${dist}`);
}

main().catch(error => { console.error(`build-vsp: ${error.message}`); process.exitCode = 1; });
