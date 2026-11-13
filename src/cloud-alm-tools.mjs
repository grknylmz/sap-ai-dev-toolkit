// MCP tools for SAP Cloud ALM operations: landscape, Integration & Exception
// Monitoring records (Raw Data Outbound Logs), analytics, health/alert hotspots
// per landscape tier, incident triage with CPI and SLG1 handoffs, feature and
// transport status, and the one write: closing an event situation behind an
// exact confirmation string. Every result passes through secret redaction.
import { z } from 'zod';
import {
  OVERWRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  confirmation,
  isoDate,
  list,
  pick,
  redactSecrets,
  requireConfirmation,
  resultOf
} from './integration-common.mjs';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { CLOUD_ALM_PATHS } from './cloud-alm-client.mjs';
import { aggregateAnalyticsRows, flattenLogRecords, lookbackWindow, readAnalyticsTable } from './cloud-alm-data.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lmsId = z.string().regex(UUID, 'expected a Cloud ALM landscape (LMS) id (UUID)');
const uuid = z.string().regex(UUID, 'expected a UUID');
const providerName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/);
const providerVersion = z.string().regex(/^v?\d{1,3}$/i);
const label = z.string().min(1).max(120);
const end = isoDate.optional().describe('UTC end of the window (default now).');
const OBJECT_TYPE = z.enum(['CloudService', 'TechnicalSystem', 'BusinessService']);
const RECORD_PROVIDER = z.enum(['im', 'exm.im', 'exm.jam', 'iep', 'jam.run', 'bsm']);
const JOB_TYPE = z.enum(['CF_DM_PROCESS', 'HCP_IPS_JOB', 'IRPA', 'NW_ABAP_JOB', 'NW_ABAP_PC', 'NW_ABAP_WF', 'NW_APPL_JOB', 'SPA_AUTOMATION', 'SPA_PROCESS']);
const USE_CASE = z.enum(['CALM.EXM', 'CALM.IM', 'CALM.BPMON', 'CALM.BSM', 'CALM.HM', 'CALM.JM', 'CALM.SUM']);
const analyticsFilters = z.array(z.object({
  key: z.string().min(1).max(100),
  values: z.array(z.string().max(255)).min(1).max(50)
})).max(10);

const LANDSCAPE_FIELDS = 'lmsId,name,description,objectType,source,systemNumber,systemType,role,serviceType,serviceTypeLabel,externalId,datacenter,mainUrl,logicalSystems'.split(',');
const FEATURE_SELECT = 'uuid,displayId,title,projectId,statusCode,priorityCode,releaseId,modifiedAt';
const FEATURE_EXPAND = 'toStatus,toPriority,toProject,toRelease,toTransports,toTransportReferences';
const FULL_EXPAND = 'toStatus,toPriority,toProject,toScope,toRelease,toWorkstream,toTransports,toTransportReferences,toTaskAssignments,toURLReferences,toExternalReferences';
const HEALTH_SERVICE_LIMIT = 30;
const LANDSCAPE_PAGE = 500;

// Which record filters apply to which provider.
const RECORD_FILTERS = Object.freeze({
  categories: ['im', 'exm.im', 'exm.jam'],
  status: ['exm.im', 'exm.jam'],
  message: ['exm.im', 'exm.jam'],
  usecase: ['iep'],
  event_subtype: ['iep'],
  job_type: ['jam.run'],
  job_name: ['jam.run'],
  event_domain: ['bsm']
});

export const CLOUD_ALM_TOOL_NAMES = Object.freeze([
  'calm_connection_info',
  'calm_list_landscape',
  'calm_get_landscape_health',
  'calm_list_monitoring_records',
  'calm_triage_incident',
  'calm_list_analytics_providers',
  'calm_describe_analytics_provider',
  'calm_query_analytics',
  'calm_list_features',
  'calm_get_feature',
  'calm_close_event_situation'
]);

const rows = value => (Array.isArray(value) ? value : []);
const enc = encodeURIComponent;
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const projectLandscape = row => pick(row, LANDSCAPE_FIELDS);

