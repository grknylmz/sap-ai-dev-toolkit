import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodePty from '@lydell/node-pty';

// ChildProcess-like adapter over a ConPTY session so the Unix `script`-based
// tests keep their shape on Windows. node-pty merges stderr into stdout, has
// no stdin EOF (a pty never closes), and kill() takes no signal — the adapter
// papering over those differences lives here so the tests stay platform-neutral.
class WindowsPtyChild extends EventEmitter {
  constructor(pty) {
    super();
    this.pty = pty;
    this.pid = pty.pid;
    this.killed = false;
    this.exitInfo = null;
    const stdout = new EventEmitter();
    stdout.setEncoding = () => stdout;
    this.stdout = stdout;
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => this.stderr;
    const stdin = new EventEmitter();
    stdin.write = chunk => {
      if (!this.killed) this.pty.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    // A pty has no EOF; end(data) still delivers the data like a real
    // ChildProcess stdin would before the (no-op) close.
    stdin.end = (chunk, encoding, callback) => {
      if (typeof chunk === 'function') { chunk(); return; }
      if (chunk !== undefined && chunk !== null && chunk !== '') stdin.write(chunk, encoding);
      if (typeof callback === 'function') callback();
    };
    this.stdin = stdin;
    pty.onData(data => stdout.emit('data', data));
    pty.onExit(({ exitCode, signal }) => {
      this.exitInfo = { code: exitCode, signal: signal || null };
      stdout.emit('end');
      this.emit('exit', exitCode, signal || null);
    });
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    try {
      this.pty.kill();
    } catch {
      // Already gone; onExit delivers the status.
    }
  }
}

function spawnWithWindowsPty(command, options = {}) {
  // node-pty escapes embedded quotes in arguments, which cmd.exe mangles, so
  // commands containing quoted paths cannot go through the /c argument.
  // Writing the command into a batch file with a space-free mkdtemp path
  // avoids every quoting layer. Kept synchronous so callers can drive the
  // returned child immediately, matching the Unix spawn() contract.
  const directory = mkdtempSync(join(tmpdir(), 'sap-ai-pty-'));
  const batchPath = join(directory, 'command.cmd');
  writeFileSync(batchPath, `@echo off\r\n${command}\r\n`);
  const pty = nodePty.spawn('cmd.exe', ['/d', '/s', '/c', batchPath], {
    name: 'xterm-256color',
    cols: options.cols || 100,
    rows: options.rows || 30,
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env
  });
  const child = new WindowsPtyChild(pty);
  child.pty.onExit(() => {
    rm(directory, { recursive: true, force: true }).catch(() => {});
  });
  return child;
}

export function spawnWithPty(command, options) {
  if (process.platform === 'darwin') {
    return spawn('python3', ['-c', 'import os,pty,sys; status=pty.spawn(["/bin/sh","-c",sys.argv[1]]); code=os.waitstatus_to_exitcode(status); sys.exit(code if code >= 0 else 128-code)', command], options);
  }
  if (process.platform === 'win32') {
    return spawnWithWindowsPty(command, options);
  }
  return spawn('script', ['-qec', command, '/dev/null'], options);
}
