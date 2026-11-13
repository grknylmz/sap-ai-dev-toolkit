import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { IntegrationError } from '../src/integration-http.mjs';
import { registerCloudAlmTools } from '../src/cloud-alm-tools.mjs';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const LOGS = '/calm-logs/v1/logs';
const LANDSCAPE = '/calm-landscape/v1/landscapeObjects';
const DATA = '/calm-analytics/v1/analytics/providers/data';
const SITUATIONS = '/calm-event-situations/v1/event-situations';
const id = n => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1);
const B = id(2);

/** Fake MCP server + REST client; `responder(method, path, options)` returns a payload or undefined. */
function fixture(responder = () => undefined) {
  const registered = [];
  const server = { registerTool: (name, definition, handler) => {
    const schema = typeof definition.inputSchema?.parse === 'function' ? definition.inputSchema : z.object(definition.inputSchema);
    registered.push({ name, ...definition, handler: async args => handler(schema.parse(args ?? {})) });
  } };
  const requests = [];
  const rest = {
    request: async (method, path, options = {}) => {
      requests.push({ method, path, options });
      const reply = await responder(method, path, options);
      return reply === undefined ? [] : reply;
    }
  };
  const summary = { api_host: 'eu10.alm.cloud.sap', token_host: 'auth.example', auth: 'client_credentials', source: 'environment' };
  registerCloudAlmTools(server, { rest, summary, verify: async () => ({ landscape_api: 'ok' }), now: () => NOW });
  return { requests, byName: Object.fromEntries(registered.map(entry => [entry.name, entry])) };
}

const parse = result => JSON.parse(result.content[0].text);
const textOf = result => result.content.map(part => part.text).join('\n');
const nanos = iso => `${BigInt(Date.parse(iso)) * 1000000n}`;
const str = value => ({ stringValue: value });

function otlp(records, service = 'PRD') {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: str(service) }, { key: 'service.namespace', value: str('ABAP') }] },
      scopeLogs: [{ logRecords: records }]
    }]
  };
}

test('records input is validated before any request', async () => {
  const f = fixture();
  const cases = [
    [{ provider: 'im', service_ids: [A] }, /im records need categories: the labels shown in Integration Monitoring/],
    [{ provider: 'iep', service_ids: [A, B] }, /iep accepts exactly one service id/],
    [{ provider: 'exm.im', service_ids: [A], minutes: 90 }, /exm\.im records are limited to 60-minute windows; only bsm accepts up to 31 days/],
    [{ provider: 'im', service_ids: [A], categories: ['IDoc'], status: 'Error' }, /status applies only to provider exm\.im or exm\.jam/]
  ];
  for (const [args, message] of cases) {
    const result = await f.byName.calm_list_monitoring_records.handler(args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), message);
  }
  assert.equal(f.requests.length, 0);
});

test('im records send joined comma lists and flatten OTLP records', async () => {
  const f = fixture((method, path) => (path === LOGS ? {
    data: otlp([
      {
        timeUnixNano: nanos('2026-11-05T11:45:00.000Z'),
        severityText: 'ERROR',
        body: str('x'.repeat(3000)),
        attributes: [
          { key: 'count', value: { intValue: '42' } },
          { key: 'detail', value: { kvlistValue: { values: [{ key: 'iflow', value: str('Orders') }] } } }
        ]
      },
      { timeUnixNano: nanos('2026-11-05T11:46:00.000Z'), severityNumber: 9, body: str('ok') }
    ]),
    responseHeaders: { 'x-total-count': '5' }
  } : undefined));
  const result = parse(await f.byName.calm_list_monitoring_records.handler({
    provider: 'im',
    service_ids: [A, B],
    categories: ['SAP Integration Suite Messages', 'IDoc'],
    limit: 2
  }));
  const [request] = f.requests;
  assert.deepEqual(request.options.query, {
    provider: 'im',
    version: 'v2',
    format: 'protobuf-json',
    onLimit: 'TRUNCATE',
    serviceId: `${A},${B}`,
    category: 'SAP Integration Suite Messages,IDoc',
    from: '20261105113000',
    to: '20261105120000',
    limit: 2,
    offset: 0
  });
  assert.deepEqual(request.options.responseHeaders, ['x-total-count']);
  assert.deepEqual(result.window, { from: '2026-11-05T11:30:00.000Z', to: '2026-11-05T12:00:00.000Z' });
  assert.equal(result.total_count, 5);
  assert.equal(result.next_offset, 2);
  const [first, second] = result.records;
  assert.equal(first.attributes.count, 42);
  assert.deepEqual(first.attributes.detail, { iflow: 'Orders' });
  assert.equal(first.body, `${'x'.repeat(2048)}…`);
  assert.equal(first.time, '2026-11-05T11:45:00.000Z');
  assert.equal(first.service.name, 'PRD');
  assert.equal(second.severity, 9);
});

