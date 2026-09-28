import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHanaInspector } from '../src/hana-inspector.mjs';

const env = {
  HANA_RO_HOST: 'hana.example.test',
  HANA_RO_PORT: '443',
  HANA_RO_USER: 'INSPECTOR',
  HANA_RO_PASSWORD: 'test-secret',
  HANA_RO_SCHEMA: 'HDI_SCHEMA'
};

function fakeDatabase({ rowResult = [{ ID: 7, TITLE: 'Catalog item' }], columns: columnOverride } = {}) {
  const calls = [];
  let closed = false;
  const columns = columnOverride || [
    { COLUMN_NAME: 'ID', POSITION: 1, DATA_TYPE_NAME: 'INTEGER', LENGTH: 10, SCALE: 0, IS_NULLABLE: 'FALSE' },
    { COLUMN_NAME: 'TITLE', POSITION: 2, DATA_TYPE_NAME: 'NVARCHAR', LENGTH: 80, SCALE: 0, IS_NULLABLE: 'TRUE' }
  ];
  return {
    calls,
    get closed() { return closed; },
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('CURRENT_SCHEMA')) return [{ CURRENT_SCHEMA: 'HDI_SCHEMA', CURRENT_USER: 'INSPECTOR' }];
      if (sql.includes('FROM SYS.TABLES') && sql.includes('TABLE_NAME = ?')) {
        return values[1] === 'BOOKS' ? [{ OBJECT_NAME: 'BOOKS' }] : [];
      }
      if (sql.includes('FROM SYS.VIEWS') && sql.includes('VIEW_NAME = ?')) {
        return values[1] === 'BOOKS_VIEW' ? [{ OBJECT_NAME: 'BOOKS_VIEW' }] : [];
      }
      if (sql.includes('FROM SYS.TABLES') && sql.includes('ORDER BY TABLE_NAME')) return [{ OBJECT_NAME: 'BOOKS' }];
      if (sql.includes('FROM SYS.VIEWS') && sql.includes('ORDER BY VIEW_NAME')) return [{ OBJECT_NAME: 'BOOKS_VIEW' }];
      if (sql.includes('FROM SYS.TABLE_COLUMNS')) return columns;
      if (sql.includes('FROM SYS.VIEW_COLUMNS')) return columns;
      if (sql.startsWith('SELECT "')) return rowResult;
      throw new Error(`Unexpected test SQL: ${sql}`);
    },
    async close() { closed = true; }
  };
}

async function connectTestClient(t, database) {
  const runtime = createHanaInspector({ env, databaseFactory: async () => database });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hana-test-client', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await runtime.close();
  });
  return { client, runtime };
}

function parseResult(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}

test('advertises only bounded, read-only HANA tools with no arbitrary SQL input', async t => {
  const database = fakeDatabase();
  const { client } = await connectTestClient(t, database);
  const result = await client.listTools();
  const tools = new Map(result.tools.map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].sort(), [
    'hana_connection_info',
    'hana_describe_object',
    'hana_list_objects',
    'hana_read_rows'
  ]);
  for (const tool of tools.values()) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  const readRowsSchema = tools.get('hana_read_rows').inputSchema;
  assert.ok(readRowsSchema.properties.objectName);
  assert.ok(readRowsSchema.properties.columns);
  assert.equal(readRowsSchema.properties.sql, undefined);
  assert.equal(readRowsSchema.properties.schema, undefined);
});

test('returns connection identity and schema-scoped object/column metadata', async t => {
  const database = fakeDatabase();
  const { client } = await connectTestClient(t, database);

  const identity = parseResult(await client.callTool({ name: 'hana_connection_info', arguments: {} }));
  assert.equal(identity.currentSchema, 'HDI_SCHEMA');
  assert.equal(identity.databaseUser, 'INSPECTOR');
  assert.equal(identity.tls, 'enabled; certificate verification required');
  assert.equal(JSON.stringify(identity).includes('test-secret'), false);

  const objects = parseResult(await client.callTool({ name: 'hana_list_objects', arguments: { objectType: 'ALL', maxResults: 10 } }));
  assert.deepEqual(objects.objects, [
    { objectName: 'BOOKS', objectType: 'TABLE' },
    { objectName: 'BOOKS_VIEW', objectType: 'VIEW' }
  ]);
  assert.ok(database.calls.every(call => call.values.every(value => value !== 'OTHER_SCHEMA')));

  const description = parseResult(await client.callTool({ name: 'hana_describe_object', arguments: { objectName: 'BOOKS' } }));
  assert.equal(description.schema, 'HDI_SCHEMA');
  assert.deepEqual(description.columns.map(column => column.COLUMN_NAME), ['ID', 'TITLE']);
});

