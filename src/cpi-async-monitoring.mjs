// Metadata-only diagnosis of CPI asynchronous processing. No queue/store message content is read.
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, key, top as topSchema } from './integration-common.mjs';
import { IntegrationError, odataDate } from './integration-http.mjs';
import { createCollectionPager, cursorSchema, decodeCollection } from './integration-collections.mjs';

const ROOT = '/api/v1';
const PAGE_BYTES = 88 * 1024;
const SOURCE_BYTES = 2 * 1024 * 1024;
const collectionInputs = { top: topSchema(200, 100), cursor: cursorSchema };
const exactFilters = { integration_flow: z.string().max(200).optional(), visibility: z.string().max(100).optional() };
const BROKER_NUMBERS = ['Capacity', 'MaxCapacity', 'QueueNumber', 'MaxQueueNumber'];
const BROKER_FLAGS = ['CapacityOk', 'CapacityWarning', 'CapacityError', 'IsQueuesHigh', 'IsMessageSpoolHigh', 'IsTransactedSessionsHigh', 'IsConsumersHigh', 'IsProducersHigh'];
const text = value => typeof value === 'string' ? value.slice(0, 512) : null;
const number = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export const normalizeCpiFlag = value => value === true || value === 1 || value === '1' || value === 'true' ? 1
  : value === false || value === 0 || value === '0' || value === 'false' ? 0 : null;
const selectText = (row, fields) => Object.fromEntries(fields.filter(field => row?.[field] !== undefined).map(field => [field, text(row[field])]));
function dates(row, fields) {
  return Object.fromEntries(fields.filter(field => row?.[field] !== undefined).map(field => {
    let value;
    try { value = odataDate(row[field]); } catch { value = null; }
    return [field, typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null];
  }));
}
export function projectCpiDataStore(row) {
  return { ...selectText(row, ['DataStoreName', 'IntegrationFlow', 'Type', 'Visibility']),
    NumberOfMessages: number(row?.NumberOfMessages), NumberOfOverdueMessages: number(row?.NumberOfOverdueMessages) };
}
export function projectCpiJmsQueue(row) {
  const state = number(row?.State);
  return { ...selectText(row, ['Name', 'Type']), NumbOfMsgs: number(row?.NumbOfMsgs), Size: number(row?.Size),
    State: state, state: state === 0 ? 'healthy' : state === 1 ? 'warning' : state === 2 ? 'critical' : 'unknown',
    FillGrade: number(row?.FillGrade), Active: normalizeCpiFlag(row?.Active), Exclusive: normalizeCpiFlag(row?.Exclusive) };
}
export function projectCpiVariable(row) {
  return { ...selectText(row, ['Name', 'VariableName', 'IntegrationFlow', 'Visibility']), ...dates(row, ['UpdatedAt', 'RetainUntil']) };
}
function projectEntry(row) {
  return { ...selectText(row, ['Id', 'Status', 'MessageId']), ...dates(row, ['DueAt', 'CreatedAt', 'RetainUntil']),
    ...(typeof row?.MessageId === 'string' && row.MessageId ? { message_log_link: 'unverified' } : {}) };
}
function sourceFailure(error) {
  const status = Number.isInteger(error?.status) ? error.status : Number(/HTTP (\d{3})\b/.exec(error?.message ?? '')?.[1]) || null;
  const stop_reason = error?.code === 'INTEGRATION_DEADLINE' ? 'deadline' : /safe size limit/.test(error?.message ?? '') ? 'source_limit' : null;
  return { result: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 || status === 501 ? 'unavailable' : 'error',
    ...(status ? { status } : {}), ...(stop_reason ? { stop_reason } : {}) };
}
const emptyPage = failure => ({ items: [], returned: 0, total: null, complete: false, next_cursor: null,
  stop_reason: failure.stop_reason ?? 'source_limit', source_result: failure });
function service(client) {
  const request = (method, path, options) => client.request(method, `${ROOT}${path}`, options);
  return { request, pager: createCollectionPager(client, { root: ROOT, request }) };
}
async function pageSafely(pager, options) {
  try {
    const page = await pager.page(options);
    return !page.source_result && !page.complete && !page.next_cursor && ['deadline', 'source_limit'].includes(page.stop_reason)
      ? { ...page, source_result: { result: 'error', stop_reason: page.stop_reason } } : page;
  }
  catch (error) {
    // Cursor validation is a local input error, not evidence about the tenant.
    if (/collection cursor/.test(error?.message ?? '')) throw new IntegrationError('Invalid or expired collection cursor; restart the listing');
    return emptyPage(sourceFailure(error));
  }
}
const matches = ({ integration_flow, visibility }) => row => (integration_flow === undefined || row.IntegrationFlow === integration_flow)
  && (visibility === undefined || row.Visibility === visibility);

