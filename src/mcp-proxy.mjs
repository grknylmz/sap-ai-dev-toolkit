import { spawn as nodeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { sanitizeChildEnv, slugifyDestination } from './bas-discovery.mjs';
import { ABAP_LINT_TOOL, runABAPLint } from './abaplint.mjs';
import { createEngineeringTools } from './engineering-tools.mjs';
import { brandedEnvValue } from './branding.mjs';
import { diagnosticText, redactText } from './redact.mjs';

const JSONRPC = '2.0';
const FORWARDED_METHODS = new Set(['ping', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'completion/complete', 'logging/setLevel']);
// MCP log levels in spec order; a notification is emitted when its level is
// at or above the client's logging/setLevel choice (default info).
const MCP_LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
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


// Self-healing restarts retry the interrupted tools/call once. Retrying a
// state-changing tool after a crash can apply the same write twice (the child
// may have completed the side effect before dying), so these are never retried;
// the original error is surfaced instead.
const NON_RETRIABLE_VSP_TOOLS = new Set([
  'Activate',
  'ActivateMultiple',
  'CreateTransport',
  'EditSource',
  'LockObject',
  'UnlockObject',
  'WriteSource'
]);

const MAX_CHILD_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_NOTIFICATIONS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 5 * 60 * 1000;

function requestTimeoutMs(env) {
  const raw = brandedEnvValue(env, 'REQUEST_TIMEOUT_MS');
  if (raw === undefined || raw === '') return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  // 0 or a negative value disables the timeout; invalid values fall back.
  if (!Number.isFinite(parsed)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return parsed > 0 ? Math.floor(parsed) : 0;
}


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
  'LockObject',
  'PrettyPrint',
  'RunATCCheck',
  'RunQuery',
  'RunUnitTests',
  'SearchObject',
  'SetBreakpoint',
  'SyntaxCheck',
  'UnlockObject',
  'WriteSource'
]);


// Public tool names are lowercase snake_case. BAS/VS Code chat tool references
// are lowercase-only, so mixed-case names never bind in the tools picker even
// when the server itself starts and lists tools.
export function snakeCaseName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

