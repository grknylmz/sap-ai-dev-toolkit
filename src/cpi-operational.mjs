// On-demand management signals, not a background monitor or receiver-side health proof.
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, isoDate, timeWindow } from './integration-common.mjs';
import { createCollectionPager } from './integration-collections.mjs';
import { getMessageStatistics } from './cpi-monitoring.mjs';
import { readCpiDataStores, readCpiJmsQueues, readCpiJmsBrokerStatus } from './cpi-async-monitoring.mjs';
import { readCertificateHealth } from './cpi-security.mjs';

const pageFailure = error => ({ result: error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : [404, 501].includes(error?.status) ? 'unavailable' : 'error',
  status: Number.isInteger(error?.status) ? error.status : null,
  stop_reason: error?.code === 'INTEGRATION_DEADLINE' ? 'deadline' : 'source_limit' });

async function observePages(read, inspect, deadline) {
  let cursor;
  let observed = 0;
  let pages = 0;
  try {
    for (;;) {
      if (Date.now() >= deadline) return { result: 'error', complete: false, observed, stop_reason: 'deadline' };
      const page = await read(cursor);
      for (const item of page.items ?? []) { inspect(item); observed += 1; }
      pages += 1;
      if (page.source_result && page.source_result.result !== 'ok') return { ...page.source_result, complete: false, observed, stop_reason: page.stop_reason };
      if (!page.next_cursor) return { result: 'ok', complete: page.complete, observed, stop_reason: page.stop_reason };
      if (pages >= 20 || observed >= 2000) return { result: 'ok', complete: false, observed, stop_reason: 'source_limit' };
      cursor = page.next_cursor;
    }
  } catch (error) { return { ...pageFailure(error), complete: false, observed }; }
}

