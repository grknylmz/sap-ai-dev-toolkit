import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { platform, tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { checkboxPrompt, colorText, formatStatus, selectPrompt, startProgress, textPrompt } from './terminal-ui.mjs';
import { discoverDestinations, remediation } from './bas-discovery.mjs';
import { adtBaseUrl, adtPort, defaultAdtUrl, discoverSapGuiSystems, hasExplicitPort, hasPathPrefix, messageServerAppServers } from './local-sap-gui.mjs';
import { discoverCloudFoundryDestinations, getCloudFoundryTarget, deleteManagedCloudFoundryServiceKeys, findOrphanedCloudFoundryServiceKeys } from './cf-destination.mjs';
import { SAP_DEVELOPMENT_MCP_SERVERS, collectCloudFoundryKeyReferencesFromAllEntries, collectManagedCloudFoundryKeyReferences, installMcpConfig, readMcpConfig, resolveMcpConfigPath } from './mcp-config.mjs';
import { parseIntegrationServiceKey, resolveIntegrationConfig, resolveIntegrationSideFromEnvironment } from './integration-config.mjs';
import { readStoredIntegrationKeys, storeIntegrationKey } from './integration-credentials.mjs';
import { INTEGRATION_CF_SERVICES, createIntegrationInstance, findIntegrationInstances, integrationServiceKey } from './cf-integration.mjs';
import { createIntegrationClients, verificationLines, verifyIntegrationClients } from './integration-verify.mjs';
import { OPTIONAL_COMPONENT_KEYS, OPTIONAL_INPUTS, parseOptionalConfig, resolveOptionalConfig } from './integration-optional-config.mjs';
import { discoverCertificateDnsNames } from './tls-adt-proxy.mjs';
import { findRemoteControllableSsoBrowsers } from './sso-browsers.mjs';
import { parseDatasphereCredentials, resolveDatasphereConfig } from './datasphere-config.mjs';
import { datasphereCredentialsPath, readStoredDatasphereCredentials, storeDatasphereCredentials } from './datasphere-credentials.mjs';
import { authorizationCodeLogin, createDatasphereTokenProvider, openInBrowser } from './datasphere-auth.mjs';
import { PROCESS_AUTOMATION_OAUTH, parseProcessAutomationCredentials, parseProcessAutomationServiceKey, resolveProcessAutomationConfig } from './process-automation-config.mjs';
import { readStoredProcessAutomationCredentials, storeProcessAutomationCredentials } from './process-automation-credentials.mjs';
import { createProcessAutomationRestClient } from './process-automation-client.mjs';
import { createBtpCli, locateBtpCli, loginBtpCli, readBtpSettings, storeBtpSettings } from './btp-cli.mjs';
import { parseCloudAlmCredentials, parseCloudAlmServiceKey, resolveCloudAlmConfig } from './cloud-alm-config.mjs';
import { readStoredCloudAlmCredentials, storeCloudAlmCredentials } from './cloud-alm-credentials.mjs';
import { createCloudAlmRestClient, verifyCloudAlmAccess } from './cloud-alm-client.mjs';
import { readStoredAemCredentials, storeAemCredentials } from './aem-credentials.mjs';
import { WEBGUI_DEFAULT_RELAY_PORT, installWebguiExtension, readStoredWebguiConfig, storeWebguiConfig } from './webgui-config.mjs';
import { createStaticServiceClient } from './integration-http.mjs';
import { connectHana } from './hana-database.mjs';
import { diagnosticText } from './redact.mjs';

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

function createSsoBrowserSelector({ discoverSsoBrowsers, input, output, env }) {
  let selectedPath;
  let selectionComplete = false;
  return async destination => {
    if (selectionComplete) return selectedPath;
    selectionComplete = true;
    print(output, formatStatus('Checking installed browsers for remote DevTools access.', 'progress', output, 'SSO'));
    let result;
    try {
      result = await discoverSsoBrowsers({ env });
    } catch (error) {
      const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240);
      print(output, formatStatus(`Browser control check failed (${reason}). Setup will keep automatic browser discovery.`, 'warning', output, 'SSO'));
      return undefined;
    }
    const { browsers = [], unavailable = [] } = result || {};
    if (!browsers.length) {
      const details = unavailable.map(browser => `${browser.name}: ${browser.reason}`).join('; ').slice(0, 300);
      print(output, formatStatus(`No remotely controllable SSO browser was found${details ? ` (${details})` : ''}. Setup will keep automatic browser discovery.`, 'warning', output, 'SSO'));
      return undefined;
    }
    if (browsers.length === 1) {
      selectedPath = browsers[0].path;
      print(output, formatStatus(`Using ${browsers[0].name}; it responded to a remote DevTools command.`, 'success', output, 'SSO browser'));
      return selectedPath;
    }
    selectedPath = await selectPrompt({
      message: `Browser for SSO (${destination.name})`,
      defaultValue: browsers[0].path,
      choices: browsers.map((browser, index) => ({
        name: `${browser.name} (${browser.path})`,
        value: browser.path,
        shortcut: String(index + 1)
      }))
    }, { input, output });
    return selectedPath;
  };
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

// Ports typed at the prompt are range-checked before anything parses them as a URL.
export function adtCandidate(answer, baseUrl) {
  const value = String(answer || '').trim();
  if (/^\d+$/.test(value)) {
    const port = Number(value);
    if (port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535, or a full URL.');
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.hostname}:${port}`;
  }
  const validation = validateAdtUrlCandidate(value);
  if (validation !== true) throw new Error(validation);
  return adtBaseUrl(value);
}

// Cheapest evidence first: named ports get one probe, then the host's usual
// ports, then the message server's application servers, then every port.
async function findAdtUrl(destination, label, client, { candidates = [], scan = true, output = stdout, env = process.env, detectAdtUrl } = {}) {
  const detect = async (line, activity, target) => {
    print(output, formatStatus(line, 'progress', output, 'ADT'));
    const started = Date.now();
    const progress = startProgress(activity, { output, env, label: 'ADT' });
    // A short, ticking spinner: a long line would truncate the animation away and look frozen.
    const ticker = setInterval(() => progress.update(`${activity} (${Math.round((Date.now() - started) / 1000)} s)`), 1000);
    try { return await detectAdtUrl({ client, ...target }); }
    catch (error) { return { url: '', reason: error.message }; }
    finally {
      clearInterval(ticker);
      progress();
    }
  };
  let verdict = { url: '', reason: `no port was checked for ${label}` };
  for (const candidate of [...new Set([destination.url, ...candidates].filter(url => url && hasExplicitPort(url)))]) {
    verdict = await detect(`Checking ADT at ${candidate}`, `Checking ${candidate}`, { url: candidate, ports: [adtPort(candidate)] });
    if (verdict.url || verdict.unresolved) return verdict;
  }
  if (!scan) return verdict;
  const host = new URL(destination.url).hostname;
  verdict = await detect(`Port scan in progress on ${host} to find the ADT port for ${label}`, `Scanning the usual ADT ports on ${host}`, { url: destination.url, ...(destination.instance ? { instance: destination.instance } : {}) });
  if (verdict.url || verdict.unresolved) return verdict;
  if (destination.messageServer) {
    const { host: messageHost, httpPort } = destination.messageServer;
    print(output, formatStatus(`Asking the message server ${messageHost}:${httpPort} for the application servers of ${label}`, 'progress', output, 'ADT'));
    const servers = (await messageServerAppServers({ ...destination.messageServer, systemId: destination.systemId })).slice(0, 3);
    print(output, formatStatus(servers.length
      ? `The message server lists ${servers.map(server => `${server.host} (instance ${server.instance})`).join(', ')}.`
      : `The message server at ${messageHost}:${httpPort} listed no application servers.`, 'info', output, 'ADT'));
    for (const server of servers) {
      const found = await detect(`Port scan in progress on application server ${server.host} (instance ${server.instance})`, `Scanning ${server.host}`, { url: `${new URL(destination.url).protocol}//${server.host}`, instance: server.instance });
      if (found.url) return found;
    }
  }
  print(output, formatStatus(`No ADT port on the usual ports for ${label}: ${verdict.reason}.`, 'info', output, 'ADT'));
  return detect(`Scanning the remaining conventional SAP ports on ${host} (about 300 ports; this can take a few minutes)`, `Scanning the remaining SAP ports on ${host}`, { url: destination.url, exhaustive: true });
}

// An SSO sign-in can only start where ADT answers, so for SSO setup does not
// end on an unverified URL unless the user chooses to.
async function settleAdtUrl(destination, label, client, { insist = false, candidates = [], input = stdin, output = stdout, env = process.env, detectAdtUrl } = {}) {
  if (!detectAdtUrl) return 'unchecked';
  if (hasPathPrefix(destination.url)) {
    print(output, formatStatus(`${destination.url} has a gateway path, so setup uses it as entered without a port scan.`, 'info', output, 'ADT'));
    return 'unchecked';
  }
  const options = { candidates, output, env, detectAdtUrl };
  let verdict = await findAdtUrl(destination, label, client, options);
  while (!verdict.url) {
    print(output, formatStatus(`No ADT answer for ${label}: ${verdict.reason}.`, 'warning', output, 'ADT'));
    if (!insist) return 'unverified';
    const choice = await selectPrompt({
      message: `ADT for ${label}`,
      defaultValue: 'enter',
      choices: [
        { name: 'Enter the ADT port or URL (basis finds it in SMICM > Goto > Services)', value: 'enter', shortcut: 'e' },
        { name: 'Scan again, for example after connecting the VPN', value: 'retry', shortcut: 'r' },
        { name: `Keep ${destination.url} without an ADT answer`, value: 'keep', shortcut: 'k' },
        { name: 'Skip this system', value: 'skip', shortcut: 's' }
      ]
    }, { input, output });
    if (choice === 'keep') return 'unverified';
    if (choice === 'skip') return 'skipped';
    if (choice === 'enter') {
      const answer = await textPrompt({
        message: `ADT port or URL for ${label}`,
        placeholder: '44300 or https://host:44300',
        validate: value => {
          try { adtCandidate(value, destination.url); return true; }
          catch (error) { return error.message; }
        }
      }, { input, output });
      destination.url = adtCandidate(answer, destination.url);
    }
    const retry = choice === 'retry';
    verdict = await findAdtUrl(destination, label, client, { ...options, candidates: retry ? candidates : [], scan: retry || !hasExplicitPort(destination.url) });
  }
  destination.url = verdict.url;
  print(output, formatStatus(`ADT answers at ${verdict.url}.`, 'success', output, 'ADT'));
  return 'verified';
}

