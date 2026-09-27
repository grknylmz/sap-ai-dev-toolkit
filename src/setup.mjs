import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { checkboxPrompt, colorText, formatStatus, textPrompt } from './terminal-ui.mjs';
import { discoverDestinations, remediation } from './bas-discovery.mjs';
import { discoverCloudFoundryDestinations, getCloudFoundryTarget, deleteManagedCloudFoundryServiceKeys } from './cf-destination.mjs';
import { SAP_DEVELOPMENT_MCP_SERVERS, collectCloudFoundryKeyReferencesFromAllEntries, collectManagedCloudFoundryKeyReferences, installMcpConfig, readMcpConfig, resolveMcpConfigPath } from './mcp-config.mjs';
import { readCredentials, removeDestinationCredentials, resolveCredentialsPath, storeDestinationCredentials } from './credentials-store.mjs';

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

// Internet destinations reach SAP through the BAS .dest proxy, which strips
// Set-Cookie and makes ADT CSRF-protected writes impossible. Ask once for
// direct-connection credentials and store them next to the MCP config; the
// relay then connects straight to the backend host with Basic auth.
async function promptForInternetDestinationCredentials({ destinations, credentialsPath, existing = {}, input = stdin, output = stdout } = {}) {
  const stored = {};
  const internetDestinations = destinations.filter(destination =>
    destination.source !== 'cloud-foundry'
    && String(destination.proxyType || '').toLowerCase() === 'internet'
    && /^basicauthentication$/i.test(String(destination.authentication || '')));
  if (!internetDestinations.length) return stored;

  print(output, '');
  print(output, formatStatus('Some selected destinations are Internet type with basic authentication.', 'step', output, 'Direct connect'));
  print(output, '  The BAS proxy strips SAP session cookies, which blocks ADT writes (CSRF validation).');
  print(output, '  Providing a user and password enables a direct connection for those destinations.');
  print(output, `  Credentials are stored beside your MCP config in ${credentialsPath} (never inside mcp.json).`);
  print(output, '');

  for (const destination of internetDestinations) {
    const known = existing[destination.name];
    if (known?.user && known?.password) {
      print(output, formatStatus(`Credentials for ${destination.name} are already stored (user ${known.user}). Press Enter at both prompts to keep them.`, 'info', output, 'Direct connect'));
    }
    const userAnswer = await textPrompt({
      message: colorText(`👤 ${destination.name} — SAP user`, 'cyan', output),
      required: false,
      placeholder: known ? `${known.user} (Enter keeps stored user)` : 'SAP user name'
    }, { input, output });
    const user = userAnswer.trim() || known?.user || '';
    const passwordAnswer = await textPrompt({
      message: colorText(`🔒 ${destination.name} — SAP password${known ? ' (Enter keeps stored password)' : ''}`, 'cyan', output),
      secret: true,
      required: false
    }, { input, output });
    const password = passwordAnswer || known?.password || '';
    if (!user || !password) {
      print(output, formatStatus(`No complete credentials for ${destination.name}; direct connect stays inactive for it.`, 'warning', output, 'Direct connect'));
      continue;
    }
    stored[destination.name] = {
      host: destination.backendUrl || known?.host || '',
      user,
      password
    };
    print(output, formatStatus(`Stored credentials for ${destination.name}.`, 'success', output, 'Direct connect'));
  }
  return stored;
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
    const detail = entry.env?.BAS_VSP_DESTINATION
      ? `destination: ${entry.env.BAS_VSP_DESTINATION}`
      : (entry.displayName ? `tool server: ${entry.displayName}` : 'tool server');
    print(output, `  • ${name} — ${detail}`);
  }
  print(output, formatStatus('Open the Command Palette → “MCP: List Servers”, select a generated server, and choose “Start Server”.', 'step', output, 'Next'));
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
  const credentialWarnings = [];
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
    print(output, formatStatus('Optionally add companion MCP servers for full-stack SAP development.', 'step', output, 'Tools'));
    print(output, '  Recommended for RAP/Fiori/CAP/UI validation work. Leave empty to only configure ABAP/ADT destination servers.');
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

  // Ask for direct-connect credentials for selected Internet destinations
  // so ADT writes work despite the BAS proxy stripping session cookies.
  const credentialsPath = await resolveCredentialsPath(env, configPath);
  const internetSelected = selected.filter(destination =>
    destination.source !== 'cloud-foundry'
    && String(destination.proxyType || '').toLowerCase() === 'internet'
    && /^basicauthentication$/i.test(String(destination.authentication || '')));
  if (internetSelected.length) {
    try {
      const existingMap = (await readCredentials(credentialsPath).catch(() => ({ destinations: {} }))).destinations || {};
      const storedNow = await promptForInternetDestinationCredentials({
        destinations: selected,
        credentialsPath,
        existing: existingMap,
        input,
        output
      });
      for (const [name, entry] of Object.entries(storedNow)) {
        await storeDestinationCredentials(credentialsPath, name, entry);
      }
      // Remove stored credentials for Internet destinations that are no
      // longer selected, so the file only tracks active servers.
      const stillSelected = new Set(selected.map(destination => destination.name));
      const stale = Object.keys(existingMap)
        .filter(name => !stillSelected.has(name))
        .filter(name => internetSelected.every(destination => destination.name !== name));
      if (stale.length) await removeDestinationCredentials(credentialsPath, stale);
    } catch (error) {
      if (/Prompt interrupted/.test(error.message)) throw error;
      credentialWarnings.push(`Direct-connect credentials could not be stored: ${error.message}`);
    }
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
    await reportWarnings(credentialWarnings);
    await reportWarnings(cleanupWarnings);
    return { selected, ...(result || {}), warnings: [...warnings, ...credentialWarnings, ...cleanupWarnings] };
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
