import { z } from 'zod';
import { quoteHanaIdentifier } from './hana-config.mjs';

export const HANA_MAX_ROWS = 200;
export const HANA_MAX_OUTPUT_BYTES = 96 * 1024;
const MAX_COLUMNS = 40;
const MAX_FILTERS = 20;
const MAX_SELECTED_COLUMN_WIDTH = 8192;
const UNBOUNDED_COLUMN_TYPES = new Set(['BLOB', 'CLOB', 'NCLOB', 'BINARY', 'VARBINARY', 'ST_GEOMETRY', 'ST_POINT']);
// Denylist of credential-like column names. This is a heuristic — the real
// control is the dedicated read-only HANA identity — but it keeps obvious
// secret material (password hashes, salts, signatures, certificates, JWTs,
// session ids) out of tool results even under that identity.
const SENSITIVE_COLUMN_NAME = /(?:PASS(?:WORD|WD)?|PWD|PASSPHRASE|SECRET|CREDENTIAL|(?:ACCESS|REFRESH|AUTH|SESSION)?_?TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNATURE|SALT|CERT(?:IFICATE)?|JWT|BEARER)/i;
const SAFE_INSPECTION_ERRORS = new Set([
  'HANA result is too large to return safely; request fewer rows or columns.',
  'The requested object was not found in the bound HDI schema.',
  'A requested column is not present on the requested HDI object.',
  'Credential-like columns are not returned by the HANA inspector.',
  'LOB and binary columns are not supported by the bounded row-read tool.',
  'The selected columns exceed the safe row-width limit; select fewer or narrower columns.'
]);

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const OPERATOR_SQL = Object.freeze({
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>='
});

function jsonSafe(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { type: 'binary', bytes: value.byteLength };
  if (Array.isArray(value)) return value.map(entry => jsonSafe(entry, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, seen)]));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function jsonText(value) {
  const text = JSON.stringify(jsonSafe(value), null, 2);
  if (Buffer.byteLength(text, 'utf8') > HANA_MAX_OUTPUT_BYTES) {
    throw new Error('HANA result is too large to return safely; request fewer rows or columns.');
  }
  return text;
}

