import { Writable } from 'node:stream';
import readline from 'node:readline';
import terminalKit from 'terminal-kit';

const { stringWidth, truncateString } = terminalKit;

const COLORS = {
  cyan: '\u001b[1;36m',
  green: '\u001b[1;32m',
  yellow: '\u001b[1;33m',
  red: '\u001b[1;31m',
  blue: '\u001b[1;34m',
  magenta: '\u001b[1;35m'
};

const STATUS = {
  progress: { icon: '…', color: 'cyan' },
  info: { icon: 'ℹ️', color: 'cyan' },
  success: { icon: '✅', color: 'green' },
  warning: { icon: '⚠️', color: 'yellow' },
  error: { icon: '❌', color: 'red' },
  step: { icon: '➡️', color: 'blue' },
  copilot: { icon: '🤖', color: 'magenta' }
};

function colorEnabled(output) {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  const isTTY = typeof output === 'boolean' ? output : Boolean(output?.isTTY);
  return isTTY && process.env.TERM !== 'dumb';
}

export function colorText(text, color, output) {
  const value = String(text);
  const code = COLORS[color];
  if (!code || !colorEnabled(output)) return value;
  return `${code}${value}\u001b[0m`;
}

export function iconLabel(icon, label, color, output) {
  return colorText(`${icon} ${label}`, color, output);
}

export function formatStatus(message, tone, output, label = 'sap-ai-dev-toolkit') {
  const { icon, color } = STATUS[tone] || STATUS.info;
  return `${iconLabel(icon, label, color, output)} ${message}`;
}

export function promptOutput(output) {
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      output.write(chunk, encoding, callback);
    }
  });
  for (const property of ['isTTY', 'columns', 'rows']) {
    Object.defineProperty(proxy, property, {
      enumerable: true,
      get: () => output?.[property]
    });
  }
  for (const method of ['getColorDepth', 'hasColors']) {
    if (typeof output?.[method] === 'function') {
      proxy[method] = (...args) => output[method](...args);
    }
  }
  return proxy;
}

export const quietSpinnerTheme = {
  spinner: { interval: 80, frames: [''] }
};

function enabledChoices(choices) {
  return choices.filter(choice => !choice.disabled);
}

function nextEnabledIndex(choices, start, step) {
  if (!choices.length) return 0;
  let index = start;
  for (let count = 0; count < choices.length; count += 1) {
    index = (index + step + choices.length) % choices.length;
    if (!choices[index]?.disabled) return index;
  }
  return start;
}

