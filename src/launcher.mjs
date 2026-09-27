#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDestinations, remediation, statusRows } from './bas-discovery.mjs';
import { findBinary } from './binary.mjs';
import { MCPProxy } from './mcp-proxy.mjs';
import { installMcpConfig } from './mcp-config.mjs';
import { runSetup } from './setup.mjs';
import { resolveConfiguredCloudFoundryDestination } from './cf-destination.mjs';
import { withBrandedEnvironment } from './branding.mjs';
import { readCredentials, resolveCredentialsPath } from './credentials-store.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeEnv = withBrandedEnvironment(process.env);

// Attach stored direct-connect credentials (setup prompts for Internet
// destinations) to matching discovered destinations. Credentials stay in
// memory only; nothing is logged or written to the MCP config.
async function enrichWithStoredCredentials(destinations, env = runtimeEnv) {
  const needingCredentials = destinations.filter(destination =>
    destination.source !== 'cloud-foundry'
    && destination.url
    && String(destination.url).includes('.dest'));
  if (!needingCredentials.length) return destinations;
  let stored;
  try {
    const path = await resolveCredentialsPath(env);
    stored = await readCredentials(path);
  } catch (error) {
    console.error(`[sap-ai-dev] stored credentials could not be read: ${String(error.message).slice(0, 200)}`);
    return destinations;
  }
  return destinations.map(destination => {
    const entry = stored.destinations?.[destination.name];
    if (!entry?.host || !entry.user || !entry.password) return destination;
    if (!destination.backendUrl) return destination;
    return { ...destination, credentials: { host: entry.host, user: entry.user, password: entry.password } };
  });
}

