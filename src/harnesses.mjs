import { homedir } from 'node:os';
import { join } from 'node:path';

export const HARNESS_ENV_VAR = 'SAP_AI_DEV_TOOLKIT_HARNESSES';
export const DEFAULT_HARNESS_IDS = ['github-copilot', 'claude-code'];
export const NON_INTERACTIVE_HARNESS_IDS = ['github-copilot'];

// \r? keeps frontmatter parsing working on Windows checkouts where git's
// autocrlf converted the bundled agents and skills to CRLF line endings.
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function splitFrontmatter(source) {
  const match = FRONTMATTER_PATTERN.exec(String(source));
  if (!match) return null;
  const fields = match[1].split('\n').map(line => {
    const separator = line.indexOf(':');
    return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
  });
  if (fields.some(field => !field.key)) return null;
  return { fields, body: String(source).slice(match[0].length) };
}

function requiredField(fields, key) {
  const field = fields.find(entry => entry.key === key);
  return field && field.value ? field.value : null;
}

function renderDocument(fields, body) {
  return `---\n${fields.map(field => `${field.key}: ${field.value}`).join('\n')}\n---\n${body}`;
}

export function agentMarkdownName(fileName) {
  return String(fileName).replace(/\.agent\.md$/, '.md');
}

export function piCodingAgentRoot({ home = process.env.HOME || homedir(), env = process.env } = {}) {
  const override = typeof env?.PI_CODING_AGENT_DIR === 'string' ? env.PI_CODING_AGENT_DIR.trim() : '';
  return override || join(home, '.pi', 'agent');
}

export function claudeCodeAgentDocument(source) {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) throw new Error('unsupported agent frontmatter');
  const kept = frontmatter.fields
    .filter(field => field.key === 'name' || field.key === 'description')
    .filter(field => field.value);
  if (!requiredField(frontmatter.fields, 'name') || !requiredField(frontmatter.fields, 'description')) {
    throw new Error('unsupported agent frontmatter');
  }
  return renderDocument(kept, frontmatter.body);
}

export function opencodeAgentDocument(source) {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) throw new Error('unsupported agent frontmatter');
  const description = requiredField(frontmatter.fields, 'description');
  if (!description) throw new Error('unsupported agent frontmatter');
  return renderDocument([{ key: 'description', value: description }, { key: 'mode', value: 'subagent' }], frontmatter.body);
}

export function piCodingAgentPromptDocument(source) {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) throw new Error('unsupported agent frontmatter');
  const name = requiredField(frontmatter.fields, 'name');
  const description = requiredField(frontmatter.fields, 'description');
  if (!name || !description) throw new Error('unsupported agent frontmatter');
  const body = frontmatter.body
    .replaceAll('from the Chat tools picker', 'from Pi\'s MCP tool context')
    .replaceAll('the Chat tools picker', 'Pi\'s MCP tool context')
    .replaceAll('current workspace and SAP MCP server', 'current workspace and configured SAP MCP server');
  return renderDocument([
    { key: 'description', value: `Use the ${name} SAP agent persona. ${description}` },
    { key: 'argument-hint', value: '"[request]"' }
  ], `Act as **${name}** for the following request. Follow these agent instructions and use relevant installed SAP skills when helpful.

${body.trim()}

User request: $ARGUMENTS
`);
}

export const HARNESSES = [
  { id: 'github-copilot', label: 'GitHub Copilot', directory: '.copilot', supportsAgents: true, legacyManifest: true },
  { id: 'claude-code', label: 'Claude Code', directory: '.claude', supportsAgents: true, agentFileName: agentMarkdownName, agentDocument: claudeCodeAgentDocument },
  { id: 'codex', label: 'OpenAI Codex', directory: '.agents', supportsAgents: false },
  { id: 'cursor', label: 'Cursor', directory: '.cursor', supportsAgents: false },
  { id: 'gemini-cli', label: 'Gemini CLI', directory: '.gemini', supportsAgents: false },
  { id: 'opencode', label: 'opencode', directory: 'opencode', configHome: true, supportsAgents: true, agentFileName: agentMarkdownName, agentDocument: opencodeAgentDocument },
  { id: 'pi-coding-agent', label: 'Pi Coding Agent', directory: '.pi/agent', supportsAgents: true, agentTargetPrefix: 'prompts', agentFileName: agentMarkdownName, agentDocument: piCodingAgentPromptDocument, root: piCodingAgentRoot }
];

export function harnessById(id) {
  const harness = HARNESSES.find(entry => entry.id === id);
  if (!harness) {
    throw new Error(`Unknown harness id: ${id}. Valid harness ids: ${HARNESSES.map(entry => entry.id).join(', ')}.`);
  }
  return harness;
}

export function harnessRoot(harness, { home = process.env.HOME || homedir(), env = process.env } = {}) {
  if (harness.root) return harness.root({ home, env });
  if (harness.configHome) {
    const override = typeof env?.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
    return join(override || join(home, '.config'), harness.directory);
  }
  return join(home, harness.directory);
}

export function parseHarnessSelection(raw) {
  const tokens = [...new Set(String(raw).split(',').map(token => token.trim().toLowerCase()).filter(Boolean))];
  const known = new Set(HARNESSES.map(entry => entry.id));
  const unknown = tokens.filter(token => !known.has(token));
  if (unknown.length > 0) {
    throw new Error(`Unknown harness id${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Valid harness ids: ${[...known].join(', ')}.`);
  }
  return HARNESSES.filter(entry => tokens.includes(entry.id)).map(entry => entry.id);
}

export function envHarnessSelection(env = process.env) {
  const raw = env?.[HARNESS_ENV_VAR];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return parseHarnessSelection(raw);
}
