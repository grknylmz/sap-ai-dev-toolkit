import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { checkboxPrompt, colorText, formatStatus } from './terminal-ui.mjs';
import { discoverDestinations, remediation } from './bas-discovery.mjs';
import { discoverCloudFoundryDestinations, getCloudFoundryTarget, deleteManagedCloudFoundryServiceKeys, findOrphanedCloudFoundryServiceKeys } from './cf-destination.mjs';
import { SAP_DEVELOPMENT_MCP_SERVERS, collectCloudFoundryKeyReferencesFromAllEntries, collectManagedCloudFoundryKeyReferences, installMcpConfig, readMcpConfig, resolveMcpConfigPath } from './mcp-config.mjs';

const SETUP_COMMAND = 'sap-ai-dev --setup';

function print(output, message) {
  output.write(`${message}\n`);
}


async function confirmCloudFoundryImport({ input = stdin, output = stdout } = {}) {
  const readline = createInterface({ input, output });
  try {
    print(output, formatStatus("Optional import from the current space's Destination service.", 'step', output, 'Cloud Foundry'));
    const answer = await readline.question("Include destinations from the current CF space's Destination service? (y + Enter = import; Enter = skip) ");
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}


function safeProbe(probe) {
  const result = {};
  if (typeof probe?.status === 'string') result.status = probe.status;
  if (typeof probe?.available === 'boolean') result.available = probe.available;
  if (Number.isFinite(probe?.httpStatus)) result.httpStatus = probe.httpStatus;
  return result;
}

function safeBasDestination(destination) {
  return {
    source: 'bas',
    name: destination.name,
    serverName: destination.name,
    url: destination.url,
    client: destination.client,
    authentication: destination.authentication,
    proxyType: destination.proxyType,
    backendUrl: destination.backendUrl || null,
    probe: safeProbe(destination.probe)
  };
}

function safeCloudFoundryDestination(destination) {
  const cf = destination.cf || {};
  return {
    source: 'cloud-foundry',
    name: destination.name,
    serverName: destination.serverName,
    client: destination.client,
    authentication: destination.authentication,
    proxyType: destination.proxyType,
    probe: safeProbe(destination.probe),
    cf: {
      spaceGuid: cf.spaceGuid,
      destinationInstanceGuid: cf.destinationInstanceGuid,
      destinationInstanceName: cf.destinationInstanceName,
      destinationKeyName: cf.destinationKeyName,
      ...(cf.connectivityInstanceGuid ? {
        connectivityInstanceGuid: cf.connectivityInstanceGuid,
        connectivityInstanceName: cf.connectivityInstanceName,
        connectivityKeyName: cf.connectivityKeyName
      } : {})
    },
    ...(destination.disabledReason ? { disabledReason: destination.disabledReason } : {})
  };
}

function printConnectionInstructions(output, result) {
  const servers = Object.entries(result?.servers || {});
  if (!servers.length) {
    print(output, '');
    print(output, formatStatus('No destinations were selected; no MCP servers were added.', 'info', output, 'SAP AI Dev Toolkit'));
    return;
  }
  print(output, '');
  print(output, colorText('📡 MCP servers now available:', 'cyan', output));
  for (const [name, entry] of servers) {
    const destinationName = entry.env?.SAP_AI_DEV_TOOLKIT_DESTINATION || entry.env?.BAS_VSP_DESTINATION;
    const detail = destinationName
      ? `destination: ${destinationName}`
      : (entry.displayName ? `tool server: ${entry.displayName}` : 'tool server');
    print(output, `  • ${name} — ${detail}`);
  }
  print(output, formatStatus('Open the Command Palette → “MCP: List Servers”, select a generated server, and choose “Start Server”.', 'step', output, 'Next'));
  print(output, formatStatus('In GitHub Copilot Chat, select an agent, open the Chat tools picker, and enable each selected destination server for this chat.', 'step', output, 'Copilot Chat'));
  print(output, formatStatus('Inspect or edit entries with “MCP: Open User Configuration”.', 'info', output, 'Config'));
}


export async function runSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  discover = discoverDestinations,
  discoverCf = discoverCloudFoundryDestinations,
  confirmCfImport = confirmCloudFoundryImport,
  install = installMcpConfig,
  includeSapDevelopmentToolsPrompt = false
} = {}) {
  if (!env.H2O_URL) {
    print(output, formatStatus(`Setup skipped: H2O_URL is not set. Run ${SETUP_COMMAND} in a BAS dev space.`, 'info', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-bas' };
  }
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus(`Interactive setup needs a terminal. Rerun ${SETUP_COMMAND} from a BAS terminal.`, 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  print(output, '');
  print(output, formatStatus('Contacting BAS to discover destinations; this may take a moment.', 'progress', output, 'Setup'));

  let basDestinations;
  try {
    basDestinations = await discover({ env: { ...env, SAP_AI_DEV_TOOLKIT_DESTINATION: '' } });
  } catch (error) {
    throw new Error(`BAS discovery failed: ${error.message}`);
  }
  const destinations = basDestinations.map(safeBasDestination);
  const warnings = [];
  let createdKeys = [];
  let configPath;
  let managedKeys = [];
  try {
    configPath = await resolveMcpConfigPath(env);
    managedKeys = collectManagedCloudFoundryKeyReferences(await readMcpConfig(configPath));
  } catch {
    warnings.push('Existing MCP config could not be read before setup; existing CF service keys will not be reused.');
  }

  const target = await getCloudFoundryTarget({ env });
  if (!target.available) {
    warnings.push(target.reason);
  } else {
    // Sweep for service keys this toolkit created but no config references
    // (an interrupted earlier setup leaves them behind; a Destination key
    // exposes credentials for every destination in its instance).
    try {
      const orphans = await findOrphanedCloudFoundryServiceKeys({ env, spaceGuid: target.spaceGuid, managedKeys });
      if (orphans.length) {
        print(output, '');
        print(output, formatStatus(`Found ${orphans.length} unreferenced sap-ai-dev-toolkit service key${orphans.length === 1 ? '' : 's'} in this CF space:`, 'warning', output, 'Cloud Foundry'));
        for (const orphan of orphans.slice(0, 5)) print(output, `  • ${orphan.keyName} on ${orphan.instanceName}`);
        const readline = createInterface({ input, output });
        let removeOrphans = false;
        try {
          const answer = await readline.question('Delete these unreferenced service keys? (y + Enter = delete; Enter = keep) ');
          removeOrphans = /^y(?:es)?$/i.test(answer.trim());
        } finally {
          readline.close();
        }
        if (removeOrphans) {
          const result = await deleteManagedCloudFoundryServiceKeys({ env, keys: orphans });
          warnings.push(...(result.warnings || []));
          const deleted = orphans.length - (result.warnings || []).length;
          print(output, formatStatus(`Removed ${deleted} unreferenced service key${deleted === 1 ? '' : 's'}.`, 'success', output, 'Cloud Foundry'));
        } else {
          warnings.push(`${orphans.length} unreferenced sap-ai-dev-toolkit service key${orphans.length === 1 ? '' : 's'} were kept; review them with "cf service-keys" and delete manually if unwanted.`);
        }
      }
    } catch {
      // The sweep is best-effort; a failed lookup must not block setup.
    }
    let shouldImport = false;
    try {
      shouldImport = await confirmCfImport({ input, output });
    } catch {
      warnings.push('Cloud Foundry import prompt failed; CF destinations were skipped.');
    }
    if (shouldImport) {
      print(output, formatStatus('Reading destinations from Cloud Foundry.', 'progress', output, 'Cloud Foundry'));
      try {
        const result = await discoverCf({ env, input, output, spaceGuid: target.spaceGuid, managedKeys });
        createdKeys = Array.isArray(result?.createdKeys) ? result.createdKeys : [];
        const cfDestinations = Array.isArray(result?.destinations) ? result.destinations : [];
        destinations.push(...cfDestinations.map(safeCloudFoundryDestination));
        warnings.push(...(Array.isArray(result?.warnings) ? result.warnings.filter(value => typeof value === 'string') : []));
      } catch {
        warnings.push('Cloud Foundry import failed; SAP AI Dev Toolkit setup can continue.');
      }
    } else if (!warnings.some(message => message.includes('Cloud Foundry import prompt failed'))) {
      warnings.push('Cloud Foundry destinations were skipped because import was not confirmed.');
    }
  }

  const reportWarnings = async messages => {
    for (const message of messages) print(output, formatStatus(message, 'warning', output, 'Warning'));
  };
  const cleanupKeys = async (keys, config) => {
    const referenced = collectCloudFoundryKeyReferencesFromAllEntries(config);
    const referenceIds = new Set(referenced.map(reference => `${reference.kind}\0${reference.spaceGuid}\0${reference.instanceGuid}\0${reference.keyName}`));
    const candidates = keys.filter(key => !referenceIds.has(`${key.kind}\0${key.spaceGuid}\0${key.instanceGuid}\0${key.keyName}`));
    if (!candidates.length) return [];
    const result = await deleteManagedCloudFoundryServiceKeys({ env, keys: candidates });
    return result.warnings || [];
  };
  const cleanupNewKeysWithoutConfigChange = async () => {
    if (!createdKeys.length) return [];
    const result = await deleteManagedCloudFoundryServiceKeys({ env, keys: createdKeys });
    return result.warnings || [];
  };
  const selectable = destinations.filter(destination => !destination.disabledReason);
  if (!selectable.length) {
    print(output, formatStatus('No selectable BAS or Cloud Foundry destinations were found.', 'warning', output, 'Setup'));
    print(output, remediation);
    await reportWarnings(warnings);
    const cleanupWarnings = await cleanupNewKeysWithoutConfigChange();
    await reportWarnings(cleanupWarnings);
    return { skipped: true, reason: 'no-destinations', warnings: [...warnings, ...cleanupWarnings] };
  }

  const orderedDestinations = [...destinations].sort((left, right) => {
    const leftRank = left.disabledReason ? 2 : (left.probe?.available === false ? 1 : 0);
    const rightRank = right.disabledReason ? 2 : (right.probe?.available === false ? 1 : 0);
    return leftRank - rightRank || String(left.name).localeCompare(String(right.name));
  });
  const choices = orderedDestinations.map(destination => {
    const probe = destination.probe?.status || 'unknown';
    const source = destination.source === 'cloud-foundry'
      ? `CF ${destination.cf.destinationInstanceName}`
      : 'BAS';
    const disabled = destination.disabledReason;
    const state = disabled ? 'disabled' : (destination.probe?.available === false ? `fail:${probe}` : `ok:${probe}`);
    return {
      value: destination,
      name: `${destination.name} (${source}, client ${destination.client}, ${state})`,
      ...(disabled ? { disabled } : {}),
      checked: false
    };
  });
  print(output, '');
  print(output, formatStatus('Choose the destinations to add. Reachable destinations are shown first.', 'step', output, 'Setup'));
  print(output, '');
  print(output, '  Space = select/deselect · a = toggle all · Enter = confirm.');
  print(output, '  Nothing selected removes this add-on’s MCP entries.');
  print(output, '');
  const selected = await checkboxPrompt({
    message: colorText('🧭 Select destinations', 'cyan', output),
    choices,
    required: false,
    shortcuts: { all: 'a' }
  }, { input, output });

  let sapDevelopmentServers = [];
  if (includeSapDevelopmentToolsPrompt) {
    print(output, '');
    print(output, formatStatus('Optionally add companion MCP servers for full-stack SAP development and HANA inspection.', 'step', output, 'Tools'));
    print(output, '  HANA Cloud inspector is read-only and uses HANA_RO_* or VCAP_SERVICES already present in the MCP host environment; credentials are not written to mcp.json.');
    print(output, '  Leave empty to only configure ABAP/ADT destination servers.');
    print(output, '');
    sapDevelopmentServers = await checkboxPrompt({
      message: colorText('🧰 Select companion tools', 'cyan', output),
      choices: SAP_DEVELOPMENT_MCP_SERVERS.map(server => ({
        value: server.id,
        name: `${server.name} — ${server.description}`,
        checked: false
      })),
      required: false,
      shortcuts: { all: 'a' }
    }, { input, output });
  }

  try {
    const result = await install(selected, { env, sapDevelopmentServers });
    const location = result?.path ? ` in ${result.path}` : '';
    print(output, '');
    const configuredCount = selected.length + sapDevelopmentServers.length;
    print(output, formatStatus(`Configured ${configuredCount} MCP server${configuredCount === 1 ? '' : 's'}${location}.`, 'success', output, 'BAS setup'));
    printConnectionInstructions(output, result);
    let cleanupWarnings = [];
    const finalPath = result?.path || configPath;
    if (!finalPath) {
      cleanupWarnings.push('CF service-key cleanup skipped because the final MCP config path is unavailable.');
    } else {
      try {
        const finalConfig = await readMcpConfig(finalPath);
        cleanupWarnings = await cleanupKeys([...managedKeys, ...createdKeys], finalConfig);
      } catch {
        cleanupWarnings.push('CF service-key cleanup skipped because the final MCP config could not be read.');
      }
    }
    await reportWarnings(warnings);
    await reportWarnings(cleanupWarnings);
    return { selected, ...(result || {}), warnings: [...warnings, ...cleanupWarnings] };
  } catch (error) {
    const cleanupWarnings = [];
    if (createdKeys.length) {
      const finalPath = configPath;
      if (!finalPath) {
        cleanupWarnings.push('CF service-key cleanup skipped because the MCP config path is unavailable.');
      } else {
        try {
          const actualConfig = await readMcpConfig(finalPath);
          cleanupWarnings.push(...await cleanupKeys(createdKeys, actualConfig));
        } catch {
          cleanupWarnings.push('CF service-key cleanup skipped because the MCP config could not be read.');
        }
      }
    }
    await reportWarnings([...warnings, ...cleanupWarnings]);
    throw new Error(`MCP config writing failed: ${error.message}`);
  }
}
