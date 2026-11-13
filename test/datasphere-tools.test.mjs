import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DATASPHERE_TOOL_NAMES, registerDatasphereTools } from '../src/datasphere-tools.mjs';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function fixture({ auth = 'technical', withSql = false, cliHandler, commandCatalog } = {}) {
  const registered = [];
  const server = { registerTool: (name, definition, handler) => {
    registered.push({ name, ...definition, handler: async args => handler(z.object(definition.inputSchema).parse(args ?? {})) });
  } };
  const runs = [];
  const restRequests = [];
  const defaultCli = async (words, options, runOptions) => {
    runs.push({ words, options, runOptions });
    if (words[0] === 'objects' && words[2] === 'list') return [];
    return { ok: true };
  };
  const rest = {
    request: async (method, path, options) => {
      restRequests.push({ method, path, options });
      if (path.endsWith('/catalog/spaces')) return { value: [{ name: 'SALES' }] };
      if (path.includes('/run/') || path.includes('/retry/')) return { logId: 4242 };
      if (path.includes('/relational/')) return { value: [{ Amount: 100 }], '@odata.count': 7, '@odata.nextLink': 'next' };
      if (path.includes('/analytical/')) return { value: [{ NetAmount: 90 }] };
      return { value: [] };
    }
  };
  const sqlStatements = [];
  const database = { query: async statement => { sqlStatements.push(statement); return [{ A: 1 }]; } };
  const summary = {
    tenant_host: 'tenant.example',
    token_host: 'auth.example',
    auth,
    source: 'environment',
    cli_package_version: '2026.22.0',
    sql: withSql ? { host: 'sql.example', user: 'DBUSER', schema: 'DBUSER' } : null,
    admin_commands_available: auth === 'interactive'
  };
  const commands = async () => commandCatalog ?? [
    { command: 'spaces list', method: 'get', access: 'read', technical_user_supported: false, parameters: [], confirm_required: false, has_body: false },
    { command: 'objects views list', method: 'get', access: 'read', technical_user_supported: true, parameters: [], confirm_required: false, has_body: false },
    { command: 'users read', method: 'get', access: 'read', technical_user_supported: false, parameters: [], confirm_required: false, has_body: false },
    { command: 'users delete', method: 'delete', access: 'delete', technical_user_supported: false, parameters: [], confirm_required: true, has_body: false },
    { command: 'spaces delete', method: 'delete', access: 'delete', technical_user_supported: true, parameters: [], confirm_required: true, has_body: false }
  ];
  const names = registerDatasphereTools(server, {
    rest,
    cli: { init: async () => {}, run: cliHandler ?? defaultCli, packageVersion: '2026.22.0' },
    sql: withSql ? { config: { user: 'DBUSER', host: 'sql.example', port: 443, password: 'sql-secret', schema: 'MYSCHEMA' }, connect: async () => database } : null,
    summary,
    verify: async () => ({ catalog: 'ok (1 spaces)' }),
    commands
  });
  return { registered, names, runs, restRequests, sqlStatements, byName: Object.fromEntries(registered.map(entry => [entry.name, entry])) };
}

const parse = result => JSON.parse(result.content[0].text);

test('tool names match DATASPHERE_TOOL_NAMES, with SQL tools only when SQL is configured', () => {
  const withoutSql = fixture();
  assert.deepEqual(withoutSql.names, DATASPHERE_TOOL_NAMES.filter(name => !name.startsWith('datasphere_sql_')));
  const withSql = fixture({ withSql: true });
  assert.deepEqual(withSql.names, DATASPHERE_TOOL_NAMES);
  assert.deepEqual(withSql.byName.datasphere_connection_info.annotations, READ_ONLY);
  assert.equal(withSql.byName.datasphere_run_command.annotations.readOnlyHint, false);
  assert.equal(withSql.byName.datasphere_build_local_table_csn.annotations.openWorldHint, false);
});