test('calm_query_analytics sums measures per dimension combination', async () => {
  const t1 = Date.parse('2026-11-05T10:00:00.000Z');
  const t2 = Date.parse('2026-11-05T11:00:00.000Z');
  const f = fixture((method, path) => (path === DATA ? [{
    serieName: 'query',
    totalCount: 10,
    count: 3,
    columns: [
      { text: 'time', type: 'time' },
      { text: 'IntegrationArtifactName', type: 'string' },
      { text: 'StatusGroup', type: 'string' },
      { text: 'Count', type: 'number' }
    ],
    rows: [[t1, 'Orders', 'Error', 2], [t2, 'Orders', 'Error', 3], [t1, 'Orders', 'Success', 7]]
  }] : undefined));
  const result = parse(await f.byName.calm_query_analytics.handler({
    provider: 'CPI_MESSAGES',
    dimensions: ['IntegrationArtifactName', 'StatusGroup'],
    measures: [{ measure: 'Count' }]
  }));
  assert.deepEqual(result.rows, [
    { IntegrationArtifactName: 'Orders', StatusGroup: 'Success', Count: 7 },
    { IntegrationArtifactName: 'Orders', StatusGroup: 'Error', Count: 5 }
  ]);
  assert.equal(result.truncated, true);
  assert.equal(result.total_rows, 10);
  const body = f.requests[0].options.json;
  assert.equal(body.format, 'table');
  assert.equal(body.tableType, 'raw');
  assert.deepEqual(body.timeRange, { from: '20261104120000', to: '20261105120000' });
  assert.equal(body.timezone, '+00:00');
});

test('landscape health groups tiers in the requested order and isolates a failing source', async () => {
  const [DEV, TST, PRD, ADM] = [id(11), id(12), id(13), id(14)];
  const landscape = [
    { lmsId: ADM, name: 'ADM', role: 'ADMIN' },
    { lmsId: PRD, name: 'PRD', role: 'PROD' },
    { lmsId: DEV, name: 'DEV', role: 'DEV' },
    { lmsId: TST, name: 'TST', role: 'TEST' }
  ];
  const f = fixture((method, path, options) => {
    if (path === LANDSCAPE) return landscape;
    if (path !== DATA) return undefined;
    const provider = options.json.queries[0].provider;
    if (provider === 'EXM_DATAPROVIDER') {
      return [{
        columns: [{ text: 'serviceId', type: 'string' }, { text: 'categoryName', type: 'string' }, { text: 'counter', type: 'number' }],
        rows: [[PRD, 'ABAP Runtime', 4], [DEV, 'ABAP Application Log', 1]]
      }];
    }
    if (provider === 'HM_ANALYTICS_DP') {
      return options.json.queries.map(query => ({
        columns: [{ text: 'metricName', type: 'string' }, { text: 'criticalStatus', type: 'number' }, { text: 'warningStatus', type: 'number' }],
        rows: query.name === PRD ? [['qRFC IN: Errors', 12, 0], ['bgRFC Errors', 0, 30]] : []
      }));
    }
    throw new IntegrationError('CLOUD_ALM POST /calm-analytics/v1/analytics/providers/data failed (HTTP 403): missing scope');
  });
  const result = parse(await f.byName.calm_get_landscape_health.handler({ roles: ['dev', 'TEST', 'prod'] }));
  assert.equal(result.matched, 3);
  assert.deepEqual(result.tiers.map(tier => [tier.role, tier.services.length]), [['DEV', 1], ['TEST', 1], ['PROD', 1]]);
  const prod = result.tiers[2];
  assert.deepEqual(prod.services[0].health, { critical: ['qRFC IN: Errors'], warning: ['bgRFC Errors'] });
  assert.deepEqual(prod.services[0].exceptions, { total: 4, by_category: [{ category: 'ABAP Runtime', count: 4 }] });
  assert.deepEqual(prod.totals, { services: 1, exceptions: 4, services_with_critical_metrics: 1, alerts: null });
  assert.equal(result.sources.exceptions.ok, true);
  assert.equal(result.sources.alerts.ok, false);
  assert.match(result.sources.alerts.error, /HTTP 403/);
  const hm = f.requests.find(request => request.options.json?.queries?.[0]?.provider === 'HM_ANALYTICS_DP').options.json;
  assert.equal(hm.queries.length, 3);
  assert.deepEqual(hm.queries.map(query => query.filters), [PRD, DEV, TST].map(lms => [{ key: 'serviceId', values: [lms] }]));
  assert.equal(hm.resolution, 'H');
});

