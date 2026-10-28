import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const PATH = '/api/1.0/AnalyticsService/ResultsUTC';
const window = { from: '2026-10-27T09:00:00.123Z', to: '2026-10-28T09:00:00.123Z' };
async function analyticsTenant(t, handler) {
  return startFakeTenant(t, async request => {
    const aggregates = [...String(request.query.get('$apply')).matchAll(/\b([A-Za-z]\w*) with sum as ([A-Za-z]\w*)/g)];
    // Enforce the live service's derived-property collision rule, without pinning client-selected alias spelling.
    if (aggregates.some(([, source, alias]) => source === alias)) return { status: 400, body: '' };
    const response = await handler?.(request);
    if (!Array.isArray(response?.json?.value)) return response;
    return { ...response, json: { ...response.json, value: response.json.value.map(row => {
      const projected = { ...row };
      for (const [, source, alias] of aggregates) { projected[alias] = row[source]; delete projected[source]; }
      return projected;
    }) } };
  });
}
async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/apim-monitoring-test', APIM_SERVICE_KEY: tenant.serviceKey() } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'analytics-test', version: '1.0.0' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close().catch(() => {}); await runtime.close(); });
  return client;
}
async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}
function parsed(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}
function row(calls, responseSum, extra = {}) {
  return { source_records: 1, CallCount: calls, SumErrors: 0, SumPolicyError: 0, SumTargetError: 0,
    SumResponseTime: responseSum, SumTargetResponseTime: responseSum / 2,
    data_through: '2026-10-28T08:30:00.123Z', ...extra };
}

test('APIM aggregate uses server sums and exact escaped V4 predicates with source watermark', async t => {
  const tenant = await analyticsTenant(t, request => {
    assert.equal(request.path, PATH);
    assert.equal(request.method, 'GET');
    assert.equal(request.query.has('$select'), false);
    const apply = request.query.get('$apply');
    assert.match(apply, /CreatedTime ge 2026-10-27T09:00:00\.123Z and CreatedTime lt 2026-10-28T09:00:00\.123Z/);
    assert.match(apply, /ApiProxy eq 'O''Brien' or ApiProxy eq 'Orders'/);
    assert.ok(apply.includes('CreatedTime with max as data_through'));
    // Two conceptual buckets (1 call at 100 ms, 9 calls at 10 ms): mean is 19, not 55.
    return { status: 200, json: { value: [row('10', '190', { SumErrors: '2', SumPolicyError: '1', SumTargetError: '1', RequestUrl: 'SECRET_URL', DeveloperName: 'SECRET_PERSON', TargetUrl: 'SECRET_TARGET' })] } };
  });
  const client = await connect(t, tenant);
  const result = parsed(await call(client, 'apim_get_analytics', { ...window, proxy_names: ["O'Brien", 'Orders'] }));
  assert.equal(result.calls, 10);
  assert.equal(result.errors, 2);
  assert.equal(result.policy_errors, 1);
  assert.equal(result.target_errors, 1);
  assert.equal(result.mean_response_time, 19);
  assert.equal(result.mean_target_response_time, 9.5);
  assert.equal(result.error_rate, 0.2);
  assert.equal(result.complete, true);
  assert.equal(result.data_through, '2026-10-28T08:30:00.123Z');
  assert.equal(result.coverage.watermark_lag_ms, 1800000);
  assert.equal(result.coverage.instantaneous_health, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|RequestUrl|TargetUrl|DeveloperName|p95|p99/);
});

test('APIM zero, empty, partial aggregate and forbidden evidence never imply healthy traffic', async t => {
  let response = { status: 200, json: { value: [row(0, 0)] } };
  const tenant = await analyticsTenant(t, () => response);
  const client = await connect(t, tenant);
  let result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'no_data');
  assert.equal(result.error_rate, null);
  assert.equal(result.mean_response_time, null);
  response = { status: 200, json: { value: [row(null, null, { source_records: 0, SumErrors: null, SumPolicyError: null,
    SumTargetError: null, SumTargetResponseTime: null, data_through: null })] } };
  result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'no_data');
  assert.equal(result.source_records, 0);
  assert.equal(result.calls, null);
  assert.equal(result.complete, true);
  response.json.value[0].source_records = 1;
  result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.complete, false);
  response = { status: 200, json: { value: [] } };
  result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'no_data');
  assert.equal(result.calls, null);
  assert.equal(result.complete, true);
  response = { status: 200, json: { value: [row(10, 20, { SumErrors: null })] } };
  result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.complete, false);
  assert.equal(result.error_rate, null);
  response = { status: 200, json: { value: [row(1, 10), row(2, 20)] } };
  result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.calls, null);
  response = { status: 403, body: 'private-policy-value SECRET_PERSON' };
  result = parsed(await call(client, 'apim_get_analytics', window));
  assert.equal(result.outcome, 'source_failure');
  assert.equal(result.source_result.result, 'forbidden');
  assert.equal(result.source_result.status, 403);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /private-policy|SECRET_PERSON/);
});