function warnSsoIpHost(destination, label, output) {
  if (!isIP(new URL(destination.url).hostname.replace(/^\[(.*)\]$/, '$1'))) return;
  print(output, formatStatus(`${label} uses an IP address; SSO needs the DNS host name for Kerberos and the browser certificate check. Enter the host name if the sign-in fails.`, 'warning', output, 'SSO'));
}

async function confirmPrompt(message, { input = stdin, output = stdout, defaultYes = true } = {}) {
  const answer = await textPrompt({
    message,
    placeholder: defaultYes ? 'y' : 'n',
    required: false,
    validate: value => /^(?:|y|yes|n|no)$/i.test(String(value || '').trim()) || 'Enter y or n.'
  }, { input, output });
  const trimmed = String(answer || '').trim();
  if (!trimmed) return defaultYes;
  return !/^n(?:o)?$/i.test(trimmed);
}

// Report configured component identities and source evidence without credential values.
export function integrationSuiteCredentialStatus(env = process.env) {
  try {
    const config = resolveIntegrationConfig(env, { stored: readStoredIntegrationKeys(env) });
    const keys = ['cpi', 'apim', 'devhub', ...OPTIONAL_COMPONENT_KEYS];
    const side = (key, value) => {
      const host = value.url ? new URL(value.url).host : key === 'aem' ? 'api.solace.cloud' : 'unknown';
      return `configured from ${value.source}${value.bindingName ? ` (${value.bindingName})` : ''}, host ${host}`;
    };
    const configured = keys.filter(key => config[key]);
    const errors = (config.optional_config_errors ?? []).map(error => `${error.component.toUpperCase()}: invalid optional configuration (${error.source}); adapter disabled`);
    if (!configured.length && !errors.length) return { found: false, config, lines: ['No Integration Suite credentials configured yet.'] };
    return { found: configured.length > 0, config, lines: [
      ...(config.environment ? [`Environment label: ${config.environment}`] : []),
      ...configured.map(key => `${key.toUpperCase()}: ${side(key, config[key])}`),
      ...errors
    ] };
  } catch (error) {
    const message = String(error?.message || '');
    if (/^Configure CPI/.test(message)) return { found: false, config: null, lines: ['No Integration Suite credentials configured yet.'] };
    return { found: false, config: null, lines: [`Credentials found but not usable: ${message}`] };
  }
}

function defaultVerifyIntegration(config, { env }) {
  return verifyIntegrationClients(createIntegrationClients(config, { env }));
}

/** Read pasted JSON text (line breaks from a multi-line paste are dropped) or the contents of a .json file path. */
function readPastedJson(value, env) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('{')) return trimmed;
  const path = trimmed.replace(/^~(?=$|[\\/])/, env.HOME || env.USERPROFILE || '~');
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error('Paste the service key JSON (starting with {) or the path to a readable .json file.');
  }
}

/** Read a pasted service key: JSON text or a path to a .json file. */
function pastedServiceKey(side, value, env) {
  const text = readPastedJson(value, env);
  return OPTIONAL_COMPONENT_KEYS.includes(side.toLowerCase())
    ? parseOptionalConfig(side.toLowerCase(), text, { source: 'setup', allowRawCtms: true })
    : parseIntegrationServiceKey(side, text);
}

async function printIntegrationVerification(config, { env, output, verifyIntegration }) {
  const stop = startProgress('Checking Integration Suite access', { output, env, label: 'Integration Suite' });
  let report;
  try { report = await verifyIntegration(config, { env }); }
  finally { stop(); }
  const host = side => config[side]?.url ? new URL(config[side].url).host : side === 'aem' && config.aem ? 'api.solace.cloud' : '';
  for (const label of ['CPI', 'APIM', 'DEVHUB']) {
    for (const line of verificationLines(label, host(label.toLowerCase()), report[label.toLowerCase()])) print(output, `  ${line}`);
  }
  for (const side of OPTIONAL_COMPONENT_KEYS) {
    const access = report[side];
    if (access?.configured) print(output, `  ${side.toUpperCase()} ${host(side)}: ${access.result ?? access.checks?.[0]?.result ?? 'untested'} (optional access; activation/entitlement unknown)`);
  }
  const core = [report.cpi, report.apim, report.devhub].filter(side => side?.configured);
  const denied = core.flatMap(side => side.checks ?? []).filter(check => check.result === 'forbidden').length;
  const message = !core.length ? 'No core service configured yet.'
    : report.ok ? (denied ? `Connected; ${denied} area(s) were access-denied — the key may lack roles.` : 'Connection verified.')
      : 'Sign-in or core read failed; see the lines above.';
  print(output, formatStatus(message, report.ok && !denied ? 'success' : 'warning', output, 'Integration Suite'));
  const optional = OPTIONAL_COMPONENT_KEYS.filter(side => report[side]?.configured);
  if (optional.length) print(output, `  Optional services: ${report.optional_completeness?.complete === true ? 'all verified' : 'not fully verified'} (separate from core access).`);
  return report;
}

const defaultIntegrationCloudFoundry = Object.freeze({
  getTarget: getCloudFoundryTarget,
  findInstances: findIntegrationInstances,
  serviceKey: integrationServiceKey,
  createInstance: createIntegrationInstance
});

const SIDE_LABELS = Object.freeze({ CPI: 'Cloud Integration (CPI)', APIM: 'API Management', DEVHUB: 'Developer Hub' });

function cfFailure(error) {
  const detail = String(error?.stderr || error?.message || '').replace(/\s+/g, ' ').trim();
  return detail ? detail.slice(0, 300) : 'Cloud Foundry CLI command failed';
}

// Verify one side's key online, then save it user-only. A key that cannot sign in is saved only when confirmed.
async function acceptIntegrationKey(side, config, context) {
  const { env, input, output, verifyIntegration } = context;
  const choice = side.toLowerCase();
  const report = await printIntegrationVerification({ [choice]: config }, { env, output, verifyIntegration });
  if (!report[choice]?.signed_in && !await confirmPrompt('Save these existing credentials despite unverified access? (y/n, Enter=no)', { input, output, defaultYes: false })) return { saved: false, report };
  const path = await storeIntegrationKey(side, config, env);
  print(output, formatStatus(`Saved the ${side} key to ${path} (readable only by you; not written to mcp.json).`, 'success', output, 'Integration Suite'));
  let fromEnvironment = null;
  try {
    fromEnvironment = OPTIONAL_COMPONENT_KEYS.includes(choice)
      ? resolveOptionalConfig(env, {})[choice]
      : resolveIntegrationSideFromEnvironment(env, side);
  } catch {
    // A broken environment value is reported by the status lines.
  }
  if (fromEnvironment) print(output, formatStatus(`${side} credentials from ${fromEnvironment.source} in this environment take precedence over the saved key.`, 'warning', output, 'Integration Suite'));
  context.recordHealth?.(report);
  return { saved: true, report };
}

function lacksRoles(side) {
  return Boolean(side?.signed_in) && (side.checks ?? []).some(check => check.result === 'forbidden');
}

async function cloudFoundryStep(message, operation, { env, output }) {
  const stop = startProgress(message, { output, env, label: 'Cloud Foundry' });
  try {
    return await operation();
  } finally {
    stop();
  }
}

// Key from an instance: reuse or create the toolkit's service key, then verify and save it.
async function useCloudFoundryInstance(side, instanceName, context) {
  const { env, output, cloudFoundry } = context;
  const key = await cloudFoundryStep(`Reading service key ${instanceName}/sap-ai-dev-integration`, () => cloudFoundry.serviceKey(instanceName, { env }), context);
  print(output, formatStatus(`${key.created ? 'Created' : 'Reusing'} service key ${key.keyName} on ${instanceName}.`, 'info', output, 'Cloud Foundry'));
  return acceptIntegrationKey(side, parseIntegrationServiceKey(side, key.credentials), context);
}

async function createDedicatedInstance(side, context) {
  const { env, output, cloudFoundry } = context;
  const service = INTEGRATION_CF_SERVICES[side];
  try {
    await cloudFoundryStep(`Creating ${service.offering}/${service.plan} instance ${service.dedicatedInstance}`, () => cloudFoundry.createInstance(side, { env }), context);
  } catch (error) {
    print(output, formatStatus(`Could not create ${service.dedicatedInstance}: ${cfFailure(error)}`, 'warning', output, 'Cloud Foundry'));
    return null;
  }
  print(output, formatStatus(`Created service instance ${service.dedicatedInstance}.`, 'success', output, 'Cloud Foundry'));
  return useCloudFoundryInstance(side, service.dedicatedInstance, context);
}

