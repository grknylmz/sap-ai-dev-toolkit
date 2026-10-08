import { platform, homedir } from 'node:os';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

function text(value) { return value == null ? '' : String(value).trim(); }
function decodeXml(value) {
  return text(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function unique(values) {
  const seen = new Set();
  return values.map(pathFromEnv).filter(Boolean).filter(value => {
    const key = String(value).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pathFromEnv(value) {
  const candidate = text(value);
  if (!candidate) return '';
  if (/^file:\/\//i.test(candidate)) {
    try { return fileURLToPath(candidate); } catch { return candidate.replace(/^file:\/\/\/?/i, ''); }
  }
  return candidate;
}

const WINDOWS_LANDSCAPE_FILES = [
  'SAPUILandscape.xml',
  'SAPUILandscapeGlobal.xml',
  'SAPGUILandscape.xml',
  'SAPGUILandscapeGlobal.xml',
  'SAPLogonTree.xml',
  'SAPLogonTreeGlobal.xml',
  'saplogon.ini'
];

const WINDOWS_EXPLICIT_PATH_ENV = [
  'SAP_AI_DEV_SAP_GUI_LANDSCAPE',
  'SAP_AI_DEV_SAP_GUI_CONFIG',
  'SAPUILANDSCAPE',
  'SAPGUI_LANDSCAPE',
  'SAPLOGON_LSXML_FILE',
  'SAPLOGON_INI_FILE'
];

function addWindowsSapGuiFiles(candidates, directory) {
  if (!directory) return;
  for (const name of WINDOWS_LANDSCAPE_FILES) candidates.push(join(directory, name));
}

function addSapGuiJavaFiles(candidates, directory) {
  if (!directory) return;
  candidates.push(join(directory, 'connections'));
  addWindowsSapGuiFiles(candidates, directory);
}

export function sapGuiLandscapeCandidates(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const userProfile = env.USERPROFILE || home;
  const appData = env.APPDATA || (userProfile ? join(userProfile, 'AppData', 'Roaming') : '');
  const localAppData = env.LOCALAPPDATA || (userProfile ? join(userProfile, 'AppData', 'Local') : '');
  const programData = env.PROGRAMDATA || (platform() === 'win32' ? 'C:\\ProgramData' : '');
  const publicProfile = env.PUBLIC || (platform() === 'win32' ? 'C:\\Users\\Public' : '');
  const windir = env.WINDIR || env.SystemRoot || (platform() === 'win32' ? 'C:\\Windows' : '');
  const candidates = WINDOWS_EXPLICIT_PATH_ENV.map(name => env[name]);
  if (platform() === 'win32' || appData || localAppData || programData) {
    for (const base of [appData, localAppData, programData, publicProfile]) {
      if (!base) continue;
      addWindowsSapGuiFiles(candidates, join(base, 'SAP', 'Common'));
      addWindowsSapGuiFiles(candidates, join(base, 'SAP'));
    }
    candidates.push(
      join(windir || '', 'saplogon.ini'),
      join(windir || '', 'SAPLogon.ini'),
      join(userProfile || '', 'saplogon.ini'),
      join(userProfile || '', 'SAPLogon.ini')
    );
    addSapGuiJavaFiles(candidates, join(userProfile || '', '.SAPGUI'));
    addSapGuiJavaFiles(candidates, join(appData || '', 'SAPGUI'));
    addSapGuiJavaFiles(candidates, join(localAppData || '', 'SAPGUI'));
    if (env.ProgramFiles) addWindowsSapGuiFiles(candidates, join(env.ProgramFiles, 'SAP', 'FrontEnd', 'SAPgui'));
    if (env['ProgramFiles(x86)']) addWindowsSapGuiFiles(candidates, join(env['ProgramFiles(x86)'], 'SAP', 'FrontEnd', 'SAPgui'));
  }
  candidates.push(
    join(home, 'Library', 'Preferences', 'SAP', 'SAPGUILandscape.xml'),
    join(home, 'Library', 'Preferences', 'SAP', 'SAPUILandscape.xml'),
    join(home, 'Library', 'Preferences', 'SAP', 'connections'),
    join(home, '.SAPGUI', 'SAPGUILandscape.xml'),
    join(home, '.SAPGUI', 'SAPUILandscape.xml'),
    join(home, '.SAPGUI', 'connections')
  );
  return unique(candidates);
}

function attributes(fragment) {
  const result = {};
  for (const match of fragment.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g)) {
    result[String(match[1] || match[3]).toLowerCase()] = decodeXml(match[2] ?? match[4]);
  }
  return result;
}

function ssoHintFrom(record) {
  const ssoKeys = ['sncname', 'sncpartnername', 'sncmode', 'snc_mode', 'sncqop', 'snc_qop', 'use_sso', 'sso'];
  if (ssoKeys.some(key => {
    const value = text(record[key]);
    return value && !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
  })) return true;
  const values = [record.authentication, record.auth].map(text).filter(Boolean);
  return values.some(value => /snc|sso|kerberos|spnego|secure\s*login/i.test(value) || ['1', 'true', 'yes'].includes(value.toLowerCase()));
}

function instanceFrom(value) {
  const candidates = [value?.instance, value?.instancenumber, value?.instanceNumber, value?.sysnr, value?.systemnumber];
  for (const candidate of candidates) {
    const match = text(candidate).match(/^\d{2}$/);
    if (match) return match[0];
  }
  return '';
}

function normalizeRecord(record, sourcePath) {
  const type = text(record.type || record.kind).toLowerCase();
  if (type && !['sapgui', 'r/3', 'sap'].some(token => type.includes(token))) return null;
  const name = text(record.name || record.description || record.desc || record.systemid || record.sid || record.uuid);
  const address = text(record.server || record.host || record.applicationserver || record.messageserver || record.mshost);
  // SAP GUI ports are DIAG dispatcher ports, not HTTP ports.
  const endpoint = address.match(/^(\[[^\]]+\]|[^:/]+):(\d+)$/);
  const host = endpoint ? endpoint[1] : address;
  const systemId = text(record.systemid || record.sid || record.r3name).toUpperCase();
  if (!name || !host) return null;
  const port = endpoint ? Number(endpoint[2]) : 0;
  const instance = instanceFrom(record) || (port >= 3200 && port <= 3299 ? String(port - 3200).padStart(2, '0') : '');
  const client = text(record.client || record.sapclient) || '001';
  // A load-balanced entry names the message server, whose port is 3600 + its instance.
  const messageServerPort = text(record.msport).match(/^36(\d{2})$/);
  return {
    source: 'sap-gui-local',
    name,
    serverName: name,
    host,
    systemId,
    instance,
    client,
    ...(messageServerPort ? { messageServer: { host, httpPort: 8100 + Number(messageServerPort[1]) } } : {}),
    authentication: ssoHintFrom(record) ? 'Basic/SSO hint' : 'Basic',
    authMode: 'basic',
    ssoHint: ssoHintFrom(record),
    proxyType: 'Internet',
    landscapePath: sourcePath,
    probe: { status: 'needs-adt-url' }
  };
}

function parseLandscapeXml(content, sourcePath) {
  const records = [];
  // Comments must not turn deleted entries into selectable systems.
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  const messageServers = new Map();
  for (const match of content.matchAll(/<Messageserver\b([^>]*)>/gi)) {
    const record = attributes(match[1]);
    if (record.uuid) messageServers.set(record.uuid, record);
  }
  for (const match of content.matchAll(/<Service\b([^>]*)\/?>(?:\s*<\/Service>)?/gi)) {
    const record = attributes(match[1]);
    if (record.msid) {
      const messageServer = messageServers.get(record.msid);
      // For load-balanced entries `server` is a logon group, not a host.
      if (!messageServer?.host) continue;
      record.server = messageServer.host;
      record.msport = messageServer.port;
    }
    const normalized = normalizeRecord(record, sourcePath);
    if (normalized) records.push(normalized);
  }
  // SAP GUI for Java files may use generic Item/Connection elements.
  for (const match of content.matchAll(/<(?:Item|Connection)\b([^>]*)\/?>(?:\s*<\/(?:Item|Connection)>)?/gi)) {
    const normalized = normalizeRecord(attributes(match[1]), sourcePath);
    if (normalized) records.push(normalized);
  }
  return records;
}

function parseSapLogonIni(content, sourcePath) {
  const sections = new Map();
  let section = '';
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)]\s*$/);
    if (header) { section = header[1].toLowerCase(); if (!sections.has(section)) sections.set(section, {}); continue; }
    const entry = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (entry && section) sections.get(section)[entry[1].toLowerCase()] = entry[2];
  }
  const descriptions = sections.get('description') || sections.get('descriptions') || {};
  const servers = sections.get('server') || sections.get('servers') || {};
  const systems = sections.get('system') || sections.get('systems') || {};
  const databases = sections.get('database') || sections.get('databases') || {};
  const clients = sections.get('client') || sections.get('clients') || {};
  const instances = sections.get('systemnumber') || {};
  const sncNames = sections.get('sncname') || {};
  const sncModes = sections.get('snc') || sections.get('sncmode') || {};
  const keys = unique([...Object.keys(descriptions), ...Object.keys(servers)]);
  return keys.map(key => normalizeRecord({
    name: descriptions[key] || systems[key] || key,
    server: servers[key],
    systemid: databases[key] || systems[key],
    client: clients[key],
    systemnumber: instances[key],
    sncname: sncNames[key],
    sncmode: sncModes[key]
  }, sourcePath)).filter(Boolean);
}

