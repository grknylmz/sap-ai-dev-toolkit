// User-only store for SAP Integration Suite, advanced event mesh credentials
// (never mcp.json): ~/.config/sap-ai-dev-toolkit/aem.json, mode 0600, atomic
// writes. Read by the native sap-ai-aem server (native/aem/src/config.rs).
import { readFileSync } from 'node:fs';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';

export function aemCredentialsPath(env = process.env) {
  return userConfigFilePath(env, 'aem.json');
}

/** Stored record ({ api?: { url, token }, semp?: { url, msg_vpn, username, password } }); undefined when absent. */
export function readStoredAemCredentials(env = process.env) {
  const path = aemCredentialsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Stored Advanced Event Mesh credentials at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored Advanced Event Mesh credentials at ${path} are not valid JSON; rerun sap-ai-dev --setup-aem`);
  }
}

export async function storeAemCredentials(record, env = process.env) {
  return writeUserOnlyJson(aemCredentialsPath(env), record);
}
