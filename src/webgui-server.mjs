#!/usr/bin/env node
// sap-ai-webgui: launches the bundled native SAP GUI for HTML (WebGUI) MCP
// server (native/webgui, Rust). No server logic lives here.
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { brandedEnvValue } from './branding.mjs';
import { bundledWebguiBinaryPath, verifyAgainstPackagedChecksums, webguiBinaryTarget } from './binary.mjs';
import { findSsoBrowsers } from './sso-browsers.mjs';

function exit(message) {
  process.stderr.write(`[sap-ai-webgui] ${message}\n`);
  process.exitCode = 1;
}

async function resolveBinary() {
  const override = brandedEnvValue(process.env, 'WEBGUI_BINARY');
  if (override) return override;
  const target = webguiBinaryTarget();
  const path = bundledWebguiBinaryPath();
  try {
    await stat(path);
  } catch {
    throw new Error(`native executable not found at ${path}; reinstall sap-ai-dev-toolkit (or npm run build:webgui in a checkout)`);
  }
  if (await verifyAgainstPackagedChecksums(path, target) === false) {
    throw new Error(`native executable ${target.asset} failed checksum verification`);
  }
  return path;
}

// The native server drives a Chromium browser; hand it the same browser the
// SSO discovery finds unless the host pinned one.
async function childEnv(env) {
  if (env.SAP_AI_WEBGUI_BROWSER || env.SAP_BROWSER_EXEC) return env;
  try {
    const [browser] = await findSsoBrowsers({ env });
    if (browser?.path) return { ...env, SAP_AI_WEBGUI_BROWSER: browser.path };
  } catch {}
  return env;
}

async function main() {
  let path;
  try {
    path = await resolveBinary();
    await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      exit(`native executable not found at ${path}; reinstall sap-ai-dev-toolkit (or npm run build:webgui in a checkout)`);
    } else {
      exit(error.message);
    }
    return;
  }
  if (process.platform !== 'win32') {
    try {
      await access(path, fsConstants.X_OK);
    } catch {
      await chmod(path, 0o755).catch(() => {});
    }
  }
  const child = spawn(path, process.argv.slice(2), { stdio: 'inherit', env: await childEnv(process.env) });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', error => exit(`could not start ${path}: ${error.code || error.message}`));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + osConstants.signals[signal] : 1);
  });
}

await main();
