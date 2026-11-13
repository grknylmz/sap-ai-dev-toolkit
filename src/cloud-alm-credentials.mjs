// User-only store for SAP Cloud ALM API client credentials (never mcp.json):
// ~/.config/sap-ai-dev-toolkit/cloud-alm.json, mode 0600, atomic writes.
import { readFileSync } from 'node:fs';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';

export function cloudAlmCredentialsPath(env = process.env) {
  return userConfigFilePath(env, 'cloud-alm.json');
}

/** Stored record ({ url, tokenurl, clientid, clientsecret }); undefined when absent. */
export function readStoredCloudAlmCredentials(env = process.env) {
  const path = cloudAlmCredentialsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Stored SAP Cloud ALM credentials at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored SAP Cloud ALM credentials at ${path} are not valid JSON; rerun sap-ai-dev --setup-cloud-alm`);
  }
}

export async function storeCloudAlmCredentials(record, env = process.env) {
  return writeUserOnlyJson(cloudAlmCredentialsPath(env), record);
}
