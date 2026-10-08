#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDestinations, remediation, slugifyDestination, statusRows } from './bas-discovery.mjs';
import { adtBaseUrl, adtPort, detectAdtUrl, discoverSapGuiSystems, hasExplicitPort, hasPathPrefix } from './local-sap-gui.mjs';
import { binaryTarget, cacheDirectory, downloadBinary, findBinary } from './binary.mjs';
import { MCPProxy } from './mcp-proxy.mjs';
import { installMcpConfig, npxMcpLauncher, repairManagedMcpConfig } from './mcp-config.mjs';
import { runSetup } from './setup.mjs';
import { resolveConfiguredCloudFoundryDestination } from './cf-destination.mjs';
import { createTlsServerNameAdtProxy } from './tls-adt-proxy.mjs';
import { withBrandedEnvironment } from './branding.mjs';
import { redactText } from './redact.mjs';
import { startProgress } from './terminal-ui.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeEnv = withBrandedEnvironment(process.env);

function args() { return process.argv.slice(2); }
function hasFlag(name) { return args().includes(name); }
function json(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
// Timestamped stderr lines so MCP server output shows when each event
// happened, not just that it did.
function logLine(message) { console.error(`[${new Date().toISOString()}] ${message}`); }

function usage() {
  return [
    'Usage: sap-ai-dev [options]',
    '',
    'With H2O_URL set, starts the SAP AI Dev Toolkit stdio server for selected BAS destinations; with local SAP GUI setup, starts the selected local ADT system. With no BAS environment and no options in an interactive terminal, starts local setup.',
    'Options:',
    '  --setup                  Configure generated BAS MCP servers',
    '  --tools                  Also offer full-stack SAP companion MCP servers (use with --setup)',
    '  --npx                    Launch configured MCP servers through the pinned npm package (use with --setup)',
    '  --list-destinations      List discovered BAS destinations',
    '  --list-destinations --json  Print redacted JSON status',
    '  --check                  Probe destination availability',
    '  --doctor                 Check SAP/MCP connectivity and repair safe toolkit config drift',
    '  --doctor --json          Print redacted JSON diagnostics',
    '  --demo                   Start an isolated, offline SAP MCP playground',
    '  --help, -h               Show this help and exit',
    '',
    'Use an MCP client to call server tools; the BAS runtime uses stdio for MCP.',
    ''
  ].join('\n');
}

function doctorRow(name, stage, status, detail) {
  return { name, stage, status, ...(detail ? { detail } : {}) };
}

async function runDoctor(destinations) {
  const checks = [];
  const stopProgress = startProgress(destinations.length === 1 ? `Checking ${destinations[0]?.name || 'destination'}` : `Checking ${destinations.length} destinations`, { output: process.stderr, label: 'Doctor' });
  if (!destinations.length) {
    stopProgress();
    return { ok: false, destinations: 0, checks: [doctorRow('-', 'destination discovery', 'failed', 'No destinations were found. Check H2O_URL or the configured Cloud Foundry destination.')] };
  }
  let binary;
  let binaryError;
  try { binary = await binaryOrError(); }
  catch (error) { binaryError = error.message; }


  try {
    const repair = await repairManagedMcpConfig(destinations, {
      env: runtimeEnv,
      discoveryComplete: true,
      packageVersion: pkg.version
    });
    const detail = repair.skipped
      ? repair.skipped
      : `${repair.repaired} managed BAS entr${repair.repaired === 1 ? 'y' : 'ies'} repaired; ${repair.managedEntries || 0} managed BAS entries recognized`;
    checks.push(doctorRow('-', 'MCP config repair', 'passed', detail));
  } catch (error) {
    checks.push(doctorRow('-', 'MCP config repair', 'failed', redactText(error.message || error).slice(0, 300)));
  }
  for (const destination of destinations) {
    stopProgress.update(`Checking ${destination.name}: ADT probe, VSP startup, tools/list`);
    const probe = destination.probe;
    const probeStatus = !probe || probe.status === 'skipped' ? 'skipped' : (probe.available === true ? 'passed' : 'failed');
    checks.push(doctorRow(destination.name, 'ADT probe', probeStatus, probe?.status || 'No BAS ADT probe was supplied; GetSystemInfo will check the route.'));
    checks.push(doctorRow(destination.name, 'VSP binary', binary ? 'passed' : 'failed', binary ? 'installed' : binaryError));
    if (!binary) {
      checks.push(doctorRow(destination.name, 'VSP MCP startup', 'skipped', 'The VSP binary is unavailable.'));
      checks.push(doctorRow(destination.name, 'SAP system check', 'skipped', 'VSP MCP startup could not run.'));
      checks.push(doctorRow(destination.name, 'MCP tools/list', 'skipped', 'VSP MCP startup could not run.'));
      try { await destination.close?.(); } catch {}
      continue;
    }
    const proxy = new MCPProxy({ binary, destinations: [destination], env: runtimeEnv, log: message => console.error(message) });
    try {
      proxy.start();
      const initialized = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      if (initialized?.error) throw new Error(initialized.error.message || 'MCP initialization failed');
      checks.push(doctorRow(destination.name, 'VSP MCP startup', 'passed', 'initialized'));
      const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      if (listed?.error) throw new Error(listed.error.message || 'MCP tools/list failed');
      const tools = listed.result?.tools || [];
      // Doctor inspects one destination per proxy, so tool names are
      // unprefixed (get_source, run_query); match the slug-prefixed form too
      // in case this ever runs against a multi-destination server.
      const toolPrefix = `${slugifyDestination(destination.name)}_`;
      const localSegments = new Set(['lint_abap', 'get_application_log', 'prepare_abap_change_set', 'apply_abap_change_set', 'check_transport_readiness', 'plan_abap_cloud_migration', 'generate_rap_regression_suite', 'run_rap_regression_suite']);
      const isUpstreamTool = tool => (tool.name.startsWith(toolPrefix) ? tool.name.slice(toolPrefix.length) : tool.name);
      const upstreamCount = tools.filter(tool => !localSegments.has(isUpstreamTool(tool))).length;
      checks.push(doctorRow(destination.name, 'MCP tools/list', upstreamCount ? 'passed' : 'failed', `${upstreamCount} VSP tools and ${tools.length} total MCP tools returned; chat-picker binding is host-managed`));
      const systemInfo = tools.find(tool => tool.name === 'get_system_info' || tool.name === `${toolPrefix}get_system_info`);
      const needsAdtUrl = destination.probe?.status === 'needs-adt-url';
      if (needsAdtUrl) {
        checks.push(doctorRow(destination.name, 'SAP system check', 'skipped', 'No ADT URL is configured for this SAP GUI system; run sap-ai-dev --setup to add one.'));
      } else if (!systemInfo) {
        checks.push(doctorRow(destination.name, 'SAP system check', 'skipped', 'GetSystemInfo is not exposed by this VSP mode.'));
      } else {
        const inspected = await proxy.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: systemInfo.name, arguments: {} } });
        const failed = inspected?.error || inspected?.result?.isError;
        checks.push(doctorRow(destination.name, 'SAP system check', failed ? 'failed' : 'passed', failed ? redactText(inspected?.error?.message || inspected?.result?.content?.[0]?.text || 'GetSystemInfo failed') : 'GetSystemInfo returned successfully'));
      }
    } catch (error) {
      const detail = redactText(error.message || error).slice(0, 300);
      const initialized = checks.some(row => row.name === destination.name && row.stage === 'VSP MCP startup' && row.status === 'passed');
      if (!initialized) checks.push(doctorRow(destination.name, 'VSP MCP startup', 'failed', detail));
      else checks.push(doctorRow(destination.name, 'MCP tools/list', 'failed', detail));
      checks.push(doctorRow(destination.name, 'SAP system check', 'skipped', 'An earlier diagnostic step failed.'));
    } finally {
      await proxy.close();
    }
  }
  const required = checks.filter(check => check.status !== 'skipped');
  stopProgress();
  return { ok: required.every(check => check.status === 'passed'), destinations: destinations.length, checks };
}

