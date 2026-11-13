// Child-process runner for @sap/datasphere-cli. The CLI is spawned (not driven
// through its in-process getCommands API) because cli-core joins and re-splits
// argv on spaces, which breaks values containing spaces. Secrets are written to
// a private state dir before every process; the child environment is an
// allowlist so CONSTANT_CASE host variables never leak into CLI options.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IntegrationError } from './integration-http.mjs';
import { capText } from './integration-common.mjs';
import { diagnosticText } from './redact.mjs';

const require = createRequire(import.meta.url);

const CLI_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const OUTPUT_CAP = 16 * 1024;
const ERROR_CAP = 800;
const CHILD_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
];

/** Isolate the SAP CLI cache and prevent host environment variables becoming CLI options. */
export function datasphereCliEnvironment(env, home) {
  return {
    ...Object.fromEntries(CHILD_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
    HOME: home,
    USERPROFILE: home
  };
}

function loadCliPackage() {
  const packageJsonPath = require.resolve('@sap/datasphere-cli/package.json');
  return { metadata: JSON.parse(readFileSync(packageJsonPath, 'utf8')), entry: join(dirname(packageJsonPath), 'terminal.js') };
}

function flatten(options) {
  const argv = [];
  for (const [name, value] of Object.entries(options || {})) {
    if (value === undefined || value === false) continue;
    if (value === true) argv.push(`--${name}`);
    else argv.push(`--${name}`, String(value));
  }
  return argv;
}

/**
 * Create the Datasphere CLI runtime for one resolved config.
 * `secrets()` is an async callback returning the OAuth record to hand to the CLI;
 * it is rewritten to <stateDir>/secrets.json before every CLI process.
 */
export function createDatasphereCli({
  config,
  secrets,
  env = process.env,
  execFileImpl = execFile,
  tmpRoot = tmpdir()
} = {}) {
  if (!config?.url) throw new Error('Datasphere CLI runner needs a resolved config');
  if (typeof secrets !== 'function') throw new Error('Datasphere CLI runner needs a secrets provider');
  let cli;
  try {
    cli = loadCliPackage();
  } catch (error) {
    throw new IntegrationError(`Datasphere CLI package could not be loaded: ${diagnosticText(error, 200)}`);
  }
  const { entry } = cli;

  let stateDirPath = null;
  let queue = Promise.resolve();
  let initPromise = null;
  let closed = false;
  let lastSecrets = null;

  const stateDir = () => stateDirPath;

  const ensureState = async () => {
    if (closed) throw new IntegrationError('Datasphere CLI runtime is closed');
    if (!stateDirPath) stateDirPath = await mkdtemp(join(tmpRoot, 'sap-ai-datasphere-'));
    return stateDirPath;
  };

  const childEnv = dir => datasphereCliEnvironment(env, dir);

  const writeSecrets = async dir => {
    const record = await secrets();
    lastSecrets = record;
    const path = join(dir, 'secrets.json');
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
    return path;
  };

  const scrubValues = () => [
    config.clientSecret,
    config.clientId,
    config.refreshToken,
    config.sql?.password,
    lastSecrets?.client_secret,
    lastSecrets?.client_id,
    lastSecrets?.access_token,
    lastSecrets?.refresh_token
  ].filter(Boolean);

  const scrub = text => {
    let out = String(text ?? '');
    for (const value of new Set(scrubValues())) out = out.split(value).join('[redacted]');
    return out;
  };

  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const exec = async (words, options = {}, { input } = {}) => {
    const dir = await ensureState();
    const secretsPath = await writeSecrets(dir);
    let inputPath;
    const argv = [entry, ...words, ...flatten(options), '--host', config.url, '--secrets-file', secretsPath];
    if (input !== undefined) {
      inputPath = join(dir, `input-${randomUUID()}.json`);
      await writeFile(inputPath, JSON.stringify(input), { encoding: 'utf8', mode: 0o600 });
      await chmod(inputPath, 0o600).catch(() => {});
      argv.push('--file-path', inputPath);
    }
    try {
      return await new Promise((resolve, reject) => {
        const child = execFileImpl(process.execPath, argv, {
          cwd: dir,
          env: childEnv(dir),
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true
        }, (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              reject(new IntegrationError(`Datasphere CLI "${words.join(' ')}" timed out after ${CLI_TIMEOUT_MS / 1000} s`));
              return;
            }
            const detail = String(stderr || stdout || error.message || '');
            reject(new IntegrationError(`Datasphere CLI "${words.join(' ')}" failed: ${diagnosticText(scrub(detail), ERROR_CAP)}`));
            return;
          }
          resolve(String(stdout ?? ''));
        });
        child?.stdin?.end();
      });
    } finally {
      if (inputPath) await rm(inputPath, { force: true }).catch(() => {});
    }
  };

  const shape = text => {
    const trimmed = scrub(text).trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // Not JSON after all: fall through to plain text.
      }
    }
    return { output: capText(trimmed, OUTPUT_CAP) };
  };

  const run = (words, options, runOptions) => enqueue(() => exec(words, options, runOptions)).then(shape);

  const init = () => {
    if (!initPromise) {
      initPromise = enqueue(async () => {
        try {
          await exec(['config', 'cache', 'init']);
        } catch {
          await exec(['login'], { 'authorization-flow': config.auth === 'interactive' ? 'authorization_code' : 'client_credentials' });
        }
      });
    }
    return initPromise;
  };

  const version = () => enqueue(() => new Promise((resolve, reject) => {
    const child = execFileImpl(process.execPath, [entry, '--version'], {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new IntegrationError(`Datasphere CLI "--version" failed: ${diagnosticText(scrub(String(stderr || stdout || error.message || '')), ERROR_CAP)}`));
        return;
      }
      resolve(String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).find(line => /^\d/.test(line)) ?? '');
    });
    child?.stdin?.end();
  }));

  const close = async () => {
    closed = true;
    await queue.catch(() => {});
    if (stateDirPath) await rm(stateDirPath, { recursive: true, force: true }).catch(() => {});
  };

  return {
    get packageVersion() {
      return cli.metadata.version;
    },
    init,
    run,
    version,
    stateDir,
    close
  };
}