test('landscape health refuses more than 30 services without analytics calls', async () => {
  const objects = Array.from({ length: 31 }, (_, index) => ({ lmsId: id(100 + index), role: 'PROD' }));
  const f = fixture((method, path) => (path === LANDSCAPE ? objects : undefined));
  const result = await f.byName.calm_get_landscape_health.handler({ roles: ['PROD'] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /covers at most 30 services; 31 matched/);
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});

test('triage keeps going past a failing section and returns CPI and SLG1 handoffs', async () => {
  const S = id(21);
  const f = fixture((method, path, options) => {
    if (path === LANDSCAPE) {
      return options.query.lmsId === S
        ? [{ lmsId: S, name: 'PRD', systemNumber: '000123', role: 'PROD', logicalSystems: [{ client: '100' }, { client: '200' }] }]
        : [];
    }
    if (path === LOGS && options.query.provider === 'iep') throw new IntegrationError('CLOUD_ALM GET /calm-logs/v1/logs failed (HTTP 403): missing scope');
    if (path === LOGS && options.query.provider === 'exm.im') {
      return { data: otlp([{ timeUnixNano: nanos('2026-11-05T11:50:00.000Z'), severityText: 'ERROR', body: str('Short dump') }]), responseHeaders: {} };
    }
    return undefined;
  });
  const result = parse(await f.byName.calm_triage_incident.handler({ service_id: S }));
  assert.match(result.alerts.error, /HTTP 403/);
  assert.equal(result.exceptions.records.length, 1);
  assert.equal(f.requests.find(request => request.options.query?.provider === 'exm.im').options.query.status, 'Error');
  assert.ok(result.messages.skipped);
  assert.deepEqual(result.handoff.abap.arguments, { from: '2026-11-04', to: '2026-11-06', messages: true });
  assert.deepEqual(result.handoff.abap.clients, ['100', '200']);
  assert.equal(result.handoff.abap.system, 'PRD');
  assert.equal(result.handoff.cpi.arguments.from, '2026-11-05T11:30:00.000Z');

  const unknown = fixture(() => []);
  const missing = await unknown.byName.calm_triage_incident.handler({ service_id: id(22) });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), new RegExp(`Cloud ALM landscape object ${id(22)} was not found`));
  assert.equal(unknown.requests.some(request => request.path === LOGS), false);
});

test('closing an event situation needs the exact confirmation and sends the notification header', async () => {
  const X = id(31);
  const f = fixture(method => (method === 'PUT' ? { status: 204, data: null } : undefined));
  const refused = await f.byName.calm_close_event_situation.handler({ event_situation_id: X, confirmation: 'yes' });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`confirmation must equal CLOSE CALM EVENT SITUATION ${X}`));
  assert.equal(f.requests.length, 0);

  const closed = parse(await f.byName.calm_close_event_situation.handler({
    event_situation_id: X,
    notify_ticketing: false,
    confirmation: `CLOSE CALM EVENT SITUATION ${X}`
  }));
  assert.deepEqual(closed, { closed: true, status: 204, event_situation_id: X, notify_ticketing: false });
  const [request] = f.requests;
  assert.equal(request.method, 'PUT');
  assert.equal(request.path, `${SITUATIONS}/${X}`);
  assert.deepEqual(request.options.json, { state: 'CLOSED' });
  assert.deepEqual(request.options.headers, { 'x-calm-notification': 'false' });

  await f.byName.calm_close_event_situation.handler({
    external_id: 'INC-4711',
    confirmation: 'CLOSE CALM EVENT SITUATION BY EXTERNAL ID INC-4711'
  });
  assert.equal(f.requests[1].path, `${SITUATIONS}/externalid/INC-4711`);
  assert.deepEqual(f.requests[1].options.headers, { 'x-calm-notification': 'true' });
});

test('transport lookup collects parent features from transports and references once', async () => {
  const F1 = { uuid: id(41), displayId: '6-42', title: 'Order API', statusCode: 'IN_TESTING', modifiedAt: '2026-11-01T08:00:00Z' };
  const F2 = { uuid: id(42), displayId: '6-43', title: 'Order UI', statusCode: 'IN_REALIZATION', modifiedAt: '2026-11-02T08:00:00Z' };
  const f = fixture((method, path) => {
    if (path.endsWith('/Transports')) return { value: [{ id: 'DEVK900123', parent: F1 }] };
    if (path.endsWith('/TransportReferences')) return { value: [{ id: 'DEVK900123', parent: F1 }, { id: 'DEVK900123', parent: F2 }] };
    return undefined;
  });
  const result = parse(await f.byName.calm_get_feature.handler({ transport_id: 'DEVK900123' }));
  assert.deepEqual(result.features.map(feature => [feature.uuid, feature.link]), [[F1.uuid, 'transport'], [F2.uuid, 'transport_reference']]);
  assert.equal(result.features[0].display_id, '6-42');
  for (const request of f.requests) {
    assert.equal(request.options.query.$filter, "id eq 'DEVK900123'");
    assert.equal(request.options.query.$expand, 'parent');
  }
});