async function readGuiFile(path) {
  const bytes = await readFile(path);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function sapGuiSearchRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const userProfile = env.USERPROFILE || home;
  return unique([
    env.APPDATA && join(env.APPDATA, 'SAP'),
    env.APPDATA && join(env.APPDATA, 'SAPGUI'),
    userProfile && join(userProfile, 'AppData', 'Roaming', 'SAP'),
    userProfile && join(userProfile, 'AppData', 'Roaming', 'SAPGUI'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'SAP'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'SAPGUI'),
    userProfile && join(userProfile, 'AppData', 'Local', 'SAP'),
    userProfile && join(userProfile, 'AppData', 'Local', 'SAPGUI'),
    env.PROGRAMDATA && join(env.PROGRAMDATA, 'SAP'),
    env.PUBLIC && join(env.PUBLIC, 'SAP'),
    userProfile && join(userProfile, '.SAPGUI'),
    home && join(home, 'Library', 'Preferences', 'SAP'),
    home && join(home, '.SAPGUI')
  ]);
}

async function findSapGuiFilesUnder(root, { maxDepth = 4, maxEntries = 500 } = {}) {
  const wanted = new Set(WINDOWS_LANDSCAPE_FILES.map(value => value.toLowerCase()).concat(['connections']));
  const found = [];
  let visited = 0;
  async function walk(directory, depth) {
    if (depth < 0 || visited >= maxEntries) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > maxEntries) return;
      const child = join(directory, entry.name);
      if (entry.isFile() && wanted.has(basename(entry.name).toLowerCase())) found.push(child);
      else if (entry.isDirectory()) {
        if (basename(entry.name).toLowerCase() === 'connections') found.push(child);
        await walk(child, depth - 1);
      }
    }
  }
  await walk(root, maxDepth);
  return found;
}

