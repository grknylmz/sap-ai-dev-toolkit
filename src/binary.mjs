import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandedEnvValue } from './branding.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Single source of truth for the upstream VSP commit; scripts/build-vsp.mjs
// imports this constant so the built artifact and the runtime cannot drift.
export const UPSTREAM_COMMIT = '9886d2727f47506368b0a3c2f1c1766f1200f747';

const platformMap = {
  'linux:x64': ['linux', 'x64', ''],
  'linux:arm64': ['linux', 'arm64', ''],
  'darwin:x64': ['darwin', 'x64', ''],
  'darwin:arm64': ['darwin', 'arm64', ''],
  'win32:x64': ['win32', 'x64', '.exe']
};

export function binaryTarget(platform = process.platform, arch = process.arch) {
  const target = platformMap[`${platform}:${arch}`];
  if (!target) throw new Error(`Unsupported platform ${platform}/${arch}. Set SAP_AI_DEV_TOOLKIT_BINARY or build cmd/vsp with scripts/build-vsp.mjs.`);
  return { os: target[0], arch: target[1], extension: target[2], asset: `vsp-${target[0]}-${target[1]}${target[2]}` };
}

// Every VSP asset the npm tarball must bundle; publish:npm refuses to ship a
// package whose dist/checksums.txt does not list all of them.
export function packagedBinaryAssets() {
  return Object.keys(platformMap).map(key => binaryTarget(...key.split(':')).asset);
}

export function bundledBinaryPath(platform = process.platform, arch = process.arch) {
  return join(packageRoot, 'dist', binaryTarget(platform, arch).asset);
}

// The npm-published dist/checksums.txt is the trust anchor: unlike a GitHub
// release (mutable) or a downloaded checksum file (same origin as the
// binary), its content is fixed the moment the package version is published.
let packagedChecksumsCache;
async function packagedChecksums() {
  if (packagedChecksumsCache !== undefined) return packagedChecksumsCache;
  const map = new Map();
  try {
    const text = await readFile(join(packageRoot, 'dist', 'checksums.txt'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) map.set(parts[1], parts[0].toLowerCase());
    }
  } catch {
    // Development checkouts without a dist/ fall through to the remote
    // release checksum during install; local candidates stay unverified.
  }
  packagedChecksumsCache = map;
  return map;
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

// Verifies a locally present binary against the packaged checksum manifest.
// Returns true (verified), false (mismatch — must not be executed), or null
// (no packaged entry; caller decides whether to trust the candidate).
async function verifyAgainstPackagedChecksums(path, target) {
  const checksums = await packagedChecksums();
  const expected = checksums.get(target.asset);
  if (!expected) return null;
  try {
    return (await sha256File(path)) === expected;
  } catch {
    return false;
  }
}

export function packageRepositoryUrl(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) throw new Error('package.json repository.url is required to resolve VSP release assets');
  return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
}

export function releaseBaseUrl(pkg, version = pkg.version) {
  const override = brandedEnvValue(process.env, 'RELEASE_BASE_URL');
  if (override) return `${override.replace(/\/$/, '')}/v${version}`;
  const repo = packageRepositoryUrl(pkg).replace(/^ssh:\/\/git@github.com:/, 'https://github.com/').replace(/^git@github.com:/, 'https://github.com/');
  if (!repo.startsWith('https://')) throw new Error('package repository URL must be an HTTPS URL for release assets');
  return `${repo}/releases/download/v${version}`;
}

export function cacheDirectory(env = process.env) {
  return brandedEnvValue(env, 'CACHE_DIR') || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'sap-ai-dev-toolkit');
}

export function cachedBinaryPath(pkg, platform = process.platform, arch = process.arch, env = process.env) {
  const target = binaryTarget(platform, arch);
  return join(cacheDirectory(env), `${pkg.name}-${pkg.version}-${target.asset}`);
}

function legacyCachedBinaryPath(pkg, platform, arch, env) {
  const target = binaryTarget(platform, arch);
  const cacheRoot = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'bas-mcp-addon');
  return join(cacheRoot, `bas-mcp-addon-${pkg.version}-${target.asset}`);
}

