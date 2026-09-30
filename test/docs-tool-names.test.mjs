import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const agentsRoot = join(root, '.github', 'agents');
const skillsRoot = join(root, '.github', 'skills');

// Hidden upstream tools the bundled docs legitimately mention as not exposed.
const allowedHiddenMentions = new Set(['DeleteBreakpoint', 'DebuggerListen']);

// tools.md list sections that define the curated surface.
const curatedSections = new Set([
  'Public VSP tools',
  'Destination-scoped workflow tools',
  'Separate optional HANA Cloud inspector'
]);

async function curatedToolNames() {
  const markdown = await readFile(join(root, 'tools.md'), 'utf8');
  const names = new Set();
  let section = '';
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith('- ') || !curatedSections.has(section)) continue;
    for (const [, name] of line.matchAll(/`([A-Za-z0-9_]+)`/g)) names.add(name);
  }
  return names;
}

async function assetPaths() {
  const paths = [];
  for (const entry of await readdir(agentsRoot)) {
    if (entry.endsWith('.agent.md')) paths.push(join(agentsRoot, entry));
  }
  for (const entry of await readdir(skillsRoot)) {
    paths.push(join(skillsRoot, entry, 'SKILL.md'));
  }
  return paths;
}

// Tool-shaped means PascalCase with an internal capital: matches `GetSource`,
// `GetAPIReleaseState`, and `LintABAP` while skipping all-caps words such as
// `MCP`/`ABAP`/`SLG1`, lowercase names such as `get_source`, and prose tokens.
function isToolShaped(token) {
  return /^[A-Z][A-Za-z0-9]+$/.test(token)
    && /[a-z]/.test(token)
    && /[A-Z]/.test(token.slice(1));
}

test('agents and skills only reference tools from the curated tools.md surface', async () => {
  const curated = await curatedToolNames();
  assert.equal(curated.size, 65, 'tools.md curated sections must list 53 VSP + 8 workflow + 4 HANA tools');

  const drift = [];
  for (const path of await assetPaths()) {
    const markdown = await readFile(path, 'utf8');
    for (const [, token] of markdown.matchAll(/`([^`\n]+)`/g)) {
      if (!isToolShaped(token)) continue;
      if (curated.has(token) || allowedHiddenMentions.has(token)) continue;
      drift.push(`${relative(root, path)} references unknown tool \`${token}\``);
    }
  }
  assert.deepEqual(drift, [], 'tool references drifted from tools.md; update the docs or tools.md');
});