const SAP_GUI_REGISTRY_ROOTS = [
  'HKCU\\Software\\SAP\\SAPLogon',
  'HKCU\\Software\\SAP\\SAPLogon\\Options',
  'HKCU\\Software\\WOW6432Node\\SAP\\SAPLogon',
  'HKCU\\Software\\WOW6432Node\\SAP\\SAPLogon\\Options',
  'HKLM\\Software\\SAP\\SAPLogon',
  'HKLM\\Software\\SAP\\SAPLogon\\Options',
  'HKLM\\Software\\WOW6432Node\\SAP\\SAPLogon',
  'HKLM\\Software\\WOW6432Node\\SAP\\SAPLogon\\Options'
];

function registryPathCandidates(value) {
  const raw = pathFromEnv(value);
  if (!raw) return [];
  const lower = raw.toLowerCase();
  if (/\.(?:xml|ini)$/i.test(lower)) return [raw];
  if (/\\|\//.test(raw) && !extname(raw)) {
    const result = [];
    addWindowsSapGuiFiles(result, raw);
    result.push(join(raw, 'connections'));
    return result;
  }
  if (/\.(?:xml|ini)(?:\s|$)/i.test(lower)) return [raw.split(/\s+/)[0]];
  return [];
}

async function windowsRegistrySapGuiCandidates(env = process.env) {
  if (platform() !== 'win32') return [];
  // Escape hatch for locked-down machines and for tests that must not see
  // the real registry's landscape paths.
  const disabled = String(env.SAP_AI_DEV_TOOLKIT_DISABLE_SAP_GUI_REGISTRY || '').toLowerCase() === 'true';
  if (disabled) return [];
  const candidates = [];
  for (const root of SAP_GUI_REGISTRY_ROOTS) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', root, '/s'], { windowsHide: true, timeout: 2000, maxBuffer: 256 * 1024 });
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i);
        if (!match) continue;
        candidates.push(...registryPathCandidates(match[1].replace(/%([^%]+)%/g, (_, name) => env[name] || env[name.toUpperCase()] || `%${name}%`)));
      }
    } catch {
      // Registry access can be blocked by policy or absent on non-standard installs.
    }
  }
  return unique(candidates);
}