export async function findBinary(pkg, options = {}) {
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const target = binaryTarget(options.platform, options.arch);
  if (brandedEnvValue(env, 'BINARY')) return brandedEnvValue(env, 'BINARY');
  if (!brandedEnvValue(env, 'BINARY_URL')) {
    const bundled = bundledBinaryPath(options.platform, options.arch);
    try {
      await stat(bundled);
      const verified = await verifyAgainstPackagedChecksums(bundled, target);
      if (verified === false) {
        log(`bundled VSP binary ${target.asset} failed checksum verification; ignoring it`);
      } else {
        if (verified === null) log(`bundled VSP binary ${target.asset} has no packaged checksum entry; using it unverified`);
        return bundled;
      }
    } catch {}
  }
  const path = cachedBinaryPath(pkg, options.platform, options.arch, env);
  try {
    await stat(path);
    const verified = await verifyAgainstPackagedChecksums(path, target);
    if (verified === false) {
      log(`cached VSP binary ${target.asset} failed checksum verification; ignoring it`);
    } else {
      if (verified === null) log(`cached VSP binary ${target.asset} has no packaged checksum entry; using it unverified`);
      return path;
    }
  } catch {}
  // The legacy bas-mcp-addon cache was written by an older release this code
  // never verified; only execute it when the packaged checksum confirms it.
  const legacyPath = legacyCachedBinaryPath(pkg, options.platform, options.arch, env);
  try {
    await stat(legacyPath);
    const verified = await verifyAgainstPackagedChecksums(legacyPath, target);
    if (verified === true) return legacyPath;
    log(`legacy cached VSP binary ${legacyPath} has no packaged checksum match; ignoring it`);
  } catch {}
  return null;
}

export async function installBinary(pkg, options = {}) {
  const env = options.env || process.env;
  if (brandedEnvValue(env, 'BINARY')) return brandedEnvValue(env, 'BINARY');
  if (!brandedEnvValue(env, 'BINARY_URL')) {
    const bundled = bundledBinaryPath(options.platform, options.arch);
    try {
      await stat(bundled);
      const target0 = binaryTarget(options.platform, options.arch);
      if (await verifyAgainstPackagedChecksums(bundled, target0) !== false) return bundled;
      throw new Error(`bundled VSP binary ${target0.asset} failed checksum verification`);
    } catch (error) {
      if (String(error?.message || '').includes('checksum verification')) throw error;
    }
  }
  const target = binaryTarget(options.platform, options.arch);
  const base = releaseBaseUrl(pkg, pkg.version);
  const assetUrl = brandedEnvValue(env, 'BINARY_URL') || `${base}/${target.asset}`;
  const response = await fetch(assetUrl);
  if (!response.ok) throw new Error(`VSP binary download failed (${response.status}); set SAP_AI_DEV_TOOLKIT_BINARY or SAP_AI_DEV_TOOLKIT_BINARY_URL`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  // Prefer the packaged checksum manifest (immutable per published version)
  // as the anchor; only when it has no entry fall back to the release's own
  // checksums.txt so pre-release builds keep working.
  let expected = (await packagedChecksums()).get(target.asset);
  let expectedSource = 'packaged checksums.txt';
  if (!expected) {
    const checksumUrl = `${base}/checksums.txt`;
    const checksumResponse = await fetch(checksumUrl);
    if (!checksumResponse.ok) throw new Error(`VSP checksum download failed (${checksumResponse.status}); set SAP_AI_DEV_TOOLKIT_BINARY or SAP_AI_DEV_TOOLKIT_BINARY_URL`);
    const checksumText = await checksumResponse.text();
    expected = checksumText.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts.length >= 2 && (parts[1] === target.asset || parts[1].endsWith(`/${target.asset}`)))?.[0]?.toLowerCase();
    expectedSource = 'release checksums.txt';
    if (!expected) throw new Error(`checksums.txt has no entry for ${target.asset}; set SAP_AI_DEV_TOOLKIT_BINARY or SAP_AI_DEV_TOOLKIT_BINARY_URL`);
  }
  if (actual !== expected) throw new Error(`VSP checksum mismatch for ${target.asset} (verified against ${expectedSource})`);
  const dir = cacheDirectory(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const destination = cachedBinaryPath(pkg, options.platform, options.arch, env);
  const temporary = join(tmpdir(), `sap-ai-dev-toolkit-vsp-${process.pid}-${Date.now()}`);
  await writeFile(temporary, bytes, { mode: 0o700 });
  await chmod(temporary, 0o700);
  await rename(temporary, destination);
  await chmod(destination, 0o700);
  return destination;
}

export async function ensureBinary(pkg, options = {}) {
  const existing = await findBinary(pkg, options);
  if (existing) return existing;
  return installBinary(pkg, options);
}
