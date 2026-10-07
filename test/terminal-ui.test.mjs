import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { checkboxPrompt, colorText, formatStatus, promptOutput, quietSpinnerTheme, selectPrompt, startProgress } from '../src/terminal-ui.mjs';

test('progress status uses a stable single-column glyph instead of a wide emoji', () => {
  const rendered = formatStatus('Loading destinations', 'progress', false, 'Setup');
  assert.equal(rendered, '… Setup Loading destinations');
  assert.doesNotMatch(rendered, /⏳/u);
});

test('startProgress animates a single rewritten line on a TTY and clears it when stopped', async () => {
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  const stop = startProgress('Contacting BAS to discover destinations', { output, env: { TERM: 'xterm-256color' }, label: 'Setup' });
  await new Promise(resolve => setTimeout(resolve, 450));
  stop();
  stop.update('late update is harmless');
  const text = chunks.join('');
  // Every frame rewrites the same line instead of scrolling the terminal.
  const frames = text.split('\r');
  assert.ok(frames.length >= 3, `expected animated frames, got: ${JSON.stringify(text)}`);
  for (const frame of frames.slice(1, -1)) {
    assert.match(frame.replace(/^\u001b\[2K/, ''), /^Setup: Contacting BAS to discover destinations \.{1,3} {0,2}$/);
  }
  // The spinner erases itself when stopped, leaving scrollback clean.
  assert.equal(text.endsWith('\r\u001b[2K'), true);
});

test('startProgress stays silent for non-TTY output and when animation is disabled', () => {
  const cases = [
    { output: new PassThrough(), env: { TERM: 'xterm-256color' } },
    ...[{ TERM: 'dumb' }, { CI: 'true' }, { SAP_AI_DEV_TOOLKIT_DISABLE_SCAN_ANIMATION: 'true' }].map(env => ({
      output: Object.assign(new PassThrough(), { isTTY: true, columns: 80 }),
      env: { TERM: 'xterm-256color', ...env }
    }))
  ];
  // Pipes, MCP hosts, --json callers, CI, dumb terminals, and the explicit
  // opt-out must never see progress output.
  for (const { output, env } of cases) {
    const stop = startProgress('Probing ADT endpoints', { output, env });
    stop();
    stop.update('next');
    assert.equal(output.read(), null, JSON.stringify(env));
  }
});

test('prompt output proxy preserves TTY sizing and color capabilities for Inquirer rendering', async () => {
  const chunks = [];
  const target = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
  target.isTTY = true;
  target.columns = 42;
  target.rows = 9;
  target.getColorDepth = () => 8;
  target.hasColors = count => count <= 256;

  const proxy = promptOutput(target);
  assert.equal(proxy.isTTY, true);
  assert.equal(proxy.columns, 42);
  assert.equal(proxy.rows, 9);
  assert.equal(proxy.getColorDepth(), 8);
  assert.equal(proxy.hasColors(256), true);

  for (let index = 0; index < 20; index += 1) {
    target.columns = 20 + index;
    target.rows = 5 + (index % 4);
    assert.equal(proxy.columns, target.columns);
    assert.equal(proxy.rows, target.rows);
  }

  await new Promise(resolve => proxy.write('visible line', resolve));
  assert.equal(chunks.join(''), 'visible line');
});

test('quiet spinner theme disables animated Braille loading frames', () => {
  assert.deepEqual(quietSpinnerTheme.spinner.frames, ['']);
  assert.equal(quietSpinnerTheme.spinner.interval, 80);
});

// Minimal VT100 model: printable characters with deferred autowrap, LF/CR,
// cursor-up, and erase-to-end-of-screen — enough to see what a redraw leaves
// behind on a real terminal of a given width.
function makeScreen(columns, rows) {
  const grid = Array.from({ length: rows }, () => Array(columns).fill(' '));
  let row = 0;
  let col = 0;
  let pendingWrap = false;
  return {
    feed(text) {
      const tokens = text.matchAll(/(\u001b\[(\d*)A)|(\u001b\[J)|(\u001b\[\?25[lh])|(\u001b\[[0-9;]*m)|([\n\r])|(.)/gu);
      for (const token of tokens) {
        if (token[2] !== undefined) {
          row = Math.max(0, row - Number(token[2] || 1));
          pendingWrap = false;
        } else if (token[3]) {
          for (let r = row; r < rows; r += 1) {
            for (let c = r === row ? col : 0; c < columns; c += 1) grid[r][c] = ' ';
          }
        } else if (token[4] || token[5]) {
          // cursor visibility and SGR styling do not move cells
        } else if (token[6] === '\n' || token[6] === '\r') {
          if (token[6] === '\n') row += 1;
          col = 0;
          pendingWrap = false;
        } else if (token[7] !== undefined) {
          if (pendingWrap) {
            row += 1;
            col = 0;
            pendingWrap = false;
          }
          if (row < rows) grid[row][col] = token[7];
          if (col === columns - 1) pendingWrap = true;
          else col += 1;
        }
      }
    },
    dump() {
      return grid.map(line => line.join('').replace(/\s+$/u, '')).join('\n').replace(/\n+$/u, '');
    }
  };
}

test('select prompt single-key shortcuts take precedence over value prefixes', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};

  const selection = selectPrompt({
    message: 'Authentication',
    defaultValue: 'basic',
    choices: [
      { name: 'windows-sso', value: 'windows-sso', shortcut: 's' },
      { name: 'windows credential UI', value: 'windows-credential-ui', shortcut: 'w' }
    ]
  }, { input, output });
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write('w');
  input.write('\r');
  assert.equal(await selection, 'windows-credential-ui');
});

test('checkbox prompt redraws cleanly on arrow keys in terminals narrower than the header', async () => {
  for (const columns of [63, 30]) {
    const screen = makeScreen(columns, 24);
    const output = new Writable({
      write(chunk, encoding, callback) {
        screen.feed(chunk.toString());
        callback();
      }
    });
    output.isTTY = true;
    output.columns = columns;
    output.rows = 24;
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};

    const message = colorText('🧭 Select destinations', 'cyan', output);
    const choices = [
      { name: 'S4H (BAS, client 100, ok:available)', value: 's4h' },
      { name: 'cicd-backend (BAS, client 001, fail:not-found)', value: 'cicd', disabled: 'unreachable' }
    ];
    const selection = checkboxPrompt({ message, choices, shortcuts: { all: 'a' } }, { input, output });

    await new Promise(resolve => setTimeout(resolve, 10));
    for (const [delay, key] of [[10, '\u001b[B'], [20, '\u001b[A'], [30, '\u001b[B']]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      input.write(key);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    const whilePrompting = screen.dump();
    const headerCount = (whilePrompting.match(/Select destinations \(Space:/gu) || []).length;
    assert.equal(headerCount, 1, `columns=${columns}: expected a single header line, got:\n${whilePrompting}`);
    assert.match(whilePrompting, /S4H/u);

    input.write('\r');
    assert.deepEqual(await selection, []);
    const finished = screen.dump();
    const residue = (finished.match(/Select destinations/gu) || []).length;
    assert.equal(residue, 1, `columns=${columns}: expected only the summary line, got:\n${finished}`);
    assert.match(finished, /Select destinations none sel(ected)?/u);
  }
}, { timeout: 5000 });

test('checkbox prompt action shortcut suspends the picker and appends pre-selected items', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  let actionRuns = 0;
  const selection = checkboxPrompt({
    message: 'Pick destinations',
    choices: [{ value: 'alpha', name: 'alpha' }],
    actions: { m: async () => {
      actionRuns += 1;
      return [{ value: 'manual-1', name: 'manual one' }];
    } }
  }, { input, output });
  await new Promise(resolve => setTimeout(resolve, 10));
  // Toggle alpha, run the wizard action, then confirm everything.
  input.write(' ');
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write('m');
  await new Promise(resolve => setTimeout(resolve, 30));
  input.write('m');
  await new Promise(resolve => setTimeout(resolve, 30));
  input.write('\r');
  assert.deepEqual(await selection, ['alpha', 'manual-1', 'manual-1']);
  assert.equal(actionRuns, 2);
});

test('checkbox prompt action shortcut keeps the picker working when the action is aborted', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const selection = checkboxPrompt({
    message: 'Pick destinations',
    choices: [{ value: 'alpha', name: 'alpha' }],
    actions: { m: async () => {
      throw new Error('Prompt interrupted');
    } }
  }, { input, output });
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write('m');
  await new Promise(resolve => setTimeout(resolve, 30));
  // The picker still responds after the aborted action; nothing is selected.
  input.write(' ');
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write('\r');
  assert.deepEqual(await selection, ['alpha']);
});
