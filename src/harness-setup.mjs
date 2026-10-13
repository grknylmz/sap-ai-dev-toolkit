import { open } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ReadStream as TTYReadStream, WriteStream as TTYWriteStream } from 'node:tty';
import { installMcpServersForHarnesses } from './harness-mcp-config.mjs';
import { installUserAssetsForHarnesses } from './install-user-assets.mjs';
import { DEFAULT_HARNESS_IDS, HARNESSES, HARNESS_ENV_VAR, NON_INTERACTIVE_HARNESS_IDS, envHarnessSelection, harnessRoot } from './harnesses.mjs';
import { checkboxPrompt, colorText, formatStatus } from './terminal-ui.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function announce(message, tone = 'info') {
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
    // npm can pipe lifecycle script streams even when the install was
    // launched from an interactive Windows console. Verify console access,
    // then attach Node TTY streams to its standard console devices.
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OpenStandardInput(); [Console]::OpenStandardOutput()'], { stdio: 'ignore', windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error('interactive console is unavailable');
    const inputFd = openSync('CONIN$', 'r');
    let outputFd;
    try {
      outputFd = openSync('CONOUT$', 'w');
      return { input: new TTYReadStream(inputFd), output: new TTYWriteStream(outputFd) };
    } catch (error) {
      closeSync(inputFd);
      if (outputFd !== undefined) closeSync(outputFd);
      throw error;
    }
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

export async function withInstallTerminal(action) {
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

function harnessSelectionLabels(ids) {
  return HARNESSES.filter(harness => ids.includes(harness.id)).map(harness => harness.label).join(', ');
}

async function resolveHarnessOverride(env) {
  try {
    return envHarnessSelection(env);
  } catch (error) {
    await announce(`${error.message} Ignoring ${HARNESS_ENV_VAR}.`, 'warning');
    return null;
  }
}

async function installSelectedHarnessAssets(ids, { env, home, root }) {
  const { results, failures } = await installUserAssetsForHarnesses(ids, { env, home, root });
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

async function runHarnessAssetInstall({ env = process.env, root = packageRoot } = {}) {
  const home = env.HOME || homedir();
  const override = await resolveHarnessOverride(env);
  return withInstallTerminal(async terminal => {
    let selected = override;
    if (!terminal) {
      if (!selected) selected = NON_INTERACTIVE_HARNESS_IDS;
      await announce(`Installing bundled agents and skills for ${harnessSelectionLabels(selected)} by default because no interactive terminal is available.`, 'progress');
      await installSelectedHarnessAssets(selected, { env, home, root });
      return selected;
    }
    if (!selected) selected = DEFAULT_HARNESS_IDS;
    await announce([
      'The bundled agents and skills can be installed for several AI coding harnesses.',
      '',
      'Space = select or deselect · a = toggle all · Enter = confirm. Pressing Enter without changes installs the pre-checked harnesses; confirming with none selected skips this step.',
      '',
      `${colorText('📁 Target folders:', 'cyan', true)}`,
      ...HARNESSES.map(harness => `   ${harnessRoot(harness, { home, env })} — ${harness.label} (${harness.supportsAgents ? 'skills + agents' : 'skills only'})`),
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
    await installSelectedHarnessAssets(answer, { env, home, root });
    return answer;
  });
}

async function wireHarnessMcpServers(ids, servers, env) {
  const entries = servers && Object.keys(servers).length ? servers : null;
  if (!entries || !ids?.length) return;
  const hasLocalSapGui = Object.values(entries).some(entry => entry?.env?.SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE === 'sap-gui-local');
  if (hasLocalSapGui) {
    await announce('Local SAP GUI MCP entries use VS Code input prompts for SAP login, so automatic wiring into non-VS Code harness MCP files was skipped. Configure those harnesses manually if they support secure runtime prompts.', 'info');
    return;
  }
  const { results, failures } = await installMcpServersForHarnesses(ids, entries, { env });
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

export async function runHarnessSetup(servers, { env = process.env, root = packageRoot, wire = true } = {}) {
  let ids = [];
  try {
    ids = await runHarnessAssetInstall({ env, root });
  } catch (error) {
    await announce(`Bundled agent and skill installation failed: ${error.message}`, 'error');
  }
  if (wire) {
    try {
      await wireHarnessMcpServers(ids, servers, env);
    } catch (error) {
      await announce(`Harness MCP auto-wiring failed: ${error.message}`, 'error');
    }
  }
  return ids;
}