import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBinary } from '../src/binary.mjs';
import { detectAdtUrl } from '../src/local-sap-gui.mjs';
import { runSetup } from '../src/setup.mjs';
import { colorText, startProgress } from '../src/terminal-ui.mjs';
import { brandedEnvValue, withBrandedEnvironment } from '../src/branding.mjs';
import { generatedServerName } from '../src/mcp-config.mjs';
import { redactText } from '../src/redact.mjs';
import { announce, runHarnessSetup, withInstallTerminal } from '../src/harness-setup.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeEnv = withBrandedEnvironment(process.env);

async function runInstallSetup(binary) {
  const detect = binary ? target => detectAdtUrl(binary, { ...target, env: runtimeEnv }) : undefined;
  return withInstallTerminal(terminal => runSetup({ env: runtimeEnv, ...(terminal || {}), detectAdtUrl: detect }));
}

function probeCell(destination) {
  const probe = destination.probe || {};
  if (probe.status === 'skipped') return { text: 'SKIPPED (probe disabled)', color: 'yellow' };
  const error = destination.source === 'cloud-foundry' ? '' : redactText(probe.error || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
  const details = [
    probe.httpStatus ? `HTTP ${probe.httpStatus}` : '',
    error
  ].filter(Boolean).join('; ');
  if (probe.available) {
    return { text: `PASS ${probe.status || 'reachable'}${details ? ` (${details})` : ''}`, color: 'green' };
  }
  return { text: `FAIL ${probe.status || 'unknown'}${details ? ` (${details})` : ''}`, color: 'red' };
}

export function destinationTable(destinations, registeredNames) {
  const headings = ['Destination', 'Source', 'Client', 'Authentication', 'ADT probe', 'MCP server'];
  const rows = destinations.map(destination => {
    const probe = probeCell(destination);
    const registered = registeredNames.has(generatedServerName(destination.serverName || destination.name));
    const source = destination.source === 'cloud-foundry'
      ? `CF ${destination.cf?.destinationInstanceName || 'unknown instance'}`
      : (destination.source === 'sap-gui-local' ? 'SAP GUI' : 'BAS');
    return [
      { text: destination.name, output: destination.name },
      { text: source, output: source },
      { text: String(destination.client || '001'), output: String(destination.client || '001') },
      { text: String(destination.authentication || 'Unknown'), output: String(destination.authentication || 'Unknown') },
      { text: probe.text, output: colorText(probe.text, probe.color, true) },
      { text: registered ? 'REGISTERED' : 'NOT REGISTERED', output: colorText(registered ? 'REGISTERED' : 'NOT REGISTERED', registered ? 'green' : 'red', true) }
    ];
  });
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map(row => row[index].text.length)));
  const border = `+${widths.map(width => '-'.repeat(width + 2)).join('+')}+`;
  const formatRow = cells => `|${cells.map((cell, index) => ` ${cell.output}${' '.repeat(widths[index] - cell.text.length)} `).join('|')}|`;
  const coloredBorder = colorText(border, 'cyan', true);
  const coloredHeadings = formatRow(headings.map(text => ({ text, output: colorText(text, 'cyan', true) })));
  return [coloredBorder, coloredHeadings, coloredBorder, ...rows.map(formatRow), coloredBorder].join('\n');
}
async function announceSetup(result) {
  if (result?.reason === 'non-bas') {
    await announce('BAS destination setup was skipped because H2O_URL is not set.\nMCP config was not changed.\nRun sap-ai-dev --setup from a BAS dev space when you are ready.', 'info');
    return;
  }
  if (result?.reason === 'non-tty') {
    await announce('Destination selection was skipped because npm did not provide an interactive terminal.\nMCP config was not changed.\nRun sap-ai-dev --setup from an interactive terminal, or run npx --yes --ignore-scripts sap-ai-dev-toolkit --setup from any terminal.', 'warning');
    return;
  }
  if (result?.reason === 'no-destinations') {
    const details = (result.warnings || []).map(warning => `• ${warning}`).join('\n');
    await announce(`No selectable BAS or Cloud Foundry destinations were found; MCP config was not changed.\nRun sap-ai-dev --setup to retry.${details ? `\n${details}` : ''}`, 'warning');
    return;
  }

  const servers = Object.entries(result?.servers || {});
  const path = result?.path || '(path unavailable)';
  if (!servers.length) {
    await announce([
      'No MCP server entries are configured for this add-on.',
      `MCP config file: ${path}`,
      'No destinations were selected, so previously managed entries were removed. Other servers and settings were preserved.',
      'Run sap-ai-dev --setup to choose destinations later.'
    ].join('\n'), 'info');
    return;
  }

  const selected = result.selected || [];
  const destinationsByServer = new Map(selected.map(destination => [
    generatedServerName(destination.serverName || destination.name),
    destination
  ]));
  const registeredNames = new Set(servers.map(([name]) => name));
  const entryDetails = servers.flatMap(([name, entry]) => {
    const destination = destinationsByServer.get(name);
    const configuredSource = brandedEnvValue(entry.env, 'DESTINATION_SOURCE') || destination?.source;
    const source = configuredSource === 'cloud-foundry'
      ? 'Cloud Foundry'
      : (configuredSource === 'sap-gui-local' ? 'Local SAP GUI' : 'BAS');
    const destinationName = brandedEnvValue(entry.env, 'DESTINATION') || destination?.name || 'unknown';
    const client = destination?.client || '001';
    const authentication = destination?.authentication || 'unknown';
    const args = Array.isArray(entry.args) ? entry.args : [];
    const command = [entry.command, ...args].filter(value => typeof value === 'string' && value.length > 0).join(' ');
    const environmentKeys = Object.keys(entry.env || {}).sort().join(', ');
    return [
      `• ${colorText(name, 'cyan', true)}`,
      `  Destination: ${source} · ${destinationName} · client ${client} · ${authentication}`,
      `  Launch: ${entry.type || 'stdio'} · ${command || '(command unavailable)'}`,
      `  Environment keys: ${environmentKeys || '(none)'}`
    ];
  });
  const message = [
    'Installation configuration summary',
    `MCP config file: ${path}`,
    `Configured MCP entries (${servers.length}):`,
    ...entryDetails,
    '',
    destinationTable(selected, registeredNames),
    `Probe guide: ${colorText('PASS', 'green', true)} = ADT responded (2xx/401/403) · ${colorText('FAIL', 'red', true)} = probe failed · ${colorText('SKIPPED', 'yellow', true)} = probe disabled.`,
    'Probe results are informational; only selected destinations are registered.',
    'Unrelated MCP servers and settings were preserved. Authentication remains in BAS/Cloud Foundry; credentials were not copied into the MCP file.',
    'Inspect: BAS/VS Code → “MCP: Open User Configuration”. Start: “MCP: List Servers” → select a generated server → “Start Server”.'
  ].join('\n');
  await announce(message, 'success');
}

