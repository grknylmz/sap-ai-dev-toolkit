// User-only store for SAP Build Process Automation OAuth client credentials (never
// mcp.json): ~/.config/sap-ai-dev-toolkit/process-automation.json, mode 0600, atomic writes.
import { readFileSync } from 'node:fs';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';

export function processAutomationCredentialsPath(env = process.env) {
  return userConfigFilePath(env, 'process-automation.json');
}

/** Stored record ({ auth, url, tokenurl, clientid, clientsecret, refreshtoken?, apikey?, environmentid? }); undefined when absent. */
export function readStoredProcessAutomationCredentials(env = process.env) {
  const path = processAutomationCredentialsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Stored SAP Build Process Automation credentials at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored SAP Build Process Automation credentials at ${path} are not valid JSON; rerun sap-ai-dev --setup-process-automation`);
  }
}

export async function storeProcessAutomationCredentials(record, env = process.env) {
  return writeUserOnlyJson(processAutomationCredentialsPath(env), record);
}

/** Persist a rotated refresh token without touching the rest of the record. */
export async function updateStoredProcessAutomationRefreshToken(refreshToken, env = process.env) {
  const path = processAutomationCredentialsPath(env);
  const stored = readStoredProcessAutomationCredentials(env);
  if (!stored) throw new Error(`Stored SAP Build Process Automation credentials at ${path} could not be read`);
  return writeUserOnlyJson(path, { ...stored, refreshtoken: refreshToken });
}
