import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { createServiceClient } from '../src/integration-http.mjs';
import { createCollectionPager, decodeCollection } from '../src/integration-collections.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', CPI_SERVICE_KEY: tenant.serviceKey() }, pollIntervalMs: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'collection-test', version: '1.0.0' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return client;
}
async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, response.content[0].text);
  return JSON.parse(response.content[0].text);
}
function service(tenant) {
  return createServiceClient({ label: 'fixture', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'client', clientSecret: 'private', env: {}, retryDelayMs: 0 });
}
const rows = count => Array.from({ length: count }, (_, index) => ({ Id: `ID${String(index).padStart(4, '0')}`, Name: `Name${String(index).padStart(4, '0')}` }));
const pageKeys = ['complete', 'items', 'next_cursor', 'returned', 'stop_reason', 'total'];
function envelope(value) {
  for (const key of pageKeys) assert.ok(Object.hasOwn(value, key), `missing ${key}`);
  assert.equal(value.returned, value.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) < 96 * 1024);
  assert.equal(Object.hasOwn(value, 'logs'), false);
  assert.equal(Object.hasOwn(value, 'steps'), false);
}

test('CPI packages traverse 205 identities without __next, changing top does not invalidate cursors', async t => {
  const fixtures = rows(205);
  const tenant = await startFakeTenant(t, request => {
    const start = Number(request.query.get('$skip') ?? 0);
    const top = Number(request.query.get('$top') ?? 100);
    return { status: 200, json: { d: { __count: '205', results: fixtures.slice(start, start + top) } } };
  });
  const client = await connect(t, tenant);
  let page = await call(client, 'cpi_list_packages', { top: 100 });
  assert.equal(page.complete, false);
  assert.equal(page.stop_reason, 'more');
  assert.equal(page.total, 205);
  const collected = [];
  for (let index = 0; ; index += 1) {
    assert.ok(index < 10, 'traversal terminates');
    envelope(page);
    collected.push(...page.items.map(row => row.Id));
    if (!page.next_cursor) break;
    page = await call(client, 'cpi_list_packages', { top: 60, cursor: page.next_cursor });
  }
  assert.equal(page.complete, true);
  assert.equal(page.stop_reason, 'end');
  assert.deepEqual(collected, fixtures.map(row => row.Id));
  assert.equal(new Set(collected).size, 205);
});

test('V4 count survives projection and server-capped pages without next links', async t => {
  const fixtures = rows(215);
  const tenant = await startFakeTenant(t, request => {
    const skip = Number(request.query.get('$skip') ?? 0);
    return { status: 200, json: { '@count': 215, value: fixtures.slice(skip, skip + 3) } };
  });
  const pager = createCollectionPager(service(tenant), { root: '/analytics' });
  let cursor;
  const collected = [];
  for (let index = 0; ; index += 1) {
    assert.ok(index < 80);
    const page = await pager.page({ path: '/ResultsUTC', top: 3, cursor, project: row => ({ id: row.Id }), orderBy: 'Id' });
    assert.equal(page.total, 215);
    if (index === 0) assert.equal(page.complete, false);
    collected.push(...page.items.map(row => row.id));
    cursor = page.next_cursor;
    if (!cursor) { assert.equal(page.complete, true); break; }
  }
  assert.deepEqual(collected, fixtures.map(row => row.Id));
  assert.equal(decodeCollection({ d: { results: [], __count: '-1' } }).total, null);
  assert.equal(decodeCollection({ value: [], '@odata.count': 'not a count' }).total, null);
  assert.equal(decodeCollection({ value: [], '@odata.count': 0 }).total, 0);
});

