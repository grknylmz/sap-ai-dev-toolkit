import { open, readFile } from 'node:fs/promises';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBinary } from '../src/binary.mjs';
import { runSetup } from '../src/setup.mjs';
import { installUserAssetsForHarnesses } from '../src/install-user-assets.mjs';
import { installMcpServersForHarnesses } from '../src/harness-mcp-config.mjs';
import { DEFAULT_HARNESS_IDS, HARNESSES, HARNESS_ENV_VAR, NON_INTERACTIVE_HARNESS_IDS, envHarnessSelection, harnessRoot } from '../src/harnesses.mjs';
import { ReadStream as TTYReadStream, WriteStream as TTYWriteStream } from 'node:tty';
import { homedir } from 'node:os';
import { checkboxPrompt, colorText, formatStatus } from '../src/terminal-ui.mjs';
import { brandedEnvValue, withBrandedEnvironment } from '../src/branding.mjs';
import { generatedServerName } from '../src/mcp-config.mjs';
import { redactText } from '../src/redact.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeEnv = withBrandedEnvironment(process.env);

async function announce(message, tone = 'info') {
  const content = message.replace(/^sap-ai-dev-toolkit:\s*/, '');
  // Windows cannot open CONOUT$ as a writable console stream from a
  // piped npm script (libuv normalizes the device name, and the resulting
  // handle drops writes), so output goes through stderr unconditionally.
  if (process.platform === 'win32') {
    console.error(formatStatus(content, tone, process.stderr));
    return;
  }
  let terminal;
  try {
    terminal = await open('/dev/tty', 'w');
    await terminal.write(`${formatStatus(content, tone, true)}\n`);
  } catch {
    console.error(formatStatus(content, tone, process.stderr));
  } finally {
    await terminal?.close().catch(() => {});
  }
}

function openControllingTerminal() {
  if (process.platform === 'win32') {
    // fs cannot open CONIN$/CONOUT$ (libuv path normalization rejects the
    // device names), so there is no controlling-terminal recovery on
    // Windows: npm-script installs run non-interactively and the printed
    // guidance points at `sap-ai-dev --setup` in a real terminal.
    throw new Error('controlling terminal recovery is unavailable on Windows');
  }
  const inputFd = openSync('/dev/tty', 'r');
  let outputFd;
  try {
    outputFd = openSync('/dev/tty', 'w');
    return { input: new TTYReadStream(inputFd), output: new TTYWriteStream(outputFd) };
  } catch (error) {
    closeSync(inputFd);
    if (outputFd !== undefined) closeSync(outputFd);
    throw error;
  }
}

async function withInstallTerminal(action) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return action({ input: process.stdin, output: process.stdout });
  }
  let terminal;
  try {
    terminal = openControllingTerminal();
  } catch {
    return action(null);
  }
  try {
    return await action(terminal);
  } finally {
    terminal.input.destroy();
    terminal.output.destroy();
  }
}

async function runInstallSetup() {
  return withInstallTerminal(terminal => runSetup({ env: runtimeEnv, ...(terminal || {}) }));
}

function harnessSelectionLabels(ids) {
  return HARNESSES.filter(harness => ids.includes(harness.id)).map(harness => harness.label).join(', ');
}

async function resolveHarnessOverride() {
  try {
    return envHarnessSelection(runtimeEnv);
  } catch (error) {
    await announce(`${error.message} Ignoring ${HARNESS_ENV_VAR}.`, 'warning');
    return null;
  }
}

async function installSelectedHarnessAssets(ids) {
  const { results, failures } = await installUserAssetsForHarnesses(ids, { root });
  for (const failure of failures) {
    await announce(`${failure.label}: bundled agent and skill installation failed: ${failure.error.message}`, 'error');
  }
  for (const assets of results) {
    const installed = assets.installed + assets.updated;
    const removed = assets.removed || 0;
    const cleanup = removed > 0 ? `; ${removed} duplicate or legacy file${removed === 1 ? '' : 's'} removed` : '';
    await announce(`${assets.label}: ${installed} file${installed === 1 ? '' : 's'} installed or updated in ${assets.root}; ${assets.unchanged} already current${cleanup}.`, 'success');
    if (assets.conflicts.length > 0) {
      const paths = assets.conflicts.map(path => join(assets.root, path)).join(', ');
      await announce(`${assets.label}: existing customizations were preserved; review these paths: ${paths}`, 'warning');
    }
  }
  const total = results.reduce((sum, assets) => sum + assets.installed + assets.updated, 0);
  if (results.length > 0) {
    await announce(`Installed ${total} files across ${results.length} harness${results.length === 1 ? '' : 'es'}.`, 'success');
  }
}

