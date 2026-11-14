// Prints a short, readable tour of MCP tool calls for terminal recordings.
// node docs/gifs/source/mcp-tour.mjs live   (checkout launcher, SAP_* env of a local SAP GUI destination)
// node docs/gifs/source/mcp-tour.mjs demo   (offline playground, no SAP system)
import { fileURLToPath } from 'node:url';
import { mcpServer } from './lib.mjs';

const launcher = fileURLToPath(new URL('../../../src/launcher.mjs', import.meta.url));
const mode = process.argv[2] || 'demo';
const pause = Number(process.env.TOUR_PAUSE_MS || 1800);
const c = { cyan: s => `\x1b[36m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` };

const tours = {
  live: [
    ['get_system_info', {}],
    ['search_object', { query: 'CL_ABAP_TYPEDESCR' }],
    ['get_source', { object_type: 'CLAS', name: 'CL_ABAP_CHAR_UTILITIES' }],
    ['run_query', { sql_query: 'SELECT MANDT, MTEXT, ORT01, CCCATEGORY FROM T000', max_rows: 10 }],
    ['lint_abap', { files: [{ filename: 'zdemo.prog.abap', source: "REPORT zdemo.\nDATA lv_text TYPE string.\nWRITE / lv_text." }] }]
  ],
  demo: [
    ['search_object', { query: 'ZCL_DEMO_ORDER' }],
    ['get_source', { object_type: 'CLAS', name: 'ZCL_DEMO_ORDER' }],
    ['run_unit_tests', { object_name: 'ZCL_DEMO_ORDER' }],
    ['run_atc_check', { object_name: 'ZCL_DEMO_ORDER' }]
  ]
};

const server = mode === 'live'
  ? mcpServer(process.execPath, [launcher], { SAP_AI_DEV_TOOLKIT_DESTINATION_SOURCE: 'sap-gui-local', SAP_AI_DEV_TOOLKIT_DESTINATION: process.env.SAP_AI_DEV_TOOLKIT_DESTINATION || 'SSA', SAP_AUTH_MODE: 'basic' })
  : mcpServer(process.execPath, [launcher, '--demo'], {});
await server.init();
const { result } = await server.request('tools/list', {});
console.log(c.bold(`${mode === 'live' ? 'Live SAP system' : 'Offline playground'}: ${result.tools.length} MCP tools`));
console.log(c.dim(result.tools.slice(0, 12).map(t => t.name).join('  ')) + c.dim('  …\n'));
await new Promise(r => setTimeout(r, pause));

function summarize(text) {
  let shown = text;
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value?.Columns) && Array.isArray(value?.Rows)) {
      const names = value.Columns.map(col => col.Name);
      const rows = value.Rows.map(row => names.map(n => String(row[n] ?? '')));
      const widths = names.map((n, i) => Math.max(n.length, ...rows.map(r => r[i].length)));
      const fmt = cells => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
      shown = [c.bold(fmt(names)), ...rows.map(fmt)].join('\n');
    } else if (Array.isArray(value?.issues)) {
      shown = [`${value.filesChecked} file(s), ${value.issueCount} issue(s)`, ...value.issues.map(i => `${i.severity.padEnd(7)} ${i.rule.padEnd(28)} ${i.message}`)].join('\n');
    } else {
      shown = JSON.stringify(value, null, 2);
    }
  } catch {}
  const lines = shown.split('\n').filter(line => line.trim());
  return lines.slice(0, 12).map(line => (line.length > 110 ? `${line.slice(0, 107)}...` : line)).join('\n') + (lines.length > 12 ? c.dim(`\n… ${lines.length - 12} more lines`) : '');
}

for (const [name, args] of tours[mode]) {
  const shownArgs = name === 'lint_abap' ? '{ files: [zdemo.prog.abap] }' : JSON.stringify(args);
  console.log(`${c.cyan('→')} ${c.bold(name)} ${c.dim(shownArgs)}`);
  const started = Date.now();
  const out = await server.call(name, args);
  console.log(summarize(out.text));
  console.log(c.green(`✔ ${Date.now() - started} ms${out.isError ? ' (tool error)' : ''}\n`));
  await new Promise(r => setTimeout(r, pause));
}
server.close();
process.exit(0);
