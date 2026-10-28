// Narrow metadata-only adapters. No message consumption or broker control.
// GA cloud schema: https://api.solace.dev/cloud/openapi/mission-control.json
// SEMP schema linked by https://help.pubsub.em.services.cloud.sap/Admin/SEMP/SEMP-API-Ref.htm
// Session/auth contract: https://help.pubsub.em.services.cloud.sap/Admin/SEMP/SEMP-Security.htm
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS } from './integration-common.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { IntegrationError } from './integration-http.mjs';

const CLOUD_ROOT = '/api/v2/missionControl';
const BROKERS = '/eventBrokerServices';
const identifier = z.string().min(1).max(255).refine(value => !/[\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..');
const paging = z.object({ top: z.number().int().min(1).max(100).default(100), cursor: cursorSchema }).strict();
const text = value => typeof value === 'string' && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const safeNames = values => Array.isArray(values) ? values.slice(0, 100).map(text).filter(value => value !== undefined) : undefined;
const numericBoolean = (row, names) => Object.fromEntries(names.filter(name => typeof row?.[name] === 'boolean' || typeof row?.[name] === 'number' && Number.isFinite(row[name])).map(name => [name, row[name]]));
const strings = (row, names) => Object.fromEntries(names.filter(name => text(row?.[name]) !== undefined).map(name => [name, row[name]]));
const failure = error => ({ result: error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : [404, 501].includes(error?.status) ? 'unavailable' : 'error', ...(Number.isInteger(error?.status) ? { http_status: error.status } : {}) });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function namedData(raw, expectedId, expectedResourceId) {
  if (!object(raw?.data) || text(raw.data.id) === undefined || raw.data.id !== expectedId) throw new IntegrationError('Named metadata identity is missing or does not match the requested resource');
  if (expectedResourceId !== undefined && raw.data.resourceId !== undefined && raw.data.resourceId !== expectedResourceId) throw new IntegrationError('Operation resource identity does not match the requested service');
  return raw.data;
}
function broker(row) {
  return { ...strings(row, ['id', 'name', 'msgVpnName', 'adminState', 'creationState', 'eventBrokerServiceVersion', 'errorId']),
    ...(text(row?.errorId) !== undefined ? { error_category: 'service_reported_broker_error' } : {}),
    ...(Array.isArray(row?.ongoingOperationIds) ? { ongoingOperationIds: safeNames(row.ongoingOperationIds) } : {}),
    ...(Array.isArray(row?.allowedActions) ? { allowedActions: safeNames(row.allowedActions) } : {}) };
}

export function registerEventMeshTools(register, client) {
  register('event_mesh_get_queue', 'Inspect standalone Event Mesh queue',
    'Read named standalone default-plan queue configuration metadata only. This is not Suite-embedded Event Mesh, message consumption, backlog measurement or a health check.',
    z.object({ name: identifier }).strict(), READ_ONLY_ANNOTATIONS, async ({ name }) => {
      try {
        const response = await client.request('GET', `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(name)}`, { unwrap: false, withStatus: true });
        const row = response.data;
        if (!object(row)) throw new IntegrationError('Expected queue configuration metadata');
        const properties = Object.keys(row).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) && !/secret|password|token|credential|authorization|payload|messageBody/i.test(key)).sort().slice(0, 100);
        return { requested_name: name, result: 'ok', http_status: response.status, property_names: properties,
          configuration: numericBoolean(row, ['maxQueueSizeInBytes', 'maxMessageSizeInBytes', 'maxRedeliveryCount', 'respectTtl', 'enableIngress', 'enableEgress']),
          scope: 'standalone_default_plan_configuration', runtime_health: 'unverified' };
      } catch (error) { return { requested_name: name, ...failure(error) }; }
    });
}

