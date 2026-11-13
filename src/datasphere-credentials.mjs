// User-only store for Datasphere OAuth client credentials (never mcp.json):
// ~/.config/sap-ai-dev-toolkit/datasphere.json, mode 0600, atomic writes.
import { readFileSync } from 'node:fs';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';

export function datasphereCredentialsPath(env = process.env) {
  return userConfigFilePath(env, 'datasphere.json');
}

/** Stored record ({ auth, url, tokenurl, clientid, clientsecret, authorizationurl?, refreshtoken?, sql? }); undefined when absent. */
export function readStoredDatasphereCredentials(env = process.env) {
  const path = datasphereCredentialsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Stored Datasphere credentials at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored Datasphere credentials at ${path} are not valid JSON; rerun sap-ai-dev --setup-datasphere`);
  }
}

export async function storeDatasphereCredentials(record, env = process.env) {
  return writeUserOnlyJson(datasphereCredentialsPath(env), record);
}

/** Persist a rotated refresh token without touching the rest of the record. */
export async function updateStoredRefreshToken(refreshToken, env = process.env) {
  const path = datasphereCredentialsPath(env);
  const stored = readStoredDatasphereCredentials(env);
  if (!stored) throw new Error(`Stored Datasphere credentials at ${path} could not be read`);
  return writeUserOnlyJson(path, { ...stored, refreshtoken: refreshToken });
}