function hasFlag(name) { return process.argv.slice(2).includes(name); }
function json(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function usage() {
  return [
    'Usage: sap-ai-dev [options]',
    '',
    'With H2O_URL set and no command, starts the SAP AI Dev Toolkit stdio server for selected BAS destinations.',
    'Options:',
    '  --setup                  Configure generated BAS MCP servers',
    '  --tools                  Also offer full-stack SAP companion MCP servers (use with --setup)',
    '  --npx                    Launch configured MCP servers through the pinned npm package (use with --setup)',
    '  --list-destinations      List discovered BAS destinations',
    '  --list-destinations --json  Print redacted JSON status',
    '  --check                  Probe destination availability',
    '  --doctor                 Check destination, VSP, SAP, and MCP connectivity',
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

function redactText(value) {
  return String(value).replace(/(authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

async function runDoctor(destinations) {
  const checks = [];
  if (!destinations.length) {
    return { ok: false, destinations: 0, checks: [doctorRow('-', 'destination discovery', 'failed', 'No destinations were found. Check H2O_URL or the configured Cloud Foundry destination.')] };
  }
  let binary;
  let binaryError;
  try { binary = await binaryOrError(); }
  catch (error) { binaryError = error.message; }

  for (const destination of destinations) {
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
      const relayedDestination = proxy.children[0]?.destination;
      if (relayedDestination?.relay) {
        checks.push(doctorRow(destination.name, 'BAS destination relay', 'passed', `enabled (${relayedDestination.url}); CSRF token/session pairing active`));
      } else if (destination.source === 'cloud-foundry') {
        checks.push(doctorRow(destination.name, 'BAS destination relay', 'skipped', 'Cloud Foundry destinations connect through the connectivity proxy directly.'));
      } else if (String(runtimeEnv.SAP_AI_DEV_TOOLKIT_DISABLE_BAS_RELAY || '').toLowerCase() === 'true') {
        checks.push(doctorRow(destination.name, 'BAS destination relay', 'skipped', 'Disabled through SAP_AI_DEV_TOOLKIT_DISABLE_BAS_RELAY.'));
      } else {
        checks.push(doctorRow(destination.name, 'BAS destination relay', 'skipped', 'Not applicable for this destination.'));
      }
      if (relayedDestination?.credentials) {
        checks.push(doctorRow(destination.name, 'Direct connect', 'passed', `active (${new URL(relayedDestination.credentials.host).origin}); ADT writes use stored credentials`));
      }
      const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      if (listed?.error) throw new Error(listed.error.message || 'MCP tools/list failed');
      const tools = listed.result?.tools || [];
      const localNames = new Set(['LintABAP', 'GetApplicationLog', 'PrepareABAPChangeSet', 'ApplyABAPChangeSet', 'CheckTransportReadiness', 'PlanABAPCloudMigration', 'GenerateRAPRegressionSuite', 'RunRAPRegressionSuite']);
      const upstreamCount = tools.filter(tool => !localNames.has(tool.name.slice(tool.name.indexOf('__') + 2))).length;
      checks.push(doctorRow(destination.name, 'MCP tools/list', upstreamCount ? 'passed' : 'failed', `${upstreamCount} VSP tools available`));
      const systemInfo = tools.find(tool => tool.name.endsWith('__GetSystemInfo'));
      if (!systemInfo) {
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
  return { ok: required.every(check => check.status === 'passed'), destinations: destinations.length, checks };
}

async function runOfflineDemo() {
  const demoPath = join(root, 'src', 'demo-vsp.mjs');
  const proxy = new MCPProxy({
    binary: process.execPath,
    childArgs: () => [demoPath],
    destinations: [{ name: 'demo', url: 'http://demo.dest', client: '001', demo: true }],
    env: { ...runtimeEnv, SAP_AI_DEV_TOOLKIT_DESTINATION: 'demo' },
    log: message => console.error(message)
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
    const error = String(probe.error)
      .replace(/(authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .replace(/\s+/g, ' ')
      .slice(0, 400);
    details.push(error);
  }
  return `[sap-ai-dev] ${destination.name}: probe=${probe.status || 'unknown'}${details.length ? ` (${details.join('; ')})` : ''}`;
}

async function binaryOrError() {
  const path = await findBinary(pkg, { env: runtimeEnv });
  if (path) return path;
  throw new Error('VSP binary is not installed. Reinstall with scripts enabled, set SAP_AI_DEV_TOOLKIT_BINARY to a trusted patched binary, or run npm run build:vsp.');
}

async function discoverForCommand() {
  const env = { ...runtimeEnv };
  if (env.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry') env.SAP_AI_DEV_TOOLKIT_DESTINATION = '';
  return discoverDestinations({ env });
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
      const destinations = runtimeEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry'
        ? [await resolveConfiguredCloudFoundryDestination({ env: runtimeEnv })]
        : await enrichWithStoredCredentials(await discoverForCommand());
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
      includeSapDevelopmentToolsPrompt: hasFlag('--tools') || hasFlag('--companion-tools')
    };
    if (hasFlag('--npx')) {
      setupOptions.install = (selected, options) => installMcpConfig(selected, {
        ...options,
        command: 'npx',
        args: ['--yes', '--ignore-scripts', `--package=sap-ai-dev-toolkit@${pkg.version}`, 'sap-ai-dev']
      });
    }
    await runSetup(setupOptions);
    return;
  }
  if (check || list) {
    const destinations = await discoverForCommand();
    const statuses = statusRows(destinations);
    if (list && hasFlag('--json')) json(statuses);
    else for (const row of statuses) console.error(`${row.name}: client=${row.client} authentication=${row.authentication} probe=${row.probe}`);
    if (check && !destinations.some(destination => destination.probe?.available)) {
      throw new Error('No BAS destination answered the ADT discovery probe successfully. Review the probe results above.');
    }
    return;
  }

  if (runtimeEnv.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'cloud-foundry') {
    const destination = await resolveConfiguredCloudFoundryDestination({ env: runtimeEnv });
    let proxy;
    try {
      const binary = await binaryOrError();
      proxy = new MCPProxy({ binary, destinations: [destination], env: runtimeEnv, log: message => console.error(message) });
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
    const binary = await binaryOrError();
    const child = spawn(binary, process.argv.slice(2), { env: runtimeEnv, stdio: 'inherit' });
    process.once('SIGINT', () => child.kill('SIGINT'));
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    const [code, signal] = await new Promise(resolve => child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
    return;
  }

  const discovered = await discoverDestinations({ env: runtimeEnv });
  for (const destination of discovered) console.error(probeDiagnostic(destination));
  const destinations = await enrichWithStoredCredentials(discovered);
  if (!destinations.length) {
    console.error('[sap-ai-dev] destination discovery returned no named BAS destinations');
    throw new Error(remediation);
  }
  const binary = await binaryOrError();
  for (const destination of destinations) {
    if (destination.credentials) console.error(`[sap-ai-dev] ${destination.name}: direct connect enabled through stored credentials`);
  }
  console.error(`[sap-ai-dev] starting MCP proxy for ${destinations.map(destination => `${destination.name} (client=${destination.client})`).join(', ')}`);
  const proxy = new MCPProxy({ binary, destinations, env: process.env, log: message => console.error(message) });
  const shutdown = signal => { void proxy.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await proxy.serve(process.stdin);
}

main().catch(error => {
  console.error(`sap-ai-dev: ${error.message}`);
  process.exitCode = 1;
});