function projectFeature(row) {
  return {
    uuid: row?.uuid,
    display_id: row?.displayId,
    title: row?.title,
    status_code: row?.statusCode,
    status: row?.toStatus?.name,
    priority: row?.toPriority?.name ?? row?.priorityCode,
    project: row?.toProject?.name,
    project_id: row?.projectId,
    release: row?.toRelease?.name,
    modified_at: row?.modifiedAt,
    transports: rows(row?.toTransports).map(entry => entry?.id),
    transport_references: rows(row?.toTransportReferences).map(entry => entry?.id)
  };
}

function featureDetail(row) {
  const description = typeof row?.description === 'string' ? row.description.slice(0, 4096) : row?.description;
  return {
    feature: { ...projectFeature(row), description },
    task_assignments: rows(row?.toTaskAssignments).map(entry => pick(entry, ['uuid', 'title', 'type'])),
    url_references: rows(row?.toURLReferences).map(entry => pick(entry, ['name', 'url'])),
    external_references: rows(row?.toExternalReferences).map(entry => pick(entry, ['id', 'name', 'url']))
  };
}

function validateRecordsInput(args) {
  const { provider } = args;
  for (const [field, providers] of Object.entries(RECORD_FILTERS)) {
    if (args[field] !== undefined && !providers.includes(provider)) {
      throw new IntegrationError(`${field} applies only to provider ${providers.join(' or ')}`);
    }
  }
  if (provider === 'im' && !args.categories) {
    throw new IntegrationError('im records need categories: the labels shown in Integration Monitoring, for example "SAP Integration Suite Messages" or "IDoc"');
  }
  if ((provider === 'iep' || provider === 'bsm') && args.service_ids.length > 1) {
    throw new IntegrationError(`${provider} accepts exactly one service id`);
  }
  if (provider === 'jam.run' && args.service_ids.length > 27) throw new IntegrationError('jam.run accepts at most 27 service ids');
  if (args.minutes > 60 && provider !== 'bsm') {
    throw new IntegrationError(`${provider} records are limited to 60-minute windows; only bsm accepts up to 31 days`);
  }
}

