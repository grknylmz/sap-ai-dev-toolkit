// User-only store for CPI/APIM service keys pasted into `sap-ai-dev --setup-integration`.
// The file lives outside mcp.json (~/.config/sap-ai-dev-toolkit/integration-suite.json, mode 0600)
// and keeps only the four OAuth fields the companion needs; environment credentials take precedence.
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SIDES = ['cpi', 'apim'];

export function integrationCredentialsPath(env = process.env) {
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(env.HOME || env.USERPROFILE || homedir(), '.config');
  return join(configHome, 'sap-ai-dev-toolkit', 'integration-suite.json');
}

/** Stored service keys ({ cpi?, apim? }); {} when nothing was stored. */
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
  return Object.fromEntries(SIDES.filter(side => parsed?.[side]).map(side => [side, parsed[side]]));
}

/** Save one side's verified OAuth client (resolved config) next to the other side's stored key. */
export async function storeIntegrationKey(side, config, env = process.env) {
  const key = side.toLowerCase();
  if (!SIDES.includes(key)) throw new Error(`Unknown Integration Suite side ${side}`);
  const path = integrationCredentialsPath(env);
  let existing = {};
  try {
    existing = readStoredIntegrationKeys(env);
  } catch {
    // An unreadable or corrupt store is replaced by the verified key.
  }
  const next = {
    ...existing,
    [key]: { oauth: { url: config.url, tokenurl: config.tokenUrl, clientid: config.clientId, clientsecret: config.clientSecret } }
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