test('wrong confirmation on create returns isError and makes zero CLI calls', async () => {
  const f = fixture();
  const result = await f.byName.datasphere_create_object.handler({
    space: 'SALES', object_type: 'views', technical_name: 'V1', definition: { definitions: { V1: {} } }, confirmation: 'CREATE DATASPHERE views SALES.OTHER'
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /confirmation must equal CREATE DATASPHERE views SALES\.V1/);
  assert.equal(f.runs.length, 0);
});

test('create of an existing object is rejected with update guidance', async () => {
  const f = fixture({ cliHandler: async (words, options) => {
    f.runs.push({ words, options });
    if (words[0] === 'objects' && words[2] === 'list') return [{ technicalName: options['technical-names'], changedOn: '2026-01-01' }];
    return { ok: true };
  } });
  const result = await f.byName.datasphere_create_object.handler({
    space: 'SALES', object_type: 'views', technical_name: 'V1', definition: { definitions: { V1: {} } }, confirmation: 'CREATE DATASPHERE views SALES.V1'
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /V1 already exists in SALES; use datasphere_update_object/);
});

test('create and update reject missing or malformed named CSN definitions before contacting the tenant', async () => {
  for (const action of ['create', 'update']) {
    for (const type of ['local-tables', 'views', 'analytic-models']) {
      for (const definition of [{}, { definitions: { OTHER: {} } }, { definitions: { V1: null } }, { definitions: { V1: [] } }]) {
        const f = fixture();
        const result = await f.byName[`datasphere_${action}_object`].handler({
          space: 'SALES', object_type: type, technical_name: 'V1', definition,
          ...(action === 'update' ? { expected_changed_on: '2026-01-01' } : {}),
          confirmation: `${action.toUpperCase()} DATASPHERE ${type} SALES.V1`
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /definition\.definitions must contain V1/);
        assert.equal(f.runs.length, 0);
      }
    }
  }
});

test('create with deploy false passes --no-deploy and returns read_back', async () => {
  const f = fixture({ cliHandler: async (words, options, runOptions) => {
    f.runs.push({ words, options, runOptions });
    if (words[0] === 'objects' && words[2] === 'list') {
      return f.runs.filter(run => run.words[2] === 'create').length
        ? [{ technicalName: 'V1', status: 'Deployed', changedOn: '2026-02-02' }]
        : [];
    }
    return { created: true };
  } });
  const result = await f.byName.datasphere_create_object.handler({
    space: 'SALES', object_type: 'views', technical_name: 'V1', definition: { definitions: { V1: { kind: 'entity' } } }, deploy: false, confirmation: 'CREATE DATASPHERE views SALES.V1'
  });
  const payload = parse(result);
  assert.equal(payload.read_back.status, 'Deployed');
  const createRun = f.runs.find(run => run.words[2] === 'create');
  assert.deepEqual(createRun.options['no-deploy'], true);
  assert.deepEqual(createRun.runOptions.input, { definitions: { V1: { kind: 'entity' } } });
});

test('update with a stale expected_changed_on is rejected without updating', async () => {
  const f = fixture({ cliHandler: async (words, options) => {
    f.runs.push({ words, options });
    if (words[0] === 'objects' && words[2] === 'list') return [{ technicalName: 'V1', changedOn: '2026-05-05' }];
    return { ok: true };
  } });
  const result = await f.byName.datasphere_update_object.handler({
    space: 'SALES', object_type: 'views', technical_name: 'V1', definition: { definitions: { V1: {} } }, expected_changed_on: '2026-01-01', confirmation: 'UPDATE DATASPHERE views SALES.V1'
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /V1 changed since it was read \(changedOn 2026-05-05\); read it again before updating/);
  assert.equal(f.runs.some(run => run.words[2] === 'update'), false);
});

test('delete passes --force and its confirmation', async () => {
  const f = fixture({ cliHandler: async (words, options) => {
    f.runs.push({ words, options });
    if (words[0] === 'objects' && words[2] === 'list') return [{ technicalName: 'V1' }];
    return { deleted: true };
  } });
  const result = await f.byName.datasphere_delete_object.handler({
    space: 'SALES', object_type: 'views', technical_name: 'V1', confirmation: 'DELETE DATASPHERE views SALES.V1'
  });
  assert.equal(parse(result).deleted, true);
  const deleteRun = f.runs.find(run => run.words[2] === 'delete');
  assert.equal(deleteRun.options.force, true);
});

test('run/retry/cancel task chain hit the Tasks REST API with exact bodies', async () => {
  const f = fixture({ auth: 'interactive' });
  const run = parse(await f.byName.datasphere_run_task_chain.handler({
    space: 'SALES', task_chain: 'LOAD_ALL', input_parameters: { YEAR: '2026' }, confirmation: 'RUN DATASPHERE TASK CHAIN SALES.LOAD_ALL'
  }));
  assert.equal(run.logId, 4242);
  const request = f.restRequests.at(-1);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/v1/datasphere/tasks/chains/SALES/run/LOAD_ALL');
  assert.deepEqual(request.options.json, { inputParameters: { YEAR: '2026' } });

  parse(await f.byName.datasphere_retry_task_chain.handler({ space: 'SALES', task_chain: 'LOAD_ALL', confirmation: 'RETRY DATASPHERE TASK CHAIN SALES.LOAD_ALL' }));
  assert.equal(f.restRequests.at(-1).path, '/api/v1/datasphere/tasks/chains/SALES/retry/LOAD_ALL');

  const wrongCancel = await f.byName.datasphere_cancel_task_chain.handler({ space: 'SALES', log_id: 9, confirmation: 'CANCEL DATASPHERE TASK CHAIN RUN SALES.8' });
  assert.equal(wrongCancel.isError, true);
  parse(await f.byName.datasphere_cancel_task_chain.handler({ space: 'SALES', log_id: 9, confirmation: 'CANCEL DATASPHERE TASK CHAIN RUN SALES.9' }));
  assert.equal(f.restRequests.at(-1).path, '/api/v1/datasphere/tasks/chains/SALES/cancel/9');
});

test('get_task_log sends the Accept header for the chosen detail level', async () => {
  const f = fixture();
  await f.byName.datasphere_get_task_log.handler({ space: 'SALES', log_id: 5, detail: 'extended' });
  const request = f.restRequests.at(-1);
  assert.equal(request.path, '/api/v1/datasphere/tasks/logs/SALES/5');
  assert.equal(request.options.accept, 'application/vnd.sap.datasphere.task.log.details.extended+json');
  await f.byName.datasphere_get_task_log.handler({ space: 'SALES', log_id: 5 });
  assert.equal(f.restRequests.at(-1).options.accept, 'application/vnd.sap.datasphere.task.log.details+json');
});

test('query_relational maps parameters to the (k=v)/Set segment', async () => {
  const f = fixture();
  const payload = parse(await f.byName.datasphere_query_relational.handler({ space: 'SALES', asset: 'Sales_View', parameters: { Region: 'US' }, top: 50 }));
  assert.deepEqual(payload, { rows: [{ Amount: 100 }], count: 7, more: true });
  const request = f.restRequests.at(-1);
  assert.equal(request.path, '/api/v1/datasphere/consumption/relational/SALES/Sales_View/Sales_View(Region=\'US\')/Set');
  assert.equal(request.options.query.$top, 50);
});

test('reconcile handles relational row counts and analytical measure mismatches', async () => {
  const f = fixture();
  const relational = parse(await f.byName.datasphere_reconcile.handler({ space: 'SALES', asset: 'Sales_View', kind: 'relational', expected_row_count: 7 }));
  assert.equal(relational.all_within_tolerance, true);
  assert.deepEqual(relational.checks, [{ metric: 'row_count', expected: 7, actual: 7, difference: 0, within_tolerance: true }]);

  const mismatch = parse(await f.byName.datasphere_reconcile.handler({ space: 'SALES', asset: 'AM', kind: 'analytical', measures: [{ name: 'NetAmount', expected: 100 }] }));
  assert.equal(mismatch.all_within_tolerance, false);
  assert.equal(mismatch.checks[0].difference, -10);

  const measuresOnRelational = await f.byName.datasphere_reconcile.handler({ space: 'SALES', asset: 'Sales_View', kind: 'relational', measures: [{ name: 'X', expected: 1 }] });
  assert.equal(measuresOnRelational.isError, true);
  assert.match(measuresOnRelational.content[0].text, /Measure totals need kind analytical/);

  const rowsOnAnalytical = await f.byName.datasphere_reconcile.handler({ space: 'SALES', asset: 'AM', kind: 'analytical', expected_row_count: 5 });
  assert.equal(rowsOnAnalytical.isError, true);
  assert.match(rowsOnAnalytical.content[0].text, /Row counts are not supported for analytical requests/);
});

test('run_read_command rejects changing commands; run_command enforces confirmations and --force', async () => {
  const f = fixture({ auth: 'interactive' });
  const changing = await f.byName.datasphere_run_read_command.handler({ command: 'users delete' });
  assert.equal(changing.isError, true);
  assert.match(changing.content[0].text, /users delete changes the tenant; use datasphere_run_command/);

  const wrong = await f.byName.datasphere_run_command.handler({ command: 'users delete', options: { name: 'x' }, confirmation: 'RUN DATASPHERE users delete' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /confirmation must equal DELETE DATASPHERE users delete/);

  const ok = await f.byName.datasphere_run_command.handler({ command: 'users delete', options: { name: 'x' }, confirmation: 'DELETE DATASPHERE users delete' });
  assert.equal(ok.isError, undefined);
  const run = f.runs.at(-1);
  assert.equal(run.options.force, true, 'x-user-to-confirm adds --force');
  assert.equal(run.options.name, 'x');

  const reserved = await f.byName.datasphere_run_read_command.handler({ command: 'spaces list', options: { 'secrets-file': '/etc/passwd' } });
  assert.equal(reserved.isError, true);
  assert.match(reserved.content[0].text, /Option --secrets-file is managed by the toolkit/);
});

test('technical auth blocks commands outside the technical-user whitelist', async () => {
  const f = fixture({ auth: 'technical' });
  const result = await f.byName.datasphere_run_read_command.handler({ command: 'users read' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /users read needs an Interactive Usage OAuth client; rerun sap-ai-dev --setup-datasphere and choose "Your user"/);
});

test('CLI results with password fields come back redacted', async () => {
  const f = fixture({ cliHandler: async () => [{ name: 'DBU', password: 'x', host: 'h' }] });
  const result = await f.byName.datasphere_run_read_command.handler({ command: 'objects views list' });
  const payload = parse(result);
  assert.equal(payload[0].password, '[redacted]');
  assert.equal(payload[0].host, 'h');
});

test('sql_query only wraps single SELECT statements with LIMIT max_rows+1', async () => {
  const f = fixture({ withSql: true });
  const deleted = await f.byName.datasphere_sql_query.handler({ sql: 'DELETE FROM T', max_rows: 10 });
  assert.equal(deleted.isError, true);
  assert.match(deleted.content[0].text, /Only SELECT statements are allowed here; use datasphere_sql_execute/);

  parse(await f.byName.datasphere_sql_query.handler({ sql: 'SELECT * FROM T', max_rows: 100 }));
  assert.equal(f.sqlStatements.at(-1), 'SELECT * FROM (SELECT * FROM T) AS Q LIMIT 101');
});

test('sql_execute demands the exact per-user confirmation', async () => {
  const f = fixture({ withSql: true });
  const wrong = await f.byName.datasphere_sql_execute.handler({ sql: 'DROP TABLE T', confirmation: 'EXECUTE DATASPHERE SQL AS someone' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /confirmation must equal EXECUTE DATASPHERE SQL AS DBUSER/);
  const ok = parse(await f.byName.datasphere_sql_execute.handler({ sql: 'DROP TABLE T', confirmation: 'EXECUTE DATASPHERE SQL AS DBUSER' }));
  assert.deepEqual(ok, { rows: [{ A: 1 }], truncated: false });
});

test('build_local_table_csn maps BW field lists to CSN', async () => {
  const f = fixture();
  const payload = parse(await f.byName.datasphere_build_local_table_csn.handler({
    technical_name: 'ZAMOUNT_TBL',
    business_name: 'Amounts',
    fields: [
      { name: '/BIC/ZAMOUNT', ddic_type: 'CURR', length: 17, decimals: 2 },
      { name: '0CALDAY', ddic_type: 'DATS', key: true },
      { name: 'ZCNT', ddic_type: 'NUMC', length: 10 }
    ]
  }));
  const elements = payload.definitions.ZAMOUNT_TBL.elements;
  assert.deepEqual({ type: elements.ZAMOUNT.type, precision: elements.ZAMOUNT.precision, scale: elements.ZAMOUNT.scale }, { type: 'cds.Decimal', precision: 17, scale: 2 });
  assert.deepEqual({ type: elements['0CALDAY'].type, key: elements['0CALDAY'].key, notNull: elements['0CALDAY'].notNull }, { type: 'cds.Date', key: true, notNull: true });
  assert.equal(elements.ZCNT.type, 'cds.String');
  assert.equal(elements.ZCNT.length, 10);

  const unsupported = await f.byName.datasphere_build_local_table_csn.handler({
    technical_name: 'X', business_name: 'X', fields: [{ name: 'A', ddic_type: 'DF16_DEC', length: 5 }]
  });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0].text, /Unsupported DDIC type DF16_DEC for A/);
});

test('replication flow status needs no confirmation but state changes do', async () => {
  const f = fixture();
  parse(await f.byName.datasphere_replication_flow.handler({ space: 'SALES', technical_name: 'RF1', action: 'status' }));
  assert.deepEqual(f.runs.at(-1).words, ['tasks', 'replication-flows', 'status']);

  const unconfirmed = await f.byName.datasphere_replication_flow.handler({ space: 'SALES', technical_name: 'RF1', action: 'run' });
  assert.equal(unconfirmed.isError, true);
  parse(await f.byName.datasphere_replication_flow.handler({ space: 'SALES', technical_name: 'RF1', action: 'run', confirmation: 'RUN DATASPHERE REPLICATION FLOW SALES.RF1' }));
  assert.deepEqual(f.runs.at(-1).words, ['tasks', 'replication-flows', 'run']);

  const objectMissing = await f.byName.datasphere_replication_flow.handler({ space: 'SALES', technical_name: 'RF1', action: 'pause-object', confirmation: 'PAUSE-OBJECT DATASPHERE REPLICATION FLOW SALES.RF1' });
  assert.equal(objectMissing.isError, true);
  assert.match(objectMissing.content[0].text, /pause-object needs object/);
});

test('list_commands annotates usability for the current auth mode', async () => {
  const technical = fixture({ auth: 'technical' });
  const payload = parse(await technical.byName.datasphere_list_commands.handler({ prefix: 'users' }));
  assert.deepEqual(payload.map(entry => [entry.command, entry.usable_with_current_auth]), [['users read', false], ['users delete', false]]);
  const interactive = fixture({ auth: 'interactive' });
  const all = parse(await interactive.byName.datasphere_list_commands.handler({}));
  assert.ok(all.every(entry => entry.usable_with_current_auth === true));
});

test('the full tenant command list fits the result limit, with parameters available for a filtered command', async () => {
  const commandCatalog = Array.from({ length: 223 }, (_, index) => ({
    command: `objects type${index} list`, access: 'read', technical_user_supported: true,
    parameters: Array.from({ length: 12 }, (_, parameter) => ({ name: `parameter${parameter}`, in: 'query', required: false, option: `--parameter${parameter}` }))
  }));
  const f = fixture({ commandCatalog });
  const result = await f.byName.datasphere_list_commands.handler({});
  assert.notEqual(result.isError, true);
  const commands = parse(result);
  assert.equal(commands.length, 223);
  assert.ok(commands.every(entry => !Object.hasOwn(entry, 'parameters')));
  const detailed = parse(await f.byName.datasphere_list_commands.handler({ prefix: 'objects type0 list', include_parameters: true }));
  assert.equal(detailed.length, 1);
  assert.deepEqual(detailed[0].parameters, commandCatalog[0].parameters);
});
