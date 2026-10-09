import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir, platform } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandedEnvValue } from './branding.mjs';
import { slugifyDestination } from './bas-discovery.mjs';

const LEGACY_MCP_SERVER_PREFIXES = ['sapAiDev_', 'basVspMcp_'];
const COMPANION_SERVER_KIND = 'sap-development-companion';
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The self-package companion (HANA inspector) must launch the exact version
// the user installed; an unpinned `npx sap-ai-dev-toolkit` would re-resolve
// executable code from the registry at every MCP host start.
let selfPackageVersion;
async function runningPackageVersion() {
  if (selfPackageVersion !== undefined) return selfPackageVersion;
  try {
    selfPackageVersion = String(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version || '');
  } catch {
    selfPackageVersion = '';
  }
  return selfPackageVersion;
}

export const SAP_DEVELOPMENT_MCP_SERVERS = Object.freeze([
  Object.freeze({
    id: 'sap-fiori-tools',
    name: 'SAP Fiori tools',
    description: 'SAP Fiori elements/freestyle project generation, annotations, and UX guidance.',
    packageName: '@sap-ux/fiori-mcp-server',
    bin: 'fiori-mcp',
    priority: 'recommended'
  }),
  Object.freeze({
    id: 'ui5-tools',
    name: 'UI5 tools',
    description: 'SAPUI5/OpenUI5 project inspection, UI5-aware help, and lint/project support.',
    packageName: '@ui5/mcp-server',
    bin: 'ui5mcp',
    priority: 'recommended'
  }),
  Object.freeze({
    id: 'cap-tools',
    name: 'CAP tools',
    description: 'CAP CDS/service model inspection and AI-assisted CAP application development.',
    packageName: '@cap-js/mcp-server',
    bin: 'cds-mcp',
    priority: 'recommended'
  }),
  Object.freeze({
    id: 'browser-validation',
    name: 'Browser validation',
    description: 'Playwright browser automation for Fiori/UI smoke tests, screenshots, and runtime checks.',
    packageName: '@playwright/mcp',
    bin: 'playwright-mcp',
    priority: 'recommended'
  }),
  Object.freeze({
    id: 'hana-cloud-inspector',
    name: 'HANA Cloud inspector',
    description: 'Read-only HANA Cloud/HDI metadata and bounded row inspection using host-provided HANA_RO_* or VCAP_SERVICES credentials.',
    packageName: 'sap-ai-dev-toolkit',
    bin: 'sap-ai-hana',
    ignoreScripts: true,
    priority: 'optional'
  })
]);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// Windows tools (PowerShell `>` redirection and Set-Content, Notepad "UTF-8
// with BOM", several editors) write mcp.json with a byte-order mark or even
// UTF-16. JSON.parse rejects a leading BOM (rendering invisibly as
// "Unexpected token ''"), so decode defensively before parsing.
export function decodeJsonFileBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? '').replace(/^﻿/, '');
  if (buffer.length >= 2) {
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le');
    if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
      let body = buffer.subarray(2);
      if (body.length % 2) body = body.subarray(0, body.length - 1);
      return Buffer.from(body).swap16().toString('utf16le');
    }
  }
  const utf8 = (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF)
    ? buffer.subarray(3).toString('utf8')
    : buffer.toString('utf8');
  return utf8.replace(/^\uFEFF/, '');
}

export async function resolveMcpServerCommand(env = process.env) {
  const executableNames = process.platform === 'win32'
    ? ['sap-ai-dev.cmd', 'sap-ai-dev.exe', 'sap-ai-dev']
    : ['sap-ai-dev'];
  const searchPath = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  for (const directory of searchPath) {
    // npx prepends its disposable cache bin dir; entries pointing there go stale or vanish with the cache.
    if (/[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]\.bin[\\/]?$/.test(directory)) continue;
    for (const executableName of executableNames) {
      const candidate = resolve(directory, executableName);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH; use the command name as a portable fallback.
      }
    }
  }
  return 'sap-ai-dev';
}