export function registerAemTools(register, client) {
  // Translate the shared signed offset cursor to the documented one-based GA page API.
  // Fixed source pages keep the cursor independent of the caller's output page size.
  const pager = createCollectionPager(client, { root: CLOUD_ROOT, request: async (_method, path, options) => {
    const skip = Number(options.query.$skip ?? 0);
    const pageNumber = Math.floor(skip / 100) + 1;
    const raw = await client.request('GET', `${CLOUD_ROOT}${path}`, { unwrap: false, query: { pageNumber, pageSize: 100, expand: 'allowedActions', sort: 'name:asc' }, deadline: options.deadline });
    if (!Array.isArray(raw?.data) || raw.data.length > 100) throw new IntegrationError('Invalid GA event broker collection');
    // The public OpenAPI leaves meta untyped. Do not guess total fields; an empty source page proves traversal end.
    return { value: raw.data.slice(skip % 100) };
  } });
  register('aem_list_brokers', 'List Advanced Event Mesh brokers',
    'Read the US GA Mission Control eventBrokerServices collection with allowedActions. Unknown source counts remain null; no broker credentials or health inference.',
    paging, READ_ONLY_ANNOTATIONS, args => pager.page({ path: BROKERS, query: { expand: 'allowedActions' }, ...args, project: broker, fallback: false, consistency: 'best_effort', identity: 'id' }));
  register('aem_get_broker', 'Inspect Advanced Event Mesh broker',
    'Read one GA broker with broker,allowedActions,messageSpoolDetails expansions privately; return only allowlisted identity/state metadata, not endpoints or credentials.',
    z.object({ service_id: identifier }).strict(), READ_ONLY_ANNOTATIONS, async ({ service_id }) => {
      try {
        const raw = await client.request('GET', `${CLOUD_ROOT}${BROKERS}/${encodeURIComponent(service_id)}`, { unwrap: false, query: { expand: 'broker,allowedActions,messageSpoolDetails' } });
        const row = namedData(raw, service_id);
        if (!text(row.eventBrokerServiceVersion)) throw new IntegrationError('Named broker metadata is missing the documented service version');
        return { requested_service_id: service_id, result: 'ok', ...broker(row), runtime_health: 'unverified' };
      } catch (error) { return { requested_service_id: service_id, ...failure(error) }; }
    });
  register('aem_get_broker_operation', 'Inspect Advanced Event Mesh operation',
    'Read an existing named GA service operation. Preserve observed status without initiating an operation or interpreting free-form error text.',
    z.object({ service_id: identifier, operation_id: identifier }).strict(), READ_ONLY_ANNOTATIONS, async ({ service_id, operation_id }) => {
      try {
        const raw = await client.request('GET', `${CLOUD_ROOT}${BROKERS}/${encodeURIComponent(service_id)}/operations/${encodeURIComponent(operation_id)}`, { unwrap: false });
        const row = namedData(raw, operation_id, service_id);
        return { requested_service_id: service_id, requested_operation_id: operation_id, result: 'ok', ...strings(row, ['id', 'operationType', 'status']),
          ...(text(row.error?.errorId) !== undefined ? { errorId: row.error.errorId, error_category: 'service_reported_operation_error' } : {}) };
      } catch (error) { return { requested_service_id: service_id, requested_operation_id: operation_id, ...failure(error) }; }
    });
}

const QUEUE_NUMBERS = ['spooledMsgCount', 'spooledByteCount', 'maxMsgSpoolUsage', 'msgSpoolUsage', 'maxBindCount', 'ingressEnabled', 'egressEnabled', 'durable', 'respectTtlEnabled', 'redeliveryEnabled', 'maxRedeliveryCount', 'maxTtl', 'txMsgRate', 'rxMsgRate'];
export function registerAemSempTools(register, client, { sempVpnName } = {}) {
  const root = '/SEMP/v2/monitor';
  // Defer validation to invocation so null-client name enumeration is side-effect-free.
  const collection = () => `/msgVpns/${encodeURIComponent(identifier.parse(sempVpnName))}/queues`;
  const pager = createCollectionPager(client, { root, request: async (_method, path, options) => {
    const query = { count: 100, ...(options.query.$skiptoken ? { cursor: options.query.$skiptoken } : {}) };
    const raw = await client.request('GET', `${root}${path}`, { unwrap: false, query, deadline: options.deadline });
    if (!Array.isArray(raw?.data) || raw.data.length > 100) throw new IntegrationError('Invalid SEMP queue collection');
    let next;
    const link = raw.meta?.paging?.nextPageUri;
    if (link !== undefined && link !== null && link !== '') {
      if (typeof link !== 'string') throw new IntegrationError('Invalid SEMP continuation');
      const target = new URL(link, client.origin);
      if (target.origin !== client.origin || target.username || target.password || target.hash || target.pathname !== `${root}${path}` || [...target.searchParams.keys()].some(key => !['count', 'cursor'].includes(key)) || target.searchParams.getAll('cursor').length !== 1 || !target.searchParams.get('cursor') || target.searchParams.getAll('count').length > 1 || target.searchParams.has('count') && target.searchParams.get('count') !== '100') throw new IntegrationError('SEMP continuation leaves the configured queue collection');
      next = `${root}${path}?${new URLSearchParams({ $skiptoken: target.searchParams.get('cursor') })}`;
    }
    return { value: raw.data, ...(next ? { '@odata.nextLink': next } : { source_end: true }) };
  } });
  register('aem_list_queues', 'List broker-local SEMP queues',
    'Read configured VPN queue monitor metadata only, using the independent broker Basic client and private reused session. No messages, cloud-token fallback or SEMP proxy.',
    paging, READ_ONLY_ANNOTATIONS, async args => {
      try { return await pager.page({ path: collection(), ...args, project: row => ({ ...strings(row, ['queueName', 'msgVpnName']), ...numericBoolean(row, QUEUE_NUMBERS) }), endOfSource: source => source.source_end === true, fallback: false }); }
      catch (error) {
        if (error.status === 529 || error.status === 401 || error.status === 403) return { items: [], returned: 0, total: null, complete: false, next_cursor: null, stop_reason: 'source_limit', source_result: { ...failure(error), setup_status: error.status === 529 ? 'no_session_slots' : 'needs_admin_confirmation', required_setup: error.status === 529 ? 'Release broker management sessions or review session limits' : 'Confirm broker Basic authentication and VPN-scoped read-only management permissions; cloud credentials are not a fallback' } };
        throw error;
      }
    });
}

export function registerMessagingTools(register, { event_mesh, aem, aem_semp } = {}, { sempVpnName } = {}) {
  if (event_mesh) registerEventMeshTools(register, event_mesh);
  if (aem) registerAemTools(register, aem);
  if (aem_semp) registerAemSempTools(register, aem_semp, { sempVpnName });
}
