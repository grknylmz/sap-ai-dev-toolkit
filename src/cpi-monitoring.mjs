// Payload-free Cloud Integration message monitoring and incident navigation.
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, ERROR_TEXT_CAP, capText, entity, isoDate, isoToOdataDateTime, key, pick, redactSecrets, timeWindow, top as topSchema } from './integration-common.mjs';
import { IntegrationError, odataDate, odataKey } from './integration-http.mjs';
import { createCollectionPager, cursorSchema, decodeCollection } from './integration-collections.mjs';
import { redactText } from './redact.mjs';
import { registerCpiAsyncMonitoringTools } from './cpi-async-monitoring.mjs';

export const MESSAGE_STATUSES = Object.freeze(['COMPLETED', 'PROCESSING', 'RETRY', 'ESCALATED', 'FAILED', 'CANCELLED', 'DISCARDED', 'ABANDONED']);
export const messageGuid = z.string().regex(/^[A-Za-z0-9_-]{10,64}$/);
export const mplFilterInputs = {
  iflow_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/).optional(),
  correlation_id: z.string().min(1).max(200).optional(),
  application_message_id: z.string().min(1).max(200).optional(),
  custom_header: z.object({ name: z.string().min(1).max(200), value: z.string().max(2000) }).strict().optional()
};
export const mplListInputs = {
  ...mplFilterInputs, status: z.enum(MESSAGE_STATUSES).optional(), from: isoDate.optional(), to: isoDate.optional(),
  top: topSchema(100, 20), cursor: cursorSchema
};
const pageInputs = { top: topSchema(200, 100), cursor: cursorSchema };
const scalarPick = (row, names) => Object.fromEntries(Object.entries(pick(row, names)).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
const dates = (row, names) => Object.fromEntries(Object.entries(scalarPick(row, names)).map(([name, value]) => [name, odataDate(value)]));
const time = value => Date.parse(odataDate(value)) || 0;
const emptyPage = () => ({ items: [], returned: 0, total: null, complete: true, next_cursor: null, stop_reason: 'end' });
const safeDiagnostic = value => redactText(value).replace(/https?:\/\/[^\s<>"']+/g, text => {
  try { const url = new URL(text); return `${url.origin}${url.pathname}`; } catch { return '[url withheld]'; }
});
const scopeOf = (tool, args) => JSON.stringify([tool, args.iflow_id ?? null, args.status ?? null, args.correlation_id ?? null, args.application_message_id ?? null, args.custom_header?.name ?? null, args.custom_header?.value ?? null]);

/** One exact filter contract for both MPL collections and count sources. */
export function messageLogQuery(args, window) {
  return {
    $filter: [
      `LogStart ge datetime'${isoToOdataDateTime(window.from)}'`,
      `LogStart lt datetime'${isoToOdataDateTime(window.to)}'`,
      args.iflow_id !== undefined && `IntegrationArtifact/Id eq ${odataKey(args.iflow_id)}`,
      args.status !== undefined && `Status eq ${odataKey(args.status)}`,
      args.correlation_id !== undefined && `CorrelationId eq ${odataKey(args.correlation_id)}`,
      args.application_message_id !== undefined && `ApplicationMessageId eq ${odataKey(args.application_message_id)}`
    ].filter(Boolean).join(' and '),
    ...(args.custom_header ? { filterCustomHeaderProperties: `${odataKey(args.custom_header.name)} eq ${odataKey(args.custom_header.value)}` } : {})
  };
}

/** Allowlist unknown observed status strings, never payload/navigation bodies. */
export function projectMessageLog(row) {
  const log = {
    ...scalarPick(row, ['MessageGuid', 'CorrelationId', 'ApplicationMessageId', 'IntegrationFlowName', 'Status', 'CustomStatus', 'Sender', 'Receiver']),
    ...dates(row, ['LogStart', 'LogEnd'])
  };
  if (row.IntegrationArtifact && typeof row.IntegrationArtifact === 'object') log.IntegrationArtifact = scalarPick(row.IntegrationArtifact, ['Id', 'Type']);
  for (const name of ['Sender', 'Receiver']) if (typeof log[name] === 'string' && /^https?:\/\//i.test(log[name])) log[name] = safeDiagnostic(log[name]);
  return log;
}
export const projectMessageRun = row => ({
  ...scalarPick(row, ['Id', 'OverallState', 'LogLevel']),
  ...dates(row, ['RunStart', 'RunStop'])
});
export function projectMessageStep(row) {
  const error = capText(safeDiagnostic(row.Error ?? ''), 1024);
  return { ...scalarPick(row, ['StepId', 'ModelStepId', 'Activity', 'Status']), Error: error.text || null, error_truncated: error.truncated, ...dates(row, ['StepStart', 'StepStop']) };
}

/** Authenticate the cursor before recovering the frozen default window. */
export function messageLogWindow(pager, args, scope) {
  if ((args.from === undefined) !== (args.to === undefined)) throw new IntegrationError('from and to must be supplied together');
  const context = pager.cursorContext(args.cursor, { scope });
  const supplied = args.from === undefined ? null : timeWindow(args.from, args.to);
  if (context) {
    const window = timeWindow(context.window?.from, context.window?.to);
    if (supplied && (supplied.from !== window.from || supplied.to !== window.to)) throw new IntegrationError('The monitoring window changed; restart the listing');
    return window;
  }
  const now = Date.now();
  return supplied ?? timeWindow(new Date(now - 86400000).toISOString(), new Date(now).toISOString());
}
export async function listMessageLogs(pager, args, { scope = scopeOf('mpl', args), maxBytes = 94 * 1024, deadline } = {}) {
  const window = messageLogWindow(pager, args, scope);
  const page = await pager.page({ path: '/MessageProcessingLogs', query: { ...messageLogQuery(args, window), $inlinecount: 'allpages' },
    top: args.top, cursor: args.cursor, scope, context: { window }, orderBy: 'LogStart desc', identity: 'MessageGuid', consistency: 'best_effort',
    project: projectMessageLog, maxBytes, deadline });
  return { ...page, window };
}

/** Shared named MPL read; callers supply the service-root-pinned GET and pager. */
export async function getMessageLogSeed(read, guid) {
  const row = entity(await read(`/MessageProcessingLogs(${key(guid)})`));
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.MessageGuid !== guid) throw new IntegrationError('Message not found or invalid MPL metadata');
  if (Buffer.byteLength(JSON.stringify(projectMessageLog(row), null, 2)) > 4096) throw new IntegrationError('MPL identity metadata exceeds the safe size limit');
  return row;
}

export async function getMessageLog(read, pager, guid) {
  const path = `/MessageProcessingLogs(${key(guid)})`;
  const log = projectMessageLog(await getMessageLogSeed(read, guid));
  const text = await read(`${path}/ErrorInformation/$value`, { responseType: 'text', accept: '*/*', expect: [200, 204, 404] });
  const error = capText(safeDiagnostic(text ?? ''), ERROR_TEXT_CAP);
  const headersPage = await pager.page({ path: `${path}/CustomHeaderProperties`, mode: 'local', top: 200, sourceComplete: false,
    maxBytes: 60 * 1024, project: row => redactSecrets(scalarPick(row, ['Name', 'Value'])) });
  return { log, error_information: error.text || null, error_information_truncated: error.truncated,
    custom_header_properties: headersPage.items, custom_header_properties_complete: headersPage.complete, custom_header_properties_truncated: headersPage.stop_reason !== 'end' };
}

const sourceFailure = error => ({ result: error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : [404, 501].includes(error?.status) ? 'unavailable' : 'error', ...(Number.isInteger(error?.status) ? { status: error.status } : {}), ...(error?.code === 'INTEGRATION_DEADLINE' ? { stop_reason: 'deadline' } : {}) });

/** Exact tenant counts, independently checked with no more than three in flight. */
export async function getMessageStatistics(client, args, { deadline = Date.now() + 30000 } = {}) {
  const window = timeWindow(args.from, args.to);
  const labels = ['total', ...MESSAGE_STATUSES];
  const counts = {};
  const checks = {};
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < labels.length) {
      const label = labels[next++];
      try {
        const text = await client.request('GET', '/api/v1/MessageProcessingLogs/$count', { query: messageLogQuery({ ...args, status: label === 'total' ? undefined : label }, window), responseType: 'text', deadline });
        if (typeof text !== 'string' || !/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text.trim()))) throw new IntegrationError('Invalid MPL count response');
        counts[label] = Number(text.trim());
        checks[label] = { result: 'ok' };
      } catch (error) { counts[label] = null; checks[label] = sourceFailure(error); }
    }
  }));
  const allCounts = labels.every(label => counts[label] !== null);
  const classified = allCounts ? MESSAGE_STATUSES.reduce((sum, label) => sum + counts[label], 0) : null;
  const consistent = allCounts && Number.isSafeInteger(classified) && classified <= counts.total;
  const complete = allCounts && consistent;
  return { window, total: counts.total, count_by_status: Object.fromEntries(MESSAGE_STATUSES.map(label => [label, counts[label]])),
    unclassified: complete ? counts.total - classified : null, checks, complete,
    coverage: !allCounts ? 'partial' : !consistent ? 'inconsistent' : counts.total === 0 ? 'no_traffic' : 'complete',
    failure_rate_statuses: ['FAILED', 'ESCALATED', 'ABANDONED'],
    failure_rate: complete && counts.total > 0 ? (counts.FAILED + counts.ESCALATED + counts.ABANDONED) / counts.total : null };
}