// Use the logged-in CF space: per side pick the matching instance (or offer to create a dedicated one with the
// roles the tools need), reuse or create the toolkit's service key, verify it online and save it.
async function useCloudFoundrySpace(target, context) {
  const { env, input, output, cloudFoundry } = context;
  let instances;
  try {
    instances = await cloudFoundryStep('Looking for Integration Suite service instances in the CF space', () => cloudFoundry.findInstances({ env, spaceGuid: target.spaceGuid }), context);
  } catch (error) {
    print(output, formatStatus(`Could not list service instances: ${cfFailure(error)}`, 'warning', output, 'Cloud Foundry'));
    return;
  }
  for (const side of ['CPI', 'APIM', 'DEVHUB']) {
    const service = INTEGRATION_CF_SERVICES[side];
    const candidates = instances[side] || [];
    print(output, '');
    if (!candidates.length) {
      print(output, formatStatus(`No ${service.label} instance with plan ${service.plan} (${service.offering}) in this space.`, 'info', output, SIDE_LABELS[side]));
      if (await confirmPrompt(`Create instance ${service.dedicatedInstance} (${service.offering}, plan ${service.plan}) with ${service.parameters.role || 'the roles the tools need'}, then create or reuse its sap-ai-dev-integration service key? (y/n, Enter=no)`, { input, output, defaultYes: false })) {
        await createDedicatedInstance(side, context);
      }
      continue;
    }
    const dedicated = candidates.find(candidate => candidate.name === service.dedicatedInstance);
    const instanceName = candidates.length === 1 ? candidates[0].name : await selectPrompt({
      message: colorText(`☁️ ${SIDE_LABELS[side]}: choose the ${service.offering}/${service.plan} instance to use`, 'cyan', output),
      defaultValue: (dedicated || candidates[0]).name,
      choices: [...candidates.map(candidate => ({ name: candidate.name, value: candidate.name })), { name: 'Skip', value: '', shortcut: 's' }]
    }, { input, output });
    if (!instanceName) continue;
    if (side === 'DEVHUB' && !await confirmPrompt(`Use ${instanceName} and create or reuse its sap-ai-dev-integration service key? (y/n, Enter=no)`, { input, output, defaultYes: false })) continue;
    let result;
    try {
      result = await useCloudFoundryInstance(side, instanceName, context);
    } catch (error) {
      print(output, formatStatus(`Could not use ${instanceName}: ${cfFailure(error)}`, 'warning', output, SIDE_LABELS[side]));
      continue;
    }
    const sideReport = result.report[side.toLowerCase()];
    if (instanceName !== service.dedicatedInstance && !dedicated && lacksRoles(sideReport)) {
      print(output, `  The roles of ${instanceName} are fixed on the instance; a new key cannot add them.`);
      print(output, `  A dedicated instance gets: ${service.parameters.roles ? service.parameters.roles.join(', ') : service.parameters.role}.`);
      if (await confirmPrompt(`Create instance ${service.dedicatedInstance} with these roles and use it instead? (y/n, Enter=no)`, { input, output, defaultYes: false })) {
        await createDedicatedInstance(side, context);
      }
    }
  }
}

// The paste flow asks which service the key belongs to; APIM and Developer Hub keys share one OAuth shape,
// so the type is never guessed from the key itself.
async function chooseKeyType({ input, output, status }) {
  return await selectPrompt({
    message: colorText('Which service is this key for?', 'cyan', output),
    defaultValue: ['CPI', 'APIM', 'DEVHUB'].find(side => !status.config?.[side.toLowerCase()]) ?? 'CPI',
    choices: [
      { value: 'CPI', shortcut: 'i', name: 'Cloud Integration (CPI) — Process Integration Runtime, plan api' },
      { value: 'APIM', shortcut: 'a', name: 'API Management — plan apiportal-apiaccess' },
      { value: 'DEVHUB', shortcut: 'd', name: 'Developer Hub — plan devportal-apiaccess (AuthGroup.API.Admin)' },
      ...OPTIONAL_COMPONENT_KEYS.map(side => ({
        value: side.toUpperCase(),
        shortcut: { ctms: 't', ans: 'n', event_mesh: 'e', aem: 'm', aem_semp: 's', open_connectors: 'o', edge: 'g' }[side],
        name: `Optional: ${OPTIONAL_INPUTS[side].label} (${OPTIONAL_INPUTS[side].variable}, existing credentials only)`
      })),
      { value: '', shortcut: 'b', name: 'Back' }
    ]
  }, { input, output });
}

// Verify the detected credentials online and let the user take CPI/APIM/DEVHUB keys from the logged-in CF space or
// paste them. A key is checked online first and saved to the user-only store (never to mcp.json); it is used
// when the environment has no key.
async function configureIntegrationCredentials({ env, input, output, verifyIntegration, cloudFoundry = defaultIntegrationCloudFoundry }) {
  let status = integrationSuiteCredentialStatus(env);
  // Latest verification per side ({ cpi, apim, devhub }); updated whenever a key is checked or saved.
  const health = {};
  const recordHealth = report => {
    for (const side of ['cpi', 'apim', 'devhub', ...OPTIONAL_COMPONENT_KEYS]) if (report?.[side]?.configured) health[side] = report[side];
  };
  if (status.found) recordHealth(await printIntegrationVerification(status.config, { env, output, verifyIntegration }));
  let target = { available: false };
  try {
    target = await cloudFoundryStep('Checking the Cloud Foundry login', () => cloudFoundry.getTarget({ env }), { env, output });
  } catch {
    // No CF CLI or no login: the CF option is simply not offered.
  }
  const context = { env, input, output, verifyIntegration, cloudFoundry, recordHealth };
  for (;;) {
    print(output, '');
    const space = target.available ? [target.orgName, target.spaceName].filter(Boolean).join(' / ') || target.spaceGuid : '';
    // Access denial is observed; its role/entitlement cause is not established. Optional setup never provisions.
    const roleless = ['CPI', 'APIM', 'DEVHUB'].filter(side => lacksRoles(health[side.toLowerCase()]));
    const healthy = status.found && !roleless.length && Object.values(health).length > 0 && Object.values(health).every(side => side.ok);
    const fixes = target.available
      ? roleless.map(side => ({
        name: `Create ${INTEGRATION_CF_SERVICES[side].dedicatedInstance} in ${space} with the roles the ${side} tools need, then use it`,
        value: `create-${side.toLowerCase()}`
      }))
      : [];
    const choice = await selectPrompt({
      message: colorText('🔑 Integration Suite credentials', 'cyan', output),
      defaultValue: healthy ? 'done' : (fixes[0]?.value ?? (target.available ? 'cf' : (status.found ? 'done' : 'paste'))),
      choices: [
        ...fixes,
        ...(target.available ? [{ value: 'cf', shortcut: 'f', name: `Get keys from Cloud Foundry (${space})` }] : []),
        { value: 'paste', shortcut: 'p', name: 'Paste a service key (JSON or path to a .json file)' },
        ...(status.found ? [{ value: 'verify', shortcut: 'v', name: 'Check credentials again' }] : []),
        { value: 'done', shortcut: 'c', name: status.found ? (healthy ? 'Done' : 'Done (some checks did not pass)') : 'Skip for now (run sap-ai-dev --setup-integration later)' }
      ]
    }, { input, output });
    if (choice === 'done') return status;
    if (choice === 'verify') {
      recordHealth(await printIntegrationVerification(status.config, { env, output, verifyIntegration }));
      continue;
    }
    if (choice.startsWith('create-')) {
      await createDedicatedInstance(choice.slice('create-'.length).toUpperCase(), context);
    } else if (choice === 'cf') {
      await useCloudFoundrySpace(target, context);
    } else if (choice === 'paste') {
      const side = await chooseKeyType({ input, output, status });
      if (!side) continue; // Back: show the menu again without refreshing status.
      const pasted = await textPrompt({
        message: `Paste existing ${side} credential JSON or the path to its .json file`,
        secret: true,
        validate: value => {
          try {
            pastedServiceKey(side, value, env);
            return true;
          } catch (error) {
            return error.message;
          }
        }
      }, { input, output });
      await acceptIntegrationKey(side, pastedServiceKey(side, pasted, env), context);
    }
    status = integrationSuiteCredentialStatus(env);
    for (const line of status.lines) print(output, `  ${line}`);
  }
}

async function promptIntegrationSuite({ env, alreadyConfigured, input, output, verifyIntegration = defaultVerifyIntegration, integrationCloudFoundry, ask = true }) {
  print(output, '');
  print(output, formatStatus('SAP Integration Suite tools', 'step', output, 'Integration Suite'));
  print(output, '  Connects your AI agent to Cloud Integration (CPI), API Management and Developer Hub. Keys are checked read-only and stored only for you, never in mcp.json.');
  if (alreadyConfigured) print(output, '  Already configured in this MCP config; keeping it and refreshing its version.');
  const status = integrationSuiteCredentialStatus(env);
  for (const line of status.lines) print(output, `  ${line}`);
  if (!status.found) print(output, '  No credentials found yet. Next you can get them from your Cloud Foundry space or paste a service key.');
  if (ask && !alreadyConfigured) {
    print(output, '');
    const defaultYes = status.found;
    if (!await confirmPrompt(`Add the SAP Integration Suite tools? (y/n, Enter=${defaultYes ? 'yes' : 'no'})`, { input, output, defaultYes })) return false;
  }
  await configureIntegrationCredentials({ env, input, output, verifyIntegration, ...(integrationCloudFoundry ? { cloudFoundry: integrationCloudFoundry } : {}) });
  return true;
}

