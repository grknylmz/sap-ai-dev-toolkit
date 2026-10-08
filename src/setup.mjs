import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { platform } from 'node:os';
import { isIP } from 'node:net';
import { checkboxPrompt, colorText, formatStatus, selectPrompt, startProgress, textPrompt } from './terminal-ui.mjs';
import { discoverDestinations, remediation } from './bas-discovery.mjs';
import { defaultAdtUrl, discoverSapGuiSystems, hasExplicitPort } from './local-sap-gui.mjs';
import { discoverCloudFoundryDestinations, getCloudFoundryTarget, deleteManagedCloudFoundryServiceKeys, findOrphanedCloudFoundryServiceKeys } from './cf-destination.mjs';
import { SAP_DEVELOPMENT_MCP_SERVERS, collectCloudFoundryKeyReferencesFromAllEntries, collectManagedCloudFoundryKeyReferences, installMcpConfig, readMcpConfig, resolveMcpConfigPath } from './mcp-config.mjs';
import { discoverCertificateDnsNames } from './tls-adt-proxy.mjs';

const SETUP_COMMAND = 'sap-ai-dev --setup';

function print(output, message) {
  output.write(`${message}\n`);
}

function startSapGuiLandscapeAnimation(output, env = process.env) {
  if (!output?.isTTY || !Number.isFinite(output?.columns)) return () => {};
  if (env.TERM === 'dumb' || env.CI || env.SAP_AI_DEV_TOOLKIT_DISABLE_SCAN_ANIMATION === 'true') return () => {};
  const frames = [
    '=^.^=                         ~(o:>',
    '  =^.^=                    ~(o:>',
    '     =^.^=              ~(o:>',
    '        =^.^=        ~(o:>',
    '           =^.^=  ~(o:>',
    '             =^.^= caught it!'
  ];
  let index = 0;
  let active = false;
  const render = () => {
    active = true;
    const columns = Math.max(20, output.columns || 80);
    const frame = frames[index % frames.length];
    index += 1;
    const line = `Scanning SAP GUI landscapes ${frame}`.slice(0, Math.max(1, columns - 1));
    output.write(`\r\u001b[2K${line}`);
  };
  const delay = setTimeout(() => {
    render();
    interval = setInterval(render, 160);
    if (typeof interval.unref === 'function') interval.unref();
  }, 150);
  if (typeof delay.unref === 'function') delay.unref();
  let interval;
  return () => {
    clearTimeout(delay);
    if (interval) clearInterval(interval);
    if (active) output.write('\r\u001b[2K');
  };
}

function windowsSsoSetupAvailable(env = process.env) {
  return platform() === 'win32' || env.SAP_AI_DEV_TOOLKIT_ENABLE_WINDOWS_SSO_SETUP === 'true';
}

async function chooseLocalAuthMode(destination, { input = stdin, output = stdout, env = process.env } = {}) {
  if (!windowsSsoSetupAvailable(env)) return 'basic';
  return await selectPrompt({
    message: `Authentication for ${destination.name}`,
    defaultValue: 'sso',
    choices: [
      { name: 'Windows / smart card SSO (Edge signs in automatically)', value: 'sso', shortcut: 's' },
      { name: 'Username/password', value: 'basic', shortcut: 'p' }
    ]
  }, { input, output });
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

export function parseSapClientList(value, fallback = '001') {
  const supplied = String(value ?? '').trim();
  const raw = supplied || String(fallback || '001').trim() || '001';
  const clients = raw.split(',').map(client => client.trim()).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const client of clients) {
    if (!/^\d{3}$/.test(client)) throw new Error('Enter one or more SAP clients as 3 digits, separated by commas, for example 100 or 100,200.');
    if (!seen.has(client)) {
      seen.add(client);
      unique.push(client);
    }
  }
  if (!unique.length) throw new Error('Enter at least one SAP client.');
  return unique;
}

async function promptSapClients(destination, { input = stdin, output = stdout } = {}) {
  const fallback = destination.client || '001';
  const answer = await textPrompt({
    message: `SAP client(s) for ${destination.name}`,
    placeholder: fallback,
    required: false,
    validate: value => {
      try { parseSapClientList(value, fallback); return true; }
      catch (error) { return error.message; }
    }
  }, { input, output });
  return parseSapClientList(answer, fallback);
}

