// Child-process runner for the SAP BTP CLI. It uses the user's own
// `btp login --sso` session from the CLI configuration and never logs in by
// itself (except loginBtpCli, called from the setup wizard). It never runs
// `btp target`; every subaccount-scoped call passes --subaccount. Calls are
// serialized so session refreshes inside the CLI cannot race.
import { execFile, spawn } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { IntegrationError } from './integration-http.mjs';
import { diagnosticText } from './redact.mjs';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';

const CLI_TIMEOUT_MS = 120_000;
// Global-account entitlement JSON carries an iconBase64 per service.
const MAX_BUFFER = 32 * 1024 * 1024;
const ERROR_CAP = 800;
const LOGIN_REQUIRED = /Unknown session|Please log in|log in again|session (?:has )?expired/i;

export const BTP_LOGIN_REQUIRED_MESSAGE = 'The btp CLI session is missing or expired (sessions last at most 12 hours). Run "btp login --sso" in a terminal, or sap-ai-dev --setup-btp, then retry.';

/** Parse btp CLI JSON output; tolerates notices around the JSON. null for empty output, undefined when not JSON. */
export function parseCliJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Retry on the outermost JSON value below.
  }
  const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter(index => index >= 0);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (!starts.length || end < 0) return undefined;
  const start = Math.min(...starts);
  if (end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function btpSettingsPath(env = process.env) {
  return userConfigFilePath(env, 'btp.json');
}

/** Stored { cli?, config? } written by sap-ai-dev --setup-btp; {} when absent. */
export function readBtpSettings(env = process.env) {
  const path = btpSettingsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Stored btp CLI settings at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored btp CLI settings at ${path} are not valid JSON; rerun sap-ai-dev --setup-btp`);
  }
}

export async function storeBtpSettings(settings, env = process.env) {
  return writeUserOnlyJson(btpSettingsPath(env), settings);
}

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

export function resolveBtpCliSettings(env = process.env, { stored = readBtpSettings(env) } = {}) {
  const fromEnv = trimmed(env.BTP_CLI);
  const fromStore = trimmed(stored?.cli);
  const cli = fromEnv || fromStore || 'btp';
  const cliSource = fromEnv ? 'environment' : fromStore ? 'stored' : 'PATH';
  const config = trimmed(env.BTP_CLIENTCONFIG) || trimmed(stored?.config) || null;
  return Object.freeze({ cli, cliSource, config });
}

/** Absolute path of the btp executable on PATH, or null. */
export async function locateBtpCli(env = process.env) {
  const executableNames = process.platform === 'win32' ? ['btp.exe', 'btp'] : ['btp'];
  const searchPath = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  for (const directory of searchPath) {
    for (const executableName of executableNames) {
      const candidate = resolve(directory, executableName);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

const childEnvironment = (env, config) => (config ? { ...env, BTP_CLIENTCONFIG: config } : env);

const missingCliError = cli => new IntegrationError(
  `btp CLI not found (${cli}). Install the SAP BTP command line interface from https://tools.hana.ondemand.com/#cloud, then rerun sap-ai-dev --setup-btp or set BTP_CLI to its path.`,
  { code: 'BTP_CLI_MISSING' }
);

function flatten(flags = {}) {
  const argv = [];
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === false) continue;
    if (value === true) argv.push(`--${name}`);
    else argv.push(`--${name}`, String(value));
  }
  return argv;
}

function errorDetail(stderr, stdout, error) {
  const raw = String(stderr || '').trim() || String(stdout || '').trim() || String(error?.message || '');
  const lines = raw.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(?:✗ ERROR|ERROR|OK)$/.test(line) && !line.startsWith('SAP BTP command line interface'));
  return diagnosticText(lines.join(' '), ERROR_CAP);
}

export function createBtpCli({ cli, config = null, env = process.env, execFileImpl = execFile } = {}) {
  if (!cli) throw new Error('btp CLI runner needs the btp executable');
  const childEnv = childEnvironment(env, config);
  let queue = Promise.resolve();

  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const exec = (words, argv) => enqueue(() => new Promise((resolvePromise, reject) => {
    const label = words.join(' ');
    const child = execFileImpl(cli, argv, {
      env: childEnv,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(missingCliError(cli));
          return;
        }
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new IntegrationError(`btp CLI "${label}" output exceeded 32 MiB; narrow the request`));
          return;
        }
        if (error.killed) {
          reject(new IntegrationError(`btp CLI "${label}" timed out after ${CLI_TIMEOUT_MS / 1000} s`, { code: 'BTP_CLI_TIMEOUT' }));
          return;
        }
        if (LOGIN_REQUIRED.test(`${stderr ?? ''}\n${stdout ?? ''}`)) {
          reject(new IntegrationError(BTP_LOGIN_REQUIRED_MESSAGE, { code: 'BTP_LOGIN_REQUIRED' }));
          return;
        }
        reject(new IntegrationError(`btp CLI "${label}" failed: ${errorDetail(stderr, stdout, error)}`));
        return;
      }
      resolvePromise(String(stdout ?? ''));
    });
    child?.stdin?.end();
  }));

  const text = (words, flags) => exec(words, ['--format', 'json', ...words, ...flatten(flags)]);

  const json = async (words, flags) => {
    const stdout = await text(words, flags);
    const parsed = parseCliJson(stdout);
    if (parsed === undefined) throw new IntegrationError(`btp CLI "${words.join(' ')}" returned output that is not JSON`);
    return parsed;
  };

  const version = async () => {
    const stdout = await exec(['--version'], ['--version']);
    return stdout.match(/client v(\d+(?:\.\d+)+)/)?.[1] ?? null;
  };

  return { json, text, version };
}

/** Interactive `btp login --sso` on the caller's terminal (setup wizard only). */
export function loginBtpCli({ cli, config = null, env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl(cli, ['login', '--sso'], { env: childEnvironment(env, config), stdio: 'inherit' });
    } catch (error) {
      reject(error?.code === 'ENOENT' ? missingCliError(cli) : error);
      return;
    }
    child.once('error', error => reject(error?.code === 'ENOENT' ? missingCliError(cli) : error));
    child.once('exit', code => {
      if (code === 0) resolvePromise();
      else reject(new IntegrationError(`btp login --sso exited with code ${code}`));
    });
  });
}
