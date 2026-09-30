import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { packagedBinaryAssets } from '../src/binary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--patch', '--dry-run', '--skip-build', '--verify-only']);

function parseToken(value) {
  const tokenValue = value.trim();
  if (!tokenValue) return '';
  if (tokenValue[0] === '"' || tokenValue[0] === "'") {
    const quote = tokenValue[0];
    const closingQuote = tokenValue.indexOf(quote, 1);
    if (closingQuote < 0 || (tokenValue.slice(closingQuote + 1).trim() && !tokenValue.slice(closingQuote + 1).trim().startsWith('#'))) {
      throw new Error('Malformed NPM_PUBLISH_TOKEN value in .env');
    }
    return tokenValue.slice(1, closingQuote);
  }
  return tokenValue.replace(/\s+#.*$/, '').trim();
}

async function npmToken() {
  if (process.env.NPM_PUBLISH_TOKEN?.trim()) return process.env.NPM_PUBLISH_TOKEN;
  let envFile;
  try {
    envFile = await readFile(join(root, '.env'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error('Set NPM_PUBLISH_TOKEN in the project .env file or environment before publishing');
  }

  let token = '';
  for (const line of envFile.split(/\r?\n/)) {
    const assignment = line.match(/^\s*(?:export\s+)?NPM_PUBLISH_TOKEN\s*=\s*(.*?)\s*$/);
    if (assignment) token = parseToken(assignment[1]);
  }
  if (!token) throw new Error('NPM_PUBLISH_TOKEN is missing or empty in the project .env file');
  return token;
}

function runNpm(npmArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
      cwd: root,
      env,
      stdio: 'inherit',
      ...(process.platform === 'win32' ? { shell: true } : {})
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `npm ${npmArgs[0]} terminated by ${signal}` : `npm ${npmArgs[0]} exited with status ${code}`));
    });
  });
}

// dist/ is gitignored, so a publish from a clean checkout silently ships no
// VSP binaries and every `npm install` of it fails (the 0.7.0 incident):
// postinstall only downloads from a GitHub release as a fallback. The
// prepublishOnly hook in package.json builds the binaries and re-invokes this
// script with --verify-only, so an incomplete dist/ can never be published —
// through publish:npm or a plain `npm publish` alike.
export async function missingDistBinaries(directory = root) {
  let text;
  try {
    text = await readFile(join(directory, 'dist', 'checksums.txt'), 'utf8');
  } catch {
    return packagedBinaryAssets();
  }
  const listed = new Set(text.split(/\r?\n/).map(line => line.trim().split(/\s+/)[1]).filter(Boolean));
  return packagedBinaryAssets().filter(asset => !listed.has(asset));
}

async function main() {
  for (const argument of args) {
    if (!allowedArgs.has(argument)) throw new Error(`Unknown option: ${argument}`);
  }
  const dryRun = args.has('--dry-run');
  const patch = args.has('--patch');
  if (dryRun && patch) throw new Error('--dry-run cannot be combined with --patch; it never changes the package version');

  // Second half of the prepublishOnly hook (after build-vsp.mjs ran): refuse
  // to let an incomplete dist/ reach the registry.
  if (args.has('--verify-only')) {
    const missing = await missingDistBinaries();
    if (missing.length > 0) throw new Error(`dist/checksums.txt is missing ${missing.join(', ')}; run npm run build:vsp first`);
    console.error('dist/checksums.txt lists every pinned VSP binary.');
    return;
  }

  if (dryRun) {
    const missing = await missingDistBinaries();
    if (missing.length > 0) console.error(`Dry-run note: dist/ is missing ${missing.join(', ')}; a real publish builds them via the prepublishOnly hook.`);
  }

  let authDirectory;
  try {
    let env = { ...process.env };
    if (!dryRun) {
      const token = await npmToken();
      authDirectory = await mkdtemp(join(tmpdir(), 'sap-ai-dev-toolkit-npm-'));
      const userConfig = join(authDirectory, '.npmrc');
      await writeFile(userConfig, '//registry.npmjs.org/:_authToken=${NPM_PUBLISH_TOKEN}\n', { encoding: 'utf8', mode: 0o600 });
      env = {
        ...env,
        NPM_PUBLISH_TOKEN: token,
        npm_config_userconfig: userConfig,
        NPM_CONFIG_USERCONFIG: userConfig
      };
    }

    if (patch) await runNpm(['version', 'patch', '--no-git-tag-version'], env);
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    // --dry-run and --skip-build bypass lifecycle scripts so neither waits
    // through the prepublishOnly build; a real publish always runs it.
    const bypassScripts = dryRun || args.has('--skip-build');
    const publishArgs = ['publish', '--access', 'public', ...(bypassScripts ? ['--ignore-scripts'] : []), ...(dryRun ? ['--dry-run'] : [])];
    console.error(`${dryRun ? 'Dry-running' : 'Publishing'} ${packageJson.name}@${packageJson.version}${dryRun ? '' : ' to npm'}...`);
    await runNpm(publishArgs, env);
  } finally {
    if (authDirectory) await rm(authDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch(error => {
    console.error(`publish:npm: ${error.message}`);
    process.exitCode = 1;
  });
}