// Windows ships npx as npx.cmd, not npx.exe: MCP hosts spawn the configured
// command directly without shell PATH resolution, so npx-launched servers
// must route through `cmd /c npx` there (the form VS Code, Claude Code, and
// Cursor document for Windows). Other platforms run npx directly.
export function npxMcpLauncher(platform = process.platform) {
  return platform === 'win32'
    ? { command: 'cmd', prefixArgs: ['/c', 'npx'] }
    : { command: 'npx', prefixArgs: [] };
}

export function npxPackageLauncher(version, platform = process.platform) {
  const { command, prefixArgs } = npxMcpLauncher(platform);
  return { command, args: [...prefixArgs, '--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit${version ? `@${version}` : ''}`, 'sap-ai-dev'] };
}

function isOlderVersion(version, other) {
  const parts = value => Array.from({ length: 3 }, (_, index) => Number.parseInt(String(value).split('.')[index], 10) || 0);
  const [current, target] = [parts(version), parts(other)];
  const index = current.findIndex((part, position) => part !== target[position]);
  return index >= 0 && current[index] < target[index];
}

// Setup pins its version into each entry, so a stale sap-ai-dev on PATH can hand off
// to that version through npx instead of running old code; the handoff happens once.
export function configuredVersionHandoff(env, runningVersion, platform = process.platform) {
  const configured = brandedEnvValue(env, 'VERSION');
  if (!configured || brandedEnvValue(env, 'HANDOFF') || !isOlderVersion(runningVersion, configured)) return null;
  return { version: configured, ...npxPackageLauncher(configured, platform) };
}

// Normalizes the argument list of npx-launched entries, whether written as
// `npx ...` or the Windows `cmd /c npx ...` form; returns null when the entry
// is not npx-launched.
function npxLaunchArgs(entry) {
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  if (entry?.command === 'npx') return args;
  const commandName = typeof entry?.command === 'string'
    ? entry.command.slice(Math.max(entry.command.lastIndexOf('/'), entry.command.lastIndexOf('\\')) + 1)
    : '';
  if (/^cmd(?:\.exe)?$/i.test(commandName) && args[0]?.toLowerCase() === '/c' && /^npx(?:\.cmd)?$/i.test(args[1] || '')) {
    return args.slice(2);
  }
  return null;
}

// The package version a PATH sap-ai-dev starts, found through npm's global
// layouts (Unix bin symlink, Windows .cmd shim); null when the layout is unknown.
async function commandPackageVersion(command) {
  const target = await realpath(command).catch(() => command);
  for (const manifest of [join(dirname(dirname(target)), 'package.json'), join(dirname(command), 'node_modules', 'sap-ai-dev-toolkit', 'package.json')]) {
    try {
      const pkg = JSON.parse(await readFile(manifest, 'utf8'));
      if (pkg.name === 'sap-ai-dev-toolkit') return pkg.version;
    } catch {
      // Try the other layout.
    }
  }
  return null;
}

// Resolves how generated destination entries launch the toolkit: the global
// sap-ai-dev command when it is on PATH and is this version, otherwise the
// pinned package through npx (routed through cmd /c on Windows) so entries
// written by a pure `npx sap-ai-dev-toolkit --setup` run still start on every host.
async function resolveLauncherInstallCommand(env) {
  const resolved = await resolveMcpServerCommand(env);
  const selfVersion = await runningPackageVersion();
  let warning;
  if (resolved !== 'sap-ai-dev') {
    const installed = await commandPackageVersion(resolved);
    if (installed === null || !selfVersion || installed === selfVersion) return { command: resolved, args: null };
    // A stale global install would keep starting the old launcher and VSP binary.
    warning = `${resolved} is sap-ai-dev-toolkit ${installed}, not ${selfVersion}; MCP entries start sap-ai-dev-toolkit@${selfVersion} through npx instead. Run "npm install -g sap-ai-dev-toolkit@${selfVersion}" to use the global command.`;
  }
  return { ...npxPackageLauncher(selfVersion), warning };
}

export async function resolveMcpConfigPath(env = process.env) {
  const configuredPath = [env.SAP_AI_DEV_MCP_CONFIG, brandedEnvValue(env, 'MCP_CONFIG')]
    .find(value => typeof value === 'string' && value.length > 0);
  if (configuredPath) return configuredPath;
  const home = env.HOME || homedir();
  const appData = env.APPDATA || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : '');
  const localVsCodeCandidates = [
    ...(appData ? [join(appData, 'Code', 'User', 'mcp.json'), join(appData, 'Code - Insiders', 'User', 'mcp.json')] : []),
    ...(platform() === 'darwin' ? [
      join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json')
    ] : []),
    join(home, '.config', 'Code', 'User', 'mcp.json'),
    join(home, '.config', 'Code - Insiders', 'User', 'mcp.json')
  ];
  const basCandidates = [
    join(home, '.vscode', 'data', 'User', 'mcp.json'),
    join(home, '.vscode-server', 'data', 'User', 'mcp.json'),
    join(home, '.code-server', 'data', 'User', 'mcp.json')
  ];
  const candidates = env.H2O_URL ? [...basCandidates, ...localVsCodeCandidates] : [...localVsCodeCandidates, ...basCandidates];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates[0];
}

// Server entry names are lowercase slugs: VS Code/BAS derive chat tool
// references from the server name and only bind lowercase identifiers.
export function generatedServerName(destinationName) {
  return slugifyDestination(destinationName);
}

export function generatedDestinationServerName(destination) {
  if (destination?.source === 'sap-gui-local') {
    const systemId = String(destination.systemId || '').trim();
    const client = String(destination.client || '001').trim() || '001';
    if (systemId) return generatedServerName(`${systemId}-${client}`);
  }
  return generatedServerName(destination?.source === 'cloud-foundry' ? destination.serverName : destination?.name);
}

export function buildSapDevelopmentMcpEntries(serverIds = SAP_DEVELOPMENT_MCP_SERVERS.map(server => server.id), { packageVersions = {}, packageManager = 'npx', platform = process.platform } = {}) {
  const selected = new Set(serverIds);
  const entries = Object.create(null);
  const launcher = packageManager === 'npx' ? npxMcpLauncher(platform) : { command: packageManager, prefixArgs: [] };
  for (const server of SAP_DEVELOPMENT_MCP_SERVERS) {
    if (!selected.has(server.id)) continue;
    const packageSpec = packageVersions[server.id] || packageVersions[server.packageName] || server.packageName;
    entries[server.id] = {
      type: 'stdio',
      command: launcher.command,
      args: [...launcher.prefixArgs, '--yes', ...(server.ignoreScripts ? ['--ignore-scripts'] : []), `--package=${packageSpec}`, server.bin],
      BAS_EXT: 'true',
      BAS_EXT_KIND: COMPANION_SERVER_KIND,
      displayName: server.name,
      description: server.description
    };
  }
  const unknown = [...selected].filter(id => !SAP_DEVELOPMENT_MCP_SERVERS.some(server => server.id === id));
  if (unknown.length) throw new Error(`Unknown SAP development MCP server id${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  return entries;
}

export function buildMcpEntries(destinations, env = process.env) {
  const h2oUrl = env.H2O_URL;
  const hasNonLocal = destinations.some(destination => destination?.source !== 'sap-gui-local');
  if (destinations.length && hasNonLocal && !h2oUrl) throw new Error('H2O_URL is required to write SAP AI Dev Toolkit configuration');
  const entries = Object.create(null);
  const selected = [...destinations].sort((a, b) => String(a.serverName || a.name).localeCompare(String(b.serverName || b.name)));
  for (const destination of selected) {
    const isCf = destination.source === 'cloud-foundry';
    const isLocalSapGui = destination.source === 'sap-gui-local';
    const name = generatedDestinationServerName(destination);
    if (Object.hasOwn(entries, name)) throw new Error(`Duplicate MCP destination server name: ${name} (two destination names normalize to the same lowercase server name)`);
    const entryEnv = {
      ...(h2oUrl ? { H2O_URL: String(h2oUrl) } : {}),
      SAP_ALLOW_TRANSPORTABLE_EDITS: 'true'
    };
    if (isCf) {
      const cf = destination.cf;
      if (!cf) throw new Error(`Cloud Foundry destination "${destination.name}" is missing service references`);
      Object.assign(entryEnv, {
        SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'cloud-foundry',
        SAP_AI_DEV_TOOLKIT_DESTINATION: String(destination.name),
        BAS_CF_SPACE_GUID: String(cf.spaceGuid),
        BAS_CF_DESTINATION_INSTANCE_GUID: String(cf.destinationInstanceGuid),
        BAS_CF_DESTINATION_INSTANCE: String(cf.destinationInstanceName),
        BAS_CF_DESTINATION_KEY: String(cf.destinationKeyName),
        BAS_CF_DESTINATION_NAME: String(destination.name)
      });
      if (destination.proxyType?.toLowerCase() === 'onpremise') {
        Object.assign(entryEnv, {
          BAS_CF_CONNECTIVITY_INSTANCE_GUID: String(cf.connectivityInstanceGuid),
          BAS_CF_CONNECTIVITY_INSTANCE: String(cf.connectivityInstanceName),
          BAS_CF_CONNECTIVITY_KEY: String(cf.connectivityKeyName)
        });
      }
    } else if (isLocalSapGui) {
      if (!destination.url) throw new Error(`Local SAP GUI destination "${destination.name}" is missing an ADT URL`);
      Object.assign(entryEnv, {
        SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local',
        SAP_AI_DEV_TOOLKIT_DESTINATION: String(destination.name),
        SAP_URL: String(destination.url),
        SAP_CLIENT: String(destination.client || '001'),
        ...(destination.systemId ? { SAP_SYSTEM_ID: String(destination.systemId) } : {}),
        ...(Array.isArray(destination.tlsServerNames) && destination.tlsServerNames.length ? { SAP_TLS_SERVER_NAMES: destination.tlsServerNames.join(',') } : {}),
        ...(!Array.isArray(destination.tlsServerNames) && destination.tlsServerName ? { SAP_TLS_SERVER_NAME: String(destination.tlsServerName) } : {}),
        ...(destination.childEnv || {})
      });
    } else {
      entryEnv.SAP_AI_DEV_TOOLKIT_DESTINATION = String(destination.name);
    }
    entries[name] = {
      type: 'stdio',
      command: 'sap-ai-dev',
      env: entryEnv,
      BAS_EXT: 'true'
    };
  }
  return entries;
}

function isCompanionServer(entry) {
  return entry?.BAS_EXT === 'true' && entry?.BAS_EXT_KIND === COMPANION_SERVER_KIND;
}

function isPackageLauncher(entry) {
  const currentCommands = new Set(['sap-ai-dev', 'sap-ai-dev-toolkit']);
  const legacyCommands = new Set(['bas-vsp-mcp']);
  const commandName = typeof entry?.command === 'string'
    ? entry.command.slice(Math.max(entry.command.lastIndexOf('/'), entry.command.lastIndexOf('\\')) + 1).replace(/\.(?:cmd|exe)$/i, '')
    : '';
  const currentCommand = currentCommands.has(entry?.command) || currentCommands.has(commandName);
  const legacyCommand = legacyCommands.has(entry?.command) || legacyCommands.has(commandName);
  const currentPackages = [/^--package=sap-ai-dev-toolkit(?:@[^/]+)?$/];
  const legacyPackages = [/^--package=bas-mcp-addon(?:@[^/]+)?$/];
  const hasPackage = (arguments_, patterns) => arguments_.some(argument => patterns.some(pattern => pattern.test(argument)));
  const npxArgs = npxLaunchArgs(entry);
  const currentNpxLauncher = npxArgs !== null
    && npxArgs.some(argument => currentCommands.has(argument))
    && hasPackage(npxArgs, currentPackages);
  const legacyNpxLauncher = npxArgs !== null
    && npxArgs.some(argument => legacyCommands.has(argument))
    && hasPackage(npxArgs, legacyPackages);
  // Current launchers are treated as managed only when tagged by this add-on.
  // Some early bas-mcp-addon entries were not tagged with BAS_EXT, though, and
  // leaving them behind keeps advertising the old full VSP surface (~159 tools).
  return (entry?.BAS_EXT === 'true' && (currentCommand || currentNpxLauncher || legacyCommand || legacyNpxLauncher))
    || legacyCommand
    || legacyNpxLauncher;
}

function destinationValue(env) {
  return env?.SAP_AI_DEV_TOOLKIT_DESTINATION ?? env?.BAS_VSP_DESTINATION;
}

function destinationSource(env) {
  return env?.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE ?? env?.BAS_VSP_DESTINATION_SOURCE;
}

function isManagedBasDestinationEntry(entry) {
  const currentCommands = new Set(['sap-ai-dev', 'sap-ai-dev-toolkit']);
  const commandName = typeof entry?.command === 'string'
    ? entry.command.slice(Math.max(entry.command.lastIndexOf('/'), entry.command.lastIndexOf('\\')) + 1).replace(/\.(?:cmd|exe)$/i, '')
    : '';
  const currentCommand = currentCommands.has(entry?.command) || currentCommands.has(commandName);
  const npxArgs = npxLaunchArgs(entry);
  const currentNpxLauncher = npxArgs !== null
    && npxArgs.some(argument => currentCommands.has(argument))
    && npxArgs.some(argument => /^--package=sap-ai-dev-toolkit(?:@[^/]+)?$/.test(argument));
  return entry?.BAS_EXT === 'true'
    && (currentCommand || currentNpxLauncher)
    && typeof destinationValue(entry?.env) === 'string'
    && destinationSource(entry.env) === undefined;
}

function collectCloudFoundryKeyReferences(config, managedOnly) {
  const refs = new Map();
  for (const entry of Object.values(config?.servers || {})) {
    const e = entry?.env;
    if (!e || (managedOnly && (destinationSource(e) !== 'cloud-foundry' || !isPackageLauncher(entry)))) continue;
    const candidates = [
      { kind: 'destination', spaceGuid: e.BAS_CF_SPACE_GUID, instanceGuid: e.BAS_CF_DESTINATION_INSTANCE_GUID, instanceName: e.BAS_CF_DESTINATION_INSTANCE, keyName: e.BAS_CF_DESTINATION_KEY },
      { kind: 'connectivity', spaceGuid: e.BAS_CF_SPACE_GUID, instanceGuid: e.BAS_CF_CONNECTIVITY_INSTANCE_GUID, instanceName: e.BAS_CF_CONNECTIVITY_INSTANCE, keyName: e.BAS_CF_CONNECTIVITY_KEY }
    ];
    for (const ref of candidates) {
      if (!ref.spaceGuid || !ref.instanceGuid || !ref.instanceName || !ref.keyName) continue;
      refs.set(`${ref.kind}\\0${ref.spaceGuid}\\0${ref.instanceGuid}\\0${ref.keyName}`, ref);
    }
  }
  return [...refs.values()];
}

export function collectManagedCloudFoundryKeyReferences(config) {
  return collectCloudFoundryKeyReferences(config, true);
}

export function collectCloudFoundryKeyReferencesFromAllEntries(config) {
  return collectCloudFoundryKeyReferences(config, false);
}

function freshConfig() {
  return { servers: {}, inputs: [] };
}

// VS Code parses mcp.json as JSONC: // and /* */ comments plus trailing
// commas are accepted there but rejected by strict JSON.parse. Strip them in
// one string-aware pass (string literals are copied verbatim, so "//", "/*",
// and "," inside values survive) so self-healing can recover hand-written
// content instead of resetting the file.
export function loosenJsonText(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    if (ch === ',') {
      // A trailing comma is dropped only when nothing but whitespace and
      // comments separate it from a closing bracket.
      let k = i + 1;
      while (k < n) {
        const lookahead = text[k];
        if (lookahead === ' ' || lookahead === '\t' || lookahead === '\n' || lookahead === '\r') { k += 1; continue; }
        if (lookahead === '/' && text[k + 1] === '/') { k += 2; while (k < n && text[k] !== '\n' && text[k] !== '\r') k += 1; continue; }
        if (lookahead === '/' && text[k + 1] === '*') { k += 2; while (k < n && !(text[k] === '*' && text[k + 1] === '/')) k += 1; k = Math.min(k + 2, n); continue; }
        break;
      }
      if (text[k] === '}' || text[k] === ']') { i += 1; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function backupPathCandidates(path, kind, now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return ['', '-2', '-3', '-4', '-5'].map(suffix => `${path}.${kind}-${stamp}${suffix}.bak`);
}

// Backups use exclusive creation (wx) so a repeated setup can never clobber
// an earlier backup; identical timestamps walk a numeric suffix instead.
// Failing to write the backup is fatal on purpose: healing must never risk
// losing the only copy of the original file.
export async function writeConfigBackup(path, buffer, { kind, now } = {}) {
  let lastError;
  for (const candidate of backupPathCandidates(path, kind, now)) {
    try {
      await writeFile(candidate, buffer, { flag: 'wx', mode: 0o600 });
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new Error(`Could not back up ${path} before healing (${error.message}); the original file was left untouched.`);
      }
      lastError = error;
    }
  }
  throw new Error(`Could not back up ${path}: no unique backup name was available (${lastError?.message}).`);
}

function shapeFailures(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return [{ field: null, message: 'must contain a top-level JSON object' }];
  }
  const failures = [];
  if (config.servers !== undefined && (!config.servers || typeof config.servers !== 'object' || Array.isArray(config.servers))) {
    failures.push({ field: 'servers', message: 'has a non-object servers value' });
  }
  if (config.inputs !== undefined && config.inputs !== null && !Array.isArray(config.inputs)) {
    failures.push({ field: 'inputs', message: 'has a non-array inputs value' });
  }
  return failures;
}

// Healing ladder (install/setup only; strict readers such as --doctor keep
// rejecting): BOM/UTF-16 decode -> torn-write re-read -> JSONC recovery ->
// field-level repair -> full reset. Every lossy step backs up the original
// first; a backup failure aborts rather than risking data loss.
async function readConfig(path, options = {}) {
  const { recoverInvalid = false, warnings, retryDelayMs = 250, readFileImpl = readFile } = options;
  let buffer;
  try {
    buffer = await readFileImpl(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return freshConfig();
    throw new Error(`MCP config ${path} could not be read: ${error.message}`);
  }
  let text = decodeJsonFileBuffer(buffer);
  if (!text.trim()) return freshConfig();
  const tryParse = candidate => {
    try { return { config: JSON.parse(candidate) }; } catch (error) { return { error }; }
  };
  let parsed = tryParse(text);
  if (parsed.error && retryDelayMs > 0) {
    // A torn read — setup racing an editor's non-atomic save — looks exactly
    // like corruption; re-read once before healing so a transient state is
    // never backed up and replaced.
    await sleep(retryDelayMs);
    const second = await readFileImpl(path).catch(() => null);
    if (second && !second.equals(buffer)) {
      buffer = second;
      text = decodeJsonFileBuffer(second);
      if (!text.trim()) return freshConfig();
      parsed = tryParse(text);
    }
  }
  let loosened = false;
  if (parsed.error && recoverInvalid) {
    const recovered = tryParse(loosenJsonText(text));
    if (!recovered.error) {
      parsed = recovered;
      loosened = true;
    }
  }
  const failures = parsed.error ? [{ field: null, message: `contains invalid JSON: ${parsed.error.message}` }] : shapeFailures(parsed.config);
  if (failures.some(failure => failure.field === null)) {
    const detail = failures[0].message;
    if (!recoverInvalid) throw new Error(`MCP config ${path} ${detail}`);
    return recoverConfig(path, buffer, warnings, {
      kind: 'invalid',
      notes: [`was not usable as JSON (${detail.replace(/^contains invalid JSON: /, '')}) and was replaced with a fresh config`],
      config: freshConfig()
    });
  }
  const blocking = failures.find(failure => failure.field !== 'inputs');
  if (!recoverInvalid) {
    if (blocking) throw new Error(`MCP config ${path} ${blocking.message}`);
    return { ...parsed.config, servers: parsed.config.servers || {} };
  }
  const notes = [];
  if (loosened) notes.push('contained comments or trailing commas (accepted by VS Code, not strict JSON)');
  const healed = { ...parsed.config };
  for (const failure of failures) {
    if (failure.field === 'servers') { healed.servers = {}; notes.push('had a non-object "servers" value, which was reset'); }
    if (failure.field === 'inputs') { delete healed.inputs; notes.push('had a non-array "inputs" value, which was removed'); }
  }
  if (!notes.length) return { ...parsed.config, servers: parsed.config.servers || {} };
  return recoverConfig(path, buffer, warnings, {
    kind: loosened ? 'healed' : 'repaired',
    notes,
    config: { ...healed, servers: healed.servers || {} }
  });
}

async function recoverConfig(path, buffer, warnings, { kind, notes, config }) {
  // Back up beside the real file (following symlinks) so a linked mcp.json
  // keeps its link and the backup sits next to the actual target.
  const backupBase = await realpath(path).catch(() => path);
  const backup = await writeConfigBackup(backupBase, buffer, { kind });
  warnings?.push(`The existing MCP config ${notes.join(' and ')}; the original was backed up to ${backup}.`);
  return config;
}

async function writeConfig(path, config) {
  // Follow symlinks so a linked mcp.json (dotfiles managers) keeps its link
  // while the real target is replaced atomically.
  const target = await realpath(path).catch(() => path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`MCP config ${path} could not be written: ${error.message}`);
  }
}

export async function installMcpConfig(destinationsOrOptions, options = {}) {
  let destinations = destinationsOrOptions;
  if (!Array.isArray(destinationsOrOptions)) {
    destinations = destinationsOrOptions?.destinations || [];
    options = destinationsOrOptions || {};
  }
  const env = options.env || process.env;
  const path = options.path || await resolveMcpConfigPath(env);
  const installWarnings = [];
  // recoverInvalid: BOM/encoding damage, VS Code JSONC comments, torn writes
  // racing an editor save, and corrupt configs are healed (with a backup)
  // instead of failing the whole setup (self-healing).
  const config = await readConfig(path, { recoverInvalid: true, warnings: installWarnings });
  const selfVersion = await runningPackageVersion();
  const companionVersions = selfVersion ? { 'sap-ai-dev-toolkit': selfVersion, 'hana-cloud-inspector': selfVersion } : {};
  const generated = {
    ...buildMcpEntries(destinations, env),
    ...buildSapDevelopmentMcpEntries(options.sapDevelopmentServers || [], { packageVersions: companionVersions })
  };
  const generatedInputs = new Map();
  for (const destination of destinations) {
    for (const input of Array.isArray(destination?.inputs) ? destination.inputs : []) {
      if (input?.id) generatedInputs.set(input.id, input);
    }
  }
  let launcherCommand = options.command || null;
  let launcherArgs = options.command ? options.args : null;
  if (!launcherCommand && destinations.length) {
    const resolved = await resolveLauncherInstallCommand(env);
    launcherCommand = resolved.command;
    launcherArgs = resolved.args;
    if (resolved.warning) installWarnings.push(resolved.warning);
  }
  if (launcherCommand) {
    for (const entry of Object.values(generated)) {
      if (isCompanionServer(entry)) continue;
      entry.command = launcherCommand;
      if (launcherArgs?.length) entry.args = [...launcherArgs];
      if (selfVersion) entry.env.SAP_AI_DEV_TOOLKIT_VERSION = selfVersion;
    }
  }
  const servers = Object.create(null);
  const managedInputIds = new Set();
  for (const [name, entry] of Object.entries(config.servers)) {
    const managed = isPackageLauncher(entry)
      && typeof destinationValue(entry?.env) === 'string'
      && (destinationSource(entry.env) === 'cloud-foundry'
        ? typeof entry.env.BAS_CF_DESTINATION_KEY === 'string'
        : (destinationSource(entry.env) === undefined || destinationSource(entry.env) === 'sap-gui-local'));
    if (managed && destinationSource(entry.env) === 'sap-gui-local') {
      for (const value of Object.values(entry.env || {})) {
        const match = typeof value === 'string' ? value.match(/^\$\{input:([^}]+)}$/) : null;
        if (match) managedInputIds.add(match[1]);
      }
    }
    if (!LEGACY_MCP_SERVER_PREFIXES.some(prefix => name.startsWith(prefix)) && !managed && !isCompanionServer(entry)) servers[name] = entry;
  }
  for (const name of Object.keys(generated)) {
    if (Object.hasOwn(servers, name)) {
      throw new Error(`MCP server "${name}" already exists and is not managed by sap-ai-dev-toolkit`);
    }
  }
  config.servers = { ...servers, ...generated };
  if (generatedInputs.size || managedInputIds.size) {
    const existingInputs = Array.isArray(config.inputs) ? config.inputs.filter(input => !generatedInputs.has(input?.id) && !managedInputIds.has(input?.id)) : [];
    config.inputs = [...existingInputs, ...generatedInputs.values()];
  }
  await writeConfig(path, config);
  return { path, servers: generated, warnings: installWarnings };
}

export async function repairManagedMcpConfig(discoveredDestinations, { env = process.env, path, discoveryComplete = false, packageVersion } = {}) {
  const configPath = path || await resolveMcpConfigPath(env);
  if (!discoveryComplete) {
    return { path: configPath, changed: false, repaired: 0, skipped: 'Destination discovery was incomplete.' };
  }
  if (!Array.isArray(discoveredDestinations)) throw new Error('Destination discovery result must be an array');
  const basDestinations = new Map(discoveredDestinations
    .filter(destination => destination?.source !== 'cloud-foundry' && destination?.name)
    .map(destination => [String(destination.name), destination]));
  const config = await readConfig(configPath);
  const managedEntries = Object.values(config.servers).filter(isManagedBasDestinationEntry).length;
  if (!basDestinations.size) return { path: configPath, changed: false, repaired: 0, managedEntries };
  const localLauncher = await resolveLauncherInstallCommand(env);
  let repaired = 0;
  for (const [serverName, entry] of Object.entries(config.servers)) {
    if (!isManagedBasDestinationEntry(entry)) continue;
    const destinationName = destinationValue(entry.env);
    const destination = basDestinations.get(destinationName);
    if (!destination) continue;
    const expectedName = generatedDestinationServerName(destination);
    if (expectedName !== serverName) {
      // Legacy mixed-case entries migrate to the normalized lowercase key.
      // A user-owned entry on the target key blocks the rename; merging is
      // only safe onto another managed entry for the same destination.
      const target = config.servers[expectedName];
      const targetMergable = isManagedBasDestinationEntry(target) && destinationValue(target.env) === destinationName;
      if (Object.hasOwn(config.servers, expectedName) && !targetMergable) continue;
    }
    const expected = buildMcpEntries([destination], env)[expectedName];
    const nextEnvironment = { ...entry.env, ...expected.env };
    if (Object.hasOwn(entry.env, 'SAP_ALLOW_TRANSPORTABLE_EDITS')) {
      nextEnvironment.SAP_ALLOW_TRANSPORTABLE_EDITS = entry.env.SAP_ALLOW_TRANSPORTABLE_EDITS;
    }
    delete nextEnvironment.BAS_VSP_DESTINATION;
    delete nextEnvironment.BAS_VSP_DESTINATION_SOURCE;
    const nextEntry = { ...entry, type: 'stdio', env: nextEnvironment, BAS_EXT: 'true' };
    if (npxLaunchArgs(entry) !== null) {
      if (packageVersion && Array.isArray(entry.args)) {
        nextEntry.args = entry.args.map(argument => typeof argument === 'string' && /^--package=sap-ai-dev-toolkit(?:@[^/]+)?$/.test(argument)
          ? `--package=sap-ai-dev-toolkit@${packageVersion}`
          : argument);
      }
    } else {
      nextEntry.command = localLauncher.command;
      if (localLauncher.args) nextEntry.args = [...localLauncher.args];
      else delete nextEntry.args;
    }
    if (expectedName === serverName) {
      if (JSON.stringify(nextEntry) === JSON.stringify(entry)) continue;
      config.servers[serverName] = nextEntry;
    } else {
      delete config.servers[serverName];
      config.servers[expectedName] = nextEntry;
    }
    repaired += 1;
  }

  if (!repaired) return { path: configPath, changed: false, repaired: 0, managedEntries };
  await writeConfig(configPath, config);
  return { path: configPath, changed: true, repaired, managedEntries };
}

export async function readMcpConfig(path, options = {}) {
  return readConfig(path, options);
}
