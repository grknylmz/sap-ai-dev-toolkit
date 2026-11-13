import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatasphereCommands } from '../src/datasphere-discovery.mjs';

const discoveryDoc = {
  paths: {
    '/api/v1/spaces': {
      get: {
        operationId: 'spaces list',
        summary: 'List spaces',
        parameters: [{ $ref: '#/components/parameters/SpaceId' }]
      }
    },
    '/api/v1/dataexport/operations/upload': {
      post: {
        operationId: 'objects views create',
        'x-user-to-confirm': true,
        'x-requestbody-fileonly': true,
        requestBody: { $ref: '#/components/requestBodies/View' }
      }
    },
    '/api/v1/users/{userName}': {
      delete: {
        operationId: ['users read', { operationId: 'users describe', summary: 'alias summary' }],
        parameters: [
          { name: 'userName', in: 'path', required: true },
          { name: 'technicalName', in: 'query', required: false }
        ]
      }
    },
    '/api/v1/workload/priorities': {
      post: { operationId: 'workload priorities update' }
    }
  },
  components: {
    parameters: { SpaceId: { name: 'space_id', in: 'query', required: true } },
    requestBodies: {
      View: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ViewDef' } } } }
    },
    schemas: { ViewDef: { properties: { technicalName: {}, businessName: {}, space_id: {} } } }
  }
};

test('the discovery document maps to catalog entries with access, flags, options and auth support', async () => {
  const catalog = await loadDatasphereCommands({ rest: { request: async () => discoveryDoc } });
  const byCommand = Object.fromEntries(catalog.map(entry => [entry.command, entry]));

  const spaces = byCommand['spaces list'];
  assert.equal(spaces.access, 'read');
  assert.equal(spaces.technical_user_supported, false);
  assert.equal(spaces.confirm_required, false);
  assert.deepEqual(spaces.parameters, [{ name: 'space_id', in: 'query', required: true, option: '--space-id' }]);

  const create = byCommand['objects views create'];
  assert.equal(create.access, 'write');
  assert.equal(create.confirm_required, true);
  assert.equal(create.file_body_only, true);
  assert.equal(create.has_body, true);
  assert.equal(create.technical_user_supported, true);
  assert.deepEqual(create.parameters.map(parameter => parameter.option), ['--technical-name', '--business-name', '--space-id']);

  const read = byCommand['users read'];
  assert.equal(read.access, 'delete');
  assert.equal(read.deprecated, false);
  assert.ok(read.parameters.some(parameter => parameter.name === 'userName' && parameter.in === 'path' && parameter.required));
  assert.ok(read.parameters.some(parameter => parameter.name === 'technicalName' && parameter.option === '--technical-name'));
  assert.equal(byCommand['users describe'].summary, 'alias summary');
  assert.equal(byCommand['workload priorities update'].technical_user_supported, false);
  assert.deepEqual(catalog.map(entry => entry.command), [...catalog.map(entry => entry.command)].sort((a, b) => a.localeCompare(b)));
});

test('REST discovery failure falls back to the newest CLI cache file', async t => {
  const state = await mkdtemp(join(tmpdir(), 'datasphere-discovery-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, '.@sap', 'cache'), { recursive: true });
  await writeFile(join(state, '.@sap', 'cache', 'discovery-metadata.json'), JSON.stringify(discoveryDoc));
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(join(state, '.@sap', 'cache', 'discovery-2026-01-02.json'), JSON.stringify(discoveryDoc));

  const catalog = await loadDatasphereCommands({
    rest: { request: async () => { throw new Error('HTTP 503'); } },
    cli: { init: async () => {}, stateDir: () => state }
  });
  assert.ok(catalog.some(entry => entry.command === 'spaces list'));
  assert.ok(catalog.some(entry => entry.command === 'users describe'));
});

test('live-style OData paging and acronym parameters use the SAP CLI option names', async () => {
  const catalog = await loadDatasphereCommands({ rest: { request: async () => ({
    paths: { '/connections': { get: {
      operationId: 'spaces connections list',
      parameters: ['$top', '$skip', '$select', 'HDIContainer', 'userID'].map(name => ({ name, in: 'query' }))
    } } }
  }) } });
  assert.deepEqual(catalog[0].parameters.map(parameter => parameter.option), ['--top', '--skip', '--select', '--hdi-container', '--user-id']);
});

test('both sources failing yields a discovery-unavailable IntegrationError', async () => {
  await assert.rejects(
    () => loadDatasphereCommands({ rest: { request: async () => { throw new Error('HTTP 503'); } }, cli: { init: async () => {}, stateDir: () => '/nonexistent' } }),
    error => {
      assert.equal(error.name, 'IntegrationError');
      assert.match(error.message, /Datasphere command discovery is unavailable: HTTP 503/);
      return true;
    }
  );
});
