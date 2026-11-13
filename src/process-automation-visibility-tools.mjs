// SAP Build Process Automation process visibility tools (SPA_Visibility_Scenario + SPA_Visibility_Workspace).
import { z } from 'zod';
import {
  CREATE_ANNOTATIONS,
  OVERWRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  confirmation,
  requireConfirmation
} from './integration-common.mjs';
import { VISIBILITY, enc, identifier, odataString, payload, skip, timestamp, top } from './process-automation-common.mjs';

export const VISIBILITY_TOOL_NAMES = Object.freeze([
  'bpa_list_visibility_scenarios',
  'bpa_get_visibility_scenario',
  'bpa_process_visibility_scenario',
  'bpa_clear_visibility_data',
  'bpa_list_visibility_events',
  'bpa_push_visibility_events',
  'bpa_list_visibility_workspace_scenarios',
  'bpa_list_visibility_instances',
  'bpa_get_visibility_instance'
]);

const REST = `${VISIBILITY}/rest/v1`;
const ODATA = `${VISIBILITY}/odata/v1`;
const text = max => z.string().min(1).max(max);
const scenarioId = identifier('visibility scenario id');

const EVENT_PARAMS = ['process_definition_id', 'process_instance_id', 'event_type', 'environment_id', 'acquired_from', 'acquired_up_to'];
const ERROR_PARAMS = ['log_id', 'start_date_time', 'end_date_time'];

const visibilityEvent = z.object({
  processDefinitionId: text(255),
  processInstanceId: text(255),
  eventType: text(255),
  timestamp: text(64),
  eventId: text(255).optional(),
  activityDefinitionId: text(255).optional(),
  activityInstanceId: text(255).optional(),
  activityType: text(255).optional(),
  activityName: text(255).optional(),
  activityStatus: text(255).optional(),
  eventName: text(255).optional(),
  processVersionId: text(255).optional(),
  userDisplayName: text(255).optional(),
  userId: text(255).optional(),
  context: payload.optional()
}).strict();

