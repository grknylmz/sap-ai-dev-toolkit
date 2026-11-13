#!/usr/bin/env node
// sap-ai-process-automation: stdio MCP server for SAP Build Process Automation.
// Technical (service-key client credentials) or interactive (authorization code +
// refresh token with the service-key client) OAuth; Workflow, decision runtime and
// business event APIs.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProcessAutomationRestClient } from './process-automation-client.mjs';
import { resolveProcessAutomationConfig } from './process-automation-config.mjs';
import {
  processAutomationCredentialsPath,
  readStoredProcessAutomationCredentials,
  updateStoredProcessAutomationRefreshToken
} from './process-automation-credentials.mjs';
import { registerProcessAutomationTools } from './process-automation-tools.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** Create an injectable server runtime for tests and the stdio executable. */
export function createProcessAutomationServer({ env = process.env, fetchImpl } = {}) {
  const config = resolveProcessAutomationConfig(env, { stored: readStoredProcessAutomationCredentials(env) });
  const rest = createProcessAutomationRestClient(config, {
    env,
    ...(fetchImpl ? { fetchImpl } : {}),
    persistRefreshToken: token => (config.source === 'stored-key' ? updateStoredProcessAutomationRefreshToken(token, env) : undefined)
  });

  const summary = Object.freeze({
    api_host: new URL(config.url).host,
    uaa_host: new URL(config.tokenUrl).host,
    auth: config.auth,
    source: config.source,
    task_attribution: config.auth === 'technical' ? 'technical client' : 'signed-in user',
    api_key_configured: Boolean(config.apiKey),
    environment_id: config.environmentId
  });

  const verify = async () => {
    try {
      const definitions = await rest.request('GET', '/public/workflow/rest/v1/workflow-definitions', { query: { $top: 1 } });
      return { workflow_api: `ok (${Array.isArray(definitions) ? definitions.length : 0} definitions on first page)` };
    } catch (error) {
      return { workflow_api: `failed: ${error?.message || 'Workflow API request failed'}` };
    }
  };

  const server = new McpServer({
    name: 'sap-ai-process-automation',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerProcessAutomationTools(server, { rest, summary, verify, access: { apiKey: config.apiKey, environmentId: config.environmentId } });

  let closing;
  const close = () => {
    if (!closing) closing = server.close().catch(() => {});
    return closing;
  };

  return { server, close, verify, connectionSummary: summary };
}

export async function runProcessAutomationServer({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    stdout.write([
      'Usage: sap-ai-process-automation',
      '',
      'Starts a stdio MCP server covering the SAP Build Process Automation APIs: Workflow (definitions,',
      'instances, contexts, logs, errors, user tasks, export, purge, jobs, messages), Inbox (TCM),',
      'Decisions, Unified API triggers, Automation Execution/Monitoring, Visibility Scenarios and',
      'Workspace, and business events. Writes require exact confirmation strings.',
      '',
      'Credentials come from a service key of a process-automation-service instance in the MCP host',
      'environment, or from the user-only store filled by sap-ai-dev --setup-process-automation:',
      '  PROCESS_AUTOMATION_SERVICE_KEY            service key JSON (endpoints.api and uaa client secret)',
      '  PROCESS_AUTOMATION_URL                    API URL (endpoints.api); takes precedence over the key',
      '  PROCESS_AUTOMATION_TOKEN_URL              XSUAA URL or token URL (uaa.url)',
      '  PROCESS_AUTOMATION_CLIENT_ID              OAuth client id (all four variables required together)',
      '  PROCESS_AUTOMATION_CLIENT_SECRET          OAuth client secret',
      '  PROCESS_AUTOMATION_AUTH                   technical (default) | interactive',
      '  PROCESS_AUTOMATION_REFRESH_TOKEN          refresh token (required for interactive)',
      '  PROCESS_AUTOMATION_API_KEY                environment API key (Control Tower > Environments > API Keys);',
      '                                            required for automation triggers/jobs/exports, optional elsewhere',
      '  PROCESS_AUTOMATION_ENVIRONMENT_ID         default environment id for API triggers and process starts',
      `  ${processAutomationCredentialsPath(env)}`,
      '                                            sign-in stored by sap-ai-dev --setup-process-automation (never mcp.json)',
      '',
      'HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored.',
      '',
      '  --check   verify Workflow API access; exit 1 when the check fails',
      ''
    ].join('\n'));
    return;
  }
  let runtime;
  try {
    runtime = createProcessAutomationServer({ env });
  } catch (error) {
    stderr.write(`[sap-ai-process-automation] ${error.message}\n`);
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
  transport.onerror = () => stderr.write('[sap-ai-process-automation] MCP stdio transport failed.\n');

  try {
    await runtime.server.connect(transport);
  } catch {
    stderr.write('[sap-ai-process-automation] MCP server startup failed.\n');
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProcessAutomationServer();
}
