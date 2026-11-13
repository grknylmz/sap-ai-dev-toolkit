// MCP tools for SAP Build Process Automation. This module owns the Workflow
// Runtime API (definitions, instances, user tasks, admin jobs), decisions and
// business events, and registers the Inbox, Automation/Unified trigger and
// Visibility modules. Every write checks an exact confirmation string before any
// tenant call, and every result passes through secret redaction.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CREATE_ANNOTATIONS,
  OVERWRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  confirmation,
  pick,
  redactSecrets,
  requireConfirmation,
  resultOf
} from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';
import {
  EVENTS,
  RULES,
  WORKFLOW,
  apiKeyHeaders,
  capContext,
  enc,
  environmentId,
  environmentQuery,
  guid,
  identifier,
  outputFile,
  payload,
  rows,
  skip,
  timestamp,
  top,
  writeExportFile
} from './process-automation-common.mjs';
import { INBOX_TOOL_NAMES, registerInboxTools } from './process-automation-inbox-tools.mjs';
import { AUTOMATION_TOOL_NAMES, registerAutomationTools } from './process-automation-automation-tools.mjs';
import { VISIBILITY_TOOL_NAMES, registerVisibilityTools } from './process-automation-visibility-tools.mjs';

const ERROR_DETAIL_LIMIT = 10;
const TRACE_LOG_LIMIT = 20;
const TRACE_TASK_LIMIT = 50;

