// SAP Build Process Automation Unified API triggers and automation (iRPA) execution/monitoring tools.
import { z } from 'zod';
import { CREATE_ANNOTATIONS, READ_ONLY_ANNOTATIONS, confirmation, requireConfirmation } from './integration-common.mjs';
import {
  IRPA_MONITORING, IRPA_RUNTIME, UNIFIED, apiKeyHeaders, enc, environmentId, environmentQuery, guid, identifier,
  outputFile, payload, timestamp, writeExportFile
} from './process-automation-common.mjs';

export const AUTOMATION_TOOL_NAMES = Object.freeze([
  'bpa_list_api_triggers',
  'bpa_get_api_trigger',
  'bpa_execute_api_trigger',
  'bpa_list_automation_triggers',
  'bpa_get_automation_trigger',
  'bpa_list_automation_jobs',
  'bpa_start_automation',
  'bpa_export_automation_data'
]);

const EXPORT_PATHS = { bam: '/bam/export', archived_jobs: '/jobs/archived/export' };

export function registerAutomationTools(register, { rest, access }) {
  const triggerUid = identifier('trigger uid (UUID or projectId.triggerId)');
  const unified = (method, path, environment, options = {}) => rest.request(method, `${UNIFIED}${path}`, {
    ...options,
    query: { ...environmentQuery(access, environment), ...(options.query ?? {}) },
    headers: apiKeyHeaders(access, 'api-key')
  });
  const irpa = (method, path, options = {}) => rest.request(method, `${IRPA_RUNTIME}${path}`, {
    ...options,
    headers: apiKeyHeaders(access, 'irpa-api-key', { required: true })
  });

  register('bpa_list_api_triggers', 'List API triggers',
    'List process API triggers of an environment via the Unified API (api-key scope trigger_read when using a technical user).',
    {
      environment_id: environmentId,
      filter: z.string().max(1000).optional().describe('OData $filter expression.'),
      expand: z.string().max(200).optional().describe('OData $expand expression.')
    },
    READ_ONLY_ANNOTATIONS,
    ({ environment_id, filter, expand }) => unified('GET', '/triggers/api', environment_id, {
      query: { ...(filter ? { $filter: filter } : {}), ...(expand ? { $expand: expand } : {}) }
    }));

  register('bpa_get_api_trigger', 'Get API trigger',
    'Get one process API trigger by UUID or projectId.triggerId (environment_id required for the latter; api-key scope trigger_read).',
    { trigger_uid: triggerUid, environment_id: environmentId },
    READ_ONLY_ANNOTATIONS,
    ({ trigger_uid, environment_id }) => unified('GET', `/triggers/api/${enc(trigger_uid)}`, environment_id));

  register('bpa_execute_api_trigger', 'Execute API trigger',
    'Start a process through its API trigger, or resume a "Wait for an API Call" step by passing execution_id (the process instance id); api-key scope trigger_execute.',
    {
      trigger_uid: triggerUid,
      inputs: payload.default({}),
      business_key: z.string().max(255).optional(),
      execution_id: guid.optional().describe('Process instance id waiting in a "Wait for an API Call" step.'),
      environment_id: environmentId,
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ trigger_uid, inputs, business_key, execution_id, environment_id, confirmation: given }) => {
      requireConfirmation(given, `EXECUTE BPA TRIGGER ${trigger_uid}`);
      const { status, data } = await unified('POST', `/triggers/api/${enc(trigger_uid)}`, environment_id, {
        json: { inputs, ...(business_key ? { businessKey: business_key } : {}), ...(execution_id ? { executionId: execution_id } : {}) },
        expect: [200, 201, 202, 204],
        withStatus: true
      });
      return { status, data: data ?? null };
    });

  register('bpa_list_automation_triggers', 'List automation API triggers',
    'List automation (iRPA) API triggers; requires an environment API key with scope TRIGGER_READ.',
    {},
    READ_ONLY_ANNOTATIONS,
    () => irpa('GET', '/apiTriggers'));

  register('bpa_get_automation_trigger', 'Get automation API trigger',
    'Get one automation API trigger; requires an environment API key with scope TRIGGER_READ.',
    { trigger_uid: triggerUid },
    READ_ONLY_ANNOTATIONS,
    ({ trigger_uid }) => irpa('GET', `/apiTriggers/${enc(trigger_uid)}`));

  register('bpa_list_automation_jobs', 'List automation jobs',
    'List jobs (runs) of an automation API trigger, or get one job by job_uid; requires an environment API key with scope TRIGGER_READ.',
    { trigger_uid: triggerUid, job_uid: identifier('job uid').optional() },
    READ_ONLY_ANNOTATIONS,
    ({ trigger_uid, job_uid }) => irpa('GET', job_uid
      ? `/apiTriggers/${enc(trigger_uid)}/runs/${enc(job_uid)}`
      : `/apiTriggers/${enc(trigger_uid)}/runs`));

  register('bpa_start_automation', 'Start automation',
    'Start an automation job through its API trigger; requires an environment API key with scope TRIGGER_EXECUTE.',
    { trigger_uid: triggerUid, input: payload.default({}), invocation_context: payload.optional(), confirmation },
    CREATE_ANNOTATIONS,
    async ({ trigger_uid, input, invocation_context, confirmation: given }) => {
      requireConfirmation(given, `START BPA AUTOMATION ${trigger_uid}`);
      return irpa('POST', `/apiTriggers/${enc(trigger_uid)}/runs`, {
        json: { input, ...(invocation_context ? { invocationContext: invocation_context } : {}) },
        expect: [201]
      });
    });

  register('bpa_export_automation_data', 'Export automation monitoring data',
    'Export business activity monitoring data (bam, scope BAM_DOWNLOAD) or archived automation jobs (archived_jobs) as CSV; requires an environment API key.',
    {
      kind: z.enum(['bam', 'archived_jobs']),
      from: timestamp.optional(),
      to: timestamp.optional(),
      region: z.string().max(64).optional().describe('Language code controlling CSV delimiters.'),
      output_file: outputFile.optional()
    },
    READ_ONLY_ANNOTATIONS,
    async ({ kind, from, to, region, output_file }) => {
      const headers = apiKeyHeaders(access, 'irpa-api-key', { required: true });
      const csv = await rest.request('GET', `${IRPA_MONITORING}${EXPORT_PATHS[kind]}`, {
        query: Object.fromEntries(Object.entries({ from, to, region }).filter(([, value]) => value !== undefined)),
        headers,
        accept: 'text/csv, */*',
        responseType: 'text'
      });
      return output_file ? writeExportFile(output_file, csv) : { csv };
    });
}