function toolError(error) {
  let message = 'HANA inspection failed. Check the selected read-only binding, target schema, and read permissions.';
  if (error?.name === 'HanaDatabaseError' || error?.name === 'HanaQueryTimeoutError') {
    message = error.message;
  } else if (SAFE_INSPECTION_ERRORS.has(error?.message)) {
    message = error.message;
  } else if (typeof error?.message === 'string' && /^(?:Set HANA_RO_|Explicit HANA |VCAP_SERVICES|The selected HANA |No HANA VCAP|Multiple HANA VCAP|The configured HANA |HANA_RO_HOST|HANA_RO_PORT)/.test(error.message)) {
    message = error.message;
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function resultOf(operation) {
  try {
    return { content: [{ type: 'text', text: jsonText(await operation()) }] };
  } catch (error) {
    return toolError(error);
  }
}

function rowsOf(value) {
  return Array.isArray(value) ? value : [];
}

async function listObjects(database, schema, objectType, maxResults) {
  const entries = [];
  if (objectType !== 'VIEW') {
    const tables = rowsOf(await database.query(
      `SELECT TABLE_NAME AS OBJECT_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME LIMIT ${maxResults}`,
      [schema]
    ));
    entries.push(...tables.map(row => ({ objectName: row.OBJECT_NAME, objectType: 'TABLE' })));
  }
  if (objectType !== 'TABLE') {
    const views = rowsOf(await database.query(
      `SELECT VIEW_NAME AS OBJECT_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME LIMIT ${maxResults}`,
      [schema]
    ));
    entries.push(...views.map(row => ({ objectName: row.OBJECT_NAME, objectType: 'VIEW' })));
  }
  entries.sort((left, right) => String(left.objectName).localeCompare(String(right.objectName)) || left.objectType.localeCompare(right.objectType));
  return {
    schema,
    objectType,
    objects: entries.slice(0, maxResults),
    maxResults,
    truncated: entries.length >= maxResults
  };
}

async function findObject(database, schema, objectName) {
  const tables = rowsOf(await database.query(
    'SELECT TABLE_NAME AS OBJECT_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?',
    [schema, objectName]
  ));
  if (tables.length) return { objectName, objectType: 'TABLE' };
  const views = rowsOf(await database.query(
    'SELECT VIEW_NAME AS OBJECT_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = ? AND VIEW_NAME = ?',
    [schema, objectName]
  ));
  if (views.length) return { objectName, objectType: 'VIEW' };
  throw new Error('The requested object was not found in the bound HDI schema.');
}

async function describeObject(database, schema, objectName) {
  const target = await findObject(database, schema, objectName);
  const sql = target.objectType === 'TABLE'
    ? 'SELECT COLUMN_NAME, POSITION, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY POSITION'
    : 'SELECT COLUMN_NAME, POSITION, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME = ? AND VIEW_NAME = ? ORDER BY POSITION';
  const columns = rowsOf(await database.query(sql, [schema, objectName]));
  return { ...target, schema, columns };
}

function assertRequestedColumns(columns, metadataColumns) {
  const available = new Set(metadataColumns.map(column => column.COLUMN_NAME));
  for (const name of columns) {
    if (!available.has(name)) throw new Error('A requested column is not present on the requested HDI object.');
  }
}

function assertBoundedColumns(columns, metadataColumns) {
  let estimatedWidth = 0;
  for (const name of columns) {
    const column = metadataColumns.find(entry => entry.COLUMN_NAME === name);
    const type = String(column.DATA_TYPE_NAME || '').toUpperCase();
    if (UNBOUNDED_COLUMN_TYPES.has(type)) {
      throw new Error('LOB and binary columns are not supported by the bounded row-read tool.');
    }
    const length = Number(column.LENGTH);
    estimatedWidth += Number.isFinite(length) && length > 0 ? length : 32;
    if (estimatedWidth > MAX_SELECTED_COLUMN_WIDTH) {
      throw new Error('The selected columns exceed the safe row-width limit; select fewer or narrower columns.');
    }
  }
}

function assertNonSensitiveColumns(columns) {
  if (columns.some(name => SENSITIVE_COLUMN_NAME.test(name))) {
    throw new Error('Credential-like columns are not returned by the HANA inspector.');
  }
}

async function readRows(database, schema, args) {
  const target = await findObject(database, schema, args.objectName);
  const metadata = await describeObject(database, schema, args.objectName);
  assertRequestedColumns(args.columns, metadata.columns);
  assertNonSensitiveColumns([
    ...args.columns,
    ...args.filters.map(filter => filter.column),
    ...(args.orderBy ? [args.orderBy.column] : [])
  ]);
  assertBoundedColumns(args.columns, metadata.columns);

  for (const filter of args.filters) assertRequestedColumns([filter.column], metadata.columns);
  if (args.orderBy) assertRequestedColumns([args.orderBy.column], metadata.columns);

  const selected = args.columns.map(quoteHanaIdentifier).join(', ');
  const conditions = args.filters.map(filter => `${quoteHanaIdentifier(filter.column)} ${OPERATOR_SQL[filter.operator]} ?`);
  const order = args.orderBy
    ? ` ORDER BY ${quoteHanaIdentifier(args.orderBy.column)} ${args.orderBy.direction}`
    : '';
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT ${selected} FROM ${quoteHanaIdentifier(schema)}.${quoteHanaIdentifier(args.objectName)}${where}${order} LIMIT ${args.limit}`;
  const values = args.filters.map(filter => filter.value);
  // Defense in depth: the SQL LIMIT and the zod cap already bound the read,
  // but the returned rows are sliced again so no future query-shape change
  // can smuggle more than HANA_MAX_ROWS into a tool result.
  const rows = rowsOf(await database.query(sql, values)).slice(0, HANA_MAX_ROWS);
  return {
    schema,
    ...target,
    columns: args.columns,
    limit: args.limit,
    rowCount: rows.length,
    rows,
    possiblyTruncated: rows.length === args.limit
  };
}

/** Register read-only inspection tools. No handler accepts arbitrary SQL or a caller-selected schema. */
export function registerHanaTools(server, getDatabase, { connectionSummary } = {}) {
  const schemaName = connectionSummary?.schema;
  if (typeof schemaName !== 'string' || !schemaName.trim()) {
    throw new Error('A configured HDI schema is required to register HANA tools.');
  }

  server.registerTool('hana_connection_info', {
    title: 'HANA connection info',
    description: 'Return the configured HANA Cloud endpoint and verified HDI schema/current user. Uses the dedicated read-only identity; never returns credentials.',
    inputSchema: {},
    annotations: READ_ONLY_ANNOTATIONS
  }, async () => resultOf(async () => {
    const database = await getDatabase();
    const rows = rowsOf(await database.query('SELECT CURRENT_SCHEMA AS CURRENT_SCHEMA, CURRENT_USER AS CURRENT_USER FROM DUMMY'));
    if (!rows.length) throw new Error('HANA did not return its current connection identity.');
    const currentSchema = rows[0].CURRENT_SCHEMA;
    if (currentSchema !== schemaName) throw new Error('The connected HANA schema does not match the configured HDI schema.');
    return {
      source: connectionSummary.source,
      serviceName: connectionSummary.serviceName,
      bindingName: connectionSummary.bindingName,
      host: connectionSummary.host,
      port: connectionSummary.port,
      configuredSchema: schemaName,
      currentSchema,
      databaseUser: rows[0].CURRENT_USER,
      tls: 'enabled; certificate verification required'
    };
  }));

  server.registerTool('hana_list_objects', {
    title: 'List HANA objects',
    description: 'List tables and/or views from the configured HDI schema only. Results are capped at 200 objects.',
    inputSchema: {
      objectType: z.enum(['ALL', 'TABLE', 'VIEW']).default('ALL'),
      maxResults: z.number().int().min(1).max(HANA_MAX_ROWS).default(100)
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async ({ objectType, maxResults }) => resultOf(async () => {
    return listObjects(await getDatabase(), schemaName, objectType, maxResults);
  }));

  server.registerTool('hana_describe_object', {
    title: 'Describe HANA object',
    description: 'Return column metadata for a table or view in the configured HDI schema only.',
    inputSchema: { objectName: z.string().trim().min(1).max(127) },
    annotations: READ_ONLY_ANNOTATIONS
  }, async ({ objectName }) => resultOf(async () => {
    return describeObject(await getDatabase(), schemaName, objectName);
  }));

  const valueSchema = z.union([z.string().max(2048), z.number().finite(), z.boolean()]);
  const filterSchema = z.object({
    column: z.string().trim().min(1).max(127),
    operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
    value: valueSchema
  }).strict();

  server.registerTool('hana_read_rows', {
    title: 'Read HANA rows',
    description: `Run a bounded, parameterized read from one catalog-listed table/view in the configured HDI schema. Select 1–${MAX_COLUMNS} known columns; no free-form SQL, DDL, DML, procedure calls, or schema selection is accepted. Maximum ${HANA_MAX_ROWS} rows.`,
    inputSchema: {
      objectName: z.string().trim().min(1).max(127),
      columns: z.array(z.string().trim().min(1).max(127)).min(1).max(MAX_COLUMNS),
      filters: z.array(filterSchema).max(MAX_FILTERS).default([]),
      orderBy: z.object({
        column: z.string().trim().min(1).max(127),
        direction: z.enum(['ASC', 'DESC']).default('ASC')
      }).strict().optional(),
      limit: z.number().int().min(1).max(HANA_MAX_ROWS).default(50)
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async args => resultOf(async () => readRows(await getDatabase(), schemaName, args)));
}

export const HANA_TOOL_NAMES = Object.freeze([
  'hana_connection_info',
  'hana_list_objects',
  'hana_describe_object',
  'hana_read_rows'
]);