// SAP Build Process Automation Inbox API (OData v2 Task Consumption Model) tools: the signed-in
// user's task inbox, task details, task definitions, claim/release/forward and substitution rules.
// The API is user-centric: with technical (client-credentials) auth it shows the technical
// client's own inbox, which is normally empty.
import { z } from 'zod';
import { CREATE_ANNOTATIONS, OVERWRITE_ANNOTATIONS, READ_ONLY_ANNOTATIONS, confirmation, requireConfirmation } from './integration-common.mjs';
import { INBOX, enc, odataString, rows, skip, timestamp, top } from './process-automation-common.mjs';

export const INBOX_TOOL_NAMES = Object.freeze([
  'bpa_inbox_list_tasks',
  'bpa_inbox_get_task',
  'bpa_inbox_list_task_definitions',
  'bpa_inbox_task_action',
  'bpa_inbox_list_substitution_rules',
  'bpa_inbox_create_substitution_rule',
  'bpa_inbox_change_substitution_rule'
]);

const USER_SCOPE = 'Needs the ProcessAutomationParticipant role; returns the signed-in user\'s inbox (with technical auth the technical client\'s, normally empty).';

// Status values the TCM $filter accepts (other values fail with HTTP 400).
const FILTER_STATUS = z.enum(['READY', 'RESERVED', 'IN_PROGRESS', 'EXECUTED']);
const PRIORITY = z.enum(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']);
const ORDER_BY = z.enum([
  'TaskDefinitionName asc', 'TaskDefinitionName desc', 'TaskTitle asc', 'TaskTitle desc', 'Status asc', 'Status desc',
  'Priority asc', 'Priority desc', 'PriorityNumber asc', 'PriorityNumber desc', 'CreatedOn asc', 'CreatedOn desc',
  'CreatedByName asc', 'CreatedByName desc', 'CompletionDeadLine asc', 'CompletionDeadLine desc'
]);
const TASK_INCLUDES = Object.freeze({
  task_definition: '/TaskDefinitionData',
  workflow_logs: '/WorkflowLogs',
  description: '/Description',
  custom_attributes: '/CustomAttributeData'
});

const origin = z.string().min(1).max(100).describe('SAP__Origin of the task; \'NA\' for SAP Build Process Automation.');
const instanceId = z.string().min(1).max(255).describe('Task InstanceID.');
const text = max => z.string().min(1).max(max);

/** UTC milliseconds of an ISO timestamp; a timestamp without zone is read as UTC (TCM expects UTC). */
function utcMillis(value) {
  const zoned = /T/.test(value) && !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? `${value}Z` : value;
  return Date.parse(zoned);
}

/** OData v2 datetime literal, e.g. datetime'2026-11-05T00:00:00'. */
const datetimeLiteral = value => `datetime'${new Date(utcMillis(value)).toISOString().slice(0, 19)}'`;

/** Drop OData v2 `__metadata` and deferred navigation stubs so results stay compact. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__metadata') continue;
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1 && item.__deferred) continue;
    result[key] = clean(item);
  }
  return result;
}

const anyOf = (field, values) => {
  const terms = values.map(value => `${field} eq ${odataString(value)}`);
  return terms.length > 1 ? `(${terms.join(' or ')})` : terms[0];
};

/** One $filter from typed inputs; attributes are and-combined, multiple values of one attribute or-combined. */
function taskFilter({ status, task_definition_id, priority, created_from, created_up_to, due_from, due_up_to, custom_attributes }) {
  const parts = [];
  if (status?.length) parts.push(anyOf('Status', status));
  if (task_definition_id?.length) parts.push(anyOf('TaskDefinitionID', task_definition_id));
  if (priority?.length) parts.push(anyOf('Priority', priority));
  if (created_from) parts.push(`CreatedOn ge ${datetimeLiteral(created_from)}`);
  if (created_up_to) parts.push(`CreatedOn le ${datetimeLiteral(created_up_to)}`);
  if (due_from) parts.push(`CompletionDeadLine ge ${datetimeLiteral(due_from)}`);
  if (due_up_to) parts.push(`CompletionDeadLine le ${datetimeLiteral(due_up_to)}`);
  for (const { name, value } of custom_attributes ?? []) {
    parts.push(`(CustomAttributeData/Name eq ${odataString(name)} and CustomAttributeData/Value eq ${odataString(value)})`);
  }
  return parts.length ? parts.join(' and ') : undefined;
}

const taskKey = (sapOrigin, id) => `/TaskCollection(SAP__Origin=${enc(odataString(sapOrigin))},InstanceID=${enc(odataString(id))})`;

export function registerInboxTools(register, { rest }) {
  const get = (path, query = {}) => rest.request('GET', `${INBOX}${path}`, { query: { ...query, $format: 'json' } });
  const count = async (path, query = {}) => {
    const body = await rest.request('GET', `${INBOX}${path}/$count`, { query, accept: 'text/plain', responseType: 'text' });
    const value = Number(String(body ?? '').trim());
    return { count: Number.isFinite(value) ? value : null };
  };
  // Function imports take OData literals as query parameters and answer 202 with the changed entity.
  const functionImport = async (name, query) => clean(await rest.request('POST', `${INBOX}/${name}`, {
    query: { ...query, $format: 'json' },
    expect: [200, 202, 204]
  }));

  register('bpa_inbox_list_tasks', 'List inbox tasks',
    `List or count tasks in the Inbox (Task Consumption Model) with typed filters. ${USER_SCOPE}`,
    z.object({
      status: z.array(FILTER_STATUS).min(1).max(4).optional().describe('Defaults to the API default (READY or RESERVED).'),
      task_definition_id: z.array(text(255)).min(1).max(20).optional().describe('TaskDefinitionID values ({task name}@{workflow definition id}, lowercase).'),
      priority: z.array(PRIORITY).min(1).max(4).optional(),
      created_from: timestamp.optional().describe('CreatedOn ge (UTC).'),
      created_up_to: timestamp.optional().describe('CreatedOn le (UTC).'),
      due_from: timestamp.optional().describe('CompletionDeadLine ge (UTC).'),
      due_up_to: timestamp.optional().describe('CompletionDeadLine le (UTC).'),
      custom_attributes: z.array(z.object({ name: text(255), value: z.string().max(255) })).min(1).max(10).optional()
        .describe('Custom attribute name/value pairs, all must match; also filter task_definition_id for performance.'),
      orderby: z.array(ORDER_BY).min(1).max(2).default(['CreatedOn desc'])
        .describe('Up to two sort keys; TaskDefinitionName must come first when used.'),
      expand: z.array(z.enum(['Description', 'CustomAttributeData'])).max(2).optional(),
      top: top(200, 50),
      skip,
      count_only: z.boolean().default(false).describe('Return only the number of matching tasks (TaskCollection/$count).')
    }).refine(args => !args.orderby.slice(1).some(key => key.startsWith('TaskDefinitionName')), {
      message: 'TaskDefinitionName must be the first orderby key', path: ['orderby']
    }).refine(args => !(args.count_only && args.custom_attributes), {
      message: 'custom_attributes filters are not supported with count_only', path: ['custom_attributes']
    }),
    READ_ONLY_ANNOTATIONS,
    async args => {
      const filter = taskFilter(args);
      if (args.count_only) return count('/TaskCollection', filter ? { $filter: filter } : {});
      const tasks = await get('/TaskCollection', {
        ...(filter ? { $filter: filter } : {}),
        $orderby: args.orderby.join(','),
        ...(args.expand?.length ? { $expand: args.expand.join(',') } : {}),
        $top: args.top,
        $skip: args.skip
      });
      return { tasks: clean(rows(tasks)) };
    });

  register('bpa_inbox_get_task', 'Get inbox task',
    `Get one inbox task with optional task definition, workflow log, description and custom attributes. ${USER_SCOPE}`,
    {
      origin,
      instance_id: instanceId,
      include: z.array(z.enum(Object.keys(TASK_INCLUDES))).max(4).default([])
    },
    READ_ONLY_ANNOTATIONS,
    async ({ origin: sapOrigin, instance_id, include }) => {
      const key = taskKey(sapOrigin, instance_id);
      const result = { task: clean(await get(key)) };
      for (const name of new Set(include)) result[name] = clean(await get(`${key}${TASK_INCLUDES[name]}`));
      return result;
    });

  register('bpa_inbox_list_task_definitions', 'List inbox task definitions',
    `List (or count) the task definitions of the user's inbox tasks, or with origin and task_definition_id the custom attribute definitions of one. ${USER_SCOPE}`,
    z.object({
      origin: origin.optional(),
      task_definition_id: text(255).optional(),
      count_only: z.boolean().default(false).describe('Return only the number of task definitions (TaskDefinitionCollection/$count).')
    }).refine(args => Boolean(args.origin) === Boolean(args.task_definition_id), {
      message: 'provide both origin and task_definition_id, or neither', path: ['task_definition_id']
    }).refine(args => !(args.count_only && args.task_definition_id), {
      message: 'count_only lists all task definitions; omit origin and task_definition_id', path: ['count_only']
    }),
    READ_ONLY_ANNOTATIONS,
    async ({ origin: sapOrigin, task_definition_id, count_only }) => {
      if (count_only) return count('/TaskDefinitionCollection');
      if (task_definition_id) {
        const path = `/TaskDefinitionCollection(SAP__Origin=${enc(odataString(sapOrigin))},TaskDefinitionID=${enc(odataString(task_definition_id))})/CustomAttributeDefinitionData`;
        return { custom_attribute_definitions: clean(rows(await get(path))) };
      }
      return { task_definitions: clean(rows(await get('/TaskDefinitionCollection'))) };
    });

  register('bpa_inbox_task_action', 'Claim, release or forward inbox task',
    `Claim (to RESERVED), release (to READY) or forward (to another user, who becomes processor and recipient; the user id is not validated) an inbox task. ${USER_SCOPE}`,
    z.object({
      origin,
      instance_id: instanceId,
      action: z.enum(['claim', 'release', 'forward']),
      forward_to: text(255).optional().describe('User id to forward to; required for forward only.'),
      confirmation
    }).refine(args => (args.action === 'forward') === Boolean(args.forward_to), {
      message: 'forward_to is required for forward and not allowed otherwise', path: ['forward_to']
    }),
    OVERWRITE_ANNOTATIONS,
    async ({ origin: sapOrigin, instance_id, action, forward_to, confirmation: given }) => {
      requireConfirmation(given, `${action.toUpperCase()} BPA INBOX TASK ${instance_id}`);
      const name = { claim: 'Claim', release: 'Release', forward: 'Forward' }[action];
      const task = await functionImport(name, {
        SAP__Origin: odataString(sapOrigin),
        InstanceID: odataString(instance_id),
        ...(action === 'forward' ? { ForwardTo: odataString(forward_to) } : {})
      });
      return { action, instance_id, task };
    });

  register('bpa_inbox_list_substitution_rules', 'List substitution rules',
    `List the user's own substitution rules (my_rules) or the rules where the user is the substitute (substituting_for). ${USER_SCOPE}`,
    { scope: z.enum(['my_rules', 'substituting_for']).default('my_rules') },
    READ_ONLY_ANNOTATIONS,
    async ({ scope }) => ({
      rules: clean(rows(await get(scope === 'my_rules' ? '/SubstitutionRuleCollection' : '/SubstitutesRuleCollection')))
    }));

  register('bpa_inbox_create_substitution_rule', 'Create substitution rule',
    `Create a substitution rule for the signed-in user: RECEIVE_TASKS (planned, enabled, needs end_date) or TAKE_OVER (unplanned, disabled until the substitute enables it). ${USER_SCOPE}`,
    z.object({
      user: text(255).describe('User id of the substitute.'),
      begin_date: timestamp.describe('UTC begin; yesterday, today or later.'),
      end_date: timestamp.optional().describe('UTC end; required for RECEIVE_TASKS, ignored for TAKE_OVER.'),
      mode: z.enum(['RECEIVE_TASKS', 'TAKE_OVER']),
      enabled: z.boolean().optional().describe('Must be true for RECEIVE_TASKS and false for TAKE_OVER; derived from mode when omitted.'),
      origin: origin.default('NA'),
      confirmation
    }).refine(args => args.mode !== 'RECEIVE_TASKS' || Boolean(args.end_date), {
      message: 'end_date is required for RECEIVE_TASKS', path: ['end_date']
    }).refine(args => args.enabled === undefined || args.enabled === (args.mode === 'RECEIVE_TASKS'), {
      message: 'enabled must be true for RECEIVE_TASKS and false for TAKE_OVER', path: ['enabled']
    }),
    CREATE_ANNOTATIONS,
    async ({ user, begin_date, end_date, mode, origin: sapOrigin, confirmation: given }) => {
      requireConfirmation(given, `CREATE BPA SUBSTITUTION FOR ${user}`);
      const rule = await rest.request('POST', `${INBOX}/SubstitutionRuleCollection`, {
        query: { $format: 'json' },
        json: {
          SAP__Origin: sapOrigin,
          User: user,
          BeginDate: `/Date(${utcMillis(begin_date)})/`,
          ...(mode === 'RECEIVE_TASKS' ? { EndDate: `/Date(${utcMillis(end_date)})/` } : {}),
          Mode: mode,
          IsEnabled: mode === 'RECEIVE_TASKS'
        },
        expect: [200, 201]
      });
      return { rule: clean(rule) };
    });

  register('bpa_inbox_change_substitution_rule', 'Enable, disable or delete substitution rule',
    `Enable or disable a passive (TAKE_OVER) substitution rule where the user is the substitute, or delete one of the user's substitution rules. ${USER_SCOPE}`,
    { rule_id: text(255).describe('SubstitutionRuleID.'), action: z.enum(['enable', 'disable', 'delete']), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ rule_id, action, confirmation: given }) => {
      requireConfirmation(given, `${action.toUpperCase()} BPA SUBSTITUTION ${rule_id}`);
      const rule = action === 'delete'
        ? await functionImport('DeleteSubstitutionRule', { SubstitutionRuleID: odataString(rule_id) })
        : await functionImport('EnableSubstitutionRule', { SubstitutionRuleID: odataString(rule_id), Enabled: action === 'enable' ? 'true' : 'false' });
      return { action, rule_id, rule: rule ?? null };
    });
}
