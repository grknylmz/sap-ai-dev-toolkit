// Read-only APIM analytics. This public V4 service is separate from Management.svc.
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, isoDate, timeWindow, top } from './integration-common.mjs';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { createCollectionPager, cursorSchema, decodeCollection } from './integration-collections.mjs';
import { registerApimInspectionTools } from './apim-inspection.mjs';

const ANALYTICS_ROOT = '/api/1.0/AnalyticsService';
const PATH = '/ResultsUTC';
const METRICS = Object.freeze([
  ['CallCount', 'total_calls'], ['SumErrors', 'total_errors'], ['SumPolicyError', 'total_policy_errors'],
  ['SumTargetError', 'total_target_errors'], ['SumResponseTime', 'total_response_time'], ['SumTargetResponseTime', 'total_target_response_time']
]);
// The service rejects derived aggregate aliases that collide with source entity properties.
const AGGREGATE = `$count as source_records,${METRICS.map(([name, alias]) => `${name} with sum as ${alias}`).join(',')},CreatedTime with max as data_through`;
const inputs = {
  from: isoDate, to: isoDate,
  proxy_names: z.array(z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/)).min(1).max(20).optional()
};
const pageInputs = { top: top(200, 100), cursor: cursorSchema };
const granularities = { minute: ['Minute', 60000], hour: ['Hour', 3600000], day: ['Day', 86400000] };

function selection(args) {
  const window = timeWindow(args.from, args.to);
  const predicates = [`CreatedTime ge ${window.from}`, `CreatedTime lt ${window.to}`];
  if (args.proxy_names) predicates.push(`(${args.proxy_names.map(name => `ApiProxy eq ${odataKey(name)}`).join(' or ')})`);
  return { window, filter: predicates.join(' and ') };
}
function number(value) {
  return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}
function timestamp(value) {
  return isoDate.safeParse(value).success ? new Date(value).toISOString() : null;
}
function metrics(row) {
  const values = Object.fromEntries(METRICS.map(([name, alias]) => [name, number(row?.[alias])]));
  const sourceRecords = number(row?.source_records);
  const empty = sourceRecords === 0 && METRICS.every(([, alias]) => row[alias] === null) && row.data_through === null;
  const calls = values.CallCount;
  const complete = empty || Number.isSafeInteger(sourceRecords) && Object.values(values).every(value => value !== null)
    && ['CallCount', 'SumErrors', 'SumPolicyError', 'SumTargetError'].every(name => Number.isSafeInteger(values[name]))
    && values.SumErrors <= calls && values.SumPolicyError <= calls && values.SumTargetError <= calls
    && (sourceRecords !== 0 || calls === 0) && (calls === 0 || timestamp(row?.data_through) !== null);
  return {
    source_records: Number.isSafeInteger(sourceRecords) ? sourceRecords : null,
    calls, errors: values.SumErrors, policy_errors: values.SumPolicyError, target_errors: values.SumTargetError,
    response_time_sum: values.SumResponseTime, target_response_time_sum: values.SumTargetResponseTime,
    error_rate: complete && calls > 0 ? values.SumErrors / calls : null,
    mean_response_time: complete && calls > 0 ? values.SumResponseTime / calls : null,
    mean_target_response_time: complete && calls > 0 ? values.SumTargetResponseTime / calls : null,
    data_through: timestamp(row?.data_through), metrics_complete: complete
  };
}
function coverage(window, dataThrough) {
  return {
    window, data_through: dataThrough,
    watermark_lag_ms: dataThrough === null ? null : Math.max(0, Date.parse(window.to) - Date.parse(dataThrough)),
    scope: 'service_reported_analytics', instantaneous_health: 'unverified',
    note: 'Source watermark is the latest reported analytics timestamp; analytics may be delayed. Response times retain service units.'
  };
}
function failure(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  return { result: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 || status === 501 ? 'unavailable' : 'error', status,
    ...(error?.code === 'INTEGRATION_DEADLINE' ? { stop_reason: 'deadline' } : {}) };
}