function validateAdtUrlCandidate(candidate) {
  if (!candidate) return 'Enter an ADT base URL, for example https://host:44300.';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Use an http:// or https:// URL.';
    if (parsed.username || parsed.password) return 'Do not embed credentials in the ADT URL; use the login prompts.';
    if (parsed.search || parsed.hash) return 'Enter an ADT base URL without a query or fragment.';
    return true;
  }
  catch { return 'Enter a valid URL.'; }
}

function localAuthenticationLabel(authMode) {
  return authMode === 'sso' ? 'SSO' : 'Basic';
}

// The SSO browser signs in on the ADT URL itself, and SAP GUI landscapes never
// carry the HTTP port, so a portless URL would send it to 443.
async function detectSsoAdtPort(destination, label, client, { output = stdout, env = process.env, detectAdtUrl } = {}) {
  if (!detectAdtUrl || hasExplicitPort(destination.url)) return;
  const stopProgress = startProgress(`Detecting the ADT port for ${label}`, { output, env, label: 'SSO' });
  let detected = '';
  try { detected = await detectAdtUrl({ url: destination.url, client }); }
  catch { detected = ''; }
  finally { stopProgress(); }
  if (detected) {
    destination.url = detected;
    print(output, formatStatus(`ADT answers at ${detected}; SSO signs in there.`, 'success', output, 'SSO'));
    return;
  }
  print(output, formatStatus(`No ADT port answered for ${label}; SSO keeps ${destination.url}. If the browser cannot reach it, rerun setup and enter the ADT URL with its port, for example ${new URL(destination.url).origin}:44300.`, 'warning', output, 'SSO'));
}

async function confirmPrompt(message, { input = stdin, output = stdout } = {}) {
  const answer = await textPrompt({
    message,
    placeholder: 'y',
    required: false,
    validate: value => /^(?:|y|yes|n|no)$/i.test(String(value || '').trim()) || 'Enter y or n.'
  }, { input, output });
  return !/^n(?:o)?$/i.test(String(answer || '').trim());
}

function buildLocalClientDestination(destination, client, authMode, { multipleClients = false, duplicateSystemName = false } = {}) {
  const name = localClientDestinationName(destination, client, { multipleClients, duplicateSystemName });
  const localDestination = { ...destination, name, serverName: name, client };
  const userInputId = `sap-ai-dev-${localDestination.serverName || localDestination.name}-user`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const passwordInputId = `sap-ai-dev-${localDestination.serverName || localDestination.name}-password`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const credentialInputs = [
    { id: userInputId, type: 'promptString', description: `SAP user for ${localDestination.name}` },
    { id: passwordInputId, type: 'promptString', description: `SAP password for ${localDestination.name}`, password: true }
  ];
  if (authMode === 'sso') {
    localDestination.childEnv = { SAP_AUTH_MODE: 'sso' };
    localDestination.inputs = [];
  } else {
    localDestination.childEnv = {
      SAP_AUTH_MODE: 'basic',
      SAP_USER: `\${input:${userInputId}}`,
      SAP_PASSWORD: `\${input:${passwordInputId}}`
    };
    localDestination.inputs = credentialInputs;
  }
  return localDestination;
}

async function maybeConfigureTlsSelfHeal(destination, promptLabel, { input = stdin, output = stdout } = {}) {
  const parsedAdtUrl = new URL(destination.url);
  if (parsedAdtUrl.protocol !== 'https:' || !isIP(parsedAdtUrl.hostname)) return;
  print(output, formatStatus('The ADT URL uses an IP address. Setup will inspect the SAP HTTPS certificate and can enable TLS self-healing automatically; certificate validation remains enabled.', 'warning', output, 'TLS self-heal'));
  let discoveredNames = [];
  try { discoveredNames = await discoverCertificateDnsNames(destination.url); }
  catch { discoveredNames = []; }
  if (!discoveredNames.length) {
    print(output, formatStatus('No DNS subjectAltName entries could be read from the SAP HTTPS certificate. TLS self-healing was not configured automatically.', 'warning', output, 'TLS self-heal'));
    return;
  }
  const preview = discoveredNames.slice(0, 5).join(', ');
  const useDiscovered = await confirmPrompt(`Use discovered certificate DNS name${discoveredNames.length === 1 ? '' : 's'} for ${promptLabel}: ${preview}${discoveredNames.length > 5 ? ', ...' : ''}? (y/Enter=yes, n=no)`, { input, output });
  if (useDiscovered) {
    destination.tlsServerNames = discoveredNames;
    destination.tlsServerName = discoveredNames[0];
  }
}

