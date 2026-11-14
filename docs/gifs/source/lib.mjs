// Shared helpers for the demo recordings: a minimal stdio MCP client, a CDP
// screencast recorder, and the GIF/MP4 encoder with caption overlays.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'undici';

export const OUT = new URL('..', import.meta.url).pathname;
const FONT = process.env.GIF_FONT || '/System/Library/Fonts/SFNS.ttf';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

export function mcpServer(command, args, env) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  child.stderr.resume();
  const request = (method, params) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    child,
    request,
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gif-recorder', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async call(name, args = {}) {
      const { result, error } = await request('tools/call', { name, arguments: args });
      if (error) throw new Error(`${name}: ${JSON.stringify(error)}`);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      return { isError: result.isError === true, text, json: () => JSON.parse(text) };
    },
    close() {
      child.kill('SIGTERM');
    }
  };
}

export function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let next = 1;
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else for (const listener of listeners) listener(message);
    });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}, sessionId) => new Promise(done => {
        const id = next++;
        pending.set(id, done);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      on: listener => listeners.push(listener),
      close: () => ws.close()
    }));
    ws.addEventListener('error', reject);
  });
}

/**
 * Records a page by polling Page.captureScreenshot (Page.startScreencast
 * yields black frames on headless targets with emulated metrics) plus timed captions.
 */
export async function screencast(pageWsUrl, { intervalMs = 200 } = {}) {
  const page = await cdp(pageWsUrl);
  const frames = [];
  const captions = [];
  const now = () => Date.now() / 1000;
  let recording = true;
  const loop = (async () => {
    while (recording) {
      const started = Date.now();
      const shot = await Promise.race([page.send('Page.captureScreenshot', { format: 'png' }), new Promise(r => setTimeout(r, 3000))]);
      // Skip frames while the page navigates (no result) and keep the previous one on screen.
      if (shot?.result?.data) frames.push({ t: now(), data: shot.result.data });
      await new Promise(r => setTimeout(r, Math.max(0, intervalMs - (Date.now() - started))));
    }
  })();
  let open = null;
  return {
    caption(text) {
      if (open) open.to = now();
      open = text ? { from: now(), to: null, text } : null;
      if (open) captions.push(open);
    },
    async hold(seconds) {
      await new Promise(r => setTimeout(r, seconds * 1000));
    },
    async stop(name) {
      if (open) open.to = now();
      recording = false;
      await loop;
      page.close();
      encode(name, frames, captions, now());
    }
  };
}

function encode(name, frames, captions, end) {
  if (!frames.length) throw new Error(`${name}: no frames recorded`);
  const dir = mkdtempSync(join(tmpdir(), `gif-${name}-`));
  const start = Math.min(frames[0].t, captions[0]?.from ?? frames[0].t);
  const list = [];
  frames.forEach((frame, i) => {
    const file = join(dir, `f${String(i).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(frame.data, 'base64'));
    const until = i + 1 < frames.length ? frames[i + 1].t : end;
    const duration = Math.max(0.04, until - (i === 0 ? start : frame.t));
    list.push(`file '${file}'`, `duration ${duration.toFixed(3)}`);
  });
  list.push(`file '${join(dir, `f${String(frames.length - 1).padStart(5, '0')}.png`)}'`);
  writeFileSync(join(dir, 'list.txt'), `${list.join('\n')}\n`);
  const draw = captions.map((c, i) => {
    const file = join(dir, `caption${i}.txt`);
    writeFileSync(file, c.text);
    const from = Math.max(0, c.from - start).toFixed(2);
    const to = Math.max(0, (c.to ?? end) - start).toFixed(2);
    return `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=26:fontcolor=white:box=1:boxcolor=0x0A2540@0.88:boxborderw=18:x=(w-text_w)/2:y=h-text_h-36:enable='between(t,${from},${to})'`;
  });
  const base = ['fps=12', 'scale=1440:1000:force_original_aspect_ratio=decrease', 'pad=1440:1000:(ow-iw)/2:(oh-ih)/2:white', ...draw].join(',');
  mkdirSync(join(OUT, 'mp4'), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', `${base},format=yuv420p`, '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', join(OUT, 'mp4', `${name}.mp4`)]);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', `${base},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, join(OUT, `${name}.gif`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${name}.gif ${(statSync(join(OUT, `${name}.gif`)).size / 1e6).toFixed(1)} MB`);
}

/** Newest managed-browser profile started by sap-ai-webgui after `since`. */
export async function waitForManagedPage(since, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dirs = readdirSync(tmpdir()).filter(d => d.startsWith('sap-ai-webgui-')).map(d => join(tmpdir(), d)).filter(d => statSync(d).mtimeMs >= since);
    for (const dir of dirs) {
      try {
        const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        // The browser's initial about:blank tab is not the one sap-ai-webgui drives.
        const page = targets.find(t => t.type === 'page' && t.url.includes('/sap/bc/gui/'));
        if (page) return page.webSocketDebuggerUrl;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('managed browser did not start');
}
