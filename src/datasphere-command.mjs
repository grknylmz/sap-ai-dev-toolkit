// Direct SAP CLI access with a tenant URL and a short-lived browser passcode.
// Only the tenant URL and discovery catalog are remembered; authentication is temporary.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { datasphereCliEnvironment } from './datasphere-cli.mjs';
import { loadDatasphereCommands } from './datasphere-discovery.mjs';
import { readStoredDatasphereCredentials } from './datasphere-credentials.mjs';
import { userConfigFilePath, writeUserOnlyJson } from './integration-credentials.mjs';
import { openInBrowser } from './datasphere-auth.mjs';
import { textPrompt } from './terminal-ui.mjs';

const require = createRequire(import.meta.url);
const CAPTURE_LIMIT = 1024 * 1024;
const MANAGED_AUTH = /^(?:--(?:options-file|secrets-file|client-id|client-secret|access-token|refresh-token|authorization-url|token-url|authorization-flow|code|login-id)(?:=|$)|-[OscCatAr](?:[^-]|$))/;

export function datasphereCommandUsage() {
  return [
    'Usage: sap-ai-dev --datasphere [--host <tenant URL>] <command> [options]',
    '',
    'Run the bundled SAP Datasphere CLI using your user and a browser temporary code.',
    'The tenant URL and command catalog are remembered. Each command opens the SAP code page.',
    'The first run needs two fresh codes: one for the catalog, then one for the command.',
    '',
    '  sap-ai-dev --datasphere objects views list --space MY_SPACE',
    '  sap-ai-dev --datasphere --host https://<tenant>.eu20.hcs.cloud.sap objects views list --space MY_SPACE',
    '  sap-ai-dev --datasphere --version',
    '',
    '  --passcode-stdin  Read a temporary code from standard input instead of opening the browser',
    '',
    'Native SAP command options and confirmations apply. Temporary code files are removed after the command.',
    'For persistent OAuth-based MCP access, use sap-ai-dev --setup-datasphere.',
    ''
  ].join('\n');
}

function tenantUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Datasphere tenant URL is invalid');
  value = value.trim();
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`); }
  catch { throw new Error('Datasphere tenant URL is invalid'); }
  if (url.username || url.password) throw new Error('Datasphere tenant URL must not contain credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Datasphere tenant URL must use https');
  }
  return url.origin;
}

function parseArguments(argv) {
  const command = [];
  let host;
  let passcode;
  let fromStdin = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--passcode-stdin') { fromStdin = true; continue; }
    const option = /^(--host|-H|--passcode|-p)(?:=(.*))?$/.exec(arg);
    const attached = /^(-H|-p)([^=].+)$/.exec(arg);
    if (option || attached) {
      const name = (option || attached)[1];
      const value = attached?.[2] ?? option[2] ?? argv[++index];
      if (!value || (name === '--host' || name === '-H') && value.startsWith('-')) throw new Error(`Missing value for ${name}`);
      if (name === '--host' || name === '-H') host = value;
      else passcode = value;
    } else {
      if (MANAGED_AUTH.test(arg)) throw new Error('This command uses browser-code authentication; configure OAuth with sap-ai-dev --setup-datasphere.');
      command.push(arg);
    }
  }
  if (passcode && fromStdin) throw new Error('Use either --passcode or --passcode-stdin');
  return { command, host, passcode, fromStdin };
}

async function rememberedTenant(env) {
  const path = userConfigFilePath(env, 'datasphere-cli.json');
  try { return JSON.parse(await readFile(path, 'utf8'))?.url; }
  catch (error) {
    if (error.code === 'ENOENT') return readStoredDatasphereCredentials(env)?.url;
    throw new Error('Stored Datasphere CLI tenant could not be read; supply --host <tenant URL> to replace it.');
  }
}

async function readPasscode(input) {
  let value = '';
  for await (const chunk of input) {
    value += chunk.toString();
    if (value.length > 4096) throw new Error('Temporary authentication code is too long');
  }
  return value.trim();
}

// Copy only SAP's discovery files; OAuth secrets and authentication files never persist.
async function copyDiscoveryCache(from, to) {
  const relative = join('.@sap', 'datasphere-cli', '.cache');
  let names;
  try { names = await readdir(join(from, relative)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const files = names.filter(name => /^discovery-.*\.json$/.test(name));
  if (!files.length) return;
  await mkdir(join(to, relative), { recursive: true, mode: 0o700 });
  await Promise.all(files.map(name => copyFile(join(from, relative, name), join(to, relative, name))));
}

/** Run a native SAP command. Prompt text goes to stderr, leaving stdout for the command result. */
export async function runDatasphereCommand(argv, {
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  cwd = process.cwd(),
  spawnImpl = spawn,
  openUrl = openInBrowser,
  prompt = textPrompt
} = {}) {
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write(datasphereCommandUsage());
    return 0;
  }
  const parsed = parseArguments(argv);
  const versionOnly = parsed.command.length === 1 && ['--version', '-v'].includes(parsed.command[0]);
  let host;
  if (!versionOnly) {
    host = parsed.host || env.DATASPHERE_URL || await rememberedTenant(env);
    if (!host) {
      if (!input.isTTY) throw new Error('Supply --host <tenant URL> on the first Datasphere command.');
      host = await prompt({ message: 'Datasphere tenant URL', validate: value => { try { tenantUrl(value); return true; } catch (error) { return error.message; } } }, { input, output: errorOutput });
    }
    host = tenantUrl(host);
    if (!parsed.passcode && !parsed.fromStdin && !input.isTTY) throw new Error('Browser sign-in needs a terminal; use --passcode-stdin to supply a temporary code through standard input.');
    await writeUserOnlyJson(userConfigFilePath(env, 'datasphere-cli.json'), { url: host });
  }
  const entry = require.resolve('@sap/datasphere-cli/terminal.js');
  const version = JSON.parse(await readFile(require.resolve('@sap/datasphere-cli/package.json'), 'utf8')).version;
  const cacheHome = host ? userConfigFilePath(env, join('datasphere-cli-cache', `${createHash('sha256').update(host).digest('hex').slice(0, 24)}-${version}`)) : null;
  const dir = await mkdtemp(join(tmpdir(), 'sap-ai-datasphere-command-'));
  const childEnv = datasphereCliEnvironment(env, dir);
  const optionsPath = join(dir, 'options.json');
  let passcode = parsed.passcode || '';
  let activeChild;
  let interrupted;
  const interrupt = signal => {
    interrupted = signal;
    if (activeChild) activeChild.kill(signal);
    else if (parsed.fromStdin) input.destroy(new Error('Datasphere command interrupted'));
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  const exitCode = (code, signal) => code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  const run = (args, capture = false) => new Promise((resolve, reject) => {
    if (interrupted) { resolve({ code: exitCode(null, interrupted), stdout: '', stderr: '' }); return; }
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let oversized = false;
    const child = spawnImpl(process.execPath, [entry, ...args], {
      cwd, env: childEnv, stdio: capture ? ['ignore', 'pipe', 'pipe'] : [input, output, errorOutput],
      ...(capture ? { timeout: 180_000, windowsHide: true } : {})
    });
    activeChild = child;
    if (capture) for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > CAPTURE_LIMIT) { oversized = true; child.kill(); return; }
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
      });
    }
    child.once('error', error => reject(new Error(`Could not start the SAP Datasphere CLI (${error.code || 'process error'})`)));
    child.once('close', (code, signal) => {
      activeChild = null;
      if (oversized) reject(new Error('SAP Datasphere CLI initialization output exceeded its size limit'));
      else resolve({ code: exitCode(code, signal), stdout, stderr });
    });
  });
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    if (versionOnly) return (await run(parsed.command)).code;
    await copyDiscoveryCache(cacheHome, dir);
    const cached = await loadDatasphereCommands({ cli: { init: async () => {}, stateDir: () => dir } }).then(() => true, () => false);
    const initializeOnly = parsed.command.slice(0, 3).join(' ') === 'config cache init';
    if (!cached && !initializeOnly && (parsed.fromStdin || parsed.passcode && !input.isTTY)) {
      throw new Error('The CLI catalog needs one-time initialization. Run sap-ai-dev --datasphere config cache init --host <tenant URL> first, using a fresh browser code.');
    }
    let codeUrl;
    const browserCode = async () => {
      if (!codeUrl) {
        const result = await run(['config', 'passcode-url', '--host', host], true);
        if (result.code) throw new Error('Could not resolve the SAP browser login URL. Check the tenant URL.');
        codeUrl = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^https:\/\//.test(line));
        if (!codeUrl) throw new Error('SAP Datasphere CLI returned no browser login URL.');
      }
      errorOutput.write(`Sign in at ${codeUrl}, then copy the temporary authentication code.\n`);
      try { await openUrl(codeUrl); } catch { /* The printed URL also works on remote terminals. */ }
      return prompt({ message: 'Temporary authentication code', secret: true }, { input, output: errorOutput });
    };
    const writePasscode = async () => {
      if (!passcode || /\s/.test(passcode) || passcode.length > 4096) throw new Error('Supply one non-empty temporary authentication code.');
      await writeFile(optionsPath, JSON.stringify({ host, passcode }), { mode: 0o600 });
    };
    if (parsed.fromStdin) passcode = await readPasscode(input);
    else if (!passcode) passcode = await browserCode();
    await writePasscode();
    if (!cached && !initializeOnly) {
      const initialized = await run(['config', 'cache', 'init', '--host', host, '--options-file', optionsPath], true);
      if (interrupted) return exitCode(null, interrupted);
      if (initialized.code) {
        const detail = (initialized.stderr || initialized.stdout).split(passcode).join('[redacted]').trim().slice(0, 1200);
        throw new Error(`Datasphere CLI initialization failed${detail ? `: ${detail}` : ''}`);
      }
      await copyDiscoveryCache(dir, cacheHome);
      errorOutput.write('Catalog initialized. A fresh browser code is needed for the requested command.\n');
      passcode = await browserCode();
      await writePasscode();
    }
    const result = await run([...(parsed.command.length ? parsed.command : ['--help']), '--host', host, '--options-file', optionsPath]);
    if (result.code === 0) {
      if (parsed.command.slice(0, 3).join(' ') === 'config cache clean') await rm(cacheHome, { recursive: true, force: true });
      else await copyDiscoveryCache(dir, cacheHome);
    }
    return result.code;
  } catch (error) {
    if (interrupted) return exitCode(null, interrupted);
    throw error;
  } finally {
    passcode = '';
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await rm(dir, { recursive: true, force: true });
  }
}