test('signed cursors reject tampering, changed identity, foreign runtime/root and expiry before requests', async t => {
  const fixtures = rows(8);
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { __count: '8', results: fixtures } } }));
  const client = service(tenant);
  const pager = createCollectionPager(client, { root: '/api/v1' });
  const args = { path: '/IntegrationPackages', top: 2, query: { $filter: "Mode eq 'EDIT'" }, orderBy: 'Name' };
  const first = await pager.page(args);
  const cursor = first.next_cursor;
  assert.ok(cursor);
  const count = tenant.requests.length;
  const [payload, signature] = cursor.split('.');
  const altered = JSON.parse(Buffer.from(payload, 'base64url'));
  altered.root = '/outside';
  const forged = `${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${signature}`;
  for (const bad of [forged, 'not-a-cursor', `${cursor.slice(0, -2)}zz`]) {
    await assert.rejects(pager.page({ ...args, cursor: bad }), /cursor/);
  }
  await assert.rejects(pager.page({ ...args, cursor, query: { $filter: "Mode eq 'READ'" } }), /cursor/);
  await assert.rejects(pager.page({ ...args, cursor, orderBy: 'Id' }), /cursor/);
  await assert.rejects(pager.page({ ...args, cursor, path: '/Other' }), /cursor/);
  await assert.rejects(createCollectionPager(client, { root: '/other' }).page({ ...args, cursor }), /cursor/);
  await assert.rejects(createCollectionPager(service(tenant), { root: '/api/v1' }).page({ ...args, cursor }), /cursor/);
  assert.equal(tenant.requests.length, count);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 16 * 60 * 1000);
  await assert.rejects(pager.page({ ...args, cursor }), /expired/);
  assert.equal(tenant.requests.length, count);
});

test('server continuation links are pinned and cyclic continuations are never followed', async t => {
  let next;
  const tenant = await startFakeTenant(t, request => ({ status: 200, json: { d: { __count: '4', results: rows(1), __next: typeof next === 'function' ? next(request) : next } } }));
  const pager = createCollectionPager(service(tenant), { root: '/api/v1' });
  for (const link of ['https://attacker.example/api/v1/Packages?$skip=1', `${tenant.url}/other/Packages?$skip=1`, `${tenant.url}/api/v1/Other?$skip=1`, `${tenant.url}/api/v1/Packages?$filter=secret&$skip=1`]) {
    next = link;
    const before = tenant.apiRequests().length;
    await assert.rejects(pager.page({ path: '/Packages', top: 2 }), /continuation/);
    assert.equal(tenant.apiRequests().length, before + 1, 'unsafe target never requested');
  }
  next = request => `${tenant.url}${request.path}${request.rawQuery}`;
  const before = tenant.apiRequests().length;
  await assert.rejects(pager.page({ path: '/Packages', top: 2 }), /Repeated/);
  assert.equal(tenant.apiRequests().length, before + 1);
});

