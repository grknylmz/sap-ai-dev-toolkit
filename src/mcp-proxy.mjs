import { spawn as nodeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { sanitizeChildEnv, slugifyDestination } from './bas-discovery.mjs';
import { ABAP_LINT_TOOL, runABAPLint } from './abaplint.mjs';
import { createEngineeringTools } from './engineering-tools.mjs';
import { brandedEnvValue } from './branding.mjs';
import { createBasDestinationRelay } from './bas-destination-relay.mjs';

const JSONRPC = '2.0';
const FORWARDED_METHODS = new Set(['ping', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'completion/complete', 'logging/setLevel']);
const APPLICATION_LOG_PARAMETERS = [
  'program',
  'user',
  'object',
  'subobject',
  'from',
  'to',
  'max_results',
  'messages'
];
const APPLICATION_LOG_SCHEMA = {
  type: 'object',
  properties: {
    program: { type: 'string', description: 'ABAP program recorded in the log.' },
    user: { type: 'string', description: 'SAP user recorded in the log.' },
    object: { type: 'string', description: 'SLG1 application-log object.' },
    subobject: { type: 'string', description: 'SLG1 application-log subobject.' },
    from: { type: 'string', description: 'Inclusive lower date/time: YYYY-MM-DD, YYYYMMDD, or timestamp.' },
    to: { type: 'string', description: 'Inclusive upper date/time; a date-only value includes the full day.' },
    max_results: { type: 'number', description: 'Maximum log entries to return; defaults to 100.' },
    messages: { type: 'boolean', description: 'Include BALDAT message details and T100 texts instead of headers only.' }
  },
  required: []
};
const APPLICATION_LOG_DESCRIPTION = 'Read SAP application log (SLG1) entries. Results are newest first and limited to 100 by default; set messages=true to include log message details.';

// Keep the default public VSP surface small enough for developer-lifecycle use.
// Hidden upstream tools can still be used by local workflow tools when needed.
export const PUBLIC_VSP_TOOLS = new Set([
  'Activate',
  'ActivateMultiple',
  'CompareSource',
  'CreateTransport',
  'DebuggerAttach',
  'DebuggerDetach',
  'DebuggerGetStack',
  'DebuggerGetVariables',
  'DebuggerStep',
  'EditSource',
  'FindDefinition',
  'FindReferences',
  'GetAPIReleaseState',
  'GetBreakpoints',
  'GetCDSDependencies',
  'GetCDSElementInfo',
  'GetCDSImpactAnalysis',
  'GetClass',
  'GetClassComponents',
  'GetClassInclude',
  'GetClassInfo',
  'GetConnectionInfo',
  'GetContext',
  'GetFeatures',
  'GetFunction',
  'GetFunctionGroup',
  'GetInactiveObjects',
  'GetInclude',
  'GetInstalledComponents',
  'GetInterface',
  'GetPackage',
  'GetProgram',
  'GetSource',
  'GetSystemInfo',
  'GetTable',
  'GetTableContents',
  'GetTransport',
  'GetTransportInfo',
  'GetUserTransports',
  'GrepObjects',
  'GrepPackages',
  'ListDependencies',
  'ListTransports',
  'PrettyPrint',
  'RunATCCheck',
  'RunQuery',
  'RunUnitTests',
  'SearchObject',
  'SetBreakpoint',
  'SyntaxCheck',
  'WriteSource'
]);

function exposeVspTool(tool) {
  return PUBLIC_VSP_TOOLS.has(tool?.name);
}

function applicationLogArguments(arguments_ = {}) {
  const filters = arguments_ && typeof arguments_ === 'object' && !Array.isArray(arguments_) ? arguments_ : {};
  const params = { type: 'application_log' };
  for (const key of APPLICATION_LOG_PARAMETERS) {
    if (Object.hasOwn(filters, key)) params[key] = filters[key];
  }
  return { action: 'analyze', params };
}

function rpcResult(id, result) { return { jsonrpc: JSONRPC, id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: JSONRPC, id, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function redactText(text) { return String(text).replace(/(authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'); }
function diagnosticText(text) { return redactText(text || 'unknown error').replace(/\s+/g, ' ').slice(0, 500); }

const closedRoutes = new WeakMap();

function closeDestinationRoute(destination) {
  if (!destination || typeof destination.close !== 'function') return Promise.resolve();
  if (!closedRoutes.has(destination)) {
    const closing = Promise.resolve().then(() => destination.close()).catch(() => {});
    closedRoutes.set(destination, closing);
  }
  return closedRoutes.get(destination);
}

function useBasDestinationRelay(destination, env = process.env) {
  if (String(brandedEnvValue(env, 'DISABLE_BAS_RELAY') || '').toLowerCase() === 'true') return false;
  if (destination.source === 'cloud-foundry') return false;
  if (!destination.authentication) return false;
  return Boolean(destination.url && String(destination.url).includes('.dest'));
}

function childEnvironment(destination, env) {
  const childEnv = { ...sanitizeChildEnv(env), ...(destination.childEnv || {}) };
  // The VSP child must reach the local BAS relay directly, never through the
  // BAS .dest proxy. Without a loopback exception every child request would
  // be double-proxied and the relay's session pairing could never apply.
  if (destination.relay) {
    const loopback = '127.0.0.1,localhost';
    for (const key of ['NO_PROXY', 'no_proxy']) {
      const entries = String(childEnv[key] || '').split(',').map(value => value.trim()).filter(Boolean);
      for (const host of loopback.split(',')) if (!entries.some(entry => entry.toLowerCase() === host)) entries.push(host);
      childEnv[key] = entries.join(',');
    }
  }
  return childEnv;
}


export function childArguments(destination, env = process.env) {
  // The proxy allowlist keeps transport mutations to CreateTransport.
  // Transportable source edits are controlled by SAP_ALLOW_TRANSPORTABLE_EDITS.
  const mode = brandedEnvValue(env, 'MODE') || 'expert';
  const args = ['--url', destination.url, '--client', destination.client || '001', '--mode', mode];
  if (destination.source !== 'cloud-foundry' || destination.authentication === 'PrincipalPropagation') args.push('--proxy-auth');
  args.push('--enable-transports');
  return args;
}

class Child {
  constructor(binary, destination, options) {
    this.destination = destination;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.exited = false;
    this.closing = false;
    this.process = (options.spawn || nodeSpawn)(binary, options.args || childArguments(destination, options.env), {
      env: childEnvironment(destination, options.env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.onData(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', chunk => {
      if (options.log) options.log(`[${destination.name}] ${redactText(chunk).trimEnd()}`);
    });
    this.process.on('error', error => {
      if (!this.closing && !this.pending.size && this.options.log) this.options.log(`[${destination.name}] VSP child process error: ${diagnosticText(error.message)}`);
      this.fail(error);
      // Relay routes survive child crashes so self-healing restarts can reuse
      // them; they are closed by the proxy shutdown path instead.
      if (!destination.relay) void closeDestinationRoute(destination);
    });
    this.process.on('exit', (code, signal) => {
      if (!this.closing && !this.pending.size && this.options.log) this.options.log(`[${destination.name}] VSP child exited (${code ?? signal})`);
      this.fail(new Error(`child exited (${code ?? signal})`));
      if (!destination.relay) void closeDestinationRoute(destination);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.onMessage(JSON.parse(line)); } catch (error) { this.fail(new Error(`invalid child JSON-RPC response: ${error.message}`)); }
    }
  }

  onMessage(message) {
    if (message.id === undefined || message.id === null) {
      if (message.method?.startsWith('notifications/')) {
        try { this.options.onNotification?.(message); }
        catch (error) { this.options.log?.(`[${this.destination.name}] child notification forwarding failed: ${diagnosticText(error.message)}`); }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'child JSON-RPC error'), { rpcError: message.error }));
    else pending.resolve(message);
  }

  fail(error) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params) {
    if (this.exited || !this.process.stdin.writable) return Promise.reject(new Error(`destination ${this.destination.name} child is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.process.stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC, id, method, ...(params === undefined ? {} : { params })})}\n`); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) {
    if (this.exited || !this.process.stdin.writable) return;
    try { this.process.stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC, method, ...(params === undefined ? {} : { params })})}\n`); } catch {}
  }

  async initialize(params) {
    const response = await this.request('initialize', params);
    this.notify('notifications/initialized');
    return response.result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const response = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(response.result?.tools || []));
      cursor = response.result?.nextCursor;
    } while (cursor);
    return tools;
  }

  async close() {
    if (this.exited) return;
    this.closing = true;
    this.notify('notifications/cancelled', { reason: 'proxy shutdown' });
    this.process.kill('SIGTERM');
    let timeout;
    try {
      await Promise.race([
        once(this.process, 'exit').catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, 1000); })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!this.exited) this.process.kill('SIGKILL');
  }
}

export class MCPProxy {
  constructor({ binary, destinations, env = process.env, spawn = nodeSpawn, childArgs, log = message => console.error(message), output = line => process.stdout.write(`${line}\n`) }) {
    this.binary = binary;
    this.destinations = destinations;
    this.env = env;
    this.spawn = spawn;
    this.childArgs = childArgs;
    this.log = log;
    this.output = output;
    this.children = [];
    this.started = false;
    this.namespace = new Map();
    this.initialized = false;
    this.clientInitialized = false;
    this.pendingNotifications = [];
    this.shuttingDown = false;
    this.usedSlugs = new Map();
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.starting = (async () => {
      for (const originalDestination of this.destinations) {
        let destination = originalDestination;
        try {
          if (useBasDestinationRelay(originalDestination, this.env)) {
            const relay = createBasDestinationRelay(originalDestination, { env: this.env, log: this.log });
            const originalClose = originalDestination.close;
            const relayUrl = await relay.ready;
            destination = {
              ...originalDestination,
              url: relayUrl,
              relay: true,
              async close() {
                await originalClose?.();
                await relay.close();
              }
            };
            this.log(`[${originalDestination.name}] BAS destination relay enabled (${relayUrl})`);
          }
          this.log(`[${destination.name}] starting VSP child (client=${destination.client || '001'})`);
          this.children.push({
            destination,
            child: new Child(this.binary, destination, {
              env: this.env,
              spawn: this.spawn,
              args: this.childArgs?.(destination),
              log: this.log,
              onNotification: notification => {
                if (this.clientInitialized) this.output(JSON.stringify(notification));
                else this.pendingNotifications.push(notification);
              }
            })
          });
        } catch (error) {
          this.log(`[${destination.name}] failed to start child: ${diagnosticText(error.message)}`);
          void closeDestinationRoute(destination);
        }
      }
      if (!this.children.length) {
        this.started = false;
        for (const destination of this.destinations) void closeDestinationRoute(destination);
        throw new Error('No destination child could be started');
      }
      return this;
    })();
    // Mark the startup promise as handled here; initializeChildren re-awaits
    // it so startup failures still surface as MCP initialization errors
    // without triggering an unhandled rejection in between.
    this.starting.catch(() => {});
    return this;
  }

  // Self-healing mode 3: transparently restart a crashed VSP child so an
  // MCP tools/call does not permanently fail after a single crash. The
  // restarted child re-initializes and re-registers tools before the call
  // is retried once.
  async restartChild(entry) {
    if (this.shuttingDown) throw new Error('MCP proxy is shutting down');
    const name = entry.destination.name;
    this.log(`[${name}] VSP child crashed; self-healing restart in progress`);
    await entry.child.close().catch(() => {});
    const child = new Child(this.binary, entry.destination, {
      env: this.env,
      spawn: this.spawn,
      args: this.childArgs?.(entry.destination),
      log: this.log,
      onNotification: notification => {
        if (this.clientInitialized) this.output(JSON.stringify(notification));
        else this.pendingNotifications.push(notification);
      }
    });
    entry.child = child;
    entry.server = await child.initialize(this.lastInitializeParams || {});
    await child.listTools().catch(() => {});
    this.log(`[${name}] VSP child self-healing restart complete`);
    return entry;
  }

  async initializeChildren(params) {
    await this.starting;
    this.lastInitializeParams = params;
    const healthy = [];
    for (const entry of this.children) {
      this.log(`[${entry.destination.name}] initializing VSP MCP session`);
      try {
        entry.server = await entry.child.initialize(params);
        this.log(`[${entry.destination.name}] VSP MCP session initialized`);
        healthy.push(entry);
      } catch (error) {
        this.log(`[${entry.destination.name}] initialization failed: ${diagnosticText(error.message)}`);
        await entry.child.close();
        await closeDestinationRoute(entry.destination);
      }
    }
    this.children = healthy;
    if (!healthy.length) throw new Error('No destination child initialized successfully');
    this.initialized = true;
    return healthy;
  }

  async mergedTools() {
    this.namespace.clear();
    this.usedSlugs.clear();
    const merged = [];
    for (const entry of this.children) {
      const slug = slugifyDestination(entry.destination.name, this.usedSlugs);
      const lintName = `${slug}__${ABAP_LINT_TOOL.name}`;
      this.namespace.set(lintName, { handler: runABAPLint });
      merged.push({ ...ABAP_LINT_TOOL, name: lintName });
      try {
        const upstreamTools = await entry.child.listTools();
        for (const tool of upstreamTools) {
          if (tool.name === 'SAP') {
            const applicationLogName = `${slug}__GetApplicationLog`;
            this.namespace.set(applicationLogName, {
              entry,
              upstream: 'SAP',
              publicName: 'GetApplicationLog',
              transformArguments: applicationLogArguments
            });
            merged.push({
              name: applicationLogName,
              description: `${APPLICATION_LOG_DESCRIPTION} [destination: ${entry.destination.name}]`,
              inputSchema: APPLICATION_LOG_SCHEMA
            });
          }

          if (!exposeVspTool(tool)) continue;
          const name = `${slug}__${tool.name}`;
          this.namespace.set(name, { entry, upstream: tool.name });
          merged.push({ ...tool, name, description: `${tool.description || tool.name} [destination: ${entry.destination.name}]` });
        }
        for (const localTool of createEngineeringTools(entry, upstreamTools, { env: this.env, log: this.log })) {
          const name = `${slug}__${localTool.definition.name}`;
          this.namespace.set(name, { handler: localTool.handler });
          merged.push({
            ...localTool.definition,
            name,
            description: `${localTool.definition.description} [destination: ${entry.destination.name}]`
          });
        }
      } catch (error) {
        this.log(`[${entry.destination.name}] tools/list failed: ${redactText(error.message)}`);
      }
    }
    if (!merged.length && this.children.length) throw new Error('No destination child provided tools');
    return merged;
  }

  async handle(message) {
    if (message.method?.startsWith('notifications/')) {
      for (const entry of this.children) entry.child.notify(message.method, message.params);
      return null;
    }
    if (message.id === undefined) return null;
    try {
      if (message.method === 'initialize') {
        await this.initializeChildren(message.params || {});
        return rpcResult(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: brandedEnvValue(this.env, 'DESTINATION') || this.children[0].destination.name, version: '0.1.0' } });
      }
      if (!this.initialized) return rpcError(message.id, -32002, 'MCP proxy is not initialized');
      if (message.method === 'tools/list') return rpcResult(message.id, { tools: await this.mergedTools() });
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        const mapped = this.namespace.get(name);
        if (!mapped) return rpcError(message.id, -32602, `Unknown namespaced tool: ${name}`);
        if (mapped.handler) return rpcResult(message.id, await mapped.handler(message.params?.arguments));
        const toolName = mapped.publicName || mapped.upstream;
        const upstreamParams = { ...message.params, name: mapped.upstream };
        if (mapped.transformArguments) upstreamParams.arguments = mapped.transformArguments(message.params?.arguments);
        const startedAt = Date.now();
        this.log(`[${mapped.entry.destination.name}] tools/call ${toolName} started`);
        try {
          const response = await mapped.entry.child.request('tools/call', upstreamParams);
          if (response.result?.isError) {
            const detail = Array.isArray(response.result.content)
              ? response.result.content.filter(item => item.type === 'text').map(item => item.text).join(' ')
              : '';
            this.log(`[${mapped.entry.destination.name}] tools/call ${toolName} returned an error in ${Date.now() - startedAt}ms${detail ? `: ${diagnosticText(detail)}` : ''}`);
          } else {
            this.log(`[${mapped.entry.destination.name}] tools/call ${toolName} completed in ${Date.now() - startedAt}ms`);
          }
          return response.error ? { ...response, id: message.id } : rpcResult(message.id, response.result);
        } catch (error) {
          this.log(`[${mapped.entry.destination.name}] tools/call ${toolName} failed after ${Date.now() - startedAt}ms: ${diagnosticText(error.rpcError?.message || error.message)}`);
          // Self-healing: a dead child (crash, OOM, transient pipe break) is
          // restarted and the call retried once before surfacing the error.
          const childBroken = mapped.entry.child.exited || !mapped.entry.child.process.stdin.writable;
          if (childBroken && !this.shuttingDown) {
            try {
              await this.restartChild(mapped.entry);
              this.log(`[${mapped.entry.destination.name}] tools/call ${toolName} retried after self-healing restart`);
              const retried = await mapped.entry.child.request('tools/call', upstreamParams);
              return retried.error ? { ...retried, id: message.id } : rpcResult(message.id, retried.result);
            } catch (restartError) {
              this.log(`[${mapped.entry.destination.name}] tools/call ${toolName} self-healing restart failed: ${diagnosticText(restartError.message)}`);
            }
          }
          return error.rpcError ? rpcError(message.id, error.rpcError.code || -32001, error.rpcError.message || error.message, error.rpcError.data) : rpcError(message.id, -32001, `Destination ${mapped.entry.destination.name} failed: ${error.message}`);
        }
      }
      if (!FORWARDED_METHODS.has(message.method)) return rpcError(message.id, -32601, `Method not found: ${message.method}`);
      const responses = [];
      for (const entry of this.children) {
        try { responses.push((await entry.child.request(message.method, message.params)).result); } catch (error) { this.log(`[${entry.destination.name}] ${message.method} failed: ${redactText(error.message)}`); }
      }
      return rpcResult(message.id, responses.length === 1 ? responses[0] : responses);
    } catch (error) {
      this.log(`[MCP] ${message.method || 'request'} failed: ${diagnosticText(error.message)}`);
      return rpcError(message.id, -32000, redactText(error.message));
    }
  }

  async serve(input = process.stdin, output = this.output) {
    this.output = output;
    this.start();
    let buffer = '';
    const onData = async chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const response = await this.handle(message);
          if (response) {
            output(JSON.stringify(response));
            if (message.method === 'initialize') {
              this.clientInitialized = true;
              for (const notification of this.pendingNotifications) output(JSON.stringify(notification));
              this.pendingNotifications.length = 0;
            }
          }
        } catch (error) { this.log(redactText(error.message)); }
      }
    };
    input.setEncoding('utf8');
    let queue = Promise.resolve();
    input.on('data', chunk => { queue = queue.then(() => onData(chunk)); });
    await once(input, 'end');
    await queue;
    await this.close();
  }

  async close() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const closed = new Set();
    await Promise.all(this.children.map(async entry => {
      await entry.child.close();
      await closeDestinationRoute(entry.destination);
      closed.add(entry.destination);
    }));
    await Promise.all(this.destinations.filter(destination => !closed.has(destination)).map(destination => closeDestinationRoute(destination)));
  }
}