async function selfHealingSapGuiCandidates(env, candidates) {
  const expanded = [...candidates, ...await windowsRegistrySapGuiCandidates(env)];
  for (const root of sapGuiSearchRoots(env)) {
    expanded.push(...await findSapGuiFilesUnder(root));
  }
  return unique(expanded);
}

function broadSapGuiSearchRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return unique([home, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.PROGRAMDATA, env.PUBLIC]);
}

async function broadSelfHealingSapGuiCandidates(env) {
  const expanded = [];
  for (const root of broadSapGuiSearchRoots(env)) {
    expanded.push(...await findSapGuiFilesUnder(root, { maxDepth: 6, maxEntries: 5000 }));
  }
  return unique(expanded);
}

async function parseConnectionsFile(path) {
  const content = await readGuiFile(path);
  if (content.includes('<')) return parseLandscapeXml(content, path);
  return content.split(/\r?\n/).map((line, index) => {
    const parts = line.split(/[;,\t]/).map(text).filter(Boolean);
    if (parts.length < 2) return null;
    return normalizeRecord({ name: parts[0] || `SAP GUI ${index + 1}`, server: parts.find(part => /[A-Za-z]/.test(part) && part.includes('.')) || parts[1], systemid: parts.find(part => /^[A-Za-z0-9]{3}$/.test(part)) }, path);
  }).filter(Boolean);
}

async function parseSapGuiCandidatePaths(candidatePaths) {
  const systems = [];
  for (const path of unique(candidatePaths)) {
    if (!path) continue;
    try {
      if (!await exists(path)) continue;
      const info = await stat(path);
      if (info.isDirectory()) {
        for (const name of await readdir(path)) {
          const child = join(path, name);
          try {
            if ((await stat(child)).isFile()) systems.push(...await parseConnectionsFile(child));
          } catch {
            // One unreadable child must not hide the rest of the directory.
          }
        }
      } else if (/saplogon\.ini$/i.test(path)) {
        systems.push(...parseSapLogonIni(await readGuiFile(path), path));
      } else {
        systems.push(...await parseConnectionsFile(path));
      }
    } catch {
      // Ignore unreadable or unfamiliar SAP GUI files; discovery is best-effort.
    }
  }
  return systems;
}