test('reads only catalog-verified columns with bound filters and a fixed HDI schema', async t => {
  const database = fakeDatabase();
  const { client } = await connectTestClient(t, database);
  const response = parseResult(await client.callTool({
    name: 'hana_read_rows',
    arguments: {
      objectName: 'BOOKS',
      schema: 'OTHER_SCHEMA',
      columns: ['ID', 'TITLE'],
      filters: [{ column: 'ID', operator: 'gt', value: 4 }],
      orderBy: { column: 'ID', direction: 'ASC' },
      limit: 10
    }
  }));
  assert.deepEqual(response.rows, [{ ID: 7, TITLE: 'Catalog item' }]);
  const dataQuery = database.calls.find(call => call.sql.startsWith('SELECT "ID"'));
  assert.ok(dataQuery);
  assert.match(dataQuery.sql, /FROM "HDI_SCHEMA"\."BOOKS"/);
  assert.doesNotMatch(dataQuery.sql, /OTHER_SCHEMA/);
  assert.deepEqual(dataQuery.values, [4]);
  assert.match(dataQuery.sql, /LIMIT 10$/);
});

test('binds hostile object names and rejects unknown columns without executing a data query', async t => {
  const database = fakeDatabase();
  const { client } = await connectTestClient(t, database);
  const maliciousName = 'BOOKS"; DROP TABLE X;--';
  const response = await client.callTool({
    name: 'hana_read_rows',
    arguments: { objectName: maliciousName, columns: ['ID'], limit: 1 }
  });
  assert.equal(response.isError, true);
  assert.equal(database.calls.some(call => call.sql.includes('DROP TABLE')), false);
  const lookup = database.calls.find(call => call.sql.includes('TABLE_NAME = ?'));
  assert.deepEqual(lookup.values, ['HDI_SCHEMA', maliciousName]);

  const invalidColumn = await client.callTool({
    name: 'hana_read_rows',
    arguments: { objectName: 'BOOKS', columns: ['SECRET'], limit: 1 }
  });
  assert.equal(invalidColumn.isError, true);
  assert.equal(database.calls.some(call => call.sql.startsWith('SELECT "SECRET"')), false);
});

test('bounds object and row limits and refuses oversized results', async t => {
  const largeDatabase = fakeDatabase({ rowResult: [{ ID: 1, TITLE: 'x'.repeat(100_000) }] });
  const { client } = await connectTestClient(t, largeDatabase);
  const tooManyObjects = await client.callTool({
    name: 'hana_list_objects',
    arguments: { objectType: 'TABLE', maxResults: 201 }
  });
  assert.equal(tooManyObjects.isError, true);

  const tooLarge = await client.callTool({
    name: 'hana_read_rows',
    arguments: { objectName: 'BOOKS', columns: ['ID', 'TITLE'], limit: 1 }
  });
  assert.equal(tooLarge.isError, true);
  assert.match(tooLarge.content[0].text, /too large to return safely/);
  assert.ok(Buffer.byteLength(tooLarge.content[0].text) < 1000);
});

test('rejects unbounded or oversized column selections before fetching row data', async t => {
  const database = fakeDatabase({ columns: [
    { COLUMN_NAME: 'ID', POSITION: 1, DATA_TYPE_NAME: 'INTEGER', LENGTH: 10, SCALE: 0, IS_NULLABLE: 'FALSE' },
    { COLUMN_NAME: 'BODY', POSITION: 2, DATA_TYPE_NAME: 'NCLOB', LENGTH: 0, SCALE: 0, IS_NULLABLE: 'TRUE' },
    { COLUMN_NAME: 'WIDE', POSITION: 3, DATA_TYPE_NAME: 'NVARCHAR', LENGTH: 9000, SCALE: 0, IS_NULLABLE: 'TRUE' },
    { COLUMN_NAME: 'API_KEY', POSITION: 4, DATA_TYPE_NAME: 'NVARCHAR', LENGTH: 128, SCALE: 0, IS_NULLABLE: 'TRUE' }
  ] });
  const { client } = await connectTestClient(t, database);

  const lob = await client.callTool({
    name: 'hana_read_rows',
    arguments: { objectName: 'BOOKS', columns: ['BODY'], limit: 1 }
  });
  assert.equal(lob.isError, true);
  assert.match(lob.content[0].text, /LOB and binary columns are not supported/);

  const oversized = await client.callTool({
    name: 'hana_read_rows',
    arguments: { objectName: 'BOOKS', columns: ['WIDE'], limit: 1 }
  });
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /safe row-width limit/);
  const credential = await client.callTool({
    name: 'hana_read_rows',
    arguments: { objectName: 'BOOKS', columns: ['API_KEY'], limit: 1 }
  });
  assert.equal(credential.isError, true);
  assert.match(credential.content[0].text, /Credential-like columns/);
  assert.equal(database.calls.some(call => ['BODY', 'WIDE', 'API_KEY'].some(name => call.sql.startsWith(`SELECT "${name}"`))), false);
});

test('closes the connected database when the server runtime closes', async t => {
  const database = fakeDatabase();
  const { client, runtime } = await connectTestClient(t, database);
  await client.callTool({ name: 'hana_connection_info', arguments: {} });
  await runtime.close();
  assert.equal(database.closed, true);
});