test('validated V2/V4 server continuations retrieve all rows with preserved filters', async t => {
  const fixtures = rows(7);
  const tenant = await startFakeTenant(t, request => {
    const skip = Number(request.query.get('$skip') ?? 0);
    const query = new URLSearchParams(request.query);
    query.set('$skip', String(skip + 2));
    const next = skip + 2 < fixtures.length ? `${tenant.url}${request.path}?${query}` : undefined;
    return { status: 200, json: { value: fixtures.slice(skip, skip + 2), '@odata.count': 7, ...(next ? { '@odata.nextLink': next } : {}) } };
  });
  const pager = createCollectionPager(service(tenant), { root: '/api/v1' });
  const items = [];
  let cursor;
  do {
    const page = await pager.page({ path: '/Packages', top: 2, cursor, query: { $filter: "Mode eq 'EDIT'" } });
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(items, fixtures);
  assert.ok(tenant.apiRequests().every(request => request.query.get('$filter') === "Mode eq 'EDIT'"));
});

test('local collections request no invented OData options, page 205 rows and detect source drift', async t => {
  let fixtures = rows(205);
  const tenant = await startFakeTenant(t, request => {
    assert.equal(request.rawQuery, '');
    return { status: 200, json: fixtures };
  });
  const pager = createCollectionPager(service(tenant), { root: '/api/v1' });
  const first = await pager.page({ path: '/Variables', mode: 'local', top: 100 });
  assert.equal(first.total, null);
  assert.equal(first.complete, false);
  const last = await pager.page({ path: '/Variables', mode: 'local', top: 200, cursor: first.next_cursor });
  assert.equal(last.complete, true);
  assert.deepEqual([...first.items, ...last.items], fixtures);
  fixtures = [{ Id: 'changed' }, ...fixtures.slice(1)];
  const drift = await pager.page({ path: '/Variables', mode: 'local', top: 100, cursor: first.next_cursor });
  assert.equal(drift.complete, false);
  assert.equal(drift.stop_reason, 'source_changed');
  assert.equal(drift.next_cursor, null);
});

test('optional-query rejection retries only the same collection without paging options', async t => {
  const fixtures = rows(205);
  const tenant = await startFakeTenant(t, request => {
    if (request.query.has('$top') || request.query.has('$skip') || request.query.has('$orderby')) return { status: 501, json: { error: { message: 'unsupported optional query' } } };
    assert.equal(request.query.get('$filter'), "Name ne 'hidden'");
    return { status: 200, json: { d: { results: fixtures } } };
  });
  const pager = createCollectionPager(service(tenant), { root: '/api/v1' });
  const first = await pager.page({ path: '/Packages', top: 100, query: { $filter: "Name ne 'hidden'" }, orderBy: 'Name' });
  assert.equal(first.returned, 100);
  const second = await pager.page({ path: '/Packages', top: 200, query: { $filter: "Name ne 'hidden'" }, orderBy: 'Name', cursor: first.next_cursor });
  assert.deepEqual([...first.items, ...second.items], fixtures);
  assert.equal(second.complete, true);
  assert.equal(tenant.apiRequests().length, 3);
  assert.ok(tenant.apiRequests().every(request => request.path === '/api/v1/Packages'));
});

test('paging rejection, oversized sources, deadlines, unverified navigations and output caps are explicit', async t => {
  const rejected = await startFakeTenant(t, () => ({ status: 400, json: { error: { message: 'not supported' } } }));
  const unsupported = await createCollectionPager(service(rejected), { root: '/api/v1' }).page({ path: '/Packages' });
  assert.equal(unsupported.stop_reason, 'paging_unsupported');
  assert.equal(unsupported.complete, false);
  assert.equal(unsupported.source_result.status, 400);
  const oversized = await startFakeTenant(t, () => ({ status: 200, json: { d: { results: [{ Value: 'x'.repeat(2 * 1024 * 1024) }] } } }));
  const limited = await createCollectionPager(service(oversized), { root: '/api/v1' }).page({ path: '/Variables', mode: 'local' });
  assert.equal(limited.stop_reason, 'source_limit');
  assert.equal(limited.complete, false);
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: rows(3).map(row => ({ ...row, Description: 'é'.repeat(30000) })) }));
  const pager = createCollectionPager(service(tenant), { root: '/api/v1' });
  const expired = await pager.page({ path: '/Variables', deadline: Date.now() - 1 });
  assert.equal(expired.stop_reason, 'deadline');
  assert.equal(tenant.requests.length, 0);
  const page = await pager.page({ path: '/Variables', mode: 'local', top: 3 });
  envelope(page);
  assert.equal(page.returned, 1);
  assert.equal(page.stop_reason, 'output_limit');
  assert.ok(page.next_cursor);
  const second = await pager.page({ path: '/Variables', mode: 'local', top: 3, cursor: page.next_cursor });
  assert.equal(second.items[0].Id, 'ID0001');
  const bounded = await pager.page({ path: '/Variables', mode: 'local', sourceComplete: false, project: row => ({ Id: row.Id }) });
  assert.equal(bounded.complete, false);
  assert.equal(bounded.stop_reason, 'source_limit');
  assert.equal(bounded.next_cursor, null);
});

test('MPL duplicate identities and count drift retain bounded best-effort evidence', async t => {
  let total = 3;
  let duplicate = false;
  const tenant = await startFakeTenant(t, request => {
    const skip = Number(request.query.get('$skip') ?? 0);
    const entries = skip ? [{ MessageGuid: duplicate ? 'guid1' : 'guid3' }] : [{ MessageGuid: 'guid1' }, { MessageGuid: 'guid2' }, { MessageGuid: 'guid3' }];
    return { status: 200, json: { d: { __count: String(total), results: entries } } };
  });
  const client = await connect(t, tenant);
  const first = await call(client, 'cpi_list_message_logs', { top: 2 });
  total = 4;
  const drift = await call(client, 'cpi_list_message_logs', { top: 2, cursor: first.next_cursor });
  assert.equal(drift.consistency, 'best_effort');
  assert.equal(drift.stop_reason, 'source_changed');
  assert.equal(drift.complete, false);
  total = 3;
  duplicate = true;
  const repeated = await call(client, 'cpi_list_message_logs', { top: 2, cursor: first.next_cursor });
  assert.equal(repeated.stop_reason, 'source_changed');
  assert.equal(repeated.next_cursor, null);
});