// Manual MCP entry wizard: offered whenever discovery finds nothing to select
// (no BAS destinations, no Cloud Foundry imports, no SAP GUI entries). It
// collects the minimal ADT configuration directly from the user and produces
// the same local destination shape as the SAP GUI flow, so installation,
// credential inputs, and TLS handling stay identical.
async function runManualEntryWizard({ env = process.env, input = stdin, output = stdout, detectAdtUrl } = {}) {
  print(output, '');
  print(output, colorText('✍️  Manual system entry — skip discovery, add your SAP system directly', 'magenta', output));
  print(output, colorText('   The ADT URL is the base URL that Eclipse ADT or VS Code ADT tools use, for example https://myhost.example:44300.', 'cyan', output));
  print(output, colorText('   Setup writes one isolated MCP server per system/client pair, with login prompts and TLS self-healing like every other entry.', 'cyan', output));
  const expanded = [];
  const usedNames = new Set();
  let addAnother = true;
  while (addAnother) {
    const name = (await textPrompt({
      message: 'System name',
      placeholder: 'S4H sandbox',
      required: true,
      validate: value => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return 'Enter a name for the system.';
        if (usedNames.has(trimmed.toLowerCase())) return 'A system with this name was already added; choose another name.';
        return true;
      }
    }, { input, output })).trim();
    usedNames.add(name.toLowerCase());
    const url = await textPrompt({
      message: `ADT URL for ${name}`,
      placeholder: 'https://host:44300',
      required: true,
      validate: validateAdtUrlCandidate
    }, { input, output });
    let parsedUrl;
    try { parsedUrl = new URL(url); }
    catch { parsedUrl = null; }
    const destination = {
      source: 'sap-gui-local',
      name,
      serverName: name,
      url,
      host: parsedUrl?.hostname || '',
      client: '001',
      authentication: 'Basic',
      authMode: 'basic',
      proxyType: 'Internet',
      // Marks wizard-configured systems so the discovery confirmation prompts
      // (clients, ADT URL, login) skip them when they flow through the
      // destination picker.
      configuredManually: true
    };
    await maybeConfigureTlsSelfHeal(destination, name, { input, output });
    const clients = await promptSapClients(destination, { input, output });
    const authMode = await chooseLocalAuthMode(destination, { input, output, env });
    if (authMode === 'sso') await detectSsoAdtPort(destination, name, clients[0], { output, env, detectAdtUrl });
    destination.authentication = localAuthenticationLabel(authMode);
    destination.authMode = authMode;
    for (const client of clients) {
      expanded.push(buildLocalClientDestination(destination, client, authMode, { multipleClients: clients.length > 1 }));
    }
    print(output, formatStatus(`Added ${name} (client${clients.length === 1 ? '' : 's'} ${clients.join(', ')}).`, 'success', output, 'Manual entry'));
    addAnother = await confirmPrompt('Add another system? (y/Enter=yes, n=no)', { input, output });
  }
  return expanded;
}

function localSystemDiscriminator(destination) {
  return [destination.systemId, destination.host, destination.instance].map(value => String(value || '').trim()).filter(Boolean).join(' ');
}