test('APIM V4 error groups page all 215 identities without next-link and count only their groups', async t => {
  const groups = Array.from({ length: 215 }, (_, i) => row(i + 1, (i + 1) * 20, { ApiProxy: `Proxy${String(i).padStart(3, '0')}`, ResponseCode: 500,
    RequestUrl: 'SECRET_REQUEST', DeveloperName: 'SECRET_PERSON' }));
  const tenant = await analyticsTenant(t, request => {
    assert.equal(request.path, PATH);
    assert.match(request.query.get('$apply'), /ResponseCode ge 400\)\/groupby\(\(ApiProxy,ResponseCode\),aggregate\(/);
    assert.equal(request.query.get('$orderby'), 'ApiProxy asc,ResponseCode asc');
    assert.equal(request.query.get('$count'), 'true');
    const offset = Number(request.query.get('$skip') ?? 0);
    return { status: 200, json: { '@count': 215, value: groups.slice(offset, offset + Number(request.query.get('$top'))) } };
  });
  const client = await connect(t, tenant);
  let page = parsed(await call(client, 'apim_get_api_error_breakdown', { ...window, top: 3 }));
  assert.equal(page.total, 215);
  assert.equal(page.complete, false);
  assert.ok(page.next_cursor);
  const rows = [...page.items];
  while (page.next_cursor) {
    page = parsed(await call(client, 'apim_get_api_error_breakdown', { ...window, top: 200, cursor: page.next_cursor }));
    rows.push(...page.items);
  }
  assert.equal(page.complete, true);
  assert.equal(rows.length, 215);
  assert.equal(new Set(rows.map(item => item.proxy_name)).size, 215);
  assert.equal(rows.at(-1).calls, 215);
  assert.equal(rows.at(-1).mean_response_time, 20);
  assert.equal(page.coverage.totals_scope, 'each_group_only');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_|RequestUrl|DeveloperName/);
});

test('APIM series weights unequal buckets independently and uses stable grouped ordering', async t => {
  const tenant = await analyticsTenant(t, request => {
    assert.equal(request.path, PATH);
    assert.match(request.query.get('$apply'), /groupby\(\(Hour\),aggregate\(/);
    assert.equal(request.query.get('$orderby'), 'Hour asc');
    return { status: 200, json: { '@odata.count': 2, value: [row(1, 100, { Hour: '2026-10-27T10:00:00Z' }), row(9, 90, { Hour: '2026-10-27T11:00:00Z' })] } };
  });
  const client = await connect(t, tenant);
  const page = parsed(await call(client, 'apim_get_analytics_series', { ...window, granularity: 'hour' }));
  assert.equal(page.complete, true);
  assert.deepEqual(page.items.map(item => item.mean_response_time), [100, 10]);
  assert.equal(page.items[0].bucket, '2026-10-27T10:00:00.000Z');
  assert.equal(page.calls, undefined);
  assert.equal(page.coverage.watermark_scope, 'returned_groups');
});

test('APIM rejects invalid windows, proxy lists, bucket bounds and forged cursors before authentication', async t => {
  const tenant = await analyticsTenant(t);
  const client = await connect(t, tenant);
  const bad = [
    ['apim_get_analytics', { ...window, from: '2026-10-28T09:00:00' }],
    ['apim_get_analytics', { ...window, from: window.to }],
    ['apim_get_analytics', { ...window, from: '2026-08-01T00:00:00Z' }],
    ['apim_get_analytics', { ...window, proxy_names: [] }],
    ['apim_get_analytics', { ...window, proxy_names: Array(21).fill('Orders') }],
    ['apim_get_analytics', { ...window, proxy_names: ['bad\nname'] }],
    ['apim_get_analytics_series', { ...window, granularity: 'minute' }],
    ['apim_get_analytics_series', { ...window, granularity: 'hour', top: 201 }],
    ['apim_get_api_error_breakdown', { ...window, cursor: 'forged.cursor' }]
  ];
  for (const [name, args] of bad) assert.equal((await call(client, name, args)).isError, true, `${name}: ${JSON.stringify(args)}`);
  assert.equal(tenant.requests.length, 0);
});

test('APIM authenticated cursor rejects changed filters, grouping and window without further network', async t => {
  const tenant = await analyticsTenant(t, () => ({ status: 200, json: { '@count': 215, value: [row(1, 10, { ApiProxy: 'A', ResponseCode: 500 }), row(2, 20, { ApiProxy: 'B', ResponseCode: 500 })] } }));
  const client = await connect(t, tenant);
  const page = parsed(await call(client, 'apim_get_api_error_breakdown', { ...window, top: 1 }));
  assert.ok(page.next_cursor);
  const count = tenant.requests.length;
  for (const args of [{ ...window, proxy_names: ['Orders'] }, { ...window, to: '2026-10-28T08:00:00Z' }]) {
    assert.equal((await call(client, 'apim_get_api_error_breakdown', { ...args, cursor: page.next_cursor })).isError, true);
  }
  assert.equal((await call(client, 'apim_get_analytics_series', { ...window, granularity: 'hour', cursor: page.next_cursor })).isError, true);
  assert.equal(tenant.requests.length, count);
});

test('APIM unknown grouped count stays null and source failures preserve explicit partial evidence', async t => {
  let forbidden = false;
  const tenant = await analyticsTenant(t, request => {
    if (forbidden) return { status: 403, body: 'SECRET_SOURCE' };
    const offset = Number(request.query.get('$skip') ?? 0);
    return { status: 200, json: { value: offset === 0 ? [row(1, 20, { ApiProxy: 'Orders', ResponseCode: 500 })] : [] } };
  });
  const client = await connect(t, tenant);
  const first = parsed(await call(client, 'apim_get_api_error_breakdown', { ...window, top: 1 }));
  assert.equal(first.total, null);
  assert.equal(first.complete, false);
  assert.ok(first.next_cursor);
  const last = parsed(await call(client, 'apim_get_api_error_breakdown', { ...window, top: 1, cursor: first.next_cursor }));
  assert.equal(last.total, null);
  assert.equal(last.complete, true);
  forbidden = true;
  const failed = parsed(await call(client, 'apim_get_api_error_breakdown', window));
  assert.equal(failed.complete, false);
  assert.equal(failed.total, null);
  assert.equal(failed.outcome, 'source_failure');
  assert.equal(failed.source_result.result, 'forbidden');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_SOURCE/);
});