export function registerVisibilityTools(register, { rest }) {
  const scenarioPath = id => `${REST}/scenario-definitions/${enc(id)}`;
  const instancePath = (scenario, id) => `${ODATA}/${enc(scenario)}/Instances(${enc(odataString(id))})`;

  register('bpa_list_visibility_scenarios', 'List visibility scenarios',
    'List deployed process visibility scenario definitions. Requires the PVAdmin role.',
    {}, READ_ONLY_ANNOTATIONS,
    () => rest.request('GET', `${REST}/scenario-definitions`));

  register('bpa_get_visibility_scenario', 'Get visibility scenario',
    'Get a deployed visibility scenario definition, optionally with its model and its 20 most recent data-processing executions. Requires PVAdmin.',
    {
      scenario_id: scenarioId,
      include: z.array(z.enum(['model', 'executions'])).max(2).default([]),
      execution_status: text(64).optional().describe('Filter executions by status.')
    }, READ_ONLY_ANNOTATIONS,
    async ({ scenario_id, include, execution_status }) => {
      const base = scenarioPath(scenario_id);
      const result = { scenario: await rest.request('GET', base) };
      if (include.includes('model')) result.model = await rest.request('GET', `${base}/model`);
      if (include.includes('executions')) {
        result.executions = await rest.request('GET', `${base}/data-executions`, execution_status ? { query: { status: execution_status } } : {});
      }
      return result;
    });

  register('bpa_process_visibility_scenario', 'Process visibility scenario data',
    'Trigger processing of the attributes and visibility patterns of a scenario model (asynchronous, HTTP 202). Requires PVAdmin.',
    { scenario_id: scenarioId, confirmation }, CREATE_ANNOTATIONS,
    async ({ scenario_id, confirmation: given }) => {
      requireConfirmation(given, `PROCESS BPA VISIBILITY ${scenario_id}`);
      const { status } = await rest.request('POST', `${scenarioPath(scenario_id)}/data-executions`, {
        expect: [202], responseType: 'none', withStatus: true
      });
      return { accepted: true, status, scenario_id };
    });

  register('bpa_clear_visibility_data', 'Clear visibility data',
    'Clear processed visibility data of the given scenario instances. Requires PVAdmin.',
    { scenario_id: scenarioId, instance_ids: z.array(text(255)).min(1).max(1000), confirmation }, OVERWRITE_ANNOTATIONS,
    async ({ scenario_id, instance_ids, confirmation: given }) => {
      requireConfirmation(given, `CLEAR BPA VISIBILITY DATA ${scenario_id}`);
      await rest.request('PATCH', `${scenarioPath(scenario_id)}/data`, {
        json: instance_ids.map(id => ({ id, deleted: true })), expect: [200, 204], responseType: 'none'
      });
      return { cleared: instance_ids.length, scenario_id };
    });

  register('bpa_list_visibility_events', 'List acquired visibility events',
    'List acquired visibility events (kind events, max 5000; PVAdmin or PVTenantOperator) or data-acquisition errors (kind errors; PVAdmin).',
    z.object({
      kind: z.enum(['events', 'errors']).default('events'),
      process_definition_id: text(255).optional(),
      process_instance_id: text(255).optional(),
      event_type: text(255).optional(),
      environment_id: text(128).optional(),
      acquired_from: timestamp.optional(),
      acquired_up_to: timestamp.optional(),
      log_id: text(255).optional(),
      start_date_time: timestamp.optional(),
      end_date_time: timestamp.optional()
    }).superRefine((value, ctx) => {
      const foreign = (value.kind === 'events' ? ERROR_PARAMS : EVENT_PARAMS).filter(key => value[key] !== undefined);
      if (foreign.length) {
        ctx.addIssue({ code: 'custom', path: [foreign[0]], message: `${foreign.join(', ')} not allowed with kind ${value.kind}` });
      }
    }), READ_ONLY_ANNOTATIONS,
    async args => {
      if (args.kind === 'errors') {
        return rest.request('GET', `${REST}/data-acquisition/error-messages`, { query: {
          logId: args.log_id, startDateTime: args.start_date_time, endDateTime: args.end_date_time
        } });
      }
      return rest.request('GET', `${REST}/data-acquisition/data`, { query: {
        processDefinitionId: args.process_definition_id,
        processInstanceId: args.process_instance_id,
        eventType: args.event_type,
        environmentId: args.environment_id,
        acquiredFrom: args.acquired_from,
        acquiredUpto: args.acquired_up_to
      } });
    });

  register('bpa_push_visibility_events', 'Push visibility events',
    'Push process events to process visibility. Requires the PVEventSender role.',
    { events: z.array(visibilityEvent).min(1).max(1000), confirmation }, CREATE_ANNOTATIONS,
    async ({ events, confirmation: given }) => {
      requireConfirmation(given, `PUSH BPA VISIBILITY EVENTS ${events.length}`);
      await rest.request('POST', `${REST}/data-acquisition/data`, { json: events, expect: [204], responseType: 'none' });
      return { pushed: events.length };
    });

  register('bpa_list_visibility_workspace_scenarios', 'List visibility workspace scenarios',
    'List metadata of visibility scenarios the user can access in the workspace. Requires PVOperator or PVRestrictedOperator.',
    { select: text(500).optional() }, READ_ONLY_ANNOTATIONS,
    ({ select }) => rest.request('GET', `${ODATA}/metadata/Scenarios`, { query: { $select: select } }));

  register('bpa_list_visibility_instances', 'List visibility scenario instances',
    'List instances of a visibility scenario with OData options. Requires PVOperator or PVRestrictedOperator.',
    {
      scenario_id: scenarioId,
      filter: text(2000).optional().describe("OData $filter, e.g. status eq 'RUNNING'."),
      select: text(500).optional(),
      orderby: text(200).optional(),
      expand: text(200).optional(),
      search: text(255).optional().describe('Free-text search (sent as search=\'text\').'),
      top: top(200, 50),
      skip,
      inline_count: z.boolean().default(false)
    }, READ_ONLY_ANNOTATIONS,
    ({ scenario_id, filter, select, orderby, expand, search, top: $top, skip: $skip, inline_count }) =>
      rest.request('GET', `${ODATA}/${enc(scenario_id)}/Instances`, { query: {
        $filter: filter, $select: select, $orderby: orderby, $expand: expand,
        search: search === undefined ? undefined : odataString(search),
        $top, $skip, ...(inline_count ? { $inlinecount: 'allpages' } : {}), $format: 'json'
      } }));

  register('bpa_get_visibility_instance', 'Get visibility scenario instance',
    'Get a visibility scenario instance, optionally with its phases, paths and steps. Requires PVOperator or PVRestrictedOperator.',
    {
      scenario_id: scenarioId,
      instance_id: text(255),
      include: z.array(z.enum(['phases', 'paths', 'steps'])).max(3).default([])
    }, READ_ONLY_ANNOTATIONS,
    async ({ scenario_id, instance_id, include }) => {
      const base = instancePath(scenario_id, instance_id);
      const result = { instance: await rest.request('GET', base) };
      for (const part of ['phases', 'paths', 'steps']) {
        if (include.includes(part)) result[part] = await rest.request('GET', `${base}/${part[0].toUpperCase()}${part.slice(1)}`);
      }
      return result;
    });
}
