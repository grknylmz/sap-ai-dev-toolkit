import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../src/launcher.mjs', import.meta.url));
const LIVE = /^(1|true|yes)$/iu.test(process.env.SAP_AI_DEV_LIVE_S4H || '');
const DESTINATION = process.env.SAP_AI_DEV_LIVE_DESTINATION || 'S4H';
const SLUG = process.env.SAP_AI_DEV_LIVE_DESTINATION_SLUG || DESTINATION.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-');
const REQUEST_TIMEOUT_MS = Number(process.env.SAP_AI_DEV_LIVE_TIMEOUT_MS || 45_000);

async function readConfiguredServer() {
  if (/^(0|false|no)$/iu.test(process.env.SAP_AI_DEV_LIVE_USE_MCP_CONFIG || '')) return null;
  const candidates = [
    process.env.SAP_AI_DEV_MCP_CONFIG,
    process.env.BAS_VSP_MCP_CONFIG,
    join(homedir(), '.vscode', 'data', 'User', 'mcp.json'),
    join(homedir(), '.vscode-server', 'data', 'User', 'mcp.json'),
    join(homedir(), '.code-server', 'data', 'User', 'mcp.json')
  ].filter(Boolean);
  for (const path of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    const server = parsed?.servers?.[DESTINATION];
    if (server?.command) return { path, server };
  }
  return null;
}

class StdioMcpClient {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.stdout = '';
    this.stderr = '';
    this.notifications = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onStdout(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.child.on('exit', (code, signal) => {
      const error = new Error(`MCP process exited (${code ?? signal})\n${this.stderr.slice(-4000)}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  #onStdout(chunk) {
    this.stdout += chunk;
    let newline;
    while ((newline = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const pending of this.pending.values()) pending.reject(new Error(`Invalid JSON-RPC line: ${line}`));
        this.pending.clear();
        return;
      }
      if (message.id === undefined || message.id === null) {
        this.notifications.push(message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { response: message }));
      else pending.resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}\n${this.stderr.slice(-4000)}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async close() {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await Promise.race([
      once(this.child, 'exit').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    if (!this.child.killed) this.child.kill('SIGKILL');
  }
}

function textPayload(result) {
  return (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function withLiveClient(t) {
  const configured = await readConfiguredServer();
  const server = configured?.server;
  const command = process.env.SAP_AI_DEV_LIVE_COMMAND || server?.command || process.execPath;
  const args = process.env.SAP_AI_DEV_LIVE_COMMAND
    ? (process.env.SAP_AI_DEV_LIVE_ARGS ? JSON.parse(process.env.SAP_AI_DEV_LIVE_ARGS) : [])
    : (server?.command ? (server.args || []) : [launcher]);
  const client = new StdioMcpClient(command, args, {
    ...process.env,
    ...(server?.env || {}),
    SAP_AI_DEV_TOOLKIT_DESTINATION: server?.env?.SAP_AI_DEV_TOOLKIT_DESTINATION || DESTINATION,
    SAP_AI_DEV_TOOLKIT_MODE: process.env.SAP_AI_DEV_TOOLKIT_MODE || server?.env?.SAP_AI_DEV_TOOLKIT_MODE || 'expert',
    SAP_ALLOW_TRANSPORTABLE_EDITS: process.env.SAP_ALLOW_TRANSPORTABLE_EDITS || server?.env?.SAP_ALLOW_TRANSPORTABLE_EDITS || 'true'
  });
  t.after(() => client.close());
  const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sap-ai-dev-live-test', version: '1.0.0' } });
  client.notify('notifications/initialized');
  assert.equal(initialized.serverInfo.name, DESTINATION);
  return client;
}

test('live S4H MCP exposes a curated ABAP lifecycle surface under 60 tools', { skip: LIVE ? false : 'set SAP_AI_DEV_LIVE_S4H=1 to run against a live BAS/S4H destination' }, async t => {
  const client = await withLiveClient(t);
  const listed = await client.request('tools/list', {});
  const tools = listed.tools || [];
  const names = new Set(tools.map(tool => tool.name));
  const prefix = `${SLUG}__`;

  assert.ok(tools.length > 25, `expected a useful ABAP lifecycle surface, got ${tools.length}`);
  assert.ok(tools.length < 60, `curated destination tool count must stay below 60, got ${tools.length}`);
  assert.ok(tools.every(tool => tool.name.startsWith(prefix)), 'every tool is destination-prefixed for the selected S4H server');

  for (const required of [
    'LintABAP', 'GetSystemInfo', 'GetConnectionInfo', 'GetFeatures',
    'SearchObject', 'GrepObjects', 'GrepPackages', 'GetSource', 'WriteSource', 'EditSource', 'CompareSource',
    'SyntaxCheck', 'PrettyPrint', 'Activate', 'RunUnitTests', 'RunATCCheck', 'GetInactiveObjects',
    'GetClass', 'GetProgram', 'GetPackage', 'GetTable', 'GetTableContents', 'RunQuery',
    'GetTransport', 'GetTransportInfo', 'ListTransports', 'CreateTransport',
    'GetApplicationLog', 'PrepareABAPChangeSet', 'ApplyABAPChangeSet', 'CheckTransportReadiness', 'PlanABAPCloudMigration'
  ]) {
    assert.ok(names.has(`${prefix}${required}`), `expected curated lifecycle tool ${required}`);
  }

  for (const hidden of [
    'SAP', 'ReleaseTransport', 'DeleteTransport', 'DeleteObject', 'ExecuteABAP', 'CallRFC',
    'ListSQLTraces', 'AnalyzeABAPCode', 'CreateObject', 'CreateClassWithTests', 'WriteClass', 'UpdateSource'
  ]) {
    assert.equal(names.has(`${prefix}${hidden}`), false, `broad/destructive tool ${hidden} must remain hidden`);
  }
});

test('live S4H MCP handles safe local and read-only SAP calls', { skip: LIVE ? false : 'set SAP_AI_DEV_LIVE_S4H=1 to run against a live BAS/S4H destination' }, async t => {
  const client = await withLiveClient(t);
  const prefix = `${SLUG}__`;
  await client.request('tools/list', {});

  const lint = await client.request('tools/call', {
    name: `${prefix}LintABAP`,
    arguments: { files: [{ filename: 'zlive_probe.prog.abap', source: "REPORT zlive_probe.\nWRITE / 'ok'.\n" }] }
  });
  const lintJson = JSON.parse(textPayload(lint));
  assert.equal(lintJson.filesChecked, 1);

  for (const [tool, args] of [
    ['GetSystemInfo', {}],
    ['GetConnectionInfo', {}],
    ['GetFeatures', {}],
    ['GetInstalledComponents', {}]
  ]) {
    const result = await client.request('tools/call', { name: `${prefix}${tool}`, arguments: args });
    assert.notEqual(result.isError, true, `${tool} returned an MCP tool error: ${textPayload(result)}`);
  }

  const query = await client.request('tools/call', {
    name: `${prefix}RunQuery`,
    arguments: { sql_query: 'SELECT * FROM T000', max_rows: 1 }
  });
  assert.notEqual(query.isError, true, `RunQuery returned an MCP tool error: ${textPayload(query)}`);
  assert.match(textPayload(query), /T000|MANDT|client|rows|\[/iu);

  const appLog = await client.request('tools/call', {
    name: `${prefix}GetApplicationLog`,
    arguments: { max_results: 1 }
  });
  assert.notEqual(appLog.isError, true, `GetApplicationLog returned an MCP tool error: ${textPayload(appLog)}`);
});