test('all existing CPI collection surfaces return bounded envelopes and typed inventories', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (/\/MessageProcessingLogs\(/.test(request.path) && !request.path.endsWith('/Runs')) return { status: 200, json: { d: { MessageGuid: 'GUID0000001' } } };
    if (request.path.endsWith('/Runs')) return { status: 200, json: { d: { results: [{ Id: 'RUN0000001', RunStart: '/Date(1700000000000)/' }] } } };
    return { status: 200, json: { d: { results: [{ Id: 'ID0001', Name: 'Fixture', Alias: 'Alias', Pid: 'Partner', Value: 'must-not-leak', Password: 'must-not-leak', NumberOfOverdueMessages: 1, StepId: 'S1' }] } } };
  });
  const client = await connect(t, tenant);
  const cases = [
    ['cpi_list_packages', {}], ['cpi_list_iflows', { package_id: 'Fixture' }],
    ['cpi_list_service_endpoints', {}], ['cpi_list_message_logs', {}], ['cpi_list_runtime_artifacts', {}],
    ['cpi_list_security_material', { kind: 'user_credentials' }], ['cpi_list_security_material', { kind: 'oauth2_client_credentials' }],
    ['cpi_list_security_material', { kind: 'keystore_entries' }], ['cpi_list_number_ranges', {}],
    ['cpi_list_partner_parameters', { type: 'string' }], ['cpi_list_partner_parameters', { type: 'binary' }],
    ['cpi_list_data_stores', { overdue_only: true }], ['cpi_list_data_store_entries', { data_store: 'store', integration_flow: 'flow' }],
    ['cpi_list_variables', {}], ['cpi_get_message_log_steps', { message_guid: 'GUID0000001' }]
  ];
  for (const [name, args] of cases) {
    const page = await call(client, name, args);
    envelope(page);
    assert.doesNotMatch(JSON.stringify(page), /must-not-leak/);
  }
  const artifacts = await call(client, 'cpi_list_package_artifacts', { package_id: 'Fixture' });
  for (const type of ['iflows', 'value_mappings', 'script_collections', 'message_mappings']) { envelope(artifacts[type]); assert.equal(artifacts[type].complete, false); }
  const partner = await call(client, 'cpi_list_partner_parameters');
  for (const type of ['string_parameters', 'binary_parameters']) envelope(partner[type]);
  for (const [name, args] of [
    ['cpi_list_package_artifacts', { package_id: 'Fixture', cursor: 'forged' }],
    ['cpi_list_partner_parameters', { cursor: 'forged' }],
    ['cpi_get_message_log_steps', { message_guid: 'GUID0000001', cursor: 'forged' }]
  ]) {
    const before = tenant.requests.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(tenant.requests.length, before);
  }
});

test('nested artifact and partner envelopes share the final pretty-printed result budget', async t => {
  const fixture = rows(100).map(row => ({ ...row, Description: 'description '.repeat(120), Pid: 'Partner', LastModifiedTime: '/Date(1700000000000)/' }));
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { results: fixture } } }));
  const client = await connect(t, tenant);
  const grouped = await call(client, 'cpi_list_package_artifacts', { package_id: 'Fixture' });
  assert.ok(Buffer.byteLength(JSON.stringify(grouped, null, 2)) < 96 * 1024);
  for (const type of ['iflows', 'value_mappings', 'script_collections', 'message_mappings']) {
    const page = grouped[type];
    envelope(page);
    assert.equal(page.stop_reason, 'output_limit');
    assert.ok(page.next_cursor);
  }
  const selected = await call(client, 'cpi_list_package_artifacts', { package_id: 'Fixture', type: 'iflows', top: 100 });
  const resumed = await call(client, 'cpi_list_package_artifacts', { package_id: 'Fixture', type: 'iflows', top: 100, cursor: selected.next_cursor });
  assert.equal(resumed.items[0].Id, fixture[selected.returned].Id);
  const partner = await call(client, 'cpi_list_partner_parameters');
  assert.ok(Buffer.byteLength(JSON.stringify(partner, null, 2)) < 96 * 1024);
});