function recordFilters(args) {
  const filters = {
    category: args.categories?.join(','),
    status: args.status,
    message: args.message,
    usecase: args.usecase,
    eventsubtype: args.event_subtype,
    jobType: args.job_type,
    jobName: args.job_name,
    eventDomain: args.event_domain
  };
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

// Aggregated rows keep dimension values first and measures after, in query column order.
const values = row => Object.values(row);
const sum = numbers => numbers.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

function alertSummary(table, top) {
  const grouped = aggregateAnalyticsRows(table, 'sum').map(values)
    .map(([useCase, eventName, events, alerts, situations]) => ({ use_case: useCase, event_name: eventName, events, alerts, event_situations: situations }));
  return {
    events: sum(grouped.map(entry => entry.events)),
    alerts: sum(grouped.map(entry => entry.alerts)),
    event_situations: sum(grouped.map(entry => entry.event_situations)),
    grouped: grouped.slice(0, top)
  };
}

function tierOrder(roles) {
  if (roles) {
    const wanted = roles.map(role => role.toUpperCase());
    return (a, b) => wanted.indexOf(a.toUpperCase()) - wanted.indexOf(b.toUpperCase());
  }
  return (a, b) => (a === 'UNASSIGNED') - (b === 'UNASSIGNED') || a.localeCompare(b);
}

/** Register all SAP Cloud ALM tools; returns the registered names. */
export function registerCloudAlmTools(server, { rest, summary, verify, now = Date.now } = {}) {
  const registeredNames = [];
  const register = (name, title, description, inputSchema, annotations, handler) => {
    registeredNames.push(name);
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(
      async () => redactSecrets(await handler(args)),
      { product: 'SAP Cloud ALM', fallback: 'SAP Cloud ALM request failed. Check the service key scopes (calm-api.*) and API reachability.' }
    ));
  };

  const analyticsData = async (queries, window, resolution) => rows(await rest.request('POST', `${CLOUD_ALM_PATHS.analytics}/providers/data`, {
    json: {
      format: 'table',
      tableType: 'raw',
      timestampFormat: 'unix',
      timeRange: { from: window.from, to: window.to },
      resolution,
      timezone: '+00:00',
      queries
    },
    expect: [200]
  })).map(readAnalyticsTable);

  const fetchRecords = async ({ provider, serviceIds, filters = {}, window, limit, offset }) => {
    // Comma lists are joined strings: arrays would become repeated parameters.
    const response = await rest.request('GET', CLOUD_ALM_PATHS.logs, {
      query: {
        provider,
        format: 'protobuf-json',
        from: window.from,
        to: window.to,
        limit,
        offset,
        onLimit: 'TRUNCATE',
        serviceId: serviceIds.join(','),
        ...(provider === 'im' ? { version: 'v2' } : {}),
        ...filters
      },
      responseHeaders: ['x-total-count']
    });
    const records = flattenLogRecords(response?.data);
    const header = response?.responseHeaders?.['x-total-count'];
    const total = header === undefined || header === null || header === '' ? null : Number(header);
    const totalCount = Number.isFinite(total) ? total : null;
    const returned = records.length;
    let nextOffset;
    if (totalCount !== null) nextOffset = offset + returned < totalCount ? offset + returned : null;
    else nextOffset = returned === limit ? offset + limit : null;
    return { total_count: totalCount, returned, next_offset: nextOffset, records };
  };

  const landscapeObject = async id => {
    const found = list(await rest.request('GET', CLOUD_ALM_PATHS.landscape, { query: { lmsId: id } }))[0];
    if (!found) throw new IntegrationError(`Cloud ALM landscape object ${id} was not found`);
    return projectLandscape(found);
  };

  // ------------------------------------------------------------ connection

  register('calm_connection_info', 'Cloud ALM connection info',
    'Report the connected Cloud ALM API host, token host, auth mode and credential source; verify: true also checks Landscape and Analytics API access read-only and never returns credentials.',
    { verify: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ verify: online }) => ({ ...summary, ...(online && verify ? { verification: await verify() } : {}) }));

  // ------------------------------------------------------------ landscape

  register('calm_list_landscape', 'List Cloud ALM landscape objects',
    'List Cloud ALM landscape objects (cloud services, technical systems, business services) with their LMS id, role (tenant-defined tier such as DEV/TEST/PROD), service type, system number and logical systems, up to 500 per page.',
    {
      object_type: OBJECT_TYPE.optional(),
      role: z.string().min(1).max(40).optional(),
      service_type: z.string().min(1).max(100).optional(),
      name: z.string().min(1).max(255).optional(),
      system_number: z.string().min(1).max(64).optional(),
      lms_id: lmsId.optional(),
      external_id: z.string().min(1).max(255).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ object_type, role, service_type, name, system_number, lms_id, external_id, limit, offset }) => {
      const objects = list(await rest.request('GET', CLOUD_ALM_PATHS.landscape, {
        query: { objectType: object_type, role, serviceType: service_type, name, systemNumber: system_number, lmsId: lms_id, externalId: external_id, limit, offset }
      })).map(projectLandscape);
      return { objects, returned: objects.length, next_offset: objects.length === limit ? offset + limit : null };
    });

  register('calm_get_landscape_health', 'Cloud ALM landscape health per tier',
    'Summarize exception counts (EXM), critical/warning health metrics (Health Monitoring) and monitoring events/alerts (EVENTS analytics) for at most 30 landscape services grouped by role tier over the last 1 to 744 hours; each source reports its own failure instead of failing the whole result.',
    {
      roles: z.array(z.string().min(1).max(40)).min(1).max(10).optional().describe('Tenant role values to include, in tier order (case-insensitive), for example ["DEV","TEST","PROD"].'),
      object_type: OBJECT_TYPE.optional(),
      service_type: z.string().min(1).max(100).optional(),
      name: z.string().min(1).max(255).optional(),
      lms_ids: z.array(lmsId).min(1).max(30).optional(),
      hours: z.number().int().min(1).max(744).default(24),
      end
    },
    READ_ONLY_ANNOTATIONS,
    async ({ roles, object_type, service_type, name, lms_ids, hours, end: endAt }) => {
      let selected = [];
      const missing = [];
      let landscapeTruncated = false;
      if (lms_ids) {
        for (const id of lms_ids) {
          const found = list(await rest.request('GET', CLOUD_ALM_PATHS.landscape, { query: { lmsId: id } }))[0];
          if (found) selected.push(found);
          else missing.push(id);
        }
      } else {
        selected = list(await rest.request('GET', CLOUD_ALM_PATHS.landscape, {
          query: { objectType: object_type, serviceType: service_type, name, limit: LANDSCAPE_PAGE }
        }));
        landscapeTruncated = selected.length === LANDSCAPE_PAGE;
      }
      if (roles) {
        const wanted = new Set(roles.map(role => role.toUpperCase()));
        selected = selected.filter(object => wanted.has(String(object?.role ?? '').toUpperCase()));
      }
      const window = lookbackWindow({ end: endAt, spanMs: hours * 3_600_000, now });
      const resolution = hours <= 48 ? 'H' : 'D';
      const windowOut = { from: window.from_iso, to: window.to_iso, resolution };
      if (selected.length > HEALTH_SERVICE_LIMIT) {
        throw new IntegrationError(`landscape health covers at most ${HEALTH_SERVICE_LIMIT} services; ${selected.length} matched; narrow with roles, object_type, service_type, name or lms_ids`);
      }
      const extras = {
        ...(landscapeTruncated ? { landscape_truncated: true } : {}),
        ...(missing.length ? { missing_lms_ids: missing } : {})
      };
      if (!selected.length) return { window: windowOut, matched: 0, ...extras, tiers: [] };

      const ids = selected.map(object => object.lmsId);
      const sources = {};
      const exceptionsById = new Map();
      const healthById = new Map();
      const alertsById = new Map();

      try {
        const [table] = await analyticsData([{
          name: 'exceptions',
          provider: 'EXM_DATAPROVIDER',
          columns: { dimensions: ['serviceId', 'categoryName'], metrics: [{ measure: 'counter', method: 'SUM' }] },
          filters: [{ key: 'serviceId', values: ids }]
        }], window, resolution);
        for (const [serviceId, category, count] of aggregateAnalyticsRows(table ?? { columns: [], rows: [] }, 'sum').map(values)) {
          const entry = exceptionsById.get(serviceId) ?? [];
          entry.push({ category, count });
          exceptionsById.set(serviceId, entry);
        }
        sources.exceptions = { ok: true, truncated: Boolean(table?.truncated) };
      } catch (error) {
        sources.exceptions = { ok: false, error: error?.message ?? String(error) };
      }

      try {
        const tables = await analyticsData(ids.map(id => ({
          name: id,
          provider: 'HM_ANALYTICS_DP',
          columns: { dimensions: ['metricName'], metrics: [{ measure: 'criticalStatus' }, { measure: 'warningStatus' }] },
          filters: [{ key: 'serviceId', values: [id] }]
        })), window, resolution);
        ids.forEach((id, index) => {
          const table = tables[index] ?? { columns: [], rows: [] };
          const metrics = aggregateAnalyticsRows(table, 'max').map(values);
          const critical = metrics.filter(([, criticalStatus]) => criticalStatus > 0).map(([metric]) => metric);
          const warning = metrics.filter(([, criticalStatus, warningStatus]) => !(criticalStatus > 0) && warningStatus > 0).map(([metric]) => metric);
          healthById.set(id, { critical: critical.slice(0, 25), warning: warning.slice(0, 25) });
        });
        sources.health = { ok: true, truncated: tables.some(table => table?.truncated) };
      } catch (error) {
        sources.health = { ok: false, error: error?.message ?? String(error) };
      }

      try {
        const tables = await analyticsData(ids.map(id => ({
          name: id,
          provider: 'EVENTS',
          columns: { dimensions: ['useCase', 'eventName'], metrics: [{ measure: 'events' }, { measure: 'alerts' }, { measure: 'eventSituations' }] },
          filters: [{ key: 'serviceId', values: [id] }]
        })), window, resolution);
        ids.forEach((id, index) => {
          const { grouped, ...totals } = alertSummary(tables[index] ?? { columns: [], rows: [] }, 10);
          alertsById.set(id, { ...totals, top: grouped.map(({ use_case, event_name, events, alerts }) => ({ use_case, event_name, events, alerts })) });
        });
        sources.alerts = { ok: true, truncated: tables.some(table => table?.truncated) };
      } catch (error) {
        sources.alerts = { ok: false, error: error?.message ?? String(error) };
      }

      const byTier = new Map();
      for (const object of selected) {
        const service = {
          lms_id: object.lmsId,
          name: object.name,
          object_type: object.objectType,
          service_type: object.serviceType,
          system_number: object.systemNumber
        };
        if (sources.exceptions.ok) {
          const categories = (exceptionsById.get(object.lmsId) ?? []).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
          service.exceptions = { total: sum(categories.map(entry => entry.count)), by_category: categories.slice(0, 20) };
        }
        if (sources.health.ok) service.health = healthById.get(object.lmsId);
        if (sources.alerts.ok) service.alerts = alertsById.get(object.lmsId);
        const tier = object.role || 'UNASSIGNED';
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(service);
      }
      const tiers = [...byTier.keys()].sort(tierOrder(roles)).map(role => {
        const services = byTier.get(role);
        return {
          role,
          totals: {
            services: services.length,
            exceptions: sources.exceptions.ok ? sum(services.map(service => service.exceptions.total)) : null,
            services_with_critical_metrics: sources.health.ok ? services.filter(service => service.health.critical.length).length : null,
            alerts: sources.alerts.ok ? sum(services.map(service => service.alerts.alerts)) : null
          },
          services
        };
      });
      return { window: windowOut, matched: selected.length, ...extras, sources, tiers };
    });

  // ------------------------------------------------------------ records

  register('calm_list_monitoring_records', 'List Cloud ALM monitoring records',
    'Read raw Cloud ALM monitoring records (Raw Data Outbound Logs) for integration messages (im), exceptions (exm.im, exm.jam), monitoring events (iep), job runs (jam.run) or business service events (bsm) over windows of at most 60 minutes (bsm up to 31 days), up to 200 records per page with next_offset paging.',
    {
      provider: RECORD_PROVIDER,
      service_ids: z.array(lmsId).min(1).max(30),
      categories: z.array(label).min(1).max(20).optional().describe('Integration/exception category labels as shown in the Cloud ALM UI; required for im.'),
      status: z.enum(['Resolved', 'Warning', 'Error']).optional(),
      message: z.string().min(1).max(255).optional().describe('Message text filter; * is a wildcard.'),
      usecase: USE_CASE.optional(),
      event_subtype: z.string().min(1).max(120).optional().describe('Event subtype, for example calm.im.cpi.msg.'),
      job_type: JOB_TYPE.optional(),
      job_name: z.string().min(1).max(255).optional(),
      event_domain: z.enum(['Maintenance', 'Degradation', 'Disruption', 'Communication']).optional(),
      end,
      minutes: z.number().int().min(1).max(44_640).default(30),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0)
    },
    READ_ONLY_ANNOTATIONS,
    async args => {
      validateRecordsInput(args);
      const window = lookbackWindow({ end: args.end, spanMs: args.minutes * 60_000, now });
      const page = await fetchRecords({
        provider: args.provider,
        serviceIds: args.service_ids,
        filters: recordFilters(args),
        window,
        limit: args.limit,
        offset: args.offset
      });
      return { provider: args.provider, window: { from: window.from_iso, to: window.to_iso }, ...page };
    });

  register('calm_triage_incident', 'Triage a Cloud ALM incident',
    'Collect, for one landscape service over the last 1 to 60 minutes, monitoring event and alert counts, monitoring event records (iep), exception records with status Error (exm.im) and optionally integration message records (im), plus ready-to-use argument handoffs for cpi_list_message_logs and the ABAP get_application_log (SLG1) tool.',
    {
      service_id: lmsId,
      end,
      minutes: z.number().int().min(1).max(60).default(30),
      im_categories: z.array(label).min(1).max(20).optional().describe('Integration Monitoring category labels, for example "SAP Integration Suite Messages" or "IDoc".'),
      limit_per_section: z.number().int().min(1).max(100).default(25)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ service_id, end: endAt, minutes, im_categories, limit_per_section: limit }) => {
      const service = await landscapeObject(service_id);
      const window = lookbackWindow({ end: endAt, spanMs: minutes * 60_000, now });
      const section = async operation => {
        try {
          return await operation();
        } catch (error) {
          return { error: error?.message ?? String(error) };
        }
      };
      const records = (provider, filters) => fetchRecords({ provider, serviceIds: [service_id], filters, window, limit, offset: 0 });

      const alertCounts = await section(async () => {
        const [table] = await analyticsData([{
          name: 'alerts',
          provider: 'EVENTS',
          columns: { dimensions: ['useCase', 'eventName'], metrics: [{ measure: 'events' }, { measure: 'alerts' }, { measure: 'eventSituations' }] },
          filters: [{ key: 'serviceId', values: [service_id] }]
        }], window, '5Mi');
        const { grouped, ...totals } = alertSummary(table ?? { columns: [], rows: [] }, 20);
        return { ...totals, by_event: grouped };
      });
      const alerts = await section(() => records('iep'));
      const exceptions = await section(() => records('exm.im', { status: 'Error' }));
      const messages = im_categories
        ? await section(() => records('im', { category: im_categories.join(',') }))
        : { skipped: 'pass im_categories (for example "SAP Integration Suite Messages", "IDoc") to include integration messages' };

      const handoff = {
        utc_window: { from: window.from_iso, to: window.to_iso },
        cpi: { tool: 'cpi_list_message_logs', arguments: { from: window.from_iso, to: window.to_iso } },
        abap: {
          tool: 'get_application_log',
          system: service.name,
          system_number: service.systemNumber,
          clients: rows(service.logicalSystems).map(entry => entry?.client).filter(client => client !== undefined && client !== null),
          arguments: { from: utcDate(window.startMs - 86_400_000), to: utcDate(window.endMs + 86_400_000), messages: true }
        }
      };
      return {
        service,
        window: { from: window.from_iso, to: window.to_iso },
        alert_counts: alertCounts,
        alerts,
        exceptions,
        messages,
        handoff
      };
    });

  // ------------------------------------------------------------ analytics

  register('calm_list_analytics_providers', 'List Cloud ALM analytics providers',
    'List the Cloud ALM analytics data providers the service key is authorized for, with domain, service and versions.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () => ({
      providers: list(await rest.request('GET', `${CLOUD_ALM_PATHS.analytics}/providers`))
        .map(provider => pick(provider, ['name', 'description', 'domain', 'service', 'version']))
    }));

  register('calm_describe_analytics_provider', 'Describe a Cloud ALM analytics provider',
    'Describe the dimensions, measures and attributes of one Cloud ALM analytics provider, or with attribute set list that attribute\'s values (first 100), optionally narrowed by filters.',
    {
      provider: providerName,
      version: providerVersion.optional(),
      attribute: z.string().min(1).max(100).optional(),
      filters: analyticsFilters.optional()
    },
    READ_ONLY_ANNOTATIONS,
    async ({ provider, version, attribute, filters }) => {
      const fields = list(await rest.request('POST', `${CLOUD_ALM_PATHS.analytics}/providers/filters`, {
        json: { providerName: provider, providerVersion: version ?? '', ...(attribute ? { name: attribute, filters: filters ?? [] } : {}) },
        expect: [200]
      }));
      return {
        provider,
        fields: fields.map(field => {
          const fieldValues = rows(field?.values);
          return {
            key: field?.key,
            name: field?.name,
            description: field?.description,
            type: field?.type,
            filterable: field?.isAttribute === true || field?.type === 'attribute',
            multiple: field?.isMultiple === true,
            values: fieldValues.slice(0, 100).map(value => pick(value, ['key', 'label'])),
            values_total: fieldValues.length
          };
        })
      };
    });

  register('calm_query_analytics', 'Query Cloud ALM analytics',
    'Run one Cloud ALM analytics query (provider, dimensions, measures, filters) over the last 1 to 744 hours and return up to 500 rows, summed or maxed per dimension combination by default or raw per time bucket with aggregate none.',
    {
      provider: providerName,
      version: providerVersion.optional(),
      dimensions: z.array(z.string().min(1).max(100)).max(10).default([]),
      measures: z.array(z.object({
        measure: z.string().min(1).max(100),
        method: z.enum(['SUM', 'AVG', 'MIN', 'MAX']).optional()
      })).min(1).max(10),
      filters: analyticsFilters.default([]),
      hours: z.number().int().min(1).max(744).default(24),
      end,
      resolution: z.enum(['P', '1Mi', '5Mi', '10Mi', '15Mi', '30Mi', 'H', 'D', 'W', 'M']).default('H'),
      aggregate: z.enum(['none', 'sum', 'max']).default('sum').describe('sum for counts, max for percentage measures such as Health Monitoring status.'),
      limit: z.number().int().min(1).max(500).default(200)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ provider, version, dimensions, measures, filters, hours, end: endAt, resolution, aggregate, limit }) => {
      const window = lookbackWindow({ end: endAt, spanMs: hours * 3_600_000, now });
      const [table = readAnalyticsTable({})] = await analyticsData([{
        name: 'query',
        provider,
        ...(version ? { version } : {}),
        columns: { dimensions, metrics: measures },
        filters
      }], window, resolution);
      const result = aggregate === 'none' ? table.rows : aggregateAnalyticsRows(table, aggregate);
      const page = result.slice(0, limit);
      return {
        provider,
        window: { from: window.from_iso, to: window.to_iso, resolution },
        aggregate,
        total_rows: table.total ?? result.length,
        returned: page.length,
        truncated: table.truncated || result.length > limit,
        rows: page
      };
    });

  // ------------------------------------------------------------ features

  register('calm_list_features', 'List Cloud ALM features',
    'List Cloud ALM features (newest change first, up to 200 per page) with lifecycle status, priority, project, release and the ids of their transports, optionally filtered by project, release, status codes and change date.',
    {
      project_id: uuid.optional(),
      release_id: uuid.optional(),
      status_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/)).min(1).max(10).optional()
        .describe('For example IN_REALIZATION, IN_TESTING, SUCCESSFULLY_TESTED, APPROVED_FOR_DEPLOYMENT, CONFIRMED.'),
      modified_since: isoDate.optional(),
      top: z.number().int().min(1).max(200).default(50),
      skip: z.number().int().min(0).default(0),
      include_status_catalog: z.boolean().default(false)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ project_id, release_id, status_codes, modified_since, top, skip, include_status_catalog }) => {
      const clauses = [];
      if (status_codes) clauses.push(`(${status_codes.map(code => `statusCode eq ${odataKey(code)}`).join(' or ')})`);
      if (project_id) clauses.push(`projectId eq ${project_id}`);
      if (release_id) clauses.push(`releaseId eq ${release_id}`);
      if (modified_since) clauses.push(`modifiedAt ge ${modified_since}`);
      const response = await rest.request('GET', `${CLOUD_ALM_PATHS.features}/Features`, {
        query: {
          ...(clauses.length ? { $filter: clauses.join(' and ') } : {}),
          $select: FEATURE_SELECT,
          $expand: FEATURE_EXPAND,
          $orderby: 'modifiedAt desc',
          $top: top,
          $skip: skip,
          $count: true
        }
      });
      return {
        features: list(response).map(projectFeature),
        count: response?.['@odata.count'] ?? response?.['@count'] ?? null,
        ...(include_status_catalog ? { status_catalog: list(await rest.request('GET', `${CLOUD_ALM_PATHS.features}/FeatureStatus`)) } : {})
      };
    });

  register('calm_get_feature', 'Get a Cloud ALM feature',
    'Read one Cloud ALM feature by UUID or display id with status, transports, task assignments and references, or find the features linked to a transport id.',
    z.object({
      feature_uuid: uuid.optional(),
      display_id: z.string().regex(/^\d+-\d+$/).optional(),
      transport_id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional()
    }).refine(
      args => [args.feature_uuid, args.display_id, args.transport_id].filter(value => value !== undefined).length === 1,
      'provide exactly one of feature_uuid, display_id, transport_id'
    ),
    READ_ONLY_ANNOTATIONS,
    async ({ feature_uuid, display_id, transport_id }) => {
      if (feature_uuid) {
        return featureDetail(await rest.request('GET', `${CLOUD_ALM_PATHS.features}/Features/${enc(feature_uuid)}`, { query: { $expand: FULL_EXPAND } }));
      }
      if (display_id) {
        const matches = list(await rest.request('GET', `${CLOUD_ALM_PATHS.features}/Features`, {
          query: { $filter: `displayId eq ${odataKey(display_id)}`, $expand: FULL_EXPAND, $top: 2 }
        }));
        if (!matches.length) throw new IntegrationError(`no Cloud ALM feature has display id ${display_id}`);
        if (matches.length > 1) throw new IntegrationError(`display id ${display_id} matched ${matches.length} features`);
        return featureDetail(matches[0]);
      }
      const features = new Map();
      for (const [entitySet, link] of [['Transports', 'transport'], ['TransportReferences', 'transport_reference']]) {
        const links = list(await rest.request('GET', `${CLOUD_ALM_PATHS.features}/${entitySet}`, {
          query: { $filter: `id eq ${odataKey(transport_id)}`, $expand: 'parent' }
        }));
        for (const parent of links.map(entry => entry?.parent)) {
          if (!parent?.uuid || features.has(parent.uuid)) continue;
          features.set(parent.uuid, {
            link,
            uuid: parent.uuid,
            display_id: parent.displayId,
            title: parent.title,
            status_code: parent.statusCode,
            modified_at: parent.modifiedAt
          });
        }
      }
      return { transport_id, features: [...features.values()] };
    });

  // ------------------------------------------------------------ event situations

  register('calm_close_event_situation', 'Close a Cloud ALM event situation',
    'Close (confirm) one Cloud ALM event situation (alert) by id or external id and, unless notify_ticketing is false, close its mapped tickets; requires confirmation exactly "CLOSE CALM EVENT SITUATION <event_situation_id>" or "CLOSE CALM EVENT SITUATION BY EXTERNAL ID <external_id>".',
    z.object({
      event_situation_id: uuid.optional(),
      external_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
      notify_ticketing: z.boolean().default(true),
      confirmation
    }).refine(
      args => [args.event_situation_id, args.external_id].filter(value => value !== undefined).length === 1,
      'provide exactly one of event_situation_id, external_id'
    ),
    OVERWRITE_ANNOTATIONS,
    async ({ event_situation_id, external_id, notify_ticketing, confirmation: given }) => {
      requireConfirmation(given, event_situation_id
        ? `CLOSE CALM EVENT SITUATION ${event_situation_id}`
        : `CLOSE CALM EVENT SITUATION BY EXTERNAL ID ${external_id}`);
      const path = event_situation_id
        ? `${CLOUD_ALM_PATHS.eventSituations}/${enc(event_situation_id)}`
        : `${CLOUD_ALM_PATHS.eventSituations}/externalid/${enc(external_id)}`;
      const { status } = await rest.request('PUT', path, {
        json: { state: 'CLOSED' },
        headers: { 'x-calm-notification': String(notify_ticketing) },
        expect: [200, 202, 204],
        responseType: 'none',
        withStatus: true
      });
      return {
        closed: true,
        status,
        ...(event_situation_id ? { event_situation_id } : { external_id }),
        notify_ticketing
      };
    });

  return registeredNames;
}