function firstEnabledIndex(choices) {
  const index = choices.findIndex(choice => !choice.disabled);
  return index === -1 ? 0 : index;
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncateToColumns(text, columns) {
  const value = String(text);
  if (columns <= 0 || stringWidth(value) <= columns) return value;
  return truncateString(value, Math.max(1, columns));
}

// A rendered line can wrap onto several physical terminal rows; redrawing must
// count those rows or cursor-up clears too little and stale fragments remain.
function physicalRows(lines, columns) {
  if (columns <= 0) return lines.length;
  return lines.reduce((total, line) => total + Math.max(1, Math.ceil(stringWidth(line) / columns)), 0);
}

function checkboxPageSize(output, choiceCount) {
  const rows = Number.isFinite(output?.rows) ? output.rows : 24;
  return clamp(Math.min(choiceCount, rows - 7), 1, Math.max(1, choiceCount));
}

export async function selectPrompt({ message, choices, defaultValue } = {}, { input = process.stdin, output = process.stdout } = {}) {
  if (!Array.isArray(choices) || !choices.length) return undefined;
  let cursor = choices.findIndex(choice => !choice.disabled && (choice.value === defaultValue || choice.checked));
  if (cursor === -1) cursor = firstEnabledIndex(choices);
  let top = 0;
  let renderedLines = 0;
  let done = false;
  let previousRawMode;

  const write = text => output.write(text);
  const clearRendered = () => {
    if (!renderedLines) return;
    write(`\u001b[${renderedLines}A\u001b[J`);
    renderedLines = 0;
  };
  const ensureVisible = pageSize => {
    if (cursor < top) top = cursor;
    if (cursor >= top + pageSize) top = cursor - pageSize + 1;
    top = clamp(top, 0, Math.max(0, choices.length - pageSize));
  };
  const render = () => {
    const columns = Number.isFinite(output?.columns) ? output.columns : 80;
    const pageSize = checkboxPageSize(output, choices.length);
    ensureVisible(pageSize);
    const lines = [];
    lines.push(truncateToColumns(`${message} (↑/↓: choose, Enter: confirm)`, columns));
    const end = Math.min(choices.length, top + pageSize);
    for (let index = top; index < end; index += 1) {
      const choice = choices[index];
      const pointer = index === cursor ? '❯' : ' ';
      const marker = index === cursor ? colorText('●', 'green', output) : '○';
      const disabled = choice.disabled ? ` — ${choice.disabled}` : '';
      const label = `${pointer}${marker} ${choice.name}${disabled}`;
      lines.push(truncateToColumns(label, columns));
    }
    if (choices.length > pageSize) {
      lines.push(truncateToColumns(colorText(`  Showing ${top + 1}-${end} of ${choices.length}; use ↑/↓ to scroll.`, 'cyan', output), columns));
    }
    clearRendered();
    write(`${lines.join('\n')}\n`);
    renderedLines = physicalRows(lines, columns);
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (typeof input.setRawMode === 'function' && previousRawMode !== undefined) input.setRawMode(previousRawMode);
      if (typeof input.pause === 'function') input.pause();
      write('\u001b[?25h');
    };
    const finish = choice => {
      if (done) return;
      done = true;
      clearRendered();
      write(`${stripAnsi(message)} ${choice?.name || choice?.value || ''}\n`);
      cleanup();
      resolve(choice?.value);
    };
    const fail = error => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const onKeypress = (chunk, key = {}) => {
      if (key.ctrl && key.name === 'c') return fail(new Error('Prompt interrupted'));
      if (key.name === 'up' || key.name === 'k') cursor = nextEnabledIndex(choices, cursor, -1);
      else if (key.name === 'down' || key.name === 'j') cursor = nextEnabledIndex(choices, cursor, 1);
      else if (key.name === 'return' || key.name === 'enter') return finish(choices[cursor]);
      else if (chunk) {
        const typed = String(chunk).toLowerCase();
        let match = choices.findIndex(choice => !choice.disabled && String(choice.shortcut || '').toLowerCase() === typed);
        if (match === -1) {
          match = choices.findIndex(choice => !choice.disabled && (
            String(choice.value || '').toLowerCase().startsWith(typed) ||
            String(choice.name || '').toLowerCase().startsWith(typed)
          ));
        }
        if (match !== -1) cursor = match;
        else return;
      } else return;
      render();
    };

    try {
      readline.emitKeypressEvents(input);
      previousRawMode = input.isRaw;
      if (typeof input.setRawMode === 'function') input.setRawMode(true);
      if (typeof input.resume === 'function') input.resume();
      write('\u001b[?25l');
      input.on('keypress', onKeypress);
      render();
    } catch (error) {
      fail(error);
    }
  });
}

