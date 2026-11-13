#!/usr/bin/env node
// sap-ai-aem: launches the bundled native SAP Integration Suite, advanced event
// mesh MCP server (native/aem, Rust). No server logic lives here.
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { brandedEnvValue } from './branding.mjs';
import { aemBinaryTarget, bundledAemBinaryPath, verifyAgainstPackagedChecksums } from './binary.mjs';

function exit(message) {
  process.stderr.write(`[sap-ai-aem] ${message}\n`);
  process.exitCode = 1;
}

async function resolveBinary() {
  const override = brandedEnvValue(process.env, 'AEM_BINARY');
  if (override) return override;
  const target = aemBinaryTarget();
  const path = bundledAemBinaryPath();
  try {
    await stat(path);
  } catch {
    throw new Error(`native executable not found at ${path}; reinstall sap-ai-dev-toolkit (or npm run build:aem in a checkout)`);
  }
  if (await verifyAgainstPackagedChecksums(path, target) === false) {
    throw new Error(`native executable ${target.asset} failed checksum verification`);
  }
  return path;
}

async function main() {
  let path;
  try {
    path = await resolveBinary();
    await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      exit(`native executable not found at ${path}; reinstall sap-ai-dev-toolkit (or npm run build:aem in a checkout)`);
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
  const child = spawn(path, process.argv.slice(2), { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', error => exit(`could not start ${path}: ${error.code || error.message}`));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + osConstants.signals[signal] : 1);
  });
}

await main();