async function main() {
  if (process.env.npm_config_ignore_scripts === 'true') return;

  // Go is intentionally NOT provisioned here: the installed package never
  // runs `go` (only the repository-only build script does), so a toolchain
  // download at install time was pure cost. The pinned, checksum-verified runtime
  // binary ships with the package; the download below is the fallback.
  let binary = brandedEnvValue(runtimeEnv, 'BINARY');
  try {
    if (binary) {
      await announce('Using the SAP_AI_DEV_TOOLKIT_BINARY override.', 'info');
    } else {
      // The bundled binary resolves in milliseconds; the animation only
      // appears when provisioning actually takes time (download fallback).
      const stopBinaryProgress = startProgress('Preparing the pinned runtime for this platform', { output: process.stderr, env: runtimeEnv });
      try {
        binary = await installBinary(pkg, { env: runtimeEnv });
        stopBinaryProgress();
        await announce('Pinned runtime installed and ready.', 'success');
      } catch (error) {
        stopBinaryProgress();
        throw new Error(`Runtime provisioning failed: ${error.message}`);
      }
    }
  } catch (error) {
    await announce(error.message, 'error');
    await announce('Set SAP_AI_DEV_TOOLKIT_BINARY only when supplying a trusted prebuilt runtime executable.', 'info');
    process.exitCode = 1;
    return;
  }

  let setupResult;
  let setupCompleted = false;
  try {
    setupResult = await runInstallSetup(binary);
    setupCompleted = true;
  } catch (error) {
    await announce(`BAS MCP setup failed: ${error.message}`, 'error');
    await announce('Rerun sap-ai-dev --setup.', 'info');
  }

  await runHarnessSetup(setupResult?.servers, { env: runtimeEnv, root, wire: setupCompleted });
  if (setupCompleted) await announceSetup(setupResult);
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch(error => {
    console.error(formatStatus(`Postinstall failed: ${error.message}`, 'error', process.stderr));
    process.exitCode = 1;
  });
}