export async function checkboxPrompt({ message, choices: initialChoices, required = false, shortcuts = { all: 'a' }, actions = {}, validate } = {}, { input = process.stdin, output = process.stdout } = {}) {
  if (!Array.isArray(initialChoices) || !initialChoices.length) return [];
  // Action shortcuts (for example 'm' → manual entry wizard) may append new
  // choices while the picker is open, so the list itself stays mutable.
  let choices = initialChoices;
  const selectable = enabledChoices(choices);
  const selected = new Set(choices.flatMap((choice, index) => choice.checked && !choice.disabled ? [index] : []));
  let cursor = firstEnabledIndex(choices);
  let top = 0;
  let renderedLines = 0;
  let done = false;
  let previousRawMode;

  const write = text => output.write(text);
  const clearRendered = () => {
    if (!renderedLines) return;
    write(`\u001b[${renderedLines}A\u001b[J`);
    renderedLines = 0;
  };
  const ensureVisible = pageSize => {
    if (cursor < top) top = cursor;
    if (cursor >= top + pageSize) top = cursor - pageSize + 1;
    top = clamp(top, 0, Math.max(0, choices.length - pageSize));
  };
  const render = (error = '') => {
    const columns = Number.isFinite(output?.columns) ? output.columns : 80;
    const pageSize = checkboxPageSize(output, choices.length);
    ensureVisible(pageSize);
    const lines = [];
    lines.push(truncateToColumns(`${message} (Space: select, ${shortcuts?.all || 'a'}: toggle all, Enter: confirm)`, columns));
    const end = Math.min(choices.length, top + pageSize);
    for (let index = top; index < end; index += 1) {
      const choice = choices[index];
      const pointer = index === cursor ? '❯' : ' ';
      const marker = selected.has(index)
        ? colorText('✓', 'green', output)
        : colorText('✗', 'red', output);
      const disabled = choice.disabled ? ` — ${choice.disabled}` : '';
      const label = `${pointer}${marker} ${choice.name}${disabled}`;
      lines.push(truncateToColumns(label, columns));
    }
    if (choices.length > pageSize) {
      lines.push(truncateToColumns(colorText(`  Showing ${top + 1}-${end} of ${choices.length}; use ↑/↓ to scroll.`, 'cyan', output), columns));
    }
    if (error) lines.push(truncateToColumns(colorText(`  ${error}`, 'red', output), columns));
    clearRendered();
    write(`${lines.join('\n')}\n`);
    renderedLines = physicalRows(lines, columns);
  };

  return new Promise((resolve, reject) => {
    const actionShortcuts = new Map(Object.entries(actions).filter(([shortcut, action]) => shortcut && typeof action === 'function'));
    const actionShortcutFor = (chunk, key = {}) => {
      if (!actionShortcuts.size) return undefined;
      const typed = String(chunk ?? '').toLowerCase();
      if (typed.length === 1 && actionShortcuts.has(typed)) return actionShortcuts.get(typed);
      if (key.name && actionShortcuts.has(key.name)) return actionShortcuts.get(key.name);
      return undefined;
    };
    // Running an action suspends the picker (listener detached, raw mode off),
    // lets the action drive its own prompts on the same streams, and appends
    // the produced items as pre-selected choices before redrawing. An aborted
    // action (Ctrl+C in a sub-prompt) returns to the picker unchanged instead
    // of tearing down the whole selection.
    const runAction = async action => {
      input.off('keypress', onKeypress);
      if (typeof input.setRawMode === 'function') input.setRawMode(false);
      clearRendered();
      let appended = [];
      try { appended = await action() || []; }
      catch { appended = []; }
      const added = (Array.isArray(appended) ? appended : []).filter(item => item && item.value !== undefined);
      if (added.length) {
        for (const item of added) {
          choices.push({ checked: true, ...item });
          selected.add(choices.length - 1);
        }
        cursor = choices.length - added.length;
      }
      if (typeof input.setRawMode === 'function') input.setRawMode(previousRawMode);
      // Sub-prompts pause the stream on cleanup; resume so keypresses reach
      // the re-attached picker listener.
      if (typeof input.resume === 'function') input.resume();
      input.on('keypress', onKeypress);
      render();
    };

    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (typeof input.setRawMode === 'function' && previousRawMode !== undefined) input.setRawMode(previousRawMode);
      if (typeof input.pause === 'function') input.pause();
      write('\u001b[?25h');
    };
    const finish = value => {
      if (done) return;
      done = true;
      clearRendered();
      write(`${stripAnsi(message)} ${value.length ? `${value.length} selected` : 'none selected'}\n`);
      cleanup();
      resolve(value);
    };
    const fail = error => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const onKeypress = (_chunk, key = {}) => {
      if (key.ctrl && key.name === 'c') return fail(new Error('Prompt interrupted'));
      if (key.name === 'up' || key.name === 'k') cursor = nextEnabledIndex(choices, cursor, -1);
      else if (key.name === 'down' || key.name === 'j') cursor = nextEnabledIndex(choices, cursor, 1);
      else if (key.name === 'space' && !choices[cursor]?.disabled) {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
      } else if (shortcuts?.all && key.name === shortcuts.all) {
        const allSelected = enabledChoices(choices).every(choice => selected.has(choices.indexOf(choice)));
        selected.clear();
        if (!allSelected) for (const choice of enabledChoices(choices)) selected.add(choices.indexOf(choice));
      } else if (actionShortcutFor(_chunk, key)) {
        void runAction(actionShortcutFor(_chunk, key));
        return;
      } else if (key.name === 'return' || key.name === 'enter') {
        const values = [...selected].sort((a, b) => a - b).map(index => choices[index].value);
        const validation = typeof validate === 'function' ? validate(values) : true;
        if (validation !== true) return render(String(validation));
        if (required && !values.length) return render('Select at least one item.');
        return finish(values);
      } else {
        return;
      }
      render();
    };

    try {
      readline.emitKeypressEvents(input);
      previousRawMode = input.isRaw;
      if (typeof input.setRawMode === 'function') input.setRawMode(true);
      if (typeof input.resume === 'function') input.resume();
      write('\u001b[?25l');
      input.on('keypress', onKeypress);
      render();
    } catch (error) {
      fail(error);
    }
  });
}

