import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const agentsRoot = join(root, '.github', 'agents');
const agentPath = join(agentsRoot, 'abap-developer.agent.md');
const skillsRoot = join(root, '.github', 'skills');
const expectedAgents = [
  'abap-developer.agent.md',
  'abap-runtime-debugger.agent.md',
  'hana-cloud-hdi-specialist.agent.md',
  'rap-service-developer.agent.md',
  'sap-integration-architect.agent.md',
  'sap-integration-developer.agent.md',
  'sap-solution-architect.agent.md'
];
const expectedSkills = [
  'abap-debugging',
  'abap-development',
  'abap-runtime-analysis',
  'abap-testing-quality',
  'cds-development',
  'clean-core-extensibility',
  'hana-cloud-inspection',
  'hana-cloud-native-development',
  'hana-cloud-validation',
  'integration-suite-delivery',
  'rap-development',
  'rap-service-delivery',
  'sap-integration-architect',
  'sap-sdlc-orchestration',
  'sap-standard-api-analysis',
  'sap-transport-release'
];
async function readMarkdown(path) {
  // Normalize CRLF so content assertions hold on Windows checkouts where
  // git autocrlf converted the bundled agents and skills.
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
}

function parseFrontmatter(markdown, path) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, `${path} must start with YAML frontmatter`);
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    assert.ok(separator > 0, `${path} has invalid frontmatter line: ${line}`);
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return metadata;
}

test('packaged Copilot agent and skill inventory is complete and canonical', async () => {
  assert.equal((await stat(agentPath)).isFile(), true);
  assert.deepEqual((await readdir(agentsRoot)).sort(), expectedAgents);
  const actualSkills = (await readdir(skillsRoot)).sort();
  assert.deepEqual(actualSkills, expectedSkills);
  for (const skill of expectedSkills) {
    assert.equal((await stat(join(skillsRoot, skill, 'SKILL.md'))).isFile(), true, `${skill} must have SKILL.md`);
  }
});

test('agent file names match the slugified frontmatter names for harness renames', async () => {
  for (const name of expectedAgents) {
    const path = join(agentsRoot, name);
    const metadata = parseFrontmatter(await readMarkdown(path), path);
    const slug = metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    assert.equal(name.replace(/\.agent\.md$/, ''), slug, `${path} file name must match the slugified frontmatter name`);
  }
});


test('each skill has valid frontmatter and a matching public directory name', async () => {
  for (const skill of expectedSkills) {
    const path = join(skillsRoot, skill, 'SKILL.md');
    const markdown = await readMarkdown(path);
    const metadata = parseFrontmatter(markdown, path);
    assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name']);
    assert.equal(metadata.name, skill, `${skill} frontmatter name must match its directory`);
  }
});

