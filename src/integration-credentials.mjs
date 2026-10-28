// User-only store for core service keys and normalized optional-service credentials.
// The file lives outside mcp.json (~/.config/sap-ai-dev-toolkit/integration-suite.json, mode 0600).
// Environment credentials take precedence; source metadata is never stored.
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OPTIONAL_COMPONENT_KEYS, optionalConfigRecord } from './integration-optional-config.mjs';

const SIDES = ['cpi', 'apim', 'devhub', ...OPTIONAL_COMPONENT_KEYS];

export function integrationCredentialsPath(env = process.env) {
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(env.HOME || env.USERPROFILE || homedir(), '.config');
  return join(configHome, 'sap-ai-dev-toolkit', 'integration-suite.json');
}

/** Stored keys/normalized optional records; malformed optional records remain isolated by the resolver. */
export function readStoredIntegrationKeys(env = process.env) {
  const path = integrationCredentialsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Stored Integration Suite credentials at ${path} could not be read`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Stored Integration Suite credentials at ${path} are not valid JSON; rerun sap-ai-dev --setup-integration`);
  }
  return Object.fromEntries(SIDES.filter(side => Object.hasOwn(parsed || {}, side)).map(side => [side, parsed[side]]));
}

/** Save one side alongside other stored keys; optional records contain only typed normalized fields. */
export async function storeIntegrationKey(side, config, env = process.env) {
  const key = side.toLowerCase();
  if (!SIDES.includes(key)) throw new Error(`Unknown Integration Suite side ${side}`);
  const optional = OPTIONAL_COMPONENT_KEYS.includes(key);
  const record = optional ? optionalConfigRecord(key, config) : {
    oauth: { url: config.url, tokenurl: config.tokenUrl, clientid: config.clientId, clientsecret: config.clientSecret }
  };
  const path = integrationCredentialsPath(env);
  let existing = {};
  try {
    existing = readStoredIntegrationKeys(env);
  } catch (error) {
    // Optional setup never replaces a store it could not read; core setup behavior is unchanged.
    if (optional) throw error;
  }
  const next = {
    ...existing,
    [key]: record
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  const temporary = join(dirname(path), `.integration-suite.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await chmod(path, 0o600).catch(() => {});
  return path;
}
