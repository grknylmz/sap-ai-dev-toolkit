#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const args = process.argv.slice(2);
const mode = args[args.indexOf('--mode') + 1] || 'focused';
const url = args[args.indexOf('--url') + 1] || 'unknown';
const destination = url.replace(/^https?:\/\//, '').replace(/\.dest$/, '');
const logPath = process.env.FAKE_LOG;
function log(entry) { if (logPath) appendFileSync(logPath, `${JSON.stringify({ destination, ...entry })}\n`); }
function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function requestADTThroughProxy(targetUrl, proxyUrl, { method = 'GET', body = '', bypassProxyForLoopback = false } = {}) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  if (target.protocol !== 'http:') throw new Error('fixture ADT request supports HTTP only');
  const headers = { host: target.host, accept: 'application/xml,text/xml,*/*' };
  if (body) headers['content-type'] = 'application/xml';
  if (process.env.SAP_USER && process.env.SAP_PASSWORD) {
    headers.authorization = `Basic ${Buffer.from(`${process.env.SAP_USER}:${process.env.SAP_PASSWORD}`).toString('base64')}`;
  }
  const loopback = bypassProxyForLoopback && ['127.0.0.1', 'localhost'].includes(target.hostname);
  return new Promise((resolve, reject) => {
    const requestOptions = loopback ? {
      hostname: target.hostname,
      port: Number(target.port),
      method,
      path: `${target.pathname}${target.search}`,
      headers
    } : {
      hostname: proxy.hostname,
      port: Number(proxy.port),
      method,
      path: target.href,
      headers
    };
    const request = httpRequest(requestOptions, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.setTimeout(5_000, () => request.destroy(new Error('fixture ADT request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}
const toolNames = [
  'GetSource',
  'WriteSource',
  'EditSource',
  'SearchObject',
  'GrepObjects',
  'GrepPackages',
  'FindDefinition',
  'FindReferences',
  'GetContext',
  'SyntaxCheck',
  'Activate',
  'ActivatePackage',
  'CompareSource',
  'GetClassInfo',
  'CreatePackage',
  'CreateTable',
  'GetTable',
  'GetTableContents',
  'GetTransport',
  'ListTransports',
  'GetTransportInfo',
  'GetUserTransports',
  'RunQuery',
  'GetPackage',
  'GetFunctionGroup',
  'GetCDSDependencies',
  'GetCDSImpactAnalysis',
  'GetAPIReleaseState',
  'GetCDSElementInfo',
  'GetMessages',
  'GetFeatures',
  'PrettyPrint',
  'GetSystemInfo',
  'GetInstalledComponents',
  'RunUnitTests',
  'RunATCCheck',
  'GetInactiveObjects',
  'DeleteObject',
  'DebuggerAttach',
  'ListSQLTraces',
  'CreateTransport',
  'ReleaseTransport',
  'DeleteTransport',
  'AnalyzeABAPCode',
  'AnalyzeCallGraph',
  'CodeCompletion',
  'GetAbapHelp',
  'GetCallGraph',
  'GetCalleesOf',
  'GetCallersOf',
  'GetCodeCoverage',
  'GetConnectionInfo',
  'GetObjectStructure',
  'GetTypeHierarchy',
  'GetTypeInfo',
  'GrepObject',
  'GrepPackage',
  'CallRFC',
  'DebuggerDetach',
  'DebuggerGetStack',
  'DebuggerGetVariables',
  'DebuggerListen',
  'DebuggerStep',
  'DeleteBreakpoint',
  'GetBreakpoints',
  'GetDump',
  'GetSQLTraceState',
  'GetTrace',
  'ListDumps',
  'SetBreakpoint',
  'CloneObject',
  'CreateAndActivateProgram',
  'CreateClassWithTests',
  'CreateObject',
  'CreateTestInclude',
  'ExecuteABAP',
  'GetClass',
  'GetClassComponents',
  'GetClassInclude',
  'GetFunction',
  'GetInclude',
  'GetInterface',
  'GetProgram',
  'GetStructure',
  'GetTransaction',
  'LockObject',
  'MoveObject',
  'RecoverFailedCreate',
  'RenameObject',
  'SaveToFile',
  'UnlockObject',
  'UpdateClassInclude',
  'UpdateSource',
  'WriteClass',
  'WriteProgram',
  'ListDependencies',
  'PublishServiceBinding',
  'UnpublishServiceBinding'
];
if (mode === 'expert') toolNames.push('ActivateMultiple', 'SAP');

function toolDefinition(name) {
  const schemas = {
    RunQuery: {
      type: 'object',
      properties: {
        sql_query: { type: 'string' },
        max_rows: { type: 'number' },
        all_rows: { type: 'boolean' }
      },
      required: ['sql_query']
    },
    GetAPIReleaseState: { type: 'object', properties: { object_uri: { type: 'string' } }, required: ['object_uri'] },
    PrettyPrint: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    GetTransport: { type: 'object', properties: { transport: { type: 'string' } }, required: ['transport'] },
    GetTransportInfo: {
      type: 'object',
      properties: { object_url: { type: 'string' }, dev_class: { type: 'string' } },
      required: ['object_url', 'dev_class']
    },
    GetUserTransports: {
      type: 'object',
      properties: { user_name: { type: 'string' } },
      required: []
    },
    ActivateMultiple: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                properties: { url: { type: 'string' }, name: { type: 'string' } },
                required: ['url', 'name']
              },
              { type: 'string' }
            ]
          }
        }
      },
      required: ['objects']
    }
  };
  return { name, description: name, inputSchema: schemas[name] || { type: 'object', properties: {}, required: [] } };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      log({ event: 'initialize', argv: args, env: { guard: process.env.SAP_PROXY_CONTEXTID_GUARD, authorization: process.env.Authorization, cookie: process.env.Cookie, user: process.env.SAP_USER, password: process.env.SAP_PASSWORD, verbose: process.env.SAP_VERBOSE, httpProxy: process.env.HTTP_PROXY, httpsProxy: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY, allowTransportableEdits: process.env.SAP_ALLOW_TRANSPORTABLE_EDITS } });
      if (destination === 'broken') process.exit(2);
      reply(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: destination, version: 'fixture' } });
    } else if (message.method === 'tools/list') {
      reply(message.id, message.params?.cursor
        ? { tools: toolNames.slice(15).map(toolDefinition) }
        : { tools: toolNames.slice(0, 15).map(toolDefinition), nextCursor: 'page-2' });
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      log({ event: 'call', name, arguments: message.params?.arguments });
      if (message.params?.arguments?.emitNotification) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', logger: 'fake-vsp', data: 'fixture log notification' }
        })}\n`);
      }
      const transportTools = [
        'ListTransports', 'GetTransport', 'GetUserTransports', 'GetTransportInfo',
        'CreateTransport', 'ReleaseTransport', 'DeleteTransport'
      ];
      const disabledTransportOperation = transportTools.includes(name)
        && (!args.includes('--enable-transports')
          || (['CreateTransport', 'ReleaseTransport', 'DeleteTransport'].includes(name) && args.includes('--transport-read-only')));
      if (disabledTransportOperation) {
        reply(message.id, { content: [{ type: 'text', text: 'transport operation is not enabled' }], isError: true });
      } else if (message.params?.arguments?.object === 'RPC_ERROR') {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32042, message: 'backend connection refused; password=must-not-log' } })}\n`);
      } else if (message.params?.arguments?.object === 'TOOL_ERROR') {
        reply(message.id, { content: [{ type: 'text', text: 'backend timeout; token=must-not-log' }], isError: true });
      } else if (process.env.FAKE_CF_ADT_TEST === 'true' && name === 'GetSystemInfo') {
        try {
          const target = new URL('/sap/bc/adt/discovery', url);
          const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
          const adt = await requestADTThroughProxy(target.href, proxy);
          reply(message.id, { content: [{ type: 'text', text: adt.body }], isError: false });
        } catch {
          reply(message.id, { content: [{ type: 'text', text: 'fixture ADT request failed' }], isError: true });
        }
      } else if (process.env.FAKE_RELAY_CSRF_TEST === 'true' && name === 'GetSystemInfo') {
        try {
          const target = new URL('/sap/bc/adt/datapreview/freestyle', url);
          const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
          const adt = await requestADTThroughProxy(target.href, proxy, { method: 'POST', body: '<probe/>', bypassProxyForLoopback: true });
          reply(message.id, { content: [{ type: 'text', text: `fixture ADT HTTP ${adt.status}: ${adt.body}` }], isError: adt.status < 200 || adt.status >= 300 });
        } catch {
          reply(message.id, { content: [{ type: 'text', text: 'fixture ADT write failed' }], isError: true });
        }
      } else {
        reply(message.id, { content: [{ type: 'text', text: `${destination}:${name}` }], isError: false });
      }
    } else if (message.id !== undefined) reply(message.id, {});
  }
});
process.stdin.on('end', () => { log({ event: 'end' }); });
process.on('SIGTERM', () => { log({ event: 'term' }); process.exit(0); });