/** `sap-ai-dev --setup-integration`: only the Integration Suite step (paste, verify, add the server), keeping every other MCP entry. */
export async function runIntegrationSuiteSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  verifyIntegration = defaultVerifyIntegration,
  integrationCloudFoundry
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-integration from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  let alreadyConfigured = false;
  try {
    alreadyConfigured = Boolean((await readMcpConfig(await resolveMcpConfigPath(env)))?.servers?.['integration-suite']);
  } catch {
    // A missing or unreadable config is created or healed by install.
  }
  await promptIntegrationSuite({ env, alreadyConfigured, input, output, verifyIntegration, integrationCloudFoundry, ask: false });
  const result = await install([], { env, sapDevelopmentServers: ['integration-suite'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the Integration Suite MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'Integration Suite'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

export function datasphereCredentialStatus(env = process.env) {
  try {
    const config = resolveDatasphereConfig(env, { stored: readStoredDatasphereCredentials(env) });
    const lines = [`Datasphere tenant ${new URL(config.url).host} (${config.auth}, source: ${config.source})`];
    if (config.sql) lines.push(`SQL user ${config.sql.user}@${config.sql.host}`);
    return { found: true, source: config.source, auth: config.auth, config, lines };
  } catch (error) {
    return { found: false, source: null, auth: null, config: null, lines: [String(error?.message || '')] };
  }
}

function datasphereRestClient(config, { env, accessToken } = {}) {
  const shared = {
    label: 'DATASPHERE',
    url: config.url,
    csrfPath: '/api/v1/datasphere/consumption/catalog/spaces',
    env
  };
  if (accessToken) {
    return createStaticServiceClient({ ...shared, authorization: async () => `Bearer ${accessToken}` });
  }
  const provider = createDatasphereTokenProvider({ config, env });
  return createStaticServiceClient({ ...shared, authorization: async () => `Bearer ${(await provider.token()).accessToken}` });
}

async function defaultVerifyDatasphere(config, { env, accessToken } = {}) {
  try {
    const payload = await datasphereRestClient(config, { env, accessToken }).request('GET', '/api/v1/datasphere/consumption/catalog/spaces');
    return { ok: true, message: `signed in; ${(payload?.value ?? []).length} spaces visible` };
  } catch (error) {
    return { ok: false, message: diagnosticText(error) };
  }
}

/** Prompt for a Datasphere OAuth client, verify it online, optionally add SQL access, and store it. */
export async function promptDatasphere({
  env = process.env,
  input = stdin,
  output = stdout,
  verifyDatasphere = defaultVerifyDatasphere,
  login = authorizationCodeLogin
} = {}) {
  print(output, '');
  print(output, formatStatus('SAP Datasphere tools', 'step', output, 'Datasphere'));
  print(output, '  Connects your AI agent to SAP Datasphere through an OAuth client from System > App Integration. Credentials are checked online and stored only for you, never in mcp.json.');
  const status = datasphereCredentialStatus(env);
  for (const line of status.lines) print(output, `  ${line}`);
  if (status.found) {
    if (status.source === 'environment') return true;
    if (!await confirmPrompt('Replace the stored Datasphere sign-in? (y/n, Enter=no)', { input, output, defaultYes: false })) return true;
  }

  const auth = await selectPrompt({
    message: 'How should the toolkit sign in to SAP Datasphere?',
    defaultValue: 'technical',
    choices: [
      { name: 'Technical user (Technical User OAuth client): objects, tasks, Data Marketplace, connections, certificates, consumption data', value: 'technical', shortcut: 't' },
      { name: 'Your user (Interactive Usage OAuth client, redirect URI http://localhost:8080): everything, including spaces, users, roles, database users and workload', value: 'interactive', shortcut: 'y' }
    ]
  }, { input, output });

  const FIELD_LABELS = { url: 'DATASPHERE_URL', tokenUrl: 'DATASPHERE_TOKEN_URL', authorizationUrl: 'DATASPHERE_AUTHORIZATION_URL' };
  const validateUrl = field => value => {
    try {
      parseDatasphereCredentials({
        auth,
        url: field === 'url' ? value : 'https://placeholder.invalid',
        tokenUrl: field === 'tokenUrl' ? value : 'https://placeholder.invalid/oauth/token',
        clientId: 'placeholder',
        clientSecret: 'placeholder',
        ...(auth === 'interactive'
          ? { authorizationUrl: field === 'authorizationUrl' ? value : 'https://placeholder.invalid', refreshToken: 'placeholder' }
          : {})
      }, 'environment');
      return true;
    } catch (error) {
      return String(error?.message || '').startsWith(FIELD_LABELS[field]) ? error.message : true;
    }
  };
  const tenantUrl = await textPrompt({
    message: 'Datasphere tenant URL (for example https://<tenant>.eu10.hcs.cloud.sap)',
    validate: validateUrl('url')
  }, { input, output });
  const tokenUrl = await textPrompt({
    message: 'Token URL',
    validate: validateUrl('tokenUrl')
  }, { input, output });
  const clientId = await textPrompt({ message: 'OAuth client ID', secret: true }, { input, output });
  const clientSecret = await textPrompt({ message: 'OAuth client secret', secret: true }, { input, output });
  let authorizationUrl = '';
  if (auth === 'interactive') {
    authorizationUrl = await textPrompt({
      message: 'Authorization URL',
      validate: validateUrl('authorizationUrl')
    }, { input, output });
  }

  let parsed;
  try {
    parsed = resolveDatasphereConfig({
      ...env,
      DATASPHERE_URL: tenantUrl,
      DATASPHERE_TOKEN_URL: tokenUrl,
      DATASPHERE_CLIENT_ID: clientId,
      DATASPHERE_CLIENT_SECRET: clientSecret,
      DATASPHERE_AUTH: auth,
      // The refresh token only exists after the sign-in below; a placeholder
      // satisfies the interactive validation and is replaced by the login result.
      ...(auth === 'interactive' ? { DATASPHERE_AUTHORIZATION_URL: authorizationUrl, DATASPHERE_REFRESH_TOKEN: 'pending-sign-in' } : {})
    });
  } catch (error) {
    print(output, formatStatus(error.message, 'warning', output, 'Datasphere'));
    return false;
  }

  let refreshToken = null;
  let accessToken = null;
  if (auth === 'interactive') {
    const mode = await selectPrompt({
      message: 'How should the sign-in finish?',
      defaultValue: 'browser',
      choices: [
        { name: 'Open the browser here (local machine)', value: 'browser', shortcut: 'b' },
        { name: 'Paste the redirected URL (BAS or remote machine)', value: 'paste', shortcut: 'p' }
      ]
    }, { input, output });
    try {
      const session = await login({
        config: parsed,
        mode,
        openUrl: url => {
          print(output, formatStatus(`Sign in with this URL (it also opened in your browser): ${url}`, 'info', output, 'Datasphere'));
          openInBrowser(url);
        },
        promptPaste: () => textPrompt({
          message: 'Paste the full URL the browser was redirected to (or just the code)',
          secret: true
        }, { input, output })
      });
      refreshToken = session.refreshToken || null;
      accessToken = session.accessToken || null;
    } catch (error) {
      print(output, formatStatus(`Datasphere sign-in failed: ${diagnosticText(error)}`, 'warning', output, 'Datasphere'));
      return false;
    }
  }

  const verification = await verifyDatasphere(parsed, { env, ...(accessToken ? { accessToken } : {}) });
  if (!verification.ok) {
    print(output, formatStatus(`Verification failed: ${verification.message}`, 'warning', output, 'Datasphere'));
    if (!await confirmPrompt('Save these credentials anyway? (y/n, Enter=no)', { input, output, defaultYes: false })) return false;
  } else {
    print(output, formatStatus(`Datasphere ${verification.message}.`, 'success', output, 'Datasphere'));
  }

  let sql = null;
  if (await confirmPrompt('Add SQL access with a Datasphere database user (Open SQL schema)? (y/n, Enter=no)', { input, output, defaultYes: false })) {
    const sqlHost = await textPrompt({ message: 'Database user host name' }, { input, output });
    const sqlPort = await textPrompt({ message: 'Port (Enter=443)', placeholder: '443', required: false }, { input, output });
    const sqlUser = await textPrompt({ message: 'Database user name' }, { input, output });
    const sqlPassword = await textPrompt({ message: 'Database user password', secret: true }, { input, output });
    const sqlSchema = await textPrompt({
      message: `Schema (Enter=${sqlUser})`,
      placeholder: sqlUser,
      required: false
    }, { input, output });
    const port = Number(sqlPort || 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      print(output, formatStatus('DATASPHERE_SQL_PORT must be an integer between 1 and 65535', 'warning', output, 'Datasphere'));
      return false;
    }
    sql = { host: sqlHost, port, user: sqlUser, password: sqlPassword, schema: sqlSchema || sqlUser };
    try {
      const database = await connectHana(sql, { queryTimeoutMs: 15_000 });
      try {
        await database.query('SELECT CURRENT_USER FROM DUMMY');
      } finally {
        await database.close();
      }
      print(output, formatStatus(`SQL access verified (${sqlUser}@${sqlHost}).`, 'success', output, 'Datasphere'));
    } catch (error) {
      print(output, formatStatus(`SQL verification failed: ${diagnosticText(error)}`, 'warning', output, 'Datasphere'));
      if (!await confirmPrompt('Save these credentials anyway? (y/n, Enter=no)', { input, output, defaultYes: false })) return false;
    }
  }

  const record = {
    auth: parsed.auth,
    url: parsed.url,
    tokenurl: parsed.tokenUrl,
    clientid: parsed.clientId,
    clientsecret: parsed.clientSecret,
    ...(parsed.auth === 'interactive' ? { authorizationurl: parsed.authorizationUrl, ...(refreshToken ? { refreshtoken: refreshToken } : {}) } : {}),
    ...(sql ? { sql } : {})
  };
  const path = await storeDatasphereCredentials(record, env);
  print(output, formatStatus(`Saved to ${path}`, 'success', output, 'Datasphere'));
  return true;
}

/** `sap-ai-dev --setup-datasphere`: only the Datasphere step (sign in, verify, add the server). */
export async function runDatasphereSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  verifyDatasphere = defaultVerifyDatasphere,
  login = authorizationCodeLogin
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-datasphere from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  const ok = await promptDatasphere({ env, input, output, verifyDatasphere, login });
  if (!ok) {
    print(output, formatStatus('Datasphere setup cancelled; no MCP entry was added.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'no-credentials' };
  }
  const result = await install([], { env, sapDevelopmentServers: ['datasphere'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the SAP Datasphere MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'SAP AI Dev Toolkit'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

export function processAutomationCredentialStatus(env = process.env) {
  try {
    const config = resolveProcessAutomationConfig(env, { stored: readStoredProcessAutomationCredentials(env) });
    const lines = [`SAP Build Process Automation API ${new URL(config.url).host} (${config.auth}, source: ${config.source})`];
    return { found: true, source: config.source, auth: config.auth, config, lines };
  } catch (error) {
    return { found: false, source: null, auth: null, config: null, lines: [String(error?.message || '')] };
  }
}

async function defaultVerifyProcessAutomation(config, { env, accessToken } = {}) {
  try {
    await createProcessAutomationRestClient(config, { env, ...(accessToken ? { accessToken } : {}) })
      .request('GET', '/public/workflow/rest/v1/workflow-definitions', { query: { $top: 1 } });
    return { ok: true, message: 'signed in; Workflow API reachable' };
  } catch (error) {
    return { ok: false, message: diagnosticText(error) };
  }
}

/** Prompt for a Process Automation service key, optionally sign in as the user, verify it online, and store it. */
export async function promptProcessAutomation({
  env = process.env,
  input = stdin,
  output = stdout,
  verifyProcessAutomation = defaultVerifyProcessAutomation,
  login = authorizationCodeLogin
} = {}) {
  const label = 'Process Automation';
  print(output, '');
  print(output, formatStatus('SAP Build Process Automation tools', 'step', output, label));
  print(output, '  Connects your AI agent to SAP Build Process Automation through a service key of a process-automation-service instance. Credentials are checked online and stored only for you, never in mcp.json.');
  const status = processAutomationCredentialStatus(env);
  for (const line of status.lines) print(output, `  ${line}`);
  if (status.found) {
    if (status.source === 'environment') return true;
    if (!await confirmPrompt('Replace the stored SAP Build Process Automation sign-in? (y/n, Enter=no)', { input, output, defaultYes: false })) return true;
  }

  const auth = await selectPrompt({
    message: 'How should the toolkit sign in to SAP Build Process Automation?',
    defaultValue: 'technical',
    choices: [
      { name: 'Technical client (service key client credentials): processes and task decisions run as the service key\'s technical user', value: 'technical', shortcut: 't' },
      { name: 'Your user (sign in with the service key client): actions are attributed to you; needs ProcessAutomationAdmin or ProcessAutomationParticipant', value: 'interactive', shortcut: 'y' }
    ]
  }, { input, output });

  const pasted = await textPrompt({
    message: 'Paste the Process Automation service key JSON or the path to its .json file',
    secret: true,
    validate: value => {
      try {
        parseProcessAutomationServiceKey(readPastedJson(value, env));
        return true;
      } catch (error) {
        return String(error?.message || 'invalid service key');
      }
    }
  }, { input, output });

  const interactive = auth === 'interactive';
  let parsed;
  try {
    parsed = parseProcessAutomationCredentials({
      auth,
      ...parseProcessAutomationServiceKey(readPastedJson(pasted, env)),
      // The refresh token only exists after the sign-in below; a placeholder
      // satisfies the interactive validation and is replaced by the login result.
      ...(interactive ? { refreshToken: 'pending-sign-in' } : {})
    }, 'stored-key');
  } catch (error) {
    print(output, formatStatus(error.message, 'warning', output, label));
    return false;
  }

  let refreshToken = null;
  let accessToken = null;
  if (interactive) {
    const mode = await selectPrompt({
      message: 'How should the sign-in finish?',
      defaultValue: 'paste',
      choices: [
        { name: 'Paste the redirected URL (works with the service key\'s registered redirect)', value: 'paste', shortcut: 'p' },
        { name: 'Open the browser here with redirect to http://localhost:8080', value: 'browser', shortcut: 'b' }
      ]
    }, { input, output });
    try {
      const session = await login({
        config: parsed,
        mode,
        profile: PROCESS_AUTOMATION_OAUTH,
        openUrl: url => {
          print(output, formatStatus(`Sign in with this URL (it also opened in your browser): ${url}`, 'info', output, label));
          openInBrowser(url);
        },
        promptPaste: () => textPrompt({
          message: 'Paste the full URL the browser was redirected to (or just the code)',
          secret: true
        }, { input, output })
      });
      refreshToken = session.refreshToken || null;
      accessToken = session.accessToken || null;
    } catch (error) {
      print(output, formatStatus(`SAP Build Process Automation sign-in failed: ${diagnosticText(error)}. Choose the technical client if the service key does not allow user sign-in.`, 'warning', output, label));
      return false;
    }
  }

  const verification = await verifyProcessAutomation(parsed, { env, ...(accessToken ? { accessToken } : {}) });
  if (!verification.ok) {
    print(output, formatStatus(`Verification failed: ${verification.message}`, 'warning', output, label));
    if (!await confirmPrompt('Save these credentials anyway? (y/n, Enter=no)', { input, output, defaultYes: false })) return false;
  } else {
    print(output, formatStatus(`SAP Build Process Automation ${verification.message}.`, 'success', output, label));
  }

  print(output, '  Automation triggers, automation jobs and BAM/job exports need an environment API key (Control Tower > Environments > API Keys, scopes such as TRIGGER_READ/TRIGGER_EXECUTE). Workflow, inbox, decision and visibility tools work without one.');
  const apiKey = await textPrompt({
    message: 'Environment API key (Enter=skip)',
    secret: true,
    required: false,
    validate: value => (!value || (value.length <= 512 && !/[^\x21-\x7e]/.test(value)) ? true : 'The API key must be a single printable token')
  }, { input, output });
  const environmentId = await textPrompt({
    message: 'Default environment id for API triggers and process starts (Enter=skip)',
    required: false,
    validate: value => (!value || /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? true : 'Use 1-128 letters, digits, dots, dashes or underscores')
  }, { input, output });

  const record = {
    auth: parsed.auth,
    url: parsed.url,
    tokenurl: parsed.tokenUrl,
    clientid: parsed.clientId,
    clientsecret: parsed.clientSecret,
    ...(interactive && refreshToken ? { refreshtoken: refreshToken } : {}),
    ...(apiKey?.trim() ? { apikey: apiKey.trim() } : {}),
    ...(environmentId?.trim() ? { environmentid: environmentId.trim() } : {})
  };
  const path = await storeProcessAutomationCredentials(record, env);
  print(output, formatStatus(`Saved to ${path}`, 'success', output, label));
  return true;
}

/** `sap-ai-dev --setup-process-automation`: only the Process Automation step (service key, sign in, verify, add the server). */
export async function runProcessAutomationSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  verifyProcessAutomation = defaultVerifyProcessAutomation,
  login = authorizationCodeLogin
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-process-automation from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  const ok = await promptProcessAutomation({ env, input, output, verifyProcessAutomation, login });
  if (!ok) {
    print(output, formatStatus('SAP Build Process Automation setup cancelled; no MCP entry was added.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'no-credentials' };
  }
  const result = await install([], { env, sapDevelopmentServers: ['process-automation'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the SAP Build Process Automation MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'SAP AI Dev Toolkit'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

async function defaultVerifyBtp({ cli, config, env }) {
  try {
    const runtime = createBtpCli({ cli, config, env });
    const version = await runtime.version();
    const account = await runtime.json(['get', 'accounts/global-account']);
    return { ok: true, message: `btp CLI${version ? ` ${version}` : ''} signed in to global account ${account?.displayName} (${account?.subdomain})` };
  } catch (error) {
    return { ok: false, loginRequired: error?.code === 'BTP_LOGIN_REQUIRED', message: diagnosticText(error) };
  }
}

/** Locate the btp CLI, check (or start) its btp login --sso session, and remember the CLI location. */
export async function promptBtp({
  env = process.env,
  input = stdin,
  output = stdout,
  verifyBtp = defaultVerifyBtp,
  loginBtp = loginBtpCli,
  locateBtp = locateBtpCli
} = {}) {
  const label = 'SAP BTP';
  print(output, '');
  print(output, formatStatus('SAP BTP platform administration tools', 'step', output, label));
  print(output, '  Connects your AI agent to SAP BTP through your own btp CLI login (btp login --sso). The toolkit stores no credentials; it only remembers where the btp CLI is installed.');
  let saved;
  try {
    saved = readBtpSettings(env).cli;
  } catch {
    saved = undefined;
  }
  const cli = String(env.BTP_CLI || '').trim() || await locateBtp(env) || (typeof saved === 'string' ? saved.trim() : '');
  if (!cli) {
    print(output, formatStatus('The btp CLI was not found on PATH. Install the SAP BTP command line interface from https://tools.hana.ondemand.com/#cloud (or set BTP_CLI to its path), then rerun sap-ai-dev --setup-btp.', 'warning', output, label));
    return false;
  }
  const config = String(env.BTP_CLIENTCONFIG || '').trim() || null;
  print(output, `  btp CLI: ${cli}${config ? ` (config ${config})` : ''}`);

  let verification = await verifyBtp({ cli, config, env });
  if (!verification.ok && verification.loginRequired
    && await confirmPrompt('Sign in now with btp login --sso? (y/n, Enter=yes)', { input, output, defaultYes: true })) {
    try {
      await loginBtp({ cli, config, env });
    } catch (error) {
      print(output, formatStatus(`btp login failed: ${diagnosticText(error)}`, 'warning', output, label));
    }
    verification = await verifyBtp({ cli, config, env });
  }
  if (!verification.ok) {
    print(output, formatStatus(`Verification failed: ${verification.message}`, 'warning', output, label));
    if (!await confirmPrompt('Add the SAP BTP MCP server anyway? (y/n, Enter=no)', { input, output, defaultYes: false })) return false;
  } else {
    print(output, formatStatus(`SAP BTP ${verification.message}.`, 'success', output, label));
  }

  const path = await storeBtpSettings({ cli, ...(config ? { config } : {}) }, env);
  print(output, formatStatus(`Saved the btp CLI location to ${path}`, 'success', output, label));
  return true;
}

/** `sap-ai-dev --setup-btp`: only the SAP BTP step (locate the btp CLI, check the session, add the server). */
export async function runBtpSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  verifyBtp = defaultVerifyBtp,
  loginBtp = loginBtpCli,
  locateBtp = locateBtpCli
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-btp from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  const ok = await promptBtp({ env, input, output, verifyBtp, loginBtp, locateBtp });
  if (!ok) {
    print(output, formatStatus('SAP BTP setup cancelled; no MCP entry was added.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'not-configured' };
  }
  const result = await install([], { env, sapDevelopmentServers: ['sap-btp'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the SAP BTP MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'SAP AI Dev Toolkit'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

export function cloudAlmCredentialStatus(env = process.env) {
  try {
    const config = resolveCloudAlmConfig(env, { stored: readStoredCloudAlmCredentials(env) });
    const lines = [`SAP Cloud ALM API ${new URL(config.url).host} (source: ${config.source})`];
    return { found: true, source: config.source, config, lines };
  } catch (error) {
    return { found: false, source: null, config: null, lines: [String(error?.message || '')] };
  }
}

async function defaultVerifyCloudAlm(config, { env } = {}) {
  const report = await verifyCloudAlmAccess(createCloudAlmRestClient(config, { env }));
  const failed = Object.entries(report).filter(([, result]) => String(result).startsWith('failed'));
  if (failed.length) return { ok: false, message: diagnosticText(failed.map(([name, result]) => `${name} ${result}`).join('; ')) };
  return { ok: true, message: 'Landscape and Analytics APIs reachable' };
}

/** Prompt for a Cloud ALM API service key, verify it online, and store it. */
export async function promptCloudAlm({
  env = process.env,
  input = stdin,
  output = stdout,
  verifyCloudAlm = defaultVerifyCloudAlm
} = {}) {
  const label = 'Cloud ALM';
  print(output, '');
  print(output, formatStatus('SAP Cloud ALM tools', 'step', output, label));
  print(output, '  Connects your AI agent to SAP Cloud ALM for operations through a service key of the "SAP Cloud ALM API" instance (plan standard) in your Cloud ALM subaccount. Credentials are checked online and stored only for you, never in mcp.json.');
  print(output, '  Grant the instance read scopes such as calm-api.landscape.read, calm-api.analytics.read, calm-api.logs.read, calm-api.exm.read, calm-api.integration-monitoring.read, calm-api.hm.read, calm-api.iep.read and calm-api.features.read; closing alerts also needs calm-api.event-situations.write.');
  const status = cloudAlmCredentialStatus(env);
  for (const line of status.lines) print(output, `  ${line}`);
  if (status.found) {
    if (status.source === 'environment') return true;
    if (!await confirmPrompt('Replace the stored SAP Cloud ALM service key? (y/n, Enter=no)', { input, output, defaultYes: false })) return true;
  }

  const pasted = await textPrompt({
    message: 'Paste the SAP Cloud ALM API service key JSON or the path to its .json file',
    secret: true,
    validate: value => {
      try {
        parseCloudAlmServiceKey(readPastedJson(value, env));
        return true;
      } catch (error) {
        return String(error?.message || 'invalid service key');
      }
    }
  }, { input, output });

  let parsed;
  try {
    parsed = parseCloudAlmCredentials(parseCloudAlmServiceKey(readPastedJson(pasted, env)), 'stored-key');
  } catch (error) {
    print(output, formatStatus(error.message, 'warning', output, label));
    return false;
  }

  const verification = await verifyCloudAlm(parsed, { env });
  if (!verification.ok) {
    print(output, formatStatus(`Verification failed: ${verification.message}`, 'warning', output, label));
    if (!await confirmPrompt('Save these credentials anyway? (y/n, Enter=no)', { input, output, defaultYes: false })) return false;
  } else {
    print(output, formatStatus(`SAP Cloud ALM ${verification.message}.`, 'success', output, label));
  }

  const path = await storeCloudAlmCredentials({
    url: parsed.url,
    tokenurl: parsed.tokenUrl,
    clientid: parsed.clientId,
    clientsecret: parsed.clientSecret
  }, env);
  print(output, formatStatus(`Saved to ${path}`, 'success', output, label));
  return true;
}

/** `sap-ai-dev --setup-cloud-alm`: only the Cloud ALM step (service key, verify, add the server). */
export async function runCloudAlmSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  verifyCloudAlm = defaultVerifyCloudAlm
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-cloud-alm from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  const ok = await promptCloudAlm({ env, input, output, verifyCloudAlm });
  if (!ok) {
    print(output, formatStatus('SAP Cloud ALM setup cancelled; no MCP entry was added.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'no-credentials' };
  }
  const result = await install([], { env, sapDevelopmentServers: ['cloud-alm'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the SAP Cloud ALM MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'SAP AI Dev Toolkit'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

const AEM_ENV_KEYS = ['AEM_API_TOKEN', 'AEM_CONFIG', 'AEM_SEMP_URL', 'AEM_SEMP_CONFIG'];

export function aemCredentialStatus(env = process.env) {
  if (AEM_ENV_KEYS.some(key => typeof env[key] === 'string' && env[key].trim())) {
    return { found: true, source: 'environment', lines: ['Advanced event mesh credentials come from the MCP host environment'] };
  }
  let stored;
  try {
    stored = readStoredAemCredentials(env);
  } catch (error) {
    return { found: false, source: null, lines: [String(error?.message || '')] };
  }
  if (stored?.api || stored?.semp) {
    const host = url => { try { return new URL(url).host; } catch { return 'unknown host'; } };
    const lines = [];
    if (stored.api) lines.push(`Cloud API ${host(stored.api.url)}`);
    if (stored.semp) lines.push(`SEMP ${host(stored.semp.url)} VPN ${stored.semp.msg_vpn}`);
    return { found: true, source: 'stored', lines };
  }
  return { found: false, source: null, lines: ['No advanced event mesh credentials configured yet'] };
}

// Runs the native server's --check with only the entered credentials (stored
// file isolated through a temporary XDG_CONFIG_HOME).
async function defaultVerifyAem(record, { env = process.env } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-aem-verify-'));
  try {
    const childEnv = { XDG_CONFIG_HOME: directory };
    for (const key of ['PATH', 'HOME', 'SAP_AI_DEV_TOOLKIT_AEM_BINARY']) if (env[key] !== undefined) childEnv[key] = env[key];
    for (const [key, value] of Object.entries(env)) if (/^(?:https?_proxy|no_proxy)$/i.test(key)) childEnv[key] = value;
    if (record.api) Object.assign(childEnv, { AEM_API_URL: record.api.url, AEM_API_TOKEN: record.api.token });
    if (record.semp) {
      Object.assign(childEnv, {
        AEM_SEMP_URL: record.semp.url,
        AEM_SEMP_MSG_VPN: record.semp.msg_vpn,
        AEM_SEMP_USERNAME: record.semp.username,
        AEM_SEMP_PASSWORD: record.semp.password
      });
    }
    const server = fileURLToPath(new URL('./aem-server.mjs', import.meta.url));
    const { code, stdout: out, stderr: err } = await new Promise(resolve => {
      execFile(process.execPath, [server, '--check'], { env: childEnv, timeout: 60000 }, (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    const result = line => line.slice(line.indexOf(': ') + 2);
    const lines = out.split(/\r?\n/).map(line => line.trim()).filter(line => /^[\w-]+: /.test(line));
    const failed = lines.filter(line => result(line).startsWith('failed'));
    if (failed.length) return { ok: false, message: diagnosticText(failed.join('; ')) };
    if (code !== 0 && !lines.length) return { ok: false, message: diagnosticText(err.trim() || `sap-ai-aem --check exited with ${code}`) };
    return { ok: true, message: lines.filter(line => result(line).startsWith('ok')).join('; ') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function aemUrlValidator(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return true;
  } catch {}
  return 'must be an https URL';
}

/** Prompt for a Cloud API token and/or broker SEMP credentials, verify them online, and store them. */
export async function promptAem({
  env = process.env,
  input = stdin,
  output = stdout,
  verifyAem = defaultVerifyAem
} = {}) {
  const label = 'Advanced Event Mesh';
  print(output, '');
  print(output, formatStatus('SAP Integration Suite, advanced event mesh tools', 'step', output, label));
  print(output, '  Connects your AI agent to advanced event mesh through a Cloud API token (Cloud Console > User & Account > Token Management; grant Mission Control and Event Portal permissions) and, for brokers without a token, broker SEMP credentials. Credentials are checked online and stored only for you, never in mcp.json.');
  const status = aemCredentialStatus(env);
  for (const line of status.lines) print(output, `  ${line}`);
  if (status.found) {
    if (status.source === 'environment') return true;
    if (!await confirmPrompt('Replace the stored advanced event mesh credentials? (y/n, Enter=no)', { input, output, defaultYes: false })) return true;
  }

  const apiUrl = (await textPrompt({
    message: 'Cloud API base URL (Enter = https://api.solace.cloud)',
    required: false,
    placeholder: 'https://api.solace.cloud',
    validate: aemUrlValidator
  }, { input, output })).trim().replace(/\/$/, '') || 'https://api.solace.cloud';
  const token = (await textPrompt({ message: 'Cloud API token (Enter = skip, for SEMP-only brokers)', secret: true, required: false }, { input, output })).trim();

  const record = {};
  if (token) record.api = { url: apiUrl, token };
  if (await confirmPrompt('Add broker SEMP credentials too? (y/n, Enter=no)', { input, output, defaultYes: !token })) {
    const url = (await textPrompt({
      message: 'SEMP URL (https://<host>:943)',
      validate: value => (String(value || '').trim() ? aemUrlValidator(value) : 'Enter a value (or press Ctrl+C to skip).')
    }, { input, output })).trim().replace(/\/$/, '');
    const msgVpn = (await textPrompt({ message: 'Message VPN' }, { input, output })).trim();
    const username = (await textPrompt({ message: 'SEMP username' }, { input, output })).trim();
    const password = await textPrompt({ message: 'SEMP password', secret: true }, { input, output });
    record.semp = { url, msg_vpn: msgVpn, username, password };
  }
  if (!record.api && !record.semp) {
    print(output, formatStatus('Nothing to save: give a Cloud API token or SEMP credentials.', 'warning', output, label));
    return false;
  }

  const verification = await verifyAem(record, { env });
  if (!verification.ok) {
    print(output, formatStatus(`Verification failed: ${verification.message}`, 'warning', output, label));
    if (!await confirmPrompt('Save these credentials anyway? (y/n, Enter=no)', { input, output, defaultYes: false })) return false;
  } else {
    print(output, formatStatus(`Advanced event mesh ${verification.message}.`, 'success', output, label));
  }

  const path = await storeAemCredentials(record, env);
  print(output, formatStatus(`Saved to ${path}`, 'success', output, label));
  return true;
}

/** `sap-ai-dev --setup-aem`: only the advanced event mesh step (token and/or SEMP, verify, add the server). */
export async function runAemSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  verifyAem = defaultVerifyAem
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-aem from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  const ok = await promptAem({ env, input, output, verifyAem });
  if (!ok) {
    print(output, formatStatus('Advanced event mesh setup cancelled; no MCP entry was added.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'no-credentials' };
  }
  const result = await install([], { env, sapDevelopmentServers: ['advanced-event-mesh'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the SAP Integration Suite, advanced event mesh MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'SAP AI Dev Toolkit'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

// Suggest the SAP_URL of an already-configured local SAP GUI / destination
// entry, else the ADT URL guessed from the first discovered SAP GUI system.
async function suggestWebguiUrl(env, discoverLocalSapGui) {
  try {
    const config = await readMcpConfig(await resolveMcpConfigPath(env));
    for (const entry of Object.values(config?.servers || {})) {
      if (typeof entry?.env?.SAP_URL === 'string' && entry.env.SAP_URL) return adtBaseUrl(entry.env.SAP_URL);
    }
  } catch {}
  try {
    for (const system of await discoverLocalSapGui({ env })) {
      const url = defaultAdtUrl(system);
      if (url) return url;
    }
  } catch {}
  return '';
}

function webguiUrlValidator(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol === 'https:' || url.protocol === 'http:') return true;
  } catch {}
  return 'must be an http(s) URL such as https://host:44300';
}

/** Prompt for WebGUI settings (URL, client, language, mode), keep or generate the relay token, and store them. */
export async function promptWebgui({
  env = process.env,
  input = stdin,
  output = stdout,
  discoverLocalSapGui = discoverSapGuiSystems
} = {}) {
  const label = 'SAP GUI for HTML';
  print(output, '');
  print(output, formatStatus('SAP GUI for HTML (WebGUI) tools', 'step', output, label));
  print(output, '  Lets your AI agent read SAP GUI for HTML transactions (read-only) through your own Chrome with the relay extension, or a managed headless browser. No credentials are stored; headless mode uses SAP_USER/SAP_PASSWORD from the MCP host environment or a one-time sign-in.');
  let stored;
  try {
    stored = readStoredWebguiConfig(env);
  } catch (error) {
    print(output, formatStatus(`${error.message}; it will be replaced.`, 'warning', output, label));
  }
  const suggestion = stored?.url || await suggestWebguiUrl(env, discoverLocalSapGui);
  const url = ((await textPrompt({
    message: 'WebGUI base URL (https://host:44300)',
    placeholder: suggestion || 'https://host:44300',
    required: false,
    validate: value => webguiUrlValidator(String(value || '').trim() || suggestion)
  }, { input, output })).trim() || suggestion).replace(/\/+$/, '');
  const defaultClient = stored?.client || '100';
  const client = (await textPrompt({
    message: `SAP client (Enter = ${defaultClient})`,
    placeholder: defaultClient,
    required: false,
    validate: value => (!String(value || '').trim() || /^\d{3}$/.test(String(value).trim()) ? true : 'must be three digits')
  }, { input, output })).trim() || defaultClient;
  const defaultLanguage = stored?.language || 'EN';
  const language = ((await textPrompt({
    message: `Logon language (Enter = ${defaultLanguage})`,
    placeholder: defaultLanguage,
    required: false
  }, { input, output })).trim() || defaultLanguage).toUpperCase();
  let tlsServerName = stored?.tlsServerName || '';
  if (isIP(new URL(url).hostname.replace(/^\[|\]$/g, ''))) {
    tlsServerName = (await textPrompt({
      message: `TLS certificate DNS name for ${new URL(url).hostname} (Enter = ${tlsServerName || 'none'})`,
      placeholder: tlsServerName,
      required: false
    }, { input, output })).trim() || tlsServerName;
  }
  const mode = await selectPrompt({
    message: 'Browser mode',
    defaultValue: stored?.mode === 'headless' ? 'headless' : 'relay',
    choices: [
      { name: 'Relay: your own Chrome through the sap-webgui-relay extension (recommended)', value: 'relay', shortcut: 'r' },
      { name: 'Headless: a managed browser the server starts itself', value: 'headless', shortcut: 'h' }
    ]
  }, { input, output });
  const relayToken = typeof stored?.relayToken === 'string' && stored.relayToken.length >= 32 ? stored.relayToken : randomBytes(32).toString('hex');
  const relayPort = Number.isInteger(stored?.relayPort) ? stored.relayPort : WEBGUI_DEFAULT_RELAY_PORT;
  const record = { url, client, language, ...(tlsServerName ? { tlsServerName } : {}), mode, relayPort, relayToken };
  const path = await storeWebguiConfig(record, env);
  print(output, formatStatus(`Saved to ${path}`, 'success', output, label));
  if (mode === 'relay') {
    const extensionPath = await installWebguiExtension(env);
    print(output, '  Load the relay extension in Chrome once (setup refreshes this folder; reload the extension after updates):');
    print(output, `    1. Open chrome://extensions and turn on Developer mode.`);
    print(output, `    2. Click Load unpacked and choose ${extensionPath}`);
    print(output, '    3. Open the extension options and paste the port and token below.');
    print(output, `  Relay port:  ${relayPort}`);
    print(output, `  Relay token: ${relayToken}`);
  }
  return true;
}

/** `sap-ai-dev --setup-webgui`: only the SAP GUI for HTML step (settings, relay token, add the server). */
export async function runWebguiSetup({
  env = process.env,
  input = stdin,
  output = stdout,
  install = installMcpConfig,
  discoverLocalSapGui = discoverSapGuiSystems
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    print(output, formatStatus('Interactive setup needs a terminal. Rerun sap-ai-dev --setup-webgui from a terminal.', 'warning', output, 'SAP AI Dev Toolkit'));
    return { skipped: true, reason: 'non-tty' };
  }
  await promptWebgui({ env, input, output, discoverLocalSapGui });
  const result = await install([], { env, sapDevelopmentServers: ['sap-webgui'], additive: true });
  print(output, '');
  print(output, formatStatus(`Configured the SAP GUI for HTML (WebGUI) MCP server${result?.path ? ` in ${result.path}` : ''}.`, 'success', output, 'SAP AI Dev Toolkit'));
  for (const message of Array.isArray(result?.warnings) ? result.warnings : []) print(output, formatStatus(message, 'warning', output, 'Warning'));
  return { selected: [], ...(result || {}) };
}

function buildLocalClientDestination(destination, client, authMode, { multipleClients = false, duplicateSystemName = false, browserPath } = {}) {
  const name = localClientDestinationName(destination, client, { multipleClients, duplicateSystemName });
  const localDestination = { ...destination, name, serverName: name, client };
  const userInputId = `sap-ai-dev-${localDestination.serverName || localDestination.name}-user`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const passwordInputId = `sap-ai-dev-${localDestination.serverName || localDestination.name}-password`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const credentialInputs = [
    { id: userInputId, type: 'promptString', description: `SAP user for ${localDestination.name}` },
    { id: passwordInputId, type: 'promptString', description: `SAP password for ${localDestination.name}`, password: true }
  ];
  if (authMode === 'sso') {
    localDestination.childEnv = { SAP_AUTH_MODE: 'sso', ...(browserPath ? { SAP_BROWSER_EXEC: browserPath } : {}) };
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
async function runManualEntryWizard({ env = process.env, input = stdin, output = stdout, detectAdtUrl, selectSsoBrowser } = {}) {
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
      url: adtBaseUrl(url),
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
    const clients = await promptSapClients(destination, { input, output });
    const authMode = await chooseLocalAuthMode(destination, { input, output, env });
    const adt = await settleAdtUrl(destination, name, clients[0], { insist: authMode === 'sso', input, output, env, detectAdtUrl });
    if (adt === 'skipped') {
      print(output, formatStatus(`Skipped ${name}; no MCP server was added for it.`, 'info', output, 'Manual entry'));
    } else {
      if (authMode === 'sso') warnSsoIpHost(destination, name, output);
      else await maybeConfigureTlsSelfHeal(destination, name, { input, output });
      const browserPath = authMode === 'sso' ? await selectSsoBrowser(destination) : undefined;
      destination.authentication = localAuthenticationLabel(authMode);
      destination.authMode = authMode;
      for (const client of clients) {
        expanded.push(buildLocalClientDestination(destination, client, authMode, { multipleClients: clients.length > 1, browserPath }));
      }
      print(output, formatStatus(`Added ${name} (client${clients.length === 1 ? '' : 's'} ${clients.join(', ')}).`, 'success', output, 'Manual entry'));
    }
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


// Two systems sharing a SID cannot be told apart, so neither URL is offered for them.
function previousLocalAdtUrls(config) {
  const urls = new Map();
  for (const entry of Object.values(config?.servers || {})) {
    const entryEnv = entry?.env || {};
    if (entryEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE !== 'sap-gui-local' || !entryEnv.SAP_SYSTEM_ID || !entryEnv.SAP_URL) continue;
    const key = String(entryEnv.SAP_SYSTEM_ID).toUpperCase();
    urls.set(key, urls.has(key) && urls.get(key) !== entryEnv.SAP_URL ? '' : entryEnv.SAP_URL);
  }
  return urls;
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
    messageServer: destination.messageServer,
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
async function chooseDiscoveredDestinations(destinations, { isBas, input = stdin, output = stdout, env = process.env, detectAdtUrl, previousAdtUrls = new Map(), selectSsoBrowser } = {}) {
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
  const addManually = async () => (await runManualEntryWizard({ env, input, output, detectAdtUrl, selectSsoBrowser })).map(destination => ({
    value: destination,
    name: `${destination.name} (manual, client ${destination.client})`
  }));
  let selected = await checkboxPrompt({
    message: colorText('🧭 Select destinations', 'cyan', output),
    choices,
    required: false,
    searchable: true,
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
      const guess = defaultAdtUrl(destination);
      // A URL an earlier setup verified beats the 443NN naming convention.
      const fallback = previousAdtUrls.get(String(destination.systemId || '').toUpperCase()) || guess;
      const url = await textPrompt({
        message: `ADT URL for ${promptLabel}`,
        placeholder: fallback || 'https://host:44300',
        validate: value => validateAdtUrlCandidate(value || fallback),
        required: false
      }, { input, output });
      destination.url = adtBaseUrl(url || fallback);
      const authMode = await chooseLocalAuthMode({ ...destination, name: promptLabel }, { input, output, env });
      const adt = await settleAdtUrl(destination, promptLabel, clients[0], { insist: authMode === 'sso', candidates: url ? [] : [guess], input, output, env, detectAdtUrl });
      if (adt === 'skipped') {
        print(output, formatStatus(`Skipped ${promptLabel}; no MCP server was added for it.`, 'info', output, 'Local SAP GUI'));
        continue;
      }
      if (authMode === 'sso') warnSsoIpHost(destination, promptLabel, output);
      else await maybeConfigureTlsSelfHeal(destination, promptLabel, { input, output });
      const browserPath = authMode === 'sso' ? await selectSsoBrowser(destination) : undefined;
      destination.authentication = localAuthenticationLabel(authMode);
      destination.authMode = authMode;
      for (const client of clients) {
        expanded.push(buildLocalClientDestination(destination, client, authMode, { multipleClients: clients.length > 1, duplicateSystemName, browserPath }));
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
  detectAdtUrl,
  discoverSsoBrowsers = findRemoteControllableSsoBrowsers,
  verifyIntegration = defaultVerifyIntegration,
  integrationCloudFoundry
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
  const selectSsoBrowser = createSsoBrowserSelector({ discoverSsoBrowsers, input, output, env });
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
  let previousAdtUrls = new Map();
  let integrationSuiteConfigured = false;
  try {
    configPath = await resolveMcpConfigPath(env);
    const existingConfig = await readMcpConfig(configPath);
    managedKeys = collectManagedCloudFoundryKeyReferences(existingConfig);
    previousAdtUrls = previousLocalAdtUrls(existingConfig);
    integrationSuiteConfigured = Boolean(existingConfig?.servers?.['integration-suite']);
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
  let additiveSetup = false;
  let integrationOnly = false;
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
        { name: '🔌 Set up only the SAP Integration Suite tools (paste and verify CPI / API Management / Developer Hub service keys)', value: 'integration', shortcut: 'i' },
        { name: 'Exit setup without changes', value: 'exit', shortcut: 'e' }
      ]
    }, { input, output });
    if (choice === 'integration') {
      selected = [];
      additiveSetup = true;
      integrationOnly = true;
    } else {
      if (choice !== 'manual') return await exitWithoutDestinations();
      selected = await runManualEntryWizard({ env, input, output, detectAdtUrl, selectSsoBrowser });
      additiveSetup = true;
      if (!selected.length) return await exitWithoutDestinations();
    }
  } else {
    selected = await chooseDiscoveredDestinations(destinations, { isBas, input, output, env, detectAdtUrl, previousAdtUrls, selectSsoBrowser });
    additiveSetup = selected.length > 0;
  }

  let sapDevelopmentServers = [];
  if (integrationOnly) {
    await promptIntegrationSuite({ env, alreadyConfigured: integrationSuiteConfigured, input, output, verifyIntegration, integrationCloudFoundry, ask: false });
    sapDevelopmentServers = ['integration-suite'];
  } else if (includeSapDevelopmentToolsPrompt) {
    print(output, '');
    print(output, formatStatus('Optionally add companion MCP servers for full-stack SAP development, HANA inspection, Integration Suite (CPI/API Management/Developer Hub), SAP Datasphere, SAP Build Process Automation, SAP BTP platform administration, SAP Cloud ALM, and SAP Integration Suite, advanced event mesh.', 'step', output, 'Tools'));
    print(output, '  HANA Cloud inspector is read-only and uses HANA_RO_* or VCAP_SERVICES already present in the MCP host environment; credentials are not written to mcp.json.');
    print(output, '  Integration Suite uses CPI/APIM/DEVHUB service keys from the MCP host environment or keys you paste next (verified online, saved for your user only); credentials are not written to mcp.json.');
    print(output, '  SAP Datasphere uses a Datasphere OAuth client from DATASPHERE_* in the MCP host environment or entered next (verified online, saved for your user only); credentials are not written to mcp.json.');
    print(output, '  SAP Build Process Automation uses a service key from PROCESS_AUTOMATION_* in the MCP host environment or pasted next (verified online, saved for your user only); credentials are not written to mcp.json.');
    print(output, '  SAP BTP platform administration uses your own btp CLI login (btp login --sso), checked next; the toolkit stores no credentials and writes none to mcp.json.');
    print(output, '  SAP Cloud ALM uses a service key from CLOUD_ALM_* in the MCP host environment or pasted next (verified online, saved for your user only); credentials are not written to mcp.json.');
    print(output, '  Advanced event mesh uses a Cloud API token or broker SEMP credentials from AEM_* in the MCP host environment or entered next (verified online, saved for your user only); credentials are not written to mcp.json.');
    print(output, '  SAP GUI for HTML (WebGUI) is read-only; it drives your own Chrome through the relay extension or a managed headless browser, set up next; no credentials are stored and none are written to mcp.json.');
    print(output, '  Leave empty to only configure ABAP/ADT destination servers.');
    print(output, '');
    sapDevelopmentServers = await checkboxPrompt({
      message: colorText('🧰 Select companion tools', 'cyan', output),
      choices: SAP_DEVELOPMENT_MCP_SERVERS.map(server => ({
        value: server.id,
        name: `${server.name} — ${server.description}`,
        checked: server.id === 'integration-suite' && integrationSuiteConfigured
      })),
      required: false,
      shortcuts: { all: 'a' }
    }, { input, output });
    if (sapDevelopmentServers.includes('integration-suite')) {
      await promptIntegrationSuite({ env, alreadyConfigured: integrationSuiteConfigured, input, output, verifyIntegration, integrationCloudFoundry, ask: false });
    }
    if (sapDevelopmentServers.includes('datasphere') && !await promptDatasphere({ env, input, output })) {
      sapDevelopmentServers = sapDevelopmentServers.filter(id => id !== 'datasphere');
    }
    if (sapDevelopmentServers.includes('process-automation') && !await promptProcessAutomation({ env, input, output })) {
      sapDevelopmentServers = sapDevelopmentServers.filter(id => id !== 'process-automation');
    }
    if (sapDevelopmentServers.includes('sap-btp') && !await promptBtp({ env, input, output })) {
      sapDevelopmentServers = sapDevelopmentServers.filter(id => id !== 'sap-btp');
    }
    if (sapDevelopmentServers.includes('cloud-alm') && !await promptCloudAlm({ env, input, output })) {
      sapDevelopmentServers = sapDevelopmentServers.filter(id => id !== 'cloud-alm');
    }
    if (sapDevelopmentServers.includes('advanced-event-mesh') && !await promptAem({ env, input, output })) {
      sapDevelopmentServers = sapDevelopmentServers.filter(id => id !== 'advanced-event-mesh');
    }
    if (sapDevelopmentServers.includes('sap-webgui')) await promptWebgui({ env, input, output });
  } else if (await promptIntegrationSuite({ env, alreadyConfigured: integrationSuiteConfigured, input, output, verifyIntegration, integrationCloudFoundry })) {
    // Without --tools, Integration Suite still gets its own yes/no step instead of being hidden.
    sapDevelopmentServers = ['integration-suite'];
  }

  try {
    const result = await install(selected, { env, sapDevelopmentServers, additive: additiveSetup });
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