export function registerApimMonitoringTools(register, client) {
  const pager = createCollectionPager(client, { root: ANALYTICS_ROOT });
  register('apim_get_analytics', 'Get API Management analytics',
    'Read server-aggregated calls, errors and weighted mean response times for explicit UTC [from,to), at most 31 days. The data watermark may lag; no traffic is no_data, not healthy. No request URLs or personal data are returned.',
    inputs, READ_ONLY_ANNOTATIONS, async args => {
      const { window, filter } = selection(args);
      let decoded;
      try {
        decoded = decodeCollection(await client.request('GET', `${ANALYTICS_ROOT}${PATH}`, {
          query: { $apply: `filter(${filter})/aggregate(${AGGREGATE})` }, unwrap: false, deadline: Date.now() + 30000
        }));
      } catch (error) {
        return { window, complete: false, outcome: 'source_failure', source_result: failure(error), coverage: coverage(window, null) };
      }
      // An aggregate has zero or one row. Never sum a sampled/malformed multirow response locally.
      const sourceComplete = !decoded.next && (decoded.total === null || decoded.total === decoded.items.length) && decoded.items.length <= 1;
      const summary = metrics(decoded.items.length === 1 ? decoded.items[0] : null);
      const empty = decoded.items.length === 0 && sourceComplete;
      const complete = sourceComplete && (empty || summary.metrics_complete);
      return { window, ...summary, complete, outcome: !complete ? 'partial' : empty || summary.calls === 0 || summary.source_records === 0 ? 'no_data' : 'data',
        source_result: { result: 'ok', complete: sourceComplete }, coverage: coverage(window, summary.data_through) };
    });

  const grouped = (kind, args) => {
    const { window, filter } = selection(args);
    const series = kind === 'series';
    let grouping = 'ApiProxy,ResponseCode';
    if (series) {
      const [field, duration] = granularities[args.granularity];
      const buckets = Math.ceil(Date.parse(window.to) / duration) - Math.floor(Date.parse(window.from) / duration);
      if (buckets > 1000) throw new IntegrationError('The analytics series must not exceed 1000 requested time buckets');
      grouping = field;
    }
    const query = {
      $apply: `filter(${filter}${series ? '' : ' and ResponseCode ge 400'})/groupby((${grouping}),aggregate(${AGGREGATE}))`,
      $count: 'true'
    };
    // Authenticate and bind the cursor before entering the source-error boundary: invalid input is an error, not source failure.
    pager.validateCursor(args.cursor);
    return { window, grouping, query, series };
  };
  async function groupedPage(kind, args) {
    const { window, grouping, query, series } = grouped(kind, args);
    // page() rejects query/filter changes before network access; keep those errors visible to the caller.
    try {
      const page = await pager.page({ path: PATH, query, orderBy: grouping.split(',').map(name => `${name} asc`).join(','),
        top: args.top, cursor: args.cursor, fallback: false, deadline: Date.now() + 30000, maxBytes: 90 * 1024,
        project: row => ({ ...(series ? { bucket: timestamp(row[grouping]) } : {
          proxy_name: typeof row.ApiProxy === 'string' ? row.ApiProxy.slice(0, 100) : null,
          response_code: number(row.ResponseCode)
        }), ...metrics(row) }) });
      const metricsComplete = page.items.every(row => row.metrics_complete && (series ? row.bucket !== null : row.proxy_name !== null && Number.isInteger(row.response_code) && row.response_code >= 400));
      const dataThrough = page.items.map(row => row.data_through).filter(Boolean).sort().at(-1) ?? null;
      return { ...page, window, ...(series ? { granularity: args.granularity } : {}),
        complete: page.complete && metricsComplete, metrics_complete: metricsComplete,
        outcome: !metricsComplete || !['end', 'more'].includes(page.stop_reason) || page.source_result ? 'partial' : page.returned === 0 && page.complete ? 'no_data' : 'data',
        coverage: { ...coverage(window, dataThrough), watermark_scope: 'returned_groups', totals_scope: 'each_group_only' } };
    } catch (error) {
      if (error instanceof IntegrationError && /cursor|continuation/i.test(error.message)) throw error;
      return { window, items: [], returned: 0, total: null, complete: false, next_cursor: null,
        stop_reason: error?.code === 'INTEGRATION_DEADLINE' ? 'deadline' : 'source_limit',
        outcome: 'source_failure', source_result: failure(error), coverage: coverage(window, null) };
    }
  }
  register('apim_get_analytics_series', 'Get API Management analytics series',
    'Read paged V4 server aggregates grouped by Minute, Hour or Day, ordered by bucket. At most 1000 requested buckets and 200 rows per page. Means are weighted by calls; page metrics are not tenant totals.',
    { ...inputs, granularity: z.enum(['minute', 'hour', 'day']), ...pageInputs }, READ_ONLY_ANNOTATIONS,
    args => groupedPage('series', args));
  register('apim_get_api_error_breakdown', 'Get API Management error breakdown',
    'Read paged V4 server aggregates grouped by exact API proxy and response code >=400 for explicit UTC [from,to). Group count and continuation apply to this error grouping, not all calls.',
    { ...inputs, ...pageInputs }, READ_ONLY_ANNOTATIONS, args => groupedPage('errors', args));
  registerApimInspectionTools(register, client);
}
