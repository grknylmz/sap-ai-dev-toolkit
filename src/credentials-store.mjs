import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { brandedEnvValue } from './branding.mjs';

// Optional SAP backend credential overrides live next to the MCP config
// (never inside it), with 0600 permissions and no tokens or cookies. Entries
// are keyed by a stable destination identity and may include a route mode.
const CREDENTIALS_FILENAME = 'sap-ai-dev-toolkit-credentials.json';
const CREDENTIAL_MODES = new Set(['direct', 'bas-tunnel', 'cf-connectivity']);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveCredentialsPath(env = process.env, mcpConfigPath) {
  const configured = brandedEnvValue(env, 'CREDENTIALS_FILE');
  if (configured) return configured;
  if (mcpConfigPath) return join(dirname(mcpConfigPath), CREDENTIALS_FILENAME);
  const home = env.HOME || homedir();
  const candidates = [
    join(home, '.vscode', 'data', 'User'),
    join(home, '.vscode-server', 'data', 'User'),
    join(home, '.code-server', 'data', 'User')
  ];
  for (const candidate of candidates) if (await exists(candidate)) return join(candidate, CREDENTIALS_FILENAME);
  return join(candidates[0], CREDENTIALS_FILENAME);
}

function sanitizeEntry(entry) {
  const result = {};
  if (typeof entry?.host === 'string' && entry.host) result.host = entry.host;
  if (typeof entry?.user === 'string' && entry.user) result.user = entry.user;
  if (typeof entry?.password === 'string' && entry.password) result.password = entry.password;
  if (CREDENTIAL_MODES.has(entry?.mode)) result.mode = entry.mode;
  if (typeof entry?.updatedAt === 'string') result.updatedAt = entry.updatedAt;
  return result;
}

export async function readCredentials(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Credentials file ${path} could not be read: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Credentials file ${path} contains invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Credentials file ${path} must contain a top-level JSON object`);
  }
  const destinations = {};
  for (const [name, entry] of Object.entries(parsed.destinations || {})) {
    const clean = sanitizeEntry(entry);
    if (clean.user && clean.password) destinations[name] = clean;
  }
  return { destinations };
}

async function writeCredentials(path, destinations) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, destinations }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`Credentials file ${path} could not be written: ${error.message}`);
  }
}

export async function storeDestinationCredentials(path, name, { host, user, password, mode }) {
  if (mode != null && !CREDENTIAL_MODES.has(mode)) throw new Error('Credential override route mode is unsupported');
  const current = await readCredentials(path).catch(error => { throw error; });
  const destinations = { ...current.destinations };
  destinations[String(name)] = {
    host: String(host || ''),
    user: String(user || ''),
    password: String(password || ''),
    ...(mode ? { mode } : {}),
    updatedAt: new Date().toISOString()
  };
  await writeCredentials(path, destinations);
  return { path, name };
}

export async function removeDestinationCredentials(path, names) {
  const current = await readCredentials(path);
  const destinations = { ...current.destinations };
  const removed = [];
  for (const name of names) {
    if (Object.hasOwn(destinations, String(name))) {
      delete destinations[String(name)];
      removed.push(String(name));
    }
  }
  if (removed.length) await writeCredentials(path, destinations);
  return { path, removed };
}
