import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  parseHarnessSelection,
  piCodingAgentPromptDocument
} from '../src/harnesses.mjs';
import { MANIFEST_NAME, installUserAssets, installUserAssetsForHarnesses } from '../src/install-user-assets.mjs';
import { harnessMcpConfigPath, installMcpServersForHarnesses } from '../src/harness-mcp-config.mjs';

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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('harness registry covers the seven supported harnesses in canonical order', () => {
  assert.deepEqual(HARNESSES.map(harness => harness.id), ['github-copilot', 'claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode', 'pi-coding-agent']);
  assert.deepEqual(HARNESSES.filter(harness => harness.supportsAgents).map(harness => harness.id), ['github-copilot', 'claude-code', 'opencode', 'pi-coding-agent']);
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
  assert.equal(harnessRoot(harnessById('opencode'), { home, env: {} }), join(home, '.config', 'opencode'));
  assert.equal(harnessRoot(harnessById('opencode'), { home, env: { XDG_CONFIG_HOME: join('/', 'xdg') } }), join('/', 'xdg', 'opencode'));
  assert.equal(harnessRoot(harnessById('opencode'), { home, env: { XDG_CONFIG_HOME: '   ' } }), join(home, '.config', 'opencode'));
  assert.equal(harnessRoot(harnessById('pi-coding-agent'), { home }), join(home, '.pi', 'agent'));
  assert.equal(harnessRoot(harnessById('pi-coding-agent'), { home, env: { PI_CODING_AGENT_DIR: join('/', 'pi-agent') } }), join('/', 'pi-agent'));
});

test('harnessById rejects unknown ids with the valid id list', () => {
  assert.throws(() => harnessById('windsurf'), /Unknown harness id: windsurf\. Valid harness ids: github-copilot, claude-code, codex, cursor, gemini-cli, opencode, pi-coding-agent\./);
});

