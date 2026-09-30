import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { checkboxPrompt, colorText, formatStatus, promptOutput, quietSpinnerTheme } from '../src/terminal-ui.mjs';

test('progress status uses a stable single-column glyph instead of a wide emoji', () => {
  const rendered = formatStatus('Loading destinations', 'progress', false, 'Setup');
  assert.equal(rendered, '… Setup Loading destinations');
  assert.doesNotMatch(rendered, /⏳/u);
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