async function runOfflineDemo() {
  const demoPath = join(root, 'src', 'demo-vsp.mjs');
  const proxy = new MCPProxy({
    binary: process.execPath,
    childArgs: () => [demoPath],
    destinations: [{ name: 'demo', url: 'http://demo.dest', client: '001', demo: true }],
    env: { ...runtimeEnv, SAP_AI_DEV_TOOLKIT_DESTINATION: 'demo' },
    log: message => console.error(message),
    version: pkg.version
  });
  console.error('[sap-ai-dev-toolkit] offline demo active; all SAP changes are simulated in memory');
  const shutdown = signal => { void proxy.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await proxy.serve(process.stdin);
}

function probeDiagnostic(destination) {
  const probe = destination.probe || {};
  const details = [];
  if (probe.httpStatus) details.push(`HTTP ${probe.httpStatus}`);
  if (probe.error) {
    const error = redactText(probe.error)
      .replace(/\s+/g, ' ')
      .slice(0, 400);
    details.push(error);
  }
  return `[sap-ai-dev] ${destination.name}: probe=${probe.status || 'unknown'}${details.length ? ` (${details.join('; ')})` : ''}`;
}

// npx MCP entries run with --ignore-scripts, so postinstall's verified
// download fallback never ran; a missing or corrupt bundled binary heals here.
// Port detection and the server share one resolution, so a failed download is not repeated.
let binaryResolution;
function binaryOrError() {
  binaryResolution ??= resolveBinary();
  return binaryResolution;
}

async function resolveBinary() {
  const notes = [];
  const found = await findBinary(pkg, { env: runtimeEnv, log: note => notes.push(note) });
  if (found) return found;
  logLine(`[sap-ai-dev] ${notes.join('; ') || 'no VSP binary found'}; downloading a checksum-verified copy`);
  try {
    const downloaded = await downloadBinary(pkg, { env: runtimeEnv });
    logLine(`[sap-ai-dev] VSP binary installed at ${downloaded}`);
    return downloaded;
  } catch (error) {
    notes.push(`download fallback failed: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
  }
  const npxDirectory = root.match(/^(.*[\\/]_npx[\\/][^\\/]+)[\\/]node_modules[\\/]/)?.[1];
  throw new Error([
    `VSP binary ${binaryTarget().asset} is unavailable for ${pkg.name}@${pkg.version}: ${notes.join('; ')}.`,
    npxDirectory
      ? `The npm package ships this binary, so an interrupted install or an antivirus quarantine usually removed it: delete ${npxDirectory} and restart the MCP server so npx reinstalls the package, or set SAP_AI_DEV_TOOLKIT_BINARY to a trusted patched VSP binary.`
      : `Reinstall ${pkg.name} (a git checkout needs npm run build:vsp), check whether antivirus quarantined the binary, or set SAP_AI_DEV_TOOLKIT_BINARY to a trusted patched VSP binary.`
  ].join(' '));
}

async function detectLocalAdtUrl(target) {
  return detectAdtUrl(await binaryOrError(), { ...target, env: runtimeEnv });
}

const adtUrlCachePath = () => join(cacheDirectory(runtimeEnv), 'adt-urls.json');

async function cachedAdtUrls() {
  try { return JSON.parse(await readFile(adtUrlCachePath(), 'utf8')) || {}; }
  catch { return {}; }
}

async function rememberAdtUrl(configured, found) {
  try {
    const path = adtUrlCachePath();
    const urls = { ...await cachedAdtUrls(), [configured.toLowerCase()]: found };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(urls, null, 2)}\n`);
    await rename(temporary, path);
  } catch {
    // The cache only saves a later scan.
  }
}

// A named port gets one probe, a scan result is remembered, and every port is
// swept only when the configuration never named one.
async function resolveLocalAdtUrl(name, configured, client) {
  const log = message => logLine(`[sap-ai-dev] ${name}: ${message}`);
  const detect = target => detectLocalAdtUrl({ client, ...target }).catch(error => ({ url: '', reason: error.message, failed: true }));
  const explicit = hasExplicitPort(configured);
  let verdict = { url: '', reason: '' };
  if (explicit) {
    verdict = await detect({ url: configured, ports: [adtPort(configured)] });
    if (verdict.url) return { url: verdict.url, verified: true };
    log(`ADT did not answer at ${configured}: ${verdict.reason}`);
    if (verdict.unresolved || verdict.failed) return { url: configured, verified: false, reason: verdict.reason };
  }
  const remembered = (await cachedAdtUrls())[configured.toLowerCase()];
  if (remembered) {
    const recheck = await detect({ url: remembered, ports: [adtPort(remembered)] });
    if (recheck.url) {
      log(`ADT answers at ${recheck.url} (found by an earlier port scan)`);
      return { url: recheck.url, verified: true };
    }
  }
  const host = new URL(configured).hostname;
  log(`port scan in progress on ${host} (usual ADT ports)`);
  verdict = await detect({ url: configured });
  if (!verdict.url && !explicit && !verdict.unresolved && !verdict.failed) {
    log(`no ADT port on the usual ports (${verdict.reason}); port scan in progress on every conventional SAP port of ${host} (can take a minute)`);
    verdict = await detect({ url: configured, exhaustive: true });
  }
  if (verdict.url) {
    log(`port scan finished; ADT answers at ${verdict.url}`);
    await rememberAdtUrl(configured, verdict.url);
    return { url: verdict.url, verified: true };
  }
  log(`port scan finished; ${verdict.reason}; keeping ${configured}. Add the ADT port to SAP_URL or rerun sap-ai-dev --setup.`);
  return { url: configured, verified: false, reason: verdict.reason };
}

function noProxyEnv(env, host) {
  const noProxy = [env.NO_PROXY || env.no_proxy, host].filter(Boolean).join(',');
  return { NO_PROXY: noProxy, no_proxy: noProxy };
}

async function discoverForCommand() {
  const env = { ...runtimeEnv };
  if (env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry') env.SAP_AI_DEV_TOOLKIT_DESTINATION = '';
  if (!env.H2O_URL) {
    const systems = await discoverSapGuiSystems({ env });
    if (!systems.length) throw new Error('H2O_URL is required for BAS destination discovery');
    return systems;
  }
  return discoverDestinations({ env });
}

async function configuredLocalSapGuiDestination(env) {
  const name = env.SAP_AI_DEV_TOOLKIT_DESTINATION || env.SAP_SYSTEM_ID || 'local-sap';
  if (!env.SAP_URL) throw new Error('SAP_URL is required for local SAP GUI MCP entries. Rerun sap-ai-dev --setup and enter the ADT URL.');
  const client = env.SAP_CLIENT || '001';
  const systemId = env.SAP_SYSTEM_ID || '';
  const configuredUrl = adtBaseUrl(env.SAP_URL);
  // Older entries used windows-sso, browser-saml or saml-password; all of them now mean browser SSO.
  const sso = !['', 'basic'].includes(String(env.SAP_AUTH_MODE || '').toLowerCase());
  const tlsServerName = String(env.SAP_TLS_SERVER_NAME || env.SAP_AI_DEV_TOOLKIT_TLS_SERVER_NAME || '').trim();
  const tlsServerNames = String(env.SAP_TLS_SERVER_NAMES || env.SAP_AI_DEV_TOOLKIT_TLS_SERVER_NAMES || tlsServerName).split(',').map(value => value.trim()).filter(Boolean);
  const tlsCaFile = String(env.SAP_TLS_CA_FILE || env.SAP_AI_DEV_TOOLKIT_TLS_CA_FILE || '').trim();
  // SNI-routed Basic entries pin port and certificate names on purpose; SSO ignores those names.
  const adt = (sso || !tlsServerNames.length) && !hasPathPrefix(configuredUrl)
    ? await resolveLocalAdtUrl(name, configuredUrl, client)
    : { url: configuredUrl };
  // The scan reached ADT directly, so an env proxy the browser's PAC would bypass must not reroute VSP.
  const direct = adt.verified ? noProxyEnv(env, new URL(adt.url).hostname) : {};
  const probe = adt.verified === undefined
    ? { status: 'configured', available: true }
    : (adt.verified ? { status: `adt-verified at ${adt.url}`, available: true } : { status: `adt-unverified: ${adt.reason}`, available: false });
  if (sso) {
    const cacheKey = `${systemId || new URL(configuredUrl).hostname}-${client}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
    if (isIP(new URL(adt.url).hostname.replace(/^\[(.*)\]$/, '$1'))) logLine(`[sap-ai-dev] ${name}: SSO is configured for an IP address; Kerberos and the browser certificate check need the DNS host name`);
    return {
      source: 'sap-gui-local',
      name,
      url: adt.url,
      client,
      systemId,
      authentication: 'SSO',
      // SAP_SAML_AUTH survives sanitizeChildEnv and would make VSP demand SAML credentials.
      childEnv: { SAP_SSO: 'true', SAP_SSO_SYSTEM: cacheKey, SAP_SAML_AUTH: '', ...direct },
      probe
    };
  }
  const tlsRoute = tlsServerNames.length
    ? await createTlsServerNameAdtProxy({ destinationUrl: configuredUrl, tlsServerNames, caFile: tlsCaFile || undefined })
    : null;
  return {
    source: 'sap-gui-local',
    name,
    url: tlsRoute?.url || adt.url,
    backendUrl: tlsRoute ? configuredUrl : undefined,
    client,
    systemId,
    authentication: 'Basic',
    childEnv: {
      SAP_USER: env.SAP_USER || env.SAP_USERNAME || '',
      SAP_PASSWORD: env.SAP_PASSWORD || env.SAP_PASS || '',
      ...direct
    },
    close: tlsRoute?.close,
    probe: tlsRoute ? { status: 'configured-tls-server-name', available: true } : probe
  };
}

async function main() {
  const setup = hasFlag('--setup');
  const check = hasFlag('--check');
  const list = hasFlag('--list-destinations');
  const doctor = hasFlag('--doctor');
  const demo = hasFlag('--demo');
  if (hasFlag('--help') || hasFlag('-h')) {
    process.stdout.write(usage());
    return;
  }
  if (doctor && demo) throw new Error('Use either --doctor or --demo, not both.');
  if (demo) {
    await runOfflineDemo();
    return;
  }
  if (doctor) {
    let report;
    try {
      const stopDiscoveryProgress = startProgress('Discovering SAP destinations', { output: process.stderr, env: runtimeEnv, label: 'Doctor' });
      let destinations;
      try {
        destinations = runtimeEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry'
          ? [await resolveConfiguredCloudFoundryDestination({ env: runtimeEnv })]
          : (runtimeEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'sap-gui-local'
            ? [await configuredLocalSapGuiDestination(runtimeEnv)]
            : await discoverForCommand());
      } finally {
        stopDiscoveryProgress();
      }
      report = await runDoctor(destinations);
    } catch (error) {
      report = { ok: false, destinations: 0, checks: [doctorRow('-', 'destination discovery', 'failed', redactText(error.message || error).slice(0, 300))] };
    }
    if (hasFlag('--json')) json(report);
    else for (const row of report.checks) console.log(`[${row.status.toUpperCase()}] ${row.name} — ${row.stage}: ${row.detail || ''}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (setup) {
    const setupOptions = {
      includeSapDevelopmentToolsPrompt: hasFlag('--tools') || hasFlag('--companion-tools'),
      detectAdtUrl: detectLocalAdtUrl
    };
    if (hasFlag('--npx')) {
      // Windows has no npx.exe, so generated entries there launch through
      // `cmd /c npx`; other platforms use npx directly.
      const launcher = npxMcpLauncher();
      setupOptions.install = (selected, options) => installMcpConfig(selected, {
        ...options,
        command: launcher.command,
        args: [...launcher.prefixArgs, '--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${pkg.version}`, 'sap-ai-dev']
      });
    }
    await runSetup(setupOptions);
    return;
  }
  if (check || list) {
    const stopProgress = startProgress('Discovering SAP destinations and probing ADT endpoints', { output: process.stderr, env: runtimeEnv });
    let destinations;
    try {
      destinations = await discoverForCommand();
    } finally {
      stopProgress();
    }
    const statuses = statusRows(destinations);
    if (list && hasFlag('--json')) json(statuses);
    else for (const row of statuses) console.error(`${row.name}: client=${row.client} authentication=${row.authentication} probe=${row.probe}`);
    if (check && !destinations.some(destination => destination.probe?.available)) {
      throw new Error('No BAS destination answered the ADT discovery probe successfully. Review the probe results above.');
    }
    return;
  }

  if (['cloud-foundry', 'sap-gui-local'].includes(runtimeEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE)) {
    const destination = runtimeEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry'
      ? await resolveConfiguredCloudFoundryDestination({ env: runtimeEnv })
      : await configuredLocalSapGuiDestination(runtimeEnv);
    let proxy;
    try {
      const binary = await binaryOrError();
      proxy = new MCPProxy({ binary, destinations: [destination], env: runtimeEnv, log: logLine, version: pkg.version });
      const shutdown = signal => { void proxy.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      await proxy.serve(process.stdin);
    } catch (error) {
      await proxy?.close();
      await destination.close?.();
      throw error;
    }
    return;
  }

  if (!runtimeEnv.H2O_URL) {
    if (args().length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
      console.error('sap-ai-dev: no BAS environment detected; starting local interactive setup. Use --help for other commands.');
      await runSetup({ detectAdtUrl: detectLocalAdtUrl });
      return;
    }
    const binary = await binaryOrError();
    // Windows cannot exec .js/.mjs files directly; route JavaScript entries
    // (test fixtures) through the current Node binary like MCPProxy does.
    // Windows .cmd/.bat shims (e.g. a SAP_AI_DEV_TOOLKIT_BINARY override)
    // must go through cmd /c; Node refuses to spawn batch files directly.
    const spawnTarget = /\.(?:mjs|cjs|js)$/i.test(binary)
      ? { command: process.execPath, prefixArgs: [binary] }
      : (/\.(?:cmd|bat)$/i.test(binary)
        ? { command: 'cmd', prefixArgs: ['/c', binary] }
        : { command: binary, prefixArgs: [] });
    const child = spawn(spawnTarget.command, [...spawnTarget.prefixArgs, ...process.argv.slice(2)], { env: runtimeEnv, stdio: 'inherit' });
    process.once('SIGINT', () => child.kill('SIGINT'));
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
    return;
  }

  const stopProgress = startProgress('Discovering BAS destinations and probing ADT endpoints', { output: process.stderr, env: runtimeEnv });
  let discovered;
  try {
    discovered = await discoverDestinations({ env: runtimeEnv });
  } finally {
    stopProgress();
  }
  for (const destination of discovered) logLine(probeDiagnostic(destination));
  const destinations = discovered;
  if (!destinations.length) {
    logLine('[sap-ai-dev] destination discovery returned no named BAS destinations');
    throw new Error(remediation);
  }
  const binary = await binaryOrError();
  logLine(`[sap-ai-dev] sap-ai-dev-toolkit v${pkg.version} (node ${process.version}, pid ${process.pid})`);
  logLine(`[sap-ai-dev] VSP binary: ${binary}`);
  logLine(`[sap-ai-dev] starting MCP proxy for ${destinations.map(destination => `${destination.name} (client=${destination.client})`).join(', ')}`);
  const proxy = new MCPProxy({ binary, destinations, env: process.env, log: logLine, version: pkg.version });
  const shutdown = signal => { void proxy.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await proxy.serve(process.stdin);
}

main().catch(error => {
  console.error(`sap-ai-dev: ${error.message}`);
  process.exitCode = 1;
});