// Single-line text/secret prompt matching the checkbox prompt's interaction
// style. Secrets are masked with ●, support backspace, and can be re-prompted
// through `validate`. Ctrl+C rejects with 'Prompt interrupted'.
export async function textPrompt({ message, secret = false, required = true, placeholder = '', validate } = {}, { input = process.stdin, output = process.stdout } = {}) {
  let value = '';
  let renderedLines = 0;
  let done = false;
  let previousRawMode;

  const write = text => output.write(text);
  const masked = () => '●'.repeat(value.length);
  const clearRendered = () => {
    if (!renderedLines) return;
    write(`\u001b[${renderedLines}A\u001b[J`);
    renderedLines = 0;
  };
  const render = (error = '') => {
    const columns = Number.isFinite(output?.columns) ? output.columns : 80;
    const lines = [];
    const hint = secret ? ' (input is hidden)' : '';
    lines.push(truncateToColumns(`${message}${hint}`, columns));
    const shown = secret ? masked() : value;
    const display = shown || colorText(placeholder, 'cyan', output);
    lines.push(truncateToColumns(`❯ ${display}`, columns));
    if (error) lines.push(truncateToColumns(colorText(`  ${error}`, 'red', output), columns));
    clearRendered();
    write(`${lines.join('\n')}\n`);
    renderedLines = physicalRows(lines, columns);
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (typeof input.setRawMode === 'function' && previousRawMode !== undefined) input.setRawMode(previousRawMode);
      if (typeof input.pause === 'function') input.pause();
      write('\u001b[?25h');
    };
    const finish = result => {
      if (done) return;
      done = true;
      clearRendered();
      const summary = secret ? '✓ saved' : (result || '(empty)');
      write(`${stripAnsi(message)} ${summary}\n`);
      cleanup();
      resolve(result);
    };
    const fail = error => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const onKeypress = (chunk, key = {}) => {
      if (key.ctrl && key.name === 'c') return fail(new Error('Prompt interrupted'));
      if (key.name === 'return' || key.name === 'enter') {
        const validation = typeof validate === 'function' ? validate(value) : true;
        if (validation !== true) return render(String(validation));
        if (required && !value.length) return render('Enter a value (or press Ctrl+C to skip).');
        return finish(value);
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1);
      } else if (key.sequence && !key.ctrl && !key.meta && /^.$/u.test(key.sequence)) {
        value += key.sequence;
      } else {
        return;
      }
      render();
    };

    try {
      readline.emitKeypressEvents(input);
      previousRawMode = input.isRaw;
      if (typeof input.setRawMode === 'function') input.setRawMode(true);
      if (typeof input.resume === 'function') input.resume();
      write('\u001b[?25l');
      input.on('keypress', onKeypress);
      render();
    } catch (error) {
      fail(error);
    }
  });
}

// Animated progress line for long-running steps (destination discovery,
// ADT probes, VSP binary provisioning). TTY outputs get spinner frames on an
// unref'd timer that starts after a short delay, so steps that finish quickly
// never flash anything. Non-TTY outputs (pipes, MCP hosts, --json callers,
// CI) stay completely silent so machine consumers never see progress noise.
// Returns stop(); on a TTY, stop() clears the line so it never pollutes
// scrollback. stop.update(message) retargets the label while running (for
// example per destination during --doctor).
export function startProgress(initialMessage, { output = process.stdout, env = process.env, label = 'sap-ai-dev-toolkit' } = {}) {
  const noop = Object.assign(() => {}, { update: () => {} });
  if (!output || typeof output.write !== 'function') return noop;
  const animationDisabled = env.TERM === 'dumb' || env.CI || env.SAP_AI_DEV_TOOLKIT_DISABLE_SCAN_ANIMATION === 'true';
  if (!output.isTTY || !Number.isFinite(output.columns) || animationDisabled) return noop;
  let message = String(initialMessage);
  let index = 0;
  let active = false;
  let interval;
  const render = () => {
    active = true;
    index += 1;
    const columns = Math.max(20, output.columns || 80);
    const dots = `.${'.'.repeat(index % 3)}${' '.repeat(2 - index % 3)}`;
    const line = `${label}: ${message} ${dots}`.slice(0, Math.max(1, columns - 1));
    output.write(`\r\u001b[2K${line}`);
  };
  const delay = setTimeout(() => {
    render();
    interval = setInterval(render, 120);
    if (typeof interval.unref === 'function') interval.unref();
  }, 150);
  if (typeof delay.unref === 'function') delay.unref();
  const stop = () => {
    clearTimeout(delay);
    if (interval) clearInterval(interval);
    if (active) output.write('\r\u001b[2K');
  };
  stop.update = next => { message = String(next); };
  return stop;
}