export function registerCpiMonitoringTools(register, client) {
  const cpi = (path, options) => client.request('GET', `/api/v1${path}`, options);
  const pager = createCollectionPager(client, { root: '/api/v1', request: (_method, path, options) => cpi(path, options) });
  const getSeed = guid => getMessageLogSeed(cpi, guid);
  async function readRuns(guid) {
    const raw = await cpi(`/MessageProcessingLogs(${key(guid)})/Runs`, { unwrap: false });
    const decoded = decodeCollection(raw);
    return { raw, ...decoded, complete: !decoded.next && decoded.total !== null && decoded.total === decoded.items.length };
  }
  register('cpi_list_message_logs', 'List message processing logs',
    'List bounded MPL metadata in a fixed UTC [from,to) LogStart window of at most 31 days. Supply both timestamps or neither (frozen last 24 hours). Continuations retain that window; traversal is best effort.',
    mplListInputs, READ_ONLY_ANNOTATIONS, args => listMessageLogs(pager, args));

  register('cpi_get_message_statistics', 'Get message statistics',
    'Count total and eight known MPL statuses for the exact explicit UTC [from,to) window, at most 31 days. Partial/inconsistent counts have no overall failure rate; zero messages means no traffic.',
    { ...mplFilterInputs, from: isoDate, to: isoDate }, READ_ONLY_ANNOTATIONS, args => getMessageStatistics(client, args));

  register('cpi_get_message_log', 'Get message processing log',
    'Read allowlisted MPL metadata, bounded error text and custom header properties. Payload attachments are never read; credential-shaped header values are withheld.',
    { message_guid: messageGuid }, READ_ONLY_ANNOTATIONS, ({ message_guid }) => getMessageLog(cpi, pager, message_guid));

  register('cpi_list_message_log_runs', 'List message processing runs',
    'Page bounded run identities and status metadata for one existing message. Missing messages and messages with no runs are distinct. Run navigation completeness remains explicit.',
    { message_guid: messageGuid, ...pageInputs }, READ_ONLY_ANNOTATIONS, async ({ message_guid, ...args }) => {
      const scope = `runs:${message_guid}`;
      pager.validateCursor(args.cursor, { scope });
      await getSeed(message_guid);
      const page = await pager.page({ ...args, path: `/MessageProcessingLogs(${key(message_guid)})/Runs`, mode: 'local', sourceComplete: false, scope,
        sort: (a, b) => time(b.RunStart) - time(a.RunStart), project: projectMessageRun });
      const noRuns = page.returned === 0 && !page.source_result && (await readRuns(message_guid)).items.length === 0;
      return { ...page, message_guid, ...(noRuns ? { outcome: 'no_runs' } : {}) };
    });

  register('cpi_get_message_log_steps', 'Get message processing steps',
    'Page run-step metadata ordered by start time. An explicit run must belong to the message; omission freezes the latest observed run across pages. Error text is bounded; payloads are never read.',
    { message_guid: messageGuid, run_id: z.string().min(1).max(200).optional(), ...pageInputs }, READ_ONLY_ANNOTATIONS, async ({ message_guid, run_id, ...args }) => {
      const scope = JSON.stringify(['steps', message_guid, run_id ?? null]);
      const context = pager.cursorContext(args.cursor, { scope });
      await getSeed(message_guid);
      const runs = await readRuns(message_guid);
      if (!runs.items.length) return { ...emptyPage(), complete: runs.complete, stop_reason: runs.complete ? 'end' : 'source_limit', outcome: 'no_runs', run: null, message_guid };
      const selectedId = context?.run_id ?? run_id;
      const selected = selectedId === undefined ? runs.items.reduce((best, row) => time(row.RunStart) > time(best.RunStart) ? row : best) : runs.items.find(row => String(row.Id) === selectedId);
      if (!selected) throw new IntegrationError(runs.complete ? 'run_id does not belong to this message' : 'run_id was not found in the bounded message runs; membership is unverified');
      if (!['string', 'number'].includes(typeof selected.Id) || !String(selected.Id).length || String(selected.Id).length > 200) throw new IntegrationError('Invalid message run identity');
      const run = projectMessageRun(selected);
      const metadataBytes = Buffer.byteLength(JSON.stringify({ run, message_guid }, null, 2)) + 1024;
      if (metadataBytes > 94 * 1024) return { ...emptyPage(), complete: false, stop_reason: 'output_limit', run: null, run_metadata_truncated: true, message_guid };
      const page = await pager.page({ ...args, path: `/MessageProcessingLogRuns(${key(selected.Id)})/RunSteps`, mode: 'local', sourceComplete: false,
        scope, context: { run_id: String(selected.Id) }, maxBytes: 95 * 1024 - metadataBytes,
        sort: (a, b) => time(a.StepStart) - time(b.StepStart), project: projectMessageStep });
      return { ...page, run, message_guid, runs_complete: runs.complete };
    });

  register('cpi_trace_message', 'Trace correlated messages',
    'Follow only the seed message’s exact nonempty CorrelationId inside an explicit UTC [from,to) window. Return bounded message/artifact identities and allowlisted run metadata when present; never infer business-ID or APIM relationships.',
    { message_guid: messageGuid, from: isoDate, to: isoDate, top: topSchema(100, 20), cursor: cursorSchema }, READ_ONLY_ANNOTATIONS,
    async ({ message_guid, ...args }) => {
      const scope = `trace:${message_guid}`;
      // Invalid or changed cursors must fail before even the seed request.
      const window = messageLogWindow(pager, args, scope);
      const context = pager.cursorContext(args.cursor, { scope });
      const seed = projectMessageLog(await getSeed(message_guid));
      const correlation = seed.CorrelationId;
      if (context?.correlation_id !== undefined && context.correlation_id !== correlation) return { ...emptyPage(), complete: false, stop_reason: 'source_changed', window, seed };
      if (typeof correlation !== 'string' || !correlation.trim()) return { ...emptyPage(), items: [seed], returned: 1, total: 1, stop_reason: 'no_correlation_id', window, seed };
      const page = await pager.page({ path: '/MessageProcessingLogs', query: { ...messageLogQuery({ correlation_id: correlation }, window), $inlinecount: 'allpages' },
        top: args.top, cursor: args.cursor, scope, context: { window, correlation_id: correlation }, orderBy: 'LogStart desc', consistency: 'best_effort', identity: 'MessageGuid',
        project: projectMessageLog, maxBytes: 90 * 1024 });
      const run_checks = [];
      // Run identities are independently bounded; unreadable runs never hide healthy message evidence.
      const items = [];
      for (const item of page.items) {
        try {
          const runs = await readRuns(item.MessageGuid);
          items.push({ ...item, runs: runs.items.slice(0, 10).map(projectMessageRun), runs_complete: runs.complete && runs.items.length <= 10 });
          run_checks.push({ message_guid: item.MessageGuid, result: 'ok' });
        } catch (error) { items.push({ ...item, runs: [], runs_complete: false }); run_checks.push({ message_guid: item.MessageGuid, ...sourceFailure(error) }); }
      }
      // Reserve a fixed run budget per page instead of letting ancillary metadata exceed the output envelope.
      if (Buffer.byteLength(JSON.stringify({ ...page, items, seed, run_checks }, null, 2)) > 95 * 1024) {
        return { ...page, complete: false, stop_reason: page.stop_reason === 'end' ? 'source_limit' : page.stop_reason, related_messages_complete: page.complete, seed, run_checks: [], runs_omitted: true, window };
      }
      const runsComplete = items.every(item => item.runs_complete);
      return { ...page, complete: page.complete && runsComplete, stop_reason: page.stop_reason === 'end' && !runsComplete ? 'source_limit' : page.stop_reason,
        related_messages_complete: page.complete, items, seed, run_checks, window };
    });

  registerCpiAsyncMonitoringTools(register, client);
}
