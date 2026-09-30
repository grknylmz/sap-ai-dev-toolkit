import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_HARNESS_IDS,
  HARNESSES,
  HARNESS_ENV_VAR,
  NON_INTERACTIVE_HARNESS_IDS,
  agentMarkdownName,
  claudeCodeAgentDocument,
  envHarnessSelection,
  harnessById,
  harnessRoot,
  opencodeAgentDocument,
  parseHarnessSelection
} from '../src/harnesses.mjs';
import { MANIFEST_NAME, installUserAssets, installUserAssetsForHarnesses } from '../src/install-user-assets.mjs';

const agentSource = [
  '---',
  'name: Example Developer',
  'description: An example agent with a description that is long enough to look realistic.',
  'target: vscode',
  'user-invocable: true',
  '---',
  '',
  'Example agent body instructions.',
  ''
].join('\n');

async function writeAsset(root, path, content) {
  const filename = join(root, '.github', path);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function createSourceTree(root) {
  await writeAsset(root, 'agents/abap-developer.agent.md', agentSource);
  await writeAsset(root, 'agents/sap-solution-architect.agent.md', agentSource.replace('Example Developer', 'SAP Solution Architect'));
  await writeAsset(root, 'skills/example/SKILL.md', '---\nname: example\ndescription: An example skill used by the harness tests.\n---\n\n# Example\n');
}

test('harness registry covers the six supported harnesses in canonical order', () => {
  assert.deepEqual(HARNESSES.map(harness => harness.id), ['github-copilot', 'claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode']);
  assert.deepEqual(HARNESSES.filter(harness => harness.supportsAgents).map(harness => harness.id), ['github-copilot', 'claude-code', 'opencode']);
  assert.deepEqual(DEFAULT_HARNESS_IDS, ['github-copilot', 'claude-code']);
  assert.deepEqual(NON_INTERACTIVE_HARNESS_IDS, ['github-copilot']);
});

test('harness roots resolve to the documented user-level directories', () => {
  const home = join('/', 'home', 'example');
  assert.equal(harnessRoot(harnessById('github-copilot'), { home }), join(home, '.copilot'));
  assert.equal(harnessRoot(harnessById('claude-code'), { home }), join(home, '.claude'));
  assert.equal(harnessRoot(harnessById('codex'), { home }), join(home, '.agents'));
  assert.equal(harnessRoot(harnessById('cursor'), { home }), join(home, '.cursor'));
  assert.equal(harnessRoot(harnessById('gemini-cli'), { home }), join(home, '.gemini'));
  assert.equal(harnessRoot(harnessById('opencode'), { home }), join(home, '.config', 'opencode'));
  assert.equal(harnessRoot(harnessById('opencode'), { home, env: { XDG_CONFIG_HOME: join('/', 'xdg') } }), join('/', 'xdg', 'opencode'));
  assert.equal(harnessRoot(harnessById('opencode'), { home, env: { XDG_CONFIG_HOME: '   ' } }), join(home, '.config', 'opencode'));
});

test('harnessById rejects unknown ids with the valid id list', () => {
  assert.throws(() => harnessById('windsurf'), /Unknown harness id: windsurf\. Valid harness ids: github-copilot, claude-code, codex, cursor, gemini-cli, opencode\./);
});

test('parseHarnessSelection normalizes, dedupes, and orders selections', () => {
  assert.deepEqual(parseHarnessSelection('claude-code'), ['claude-code']);
  assert.deepEqual(parseHarnessSelection(' Cursor, github-copilot ,cursor'), ['github-copilot', 'cursor']);
  assert.deepEqual(parseHarnessSelection('Codex'), ['codex']);
  assert.deepEqual(parseHarnessSelection(',, '), []);
  assert.throws(() => parseHarnessSelection('windsurf'), /Unknown harness id: windsurf\. Valid harness ids: github-copilot, claude-code, codex, cursor, gemini-cli, opencode\./);
  assert.throws(() => parseHarnessSelection('codex, windsurf, gemini'), /Unknown harness ids: windsurf, gemini\. Valid harness ids:/);
});

test('envHarnessSelection reads the branded override and treats blank values as unset', () => {
  assert.equal(envHarnessSelection({}), null);
  assert.equal(envHarnessSelection({ [HARNESS_ENV_VAR]: '  ' }), null);
  assert.deepEqual(envHarnessSelection({ [HARNESS_ENV_VAR]: 'gemini-cli,opencode' }), ['gemini-cli', 'opencode']);
  assert.throws(() => envHarnessSelection({ [HARNESS_ENV_VAR]: 'windsurf' }), /Unknown harness id: windsurf/);
});

test('agentMarkdownName rewrites agent file names to plain markdown', () => {
  assert.equal(agentMarkdownName('abap-developer.agent.md'), 'abap-developer.md');
  assert.equal(agentMarkdownName('plain.md'), 'plain.md');
});

test('claudeCodeAgentDocument keeps only name and description with an identical body', () => {
  const transformed = claudeCodeAgentDocument(agentSource);
  assert.equal(transformed, '---\nname: Example Developer\ndescription: An example agent with a description that is long enough to look realistic.\n---\n\nExample agent body instructions.\n');
  assert.equal(transformed.includes('target:'), false);
  assert.equal(transformed.includes('user-invocable:'), false);
});

test('opencodeAgentDocument emits description and subagent mode with an identical body', () => {
  const transformed = opencodeAgentDocument(agentSource);
  assert.equal(transformed, '---\ndescription: An example agent with a description that is long enough to look realistic.\nmode: subagent\n---\n\nExample agent body instructions.\n');
  assert.equal(transformed.includes('name:'), false);
});

test('agent document transforms reject malformed frontmatter', () => {
  for (const transform of [claudeCodeAgentDocument, opencodeAgentDocument]) {
    assert.throws(() => transform('no frontmatter here'), /unsupported agent frontmatter/);
    assert.throws(() => transform('---\nname: missing description\n---\nbody'), /unsupported agent frontmatter/);
  }
  assert.throws(() => claudeCodeAgentDocument('---\ndescription: missing name\n---\nbody'), /unsupported agent frontmatter/);
});

test('installUserAssets writes the expected tree for every harness', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  const xdg = join(directory, 'xdg');
  await createSourceTree(root);

  const copilot = await installUserAssets({ harness: harnessById('github-copilot'), home, root });
  assert.equal(copilot.installed, 3);
  assert.equal((await readFile(join(home, '.copilot', 'agents', 'abap-developer.agent.md'), 'utf8')), agentSource);
  assert.equal((await stat(join(home, '.copilot', 'skills', 'example', 'SKILL.md'))).isFile(), true);

  const claude = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(claude.installed, 3);
  assert.equal(claude.root, join(home, '.claude'));
  const claudeAgent = await readFile(join(home, '.claude', 'agents', 'abap-developer.md'), 'utf8');
  assert.equal(claudeAgent, claudeCodeAgentDocument(agentSource));
  assert.deepEqual((await readdir(join(home, '.claude', 'agents'))).sort(), ['abap-developer.md', 'sap-solution-architect.md']);
  assert.equal((await stat(join(home, '.claude', 'skills', 'example', 'SKILL.md'))).isFile(), true);

  for (const id of ['codex', 'cursor', 'gemini-cli']) {
    const result = await installUserAssets({ harness: harnessById(id), home, root });
    assert.equal(result.installed, 1, id);
    assert.deepEqual((await readdir(result.root)).sort(), [MANIFEST_NAME, 'skills'], id);
    assert.equal((await stat(join(result.root, 'skills', 'example', 'SKILL.md'))).isFile(), true);
  }

  const opencode = await installUserAssets({ harness: harnessById('opencode'), home, root, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(opencode.root, join(xdg, 'opencode'));
  assert.equal((await readFile(join(xdg, 'opencode', 'agents', 'abap-developer.md'), 'utf8')), opencodeAgentDocument(agentSource));

  for (const harness of HARNESSES) {
    const targetRoot = harnessRoot(harness, { home, env: { XDG_CONFIG_HOME: xdg } });
    assert.equal((await stat(join(targetRoot, MANIFEST_NAME))).isFile(), true, harness.id);
  }
});

test('installUserAssets is idempotent and preserves user edits per harness', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-revisit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  await createSourceTree(root);

  const first = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(first.installed, 3);
  const second = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(second.installed, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 3);

  await writeAsset(root, 'skills/example/SKILL.md', '---\nname: example\ndescription: Revised example skill description for the update path.\n---\n\n# Example\n');
  const updatedSource = agentSource.replace('Example agent body instructions.', 'Revised agent body instructions.');
  await writeAsset(root, 'agents/abap-developer.agent.md', updatedSource);
  await writeFile(join(home, '.claude', 'agents', 'sap-solution-architect.md'), 'user customization');
  await writeAsset(root, 'agents/sap-solution-architect.agent.md', agentSource.replace('Example Developer', 'Changed'));

  const third = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(third.updated, 2);
  assert.deepEqual(third.conflicts, [join('agents', 'sap-solution-architect.md')]);
  assert.equal(await readFile(join(home, '.claude', 'agents', 'sap-solution-architect.md'), 'utf8'), 'user customization');
  assert.equal(await readFile(join(home, '.claude', 'agents', 'abap-developer.md'), 'utf8'), claudeCodeAgentDocument(updatedSource));
});

test('installUserAssetsForHarnesses isolates harness failures and reports results', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-multi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  await createSourceTree(root);

  const good = await installUserAssetsForHarnesses(['gemini-cli', 'cursor'], { home, root });
  assert.deepEqual(good.failures, []);
  assert.deepEqual(good.results.map(result => result.harness), ['gemini-cli', 'cursor']);

  await rm(join(home, '.cursor'), { recursive: true, force: true });
  await writeFile(join(home, '.cursor'), 'not a directory', { flag: 'wx' });
  const broken = await installUserAssetsForHarnesses(['gemini-cli', 'cursor', 'windsurf'], { home, root });
  assert.equal(broken.results.length, 1);
  assert.equal(broken.results[0].harness, 'gemini-cli');
  assert.deepEqual(broken.failures.map(failure => failure.id), ['cursor', 'windsurf']);
  assert.equal(broken.failures[0].label, 'Cursor');
});
