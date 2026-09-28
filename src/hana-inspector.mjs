#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveHanaReadOnlyConfig } from './hana-config.mjs';
import { connectReadOnlyHana } from './hana-database.mjs';
import { registerHanaTools } from './hana-tools.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function publicConnectionSummary(config) {
  return Object.freeze({
    source: config.source,
    serviceName: config.serviceName,
    bindingName: config.bindingName,
    host: config.host,
    port: config.port,
    schema: config.schema
  });
}

/** Create an injectable server runtime for tests and the stdio executable. */
export function createHanaInspector({ env = process.env, driver, databaseFactory = connectReadOnlyHana } = {}) {
  const config = resolveHanaReadOnlyConfig(env);
  const summary = publicConnectionSummary(config);
  let databasePromise;
  let database;

  const getDatabase = async () => {
    if (!databasePromise) {
      databasePromise = databaseFactory(config, { driver })
        .then(connected => {
          database = connected;
          return connected;
        })
        .catch(error => {
          databasePromise = undefined;
          throw error;
        });
    }
    return databasePromise;
  };

  const server = new McpServer({
    name: 'sap-ai-hana-inspector',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerHanaTools(server, getDatabase, { connectionSummary: summary });

  let closing;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        await server.close().catch(() => {});
        if (!database && databasePromise) database = await databasePromise.catch(() => undefined);
        if (database) await database.close().catch(() => {});
      })();
    }
    return closing;
  };

  return { server, close, connectionSummary: summary };
}

export async function runHanaInspector({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, driver } = {}) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    stdout.write([
      'Usage: sap-ai-hana',
      '',
      'Starts a read-only stdio MCP server for the HANA service selected by HANA_RO_* or VCAP_SERVICES.',
      'Required explicit variables: HANA_RO_HOST, HANA_RO_PORT, HANA_RO_USER, HANA_RO_PASSWORD, HANA_RO_SCHEMA.',
      'VCAP selection: HANA_RO_VCAP_SERVICE and HANA_RO_BINDING are optional when exactly one HANA binding exists.',
      'TLS certificate validation is always enabled. Deployment credentials are never used as a fallback.',
      ''
    ].join('\n'));
    return;
  }
  let runtime;
  try {
    runtime = createHanaInspector({ env, driver });
  } catch (error) {
    stderr.write(`[sap-ai-hana] ${error.message}\n`);
    process.exitCode = 1;
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
  transport.onerror = () => stderr.write('[sap-ai-hana] MCP stdio transport failed.\n');

  try {
    await runtime.server.connect(transport);
  } catch {
    stderr.write('[sap-ai-hana] MCP server startup failed.\n');
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runHanaInspector();
}