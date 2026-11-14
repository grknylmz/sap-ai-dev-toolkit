// SAP AI WebGUI Relay: connects to the local sap-ai-webgui MCP server
// (ws://127.0.0.1:<port>), proves the pairing token, and executes tab and
// chrome.debugger commands — only on SAP GUI for HTML tabs.
const WEBGUI_PATH = '/sap/bc/gui/sap/its/webgui';
const DEFAULT_PORT = 47823;
const PROTOCOL = 1;
// CDP methods the server may send; everything else is refused.
const ALLOWED_CDP = new Set([
  'Runtime.evaluate',
  'Page.enable',
  'Page.navigate',
  'Page.captureScreenshot',
  'Page.handleJavaScriptDialog',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setFocusEmulationEnabled'
]);

let socket = null;
let pingTimer = null;
// A rejected token stays rejected until the options change; no retry storm.
let rejected = false;
const attached = new Set();
const created = new Set();

async function settings() {
  const stored = await chrome.storage.local.get(['port', 'token', 'origins']);
  return {
    port: Number(stored.port) || DEFAULT_PORT,
    token: String(stored.token || '').trim(),
    origins: (stored.origins || []).map(o => String(o).trim().replace(/\/+$/, '')).filter(Boolean)
  };
}

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
  chrome.action.setBadgeText({ text: status.state === 'connected' ? 'ON' : status.state === 'rejected' ? 'ERR' : '' });
}

function isWebgui(url, origins) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.pathname.startsWith(WEBGUI_PATH)) return false;
  return origins.length === 0 || origins.includes(parsed.origin);
}

async function requireWebguiTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { origins } = await settings();
  if (!isWebgui(tab.url || '', origins)) throw new Error(`tab ${tabId} is not an allowed SAP GUI for HTML page`);
  return tab;
}

const handlers = {
  async 'tabs.find'({ prefix }) {
    const { origins } = await settings();
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter(t => t.url && t.url.startsWith(prefix) && isWebgui(t.url, origins))
      .map(t => ({ tabId: t.id, url: t.url, title: t.title, active: t.active }));
  },
  async 'tabs.create'({ url }) {
    const { origins } = await settings();
    if (!isWebgui(url, origins)) throw new Error('only SAP GUI for HTML URLs may be opened');
    const tab = await chrome.tabs.create({ url, active: true });
    created.add(tab.id);
    return { tabId: tab.id };
  },
  async 'tabs.remove'({ tabId }) {
    if (!created.has(tabId)) throw new Error('only tabs opened by the relay may be closed');
    await chrome.tabs.remove(tabId);
    created.delete(tabId);
    attached.delete(tabId);
    return {};
  },
  async 'debugger.attach'({ tabId }) {
    await requireWebguiTab(tabId);
    if (!attached.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attached.add(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    }
    return {};
  },
  async 'debugger.detach'({ tabId }) {
    if (attached.has(tabId)) {
      attached.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    return {};
  },
  async cdp({ tabId, method, params }) {
    if (!attached.has(tabId)) throw new Error('debugger is not attached to this tab; call webgui_open again');
    if (!ALLOWED_CDP.has(method)) throw new Error(`CDP method ${method} is not allowed by the relay`);
    // The user may have navigated the tab elsewhere; never drive non-WebGUI pages.
    const tab = await requireWebguiTab(tabId);
    if (method === 'Page.navigate') {
      const { origins } = await settings();
      if (!isWebgui(params?.url || '', origins) || new URL(params.url).origin !== new URL(tab.url).origin) {
        throw new Error('navigation outside SAP GUI for HTML is not allowed');
      }
    }
    return chrome.debugger.sendCommand({ tabId }, method, params || {});
  }
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.javascriptDialogOpening' || !attached.has(source.tabId)) return;
  const accept = params.type === 'beforeunload' || params.type === 'alert';
  chrome.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept }).catch(() => {});
});

chrome.debugger.onDetach.addListener((source, reason) => {
  attached.delete(source.tabId);
  send({ type: 'event', name: 'detached', tabId: source.tabId, reason });
});

chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId);
  created.delete(tabId);
});

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function onRequest(message) {
  const handler = handlers[message.method];
  try {
    if (!handler) throw new Error(`unknown relay method ${message.method}`);
    send({ id: message.id, result: (await handler(message.params || {})) ?? {} });
  } catch (error) {
    send({ id: message.id, error: { message: String(error?.message || error) } });
  }
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const { port, token } = await settings();
  if (rejected) return;
  if (!token) {
    await setStatus({ state: 'unpaired', detail: 'Enter the pairing token from sap-ai-dev --setup-webgui in the extension options.' });
    return;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, protocol: PROTOCOL, version: chrome.runtime.getManifest().version }));
  ws.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      setStatus({ state: 'connected', detail: `paired with sap-ai-webgui on port ${port}` });
      clearInterval(pingTimer);
      // Traffic keeps the service worker alive while the server is up.
      pingTimer = setInterval(() => send({ type: 'ping' }), 20_000);
    } else if (message.type === 'rejected') {
      rejected = true;
      setStatus({ state: 'rejected', detail: message.reason || 'pairing token rejected' });
      ws.close();
    } else if (message.type === 'request') {
      onRequest(message);
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (socket === ws) socket = null;
    for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {});
    attached.clear();
    if (!rejected) {
      setStatus({ state: 'waiting', detail: `waiting for sap-ai-webgui on 127.0.0.1:${port}` });
      setTimeout(connect, 3000);
    }
  };
  ws.onerror = () => {};
}

chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reconnect') connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.port)) {
    rejected = false;
    if (socket) socket.close();
    connect();
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
connect();
