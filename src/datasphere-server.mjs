#!/usr/bin/env node
// sap-ai-datasphere: stdio MCP server for SAP Datasphere. Technical (client
// credentials) or interactive (authorization code + refresh token) OAuth client;
// REST consumption/tasks APIs, the datasphere CLI child runner, and optional
// Open SQL access through a Datasphere database user.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveDatasphereConfig } from './datasphere-config.mjs';
import { datasphereCredentialsPath, readStoredDatasphereCredentials, updateStoredRefreshToken } from './datasphere-credentials.mjs';
import { createDatasphereTokenProvider } from './datasphere-auth.mjs';
import { createDatasphereCli } from './datasphere-cli.mjs';
import { loadDatasphereCommands } from './datasphere-discovery.mjs';
import { DATASPHERE_TOOL_NAMES, registerDatasphereTools } from './datasphere-tools.mjs';
import { createStaticServiceClient, IntegrationError } from './integration-http.mjs';
import { connectHana } from './hana-database.mjs';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const CSRF_PATH = '/api/v1/datasphere/consumption/catalog/spaces';
const SQL_QUERY_TIMEOUT_MS = 300_000;

function unavailableCli(error) {
  const message = error?.message || 'Datasphere CLI runtime is unavailable';
  const reject = () => Promise.reject(new IntegrationError(message));
  return {
    packageVersion: null,
    init: reject,
    run: reject,
    version: reject,
    stateDir: () => null,
    close: async () => {}
  };
}

/** Create an injectable server runtime for tests and the stdio executable. */
export function createDatasphereServer({ env = process.env, fetchImpl, cliFactory = createDatasphereCli, sqlFactory = connectHana } = {}) {
  const config = resolveDatasphereConfig(env, { stored: readStoredDatasphereCredentials(env) });

  const provider = createDatasphereTokenProvider({
    config,
    env,
    persistRefreshToken: refreshToken => (config.source === 'stored-key' ? updateStoredRefreshToken(refreshToken, env) : undefined),
    ...(fetchImpl ? { fetchImpl } : {})
  });

  const secrets = async () => {
    if (config.auth === 'technical') {
      return {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        token_url: config.tokenUrl,
        authorization_flow: 'client_credentials',
        host: config.url,
        tenantUrl: config.url
      };
    }
    const token = await provider.token();
    return {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token_url: config.tokenUrl,
      authorization_url: config.authorizationUrl,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_after: Math.floor(token.expiresAt / 1000),
      authorization_flow: 'authorization_code',
      host: config.url,
      tenantUrl: config.url
    };
  };

  const rest = createStaticServiceClient({
    label: 'DATASPHERE',
    url: config.url,
    authorization: async () => `Bearer ${(await provider.token()).accessToken}`,
    csrfPath: CSRF_PATH,
    env,
    ...(fetchImpl ? { fetchImpl } : {})
  });

  let cli;
  try {
    cli = cliFactory({ config, secrets, env });
  } catch (error) {
    cli = unavailableCli(error);
  }

  let commandsPromise;
  const commands = () => {
    if (!commandsPromise) {
      commandsPromise = loadDatasphereCommands({ rest, cli }).catch(error => {
        commandsPromise = undefined;
        throw error;
      });
    }
    return commandsPromise;
  };

  let databasePromise = null;
  let sqlAccess = null;
  if (config.sql) {
    databasePromise = null;
    const getDatabase = () => {
      if (!databasePromise) {
        databasePromise = Promise.resolve(sqlFactory(config.sql, { queryTimeoutMs: SQL_QUERY_TIMEOUT_MS })).catch(error => {
          databasePromise = null;
          throw error;
        });
      }
      return databasePromise;
    };
    sqlAccess = { config: config.sql, connect: async () => getDatabase() };
  }

  const summary = Object.freeze({
    tenant_host: new URL(config.url).host,
    token_host: new URL(config.tokenUrl).host,
    auth: config.auth,
    source: config.source,
    cli_package_version: cli.packageVersion,
    sql: config.sql ? { host: config.sql.host, user: config.sql.user, schema: config.sql.schema } : null,
    admin_commands_available: config.auth === 'interactive'
  });

  const verify = async () => {
    const report = {};
    try {
      const payload = await rest.request('GET', '/api/v1/datasphere/consumption/catalog/spaces');
      report.catalog = `ok (${(payload?.value ?? []).length} spaces)`;
    } catch (error) {
      report.catalog = `failed: ${error?.message || 'catalog request failed'}`;
    }
    try {
      await cli.init();
      report.cli = `ok (datasphere ${await cli.version()})`;
    } catch (error) {
      report.cli = `failed: ${error?.message || 'CLI initialization failed'}`;
    }
    if (!config.sql) {
      report.sql = 'not configured';
    } else {
      try {
        const database = await sqlAccess.connect();
        const rows = await database.query('SELECT CURRENT_USER, CURRENT_SCHEMA FROM DUMMY');
        const row = Array.isArray(rows) ? rows[0] : {};
        report.sql = `ok (${row?.CURRENT_USER ?? config.sql.user}/${row?.CURRENT_SCHEMA ?? config.sql.schema})`;
      } catch (error) {
        report.sql = `failed: ${error?.message || 'SQL connection failed'}`;
      }
    }
    return report;
  };

  const server = new McpServer({
    name: 'sap-ai-datasphere',
    version: packageMetadata.version
  }, { capabilities: { tools: {} } });
  registerDatasphereTools(server, { rest, cli, sql: sqlAccess, summary, verify, commands });

  let closing;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        await cli.close?.().catch?.(() => {});
        await databasePromise?.then(database => database.close()).catch(() => {});
        await server.close().catch(() => {});
      })();
    }
    return closing;
  };

  return { server, close, verify, connectionSummary: summary };
}

