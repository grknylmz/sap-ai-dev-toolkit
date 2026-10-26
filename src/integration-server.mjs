#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveIntegrationConfig } from './integration-config.mjs';
import { integrationCredentialsPath, readStoredIntegrationKeys } from './integration-credentials.mjs';
import { registerIntegrationTools } from './integration-tools.mjs';
import { createIntegrationClients, verificationLines, verifyIntegrationClients } from './integration-verify.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function sideSummary(config) {
  if (!config) return Object.freeze({ configured: false });
  return Object.freeze({
    configured: true,
    source: config.source,
    binding: config.bindingName,
    host: new URL(config.url).host,
    token_host: new URL(config.tokenUrl).host
  });
}

/** Create an injectable server runtime for tests and the stdio executable. */
export function createIntegrationServer({ env = process.env, fetchImpl, pollIntervalMs, readBackDelayMs } = {}) {
  const config = resolveIntegrationConfig(env, { stored: readStoredIntegrationKeys(env) });
  const summary = Object.freeze({ cpi: sideSummary(config.cpi), apim: sideSummary(config.apim) });
  const clients = createIntegrationClients(config, { env, fetchImpl });
  const verify = () => verifyIntegrationClients(clients);

  const server = new McpServer({
    name: 'sap-ai-integration-suite',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerIntegrationTools(server, {
    cpi: clients.cpi,
    apim: clients.apim,
    summary,
    verify,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(readBackDelayMs !== undefined ? { readBackDelayMs } : {})
  });

  let closing;
  const close = () => {
    if (!closing) closing = server.close().catch(() => {});
    return closing;
  };

  return { server, close, verify, connectionSummary: summary };
}

export async function runIntegrationServer({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    stdout.write([
      'Usage: sap-ai-integration',
      '',
      'Starts a stdio MCP server for SAP Integration Suite: Cloud Integration (CPI) packages, iFlows, value mappings,',
      'script collections, security material, Partner Directory and monitoring, and API Management (APIM) providers,',
      'proxies, policies, products and key value maps. Writes are create/update/deploy/undeploy only and need an',
      'exact confirmation string; there are no delete tools. Secrets are write-only and never returned.',
      '',
      'Credentials are read from the MCP host environment (never from mcp.json). Per side, first match wins:',
      '  CPI_URL, CPI_TOKEN_URL, CPI_CLIENT_ID, CPI_CLIENT_SECRET      explicit CPI OAuth client (all four)',
      '  CPI_SERVICE_KEY                                              CPI "api" plan service key JSON',
      '  VCAP_SERVICES + CPI_VCAP_SERVICE (default it-rt), CPI_BINDING',
      '  APIM_URL, APIM_TOKEN_URL, APIM_CLIENT_ID, APIM_CLIENT_SECRET  explicit APIM OAuth client (all four)',
      '  APIM_SERVICE_KEY                                             APIM "apiportal-apiaccess" service key JSON',
      '  VCAP_SERVICES + APIM_VCAP_SERVICE (default apimanagement-apiportal), APIM_BINDING',
      `  ${integrationCredentialsPath(env)}`,
      '                                                               keys pasted and verified by sap-ai-dev --setup-integration',
      'HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored. At least one of CPI or APIM must be configured.',
      '',
      '  --check   sign in and run one read per tool area, report missing roles, and exit (1 on failure)',
      ''
    ].join('\n'));
    return;
  }
  let runtime;
  try {
    runtime = createIntegrationServer({ env });
  } catch (error) {
    stderr.write(`[sap-ai-integration] ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.slice(2).includes('--check')) {
    const report = await runtime.verify();
    const lines = [
      ...verificationLines('CPI', runtime.connectionSummary.cpi.host, report.cpi),
      ...verificationLines('APIM', runtime.connectionSummary.apim.host, report.apim)
    ];
    stdout.write(`${lines.join('\n')}\n`);
    await runtime.close();
    if (!report.ok) process.exitCode = 1;
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
  transport.onerror = () => stderr.write('[sap-ai-integration] MCP stdio transport failed.\n');

  try {
    await runtime.server.connect(transport);
  } catch {
    stderr.write('[sap-ai-integration] MCP server startup failed.\n');
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runIntegrationServer();
}