function localClientDestinationName(destination, client, { multipleClients = false, duplicateSystemName = false } = {}) {
  const suffix = [];
  if (multipleClients || duplicateSystemName) suffix.push(client);
  if (duplicateSystemName) {
    const discriminator = localSystemDiscriminator(destination);
    if (discriminator) suffix.push(discriminator);
  }
  return suffix.length ? `${destination.name} ${suffix.join(' ')}` : destination.name;
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

function safeLocalSapGuiDestination(destination) {
  return {
    source: 'sap-gui-local',
    name: destination.name,
    serverName: destination.serverName || destination.name,
    url: destination.url,
    host: destination.host,
    systemId: destination.systemId,
    instance: destination.instance,
    client: destination.client || '001',
    authentication: destination.authentication || 'Basic',
    authMode: destination.authMode,
    proxyType: 'Internet',
    tlsServerName: destination.tlsServerName,
    tlsServerNames: destination.tlsServerNames,
    probe: safeProbe(destination.probe),
    childEnv: destination.childEnv || {}
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


// Checkbox selection over the discovered destinations plus, outside BAS, the
// per-system confirmation prompts (clients, ADT URL, TLS self-heal, login).
async function chooseDiscoveredDestinations(destinations, { isBas, input = stdin, output = stdout, env = process.env, detectAdtUrl } = {}) {
  const orderedDestinations = [...destinations].sort((left, right) => {
    const leftRank = left.disabledReason ? 2 : (left.probe?.available === false ? 1 : 0);
    const rightRank = right.disabledReason ? 2 : (right.probe?.available === false ? 1 : 0);
    return leftRank - rightRank || String(left.name).localeCompare(String(right.name));
  });
  const choices = orderedDestinations.map(destination => {
    const probe = destination.probe?.status || 'unknown';
    const source = destination.source === 'cloud-foundry'
      ? `CF ${destination.cf.destinationInstanceName}`
      : (destination.source === 'sap-gui-local' ? `SAP GUI ${destination.systemId || destination.host || ''}`.trim() : 'BAS');
    const disabled = destination.disabledReason;
    const state = disabled ? 'disabled' : (probe === 'needs-adt-url' ? probe : (destination.probe?.available === false ? `fail:${probe}` : `ok:${probe}`));
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
  print(output, colorText('  Space = select/deselect · a = toggle all · m = add a system manually · Enter = confirm.', 'cyan', output));
  print(output, colorText('  💡 No system listed, or need an extra one? Press m to skip discovery and add any SAP system manually.', 'magenta', output));
  print(output, '');
  const addManually = async () => (await runManualEntryWizard({ env, input, output, detectAdtUrl })).map(destination => ({
    value: destination,
    name: `${destination.name} (manual, client ${destination.client})`
  }));
  let selected = await checkboxPrompt({
    message: colorText('🧭 Select destinations', 'cyan', output),
    choices,
    required: false,
    shortcuts: { all: 'a' },
    actions: { m: addManually },
    confirmEmpty: 'Press Enter again to continue with none (removes this add-on’s MCP entries).'
  }, { input, output });

  if (!isBas && selected.length) {
    print(output, '');
    print(output, formatStatus('SAP GUI landscapes do not contain ADT HTTP(S) endpoints or a complete client catalog. Confirm the SAP client(s), ADT URL, and authentication for each selected system.', 'step', output, 'Local SAP GUI'));
    print(output, '  Enter multiple clients as comma-separated 3-digit values, for example 100,200. Setup creates one isolated MCP server per system/client pair.');
    if (windowsSsoSetupAvailable(env)) print(output, '  Windows / smart card SSO signs in through Microsoft Edge (smart card, Kerberos or company login) and keeps the session refreshed; no password is stored.');
    const selectedNameCounts = selected.reduce((counts, destination) => {
      const key = String(destination.name).toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map());
    const expanded = [];
    for (const destination of selected) {
      // Wizard-configured systems are already complete; only discovered SAP
      // GUI entries need their clients, ADT URL, and login confirmed here.
      if (destination.configuredManually) {
        expanded.push(destination);
        continue;
      }
      const duplicateSystemName = (selectedNameCounts.get(String(destination.name).toLowerCase()) || 0) > 1;
      const discriminator = duplicateSystemName ? localSystemDiscriminator(destination) : '';
      const promptLabel = discriminator ? `${destination.name} (${discriminator})` : destination.name;
      const clients = await promptSapClients({ ...destination, name: promptLabel }, { input, output });
      const fallback = defaultAdtUrl(destination);
      const url = await textPrompt({
        message: `ADT URL for ${promptLabel}`,
        placeholder: fallback || 'https://host:44300',
        validate: value => validateAdtUrlCandidate(value || fallback),
        required: false
      }, { input, output });
      destination.url = url || fallback;
      await maybeConfigureTlsSelfHeal(destination, promptLabel, { input, output });
      const authMode = await chooseLocalAuthMode({ ...destination, name: promptLabel }, { input, output, env });
      if (authMode === 'sso') await detectSsoAdtPort(destination, promptLabel, clients[0], { output, env, detectAdtUrl });
      destination.authentication = localAuthenticationLabel(authMode);
      destination.authMode = authMode;
      for (const client of clients) {
        expanded.push(buildLocalClientDestination(destination, client, authMode, { multipleClients: clients.length > 1, duplicateSystemName }));
      }
    }
    selected = expanded;
  }
  return selected;
}

export async function runSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  discover = discoverDestinations,
  discoverCf = discoverCloudFoundryDestinations,
  discoverLocalSapGui = discoverSapGuiSystems,
  confirmCfImport = confirmCloudFoundryImport,
  install = installMcpConfig,
  includeSapDevelopmentToolsPrompt = false,
  detectAdtUrl
} = {}) {
  const isBas = Boolean(env.H2O_URL);
  if (!isBas && (!input.isTTY || !output.isTTY)) {
    print(output, formatStatus('BAS destination setup was skipped because H2O_URL is not set.', 'info', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-bas' };
  }
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus(`Interactive setup needs a terminal. Rerun ${SETUP_COMMAND} from a terminal.`, 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  print(output, '');
  print(output, colorText('💡 Tip: you can skip auto-discovery and add a system manually — press m in the destination picker, or take the wizard offer when nothing is found.', 'magenta', output));
  if (!isBas) print(output, formatStatus('Looking for local SAP GUI system configuration.', 'progress', output, 'Setup'));

  let destinations = [];
  if (isBas) {
    let basDestinations;
    // BAS discovery probes every destination's ADT endpoint (up to a 5s
    // timeout each); the animated progress line keeps the terminal visibly
    // alive from the first moment instead of looking stuck.
    const stopDiscoveryProgress = startProgress('Contacting BAS to discover destinations', { output, env, label: 'Setup' });
    try {
      basDestinations = await discover({ env: { ...env, SAP_AI_DEV_TOOLKIT_DESTINATION: '' } });
    } catch (error) {
      throw new Error(`BAS discovery failed: ${error.message}`);
    } finally {
      stopDiscoveryProgress();
    }
    destinations = basDestinations.map(safeBasDestination);
  } else {
    let localSystems;
    const stopScanAnimation = startSapGuiLandscapeAnimation(output, env);
    try {
      localSystems = await discoverLocalSapGui({ env });
    } catch (error) {
      throw new Error(`SAP GUI discovery failed: ${error.message}`);
    } finally {
      stopScanAnimation();
    }
    destinations = localSystems.map(safeLocalSapGuiDestination);
  }
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

  const target = isBas ? await getCloudFoundryTarget({ env }) : { available: false, reason: 'Cloud Foundry import is only available in BAS setup.' };
  if (!target.available) {
    if (isBas) warnings.push(target.reason);
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
  const exitWithoutDestinations = async () => {
    await reportWarnings(warnings);
    const cleanupWarnings = await cleanupNewKeysWithoutConfigChange();
    await reportWarnings(cleanupWarnings);
    return { skipped: true, reason: 'no-destinations', warnings: [...warnings, ...cleanupWarnings] };
  };
  let selected;
  if (!selectable.length) {
    // Nothing was detected — no BAS/CF destinations, or no SAP GUI entries.
    // Offer the manual MCP entry wizard before giving up.
    print(output, formatStatus(isBas ? 'No selectable BAS or Cloud Foundry destinations were found.' : 'No SAP GUI systems were found on this computer.', 'warning', output, 'Setup'));
    print(output, isBas ? remediation : 'Install SAP GUI and create SAP Logon entries, or configure your system manually below. ADT still needs an HTTP(S) URL; SAP GUI files contain DIAG routing only.');
    print(output, '');
    const choice = await selectPrompt({
      message: colorText('💡 No systems were detected. Configure an SAP system manually?', 'magenta', output),
      defaultValue: 'manual',
      choices: [
        { name: '✍️  Start manual entry wizard (system name, ADT URL, client, login)', value: 'manual', shortcut: 'm' },
        { name: 'Exit setup without changes', value: 'exit', shortcut: 'e' }
      ]
    }, { input, output });
    if (choice !== 'manual') return await exitWithoutDestinations();
    selected = await runManualEntryWizard({ env, input, output, detectAdtUrl });
    if (!selected.length) return await exitWithoutDestinations();
  } else {
    selected = await chooseDiscoveredDestinations(destinations, { isBas, input, output, env, detectAdtUrl });
  }

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
    print(output, formatStatus(`Configured ${configuredCount} MCP server${configuredCount === 1 ? '' : 's'}${location}.`, 'success', output, isBas ? 'BAS setup' : 'Local setup'));
    printConnectionInstructions(output, result);
    warnings.push(...(Array.isArray(result?.warnings) ? result.warnings.filter(message => typeof message === 'string') : []));
    let cleanupWarnings = [];
    const finalPath = result?.path || configPath;
    if (isBas) {
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
