import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { brandedEnvValue } from './branding.mjs';

const LEGACY_MCP_SERVER_PREFIXES = ['sapAiDev_', 'basVspMcp_'];
const COMPANION_SERVER_KIND = 'sap-development-companion';

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

export async function resolveMcpServerCommand(env = process.env) {
  const executableNames = process.platform === 'win32'
    ? ['sap-ai-dev.cmd', 'sap-ai-dev.exe', 'sap-ai-dev']
    : ['sap-ai-dev'];
  const searchPath = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  for (const directory of searchPath) {
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

export async function resolveMcpConfigPath(env = process.env) {
  const configuredPath = [env.SAP_AI_DEV_MCP_CONFIG, brandedEnvValue(env, 'MCP_CONFIG')]
    .find(value => typeof value === 'string' && value.length > 0);
  if (configuredPath) return configuredPath;
  const home = env.HOME || homedir();
  const candidates = [
    join(home, '.vscode', 'data', 'User', 'mcp.json'),
    join(home, '.vscode-server', 'data', 'User', 'mcp.json'),
    join(home, '.code-server', 'data', 'User', 'mcp.json')
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates[0];
}

export function generatedServerName(destinationName) {
  return String(destinationName);
}

export function buildSapDevelopmentMcpEntries(serverIds = SAP_DEVELOPMENT_MCP_SERVERS.map(server => server.id), { packageVersions = {}, packageManager = 'npx' } = {}) {
  const selected = new Set(serverIds);
  const entries = Object.create(null);
  for (const server of SAP_DEVELOPMENT_MCP_SERVERS) {
    if (!selected.has(server.id)) continue;
    const packageSpec = packageVersions[server.id] || packageVersions[server.packageName] || server.packageName;
    entries[server.id] = {
      type: 'stdio',
      command: packageManager,
      args: ['--yes', ...(server.ignoreScripts ? ['--ignore-scripts'] : []), `--package=${packageSpec}`, server.bin],
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
  if (!h2oUrl) throw new Error('H2O_URL is required to write SAP AI Dev Toolkit configuration');
  const entries = Object.create(null);
  const selected = [...destinations].sort((a, b) => String(a.serverName || a.name).localeCompare(String(b.serverName || b.name)));
  for (const destination of selected) {
    const isCf = destination.source === 'cloud-foundry';
    const name = generatedServerName(isCf ? destination.serverName : destination.name);
    if (Object.hasOwn(entries, name)) throw new Error(`Duplicate MCP destination server name: ${name}`);
    const entryEnv = {
      H2O_URL: String(h2oUrl),
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
  const hasPackage = patterns => Array.isArray(entry?.args)
    && entry.args.some(argument => typeof argument === 'string' && patterns.some(pattern => pattern.test(argument)));
  const currentNpxLauncher = entry?.command === 'npx'
    && Array.isArray(entry.args)
    && entry.args.some(argument => currentCommands.has(argument))
    && hasPackage(currentPackages);
  const legacyNpxLauncher = entry?.command === 'npx'
    && Array.isArray(entry.args)
    && entry.args.some(argument => legacyCommands.has(argument))
    && hasPackage(legacyPackages);
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
  const currentNpxLauncher = entry?.command === 'npx'
    && Array.isArray(entry.args)
    && entry.args.some(argument => currentCommands.has(argument))
    && entry.args.some(argument => typeof argument === 'string' && /^--package=sap-ai-dev-toolkit(?:@[^/]+)?$/.test(argument));
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

async function readConfig(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { servers: {}, inputs: [] };
    throw new Error(`MCP config ${path} could not be read: ${error.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MCP config ${path} contains invalid JSON: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`MCP config ${path} must contain a top-level JSON object`);
  }
  if (config.servers !== undefined && (!config.servers || typeof config.servers !== 'object' || Array.isArray(config.servers))) {
    throw new Error(`MCP config ${path} has a non-object servers value`);
  }
  return { ...config, servers: config.servers || {} };
}

async function writeConfig(path, config) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
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
  const config = await readConfig(path);
  const generated = {
    ...buildMcpEntries(destinations, env),
    ...buildSapDevelopmentMcpEntries(options.sapDevelopmentServers || [])
  };
  const launcherCommand = options.command || (destinations.length ? await resolveMcpServerCommand(env) : null);
  if (launcherCommand) {
    for (const entry of Object.values(generated)) {
      if (isCompanionServer(entry)) continue;
      entry.command = launcherCommand;
      if (options.command && options.args?.length) entry.args = [...options.args];
    }
  }
  const servers = Object.create(null);
  for (const [name, entry] of Object.entries(config.servers)) {
    const managed = isPackageLauncher(entry)
      && typeof destinationValue(entry?.env) === 'string'
      && (destinationSource(entry.env) === 'cloud-foundry'
        ? typeof entry.env.BAS_CF_DESTINATION_KEY === 'string'
        : destinationSource(entry.env) === undefined);
    if (!LEGACY_MCP_SERVER_PREFIXES.some(prefix => name.startsWith(prefix)) && !managed && !isCompanionServer(entry)) servers[name] = entry;
  }
  for (const name of Object.keys(generated)) {
    if (Object.hasOwn(servers, name)) {
      throw new Error(`MCP server "${name}" already exists and is not managed by sap-ai-dev-toolkit`);
    }
  }
  config.servers = { ...servers, ...generated };
  await writeConfig(path, config);
  return { path, servers: generated };
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
  const localCommand = await resolveMcpServerCommand(env);
  let repaired = 0;
  for (const [serverName, entry] of Object.entries(config.servers)) {
    if (!isManagedBasDestinationEntry(entry)) continue;
    const destinationName = destinationValue(entry.env);
    if (generatedServerName(destinationName) !== serverName) continue;
    const destination = basDestinations.get(destinationName);
    if (!destination) continue;
    const expected = buildMcpEntries([destination], env)[serverName];
    const nextEnvironment = { ...entry.env, ...expected.env };
    if (Object.hasOwn(entry.env, 'SAP_ALLOW_TRANSPORTABLE_EDITS')) {
      nextEnvironment.SAP_ALLOW_TRANSPORTABLE_EDITS = entry.env.SAP_ALLOW_TRANSPORTABLE_EDITS;
    }
    delete nextEnvironment.BAS_VSP_DESTINATION;
    delete nextEnvironment.BAS_VSP_DESTINATION_SOURCE;
    const nextEntry = { ...entry, type: 'stdio', env: nextEnvironment, BAS_EXT: 'true' };
    if (entry.command === 'npx') {
      if (packageVersion && Array.isArray(entry.args)) {
        nextEntry.args = entry.args.map(argument => typeof argument === 'string' && /^--package=sap-ai-dev-toolkit(?:@[^/]+)?$/.test(argument)
          ? `--package=sap-ai-dev-toolkit@${packageVersion}`
          : argument);
      }
    } else {
      nextEntry.command = localCommand;
    }
    if (JSON.stringify(nextEntry) === JSON.stringify(entry)) continue;
    config.servers[serverName] = nextEntry;
    repaired += 1;
  }

  if (!repaired) return { path: configPath, changed: false, repaired: 0, managedEntries };
  await writeConfig(configPath, config);
  return { path: configPath, changed: true, repaired, managedEntries };
}

export async function readMcpConfig(path) {
  return readConfig(path);
}
