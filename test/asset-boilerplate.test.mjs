import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const agentsRoot = join(root, '.github', 'agents');
const skillsRoot = join(root, '.github', 'skills');

// Canonical shared boilerplate. Every bundled agent and skill is installed as a
// standalone file, so these paragraphs are duplicated verbatim; this test keeps
// the copies byte-identical instead of letting them drift apart.
const TOOL_NAMING_RULE = 'Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.';
const DIRECT_MCP_ABAP = 'Do not launch `sap-ai-dev` or another server binary, drive stdio/JSON-RPC from a terminal, or handcraft a JSON-RPC handshake for MCP operations. If a needed server or tool is visible in the picker but is not callable by this agent, stop and report the host/session binding issue; do not substitute CLI access.';
const DIRECT_MCP_HANA = 'Do not launch `sap-ai-dev` or `sap-ai-hana` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue.';

const hanaAgent = 'hana-cloud-hdi-specialist.agent.md';
const hanaSkills = new Set(['hana-cloud-inspection', 'hana-cloud-native-development', 'hana-cloud-validation']);

async function assetEntries() {
  const entries = [];
  for (const entry of await readdir(agentsRoot)) {
    if (entry.endsWith('.agent.md')) entries.push([join(agentsRoot, entry), entry]);
  }
  for (const entry of await readdir(skillsRoot)) {
    entries.push([join(skillsRoot, entry, 'SKILL.md'), entry]);
  }
  return entries;
}

test('shared boilerplate paragraphs stay byte-identical across agents and skills', async () => {
  const drift = [];
  for (const [path, label] of await assetEntries()) {
    const markdown = await readFile(path, 'utf8');
    const where = relative(root, path);
    const isAgent = label.endsWith('.agent.md');
    const isHana = label === hanaAgent || hanaSkills.has(label);
    if (!markdown.includes(TOOL_NAMING_RULE)) drift.push(`${where}: tool-naming paragraph drifted from the canonical text`);
    if (isAgent && !isHana && !markdown.includes(DIRECT_MCP_ABAP)) drift.push(`${where}: ABAP direct-MCP paragraph drifted from the canonical text`);
    if (isHana && !markdown.includes(DIRECT_MCP_HANA)) drift.push(`${where}: HANA direct-MCP sentence drifted from the canonical text`);
    if (!isAgent && !isHana && (markdown.includes(DIRECT_MCP_ABAP) || markdown.includes(DIRECT_MCP_HANA))) {
      drift.push(`${where}: ABAP skill carries a direct-MCP paragraph; only agents and HANA skills should`);
    }
  }
  assert.deepEqual(drift, [], 'update every copy of the shared paragraphs or adjust the canonical text in this test');
});
