// MCP tools for SAP Datasphere: typed tools for the frequent flows (consumption
// queries, object lifecycle, task chains, replication flows, Data Marketplace,
// Open SQL) plus discovery-driven generic tools covering every other CLI command.
// Every write checks an exact confirmation string before any tenant call, and
// every result passes through secret redaction.
import { z } from 'zod';
import {
  CREATE_ANNOTATIONS,
  OVERWRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  capText,
  confirmation,
  key,
  redactSecrets,
  requireConfirmation,
  resultOf
} from './integration-common.mjs';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { buildLocalTableCsn } from './datasphere-csn.mjs';

const CONSUMPTION = '/api/v1/datasphere/consumption';
const TASKS = '/api/v1/datasphere/tasks';
const DEFINITION_MAX_BYTES = 5 * 1024 * 1024;
const DATA_PRODUCT_MAX_BYTES = 1024 * 1024;
const SQL_QUERY_MAX = 20_000;
const SQL_EXECUTE_MAX = 100_000;
const SQL_QUERY_TIMEOUT_MS = 300_000;

const space = z.string().regex(/^[A-Z0-9_]{1,20}$/, 'Datasphere space IDs are 1-20 uppercase letters, digits or underscores');
const technicalName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.]{0,99}$/, 'Technical names start with a letter, digit or underscore');
const OBJECT_TYPES = ['remote-tables', 'local-tables', 'views', 'intelligent-lookups', 'er-models', 'types', 'contexts', 'data-flows', 'replication-flows', 'transformation-flows', 'task-chains', 'analytic-models', 'business-entities', 'fact-models', 'consumption-models', 'data-access-controls', 'packages'];
const WRITABLE_OBJECT_TYPES = OBJECT_TYPES.filter(type => type !== 'types' && type !== 'contexts');
const CSN_DEFINITION_TYPES = ['local-tables', 'views', 'analytic-models'];
const uuid = z.string().uuid();
const objectType = z.enum(OBJECT_TYPES);
const writableObjectType = z.enum(WRITABLE_OBJECT_TYPES);
const assetParameters = z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string().max(500)).optional();

const ACCEPT_BY_VERSION = {
  'design-time': 'application/vnd.sap.datasphere.object.content.design-time+json',
  'run-time': 'application/vnd.sap.datasphere.object.content.run-time+json',
  complete: 'application/vnd.sap.datasphere.object.content+json'
};

const TASK_LOG_ACCEPT = {
  status: 'application/vnd.sap.datasphere.task.log.status.object+json',
  details: 'application/vnd.sap.datasphere.task.log.details+json',
  extended: 'application/vnd.sap.datasphere.task.log.details.extended+json'
};

export const DATASPHERE_TOOL_NAMES = Object.freeze([
  'datasphere_connection_info',
  'datasphere_list_spaces',
  'datasphere_list_assets',
  'datasphere_get_asset_metadata',
  'datasphere_query_relational',
  'datasphere_query_analytical',
  'datasphere_reconcile',
  'datasphere_list_objects',
  'datasphere_read_object',
  'datasphere_create_object',
  'datasphere_update_object',
  'datasphere_delete_object',
  'datasphere_export_package',
  'datasphere_list_connections',
  'datasphere_validate_connection',
  'datasphere_list_task_logs',
  'datasphere_get_task_log',
  'datasphere_run_task_chain',
  'datasphere_retry_task_chain',
  'datasphere_cancel_task_chain',
  'datasphere_replication_flow',
  'datasphere_list_data_providers',
  'datasphere_list_data_products',
  'datasphere_read_data_product',
  'datasphere_create_data_product',
  'datasphere_set_data_product_status',
  'datasphere_install_data_product',
  'datasphere_build_local_table_csn',
  'datasphere_list_commands',
  'datasphere_describe_command',
  'datasphere_run_read_command',
  'datasphere_run_command',
  'datasphere_sql_query',
  'datasphere_sql_execute'
]);

const GENERIC_COMMAND = /^[a-z0-9-]+(?: [a-z0-9-]+)*$/;
const GENERIC_OPTION_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_OPTIONS = new Set([
  'host', 'secrets-file', 'options-file', 'client-id', 'client-secret', 'access-token', 'refresh-token',
  'passcode', 'code', 'authorization-url', 'token-url', 'authorization-flow', 'browser', 'expires-in',
  'output', 'file-path', 'input', 'login-id', 'verbose'
]);