test('parseHarnessSelection normalizes, dedupes, and orders selections', () => {
  assert.deepEqual(parseHarnessSelection('claude-code'), ['claude-code']);
  assert.deepEqual(parseHarnessSelection(' Cursor, github-copilot ,cursor'), ['github-copilot', 'cursor']);
  assert.deepEqual(parseHarnessSelection('Codex'), ['codex']);
  assert.deepEqual(parseHarnessSelection(',, '), []);
  assert.throws(() => parseHarnessSelection('windsurf'), /Unknown harness id: windsurf\. Valid harness ids: github-copilot, claude-code, codex, cursor, gemini-cli, opencode, pi-coding-agent\./);
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

test('piCodingAgentPromptDocument emits a prompt template for the agent persona', () => {
  const transformed = piCodingAgentPromptDocument(agentSource);
  assert.equal(transformed, '---\ndescription: Use the Example Developer SAP agent persona. An example agent with a description that is long enough to look realistic.\nargument-hint: "[request]"\n---\nAct as **Example Developer** for the following request. Follow these agent instructions and use relevant installed SAP skills when helpful.\n\nExample agent body instructions.\n\nUser request: $ARGUMENTS\n');
});

test('agent document transforms reject malformed frontmatter', () => {
  for (const transform of [claudeCodeAgentDocument, opencodeAgentDocument, piCodingAgentPromptDocument]) {
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

  const pi = await installUserAssets({ harness: harnessById('pi-coding-agent'), home, root });
  assert.equal(pi.root, join(home, '.pi', 'agent'));
  assert.equal((await readFile(join(home, '.pi', 'agent', 'prompts', 'abap-developer.md'), 'utf8')), piCodingAgentPromptDocument(agentSource));
  assert.equal((await stat(join(home, '.pi', 'agent', 'skills', 'example', 'SKILL.md'))).isFile(), true);

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

test('installUserAssets removes managed legacy agent aliases instead of multiplying entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-dedupe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  await createSourceTree(root);

  const oldPath = join(home, '.claude', 'agents', 'abap-developer.agent.md');
  const unmanagedDuplicate = join(home, '.claude', 'agents', 'sap-solution-architect.agent.md');
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, 'old managed claude agent');
  await writeFile(unmanagedDuplicate, claudeCodeAgentDocument(agentSource.replace('Example Developer', 'SAP Solution Architect')));
  await writeFile(join(home, '.claude', MANIFEST_NAME), JSON.stringify({
    version: 1,
    files: {
      [join('agents', 'abap-developer.agent.md')]: createHash('sha256').update('old managed claude agent').digest('hex')
    }
  }));

  const result = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(result.installed, 3);
  assert.equal(result.removed, 2);
  assert.equal(await readFile(join(home, '.claude', 'agents', 'abap-developer.md'), 'utf8'), claudeCodeAgentDocument(agentSource));
  await assert.rejects(readFile(oldPath), { code: 'ENOENT' });
  await assert.rejects(readFile(unmanagedDuplicate), { code: 'ENOENT' });
  assert.deepEqual((await readdir(join(home, '.claude', 'agents'))).sort(), ['abap-developer.md', 'sap-solution-architect.md']);

  const second = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(second.installed, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.unchanged, 3);
  assert.deepEqual((await readdir(join(home, '.claude', 'agents'))).sort(), ['abap-developer.md', 'sap-solution-architect.md']);
});

test('installUserAssets preserves customized legacy aliases and reports them as conflicts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-custom-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  await createSourceTree(root);

  const customAlias = join(home, '.claude', 'agents', 'abap-developer.agent.md');
  await mkdir(dirname(customAlias), { recursive: true });
  await writeFile(customAlias, 'user-customized old-format agent');
  await writeFile(join(home, '.claude', MANIFEST_NAME), JSON.stringify({
    version: 1,
    files: {
      [join('agents', 'abap-developer.agent.md')]: sha256('old managed content before user edit')
    }
  }));

  const result = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(result.removed, 0);
  assert.deepEqual(result.conflicts, [join('agents', 'abap-developer.agent.md')]);
  assert.equal(await readFile(customAlias, 'utf8'), 'user-customized old-format agent');
  assert.equal(await readFile(join(home, '.claude', 'agents', 'abap-developer.md'), 'utf8'), claudeCodeAgentDocument(agentSource));
});

test('installUserAssets removes stale managed files that disappeared from the package', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-stale-managed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  await createSourceTree(root);

  const staleTarget = join('skills', 'obsolete', 'SKILL.md');
  const stalePath = join(home, '.claude', staleTarget);
  await mkdir(dirname(stalePath), { recursive: true });
  await writeFile(stalePath, 'old managed skill');
  await writeFile(join(home, '.claude', MANIFEST_NAME), JSON.stringify({
    version: 1,
    files: { [staleTarget]: sha256('old managed skill') }
  }));

  const result = await installUserAssets({ harness: harnessById('claude-code'), home, root });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.conflicts, []);
  await assert.rejects(readFile(stalePath), { code: 'ENOENT' });
  const manifest = JSON.parse(await readFile(join(home, '.claude', MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.files[staleTarget], undefined);
});

test('installUserAssets removes Pi prompt duplicates from all legacy agent locations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-pi-dedupe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const home = join(directory, 'home');
  await createSourceTree(root);

  const duplicateContent = piCodingAgentPromptDocument(agentSource);
  const duplicates = [
    join(home, '.pi', 'agent', 'agents', 'abap-developer.agent.md'),
    join(home, '.pi', 'agent', 'agents', 'abap-developer.md'),
    join(home, '.pi', 'agent', 'prompts', 'abap-developer.agent.md')
  ];
  for (const duplicate of duplicates) {
    await mkdir(dirname(duplicate), { recursive: true });
    await writeFile(duplicate, duplicateContent);
  }

  const result = await installUserAssets({ harness: harnessById('pi-coding-agent'), home, root });
  assert.equal(result.removed, 3);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await readFile(join(home, '.pi', 'agent', 'prompts', 'abap-developer.md'), 'utf8'), duplicateContent);
  for (const duplicate of duplicates) await assert.rejects(readFile(duplicate), { code: 'ENOENT' });
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

test('harness MCP paths target supported user-level JSON configs', () => {
  const home = join('/', 'home', 'example');
  assert.equal(harnessMcpConfigPath('github-copilot', { home }), null);
  assert.equal(harnessMcpConfigPath('claude-code', { home }), join(home, '.claude.json'));
  assert.equal(harnessMcpConfigPath('cursor', { home }), join(home, '.cursor', 'mcp.json'));
  assert.equal(harnessMcpConfigPath('gemini-cli', { home }), join(home, '.gemini', 'settings.json'));
  assert.equal(harnessMcpConfigPath('pi-coding-agent', { home }), join(home, '.pi', 'agent', 'mcp.json'));
});

test('installMcpServersForHarnesses wires managed servers and preserves unrelated entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const env = { PI_CODING_AGENT_DIR: join(directory, 'pi-agent') };
  const servers = {
    'demo-abap': {
      type: 'stdio',
      command: 'sap-ai-dev',
      env: { H2O_URL: 'http://h2o.example', SAP_AI_DEV_TOOLKIT_DESTINATION: 'DEMO_ABAP' },
      BAS_EXT: 'true'
    },
    'cap-tools': {
      type: 'stdio',
      command: 'npx',
      args: ['--yes', '--package=@cap-js/mcp-server', 'cds-mcp'],
      displayName: 'CAP tools',
      description: 'CAP project inspection.',
      BAS_EXT: 'true'
    }
  };

  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      mine: { command: 'node', args: ['mine.js'] },
      stale: { command: 'sap-ai-dev', env: { SAP_AI_DEV_TOOLKIT_DESTINATION: 'OLD' } }
    }
  }));

  const result = await installMcpServersForHarnesses(['github-copilot', 'cursor', 'gemini-cli', 'pi-coding-agent'], servers, { home, env });
  assert.deepEqual(result.failures, []);
  assert.equal(result.results.find(entry => entry.harness === 'github-copilot').supported, false);

  const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ['cap-tools', 'demo-abap', 'mine']);
  assert.equal(cursor.mcpServers.mine.command, 'node');
  assert.equal(cursor.mcpServers['demo-abap'].command, 'sap-ai-dev');
  assert.equal(cursor.mcpServers['demo-abap'].env.SAP_AI_DEV_TOOLKIT_DESTINATION, 'DEMO_ABAP');
  assert.equal(cursor.mcpServers['demo-abap'].env.SAP_AI_DEV_TOOLKIT_MANAGED, 'true');
  assert.equal(cursor.mcpServers['cap-tools'].description, 'CAP project inspection.');

  const gemini = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.mcpServers['demo-abap'].command, 'sap-ai-dev');
  const pi = JSON.parse(await readFile(join(directory, 'pi-agent', 'mcp.json'), 'utf8'));
  assert.equal(pi.mcpServers['cap-tools'].command, 'npx');
});

test('installMcpServersForHarnesses refuses to overwrite user-owned MCP entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-mcp-conflict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'other' } } }));

  const result = await installMcpServersForHarnesses(['cursor'], { demo: { type: 'stdio', command: 'sap-ai-dev' } }, { home });
  assert.equal(result.results.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error.message, /already exists and is not managed/);
});

test('installMcpServersForHarnesses reads a BOM-prefixed harness mcp.json on Windows-style files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-harness-mcp-bom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.cursor', 'mcp.json'), Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(JSON.stringify({ mcpServers: { mine: { command: 'node', args: ['mine.js'] } } }))
  ]));

  const result = await installMcpServersForHarnesses(['cursor'], { demo: { type: 'stdio', command: 'sap-ai-dev' } }, { home });
  assert.deepEqual(result.failures, []);
  const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ['demo', 'mine']);
  assert.equal((await readFile(join(home, '.cursor', 'mcp.json')))[0], 0x7B, 'rewrite drops the BOM');
});