export async function discoverSapGuiSystems({ env = process.env, paths } = {}) {
  const candidatePaths = paths ? unique(paths) : await selfHealingSapGuiCandidates(env, sapGuiLandscapeCandidates(env));
  let systems = await parseSapGuiCandidatePaths(candidatePaths);
  if (!systems.length && !paths) systems = await parseSapGuiCandidatePaths(await broadSelfHealingSapGuiCandidates(env));
  const seen = new Set();
  return systems.filter(system => {
    const key = `${system.name}\0${system.host}\0${system.systemId}\0${system.instance}\0${system.client}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function defaultAdtUrl(system) {
  const host = text(system.host);
  const instance = text(system.instance);
  if (!host) return '';
  // Router strings and other DIAG routes cannot be used as HTTP hosts.
  if (/[\s/@?#]/.test(host)) return '';
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return /^\d{2}$/.test(instance) ? `https://${authority}:443${instance}` : `https://${authority}`;
}

// new URL() drops a default port, so `https://host:443` must be read from the text.
export function hasExplicitPort(url) {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:\d+(?:[/?#]|$)/i.test(String(url || '').trim());
}

// VSP appends every ADT path to the base URL, so a pasted ADT path would double up.
export function adtBaseUrl(url) {
  return String(url || '').trim().replace(/[?#].*$/, '').replace(/\/sap\/bc\/adt(?:\/.*)?$/i, '').replace(/\/+$/, '');
}

// A gateway path prefix cannot be probed by host and port alone.
export function hasPathPrefix(url) {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/[^?#]/i.test(adtBaseUrl(url));
}

export function adtPort(url) {
  const parsed = new URL(url);
  return Number(parsed.port) || (parsed.protocol === 'http:' ? 80 : 443);
}

// A redirect proves less than a 401 or 200: a gateway can redirect every path.
function adtRank(finding) {
  return (finding.secure ? 0 : 2) + (finding.status >= 300 && finding.status < 400 ? 1 : 0);
}

// Picks the ADT URL from VSP detect's JSON, or explains why there is none.
export function adtVerdict(result, protocol = 'https:') {
  const findings = Array.isArray(result?.findings) ? result.findings.filter(Boolean) : [];
  const usable = findings
    .filter(finding => finding.kind === 'adt' && /^https?:\/\//i.test(String(finding.url || '')) && (finding.secure || protocol === 'http:'))
    .sort((left, right) => adtRank(left) - adtRank(right));
  if (usable.length) return { url: usable[0].url, reason: '' };
  const host = result?.host || 'the host';
  const unsearched = Array.isArray(result?.unsearched) ? result.unsearched[0] : undefined;
  if (unsearched) {
    const unresolved = /does not resolve/i.test(String(unsearched.reason));
    return { url: '', unresolved, reason: unresolved ? `${unsearched.object} does not resolve; connect to the company network or VPN` : `${unsearched.object}: ${unsearched.reason}` };
  }
  const plain = findings.find(finding => finding.kind === 'adt');
  // The SSO session cookie is the whole credential; https is never traded for http silently.
  if (plain) return { url: '', reason: `only plain HTTP answers ADT (${plain.url}); enter it explicitly to accept an unencrypted connection` };
  const inactive = findings.find(finding => finding.kind === 'sap-without-adt');
  if (inactive) return { url: '', reason: `SAP answers at ${inactive.url} but /sap/bc/adt is not active; ask basis to activate it in SICF` };
  const tls = findings.find(finding => finding.kind === 'tls-name-mismatch');
  if (tls && /certificate required|bad certificate/i.test(String(tls.detail))) {
    return { url: '', reason: `port ${tls.port} demands a client certificate (smart card), which VSP cannot present` };
  }
  if (tls) return { url: '', reason: `port ${tls.port} presents a certificate ${tls.certHost ? `for ${tls.certHost}` : 'this machine does not trust'}${tls.detail ? ` (${tls.detail})` : ''}` };
  const open = findings.filter(finding => ['open', 'http'].includes(finding.kind)).map(finding => finding.port);
  if (open.length) return { url: '', reason: `${open.length === 1 ? `port ${open[0]} on ${host} accepts` : `ports ${open.join(', ')} on ${host} accept`} connections but none answered as ADT` };
  return { url: '', reason: `no port answered on ${host}` };
}

// A portless URL means 443, which on-premise ICMs rarely serve; VSP's `detect`
// probes the conventional ADT ports and reports which one answers. A host that
// accepts every port makes each probe wait out its HTTP timeouts, so the full
// sweep gets minutes.
export async function detectAdtUrl(binary, { url, client, instance, env = process.env, exhaustive = false, ports = [], timeoutMs = exhaustive ? 600_000 : 120_000 } = {}) {
  let configured;
  try { configured = new URL(url); } catch { return { url: '', reason: `${url} is not a valid URL` }; }
  const host = configured.hostname.replace(/^\[(.*)\]$/, '$1');
  const args = ['detect', host, '--json',
    ...(client ? ['--client', String(client)] : []),
    ...(/^\d{2}$/.test(String(instance || '')) ? ['--instance', String(instance)] : []),
    ...(exhaustive ? ['--all'] : []),
    ...ports.flatMap(port => ['--port', String(port)])];
  // A corporate HTTPS_PROXY rarely routes internal SAP hosts; probe them directly.
  const noProxy = [env.NO_PROXY || env.no_proxy, host].filter(Boolean).join(',');
  const [command, ...prefixArgs] = /\.(?:mjs|cjs|js)$/i.test(binary)
    ? [process.execPath, binary]
    : (/\.(?:cmd|bat)$/i.test(binary) && platform() === 'win32' ? ['cmd', '/c', binary] : [binary]);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(command, [...prefixArgs, ...args], { env: { ...env, NO_PROXY: noProxy, no_proxy: noProxy }, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    const why = error.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : (typeof error.code === 'string' ? error.code : `exit code ${error.code}`);
    const blocked = ['EACCES', 'EPERM', 'UNKNOWN'].includes(error.code) ? '; antivirus or application control may block it' : '';
    return { url: '', reason: `VSP detect could not run (${why}) from ${binary}${blocked}` };
  }
  try { return adtVerdict(JSON.parse(stdout), configured.protocol); }
  catch { return { url: '', reason: 'VSP detect returned unreadable output' }; }
}

// Application servers appear by their SM51 names, host_SID_NN.
export function parseMessageServerServers(body, { host = '', systemId = '' } = {}) {
  const domain = isIP(host) ? '' : (/^[^.]+\.(.+)$/.exec(host)?.[1] || '');
  const servers = new Map();
  for (const [, name, sid, instance] of String(body).matchAll(/\b([A-Za-z0-9][A-Za-z0-9.-]*)_([A-Za-z][A-Za-z0-9]{2})_(\d{2})\b/g)) {
    if (systemId && sid.toUpperCase() !== systemId.toUpperCase()) continue;
    const appHost = name.includes('.') || !domain ? name : `${name}.${domain}`;
    servers.set(`${appHost.toLowerCase()}:${instance}`, { host: appHost, instance });
  }
  return [...servers.values()];
}

// A load-balanced landscape entry names the message server, which serves no
// ADT; its HTTP port lists the application servers that do, the same source
// SAP Web Dispatcher reads.
export async function messageServerAppServers({ host, httpPort, systemId } = {}, { timeoutMs = 5000 } = {}) {
  if (!host || !httpPort) return [];
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  for (const path of ['/msgserver/text/logon', '/msgserver/text/serverlist']) {
    let body = '';
    try {
      const response = await fetch(`http://${authority}:${httpPort}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) body = await response.text();
    } catch {
      continue;
    }
    const servers = parseMessageServerServers(body, { host, systemId });
    if (servers.length) return servers;
  }
  return [];
}