const definitionId = identifier('process definition id');
const ruleServiceId = identifier('decision rule service id');
const INSTANCE_STATUS = z.enum(['RUNNING', 'ERRONEOUS', 'SUSPENDED', 'CANCELED', 'COMPLETED']);
const TASK_STATUS = z.enum(['READY', 'RESERVED', 'COMPLETED', 'CANCELED']);
const PRIORITY = z.enum(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']);
const OPEN_TASK_STATUSES = new Set(['READY', 'RESERVED']);
const userList = z.array(z.string().min(1).max(255)).max(100);

const INSTANCE_FIELDS = 'id,definitionId,definitionVersion,subject,status,businessKey,startedAt,startedBy,completedAt,parentInstanceId,rootInstanceId,projectId,projectVersion,applicationScope,attributes'.split(',');
const TASK_FIELDS = 'id,activityId,subject,description,status,priority,dueDate,createdAt,createdBy,claimedAt,completedAt,lastChangedAt,processor,recipientUsers,recipientGroups,workflowInstanceId,workflowDefinitionId,definitionId,applicationScope,userInterfaceUri,attributes'.split(',');
const DEFINITION_FIELDS = 'id,name,version,createdAt,createdBy,applicationScope,jobs'.split(',');

const TRANSITIONS = Object.freeze({
  cancel: Object.freeze({ from: ['RUNNING', 'ERRONEOUS', 'SUSPENDED'], to: 'CANCELED' }),
  suspend: Object.freeze({ from: ['RUNNING', 'ERRONEOUS'], to: 'SUSPENDED' }),
  resume: Object.freeze({ from: ['SUSPENDED'], to: 'RUNNING' }),
  retry: Object.freeze({ from: ['ERRONEOUS'], to: 'RUNNING' })
});

const INSTANCE_ORDER = z.enum(['startedAt desc', 'startedAt asc', 'completedAt desc', 'completedAt asc', 'definitionId asc', 'definitionId desc', 'subject asc', 'subject desc', 'businessKey asc', 'businessKey desc', 'id asc', 'id desc']);
const TASK_ORDER = z.enum(['createdAt desc', 'createdAt asc', 'dueDate asc', 'dueDate desc', 'priority desc', 'priority asc', 'claimedAt desc', 'claimedAt asc', 'completedAt desc', 'completedAt asc', 'lastChangedAt desc', 'lastChangedAt asc', 'subject asc', 'subject desc']);
const DEFINITION_ORDER = z.enum(['id asc', 'id desc', 'name asc', 'name desc', 'version asc', 'version desc', 'createdAt asc', 'createdAt desc']);

export const WORKFLOW_TOOL_NAMES = Object.freeze([
  'bpa_connection_info',
  'bpa_list_process_definitions',
  'bpa_get_process_definition',
  'bpa_delete_process_definition',
  'bpa_list_task_definitions',
  'bpa_delete_form',
  'bpa_list_instances',
  'bpa_get_instance',
  'bpa_find_stuck_instances',
  'bpa_trace_process',
  'bpa_start_instance',
  'bpa_change_instance_status',
  'bpa_update_instance_context',
  'bpa_update_instance_roles',
  'bpa_delete_instances',
  'bpa_send_message',
  'bpa_list_tasks',
  'bpa_get_task',
  'bpa_complete_task',
  'bpa_update_tasks',
  'bpa_update_task_context',
  'bpa_export_workflow_data',
  'bpa_purge_workflow_data',
  'bpa_get_job',
  'bpa_invoke_decision',
  'bpa_test_decision',
  'bpa_send_business_event'
]);

export const PROCESS_AUTOMATION_TOOL_NAMES = Object.freeze([
  ...WORKFLOW_TOOL_NAMES,
  ...INBOX_TOOL_NAMES,
  ...AUTOMATION_TOOL_NAMES,
  ...VISIBILITY_TOOL_NAMES
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Expected values are a subset: extra actual keys/elements are allowed. */
function subsetMismatches(expected, actual, path = '$') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return [{ path, expected, actual }];
    return expected.flatMap((item, index) => subsetMismatches(item, actual[index], `${path}[${index}]`));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [{ path, expected, actual }];
    return Object.keys(expected).flatMap(name => (Object.hasOwn(actual, name)
      ? subsetMismatches(expected[name], actual[name], `${path}.${name}`)
      : [{ path: `${path}.${name}`, expected: expected[name], actual: undefined }]));
  }
  return Object.is(expected, actual) ? [] : [{ path, expected, actual }];
}

function transition(action, instanceId, status) {
  const { from, to } = TRANSITIONS[action];
  if (!from.includes(status)) throw new IntegrationError(`instance ${instanceId} is ${status}; ${action} requires ${from.join(' or ')}`);
  return to;
}

/** 202/303 responses of asynchronous workflow operations point at /v1/jobs/{id}. */
function asyncOutcome({ status, responseHeaders }) {
  const jobId = /\/jobs\/([^/?#]+)/.exec(responseHeaders?.location ?? '')?.[1];
  return {
    status,
    ...(status === 303 ? { already_running: true } : {}),
    ...(jobId ? { job_id: decodeURIComponent(jobId) } : {})
  };
}

/** Register all SAP Build Process Automation tools; returns the registered names. */
export function registerProcessAutomationTools(server, { rest, summary, verify, access = {}, now = Date.now } = {}) {
  const registeredNames = [];
  const register = (name, title, description, inputSchema, annotations, handler) => {
    registeredNames.push(name);
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(
      async () => redactSecrets(await handler(args)),
      { product: 'SAP Build Process Automation', fallback: 'SAP Build Process Automation request failed. Check the service key, the user\'s role collections, the API key scopes and API reachability.' }
    ));
  };

  const get = (path, query) => rest.request('GET', `${WORKFLOW}${path}`, query ? { query } : {});
  const getInstance = id => get(`/workflow-instances/${enc(id)}`);
  const getTask = id => get(`/task-instances/${enc(id)}`);
  const errorMessages = async id => rows(await get(`/workflow-instances/${enc(id)}/error-messages`));
  const invokeDecision = (id, vocabulary, revision, version) => rest.request('POST', RULES, {
    json: {
      RuleServiceId: id,
      Vocabulary: vocabulary,
      ...(revision ? { RuleServiceRevision: revision } : {}),
      ...(version ? { RuleServiceVersion: version } : {})
    },
    expect: [200]
  });
  const asyncCall = async (method, path, options = {}) => asyncOutcome(await rest.request(method, `${WORKFLOW}${path}`, {
    ...options,
    responseType: 'none',
    withStatus: true,
    responseHeaders: ['location']
  }));

  // ------------------------------------------------------------ connection

  register('bpa_connection_info', 'Process Automation connection info',
    'Report the connected API host, token host, auth mode, credential source, task attribution, and whether an environment API key and default environment are configured. Verification is read-only and never returns credentials.',
    { verify: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ verify: online }) => {
      const verification = online && verify ? await verify() : undefined;
      return { ...summary, ...(verification ? { verification } : {}) };
    });

  // ------------------------------------------------------------ definitions

  register('bpa_list_process_definitions', 'List process definitions',
    'List the latest version of each deployed process (workflow) definition. Roles: ProcessAutomationAdmin or ProcessAutomationDeveloper.',
    { top: top(200, 100), skip, orderby: DEFINITION_ORDER.optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ top: limit, skip: offset, orderby }) => rows(await get('/workflow-definitions', { $top: limit, $skip: offset, $orderby: orderby }))
      .map(row => pick(row, DEFINITION_FIELDS)));

  register('bpa_get_process_definition', 'Get process definition',
    'Read a deployed process definition (latest or one version), optionally with its model, its default start context and the list of deployed versions.',
    {
      definition_id: definitionId,
      version: z.string().regex(/^\d{1,9}$/, 'expected a version number').optional(),
      include: z.array(z.enum(['model', 'sample_start_context', 'versions'])).max(3).default([])
    },
    READ_ONLY_ANNOTATIONS,
    async ({ definition_id: id, version, include }) => {
      const base = `/workflow-definitions/${enc(id)}${version ? `/versions/${enc(version)}` : ''}`;
      const wanted = new Set(include);
      const result = { definition: await get(base) };
      if (wanted.has('model')) result.model = await get(`${base}/model`);
      if (wanted.has('sample_start_context')) result.sample_start_context = await get(`${base}/sample-contexts/default-start-context`);
      if (wanted.has('versions')) result.versions = rows(await get(`/workflow-definitions/${enc(id)}/versions`, { $orderby: 'version desc' })).map(row => pick(row, DEFINITION_FIELDS));
      return result;
    });

  register('bpa_delete_process_definition', 'Undeploy process definition',
    'Undeploy all versions of a classic workflow definition (SAP Business Application Studio) and delete its instances; asynchronous, returns the job id for bpa_get_job. Processes built in SAP Build are deleted through their project instead. Role: ProcessAutomationAdmin. Requires confirmation "DELETE BPA DEFINITION <definition_id>".',
    { definition_id: definitionId, cascade: z.boolean().default(false), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ definition_id: id, cascade, confirmation: given }) => {
      requireConfirmation(given, `DELETE BPA DEFINITION ${id}`);
      return asyncCall('DELETE', `/workflow-definitions/${enc(id)}`, { query: { cascade }, expect: [202, 303] });
    });

  register('bpa_list_task_definitions', 'List task definitions',
    'List user-task definitions (activity id + workflow definition id), optionally with their custom attribute definitions.',
    { top: top(200, 100), skip, include_attribute_definitions: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ top: limit, skip: offset, include_attribute_definitions: expand }) => rows(await get('/task-definitions', {
      $top: limit,
      $skip: offset,
      ...(expand ? { $expand: 'attributeDefinitions' } : {})
    })));

  register('bpa_delete_form', 'Undeploy classic form',
    'Undeploy all versions of a classic workflow form (SAP Business Application Studio). Role: ProcessAutomationAdmin. Requires confirmation "DELETE BPA FORM <form_id>".',
    { form_id: identifier('form id'), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ form_id: id, confirmation: given }) => {
      requireConfirmation(given, `DELETE BPA FORM ${id}`);
      await rest.request('DELETE', `${WORKFLOW}/forms/${enc(id)}`, { expect: [204], responseType: 'none' });
      return { deleted: id };
    });

  // ------------------------------------------------------------ instances

  register('bpa_list_instances', 'List workflow instances',
    'List workflow instances (default newest first). Multiple statuses are OR-combined; other filters are AND-combined. Without a status filter BPA returns RUNNING and ERRONEOUS instances. Role: ProcessAutomationAdmin.',
    {
      definition_id: definitionId.optional(),
      definition_version: z.string().regex(/^\d{1,9}$/).optional(),
      status: z.array(INSTANCE_STATUS).min(1).max(5).optional(),
      business_key: z.string().min(1).max(255).optional(),
      contains_text: z.string().min(1).max(255).optional(),
      subject: z.string().min(1).max(255).optional(),
      started_by: z.string().min(1).max(255).optional(),
      started_from: timestamp.optional(),
      started_up_to: timestamp.optional(),
      completed_from: timestamp.optional(),
      completed_up_to: timestamp.optional(),
      root_instance_id: guid.optional(),
      parent_instance_id: guid.optional(),
      project_id: z.string().min(1).max(255).optional(),
      project_version: z.string().min(1).max(64).optional(),
      include_attributes: z.boolean().default(false),
      orderby: INSTANCE_ORDER.default('startedAt desc'),
      top: top(200, 50),
      skip
    },
    READ_ONLY_ANNOTATIONS,
    async args => rows(await get('/workflow-instances', {
      definitionId: args.definition_id,
      definitionVersion: args.definition_version,
      status: args.status,
      businessKey: args.business_key,
      containsText: args.contains_text,
      subject: args.subject,
      startedBy: args.started_by,
      startedFrom: args.started_from,
      startedUpTo: args.started_up_to,
      completedFrom: args.completed_from,
      completedUpTo: args.completed_up_to,
      rootInstanceId: args.root_instance_id,
      parentInstanceId: args.parent_instance_id,
      projectId: args.project_id,
      projectVersion: args.project_version,
      ...(args.include_attributes ? { $expand: 'attributes' } : {}),
      $orderby: args.orderby,
      $top: args.top,
      $skip: args.skip
    })).map(row => pick(row, INSTANCE_FIELDS)));

  register('bpa_get_instance', 'Get workflow instance',
    'Read one workflow instance with optional context (capped at 48 KiB, or one context fragment by path), outputs (COMPLETED only), execution logs, error messages, custom attributes and instance role assignments.',
    {
      instance_id: guid,
      include: z.array(z.enum(['context', 'outputs', 'execution_logs', 'error_messages', 'attributes', 'roles'])).max(6).default(['error_messages']),
      context_path: z.string().regex(/^[A-Za-z0-9_$][A-Za-z0-9_$./-]{0,499}$/, 'expected a context path such as order/items').optional()
        .describe('Read only this context fragment (e.g. order/items) instead of the whole context.'),
      log_limit: z.number().int().min(1).max(200).default(50)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ instance_id: id, include, context_path: contextPath, log_limit: logLimit }) => {
      const base = `/workflow-instances/${enc(id)}`;
      const result = { instance: await get(base) };
      const wanted = new Set(include);
      if (contextPath) {
        const path = contextPath.split('/').map(enc).join('/');
        Object.assign(result, capContext(await get(`${base}/context/${path}`)));
      } else if (wanted.has('context')) {
        Object.assign(result, capContext(await get(`${base}/context`)));
      }
      if (wanted.has('outputs')) Object.assign(result, capContext(await get(`${base}/outputs`), 'outputs'));
      if (wanted.has('execution_logs')) result.execution_logs = rows(await get(`${base}/execution-logs`)).slice(-logLimit);
      if (wanted.has('error_messages')) result.error_messages = await errorMessages(id);
      if (wanted.has('attributes')) result.attributes = await get(`${base}/attributes`);
      if (wanted.has('roles')) result.roles = await get(`${base}/roles`);
      return result;
    });

  register('bpa_find_stuck_instances', 'Find stuck workflow instances',
    'Find erroneous instances (with their first error messages), suspended instances, and running instances older than a threshold.',
    {
      definition_id: definitionId.optional(),
      running_longer_than_minutes: z.number().int().min(1).max(43_200).default(60),
      top: top(100, 25)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ definition_id, running_longer_than_minutes: minutes, top: limit }) => {
      const byStatus = async status => rows(await get('/workflow-instances', {
        definitionId: definition_id,
        status,
        $orderby: 'startedAt asc',
        $top: limit
      })).map(row => pick(row, INSTANCE_FIELDS));
      const [erroneous, suspended, running] = [await byStatus('ERRONEOUS'), await byStatus('SUSPENDED'), await byStatus('RUNNING')];
      const cutoff = now() - minutes * 60_000;
      for (const row of erroneous.slice(0, ERROR_DETAIL_LIMIT)) row.error_messages = await errorMessages(row.id);
      return {
        erroneous,
        suspended,
        long_running: running.filter(row => Date.parse(row.startedAt) < cutoff),
        cutoff: new Date(cutoff).toISOString()
      };
    });

  register('bpa_trace_process', 'Trace process end to end',
    'Resolve workflow instances by id, business key or contained text (e.g. the correlation value from the ABAP/RAP event or CPI message) and return per instance its status, error messages, user tasks (all statuses; open ones appear in My Inbox / Fiori Task Center) and recent execution logs.',
    z.object({
      instance_id: guid.optional(),
      business_key: z.string().min(1).max(255).optional(),
      contains_text: z.string().min(1).max(255).optional(),
      max_instances: z.number().int().min(1).max(10).default(5)
    }).refine(
      args => [args.instance_id, args.business_key, args.contains_text].filter(value => value !== undefined).length === 1,
      'provide exactly one of instance_id, business_key, contains_text'
    ),
    READ_ONLY_ANNOTATIONS,
    async ({ instance_id, business_key, contains_text, max_instances: maxInstances }) => {
      const instances = instance_id
        ? [await getInstance(instance_id)]
        : rows(await get('/workflow-instances', {
          businessKey: business_key,
          containsText: contains_text,
          status: INSTANCE_STATUS.options,
          $orderby: 'startedAt desc',
          $top: maxInstances
        }));
      const traced = [];
      for (const raw of instances) {
        const instance = pick(raw, INSTANCE_FIELDS);
        const base = `/workflow-instances/${enc(instance.id)}`;
        traced.push({
          instance,
          ...(instance.status === 'ERRONEOUS' ? { error_messages: await errorMessages(instance.id) } : {}),
          tasks: rows(await get('/task-instances', { workflowInstanceId: instance.id, $top: TRACE_TASK_LIMIT })).map(row => pick(row, TASK_FIELDS)),
          recent_logs: rows(await get(`${base}/execution-logs`)).slice(-TRACE_LOG_LIMIT)
        });
      }
      return { instances: traced };
    });

  register('bpa_start_instance', 'Start process instance',
    'Start a workflow instance of the latest deployed version of a definition with the given start context (see bpa_get_process_definition include sample_start_context). With an environment API key configured it is sent as api-key for shared environments. Role: ProcessAutomationParticipant. Requires confirmation "START BPA PROCESS <definition_id>".',
    { definition_id: definitionId, context: payload, environment_id: environmentId, confirmation },
    CREATE_ANNOTATIONS,
    async ({ definition_id: id, context, environment_id: environment, confirmation: given }) => {
      requireConfirmation(given, `START BPA PROCESS ${id}`);
      const instance = await rest.request('POST', `${WORKFLOW}/workflow-instances`, {
        query: environmentQuery(access, environment),
        headers: apiKeyHeaders(access, 'api-key'),
        json: { definitionId: id, context },
        expect: [200, 201]
      });
      return pick(instance, INSTANCE_FIELDS);
    });

  register('bpa_change_instance_status', 'Change workflow instance status',
    'Cancel, suspend, resume or retry a workflow instance after checking its current status; cascade also applies the change to subflow instances. Status changes may take effect asynchronously. Role: ProcessAutomationAdmin. Requires confirmation "<ACTION> BPA INSTANCE <instance_id>" (e.g. "RETRY BPA INSTANCE <id>").',
    { instance_id: guid, action: z.enum(['cancel', 'suspend', 'resume', 'retry']), cascade: z.boolean().default(false), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ instance_id: id, action, cascade, confirmation: given }) => {
      requireConfirmation(given, `${action.toUpperCase()} BPA INSTANCE ${id}`);
      const before = await getInstance(id);
      const status = transition(action, id, before?.status);
      await rest.request('PATCH', `${WORKFLOW}/workflow-instances/${enc(id)}`, {
        json: { status, ...(cascade ? { cascade: true } : {}) },
        expect: [200, 202, 204],
        responseType: 'none'
      });
      const after = await getInstance(id);
      return { before: before?.status, after: after?.status, instance: pick(after, INSTANCE_FIELDS) };
    });

  register('bpa_update_instance_context', 'Update workflow instance context',
    'Merge into (PATCH) or replace (PUT) the context of a workflow instance, e.g. to correct data before retry or to remove sensitive data. Suspend the instance first. Role: ProcessAutomationAdmin. Requires confirmation "MERGE BPA CONTEXT <instance_id>" or "REPLACE BPA CONTEXT <instance_id>".',
    { instance_id: guid, mode: z.enum(['merge', 'replace']), context: payload, confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ instance_id: id, mode, context, confirmation: given }) => {
      requireConfirmation(given, `${mode.toUpperCase()} BPA CONTEXT ${id}`);
      const path = `${WORKFLOW}/workflow-instances/${enc(id)}/context`;
      await rest.request(mode === 'merge' ? 'PATCH' : 'PUT', path, { json: context, expect: [200, 204], responseType: 'none' });
      return { instance_id: id, mode, ...capContext(await rest.request('GET', path)) };
    });

  register('bpa_update_instance_roles', 'Update workflow instance roles',
    'Overwrite instance-specific role assignments (viewer, admin, context viewer, context admin users/groups; max 100 each); omitted roles stay unchanged. Role: ProcessAutomationAdmin. Requires confirmation "UPDATE BPA ROLES <instance_id>".',
    {
      instance_id: guid,
      viewer_users: userList.optional(),
      viewer_groups: userList.optional(),
      admin_users: userList.optional(),
      admin_groups: userList.optional(),
      context_viewer_users: userList.optional(),
      context_viewer_groups: userList.optional(),
      context_admin_users: userList.optional(),
      context_admin_groups: userList.optional(),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ instance_id: id, confirmation: given, ...roles }) => {
      requireConfirmation(given, `UPDATE BPA ROLES ${id}`);
      const body = Object.fromEntries(Object.entries(roles)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
      if (!Object.keys(body).length) throw new IntegrationError('provide at least one role assignment to update');
      const path = `${WORKFLOW}/workflow-instances/${enc(id)}/roles`;
      await rest.request('PATCH', path, { json: body, expect: [200, 204], responseType: 'none' });
      return { instance_id: id, roles: await rest.request('GET', path) };
    });

  register('bpa_delete_instances', 'Delete workflow instances',
    'Permanently delete workflow instances (up to 1000 per call); asynchronous for larger sets, returns the job id for bpa_get_job. Role: ProcessAutomationAdmin. Requires confirmation "DELETE BPA INSTANCES <count>".',
    { instance_ids: z.array(guid).min(1).max(1000), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ instance_ids: ids, confirmation: given }) => {
      const unique = [...new Set(ids)];
      requireConfirmation(given, `DELETE BPA INSTANCES ${unique.length}`);
      return { requested: unique.length, ...await asyncCall('PATCH', '/workflow-instances', { json: unique.map(id => ({ id, deleted: true })), expect: [200, 202] }) };
    });

  register('bpa_send_message', 'Send workflow message',
    'Deliver a message to workflow instances waiting in an intermediate message event (classic workflows only; processes built in SAP Build resume through bpa_execute_api_trigger with execution_id). Target by instance id, or by workflow definition and/or business key. Requires confirmation "SEND BPA MESSAGE <message_definition_id>".',
    z.object({
      message_definition_id: identifier('message definition id'),
      workflow_instance_id: guid.optional(),
      workflow_definition_id: definitionId.optional(),
      business_key: z.string().min(1).max(255).optional(),
      context: payload.optional(),
      confirmation
    }).refine(args => args.workflow_instance_id || args.workflow_definition_id || args.business_key,
      'provide workflow_instance_id, workflow_definition_id or business_key'),
    CREATE_ANNOTATIONS,
    async ({ message_definition_id: messageId, workflow_instance_id, workflow_definition_id, business_key, context, confirmation: given }) => {
      requireConfirmation(given, `SEND BPA MESSAGE ${messageId}`);
      const consumers = await rest.request('POST', `${WORKFLOW}/messages`, {
        json: {
          definitionId: messageId,
          ...(workflow_instance_id ? { workflowInstanceId: workflow_instance_id } : {}),
          ...(workflow_definition_id ? { workflowDefinitionId: workflow_definition_id } : {}),
          ...(business_key ? { businessKey: business_key } : {}),
          ...(context ? { context } : {})
        },
        expect: [200]
      });
      return { consumed_by: rows(consumers) };
    });

  // ------------------------------------------------------------ user tasks

  register('bpa_list_tasks', 'List user tasks',
    'List user-task instances (the queue behind My Inbox / Fiori Task Center), newest first; open tasks by default. Multiple statuses or priorities are OR-combined.',
    {
      status: z.array(TASK_STATUS).min(1).max(4).default(['READY', 'RESERVED']),
      priority: z.array(PRIORITY).min(1).max(4).optional(),
      workflow_instance_id: guid.optional(),
      workflow_definition_id: definitionId.optional(),
      definition_id: z.string().min(1).max(255).optional().describe('Task definition id, e.g. usertask1@orderapproval'),
      activity_id: z.string().min(1).max(255).optional(),
      recipient_user: z.string().min(1).max(255).optional(),
      recipient_group: z.string().min(1).max(255).optional(),
      processor: z.string().min(1).max(255).optional(),
      contains_text: z.string().min(1).max(255).optional(),
      created_from: timestamp.optional(),
      created_up_to: timestamp.optional(),
      due_date_from: timestamp.optional(),
      due_date_up_to: timestamp.optional(),
      completed_from: timestamp.optional(),
      completed_up_to: timestamp.optional(),
      include_attributes: z.boolean().default(false),
      orderby: TASK_ORDER.default('createdAt desc'),
      top: top(200, 50),
      skip
    },
    READ_ONLY_ANNOTATIONS,
    async args => rows(await get('/task-instances', {
      status: args.status,
      priority: args.priority,
      workflowInstanceId: args.workflow_instance_id,
      workflowDefinitionId: args.workflow_definition_id,
      definitionId: args.definition_id,
      activityId: args.activity_id,
      recipientUsers: args.recipient_user,
      recipientGroups: args.recipient_group,
      processor: args.processor,
      containsText: args.contains_text,
      createdFrom: args.created_from,
      createdUpTo: args.created_up_to,
      dueDateFrom: args.due_date_from,
      dueDateUpTo: args.due_date_up_to,
      completedFrom: args.completed_from,
      completedUpTo: args.completed_up_to,
      ...(args.include_attributes ? { $expand: 'attributes' } : {}),
      $orderby: args.orderby,
      $top: args.top,
      $skip: args.skip
    })).map(row => pick(row, TASK_FIELDS)));

  register('bpa_get_task', 'Get user task',
    'Read one user-task instance, by default with its context (capped at 48 KiB) and optionally its custom attributes.',
    { task_id: guid, include_context: z.boolean().default(true), include_attributes: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ task_id: id, include_context: includeContext, include_attributes: includeAttributes }) => {
      const result = { task: await getTask(id) };
      if (includeContext) Object.assign(result, capContext(await get(`/task-instances/${enc(id)}/context`)));
      if (includeAttributes) result.attributes = await get(`/task-instances/${enc(id)}/attributes`);
      return result;
    });

  register('bpa_complete_task', 'Complete user task',
    'Complete an open user task, optionally with a decision (the form button id) and output context. Requires confirmation "COMPLETE BPA TASK <task_id>".',
    { task_id: guid, decision: z.string().min(1).max(255).optional(), context: payload.optional(), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ task_id: id, decision, context, confirmation: given }) => {
      requireConfirmation(given, `COMPLETE BPA TASK ${id}`);
      const before = await getTask(id);
      if (!OPEN_TASK_STATUSES.has(before?.status)) throw new IntegrationError(`task ${id} is ${before?.status}; only open tasks can be completed`);
      await rest.request('PATCH', `${WORKFLOW}/task-instances/${enc(id)}`, {
        json: { status: 'COMPLETED', ...(decision ? { decision } : {}), ...(context ? { context } : {}) },
        expect: [200, 204],
        responseType: 'none'
      });
      const after = await getTask(id);
      return { before: before?.status, after: after?.status, ...(decision ? { decision } : {}) };
    });

  register('bpa_update_tasks', 'Update user tasks',
    'Administratively change properties of up to 100 user tasks: subject, description, recipients, processor (claim/release by admin: set or clear), due date, priority, confidence level, UI URI. Asynchronous; returns the job id. Role: ProcessAutomationAdmin. Requires confirmation "UPDATE BPA TASKS <count>".',
    {
      updates: z.array(z.object({
        id: guid,
        subject: z.string().min(1).max(255).optional(),
        description: z.string().max(1024).optional(),
        recipient_users: z.string().max(5000).optional().describe('Comma-separated user ids'),
        recipient_groups: z.string().max(5000).optional().describe('Comma-separated group ids'),
        processor: z.string().max(255).optional().describe('User id; empty string releases the task'),
        due_date: timestamp.optional(),
        priority: PRIORITY.optional(),
        confidence_level: z.number().min(0).max(1).optional(),
        user_interface_uri: z.string().max(2048).optional()
      })).min(1).max(100),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ updates, confirmation: given }) => {
      requireConfirmation(given, `UPDATE BPA TASKS ${updates.length}`);
      const body = updates.map(({ id, recipient_users, recipient_groups, due_date, confidence_level, user_interface_uri, ...rest }) => ({
        id,
        ...rest,
        ...(recipient_users !== undefined ? { recipientUsers: recipient_users } : {}),
        ...(recipient_groups !== undefined ? { recipientGroups: recipient_groups } : {}),
        ...(due_date !== undefined ? { dueDate: due_date } : {}),
        ...(confidence_level !== undefined ? { confidenceLevel: confidence_level } : {}),
        ...(user_interface_uri !== undefined ? { userInterfaceUri: user_interface_uri } : {})
      }));
      if (body.some(update => Object.keys(update).length === 1)) throw new IntegrationError('every update needs at least one property besides id');
      return { requested: body.length, ...await asyncCall('PATCH', '/task-instances', { json: body, expect: [200, 202, 204] }) };
    });

  register('bpa_update_task_context', 'Update user task context',
    'Merge a payload into the stored context of a user task (exceptional corrections only; prefer the task input mapping). Requires confirmation "UPDATE BPA TASK CONTEXT <task_id>".',
    { task_id: guid, context: payload, confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ task_id: id, context, confirmation: given }) => {
      requireConfirmation(given, `UPDATE BPA TASK CONTEXT ${id}`);
      const path = `${WORKFLOW}/task-instances/${enc(id)}/context`;
      await rest.request('PATCH', path, { json: context, expect: [200, 204], responseType: 'none' });
      return { task_id: id, ...capContext(await rest.request('GET', path)) };
    });

  // ------------------------------------------------------------ administration

  register('bpa_export_workflow_data', 'Export workflow data',
    'Download the workflow data export (ZIP of definitions/forms metadata, workflow instances and/or task instances) to a new local file. Role: ProcessAutomationAdmin.',
    {
      type: z.enum(['ALL', 'TASK_INSTANCES', 'WORKFLOW_INSTANCES', 'ALL_DEFINITIONS']).default('ALL'),
      created_from: timestamp.optional(),
      created_up_to: timestamp.optional(),
      collection_query: z.enum(['own', 'shared']).optional(),
      output_file: outputFile
    },
    READ_ONLY_ANNOTATIONS,
    async ({ type, created_from, created_up_to, collection_query, output_file: path }) => {
      const bytes = await rest.request('GET', `${WORKFLOW}/export`, {
        query: { type, createdFrom: created_from, createdUpTo: created_up_to, collectionQuery: collection_query },
        accept: 'application/zip',
        responseType: 'bytes'
      });
      return { type, ...await writeExportFile(path, bytes) };
    });

  register('bpa_purge_workflow_data', 'Purge all workflow data',
    'Irreversibly erase ALL workflow definitions, workflow instances and form definitions of the tenant; asynchronous, returns the job id. Role: ProcessAutomationAdmin. Requires confirmation "PURGE ALL BPA WORKFLOW DATA".',
    { confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ confirmation: given }) => {
      requireConfirmation(given, 'PURGE ALL BPA WORKFLOW DATA');
      return asyncCall('POST', '/purge', { expect: [202, 303] });
    });

  register('bpa_get_job', 'Get workflow job status',
    'Track an asynchronous workflow operation (definition undeployment, purge, bulk instance deletion, bulk task update) by the job id those tools return. Role: ProcessAutomationAdmin.',
    { job_id: identifier('job id') },
    READ_ONLY_ANNOTATIONS,
    async ({ job_id: id }) => get(`/jobs/${enc(id)}`));

  // ------------------------------------------------------------ decisions

  register('bpa_invoke_decision', 'Invoke decision',
    'Evaluate a deployed decision (rule service) with input vocabulary objects such as [{ "<InputTypeName>": { ... } }]; latest deployment unless a revision/version is given. Rule-service ids come from the deployed project; there is no list API. Evaluation has no side effects.',
    {
      rule_service_id: ruleServiceId,
      vocabulary: z.array(payload).min(1).max(50),
      revision: z.string().min(1).max(64).optional(),
      version: z.string().min(1).max(64).optional()
    },
    READ_ONLY_ANNOTATIONS,
    async ({ rule_service_id: id, vocabulary, revision, version }) => invokeDecision(id, vocabulary, revision, version));

  register('bpa_test_decision', 'Test decision',
    'Run decision test cases sequentially and compare each Result with the expected output (subset match: an object is compared with Result[0], an array with Result).',
    {
      rule_service_id: ruleServiceId,
      revision: z.string().min(1).max(64).optional(),
      version: z.string().min(1).max(64).optional(),
      cases: z.array(z.object({
        name: z.string().min(1).max(120),
        vocabulary: z.array(payload).min(1).max(50),
        expected: z.union([payload, z.array(payload)])
      })).min(1).max(50)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ rule_service_id: id, revision, version, cases }) => {
      const results = [];
      for (const testCase of cases) {
        try {
          const response = await invokeDecision(id, testCase.vocabulary, revision, version);
          const actual = rows(response?.Result);
          const mismatches = Array.isArray(testCase.expected)
            ? subsetMismatches(testCase.expected, actual)
            : subsetMismatches(testCase.expected, actual[0], '$[0]');
          results.push({ name: testCase.name, pass: mismatches.length === 0, mismatches, result: actual });
        } catch (error) {
          if (!(error instanceof IntegrationError)) throw error;
          results.push({ name: testCase.name, pass: false, error: error.message });
        }
      }
      const passed = results.filter(result => result.pass).length;
      return { passed, failed: results.length - passed, cases: results };
    });

  // ------------------------------------------------------------ business events

  register('bpa_send_business_event', 'Send business event',
    'Send a CloudEvents business event that triggers event-based processes (the endpoint SAP documents for SAP Integration Suite, advanced event mesh webhooks). Requires confirmation "SEND BPA EVENT <type>".',
    {
      type: z.string().min(1).max(255),
      source: z.string().min(1).max(255),
      subject: z.string().min(1).max(255).optional(),
      data: payload,
      id: z.string().min(1).max(128).optional(),
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ type, source, subject, data, id, confirmation: given }) => {
      requireConfirmation(given, `SEND BPA EVENT ${type}`);
      const event = {
        specversion: '1.0',
        id: id ?? randomUUID(),
        type,
        source,
        ...(subject ? { subject } : {}),
        time: new Date(now()).toISOString(),
        datacontenttype: 'application/json',
        data
      };
      const { status } = await rest.request('POST', EVENTS, {
        body: JSON.stringify(event),
        contentType: 'application/cloudevents+json',
        expect: [200, 201, 202, 204],
        responseType: 'text',
        withStatus: true
      });
      return { accepted: true, status, event_id: event.id };
    });

  const context = { rest, access, now };
  registerInboxTools(register, context);
  registerAutomationTools(register, context);
  registerVisibilityTools(register, context);

  return registeredNames;
}