test('unknown counts never turn a server-capped nonempty page into a false traversal end', async t => {
  const fixture = rows(7);
  const tenant = await startFakeTenant(t, request => {
    const start = Number(request.query.get('$skip') ?? 0);
    return { status: 200, json: { d: { results: fixture.slice(start, start + 2) } } };
  });
  const pager = createCollectionPager(service(tenant), { root: '/api/v1' });
  const collected = [];
  let cursor;
  for (let index = 0; ; index += 1) {
    assert.ok(index < 6);
    const page = await pager.page({ path: '/Packages', top: 100, cursor });
    assert.equal(page.total, null);
    if (page.items.length) {
      assert.equal(page.complete, false);
      assert.ok(page.next_cursor);
      collected.push(...page.items);
    } else {
      assert.equal(page.complete, true);
      assert.equal(page.stop_reason, 'end');
    }
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(collected, fixture);
});

const mplWindow = { from: '2026-10-27T09:00:00.123Z', to: '2026-10-28T09:00:00.456Z' };
const mplGuid = 'MESSAGE000001';

test('MPL half-open millisecond window includes boundary and processing records; counts use identical filters', async t => {
  const fixtures = [
    { MessageGuid: 'from', LogStart: mplWindow.from, Status: 'COMPLETED' },
    { MessageGuid: 'processing', LogStart: '2026-10-27T12:00:00.124Z', Status: 'PROCESSING', ApplicationMessageId: 'business-id', IntegrationArtifact: { Id: 'Flow', Type: 'IFLOW', Content: 'private' } },
    { MessageGuid: 'unknown', LogStart: '2026-10-28T09:00:00.455Z', Status: 'FUTURE_STATUS' },
    { MessageGuid: 'to', LogStart: mplWindow.to, Status: 'FAILED' }
  ];
  const tenant = await startFakeTenant(t, request => {
    const filter = request.query.get('$filter');
    assert.match(filter, /LogStart ge datetime'2026-10-27T09:00:00\.123'/);
    assert.match(filter, /LogStart lt datetime'2026-10-28T09:00:00\.456'/);
    assert.doesNotMatch(filter, /LogEnd/);
    const status = /Status eq '([^']+)'/.exec(filter)?.[1];
    const selected = fixtures.filter(row => row.LogStart >= mplWindow.from && row.LogStart < mplWindow.to && (!status || row.Status === status));
    return request.path.endsWith('/$count') ? { status: 200, body: String(selected.length) }
      : { status: 200, json: { d: { __count: String(selected.length), results: selected } } };
  });
  const client = await connect(t, tenant);
  const filters = { ...mplWindow, iflow_id: 'Flow', correlation_id: "corr'1", application_message_id: 'business-id', custom_header: { name: 'order', value: "12'5" } };
  const page = await call(client, 'cpi_list_message_logs', filters);
  assert.deepEqual(page.items.map(row => row.MessageGuid), ['from', 'processing', 'unknown']);
  assert.equal(page.items[1].LogEnd, undefined);
  assert.equal(page.items[2].Status, 'FUTURE_STATUS');
  assert.deepEqual(page.items[1].IntegrationArtifact, { Id: 'Flow', Type: 'IFLOW' });
  const stats = await call(client, 'cpi_get_message_statistics', filters);
  assert.equal(stats.total, 3);
  assert.equal(stats.unclassified, 1);
  assert.equal(stats.complete, true);
  const requests = tenant.apiRequests();
  assert.equal(requests[0].query.get('$filter'), requests[1].query.get('$filter'));
  assert.ok(requests.every(request => request.query.get('filterCustomHeaderProperties') === "'order' eq '12''5'"));
});