/** Shared bounded metadata helpers; deadline is the transport's absolute internal deadline. */
export async function readCpiDataStores(client, { top = 100, cursor, integration_flow, visibility, overdue_only = false, deadline } = {}) {
  const { pager } = service(client);
  const exact = matches({ integration_flow, visibility });
  return pageSafely(pager, { path: '/DataStores', mode: 'local', top, cursor, deadline, maxBytes: PAGE_BYTES,
    identity: { integration_flow, visibility, overdue_only },
    filter: row => exact(row) && (!overdue_only || number(row.NumberOfOverdueMessages) > 0), project: projectCpiDataStore });
}
export async function readCpiVariables(client, { top = 100, cursor, integration_flow, visibility, deadline } = {}) {
  const { pager } = service(client);
  return pageSafely(pager, { path: '/Variables', mode: 'local', top, cursor, deadline, maxBytes: PAGE_BYTES,
    identity: { integration_flow, visibility }, filter: matches({ integration_flow, visibility }), project: projectCpiVariable });
}
export async function readCpiDataStoreEntries(client, { data_store, integration_flow, type = '', top = 100, cursor, deadline } = {}) {
  const { pager, request } = service(client);
  const path = `/DataStores(DataStoreName=${key(data_store)},IntegrationFlow=${key(integration_flow)},Type=${key(type)})`;
  // Validate the collection binding before either the parent-metadata or entry request.
  const entries = await pageSafely(pager, { path: `${path}/Entries`, mode: 'local', top, cursor, deadline,
    maxBytes: PAGE_BYTES, project: projectEntry });
  let store = null;
  let storeResult;
  try {
    const raw = await request('GET', path, { unwrap: false, deadline });
    const row = raw?.d ?? raw;
    if (!row || Array.isArray(row) || row.DataStoreName !== data_store || row.IntegrationFlow !== integration_flow || row.Type !== type) {
      throw new IntegrationError('Unexpected data store identity');
    }
    store = projectCpiDataStore(row);
    storeResult = { result: 'ok' };
  } catch (error) { storeResult = sourceFailure(error); }
  return { ...entries, store, source_results: { entries: entries.source_result ?? { result: 'ok' }, store: storeResult } };
}
export async function readCpiJmsQueues(client, { top = 100, cursor, name, deadline } = {}) {
  const { pager } = service(client);
  return pageSafely(pager, { path: '/Queues', mode: 'local', top, cursor, deadline, maxBytes: PAGE_BYTES,
    identity: { name }, filter: name === undefined ? undefined : row => row.Name === name, project: projectCpiJmsQueue });
}
export async function readCpiJmsQueue(client, { name, deadline } = {}) {
  const page = await readCpiJmsQueues(client, { name, top: 2, deadline });
  return { name, found: page.items.length === 1 ? true : page.complete && page.items.length === 0 ? false : null,
    queue: page.items.length === 1 ? page.items[0] : null, complete: page.complete,
    ...(page.items.length > 1 ? { identity_ambiguous: true } : {}), ...(page.source_result ? { source_result: page.source_result } : {}),
    stop_reason: page.stop_reason };
}
async function brokerSource(request, expand, deadline) {
  try {
    const raw = await request('GET', `/JmsBrokers(${key('Broker1')})`, { query: { $expand: expand }, unwrap: false, deadline });
    if (Buffer.byteLength(JSON.stringify(raw)) > SOURCE_BYTES) throw new IntegrationError('Response exceeds safe size limit');
    const broker = raw?.d ?? raw;
    if (!broker || typeof broker !== 'object' || Array.isArray(broker) || !Object.hasOwn(broker, expand)) throw new IntegrationError('Missing broker metadata');
    const collection = decodeCollection(broker[expand]);
    return { broker, raw: broker[expand], rows: collection.items,
      complete: !collection.next && (collection.total === null || collection.total === collection.items.length), source_result: { result: 'ok' } };
  } catch (error) { return { rows: [], complete: false, source_result: sourceFailure(error) }; }
}
export async function readCpiJmsBrokerStatus(client, { deadline } = {}) {
  const { pager, request } = service(client);
  const [states, inactive] = await Promise.all(['QueueStates', 'InactiveQueues'].map(expand => brokerSource(request, expand, deadline)));
  const brokerRow = states.broker ?? inactive.broker;
  const broker = brokerRow ? Object.fromEntries([
    ...BROKER_NUMBERS.map(field => [field, number(brokerRow[field])]), ...BROKER_FLAGS.map(field => [field, normalizeCpiFlag(brokerRow[field])])
  ]) : null;
  const summarize = async (source, path, filter, project) => {
    if (source.raw === undefined) return emptyPage(source.source_result);
    const page = await pageSafely(pager, { path, raw: source.raw, mode: 'local', top: 200, maxBytes: 24 * 1024, deadline,
      sourceComplete: source.complete, filter, project });
    // Broker status is a single bounded snapshot, not a resumable list endpoint.
    return page.next_cursor ? { ...page, next_cursor: null, complete: false, stop_reason: 'source_limit' } : page;
  };
  const queueState = row => { const State = number(row.State); return { ...selectText(row, ['Name']), State,
    state: State === 0 ? 'healthy' : State === 1 ? 'warning' : State === 2 ? 'critical' : 'unknown' }; };
  const unhealthy = row => number(row.State) === 1 || number(row.State) === 2;
  const [unhealthyQueues, unknownQueues, stoppedQueues] = await Promise.all([
    summarize(states, '/JmsBrokers/QueueStates', unhealthy, queueState),
    summarize(states, '/JmsBrokers/UnknownQueueStates', row => ![0, 1, 2].includes(number(row.State)), queueState),
    summarize(inactive, '/JmsBrokers/InactiveQueues', undefined, row => ({ ...selectText(row, ['Name']), stopped: true }))
  ]);
  return { broker, queue_count: states.complete ? states.rows.length : null,
    unhealthy_queue_count: states.complete ? states.rows.filter(unhealthy).length : null,
    unknown_queue_count: states.complete ? states.rows.filter(row => ![0, 1, 2].includes(number(row.State))).length : null,
    stopped_queue_count: inactive.complete ? inactive.rows.length : null,
    unhealthy_queues: unhealthyQueues, unknown_queues: unknownQueues, stopped_queues: stoppedQueues,
    complete: states.complete && inactive.complete && unhealthyQueues.complete && unknownQueues.complete && stoppedQueues.complete,
    source_results: { queue_states: states.source_result, inactive_queues: inactive.source_result } };
}

