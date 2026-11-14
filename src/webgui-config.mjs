// User-only settings for the SAP GUI for HTML (WebGUI) companion (never
// mcp.json): ~/.config/sap-ai-dev-toolkit/webgui.json, mode 0600, atomic
// writes. Holds no credentials. Read by the native sap-ai-webgui server.
import { readFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';

export const WEBGUI_DEFAULT_RELAY_PORT = 47823;

export function webguiConfigPath(env = process.env) {
  return userConfigFilePath(env, 'webgui.json');
}

/** Stored settings ({ url, client, language, tlsServerName?, mode, relayPort, relayToken }); undefined when absent. */
export function readStoredWebguiConfig(env = process.env) {
  const path = webguiConfigPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Stored WebGUI settings at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored WebGUI settings at ${path} are not valid JSON; rerun sap-ai-dev --setup-webgui`);
  }
}

export async function storeWebguiConfig(record, env = process.env) {
  return writeUserOnlyJson(webguiConfigPath(env), record);
}

const BUNDLED_EXTENSION = fileURLToPath(new URL('../extension/sap-webgui-relay', import.meta.url));

/**
 * Copies the relay extension next to the settings: an npx cache path can be
 * purged at any time, and Chrome reloads unpacked extensions from their folder.
 */
export async function installWebguiExtension(env = process.env) {
  const target = userConfigFilePath(env, 'sap-webgui-relay');
  await rm(target, { recursive: true, force: true });
  await cp(BUNDLED_EXTENSION, target, { recursive: true });
  return target;
}