async function runHarnessAssetInstall() {
  const home = process.env.HOME || homedir();
  const override = await resolveHarnessOverride();
  return withInstallTerminal(async terminal => {
    let selected = override;
    if (!terminal) {
      if (!selected) selected = NON_INTERACTIVE_HARNESS_IDS;
      await announce(`Installing bundled agents and skills for ${harnessSelectionLabels(selected)} by default because no interactive terminal is available.`, 'progress');
      await installSelectedHarnessAssets(selected);
      return selected;
    }
    if (!selected) selected = DEFAULT_HARNESS_IDS;
    await announce([
      'The bundled agents and skills can be installed for several AI coding harnesses.',
      '',
      'Space = select or deselect · a = toggle all · Enter = confirm. Pressing Enter without changes installs the pre-checked harnesses; confirming with none selected skips this step.',
      '',
      `${colorText('📁 Target folders:', 'cyan', true)}`,
      ...HARNESSES.map(harness => `   ${harnessRoot(harness, { home, env: runtimeEnv })} — ${harness.label} (${harness.supportsAgents ? 'skills + agents' : 'skills only'})`),
      ''
    ].join('\n'), 'copilot');
    let answer;
    try {
      answer = await checkboxPrompt({
        message: colorText('🤖 Install bundled agents and skills for', 'magenta', terminal.output),
        choices: HARNESSES.map(harness => ({
          value: harness.id,
          name: `${harness.label} (${harness.supportsAgents ? 'skills + agents' : 'skills'})`,
          checked: selected.includes(harness.id)
        })),
        required: false,
        shortcuts: { all: 'a' }
      }, { input: terminal.input, output: terminal.output });
    } catch (error) {
      if (error.message === 'Prompt interrupted') {
        await announce('Bundled agents and skills were skipped because the prompt was interrupted. Your files were not changed.', 'info');
        return [];
      }
      throw error;
    }
    if (answer.length === 0) {
      await announce('Bundled agents and skills were skipped. Your files were not changed.', 'info');
      return [];
    }
    await installSelectedHarnessAssets(answer);
    return answer;
  });
}

async function wireHarnessMcpServers(ids, servers) {
  const entries = servers && Object.keys(servers).length ? servers : null;
  if (!entries || !ids?.length) return;
  const hasLocalSapGui = Object.values(entries).some(entry => entry?.env?.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'sap-gui-local');
  if (hasLocalSapGui) {
    await announce('Local SAP GUI MCP entries use VS Code input prompts for SAP login, so automatic wiring into non-VS Code harness MCP files was skipped. Configure those harnesses manually if they support secure runtime prompts.', 'info');
    return;
  }
  const { results, failures } = await installMcpServersForHarnesses(ids, entries, { env: runtimeEnv });
  for (const result of results) {
    if (!result.supported) {
      await announce(`${result.label}: MCP auto-wiring skipped. ${result.skipped}`, 'info');
      continue;
    }
    await announce(`${result.label}: wired ${result.servers} MCP server${result.servers === 1 ? '' : 's'} in ${result.path}.`, 'success');
  }
  for (const failure of failures) {
    await announce(`${failure.label}: MCP auto-wiring failed: ${failure.error.message}`, 'error');
  }
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
    await announce('Destination selection was skipped because npm did not provide an interactive terminal.\nMCP config was not changed.\nRun sap-ai-dev --setup from an interactive BAS terminal, or run npx --yes --ignore-scripts --package=sap-ai-dev-toolkit sap-ai-dev --setup --npx.', 'warning');
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
  // runs `go` (only the repository-only build:vsp script does), so a toolchain
  // download at install time was pure cost. The pinned, checksum-verified VSP
  // binary ships with the package; the download below is the fallback.
  try {
    if (brandedEnvValue(runtimeEnv, 'BINARY')) {
      await announce('Using the SAP_AI_DEV_TOOLKIT_BINARY override.', 'info');
    } else {
      await announce('Preparing the pinned VSP runtime for this platform.', 'progress');
      try {
        await installBinary(pkg, { env: runtimeEnv });
        await announce('Pinned VSP binary installed and ready.', 'success');
      } catch (error) {
        throw new Error(`VSP binary provisioning failed: ${error.message}`);
      }
    }
  } catch (error) {
    await announce(error.message, 'error');
    await announce('Set SAP_AI_DEV_TOOLKIT_BINARY only when supplying a trusted prebuilt VSP executable.', 'info');
    process.exitCode = 1;
    return;
  }

  let setupResult;
  let setupCompleted = false;
  try {
    setupResult = await runInstallSetup();
    setupCompleted = true;
  } catch (error) {
    await announce(`BAS MCP setup failed: ${error.message}`, 'error');
    await announce('Rerun sap-ai-dev --setup.', 'info');
  }

  let harnessIds = [];
  try {
    harnessIds = await runHarnessAssetInstall();
  } catch (error) {
    await announce(`Bundled agent and skill installation failed: ${error.message}`, 'error');
  }
  try {
    if (setupCompleted) await wireHarnessMcpServers(harnessIds, setupResult?.servers);
  } catch (error) {
    await announce(`Harness MCP auto-wiring failed: ${error.message}`, 'error');
  }
  if (setupCompleted) await announceSetup(setupResult);
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch(error => {
    console.error(formatStatus(`Postinstall failed: ${error.message}`, 'error', process.stderr));
    process.exitCode = 1;
  });
}