/** Register all Datasphere tools; SQL tools only when `sql` is configured. */
export function registerDatasphereTools(server, { rest, cli, sql, summary, verify, commands } = {}) {
  const registeredNames = [];
  const auth = summary?.auth ?? 'technical';
  const register = (name, title, description, inputSchema, annotations, handler) => {
    registeredNames.push(name);
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(
      async () => redactSecrets(await handler(args)),
      { product: 'SAP Datasphere', fallback: "SAP Datasphere request failed. Check the client's roles and tenant reachability." }
    ));
  };

  const runCli = async (words, options, runOptions) => {
    await cli.init().catch(() => {});
    return cli.run(words, options, runOptions);
  };

  const catalog = async () => {
    const entries = await commands();
    return entries;
  };

  const objectRows = result => {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.value)) return result.value;
    if (Array.isArray(result?.objects)) return result.objects;
    return [];
  };

  const listObjectRows = async (objectSpace, objectTypeRequested, names) => {
    const options = {
      space: objectSpace,
      select: 'technicalName,businessName,type,semanticUsage,status,deployedOn,changedOn'
    };
    if (names?.length) options['technical-names'] = names.join(',');
    const result = await runCli(['objects', objectTypeRequested, 'list'], options);
    return objectRows(result);
  };

  const checkDefinition = (definition, type, name, limit, limitText) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new IntegrationError('definition must be a JSON object');
    }
    const bytes = Buffer.byteLength(JSON.stringify(definition), 'utf8');
    if (bytes > limit) throw new IntegrationError(limitText);
    const content = definition.definitions?.[name];
    if (CSN_DEFINITION_TYPES.includes(type) && (!Object.hasOwn(definition.definitions || {}, name) || !content || typeof content !== 'object' || Array.isArray(content))) {
      throw new IntegrationError(`definition.definitions must contain ${name}`);
    }
  };

  // ------------------------------------------------------------ connection

  register('datasphere_connection_info', 'Datasphere connection info',
    'Report the connected tenant, auth mode, credential source, CLI package version and Open SQL configuration. Verification is read-only and never returns credentials.',
    { verify: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ verify: online }) => {
      const verification = online && verify ? await verify() : undefined;
      return { ...summary, ...(verification ? { verification } : {}) };
    });

  // ------------------------------------------------------------ consumption API

  register('datasphere_list_spaces', 'List Datasphere spaces',
    'List the spaces visible to the OAuth client through the Consumption catalog API.',
    {}, READ_ONLY_ANNOTATIONS,
    async () => (await rest.request('GET', `${CONSUMPTION}/catalog/spaces`))?.value ?? []);

  register('datasphere_list_assets', 'List consumption assets',
    'List assets exposed for consumption: all visible assets, or the assets of one space.',
    { space: space.optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ space: assetSpace }) => (await rest.request('GET', assetSpace
      ? `${CONSUMPTION}/catalog/spaces(${key(assetSpace)})/assets`
      : `${CONSUMPTION}/catalog/assets`))?.value ?? []);

  register('datasphere_get_asset_metadata', 'Get asset metadata',
    'Fetch the $metadata document of a relational or analytical asset (XML, capped at 64 KiB).',
    {
      space,
      asset: z.string().min(1).max(200),
      kind: z.enum(['relational', 'analytical'])
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: assetSpace, asset, kind }) => {
      const text = await rest.request('GET', `${CONSUMPTION}/${kind}/${encodeURIComponent(assetSpace)}/${encodeURIComponent(asset)}/$metadata`, {
        accept: 'application/xml',
        responseType: 'text'
      });
      return { space: assetSpace, asset, kind, metadata: capText(String(text ?? ''), 64 * 1024) };
    });

  const consumptionPath = (kind, assetSpace, asset, parameters) => {
    const segment = parameters && Object.keys(parameters).length
      ? `${asset}(${Object.entries(parameters).map(([name, value]) => `${name}=${odataKey(value)}`).join(',')})/Set`
      : asset;
    return `${CONSUMPTION}/${kind}/${encodeURIComponent(assetSpace)}/${encodeURIComponent(asset)}/${segment}`;
  };

  register('datasphere_query_relational', 'Query a relational asset',
    'Read rows of a relational asset exposed for consumption (SELECT-style projection, filter, ordering, paging, count).',
    {
      space,
      asset: z.string().min(1).max(200),
      parameters: assetParameters,
      select: z.array(z.string().min(1).max(200)).max(50).optional(),
      filter: z.string().max(2000).optional(),
      orderby: z.string().max(500).optional(),
      top: z.number().int().min(1).max(200).default(100),
      skip: z.number().int().min(0).max(100_000).default(0),
      count: z.boolean().default(false)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: assetSpace, asset, parameters, select, filter, orderby, top, skip, count }) => {
      const payload = await rest.request('GET', consumptionPath('relational', assetSpace, asset, parameters), {
        query: {
          ...(select?.length ? { $select: select.join(',') } : {}),
          ...(filter ? { $filter: filter } : {}),
          ...(orderby ? { $orderby: orderby } : {}),
          $top: top,
          $skip: skip,
          ...(count ? { $count: 'true' } : {})
        }
      });
      return {
        rows: payload?.value ?? [],
        count: payload?.['@odata.count'],
        more: Boolean(payload?.['@odata.nextLink'])
      };
    });

  register('datasphere_query_analytical', 'Query an analytical asset',
    'Read aggregated data from an analytic model exposed for consumption; $select lists the requested measures and dimensions.',
    {
      space,
      asset: z.string().min(1).max(200),
      parameters: assetParameters,
      select: z.array(z.string().min(1).max(200)).min(1).max(50),
      filter: z.string().max(2000).optional(),
      orderby: z.string().max(500).optional(),
      top: z.number().int().min(1).max(200).default(200)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: assetSpace, asset, parameters, select, filter, orderby, top }) => {
      const payload = await rest.request('GET', consumptionPath('analytical', assetSpace, asset, parameters), {
        query: {
          $select: select.join(','),
          ...(filter ? { $filter: filter } : {}),
          ...(orderby ? { $orderby: orderby } : {}),
          $top: top
        }
      });
      return { rows: payload?.value ?? [], more: Boolean(payload?.['@odata.nextLink']) };
    });

  register('datasphere_reconcile', 'Reconcile asset data against expected figures',
    'Compare a Datasphere asset against expected numbers: row count for relational assets, measure totals for analytic models, each with a tolerance.',
    {
      space,
      asset: z.string().min(1).max(200),
      kind: z.enum(['relational', 'analytical']),
      parameters: assetParameters,
      expected_row_count: z.number().int().min(0).optional(),
      measures: z.array(z.object({ name: z.string().min(1).max(200), expected: z.number() })).max(20).default([]),
      filter: z.string().max(2000).optional(),
      tolerance: z.number().min(0).default(0)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: assetSpace, asset, kind, parameters, expected_row_count: expectedRowCount, measures, filter, tolerance }) => {
      const checks = [];
      if (kind === 'relational') {
        if (measures.length) throw new IntegrationError('Measure totals need kind analytical (an analytic model)');
        if (expectedRowCount !== undefined) {
          const payload = await rest.request('GET', consumptionPath('relational', assetSpace, asset, parameters), {
            query: { $count: 'true', $top: 1, ...(filter ? { $filter: filter } : {}) }
          });
          const actual = payload?.['@odata.count'];
          const difference = Number.isFinite(actual) ? actual - expectedRowCount : null;
          checks.push({
            metric: 'row_count',
            expected: expectedRowCount,
            actual: actual ?? null,
            difference,
            within_tolerance: difference !== null && Math.abs(difference) <= tolerance
          });
        }
      } else {
        if (expectedRowCount !== undefined) throw new IntegrationError('Row counts are not supported for analytical requests');
        if (measures.length) {
          const payload = await rest.request('GET', consumptionPath('analytical', assetSpace, asset, parameters), {
            query: { $select: measures.map(measure => measure.name).join(','), $top: 1, ...(filter ? { $filter: filter } : {}) }
          });
          const first = payload?.value?.[0] ?? {};
          for (const measure of measures) {
            const raw = first[measure.name];
            const actual = Number(raw);
            const usable = raw !== undefined && raw !== null && Number.isFinite(actual);
            const difference = usable ? actual - measure.expected : null;
            checks.push({
              metric: measure.name,
              expected: measure.expected,
              actual: usable ? actual : null,
              difference,
              within_tolerance: difference !== null && Math.abs(difference) <= tolerance
            });
          }
        }
      }
      return {
        space: assetSpace,
        asset,
        kind,
        filter: filter ?? null,
        checks,
        all_within_tolerance: checks.every(check => check.within_tolerance)
      };
    });

  // ------------------------------------------------------------ objects (CLI)

  register('datasphere_list_objects', 'List Datasphere objects',
    'List objects of one type in a space through the Datasphere CLI (technical/business name, type, semantic usage, status, deployment and change dates).',
    {
      space,
      object_type: objectType,
      technical_names: z.array(technicalName).max(50).optional(),
      filter: z.string().max(1000).optional(),
      top: z.number().int().min(1).max(200).default(25),
      skip: z.number().int().min(0).max(100_000).default(0)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: objectSpace, object_type: type, technical_names: names, filter, top, skip }) => runCli(['objects', type, 'list'], {
      space: objectSpace,
      select: 'technicalName,businessName,type,semanticUsage,status,deployedOn,changedOn',
      top,
      skip,
      ...(names?.length ? { 'technical-names': names.join(',') } : {}),
      ...(filter ? { filter } : {})
    }));

  register('datasphere_read_object', 'Read a Datasphere object',
    'Read one object of a space through the Datasphere CLI: design-time definition, run-time state, or the complete object.',
    {
      space,
      object_type: objectType,
      technical_name: technicalName,
      version: z.enum(['design-time', 'run-time', 'complete']).default('design-time')
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: objectSpace, object_type: type, technical_name: name, version }) => runCli(
      ['objects', type, 'read'],
      { space: objectSpace, 'technical-name': name, accept: ACCEPT_BY_VERSION[version] }
    ));

  register('datasphere_create_object', 'Create a Datasphere object',
    `Create an object from a CSN definition through the Datasphere CLI and read it back. Requires confirmation "CREATE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>".`,
    {
      space,
      object_type: writableObjectType,
      technical_name: technicalName,
      definition: z.record(z.string(), z.unknown()),
      deploy: z.boolean().default(true),
      save_anyway: z.boolean().default(false),
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ space: objectSpace, object_type: type, technical_name: name, definition, deploy, save_anyway: saveAnyway, confirmation: given }) => {
      requireConfirmation(given, `CREATE DATASPHERE ${type} ${objectSpace}.${name}`);
      checkDefinition(definition, type, name, DEFINITION_MAX_BYTES, 'Definition is larger than 5 MiB');
      const existing = await listObjectRows(objectSpace, type, [name]);
      if (existing.length) throw new IntegrationError(`${name} already exists in ${objectSpace}; use datasphere_update_object`);
      const cliOutput = await runCli(['objects', type, 'create'], {
        space: objectSpace,
        'technical-name': name,
        ...(deploy ? {} : { 'no-deploy': true }),
        ...(saveAnyway ? { 'save-anyway': true } : {})
      }, { input: definition });
      const readBack = (await listObjectRows(objectSpace, type, [name]))[0] ?? null;
      return { cli_output: cliOutput, read_back: readBack };
    });

  register('datasphere_update_object', 'Update a Datasphere object',
    `Update an existing object from a CSN definition, guarded by expected_changed_on. Requires confirmation "UPDATE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>".`,
    {
      space,
      object_type: writableObjectType,
      technical_name: technicalName,
      definition: z.record(z.string(), z.unknown()),
      expected_changed_on: z.string().min(1).max(60),
      deploy: z.boolean().default(true),
      save_anyway: z.boolean().default(false),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ space: objectSpace, object_type: type, technical_name: name, definition, expected_changed_on: expectedChangedOn, deploy, save_anyway: saveAnyway, confirmation: given }) => {
      requireConfirmation(given, `UPDATE DATASPHERE ${type} ${objectSpace}.${name}`);
      checkDefinition(definition, type, name, DEFINITION_MAX_BYTES, 'Definition is larger than 5 MiB');
      const rows = await listObjectRows(objectSpace, type, [name]);
      if (!rows.length) throw new IntegrationError(`${name} not found in ${objectSpace}; use datasphere_create_object`);
      const changedOn = rows[0]?.changedOn ?? null;
      if (changedOn !== expectedChangedOn) {
        throw new IntegrationError(`${name} changed since it was read (changedOn ${changedOn}); read it again before updating`);
      }
      const cliOutput = await runCli(['objects', type, 'update'], {
        space: objectSpace,
        'technical-name': name,
        ...(deploy ? {} : { 'no-deploy': true }),
        ...(saveAnyway ? { 'save-anyway': true } : {})
      }, { input: definition });
      const readBack = (await listObjectRows(objectSpace, type, [name]))[0] ?? null;
      return { cli_output: cliOutput, read_back: readBack };
    });

  register('datasphere_delete_object', 'Delete a Datasphere object',
    `Delete an object from a space through the Datasphere CLI. Requires confirmation "DELETE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>".`,
    {
      space,
      object_type: writableObjectType,
      technical_name: technicalName,
      delete_anyway: z.boolean().default(false),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ space: objectSpace, object_type: type, technical_name: name, delete_anyway: deleteAnyway, confirmation: given }) => {
      requireConfirmation(given, `DELETE DATASPHERE ${type} ${objectSpace}.${name}`);
      const rows = await listObjectRows(objectSpace, type, [name]);
      if (!rows.length) throw new IntegrationError(`${name} not found in ${objectSpace}`);
      return runCli(['objects', type, 'delete'], {
        space: objectSpace,
        'technical-name': name,
        force: true,
        ...(deleteAnyway ? { 'delete-anyway': true } : {})
      });
    });

  register('datasphere_export_package', 'Export a Datasphere package',
    `Export a package from a space through the Datasphere CLI. Requires confirmation "EXPORT DATASPHERE PACKAGE <SPACE>.<TECHNICAL_NAME>".`,
    {
      space,
      technical_name: technicalName,
      allow_overwrite: z.boolean().default(false),
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ space: objectSpace, technical_name: name, allow_overwrite: allowOverwrite, confirmation: given }) => {
      requireConfirmation(given, `EXPORT DATASPHERE PACKAGE ${objectSpace}.${name}`);
      return runCli(['objects', 'packages', 'export'], {
        space: objectSpace,
        'technical-name': name,
        ...(allowOverwrite ? { 'allow-overwrite': true } : {})
      });
    });

  // ------------------------------------------------------------ connections (CLI)

  register('datasphere_list_connections', 'List space connections',
    'List the connections of a space through the Datasphere CLI.',
    { space }, READ_ONLY_ANNOTATIONS,
    async ({ space: objectSpace }) => runCli(['spaces', 'connections', 'list'], { space: objectSpace }));

  register('datasphere_validate_connection', 'Validate a space connection',
    'Validate one connection of a space through the Datasphere CLI.',
    { space, name: z.string().min(1).max(200) }, READ_ONLY_ANNOTATIONS,
    async ({ space: objectSpace, name }) => runCli(['spaces', 'connections', 'validate'], { space: objectSpace, name }));

  // ------------------------------------------------------------ tasks (REST + CLI)

  register('datasphere_list_task_logs', 'List task logs',
    'List the task logs of one object (task chain, replication flow) in a space through the Tasks REST API.',
    {
      space,
      object_id: z.string().min(1).max(200),
      top: z.number().int().min(1).max(100).default(20)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: objectSpace, object_id: objectId, top }) => {
      const payload = await rest.request('GET', `${TASKS}/logs/${encodeURIComponent(objectSpace)}/objects/${encodeURIComponent(objectId)}`);
      const logs = Array.isArray(payload) ? payload : payload?.value ?? [];
      return { logs: logs.slice(0, top), total: logs.length };
    });

  register('datasphere_get_task_log', 'Get a task log',
    'Read one task log by id through the Tasks REST API; detail level status, details or extended.',
    {
      space,
      log_id: z.number().int().min(1),
      detail: z.enum(['status', 'details', 'extended']).default('details')
    },
    READ_ONLY_ANNOTATIONS,
    async ({ space: objectSpace, log_id: logId, detail }) => rest.request('GET', `${TASKS}/logs/${encodeURIComponent(objectSpace)}/${logId}`, {
      accept: TASK_LOG_ACCEPT[detail]
    }));

  register('datasphere_run_task_chain', 'Run a task chain',
    `Start a task chain run through the Tasks REST API and return its log id. Requires confirmation "RUN DATASPHERE TASK CHAIN <SPACE>.<TASK_CHAIN>".`,
    {
      space,
      task_chain: technicalName,
      input_parameters: z.record(z.string().min(1).max(200), z.string().max(1000)).optional(),
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ space: objectSpace, task_chain: taskChain, input_parameters: inputParameters, confirmation: given }) => {
      requireConfirmation(given, `RUN DATASPHERE TASK CHAIN ${objectSpace}.${taskChain}`);
      const payload = await rest.request('POST', `${TASKS}/chains/${encodeURIComponent(objectSpace)}/run/${encodeURIComponent(taskChain)}`, {
        ...(inputParameters ? { json: { inputParameters } } : {}),
        expect: [200, 201, 202]
      });
      return { logId: payload?.logId ?? payload?.log_id ?? payload?.d?.logId ?? null };
    });

  register('datasphere_retry_task_chain', 'Retry a task chain',
    `Retry the last failed run of a task chain. Requires confirmation "RETRY DATASPHERE TASK CHAIN <SPACE>.<TASK_CHAIN>".`,
    { space, task_chain: technicalName, confirmation },
    CREATE_ANNOTATIONS,
    async ({ space: objectSpace, task_chain: taskChain, confirmation: given }) => {
      requireConfirmation(given, `RETRY DATASPHERE TASK CHAIN ${objectSpace}.${taskChain}`);
      const payload = await rest.request('POST', `${TASKS}/chains/${encodeURIComponent(objectSpace)}/retry/${encodeURIComponent(taskChain)}`, {
        expect: [200, 201, 202]
      });
      return { logId: payload?.logId ?? payload?.log_id ?? payload?.d?.logId ?? null };
    });

  register('datasphere_cancel_task_chain', 'Cancel a task chain run',
    `Cancel one task chain run by log id. Requires confirmation "CANCEL DATASPHERE TASK CHAIN RUN <SPACE>.<LOG_ID>".`,
    { space, log_id: z.number().int().min(1), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ space: objectSpace, log_id: logId, confirmation: given }) => {
      requireConfirmation(given, `CANCEL DATASPHERE TASK CHAIN RUN ${objectSpace}.${logId}`);
      return rest.request('POST', `${TASKS}/chains/${encodeURIComponent(objectSpace)}/cancel/${logId}`, { expect: [200, 201, 202] });
    });

  register('datasphere_replication_flow', 'Control a replication flow',
    `Run, pause, resume, stop or inspect a replication flow, or pause/resume/restart a single object within it. State-changing actions require confirmation "<ACTION> DATASPHERE REPLICATION FLOW <SPACE>.<TECHNICAL_NAME>".`,
    {
      space,
      technical_name: technicalName,
      action: z.enum(['status', 'run', 'pause', 'resume', 'stop', 'pause-object', 'resume-object', 'restart-object']),
      object: z.string().min(1).max(200).optional(),
      no_cleanup: z.boolean().default(false),
      confirmation: confirmation.optional()
    },
    OVERWRITE_ANNOTATIONS,
    async ({ space: objectSpace, technical_name: name, action, object: flowObject, no_cleanup: noCleanup, confirmation: given }) => {
      if (action !== 'status') {
        requireConfirmation(given, `${action.toUpperCase()} DATASPHERE REPLICATION FLOW ${objectSpace}.${name}`);
      }
      if (action.endsWith('-object') && !flowObject) throw new IntegrationError(`${action} needs object`);
      if (noCleanup && action !== 'stop') throw new IntegrationError('no_cleanup is only valid with action stop');
      return runCli(['tasks', 'replication-flows', action], {
        space: objectSpace,
        'technical-name': name,
        ...(flowObject ? { object: flowObject } : {}),
        ...(noCleanup ? { 'no-cleanup': true } : {})
      });
    });

  // ------------------------------------------------------------ Data Marketplace (CLI)

  register('datasphere_list_data_providers', 'List Data Marketplace providers',
    'List the Data Marketplace providers visible to the tenant through the Datasphere CLI.',
    {}, READ_ONLY_ANNOTATIONS,
    async () => runCli(['marketplace', 'providers', 'list']));

  register('datasphere_list_data_products', 'List Data Marketplace products',
    'List Data Marketplace products through the Datasphere CLI.',
    {}, READ_ONLY_ANNOTATIONS,
    async () => runCli(['marketplace', 'products', 'list']));

  register('datasphere_read_data_product', 'Read a Data Marketplace product',
    'Read one Data Marketplace product definition by uuid (a template for datasphere_create_data_product).',
    { data_product_uuid: uuid }, READ_ONLY_ANNOTATIONS,
    async ({ data_product_uuid: dataProductUuid }) => runCli(['marketplace', 'products', 'read'], { 'data-product-uuid': dataProductUuid }));

  register('datasphere_create_data_product', 'Create a Data Marketplace data product',
    `Create a data product in status Draft from a definition (template: datasphere_read_data_product). Requires confirmation "CREATE DATASPHERE DATA PRODUCT".`,
    { definition: z.record(z.string(), z.unknown()), confirmation },
    CREATE_ANNOTATIONS,
    async ({ definition, confirmation: given }) => {
      requireConfirmation(given, 'CREATE DATASPHERE DATA PRODUCT');
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new IntegrationError('definition must be a JSON object');
      if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > DATA_PRODUCT_MAX_BYTES) {
        throw new IntegrationError('Definition is larger than 1 MiB');
      }
      return runCli(['marketplace', 'products', 'create'], {}, { input: definition });
    });

  register('datasphere_set_data_product_status', 'Set a data product lifecycle status',
    `List, delist or deactivate a data product. Requires confirmation "SET DATASPHERE DATA PRODUCT <UUID> <LIFECYCLE_STATUS>".`,
    {
      data_product_uuid: uuid,
      lifecycle_status: z.enum(['Listed', 'Delisted', 'Deactivated']),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ data_product_uuid: dataProductUuid, lifecycle_status: lifecycleStatus, confirmation: given }) => {
      requireConfirmation(given, `SET DATASPHERE DATA PRODUCT ${dataProductUuid} ${lifecycleStatus}`);
      return runCli(['marketplace', 'products', 'change-lifecycle-status'], {
        'data-product-uuid': dataProductUuid,
        'lifecycle-status': lifecycleStatus
      });
    });

  register('datasphere_install_data_product', 'Install a data product',
    `Install a data product into a space. Requires confirmation "INSTALL DATASPHERE DATA PRODUCT <UUID> INTO <SPACE>".`,
    {
      data_product_uuid: uuid,
      space,
      update_type: z.enum(['Manual', 'Automatic']).default('Manual'),
      license_key: uuid.optional(),
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ data_product_uuid: dataProductUuid, space: targetSpace, update_type: updateType, license_key: licenseKey, confirmation: given }) => {
      requireConfirmation(given, `INSTALL DATASPHERE DATA PRODUCT ${dataProductUuid} INTO ${targetSpace}`);
      return runCli(['marketplace', 'products', 'install'], {
        'data-product-uuid': dataProductUuid,
        'space-id': targetSpace,
        'update-type': updateType,
        ...(licenseKey ? { 'license-key': licenseKey } : {})
      });
    });

  // ------------------------------------------------------------ CSN builder (pure)

  register('datasphere_build_local_table_csn', 'Build a local-table CSN',
    'Convert a field list (BW/Data Dictionary style: name, label, ddic_type, length, decimals, key) into a Datasphere local-table CSN definition. Pure conversion, no tenant call.',
    {
      technical_name: technicalName,
      business_name: z.string().min(1).max(200),
      fields: z.array(z.object({
        name: z.string().min(1).max(200),
        label: z.string().max(200).optional(),
        ddic_type: z.string().min(1).max(30),
        length: z.number().int().min(1).max(9999).optional(),
        decimals: z.number().int().min(0).max(99).optional(),
        key: z.boolean().optional()
      })).min(1).max(1000)
    },
    { ...READ_ONLY_ANNOTATIONS, openWorldHint: false },
    async ({ technical_name: technicalNameArg, business_name: businessName, fields }) =>
      buildLocalTableCsn({ technicalName: technicalNameArg, businessName, fields }));

  // ------------------------------------------------------------ generic CLI commands

  const findEntry = async command => {
    const entries = await catalog();
    return entries.find(entry => entry.command === command) ?? null;
  };

  const runGeneric = async (command, options, input) => {
    if (!GENERIC_COMMAND.test(command)) throw new IntegrationError(`Invalid Datasphere command "${command}"`);
    const entry = await findEntry(command);
    if (!entry) throw new IntegrationError(`Unknown Datasphere command ${command}; call datasphere_list_commands`);
    if (auth !== 'interactive' && !entry.technical_user_supported) {
      throw new IntegrationError(`${command} needs an Interactive Usage OAuth client; rerun sap-ai-dev --setup-datasphere and choose "Your user"`);
    }
    const words = command.split(' ');
    const cliOptions = {};
    for (const [name, value] of Object.entries(options || {})) {
      if (!GENERIC_OPTION_KEY.test(name)) throw new IntegrationError(`Invalid option --${name}`);
      if (RESERVED_OPTIONS.has(name)) throw new IntegrationError(`Option --${name} is managed by the toolkit`);
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value.length > 10_000) throw new IntegrationError(`Option --${name} value is too long`);
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new IntegrationError(`Option --${name} must be a string, number or boolean`);
      }
      cliOptions[name] = value;
    }
    if (input !== undefined && !entry.has_body) throw new IntegrationError(`${command} takes no request body`);
    return runCli(words, cliOptions, input !== undefined ? { input } : {});
  };

  register('datasphere_list_commands', 'List Datasphere CLI commands',
    'List the Datasphere CLI command catalog discovered from the tenant, optionally filtered by prefix, with the auth mode each command supports. Parameter lists are omitted by default to keep the full catalog within the output limit; use include_parameters with a prefix or describe one command for its options.',
    {
      prefix: z.string().regex(/^[a-z0-9-]*(?: [a-z0-9-]*)*$/).max(120).optional(),
      include_parameters: z.boolean().default(false)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ prefix, include_parameters: includeParameters }) => (await catalog())
      .filter(entry => !prefix || entry.command.startsWith(prefix))
      .map(({ parameters, ...entry }) => ({
        ...entry,
        ...(includeParameters ? { parameters } : {}),
        usable_with_current_auth: auth === 'interactive' || entry.technical_user_supported
      })));

  register('datasphere_describe_command', 'Describe a Datasphere CLI command',
    'Show the authoritative --help text of one Datasphere CLI command from the tenant catalog.',
    { command: z.string().min(1).max(200) },
    READ_ONLY_ANNOTATIONS,
    async ({ command }) => {
      const entry = await findEntry(command);
      if (!entry) throw new IntegrationError(`Unknown Datasphere command ${command}; call datasphere_list_commands`);
      const help = await runCli(command.split(' '), { help: true });
      return { command, catalog: entry, help };
    });

  register('datasphere_run_read_command', 'Run a read-only Datasphere CLI command',
    'Run any discovered read-only Datasphere CLI command (spaces list, objects read, marketplace, tasks status, ...) with validated options.',
    {
      command: z.string().min(1).max(200),
      options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      input: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional()
    },
    READ_ONLY_ANNOTATIONS,
    async ({ command, options, input }) => {
      if (!GENERIC_COMMAND.test(command)) throw new IntegrationError(`Invalid Datasphere command "${command}"`);
      const entry = await findEntry(command);
      if (!entry) throw new IntegrationError(`Unknown Datasphere command ${command}; call datasphere_list_commands`);
      if (entry.access !== 'read') throw new IntegrationError(`${command} changes the tenant; use datasphere_run_command`);
      return runGeneric(command, options, input);
    });

  register('datasphere_run_command', 'Run any Datasphere CLI command',
    `Run any discovered Datasphere CLI command. Changing commands require confirmation "RUN DATASPHERE <COMMAND>" (or "DELETE DATASPHERE <COMMAND>" for deletions).`,
    {
      command: z.string().min(1).max(200),
      options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      input: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ command, options, input, confirmation: given }) => {
      if (!GENERIC_COMMAND.test(command)) throw new IntegrationError(`Invalid Datasphere command "${command}"`);
      const entry = await findEntry(command);
      if (!entry) throw new IntegrationError(`Unknown Datasphere command ${command}; call datasphere_list_commands`);
      if (entry.access === 'write') requireConfirmation(given, `RUN DATASPHERE ${command}`);
      if (entry.access === 'delete') requireConfirmation(given, `DELETE DATASPHERE ${command}`);
      const cliOptions = { ...(options || {}) };
      if (entry.confirm_required) cliOptions.force = true;
      return runGeneric(command, cliOptions, input);
    });

  // ------------------------------------------------------------ Open SQL

  if (sql) {
    let databasePromise;
    const getDatabase = () => {
      if (!databasePromise) {
        databasePromise = Promise.resolve(sql.connect(sql.config, { queryTimeoutMs: SQL_QUERY_TIMEOUT_MS })).catch(error => {
          databasePromise = undefined;
          throw error;
        });
      }
      return databasePromise;
    };
    const query = async statement => {
      try {
        return await (await getDatabase()).query(statement);
      } catch (error) {
        throw new IntegrationError(error?.message || 'Datasphere Open SQL query failed');
      }
    };

    const stripComments = statement => {
      let text = String(statement || '').trim();
      for (;;) {
        if (text.startsWith('--')) text = text.slice(text.indexOf('\n') + 1).trim();
        else if (text.startsWith('/*')) {
          const end = text.indexOf('*/');
          if (end < 0) break;
          text = text.slice(end + 2).trim();
        } else break;
      }
      return text;
    };

    const singleStatement = statement => {
      const text = stripComments(statement);
      const withoutTrailing = text.replace(/;+\s*$/, '').trim();
      if (withoutTrailing.includes(';')) throw new IntegrationError('Only a single SQL statement is allowed');
      return withoutTrailing;
    };

    register('datasphere_sql_query', 'Query the Datasphere Open SQL schema',
      'Run one read-only SELECT statement against the space Open SQL schema of the configured database user; rows are capped by max_rows.',
      {
        sql: z.string().min(1).max(SQL_QUERY_MAX),
        max_rows: z.number().int().min(1).max(200).default(100)
      },
      READ_ONLY_ANNOTATIONS,
      async ({ sql: statement, max_rows: maxRows }) => {
        const text = stripComments(statement);
        if (!/^select\b/i.test(text)) throw new IntegrationError('Only SELECT statements are allowed here; use datasphere_sql_execute');
        const single = singleStatement(statement);
        const rows = await query(`SELECT * FROM (${single}) AS Q LIMIT ${maxRows + 1}`);
        const list = Array.isArray(rows) ? rows : rows?.rows ?? [];
        return { rows: list.slice(0, maxRows), truncated: list.length > maxRows };
      });

    register('datasphere_sql_execute', 'Execute a statement on the Open SQL schema',
      `Execute one SQL statement (DDL, DML, or a documented "DWC_GLOBAL" data-lake procedure call) as the configured database user. Requires confirmation "EXECUTE DATASPHERE SQL AS <USER>".`,
      {
        sql: z.string().min(1).max(SQL_EXECUTE_MAX),
        confirmation
      },
      OVERWRITE_ANNOTATIONS,
      async ({ sql: statement, confirmation: given }) => {
        requireConfirmation(given, `EXECUTE DATASPHERE SQL AS ${sql.config.user}`);
        const single = singleStatement(statement);
        const result = await query(single);
        if (Array.isArray(result)) {
          return { rows: result.slice(0, 200), truncated: result.length > 200 };
        }
        return { affected_rows: result?.affectedRows ?? 0 };
      });
  }

  return registeredNames;
}