export async function getOperationalSummary(client, args, { summary = {}, deadline = Date.now() + 30000 } = {}) {
  const window = timeWindow(args.from, args.to);
  const evaluated_at = new Date().toISOString();
  const findings = [];
  let findings_truncated = false;
  const add = (kind, identity, detail) => {
    if (findings.length >= 100) { findings_truncated = true; return; }
    findings.push({ kind, identity: String(identity ?? '').slice(0, 255), ...detail });
  };
  let degraded = false;
  let unknown = false;
  const targets = args.iflow_ids ? new Set(args.iflow_ids) : null;
  const runtimeIds = new Set();
  const runtimePager = createCollectionPager(client, { root: '/api/v1' });
  const counts = { runtime_errors: 0, queues_warning: 0, queues_critical: 0, queues_stopped: 0, queues_unknown: 0, overdue_stores: 0,
    overdue_messages: 0, certificates_expired: 0, certificates_not_yet_valid: 0, certificates_expiring: 0, certificates_unknown: 0 };
  const sources = {};
  // Independent reads share one deadline; an inaccessible source never hides healthy-source evidence.
  await Promise.all([
    (async () => {
      sources.runtime = await observePages(cursor => runtimePager.page({ path: '/IntegrationRuntimeArtifacts', top: 500, cursor, orderBy: 'Id', deadline,
        project: row => Object.fromEntries(['Id', 'Version', 'Status'].map(name => [name, typeof row[name] === 'string' ? row[name].slice(0, 200) : null])) }), row => {
        if (targets && !targets.has(row.Id)) return;
        runtimeIds.add(row.Id);
        if (row.Status === 'ERROR') { degraded = true; counts.runtime_errors += 1; add('runtime_error', row.Id, { version: row.Version ?? null, status: row.Status }); }
        else if (!['STARTED', 'STARTING', 'STOPPING'].includes(row.Status)) unknown = true;
      }, deadline);
      if (targets && [...targets].some(id => !runtimeIds.has(id))) unknown = true;
    })(),
    (async () => {
      sources.stores = await observePages(cursor => readCpiDataStores(client, { top: 200, cursor, deadline }), row => {
        if (targets && row.IntegrationFlow !== '' && !targets.has(row.IntegrationFlow)) return;
        if (row.NumberOfOverdueMessages === null) unknown = true;
        else if (row.NumberOfOverdueMessages > 0) {
          degraded = true; counts.overdue_stores += 1; counts.overdue_messages += row.NumberOfOverdueMessages;
          add('overdue_store', row.DataStoreName, { integration_flow: row.IntegrationFlow, messages: row.NumberOfMessages, overdue: row.NumberOfOverdueMessages });
        }
      }, deadline);
    })(),
    (async () => {
      sources.queues = await observePages(cursor => readCpiJmsQueues(client, { top: 200, cursor, deadline }), row => {
        if (row.State === 1 || row.State === 2) { degraded = true; counts[row.State === 1 ? 'queues_warning' : 'queues_critical'] += 1; add('queue_state', row.Name, { state: row.state }); }
        if (row.Active === 0) { degraded = true; counts.queues_stopped += 1; add('stopped_queue', row.Name, { active: 0 }); }
        if (row.state === 'unknown' || row.Active === null) { unknown = true; counts.queues_unknown += 1; }
      }, deadline);
    })(),
    (async () => {
      sources.certificates = await observePages(cursor => readCertificateHealth(client, { top: 200, cursor, warning_days: args.certificate_warning_days ?? 30, deadline, evaluated_at }), row => {
        const validity = row.validity;
        if (['expired', 'not_yet_valid', 'expiring'].includes(validity)) {
          degraded = true; counts[`certificates_${validity}`] += 1;
          add('certificate_validity', row.alias ?? row.Alias, { validity, days_remaining: row.days_remaining ?? null });
        } else if (validity !== 'valid') { unknown = true; counts.certificates_unknown += 1; }
      }, deadline);
    })(),
    (async () => {
      try {
        const broker = await readCpiJmsBrokerStatus(client, { deadline });
        sources.broker = { source_results: broker.source_results, complete: broker.complete,
          broker: broker.broker, warning_queue_count: broker.unhealthy_queue_count, stopped_queue_count: broker.stopped_queue_count };
        if (Object.values(broker.source_results ?? {}).some(source => source.result !== 'ok') || broker.complete !== true) unknown = true;
        for (const flag of ['CapacityWarning', 'CapacityError', 'IsQueuesHigh', 'IsMessageSpoolHigh', 'IsTransactedSessionsHigh', 'IsConsumersHigh', 'IsProducersHigh']) {
          if (broker.broker?.[flag] === 1) { degraded = true; add('broker_limit', 'Broker1', { flag }); }
          else if (broker.broker?.[flag] !== 0) unknown = true;
        }
        for (const queue of broker.unhealthy_queues?.items ?? []) {
          if ([1, 2].includes(queue.State)) { degraded = true; add('broker_queue_state', queue.Name, { state: queue.State }); }
        }
        for (const queue of broker.stopped_queues?.items ?? []) { degraded = true; add('broker_stopped_queue', queue.Name, {}); }
      } catch (error) { sources.broker = { ...pageFailure(error), complete: false }; unknown = true; }
    })(),
    (async () => {
      const statistics = [];
      for (const iflow_id of args.iflow_ids ?? [undefined]) {
        const result = await getMessageStatistics(client, { ...window, ...(iflow_id ? { iflow_id } : {}) }, { deadline });
        statistics.push({ ...(iflow_id ? { iflow_id } : {}), ...result });
        for (const status of ['FAILED', 'ESCALATED', 'ABANDONED', 'RETRY']) {
          const count = result.count_by_status[status];
          if (count > 0) { degraded = true; add('message_status', iflow_id ?? 'tenant', { status, count }); }
        }
        if (!result.complete || result.total === 0 || result.unclassified > 0) unknown = true;
      }
      sources.messages = { complete: statistics.every(result => result.complete), items: statistics };
    })()
  ]);
  for (const name of ['runtime', 'stores', 'queues', 'certificates']) if (sources[name]?.complete !== true || sources[name]?.result !== 'ok') unknown = true;
  return { environment: summary.environment ?? 'default', hosts: { cpi: summary.cpi?.host ?? new URL(client.origin).host },
    evaluated_at, window, iflow_ids: args.iflow_ids ?? null, health_scope: 'observed_management_signals',
    health: degraded ? 'degraded' : unknown ? 'unknown' : 'no_issues_observed', counts, findings, findings_truncated, sources,
    continuous_monitoring: 'unverified', receiver_side_processing: 'unverified' };
}

export function registerCpiOperationalTools(register, client, { summary = {} } = {}) {
  register('cpi_get_operational_summary', 'Get CPI operational management snapshot',
    'Read an on-demand bounded snapshot of runtime, exact message counts, JMS limits/stopped queues, overdue stores and certificate validity. No traffic or missing sources is unknown unless an issue already establishes degraded. This is not continuous monitoring or receiver-side health proof.',
    { from: isoDate, to: isoDate, iflow_ids: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/)).min(1).max(20).optional(),
      certificate_warning_days: z.number().int().min(1).max(365).default(30) }, READ_ONLY_ANNOTATIONS,
    args => getOperationalSummary(client, args, { summary }));
}
