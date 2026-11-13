#!/usr/bin/env node
// sap-ai-cloud-alm: stdio MCP server for SAP Cloud ALM operations (landscape,
// Integration & Exception Monitoring, analytics, features/transports, event
// situations) with service-key client credentials.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCloudAlmRestClient, verifyCloudAlmAccess } from './cloud-alm-client.mjs';
import { resolveCloudAlmConfig } from './cloud-alm-config.mjs';
import { cloudAlmCredentialsPath, readStoredCloudAlmCredentials } from './cloud-alm-credentials.mjs';
import { registerCloudAlmTools } from './cloud-alm-tools.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** Create an injectable server runtime for tests and the stdio executable. */
export function createCloudAlmServer({ env = process.env, fetchImpl } = {}) {
  const config = resolveCloudAlmConfig(env, { stored: readStoredCloudAlmCredentials(env) });
  const rest = createCloudAlmRestClient(config, { env, ...(fetchImpl ? { fetchImpl } : {}) });

  const summary = Object.freeze({
    api_host: new URL(config.url).host,
    token_host: new URL(config.tokenUrl).host,
    auth: 'client_credentials',
    source: config.source
  });

  const verify = () => verifyCloudAlmAccess(rest);

  const server = new McpServer({
    name: 'sap-ai-cloud-alm',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerCloudAlmTools(server, { rest, summary, verify });

  let closing;
  const close = () => {
    if (!closing) closing = server.close().catch(() => {});
    return closing;
  };

  return { server, close, verify, connectionSummary: summary };
}

export async function runCloudAlmServer({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    stdout.write([
      'Usage: sap-ai-cloud-alm',
      '',
      'Starts a stdio MCP server for SAP Cloud ALM operations: landscape objects and tiers, health,',
      'exception and alert hotspots, Integration & Exception Monitoring records, monitoring events,',
      'incident triage with CPI message log and SLG1 handoffs, analytics queries, feature and',
      'transport status. Closing an event situation requires an exact confirmation string.',
      '',
      'Credentials come from a service key of a "SAP Cloud ALM API" instance (plan standard) in the',
      'MCP host environment, or from the user-only store filled by sap-ai-dev --setup-cloud-alm:',
      '  CLOUD_ALM_SERVICE_KEY                     service key JSON (endpoints.Api and uaa client secret)',
      '  CLOUD_ALM_URL                             API base URL including /api; takes precedence over the key',
      '  CLOUD_ALM_TOKEN_URL                       XSUAA URL or token URL (uaa.url)',
      '  CLOUD_ALM_CLIENT_ID                       OAuth client id (all four variables required together)',
      '  CLOUD_ALM_CLIENT_SECRET                   OAuth client secret',
      `  ${cloudAlmCredentialsPath(env)}`,
      '                                            service key stored by sap-ai-dev --setup-cloud-alm (never mcp.json)',
      '',
      'HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored.',
      '',
      '  --check   verify Landscape and Analytics API access; exit 1 when a check fails',
      ''
    ].join('\n'));
    return;
  }
  let runtime;
  try {
    runtime = createCloudAlmServer({ env });
  } catch (error) {
    stderr.write(`[sap-ai-cloud-alm] ${error.message}\n`);
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
  transport.onerror = () => stderr.write('[sap-ai-cloud-alm] MCP stdio transport failed.\n');

  try {
    await runtime.server.connect(transport);
  } catch {
    stderr.write('[sap-ai-cloud-alm] MCP server startup failed.\n');
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCloudAlmServer();
}
