#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveIntegrationConfig } from './integration-config.mjs';
import { integrationCredentialsPath, readStoredIntegrationKeys } from './integration-credentials.mjs';
import { registerIntegrationTools } from './integration-tools.mjs';
import { createIntegrationClients, verificationLines, verifyIntegrationClients } from './integration-verify.mjs';
import { OPTIONAL_COMPONENT_KEYS, OPTIONAL_INPUTS } from './integration-optional-config.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function sideSummary(config, client) {
  if (!config) return Object.freeze({ configured: false });
  const url = config.url ?? client?.origin;
  return Object.freeze({
    configured: true,
    source: config.source,
    binding: config.bindingName ?? null,
    host: url ? new URL(url).host : null,
    token_host: config.tokenUrl ? new URL(config.tokenUrl).host : null
  });
}

/** Create an injectable server runtime for tests and the stdio executable. */
export function createIntegrationServer({ env = process.env, fetchImpl, execFileImpl, pollIntervalMs, readBackDelayMs } = {}) {
  const config = resolveIntegrationConfig(env, { stored: readStoredIntegrationKeys(env) });
  const clients = createIntegrationClients(config, { env, fetchImpl });
  const summary = Object.freeze({
    environment: config.environment ?? 'default',
    ...Object.fromEntries(['cpi', 'apim', 'devhub', ...OPTIONAL_COMPONENT_KEYS].map(side => [side, sideSummary(config[side], clients[side])])),
    optional_config_errors: config.optional_config_errors ?? [],
    common_subaccount: 'unverified'
  });
  const verify = () => verifyIntegrationClients(clients);

  const server = new McpServer({
    name: 'sap-ai-integration-suite',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerIntegrationTools(server, {
    ...clients,
    summary,
    env,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(execFileImpl ? { execFileImpl } : {}),
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
      'proxies, policies, products and key value maps; optional Developer Hub onboarding and consumer applications.',
      'Writes require exact confirmation strings. Secrets are write-only and never returned.',
      '',
      'Credentials are read from the MCP host environment (never from mcp.json). Per side, first match wins:',
      '  CPI_URL, CPI_TOKEN_URL, CPI_CLIENT_ID, CPI_CLIENT_SECRET      explicit CPI OAuth client (all four)',
      '  CPI_SERVICE_KEY                                              CPI "api" plan service key JSON',
      '  VCAP_SERVICES + CPI_VCAP_SERVICE (default it-rt), CPI_BINDING',
      '  APIM_URL, APIM_TOKEN_URL, APIM_CLIENT_ID, APIM_CLIENT_SECRET  explicit APIM OAuth client (all four)',
      '  APIM_SERVICE_KEY                                             APIM "apiportal-apiaccess" service key JSON',
      '  VCAP_SERVICES + APIM_VCAP_SERVICE (default apimanagement-apiportal), APIM_BINDING',
      '  DEVHUB_URL, DEVHUB_TOKEN_URL, DEVHUB_CLIENT_ID, DEVHUB_CLIENT_SECRET  explicit Developer Hub OAuth client (all four)',
      '  DEVHUB_SERVICE_KEY                                           Developer Hub "devportal-apiaccess" service key JSON',
      '  VCAP_SERVICES + DEVHUB_VCAP_SERVICE (default apimanagement-devportal), DEVHUB_BINDING',
      ...Object.values(OPTIONAL_INPUTS).map(input => `  ${input.variable.padEnd(58)} existing ${input.label} credential JSON (no provisioning)`),
      '  INTEGRATION_ENVIRONMENT                                    non-secret report label; default default, never tenant authority',
      `  ${integrationCredentialsPath(env)}`,
      '                                                               keys pasted and verified by sap-ai-dev --setup-integration',
      'HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored. Configure core and/or separately credentialed optional components.',
      '',
      '  --check   report configured core access separately from optional capability completeness; no tenant writes',
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
      ...['cpi', 'apim', 'devhub'].flatMap(side => verificationLines(side.toUpperCase(), runtime.connectionSummary[side].host, report[side])),
      ...OPTIONAL_COMPONENT_KEYS.filter(side => report[side]?.configured).map(side =>
        `${side.toUpperCase()} ${runtime.connectionSummary[side].host ?? ''}: ${report[side].result ?? 'untested'} (optional access; activation/entitlement unknown)`),
      `Configured core access: ${report.ok ? 'verified' : 'not verified'}; optional capability completeness: ${report.optional_completeness?.complete === true ? 'complete' : 'unverified/partial'}`,
      ...runtime.connectionSummary.optional_config_errors.map(error => `${error.component}: invalid optional configuration (${error.source}); adapter disabled`)
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runIntegrationServer();
}