export async function runDatasphereServer({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, cliFactory, sqlFactory } = {}) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    stdout.write([
      'Usage: sap-ai-datasphere',
      '',
      'Starts a stdio MCP server for SAP Datasphere: spaces, users, roles, database users, workload,',
      'connections, TLS certificates, modeling objects and packages, task chains, replication flows,',
      'Data Marketplace, consumption queries and Open SQL. Writes require exact confirmation strings.',
      '',
      'Credentials come from a Datasphere OAuth client (System > App Integration) in the MCP host',
      'environment, or from the user-only store filled by sap-ai-dev --setup-datasphere:',
      '  DATASPHERE_URL                     tenant URL, for example https://<tenant>.eu10.hcs.cloud.sap',
      '  DATASPHERE_TOKEN_URL               OAuth token URL of the tenant',
      '  DATASPHERE_CLIENT_ID               OAuth client id (all four variables required together)',
      '  DATASPHERE_CLIENT_SECRET           OAuth client secret',
      '  DATASPHERE_AUTH                    technical (default) | interactive',
      '  DATASPHERE_AUTHORIZATION_URL       OAuth authorization URL (required for interactive)',
      '  DATASPHERE_REFRESH_TOKEN           refresh token (required for interactive)',
      'Optional Open SQL access through a Datasphere database user:',
      '  DATASPHERE_SQL_HOST, DATASPHERE_SQL_USER, DATASPHERE_SQL_PASSWORD   required together',
      '  DATASPHERE_SQL_PORT                default 443',
      '  DATASPHERE_SQL_SCHEMA              default = database user name',
      `  ${datasphereCredentialsPath(env)}`,
      '                                     sign-in stored by sap-ai-dev --setup-datasphere (never mcp.json)',
      '',
      'HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored.',
      '',
      '  --check   verify catalog, CLI and SQL access; exit 1 when any check fails',
      ''
    ].join('\n'));
    return;
  }
  let runtime;
  try {
    runtime = createDatasphereServer({ env, ...(cliFactory ? { cliFactory } : {}), ...(sqlFactory ? { sqlFactory } : {}) });
  } catch (error) {
    stderr.write(`[sap-ai-datasphere] ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.slice(2).includes('--check')) {
    const report = await runtime.verify();
    const lines = Object.entries(report).map(([name, result]) => `${name}: ${result}`);
    stdout.write(`${lines.join('\n')}\n`);
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
  transport.onerror = () => stderr.write('[sap-ai-datasphere] MCP stdio transport failed.\n');

  try {
    await runtime.server.connect(transport);
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runDatasphereServer();
}
