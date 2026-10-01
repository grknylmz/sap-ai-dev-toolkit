import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { harnessById, harnessRoot } from './harnesses.mjs';

const MANAGED_ENV = 'SAP_AI_DEV_TOOLKIT_MANAGED';

function mcpServersPath(harness, { home = process.env.HOME || homedir(), env = process.env } = {}) {
  switch (harness.id) {
    case 'claude-code':
      return join(home, '.claude.json');
    case 'cursor':
      return join(harnessRoot(harness, { home, env }), 'mcp.json');
    case 'gemini-cli':
      return join(harnessRoot(harness, { home, env }), 'settings.json');
    case 'pi-coding-agent':
      return join(harnessRoot(harness, { home, env }), 'mcp.json');
    default:
      return null;
  }
}

async function readJsonConfig(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level value is not an object');
    return parsed;
  } catch (error) {
    throw new Error(`${path} contains invalid JSON: ${error.message}`);
  }
}

async function writeJsonConfig(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isManagedServer(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const env = entry.env;
  return env && typeof env === 'object' && (
    env[MANAGED_ENV] === 'true'
    || typeof env.SAP_AI_DEV_TOOLKIT_DESTINATION === 'string'
    || env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry'
  );
}

function toMcpServersEntry(entry) {
  const converted = {};
  if (entry?.type === 'stdio') converted.type = 'stdio';
  if (typeof entry?.command === 'string') converted.command = entry.command;
  if (Array.isArray(entry?.args)) converted.args = [...entry.args];
  converted.env = entry?.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
    ? { ...entry.env, [MANAGED_ENV]: 'true' }
    : { [MANAGED_ENV]: 'true' };
  if (typeof entry?.cwd === 'string') converted.cwd = entry.cwd;
  if (typeof entry?.description === 'string') converted.description = entry.description;
  if (typeof entry?.displayName === 'string' && !converted.description) converted.description = entry.displayName;
  return converted;
}

export function harnessMcpConfigPath(id, options = {}) {
  return mcpServersPath(harnessById(id), options);
}

export async function installMcpServersForHarness({ harness, servers, home, env = process.env } = {}) {
  const path = mcpServersPath(harness, { home, env });
  if (!path) {
    const skipped = harness.id === 'github-copilot'
      ? 'GitHub Copilot uses the BAS/VS Code MCP configuration already written during destination setup.'
      : 'No stable user-level MCP JSON config is known for this harness.';
    return { harness: harness.id, label: harness.label, supported: false, skipped };
  }
  const config = await readJsonConfig(path);
  const existing = config.mcpServers;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(`${path} has a non-object mcpServers value`);
  }
  const mcpServers = { ...(existing || {}) };
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (isManagedServer(entry)) delete mcpServers[name];
  }
  for (const [name, entry] of Object.entries(servers || {})) {
    if (Object.hasOwn(mcpServers, name)) {
      throw new Error(`MCP server "${name}" already exists and is not managed by sap-ai-dev-toolkit`);
    }
    mcpServers[name] = toMcpServersEntry(entry);
  }
  config.mcpServers = mcpServers;
  await writeJsonConfig(path, config);
  return { harness: harness.id, label: harness.label, supported: true, path, servers: Object.keys(servers || {}).length };
}

export async function installMcpServersForHarnesses(ids, servers, { home, env = process.env } = {}) {
  const results = [];
  const failures = [];
  for (const id of ids) {
    let harness;
    try {
      harness = harnessById(id);
      results.push(await installMcpServersForHarness({ harness, servers, home, env }));
    } catch (error) {
      failures.push({ id, label: harness?.label || id, error });
    }
  }
  return { results, failures };
}