// Every generated tool is prefixed with the destination it targets:
// <destination-slug>_<tool>, for example demo-abap_get_table_contents.
function publicToolSegment(name) {
  return snakeCaseName(name) || String(name).toLowerCase();
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

const closedRoutes = new WeakMap();

function closeDestinationRoute(destination) {
  if (!destination || typeof destination.close !== 'function') return Promise.resolve();
  if (!closedRoutes.has(destination)) {
    const closing = Promise.resolve().then(() => destination.close()).catch(() => {});
    closedRoutes.set(destination, closing);
  }
  return closedRoutes.get(destination);
}


function useProxyAuthentication(destination) {
  if (destination.source === 'sap-gui-local') return false;
  return destination.source !== 'cloud-foundry' || destination.authentication === 'PrincipalPropagation';
}

function childEnvironment(destination, env) {
  const childEnv = { ...sanitizeChildEnv(env), ...(destination.childEnv || {}) };
  if (useProxyAuthentication(destination)) {
    // VSP loads SAP_* values from local .env files. Set every supported local
    // auth variable explicitly empty so dotenv cannot supply a fallback
    // identity or session instead of the selected BAS destination identity.
    for (const key of [
      'SAP_USER', 'SAP_USERNAME', 'SAP_PASSWORD', 'SAP_PASS',
      'SAP_COOKIE_FILE', 'SAP_COOKIE_STRING', 'SAP_BROWSER_AUTH', 'SAP_SSO',
      'SAP_SAML_AUTH', 'SAP_SAML_USER', 'SAP_SAML_PASSWORD', 'SAP_CREDENTIAL_CMD'
    ]) childEnv[key] = '';
  }
  return childEnv;
}


export function childArguments(destination, env = process.env) {
  // The proxy allowlist controls transport operations; source edits are
  // controlled by SAP_ALLOW_TRANSPORTABLE_EDITS and SAP authorizations.
  const mode = brandedEnvValue(env, 'MODE') || 'expert';
  const args = ['--url', destination.url, '--client', destination.client || '001', '--mode', mode];
  if (useProxyAuthentication(destination)) args.push('--proxy-auth');
  args.push('--enable-transports');
  return args;
}

// Windows cannot exec a .js/.mjs file directly (no shebang support), so test
// fixtures written in JavaScript are launched through the current Node binary.
// The production VSP binary is a native executable and is unaffected; a
// Windows .cmd/.bat override needs cmd /c because Node refuses to spawn
// batch files directly (EINVAL since the CVE-2024-27980 hardening).
function spawnCommand(binary) {
  if (/\.(?:mjs|cjs|js)$/i.test(binary)) return [process.execPath, binary];
  if (/\.(?:cmd|bat)$/i.test(binary) && process.platform === 'win32') return ['cmd', '/c', binary];
  return [binary];
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
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    const [command, ...commandPrefixArgs] = spawnCommand(binary);
    this.process = (options.spawn || nodeSpawn)(command, [...commandPrefixArgs, ...(options.args || childArguments(destination, options.env))], {
      env: childEnvironment(destination, options.env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.onData(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', chunk => {
      if (options.log) options.log(`[${destination.name}] ${redactText(chunk).trimEnd()}`);
    });
    // A write racing child death surfaces as an EPIPE 'error' event on stdin.
    // Without a listener that is an uncaught exception that kills the whole
    // MCP server — exactly the crash window self-healing is meant to cover.
    this.process.stdin.on('error', error => {
      if (!this.closing && this.options.log) this.options.log(`[${destination.name}] VSP child stdin error: ${diagnosticText(error.message)}`);
      this.fail(new Error(`child stdin failed: ${error.message}`));
    });
    this.process.on('error', error => {
      if (!this.closing && !this.pending.size && this.options.log) this.options.log(`[${destination.name}] VSP child process error: ${diagnosticText(error.message)}`);
      this.fail(error);
      void closeDestinationRoute(destination);
    });
    this.process.on('exit', (code, signal) => {
      if (!this.closing && !this.pending.size && this.options.log) this.options.log(`[${destination.name}] VSP child exited (${code ?? signal})`);
      this.fail(new Error(`child exited (${code ?? signal})`));
      void closeDestinationRoute(destination);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_CHILD_BUFFER_BYTES) {
      // A child streaming non-JSON garbage would grow this buffer unbounded.
      this.fail(new Error('child stdout exceeded the buffered line limit'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      // One garbled line (interleaved stderr, partial write) must not reject
      // every in-flight request: skip it and let the per-request timeout or
      // child exit handle a genuinely desynchronized stream.
      try { this.onMessage(JSON.parse(line)); }
      catch (error) { this.options.log?.(`[${this.destination.name}] dropped a non-JSON child line: ${diagnosticText(error.message)}`); }
    }
  }

  onMessage(message) {
    if (message.id === undefined || message.id === null) {
      if (message.method?.startsWith('notifications/')) {
        // An upstream tool-surface change invalidates this child's cached
        // listing; the proxy also drops its merged cache when forwarding.
        if (message.method === 'notifications/tools/list_changed') this.toolsPromise = undefined;
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
    // A dead child must not keep serving its last successful tool listing.
    this.toolsPromise = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params) {
    if (this.exited || !this.process.stdin.writable) return Promise.reject(new Error(`destination ${this.destination.name} child is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A hung child (network stall, backend deadlock) must not hang the call
      // forever. The timeout only fails this request; the child is left alone
      // because killing it would also kill unrelated in-flight requests.
      let timeout;
      const cancel = () => clearTimeout(timeout);
      this.pending.set(id, {
        resolve: value => { cancel(); resolve(value); },
        reject: error => { cancel(); reject(error); }
      });
      if (this.requestTimeoutMs > 0) {
        timeout = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`destination ${this.destination.name} did not answer ${method} within ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs);
      }
      try { this.process.stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC, id, method, ...(params === undefined ? {} : { params })})}\n`); }
      catch (error) { cancel(); this.pending.delete(id); reject(error); }
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

  // The VSP tool surface is fixed for the process lifetime (--mode is a
  // launch argument), so listings are memoized per child. The memo is
  // cleared on failure, on child exit, and on upstream list_changed.
  listToolsCached() {
    if (!this.toolsPromise) {
      this.toolsPromise = this.listTools().catch(error => {
        this.toolsPromise = undefined;
        throw error;
      });
    }
    return this.toolsPromise;
  }

  async close() {
    if (this.exited) return;
    this.closing = true;
    this.notify('notifications/cancelled', { reason: 'proxy shutdown' });
    // Give well-behaved MCP children a graceful exit first: stdin EOF lets
    // them finish and log their own shutdown. Windows cannot trap SIGTERM
    // (Node maps it to TerminateProcess), so EOF is the only graceful path —
    // wait briefly for it before escalating.
    this.process.stdin?.end();
    let timeout;
    try {
      await Promise.race([
        once(this.process, 'exit').catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, 750); })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (this.exited) return;
    this.process.kill('SIGTERM');
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
  constructor({ binary, destinations, env = process.env, spawn = nodeSpawn, childArgs, log = message => console.error(message), output = line => process.stdout.write(`${line}\n`), version = '0.0.0' }) {
    this.binary = binary;
    this.destinations = destinations;
    this.env = env;
    this.spawn = spawn;
    this.childArgs = childArgs;
    this.log = log;
    this.output = output;
    this.version = version;
    this.requestTimeoutMs = requestTimeoutMs(env);
    this.children = [];
    this.started = false;
    this.namespace = new Map();
    this.initialized = false;
    this.clientInitialized = false;
    this.pendingNotifications = [];
    this.shuttingDown = false;
    this.toolsCache = null;
    this.mergedToolsPromise = undefined;
    this.mcpLogLevel = 'info';
  }

  mcpLogEnabled(level) {
    return MCP_LOG_LEVELS.indexOf(level) >= MCP_LOG_LEVELS.indexOf(this.mcpLogLevel);
  }

  // Every observable proxy event lands on stderr and, as a standard
  // notifications/message log event, in the host's MCP server output channel
  // (VS Code/BAS and Claude Code both render these). Events raised before the
  // client initializes are buffered so the channel still shows the full
  // startup picture once it opens. Everything passes through redactText so no
  // lane can leak a credential that reached a diagnostic string.
  eventSink(message, level = 'info', logger = 'sap-ai-dev-toolkit') {
    const text = redactText(message);
    this.log(text);
    if (!this.mcpLogEnabled(level)) return;
    const notification = { jsonrpc: JSONRPC, method: 'notifications/message', params: { level, logger, data: text } };
    if (this.clientInitialized) this.output(JSON.stringify(notification));
    else if (this.pendingNotifications.length < MAX_PENDING_NOTIFICATIONS) this.pendingNotifications.push(notification);
  }

  // Shared spawn options for initial start and self-healing restarts, so the
  // replacement child behaves exactly like the one it replaces.
  childSpawnOptions(destination) {
    return {
      env: this.env,
      spawn: this.spawn,
      args: this.childArgs?.(destination),
      requestTimeoutMs: this.requestTimeoutMs,
      log: message => this.eventSink(message),
      onNotification: notification => {
        if (notification.method === 'notifications/tools/list_changed') this.toolsCache = null;
        if (this.clientInitialized) this.output(JSON.stringify(notification));
        else if (this.pendingNotifications.length < MAX_PENDING_NOTIFICATIONS) this.pendingNotifications.push(notification);
      }
    };
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.starting = (async () => {
      // Destinations start concurrently and are assembled in destination order,
      // keeping serverInfo's children[0] fallback and merged slug numbering deterministic.
      const started = await Promise.all(this.destinations.map(destination => (async () => {
        try {
          this.eventSink(`[${destination.name}] starting VSP child (client=${destination.client || '001'})`);
          return {
            destination,
            child: new Child(this.binary, destination, this.childSpawnOptions(destination))
          };
        } catch (error) {
          this.eventSink(`[${destination.name}] failed to start child: ${diagnosticText(error.message)}`, 'error');
          void closeDestinationRoute(destination);
          return null;
        }
      })()));
      this.children = started.filter(Boolean);
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
  // is retried once. Concurrent triggers share one restart (no orphaned
  // children), and a bounded budget within a rolling window stops a
  // crash-looping child from respawning forever.
  async restartChild(entry) {
    if (this.shuttingDown) throw new Error('MCP proxy is shutting down');
    entry.restartState ||= { inFlight: null, timestamps: [] };
    const state = entry.restartState;
    if (state.inFlight) return state.inFlight;
    const now = Date.now();
    state.timestamps = state.timestamps.filter(at => now - at < RESTART_WINDOW_MS);
    if (state.timestamps.length >= MAX_RESTARTS_PER_WINDOW) {
      throw new Error(`VSP child restart budget exhausted (${MAX_RESTARTS_PER_WINDOW} in ${RESTART_WINDOW_MS / 1000}s); surfacing the failure instead of respawning`);
    }
    state.inFlight = (async () => {
      const name = entry.destination.name;
      this.eventSink(`[${name}] VSP child crashed; self-healing restart in progress`, 'warning');
      try {
        await entry.child.close().catch(() => {});
        const child = new Child(this.binary, entry.destination, this.childSpawnOptions(entry.destination));
        entry.child = child;
        entry.server = await child.initialize(this.lastInitializeParams || {});
        this.toolsCache = null;
        await child.listToolsCached().catch(() => {});
        state.timestamps.push(Date.now());
        this.eventSink(`[${name}] VSP child self-healing restart complete`);
        this.emitToolsListChanged();
        return entry;
      } finally {
        state.inFlight = null;
      }
    })();
    return state.inFlight;
  }

  emitToolsListChanged() {
    // Emitted only after the replacement child's tool surface is warm so a
    // client re-list sees fresh data; buffered until the client initialized.
    const notification = { jsonrpc: JSONRPC, method: 'notifications/tools/list_changed' };
    if (this.clientInitialized) this.output(JSON.stringify(notification));
    else this.pendingNotifications.push(notification);
  }

  async initializeChildren(params) {
    await this.starting;
    this.lastInitializeParams = params;
    // Children initialize concurrently; healthy entries keep destination
    // order so tool naming stays deterministic.
    const initialized = await Promise.all(this.children.map(async entry => {
      const startedAt = Date.now();
      this.eventSink(`[${entry.destination.name}] initializing VSP MCP session`);
      try {
        entry.server = await entry.child.initialize(params);
        this.eventSink(`[${entry.destination.name}] VSP MCP session initialized (${Date.now() - startedAt}ms)`);
        return entry;
      } catch (error) {
        this.eventSink(`[${entry.destination.name}] initialization failed: ${diagnosticText(error.message)}`, 'error');
        await entry.child.close();
        await closeDestinationRoute(entry.destination);
        return null;
      }
    }));
    const healthy = initialized.filter(Boolean);
    this.children = healthy;
    if (!healthy.length) throw new Error('No destination child initialized successfully');
    this.initialized = true;
    // Warm the merged tool cache so the client's first tools/list after
    // initialize resolves without a child round trip.
    const warmedAt = Date.now();
    void this.mergedTools()
      .then(tools => this.eventSink(`[MCP] tools cache warmed (${tools.length} tools, ${Date.now() - warmedAt}ms)`))
      .catch(() => {});
    return healthy;
  }

  toolsCacheValid() {
    const cached = this.toolsCache;
    if (!cached) return false;
    if (cached.children.length !== this.children.length) return false;
    return this.children.every((entry, index) => entry.child === cached.children[index] && !entry.child.exited);
  }

  mergedTools() {
    if (this.mergedToolsPromise) return this.mergedToolsPromise;
    if (this.toolsCacheValid()) return Promise.resolve([...this.toolsCache.tools]);
    const childrenAtBuild = this.children.map(entry => entry.child);
    // A build whose child listing failed is incomplete; caching it would pin
    // the destination's missing tools until a restart or list_changed.
    const buildState = { complete: true };
    this.mergedToolsPromise = this.buildMergedTools(buildState)
      .then(tools => {
        // Cache only when the child set is unchanged; a restart that landed
        // mid-build invalidates the result and the next list rebuilds.
        if (!this.shuttingDown && buildState.complete && this.children.length === childrenAtBuild.length
          && this.children.every((entry, index) => entry.child === childrenAtBuild[index])) {
          this.toolsCache = { children: childrenAtBuild, tools };
        }
        return [...tools];
      })
      .finally(() => { this.mergedToolsPromise = undefined; });
    return this.mergedToolsPromise;
  }

  async buildMergedTools(buildState = { complete: true }) {
    const namespace = new Map();
    const usedSlugs = new Map();
    const merged = [];
    // Generated MCP entries pin exactly one destination per server, so tool
    // names are unprefixed (run_query, get_source): the server name already
    // identifies the target and a slug prefix would be redundant in chat
    // references. Only when one server fronts several destinations (manual
    // multi-destination startup) does each name carry its destination slug
    // so every tool stays unambiguous.
    const prefixed = this.children.length > 1;
    const publish = (name, mapping, definition) => {
      // A duplicate public name must not shadow the first registration: the
      // namespace map would keep the first handler while advertising both.
      if (namespace.has(name)) {
        this.eventSink(`[MCP] skipped duplicate public tool name: ${name}`, 'warning');
        return;
      }
      namespace.set(name, mapping);
      merged.push(definition);
    };
    for (const entry of this.children) {
      const slug = slugifyDestination(entry.destination.name, usedSlugs);
      const publicName = prefixed ? (name => `${slug}_${publicToolSegment(name)}`) : (name => publicToolSegment(name));
      const lintName = publicName(ABAP_LINT_TOOL.name);
      publish(lintName, { handler: runABAPLint }, { ...ABAP_LINT_TOOL, name: lintName });
      let upstreamTools;
      try {
        upstreamTools = await entry.child.listToolsCached();
        entry.lastUpstreamTools = upstreamTools;
      } catch (error) {
        buildState.complete = false;
        this.eventSink(`[${entry.destination.name}] tools/list failed: ${redactText(error.message)}`, 'error');
        // A crashed child must not silently remove its tools from the
        // surface: fall back to the last successful listing so the names stay
        // callable and the tools/call self-heal path can restart the child.
        upstreamTools = entry.lastUpstreamTools;
      }
      if (!upstreamTools) continue;
      for (const tool of upstreamTools) {
        if (tool.name === 'SAP') {
          const applicationLogName = publicName('GetApplicationLog');
          publish(applicationLogName, {
            entry,
            upstream: 'SAP',
            publicName: 'GetApplicationLog',
            transformArguments: applicationLogArguments
          }, {
            name: applicationLogName,
            description: `${APPLICATION_LOG_DESCRIPTION} [destination: ${entry.destination.name}]`,
            inputSchema: APPLICATION_LOG_SCHEMA
          });
        }

        if (!PUBLIC_VSP_TOOLS.has(tool?.name)) continue;
        const name = publicName(tool.name);
        publish(name, { entry, upstream: tool.name }, { ...tool, name, description: `${tool.description || tool.name} [destination: ${entry.destination.name}]` });
      }
      for (const localTool of createEngineeringTools(entry, upstreamTools, { env: this.env, log: this.log })) {
        const name = publicName(localTool.definition.name);
        publish(name, { handler: localTool.handler }, {
          ...localTool.definition,
          name,
          description: `${localTool.definition.description} [destination: ${entry.destination.name}]`
        });
      }
    }
    if (!merged.length && this.children.length) throw new Error('No destination child provided tools');
    // Swap atomically so a concurrent tools/call never sees a partial map.
    this.namespace = namespace;
    return merged;
  }

  async handle(message) {
    if (message.method?.startsWith('notifications/')) {
      for (const entry of this.children) entry.child.notify(message.method, message.params);
      return null;
    }
    if (message.id === undefined) return null;
    const receivedAt = Date.now();
    try {
      this.eventSink(`[MCP] request ${message.method || '?'} (id=${message.id})`, 'debug');
      if (message.method === 'initialize') {
        await this.initializeChildren(message.params || {});
        this.eventSink('[MCP] initialize complete; server ready', 'info');
        return rpcResult(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: slugifyDestination(brandedEnvValue(this.env, 'DESTINATION') || this.children[0].destination.name), version: this.version } });
      }
      if (!this.initialized) return rpcError(message.id, -32002, 'MCP proxy is not initialized');
      if (message.method === 'logging/setLevel' && MCP_LOG_LEVELS.includes(message.params?.level)) {
        this.mcpLogLevel = message.params.level;
        this.eventSink(`[MCP] log level set to ${this.mcpLogLevel}`);
      }
      if (message.method === 'tools/list') {
        const tools = await this.mergedTools();
        this.eventSink(`[MCP] tools/list returned ${tools.length} tools in ${Date.now() - receivedAt}ms`, 'debug');
        return rpcResult(message.id, { tools });
      }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        // Concurrent dispatch means a tools/call can race the first
        // tools/list that builds the tool namespace; ensure the surface
        // exists before resolving the name.
        if (!this.namespace.size) await this.mergedTools().catch(() => {});
        const mapped = this.namespace.get(name);
        if (!mapped) return rpcError(message.id, -32602, `Unknown namespaced tool: ${name}`);
        if (mapped.handler) return rpcResult(message.id, await mapped.handler(message.params?.arguments));
        const toolName = mapped.publicName || mapped.upstream;
        const upstreamParams = { ...message.params, name: mapped.upstream };
        if (mapped.transformArguments) upstreamParams.arguments = mapped.transformArguments(message.params?.arguments);
        const startedAt = Date.now();
        this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} started`);
        try {
          const response = await mapped.entry.child.request('tools/call', upstreamParams);
          if (response.result?.isError) {
            const detail = Array.isArray(response.result.content)
              ? response.result.content.filter(item => item.type === 'text').map(item => item.text).join(' ')
              : '';
            this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} returned an error in ${Date.now() - startedAt}ms${detail ? `: ${diagnosticText(detail)}` : ''}`, 'warning');
          } else {
            this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} completed in ${Date.now() - startedAt}ms`);
          }
          return response.error ? { ...response, id: message.id } : rpcResult(message.id, response.result);
        } catch (error) {
          this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} failed after ${Date.now() - startedAt}ms: ${diagnosticText(error.rpcError?.message || error.message)}`, 'error');
          // Self-healing: a dead child (crash, OOM, transient pipe break) is
          // restarted and the call retried once before surfacing the error.
          // State-changing tools are never retried: the child may have
          // completed the write before dying, and a blind re-send would
          // apply it twice.
          const childBroken = mapped.entry.child.exited || !mapped.entry.child.process.stdin.writable;
          const retriable = !NON_RETRIABLE_VSP_TOOLS.has(mapped.upstream);
          if (!retriable) {
            this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} is state-changing; not retried after a child crash (possible duplicate write)`, 'warning');
          }
          let restartFailure;
          if (childBroken && retriable && !this.shuttingDown) {
            try {
              await this.restartChild(mapped.entry);
              this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} retried after self-healing restart`);
              const retried = await mapped.entry.child.request('tools/call', upstreamParams);
              return retried.error ? { ...retried, id: message.id } : rpcResult(message.id, retried.result);
            } catch (restartError) {
              restartFailure = restartError;
              this.eventSink(`[${mapped.entry.destination.name}] tools/call ${toolName} self-healing restart failed: ${diagnosticText(restartError.message)}`, 'error');
            }
          }
          if (restartFailure) {
            // The restart refusal (budget exhausted, shutdown) is the
            // actionable cause; keep the original failure as context.
            return rpcError(message.id, -32001, `Destination ${mapped.entry.destination.name} failed: ${error.message}; self-healing restart did not run: ${restartFailure.message}`);
          }
          return error.rpcError ? rpcError(message.id, error.rpcError.code || -32001, error.rpcError.message || error.message, error.rpcError.data) : rpcError(message.id, -32001, `Destination ${mapped.entry.destination.name} failed: ${error.message}`);
        }
      }
      if (!FORWARDED_METHODS.has(message.method)) return rpcError(message.id, -32601, `Method not found: ${message.method}`);
      const responses = [];
      for (const entry of this.children) {
        try { responses.push((await entry.child.request(message.method, message.params)).result); } catch (error) { this.eventSink(`[${entry.destination.name}] ${message.method} failed: ${redactText(error.message)}`, 'warning'); }
      }
      return rpcResult(message.id, responses.length === 1 ? responses[0] : responses);
    } catch (error) {
      this.eventSink(`[MCP] ${message.method || 'request'} failed: ${diagnosticText(error.message)}`, 'error');
      return rpcError(message.id, -32000, redactText(error.message));
    }
  }

  async serve(input = process.stdin, output = this.output) {
    this.output = output;
    this.start();
    let buffer = '';
    // Requests are dispatched concurrently so one slow tools/call (an ATC
    // run, a big query) cannot block ping, tools/list, or notifications and
    // make the host declare the server unresponsive. JSON-RPC ids make
    // response order irrelevant to the client; only the initialize handshake
    // must finish first, so every request awaits the gate captured at parse
    // time. In-flight requests are awaited on stream end so their responses
    // are still written before shutdown.
    let initGate = Promise.resolve();
    const inFlight = new Set();
    const dispatch = async message => {
      try {
        const response = await this.handle(message);
        if (!response) return;
        output(JSON.stringify(response));
        if (message.method === 'initialize') {
          this.clientInitialized = true;
          for (const notification of this.pendingNotifications) output(JSON.stringify(notification));
          this.pendingNotifications.length = 0;
        }
      } catch (error) {
        // One failed dispatch must never poison the stream: log and keep
        // serving whatever the client sends next.
        this.eventSink(`[MCP] failed to answer client message: ${diagnosticText(error.message)}`, 'error');
      }
    };
    const track = promise => {
      inFlight.add(promise);
      promise.finally(() => inFlight.delete(promise)).catch(() => {});
    };
    const onData = chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch (error) {
          this.eventSink(`[MCP] invalid client message dropped: ${redactText(error.message)}`, 'error');
          continue;
        }
        if (message?.method === 'initialize' && message.id !== undefined) {
          // Serialize the handshake itself so a second initialize cannot
          // race the first into initializeChildren.
          const run = initGate.then(() => dispatch(message));
          initGate = run;
          track(run);
        } else if (message?.id !== undefined) {
          track(initGate.then(() => dispatch(message)));
        } else {
          track(dispatch(message));
        }
      }
    };
    input.setEncoding('utf8');
    input.on('error', error => {
      this.eventSink(`[MCP] client input stream failed: ${diagnosticText(error.message)}`, 'error');
      void this.close();
    });
    input.on('data', onData);
    try {
      await once(input, 'end');
      await Promise.allSettled([...inFlight]);
    } finally {
      input.off('data', onData);
      await this.close();
    }
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
