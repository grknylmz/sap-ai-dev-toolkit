#!/usr/bin/env node
// sap-ai-btp: stdio MCP server for SAP BTP core platform administration through
// the user's own btp CLI login (btp login --sso): account hierarchy, entitlements
// and quotas, Service Manager instances and keys, destinations, trust and Cloud
// Connectors. The toolkit stores no credentials for it.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { btpSettingsPath, createBtpCli, resolveBtpCliSettings } from './btp-cli.mjs';
import { registerBtpTools } from './btp-tools.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** Create an injectable server runtime for tests and the stdio executable. */
export function createBtpServer({ env = process.env, execFileImpl } = {}) {
  const settings = resolveBtpCliSettings(env);
  const cli = createBtpCli({ cli: settings.cli, config: settings.config, env, ...(execFileImpl ? { execFileImpl } : {}) });

  const summary = Object.freeze({
    cli: settings.cli,
    cli_source: settings.cliSource,
    config_file: settings.config ?? 'btp CLI default',
    acting_user: 'the user signed in to the btp CLI (btp login --sso)'
  });

  const verify = async () => {
    let cliVersion;
    try {
      cliVersion = await cli.version() ?? 'unknown';
    } catch (error) {
      cliVersion = `failed: ${error?.message || 'btp --version failed'}`;
    }
    let globalAccount;
    try {
      const account = await cli.json(['get', 'accounts/global-account']);
      globalAccount = `ok (${account?.displayName}, subdomain ${account?.subdomain})`;
    } catch (error) {
      globalAccount = `failed: ${error?.message || 'reading the global account failed'}`;
    }
    return { cli_version: cliVersion, global_account: globalAccount };
  };

  const server = new McpServer({
    name: 'sap-ai-btp',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerBtpTools(server, { cli, summary, verify, env });

  let closing;
  const close = () => {
    if (!closing) closing = server.close().catch(() => {});
    return closing;
  };

  return { server, close, verify, connectionSummary: summary };
}

export async function runBtpServer({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    stdout.write([
      'Usage: sap-ai-btp',
      '',
      'Starts a stdio MCP server for SAP BTP core platform administration through your own btp CLI',
      'login: global account hierarchy, entitlements and quotas, Service Manager instances and service',
      'keys, destinations, identity and destination trust, and Cloud Connectors. Creating instances and',
      'service keys requires exact confirmation strings; credentials are always redacted.',
      '',
      'Sign in with "btp login --sso" (sessions last at most 12 hours); the toolkit stores no credentials.',
      '  BTP_CLI                 path to the btp executable (else the location saved by sap-ai-dev --setup-btp, else btp on PATH)',
      '  BTP_CLIENTCONFIG        btp CLI configuration file (else the saved value, else the btp CLI default)',
      `  ${btpSettingsPath(env)}`,
      '                          btp CLI location saved by sap-ai-dev --setup-btp (never mcp.json)',
      '',
      'HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored.',
      '',
      '  --check   verify the btp CLI and its login session; exit 1 when the check fails',
      ''
    ].join('\n'));
    return;
  }
  let runtime;
  try {
    runtime = createBtpServer({ env });
  } catch (error) {
    stderr.write(`[sap-ai-btp] ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.slice(2).includes('--check')) {
    const report = await runtime.verify();
    stdout.write(`${Object.entries(report).map(([name, result]) => `${name}: ${result}`).join('\n')}\n`);
    await runtime.close();
    if (Object.values(report).some(result => String(result).startsWith('failed'))) process.exitCode = 1;
    return;
  }

  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 1024 * 1024 });
  let closing;
  const shutdown = () => {
    if (!closing) closing = runtime.close().catch(() => {});
    return closing;
  };
  const onStdinEnd = () => { void shutdown(); };
  const onSignal = signal => {
    void shutdown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  stdin.once('end', onStdinEnd);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  transport.onerror = () => stderr.write('[sap-ai-btp] MCP stdio transport failed.\n');

  try {
    await runtime.server.connect(transport);
  } catch {
    stderr.write('[sap-ai-btp] MCP server startup failed.\n');
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBtpServer();
}