export function registerCpiAsyncMonitoringTools(register, client) {
  register('cpi_list_data_stores', 'List CPI data stores',
    'List bounded data store metadata with exact local iFlow/visibility filters and store-reported backlog counts. No query options or message bodies are read.',
    { ...collectionInputs, ...exactFilters, overdue_only: z.boolean().default(false) }, READ_ONLY_ANNOTATIONS,
    args => readCpiDataStores(client, args));
  register('cpi_list_data_store_entries', 'List data store entries',
    'List bounded entry metadata and separate store-reported backlog counts. Empty integration_flow selects a global store. MessageId links are unverified; no payloads are read.',
    { data_store: z.string().min(1).max(200), integration_flow: z.string().max(200), type: z.string().max(40).default(''), ...collectionInputs },
    READ_ONLY_ANNOTATIONS, args => readCpiDataStoreEntries(client, args));
  register('cpi_list_variables', 'List CPI variables',
    'List bounded variable metadata with exact local iFlow/visibility filters. No values or OData query options are read.',
    { ...collectionInputs, ...exactFilters }, READ_ONLY_ANNOTATIONS, args => readCpiVariables(client, args));
  register('cpi_list_jms_queues', 'List JMS queues',
    'List bounded JMS queue metadata from /Queues. Unrecognized or missing flags remain unknown; queue message bodies are never read.',
    collectionInputs, READ_ONLY_ANNOTATIONS, args => readCpiJmsQueues(client, args));
  register('cpi_get_jms_queue', 'Get JMS queue metadata',
    'Find one exact queue name in bounded /Queues metadata. No message bodies are read.',
    { name: z.string().min(1).max(200) }, READ_ONLY_ANNOTATIONS, args => readCpiJmsQueue(client, args));
  register('cpi_get_jms_broker_status', 'Get JMS broker status',
    'Read broker capacity/limit flags and independently retrieve warning/critical queue states and stopped queue identities. Missing access remains explicit partial evidence.',
    {}, READ_ONLY_ANNOTATIONS, args => readCpiJmsBrokerStatus(client, args));
}