test('MPL freezes default window in authenticated cursors and rejects changed inputs before network', async t => {
  const fixtures = Array.from({ length: 3 }, (_, index) => ({ MessageGuid: `GUID${index}`, LogStart: mplWindow.from }));
  const tenant = await startFakeTenant(t, request => ({ status: 200, json: { d: { __count: '3', results: fixtures.slice(Number(request.query.get('$skip') ?? 0)) } } }));
  const client = await connect(t, tenant);
  const first = await call(client, 'cpi_list_message_logs', { top: 1 });
  assert.equal(Date.parse(first.window.to) - Date.parse(first.window.from), 86400000);
  const second = await call(client, 'cpi_list_message_logs', { top: 1, cursor: first.next_cursor });
  assert.deepEqual(second.window, first.window);
  assert.equal(tenant.apiRequests()[0].query.get('$filter'), tenant.apiRequests()[1].query.get('$filter'));
  for (const args of [
    { from: mplWindow.from }, { from: mplWindow.to, to: mplWindow.from },
    { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
    { cursor: first.next_cursor, ...mplWindow },
    { cursor: first.next_cursor, correlation_id: 'changed' },
    { cursor: first.next_cursor.slice(0, -2) + 'xx' }
  ]) {
    const before = tenant.requests.length;
    const result = await client.callTool({ name: 'cpi_list_message_logs', arguments: args });
    assert.equal(result.isError, true);
    assert.equal(tenant.requests.length, before);
  }
});

test('MPL statistics cap concurrent counts at three and retain partial, inconsistent and no-traffic evidence', async t => {
  let active = 0;
  let maximum = 0;
  let mode = 'partial';
  const tenant = await startFakeTenant(t, async request => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active -= 1;
    const status = /Status eq '([^']+)'/.exec(request.query.get('$filter'))?.[1];
    if (mode === 'partial' && status === 'FAILED') return { status: 403, body: 'private-secret' };
    const count = mode === 'zero' ? 0 : !status ? 10 : mode === 'inconsistent' ? 2 : 1;
    return { status: 200, body: String(count) };
  });
  const client = await connect(t, tenant);
  const partial = await call(client, 'cpi_get_message_statistics', mplWindow);
  assert.equal(partial.complete, false);
  assert.equal(partial.failure_rate, null);
  assert.equal(partial.count_by_status.FAILED, null);
  assert.equal(partial.checks.FAILED.result, 'forbidden');
  assert.doesNotMatch(JSON.stringify(partial), /private-secret/);
  assert.ok(maximum <= 3 && maximum > 1);
  mode = 'inconsistent';
  const inconsistent = await call(client, 'cpi_get_message_statistics', mplWindow);
  assert.equal(inconsistent.coverage, 'inconsistent');
  assert.equal(inconsistent.failure_rate, null);
  mode = 'zero';
  const zero = await call(client, 'cpi_get_message_statistics', mplWindow);
  assert.equal(zero.coverage, 'no_traffic');
  assert.equal(zero.failure_rate, null);
});

test('MPL explicit earlier run, latest run freeze, run paging and step 201 preserve errors and reject foreign runs', async t => {
  const runs = [
    { Id: 'earlier', RunStart: '2026-10-27T09:00:00Z', OverallState: 'FAILED' },
    { Id: 'latest', RunStart: '2026-10-28T09:00:00Z', OverallState: 'COMPLETED' }
  ];
  const steps = Array.from({ length: 205 }, (_, index) => ({ StepId: `step${index + 1}`, StepStart: new Date(1700000000000 + index).toISOString(), Status: index === 200 ? 'FAILED' : 'COMPLETED', Error: index === 200 ? 'failure ' + 'x'.repeat(2000) : undefined }));
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/Runs')) return { status: 200, json: { d: { results: runs } } };
    if (request.path.includes('MessageProcessingLogRuns')) return { status: 200, json: { d: { results: request.path.includes('earlier') ? steps : [{ StepId: 'success1' }, { StepId: 'success2' }] } } };
    if (request.path.includes('MISSING00001')) return { status: 404 };
    return { status: 200, json: { d: { MessageGuid: mplGuid } } };
  });
  const client = await connect(t, tenant);
  const listed = await call(client, 'cpi_list_message_log_runs', { message_guid: mplGuid, top: 1 });
  assert.equal(listed.items[0].Id, 'latest');
  const next = await call(client, 'cpi_list_message_log_runs', { message_guid: mplGuid, top: 1, cursor: listed.next_cursor });
  assert.equal(next.items[0].Id, 'earlier');
  const latest = await call(client, 'cpi_get_message_log_steps', { message_guid: mplGuid, top: 1 });
  assert.equal(latest.run.Id, 'latest');
  runs.push({ Id: 'newest', RunStart: '2026-10-28T10:00:00Z' });
  const latestNext = await call(client, 'cpi_get_message_log_steps', { message_guid: mplGuid, top: 1, cursor: latest.next_cursor });
  assert.equal(latestNext.run.Id, 'latest');
  assert.equal(latestNext.items[0].StepId, 'success2');
  const beforeChanged = tenant.requests.length;
  const changed = await client.callTool({ name: 'cpi_get_message_log_steps', arguments: { message_guid: mplGuid, run_id: 'earlier', cursor: latest.next_cursor } });
  assert.equal(changed.isError, true);
  assert.equal(tenant.requests.length, beforeChanged);
  const first = await call(client, 'cpi_get_message_log_steps', { message_guid: mplGuid, run_id: 'earlier', top: 200 });
  assert.equal(first.items.length, 200);
  const second = await call(client, 'cpi_get_message_log_steps', { message_guid: mplGuid, run_id: 'earlier', top: 200, cursor: first.next_cursor });
  assert.equal(second.items[0].StepId, 'step201');
  assert.equal(second.items[0].Status, 'FAILED');
  assert.equal(second.items[0].error_truncated, true);
  assert.ok(Buffer.byteLength(second.items[0].Error) <= 1024);
  const before = tenant.apiRequests().filter(request => request.path.includes('MessageProcessingLogRuns')).length;
  const foreign = await client.callTool({ name: 'cpi_get_message_log_steps', arguments: { message_guid: mplGuid, run_id: 'foreign' } });
  assert.equal(foreign.isError, true);
  assert.equal(tenant.apiRequests().filter(request => request.path.includes('MessageProcessingLogRuns')).length, before);
  runs.length = 0;
  const empty = await call(client, 'cpi_get_message_log_steps', { message_guid: mplGuid });
  assert.equal(empty.outcome, 'no_runs');
  const missing = await client.callTool({ name: 'cpi_get_message_log_steps', arguments: { message_guid: 'MISSING00001' } });
  assert.equal(missing.isError, true);
});

test('MPL trace follows exact correlation only and never broadens an uncorrelated seed', async t => {
  let correlation = "exact'correlation";
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/Runs')) return { status: 200, json: { d: { results: [{ Id: 'run1' }] } } };
    if (request.path === '/api/v1/MessageProcessingLogs') {
      assert.match(request.query.get('$filter'), /CorrelationId eq 'exact''correlation'/);
      assert.doesNotMatch(request.query.get('$filter'), /ApplicationMessageId|IntegrationArtifact/);
      return { status: 200, json: { d: { __count: '1', results: [{ MessageGuid: mplGuid, CorrelationId: correlation }] } } };
    }
    return { status: 200, json: { d: { MessageGuid: mplGuid, CorrelationId: correlation, ApplicationMessageId: 'must-not-broaden', Payload: 'private' } } };
  });
  const client = await connect(t, tenant);
  const trace = await call(client, 'cpi_trace_message', { message_guid: mplGuid, ...mplWindow });
  assert.equal(trace.items[0].runs[0].Id, 'run1');
  assert.doesNotMatch(JSON.stringify(trace), /private/);
  correlation = '';
  const before = tenant.apiRequests().length;
  const alone = await call(client, 'cpi_trace_message', { message_guid: mplGuid, ...mplWindow });
  assert.equal(alone.stop_reason, 'no_correlation_id');
  assert.equal(alone.items.length, 1);
  assert.equal(tenant.apiRequests().length, before + 1);
});
