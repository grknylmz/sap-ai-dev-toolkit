// MCP tools for SAP Cloud Integration (CPI) over the /api/v1 OData API.
import { z } from 'zod';
import {
  CREATE_ANNOTATIONS,
  ERROR_TEXT_CAP,
  OVERWRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  REDACTED,
  SINGLE_FILE_CAP,
  FILE_TEXT_CAP,
  bundleFiles,
  capText,
  confirmation,
  entity,
  fileEntry,
  isoDate,
  isoToOdataDateTime,
  key,
  list,
  pick,
  redactSecrets,
  registerODataReader,
  requireConfirmation,
  secretValue,
  sleep,
  toolError,
  top as topSchema
} from './integration-common.mjs';
import { IntegrationError, odataDate, odataKey } from './integration-http.mjs';
import {
  MANIFEST_PATH,
  PARAMETERS_PROP,
  PARAMETERS_PROPDEF,
  buildIflowBundle,
  bumpPatchVersion,
  mergePropdef,
  parseProperties,
  propertiesText,
  readBundle,
  replaceManifestVersion,
  strFromU8,
  strToU8,
  validateParameters,
  writeBundle
} from './iflow-bundle.mjs';

const CPI_BASE = '/api/v1';
const MAX_UPDATE_FILE_BYTES = 256 * 1024;
const MESSAGE_STATUSES = ['COMPLETED', 'PROCESSING', 'RETRY', 'ESCALATED', 'FAILED', 'CANCELLED', 'DISCARDED', 'ABANDONED'];

const packageId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/);
const iflowId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/);
// CPI's own rule (verified live): start with a letter or underscore; letters, digits, space, '.', '-', '_';
// no trailing period. Non-ASCII letters are rejected by the tenant with HTTP 400.
const iflowName = z.string().max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_ .-]*$/, 'must start with a letter or underscore and contain only ASCII letters, digits, space, period, hyphen or underscore')
  .refine(value => !value.endsWith('.'), 'must not end with a period');
const parameterMap = z.record(z.string().regex(/^[A-Za-z0-9_. -]{1,100}$/), z.string().max(4096));

const templateParameters = z.object({
  sender_path: z.string().regex(/^\/[A-Za-z0-9_\-/.]{1,200}$/),
  receiver_address: z.string().max(2048).regex(/^https?:\/\/[^\s]+$/, 'must be an http(s) URL'),
  receiver_query: z.string().max(2048).optional(),
  receiver_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  receiver_proxy_type: z.enum(['internet', 'on_premise']),
  receiver_location_id: z.string().max(2048).optional(),
  receiver_authentication: z.enum(['None', 'Basic', 'Principal Propagation', 'OAuth2 Client Credentials', 'Client Certificate']),
  receiver_credential_name: z.string().min(1).max(200).optional(),
  receiver_timeout_ms: z.number().int().min(1000).max(300000).default(60000)
}).strict();

const scriptSchema = z.object({ name: z.string().max(90), content: z.string() }).strict();
const artifactId = iflowId;
const artifactVersion = z.string().regex(/^(?:active|\d+\.\d+\.\d+)$/).default('active');
const messageGuid = z.string().regex(/^[A-Za-z0-9_-]{10,64}$/);
const waitSeconds = fallback => z.number().int().min(0).max(50).default(fallback);
// Discover (SAP standard) package ids are longer than design-time ids and may contain periods.
const sourcePackageId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,199}$/);
const securityName = z.string().regex(/^[A-Za-z0-9 _.@-]{1,150}$/);
const partnerChars = /^[A-Za-z0-9\-._~@]+$/;
const numberText = z.union([z.number().int().min(0).max(99_999_999_999_999), z.string().regex(/^\d{1,14}$/)]);

// Design-time artifact kinds besides iFlows: entity set and Deploy<Kind>DesigntimeArtifact function import.
const ARTIFACT_TYPES = Object.freeze({
  value_mapping: { set: 'ValueMappingDesigntimeArtifacts', deploy: 'DeployValueMappingDesigntimeArtifact' },
  script_collection: { set: 'ScriptCollectionDesigntimeArtifacts', deploy: 'DeployScriptCollectionDesigntimeArtifact' },
  message_mapping: { set: 'MessageMappingDesigntimeArtifacts', deploy: 'DeployMessageMappingDesigntimeArtifact' }
});
const artifactType = z.enum(Object.keys(ARTIFACT_TYPES));
const PACKAGE_ARTIFACT_SETS = Object.freeze({
  iflows: 'IntegrationDesigntimeArtifacts',
  value_mappings: 'ValueMappingDesigntimeArtifacts',
  script_collections: 'ScriptCollectionDesigntimeArtifacts',
  message_mappings: 'MessageMappingDesigntimeArtifacts'
});
const RUNTIME_STATUSES = ['STARTED', 'STARTING', 'STOPPING', 'ERROR'];
const KEYSTORES = ['system', 'backup_admin_system', 'KeyRenewal'];
const PARTNER_CONTENT_TYPES = ['xml', 'xsl', 'xsd', 'json', 'text', 'zip', 'gz', 'zlib', 'crt'];
const JMS_BROKER_FIELDS = ['Capacity', 'MaxCapacity', 'CapacityOk', 'CapacityWarning', 'CapacityError', 'QueueNumber', 'MaxQueueNumber',
  'IsQueuesHigh', 'IsMessageSpoolHigh', 'IsTransactedSessionsHigh', 'IsConsumersHigh', 'IsProducersHigh'];
const MAX_VALUES_PER_PAIR = 500;
const MAX_LIST_ENTRIES = 500;
const MAX_RUN_STEPS = 200;
const STEP_ERROR_CAP = 1024;
const MAX_CERTIFICATE_BYTES = 10 * 1024;

const time = value => Date.parse(odataDate(value)) || 0;
const dates = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, odataDate(value[field])]));

/** Tenant error text can echo request fields: strip the secret, including a whitespace-collapsed or truncated copy. */
function withoutSecret(error, secret) {
  if (error?.name !== 'IntegrationError') return error;
  let message = error.message;
  for (const variant of new Set([secret, secret.replace(/\s+/g, ' ').trim()])) if (variant) message = message.replaceAll(variant, REDACTED);
  for (let length = Math.min(secret.length, message.length) - 1; length >= 3; length -= 1) {
    if (message.endsWith(secret.slice(0, length))) {
      message = `${message.slice(0, -length)}${REDACTED}`;
      break;
    }
  }
  return new IntegrationError(message);
}

/** Register cpi_* tools for one CPI client. */
export function registerCpiTools(register, client, { pollIntervalMs }) {
  const cpi = (method, path, options) => client.request(method, `${CPI_BASE}${path}`, options);
  const artifactPath = (id, version = 'active') => `/IntegrationDesigntimeArtifacts(Id=${key(id)},Version=${key(version)})`;
  const runtimePath = id => `/IntegrationRuntimeArtifacts(${key(id)})`;
  const designtimePath = (type, id, version = 'active') => `/${ARTIFACT_TYPES[type].set}(Id=${key(id)},Version=${key(version)})`;
  const bundleBytes = path => cpi('GET', `${path}/$value`, { responseType: 'bytes', accept: 'application/zip, application/octet-stream' });

  /** GET the entity; PUT bodyFor(existing) when it exists, else POST bodyFor(null) to the collection. */
  async function createOrReplace(path, collection, bodyFor, { putExpect = [200, 201, 202, 204], postExpect = [200, 201, 202, 204] } = {}) {
    const existing = await cpi('GET', path, { expect: [200, 404], withStatus: true });
    if (existing.status === 200) {
      await cpi('PUT', path, { json: bodyFor(existing.data ?? {}), expect: putExpect, responseType: 'text', accept: '*/*' });
      return 'updated';
    }
    await cpi('POST', collection, { json: bodyFor(null), expect: postExpect, responseType: 'text', accept: '*/*' });
    return 'created';
  }

  async function runtimeError(id) {
    const text = await cpi('GET', `${runtimePath(id)}/ErrorInformation/$value`, { responseType: 'text', accept: '*/*', expect: [200, 204] });
    return text === null ? null : capText(readableRuntimeError(text), ERROR_TEXT_CAP).text;
  }

  // ErrorInformation arrives as JSON ({ message: { messageId }, parameter: [text...] }); return its text.
  function readableRuntimeError(text) {
    try {
      const parsed = JSON.parse(text);
      const lines = Array.isArray(parsed?.parameter) ? parsed.parameter.filter(entry => typeof entry === 'string' && entry.trim()) : [];
      if (lines.length) return [parsed.message?.messageId, ...lines].filter(Boolean).join('\n');
    } catch {
      // Plain-text error information: keep as is.
    }
    return text;
  }

  function runtimeSummary(artifact) {
    return {
      ...pick(artifact, ['Id', 'Version', 'Name', 'Type', 'DeployedBy', 'Status']),
      DeployedOn: odataDate(artifact.DeployedOn)
    };
  }

  registerODataReader(register, {
    name: 'cpi_odata_get',
    title: 'Read CPI OData API',
    service: 'Cloud Integration /api/v1',
    request: cpi,
    examples: "/JmsBrokers('Broker1') with $expand=QueueStates, /AccessPolicies, /KeystoreEntries with keystoreName=system, /MessageProcessingLogs('<guid>')/Runs"
  });

  register('cpi_list_packages', 'List CPI packages',
    'List Cloud Integration design-time packages (Id, Name, ShortText, Version, Mode).',
    { top: z.number().int().min(1).max(200).default(100) },
    READ_ONLY_ANNOTATIONS,
    // The CPI tenant rejects $select on IntegrationPackages (HTTP 501); project client-side.
    async ({ top }) => list(await cpi('GET', '/IntegrationPackages', {
      query: { $top: top, $orderby: 'Name' }
    })).map(entry => pick(entry, ['Id', 'Name', 'ShortText', 'Version', 'Mode'])));

  register('cpi_list_iflows', 'List iFlows in a package',
    'List the integration flows of one CPI package (Id, Name, Version, Description).',
    { package_id: packageId },
    READ_ONLY_ANNOTATIONS,
    async ({ package_id }) => list(await cpi('GET', `/IntegrationPackages(${key(package_id)})/IntegrationDesigntimeArtifacts`))
      .map(artifact => pick(artifact, ['Id', 'Name', 'Version', 'Description'])));

  register('cpi_get_iflow', 'Get iFlow',
    'Read an iFlow: artifact metadata, externalized configuration and bundle files (text files capped at 48 KiB each). Pass file_path to return one file (up to 90 KiB).',
    {
      iflow_id: iflowId,
      version: z.string().regex(/^(?:active|\d+\.\d+\.\d+)$/).default('active'),
      file_path: z.string().min(1).max(300).optional()
    },
    READ_ONLY_ANNOTATIONS,
    async ({ iflow_id, version, file_path }) => {
      const path = artifactPath(iflow_id, version);
      const artifact = entity(await cpi('GET', path));
      delete artifact.ArtifactContent;
      const bundle = readBundle(await cpi('GET', `${path}/$value`, { responseType: 'bytes', accept: 'application/zip, application/octet-stream' }));
      if (file_path) {
        const bytes = bundle.get(file_path);
        if (!bytes) throw new IntegrationError('file_path not found in the iFlow bundle');
        return { artifact, file: fileEntry(file_path, bytes, SINGLE_FILE_CAP) };
      }
      const configurations = list(await cpi('GET', `${path}/Configurations`))
        .map(entry => pick(entry, ['ParameterKey', 'ParameterValue', 'DataType']));
      const files = [...bundle.entries()]
        .filter(([name]) => !name.endsWith('/'))
        .map(([name, bytes]) => fileEntry(name, bytes, FILE_TEXT_CAP));
      return { artifact, configurations, files };
    });

  register('cpi_get_iflow_runtime_status', 'Get iFlow runtime status',
    'Return the deployed runtime state of an iFlow; includes error information when Status is ERROR.',
    { iflow_id: iflowId },
    READ_ONLY_ANNOTATIONS,
    async ({ iflow_id }) => {
      const { status, data } = await cpi('GET', runtimePath(iflow_id), { expect: [200, 404], withStatus: true });
      if (status === 404) return { deployed: false };
      const result = { deployed: true, ...runtimeSummary(data) };
      if (String(data?.Status).toUpperCase() === 'ERROR') result.error_information = await runtimeError(iflow_id);
      return result;
    });

  register('cpi_list_service_endpoints', 'List CPI service endpoints',
    'List deployed HTTP(S)/SOAP endpoint URLs; optionally only those of one iFlow. CPI registers an endpoint up to a few minutes after the iFlow reaches STARTED, so an empty list right after deployment means retry later.',
    { iflow_id: iflowId.optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ iflow_id }) => {
      let endpoints = list(await cpi('GET', '/ServiceEndpoints', { query: { $expand: 'EntryPoints' } }));
      if (iflow_id) {
        const byName = endpoints.filter(endpoint => endpoint.Name === iflow_id);
        endpoints = byName.length ? byName : endpoints.filter(endpoint => String(endpoint.Id || '').includes(iflow_id));
      }
      return endpoints.map(endpoint => ({
        name: endpoint.Name,
        urls: list(endpoint.EntryPoints).map(entryPoint => entryPoint.Url).filter(Boolean)
      }));
    });

  register('cpi_list_message_logs', 'List message processing logs',
    'List CPI message processing logs, newest first, filtered by iFlow, status, time window (ISO-8601), correlation id, application message id or one custom header property (name and value, exact match).',
    {
      iflow_id: iflowId.optional(),
      status: z.enum(MESSAGE_STATUSES).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      correlation_id: z.string().min(1).max(200).optional(),
      application_message_id: z.string().min(1).max(200).optional(),
      custom_header: z.object({ name: z.string().min(1).max(200), value: z.string().max(2000) }).strict().optional(),
      top: z.number().int().min(1).max(100).default(20)
    },
    READ_ONLY_ANNOTATIONS,
    async ({ iflow_id, status, from, to, correlation_id, application_message_id, custom_header, top }) => {
      const filter = [
        iflow_id && `IntegrationArtifact/Id eq ${odataKey(iflow_id)}`,
        status && `Status eq '${status}'`,
        from && `LogStart gt datetime'${isoToOdataDateTime(from)}'`,
        to && `LogEnd lt datetime'${isoToOdataDateTime(to)}'`,
        correlation_id && `CorrelationId eq ${odataKey(correlation_id)}`,
        application_message_id && `ApplicationMessageId eq ${odataKey(application_message_id)}`
      ].filter(Boolean).join(' and ');
      const parsed = await cpi('GET', '/MessageProcessingLogs', {
        query: {
          $filter: filter || undefined,
          $orderby: 'LogEnd desc',
          $top: top,
          $inlinecount: 'allpages',
          filterCustomHeaderProperties: custom_header ? `${odataKey(custom_header.name)} eq ${odataKey(custom_header.value)}` : undefined
        },
        unwrap: false
      });
      const logs = list(parsed?.d ?? parsed).map(log => ({
        ...pick(log, ['MessageGuid', 'CorrelationId', 'IntegrationFlowName', 'Status', 'CustomStatus', 'Sender', 'Receiver']),
        LogStart: odataDate(log.LogStart),
        LogEnd: odataDate(log.LogEnd)
      }));
      const total = Number(parsed?.d?.__count);
      return { total: Number.isFinite(total) ? total : null, returned: logs.length, logs };
    });

  register('cpi_get_message_log', 'Get message processing log',
    'Read one message processing log with its error text and custom header properties. Payload attachments are never read.',
    { message_guid: messageGuid },
    READ_ONLY_ANNOTATIONS,
    async ({ message_guid }) => {
      const path = `/MessageProcessingLogs(${key(message_guid)})`;
      const log = entity(await cpi('GET', path));
      for (const field of ['LogStart', 'LogEnd']) if (field in log) log[field] = odataDate(log[field]);
      const errorText = await cpi('GET', `${path}/ErrorInformation/$value`, { responseType: 'text', accept: '*/*', expect: [200, 204, 404] });
      const headers = list(await cpi('GET', `${path}/CustomHeaderProperties`)).map(entry => pick(entry, ['Name', 'Value']));
      return { log, error_information: errorText ? capText(errorText, ERROR_TEXT_CAP).text : null, custom_header_properties: headers };
    });

  register('cpi_create_package', 'Create CPI package',
    'Create a Cloud Integration package. Requires confirmation exactly equal to CREATE CPI PACKAGE <package_id>.',
    {
      package_id: packageId,
      name: z.string().min(1).max(100),
      short_text: z.string().min(1).max(255),
      description: z.string().max(4096).optional(),
      confirmation
    },
    CREATE_ANNOTATIONS,
    async ({ package_id, name, short_text, description, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `CREATE CPI PACKAGE ${package_id}`);
      await cpi('POST', '/IntegrationPackages', {
        json: { Id: package_id, Name: name, ShortText: short_text, Description: description ?? '', Version: '1.0.0' },
        expect: [201]
      });
      return { created: true, package_id };
    });

  register('cpi_create_iflow', 'Create iFlow',
    'Create an iFlow in a package from the vetted https-request-reply-http template (HTTPS sender → Request Reply → HTTP receiver) or from caller-supplied BPMN (template=custom). Requires confirmation exactly equal to CREATE IFLOW <iflow_id>.',
    z.object({
      package_id: packageId,
      iflow_id: iflowId,
      name: iflowName,
      description: z.string().max(4096).optional(),
      template: z.enum(['https-request-reply-http', 'custom']),
      template_parameters: templateParameters.optional(),
      iflw_xml: z.string().optional(),
      scripts: z.array(scriptSchema).max(10).optional(),
      parameters: parameterMap.optional(),
      confirmation
    }).strict().superRefine((value, context) => {
      if (value.template === 'custom' && !value.iflw_xml) {
        context.addIssue({ code: 'custom', path: ['iflw_xml'], message: 'iflw_xml is required when template is custom' });
      }
      if (value.template !== 'custom' && !value.template_parameters) {
        context.addIssue({ code: 'custom', path: ['template_parameters'], message: 'template_parameters are required for template iFlows' });
      }
      const auth = value.template_parameters?.receiver_authentication;
      if ((auth === 'Basic' || auth === 'OAuth2 Client Credentials') && !value.template_parameters?.receiver_credential_name) {
        context.addIssue({ code: 'custom', path: ['template_parameters', 'receiver_credential_name'], message: `receiver_credential_name is required for ${auth}` });
      }
    }),
    CREATE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `CREATE IFLOW ${args.iflow_id}`);
      const bundle = buildIflowBundle({
        id: args.iflow_id,
        name: args.name,
        description: args.description ?? '',
        template: args.template,
        templateParameters: args.template_parameters,
        iflwXml: args.iflw_xml,
        scripts: args.scripts ?? [],
        parameters: args.parameters ?? {}
      });
      const existing = await cpi('GET', artifactPath(args.iflow_id), { expect: [200, 404], withStatus: true });
      if (existing.status === 200) throw new IntegrationError(`iFlow ${args.iflow_id} already exists; use cpi_update_iflow`);
      await cpi('POST', '/IntegrationDesigntimeArtifacts', {
        json: {
          Name: args.name,
          Id: args.iflow_id,
          PackageId: args.package_id,
          Description: args.description ?? '',
          ArtifactContent: Buffer.from(bundle).toString('base64')
        },
        expect: [201]
      });
      return { created: true, iflow_id: args.iflow_id, package_id: args.package_id, version: '1.0.0', files: [...readBundle(bundle).keys()] };
    });

  register('cpi_update_iflow', 'Update iFlow',
    'Replace or add files under src/main/resources in an iFlow bundle, merge externalized parameters, and bump the patch version. Fails without writing when expected_version differs from the current version. Never deletes bundle files. Requires confirmation exactly equal to UPDATE IFLOW <iflow_id>.',
    {
      iflow_id: iflowId,
      expected_version: z.string().min(1).max(40),
      files: z.array(z.object({
        path: z.string().regex(/^src\/main\/resources\/[A-Za-z0-9_\-/.]{1,200}$/).refine(value => !value.includes('..'), 'must not contain ..'),
        content: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= MAX_UPDATE_FILE_BYTES, 'must be at most 256 KiB')
      }).strict()).min(1).max(20),
      parameters: parameterMap.optional(),
      name: iflowName.optional(),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ iflow_id, expected_version, files, parameters, name, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `UPDATE IFLOW ${iflow_id}`);
      if (parameters) validateParameters(parameters);
      const path = artifactPath(iflow_id);
      const artifact = await cpi('GET', path);
      const current = artifact?.Version;
      if (current !== expected_version) {
        throw new IntegrationError(`iFlow ${iflow_id} is at version ${current}, not ${expected_version}; re-read with cpi_get_iflow`);
      }
      const newVersion = bumpPatchVersion(current);
      const bundle = readBundle(await cpi('GET', `${path}/$value`, { responseType: 'bytes', accept: 'application/zip, application/octet-stream' }));
      const changed = new Set();
      for (const file of files) {
        bundle.set(file.path, strToU8(file.content));
        changed.add(file.path);
      }
      if (parameters && Object.keys(parameters).length) {
        const existing = bundle.has(PARAMETERS_PROP) ? parseProperties(strFromU8(bundle.get(PARAMETERS_PROP))) : {};
        const merged = { ...existing, ...parameters };
        validateParameters(merged);
        bundle.set(PARAMETERS_PROP, strToU8(propertiesText(merged)));
        const propdef = bundle.has(PARAMETERS_PROPDEF) ? strFromU8(bundle.get(PARAMETERS_PROPDEF)) : '';
        const updatedPropdef = mergePropdef(propdef, Object.keys(merged));
        if (updatedPropdef !== propdef) {
          bundle.set(PARAMETERS_PROPDEF, strToU8(updatedPropdef));
          changed.add(PARAMETERS_PROPDEF);
        }
        changed.add(PARAMETERS_PROP);
      }
      if (!bundle.has(MANIFEST_PATH)) throw new IntegrationError(`iFlow ${iflow_id} bundle has no ${MANIFEST_PATH}`);
      bundle.set(MANIFEST_PATH, strToU8(replaceManifestVersion(strFromU8(bundle.get(MANIFEST_PATH)), newVersion)));
      changed.add(MANIFEST_PATH);
      await cpi('PUT', path, {
        json: { Name: name ?? artifact.Name, ArtifactContent: Buffer.from(writeBundle(bundle)).toString('base64') },
        expect: [200, 202, 204]
      });
      return { updated: true, previous_version: current, new_version: newVersion, changed_files: [...changed] };
    });

  register('cpi_update_iflow_configuration', 'Configure iFlow parameters',
    'Set externalized iFlow configuration parameters one at a time; stops at the first failure and reports which keys were updated. Requires confirmation exactly equal to CONFIGURE IFLOW <iflow_id>.',
    {
      iflow_id: iflowId,
      parameters: z.array(z.object({
        key: z.string().min(1).max(200),
        value: z.string().max(4096),
        data_type: z.string().min(1).max(40).default('xsd:string')
      }).strict()).min(1).max(50),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ iflow_id, parameters, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `CONFIGURE IFLOW ${iflow_id}`);
      const updated = [];
      for (const parameter of parameters) {
        try {
          await cpi('PUT', `${artifactPath(iflow_id)}/$links/Configurations(${key(parameter.key)})`, {
            json: { ParameterValue: parameter.value, DataType: parameter.data_type },
            expect: [200, 202, 204]
          });
          updated.push(parameter.key);
        } catch (error) {
          return { updated, failed: { key: parameter.key, error: toolError(error).content[0].text } };
        }
      }
      return { updated, failed: null };
    });

  // MCP clients commonly abort a tool call after 60 s, so the wait stays below that;
  // a long STARTING phase is reported as timed_out and continued with cpi_get_iflow_runtime_status.
  register('cpi_deploy_iflow', 'Deploy iFlow',
    'Deploy the active iFlow version and wait (up to wait_seconds, max 50) for build and runtime status; returns runtime error text when it fails to start. When timed_out is true, poll cpi_get_iflow_runtime_status. Requires confirmation exactly equal to DEPLOY IFLOW <iflow_id>.',
    { iflow_id: iflowId, wait_seconds: z.number().int().min(0).max(50).default(45), confirmation },
    CREATE_ANNOTATIONS,
    async ({ iflow_id, wait_seconds, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `DEPLOY IFLOW ${iflow_id}`);
      const deadline = Date.now() + wait_seconds * 1000;
      const taskId = String(await cpi('POST', '/DeployIntegrationDesigntimeArtifact', {
        query: { Id: odataKey(iflow_id), Version: "'active'" },
        responseType: 'text',
        accept: '*/*',
        expect: [200, 202]
      }) ?? '').trim().replace(/^"|"$/g, '');
      if (!taskId) throw new IntegrationError(`CPI deploy of ${iflow_id} returned no task id`);

      let buildStatus;
      for (;;) {
        const build = await cpi('GET', `/BuildAndDeployStatus(TaskId=${key(taskId)})`);
        buildStatus = String(build?.Status ?? '').toUpperCase();
        if (buildStatus !== 'DEPLOYING' || Date.now() >= deadline) break;
        await sleep(pollIntervalMs);
      }
      const result = { task_id: taskId, build_status: buildStatus, runtime_status: null, runtime_version: null, error_information: null, timed_out: false };
      const readRuntime = async () => {
        const runtime = await cpi('GET', runtimePath(iflow_id), { expect: [200, 404], withStatus: true });
        result.runtime_status = runtime.status === 404 ? null : String(runtime.data?.Status ?? '').toUpperCase();
        result.runtime_version = runtime.status === 404 ? null : runtime.data?.Version ?? null;
      };
      if (buildStatus === 'DEPLOYING') {
        return { ...result, timed_out: true, note: 'Build still running; poll cpi_get_iflow_runtime_status.' };
      }
      if (buildStatus !== 'SUCCESS') {
        // CPI occasionally reports a transient build FAIL for a deploy that does start; report the runtime truth too.
        await readRuntime();
        if (result.runtime_status === 'ERROR') result.error_information = await runtimeError(iflow_id);
        result.note = `CPI reported build status ${buildStatus || 'unknown'}; runtime_status/runtime_version show the iFlow currently deployed. Check cpi_get_iflow_runtime_status before redeploying.`;
        return result;
      }

      for (;;) {
        await readRuntime();
        const pending = result.runtime_status === null || result.runtime_status === 'STARTING';
        if (!pending) break;
        if (Date.now() >= deadline) {
          result.timed_out = true;
          result.note = 'Runtime still starting; poll cpi_get_iflow_runtime_status.';
          break;
        }
        await sleep(pollIntervalMs);
      }
      if (result.runtime_status === 'ERROR') result.error_information = await runtimeError(iflow_id);
      return result;
    });

  register('cpi_list_runtime_artifacts', 'List deployed CPI artifacts',
    'List deployed (runtime) Cloud Integration artifacts of every type (iFlows, value mappings, script collections, message mappings, …) with status and deployment time; optionally only one status.',
    { status: z.enum(RUNTIME_STATUSES).optional(), top: topSchema(500, 200) },
    READ_ONLY_ANNOTATIONS,
    async ({ status, top }) => list(await cpi('GET', '/IntegrationRuntimeArtifacts', {
      query: { $filter: status ? `Status eq '${status}'` : undefined, $top: top }
    })).map(runtimeSummary));

  register('cpi_undeploy_artifact', 'Undeploy CPI artifact',
    'Undeploy a runtime artifact of any type and wait (up to wait_seconds, max 50) until it is gone; the design-time artifact is kept. When timed_out is true, poll cpi_list_runtime_artifacts. Requires confirmation exactly equal to UNDEPLOY ARTIFACT <artifact_id>.',
    { artifact_id: artifactId, wait_seconds: waitSeconds(30), confirmation },
    OVERWRITE_ANNOTATIONS,
    async ({ artifact_id, wait_seconds, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `UNDEPLOY ARTIFACT ${artifact_id}`);
      const deadline = Date.now() + wait_seconds * 1000;
      const current = await cpi('GET', runtimePath(artifact_id), { expect: [200, 404], withStatus: true });
      if (current.status === 404) throw new IntegrationError(`Artifact ${artifact_id} is not deployed`);
      await cpi('DELETE', runtimePath(artifact_id), { expect: [200, 202, 204], responseType: 'text', accept: '*/*' });
      for (;;) {
        const runtime = await cpi('GET', runtimePath(artifact_id), { expect: [200, 404], withStatus: true });
        if (runtime.status === 404) return { undeployed: true, artifact_id, previous_version: current.data?.Version ?? null };
        if (Date.now() >= deadline) {
          return {
            undeployed: false,
            timed_out: true,
            artifact_id,
            runtime_status: String(runtime.data?.Status ?? '').toUpperCase() || null,
            note: 'Undeployment still running; poll cpi_list_runtime_artifacts until the artifact disappears.'
          };
        }
        await sleep(pollIntervalMs);
      }
    });

  register('cpi_list_package_artifacts', 'List artifacts in a package',
    'List the iFlows, value mappings, script collections and message mappings of one CPI package (Id, Name, Version, Description), grouped by type.',
    { package_id: packageId },
    READ_ONLY_ANNOTATIONS,
    async ({ package_id }) => {
      const result = {};
      for (const [group, set] of Object.entries(PACKAGE_ARTIFACT_SETS)) {
        result[group] = list(await cpi('GET', `/IntegrationPackages(${key(package_id)})/${set}`))
          .map(artifact => pick(artifact, ['Id', 'Name', 'Version', 'Description']));
      }
      return result;
    });

  register('cpi_get_artifact', 'Get CPI artifact',
    'Read a value mapping, script collection or message mapping: metadata and bundle files (text files capped at 48 KiB each). Pass file_path to return one file (up to 90 KiB).',
    { type: artifactType, artifact_id: artifactId, version: artifactVersion, file_path: z.string().min(1).max(300).optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ type, artifact_id, version, file_path }) => {
      const path = designtimePath(type, artifact_id, version);
      const artifact = entity(await cpi('GET', path));
      delete artifact.ArtifactContent;
      return { artifact, ...bundleFiles(readBundle(await bundleBytes(path)), file_path) };
    });

  register('cpi_get_value_mappings', 'Get value mapping values',
    `Read the agency/identifier pairs of a value mapping with their value pairs (up to ${MAX_VALUES_PER_PAIR} per agency pair) and default values.`,
    { artifact_id: artifactId, version: artifactVersion },
    READ_ONLY_ANNOTATIONS,
    async ({ artifact_id, version }) => {
      const path = designtimePath('value_mapping', artifact_id, version);
      const valMap = entry => ({ Id: entry.Id, SrcValue: entry.Value?.SrcValue ?? null, TgtValue: entry.Value?.TgtValue ?? null });
      const pairs = [];
      for (const schema of list(await cpi('GET', `${path}/ValMapSchema`))) {
        const pairPath = `${path}/ValMapSchema(SrcAgency=${key(schema.SrcAgency)},SrcId=${key(schema.SrcId)},TgtAgency=${key(schema.TgtAgency)},TgtId=${key(schema.TgtId)})`;
        const values = list(await cpi('GET', `${pairPath}/ValMaps`)).map(valMap);
        const defaults = list(await cpi('GET', `${pairPath}/DefaultValMaps`)).map(valMap);
        pairs.push({
          ...pick(schema, ['SrcAgency', 'SrcId', 'TgtAgency', 'TgtId', 'State']),
          value_count: values.length,
          values: values.slice(0, MAX_VALUES_PER_PAIR),
          ...(values.length > MAX_VALUES_PER_PAIR ? { values_truncated: true } : {}),
          default_values: defaults
        });
      }
      return { artifact_id, version, agency_pairs: pairs };
    });

  const agencyField = z.string().min(1).max(200);
  register('cpi_upsert_value_mappings', 'Upsert value mapping values',
    'Add or change value pairs of the active value mapping version, one at a time; stops at the first failure and reports how many were written. Agency pairs that do not exist yet are created. Takes effect after cpi_deploy_artifact (type value_mapping). Requires confirmation exactly equal to UPDATE VALUE MAPPING <artifact_id>.',
    {
      artifact_id: artifactId,
      pairs: z.array(z.object({
        src_agency: agencyField,
        src_identifier: agencyField,
        tgt_agency: agencyField,
        tgt_identifier: agencyField,
        src_value: z.string().min(1).max(2000),
        tgt_value: z.string().min(1).max(2000)
      }).strict()).min(1).max(100),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ artifact_id, pairs, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `UPDATE VALUE MAPPING ${artifact_id}`);
      let upserted = 0;
      for (const [index, pair] of pairs.entries()) {
        try {
          await cpi('POST', '/UpsertValMaps', {
            query: {
              Id: odataKey(artifact_id),
              Version: "'active'",
              SrcAgency: odataKey(pair.src_agency),
              SrcId: odataKey(pair.src_identifier),
              TgtAgency: odataKey(pair.tgt_agency),
              TgtId: odataKey(pair.tgt_identifier),
              SrcValue: odataKey(pair.src_value),
              TgtValue: odataKey(pair.tgt_value),
              IsConfigured: 'true'
            },
            responseType: 'text',
            accept: '*/*',
            expect: [200, 202, 204]
          });
          upserted += 1;
        } catch (error) {
          return { upserted, failed: { index, error: toolError(error).content[0].text } };
        }
      }
      return { upserted, failed: null, note: 'Deploy with cpi_deploy_artifact (type value_mapping) for the change to take effect.' };
    });

  register('cpi_update_script_collection', 'Update script collection',
    'Replace or add scripts (src/main/resources/script/<name>) in the active version of a script collection; other files are kept and the version is not changed. Fails without writing when expected_version is given and differs. Takes effect after cpi_deploy_artifact (type script_collection). Requires confirmation exactly equal to UPDATE SCRIPT COLLECTION <artifact_id>.',
    {
      artifact_id: artifactId,
      expected_version: z.string().min(1).max(40).optional(),
      files: z.array(z.object({
        name: z.string().regex(/^[A-Za-z0-9_.-]{1,80}\.(?:groovy|gsh|js)$/, 'must be a .groovy, .gsh or .js file name without a path'),
        content: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= MAX_UPDATE_FILE_BYTES, 'must be at most 256 KiB')
      }).strict()).min(1).max(20),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ artifact_id, expected_version, files, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `UPDATE SCRIPT COLLECTION ${artifact_id}`);
      const path = designtimePath('script_collection', artifact_id);
      const artifact = await cpi('GET', path);
      if (expected_version !== undefined && artifact?.Version !== expected_version) {
        throw new IntegrationError(`Script collection ${artifact_id} is at version ${artifact?.Version}, not ${expected_version}; re-read with cpi_get_artifact`);
      }
      const bundle = readBundle(await bundleBytes(path));
      const changed = new Set();
      for (const file of files) {
        const filePath = `src/main/resources/script/${file.name}`;
        bundle.set(filePath, strToU8(file.content));
        changed.add(filePath);
      }
      await cpi('PUT', path, {
        json: { Name: artifact?.Name, ArtifactContent: Buffer.from(writeBundle(bundle)).toString('base64') },
        responseType: 'text',
        accept: '*/*',
        expect: [200, 202, 204]
      });
      return { updated: true, artifact_id, version: artifact?.Version ?? null, changed_files: [...changed] };
    });

  register('cpi_deploy_artifact', 'Deploy CPI artifact',
    'Deploy the active version of a value mapping, script collection or message mapping and wait (up to wait_seconds, max 50) until the runtime artifact leaves STARTING; returns runtime error text when it fails. A redeploy can briefly report the previously deployed artifact as STARTED, so check runtime_version and deployed_on. When timed_out is true, poll cpi_list_runtime_artifacts. Requires confirmation exactly equal to DEPLOY ARTIFACT <artifact_id>.',
    { type: artifactType, artifact_id: artifactId, wait_seconds: waitSeconds(45), confirmation },
    CREATE_ANNOTATIONS,
    async ({ type, artifact_id, wait_seconds, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `DEPLOY ARTIFACT ${artifact_id}`);
      const deadline = Date.now() + wait_seconds * 1000;
      await cpi('POST', `/${ARTIFACT_TYPES[type].deploy}`, {
        query: { Id: odataKey(artifact_id), Version: "'active'" },
        responseType: 'text',
        accept: '*/*',
        expect: [200, 201, 202]
      });
      const result = { type, artifact_id, runtime_status: null, runtime_version: null, deployed_on: null, error_information: null, timed_out: false };
      for (;;) {
        const runtime = await cpi('GET', runtimePath(artifact_id), { expect: [200, 404], withStatus: true });
        const deployed = runtime.status === 200;
        result.runtime_status = deployed ? String(runtime.data?.Status ?? '').toUpperCase() : null;
        result.runtime_version = deployed ? runtime.data?.Version ?? null : null;
        result.deployed_on = deployed ? odataDate(runtime.data?.DeployedOn) ?? null : null;
        if (deployed && result.runtime_status !== 'STARTING') break;
        if (Date.now() >= deadline) {
          result.timed_out = true;
          result.note = 'Runtime artifact not started yet; poll cpi_list_runtime_artifacts.';
          break;
        }
        await sleep(pollIntervalMs);
      }
      if (result.runtime_status === 'ERROR') result.error_information = await runtimeError(artifact_id);
      return result;
    });

  register('cpi_update_package', 'Update CPI package',
    'Change the name, short text, description or version of a CPI package; omitted fields keep their current values. Requires confirmation exactly equal to UPDATE CPI PACKAGE <package_id>.',
    z.object({
      package_id: packageId,
      name: z.string().min(1).max(100).optional(),
      short_text: z.string().min(1).max(255).optional(),
      description: z.string().max(4096).optional(),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
      confirmation
    }).strict().refine(value => ['name', 'short_text', 'description', 'version'].some(field => value[field] !== undefined),
      'pass at least one of name, short_text, description, version'),
    OVERWRITE_ANNOTATIONS,
    async ({ package_id, name, short_text, description, version, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `UPDATE CPI PACKAGE ${package_id}`);
      const path = `/IntegrationPackages(${key(package_id)})`;
      const current = await cpi('GET', path);
      const body = {
        Name: name ?? current?.Name,
        ShortText: short_text ?? current?.ShortText,
        Description: description ?? current?.Description ?? '',
        Version: version ?? current?.Version
      };
      await cpi('PUT', path, { json: body, responseType: 'text', accept: '*/*', expect: [200, 202, 204] });
      return { updated: true, package_id, name: body.Name, short_text: body.ShortText, version: body.Version };
    });

  register('cpi_copy_package', 'Copy package from Discover',
    'Copy a package from the Discover catalog (SAP standard content) into Design. CREATE_COPY creates a new package (suffix appends .<suffix> to the name and artifact ids); OVERWRITE_MERGE updates an existing copy and keeps its externalized configuration. Requires confirmation exactly equal to COPY CPI PACKAGE <package_id>.',
    z.object({
      package_id: sourcePackageId,
      import_mode: z.enum(['CREATE_COPY', 'OVERWRITE_MERGE']).default('CREATE_COPY'),
      suffix: z.string().regex(/^[A-Za-z0-9]{1,20}$/).optional(),
      confirmation
    }).strict().refine(value => !value.suffix || value.import_mode === 'CREATE_COPY', { path: ['suffix'], message: 'suffix is only allowed with import_mode CREATE_COPY' }),
    OVERWRITE_ANNOTATIONS,
    async ({ package_id, import_mode, suffix, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `COPY CPI PACKAGE ${package_id}`);
      let copied;
      try {
        copied = await cpi('POST', '/CopyIntegrationPackage', {
          query: { Id: odataKey(package_id), ImportMode: `'${import_mode}'`, Suffix: suffix ? `'${suffix}'` : undefined },
          expect: [200, 201]
        });
      } catch (error) {
        if (/\(HTTP 409\)/.test(error?.message)) {
          throw new IntegrationError(`Package ${package_id} conflicts with an existing design-time package (HTTP 409); use import_mode OVERWRITE_MERGE or CREATE_COPY with a different suffix`);
        }
        throw error;
      }
      return { copied: true, import_mode, package: pick(copied ?? {}, ['Id', 'Name', 'Version']) };
    });

  // ---------------------------------------------------------------- security material

  const deployment = descriptor => (descriptor ? { ...pick(descriptor, ['Type', 'Status', 'DeployedBy']), ...dates(descriptor, ['DeployedOn']) } : null);
  register('cpi_list_security_material', 'List CPI security material',
    'List user credentials, OAuth2 client credentials or keystore entries (keystore system, backup_admin_system or KeyRenewal; default system) with deployment status. Passwords, client secrets and keys are never returned.',
    z.object({
      kind: z.enum(['user_credentials', 'oauth2_client_credentials', 'keystore_entries']),
      keystore: z.enum(KEYSTORES).optional()
    }).strict().refine(value => !value.keystore || value.kind === 'keystore_entries', { path: ['keystore'], message: 'keystore is only allowed with kind keystore_entries' }),
    READ_ONLY_ANNOTATIONS,
    async ({ kind, keystore }) => {
      if (kind === 'user_credentials') {
        return redactSecrets(list(await cpi('GET', '/UserCredentials')).map(entry => ({
          ...pick(entry, ['Name', 'Kind', 'Description', 'User', 'CompanyId']),
          deployment: deployment(entry.SecurityArtifactDescriptor)
        })));
      }
      if (kind === 'oauth2_client_credentials') {
        return redactSecrets(list(await cpi('GET', '/OAuth2ClientCredentials')).map(entry => ({
          ...pick(entry, ['Name', 'Description', 'TokenServiceUrl', 'ClientId', 'ClientAuthentication', 'Scope', 'ScopeContentType', 'Resource', 'Audience']),
          deployment: deployment(entry.SecurityArtifactDescriptor)
        })));
      }
      return redactSecrets(list(await cpi('GET', '/KeystoreEntries', { query: { keystoreName: keystore ?? 'system' } })).map(entry => ({
        ...pick(entry, ['Alias', 'Hexalias', 'Type', 'Owner', 'KeyType', 'SubjectDN', 'IssuerDN', 'Status']),
        ...dates(entry, ['ValidNotBefore', 'ValidNotAfter'])
      })));
    });

  register('cpi_set_user_credential', 'Set CPI user credential',
    'Create or replace a User Credentials security artifact (kind default, successfactors with company_id, or openconnectors). The password is write-only and never returned. Requires confirmation exactly equal to SET USER CREDENTIAL <name>.',
    z.object({
      name: securityName,
      kind: z.enum(['default', 'successfactors', 'openconnectors']).default('default'),
      user: z.string().min(1).max(255),
      password: secretValue,
      company_id: z.string().min(1).max(100).optional(),
      description: z.string().max(1024).optional(),
      confirmation
    }).strict().refine(value => value.kind !== 'successfactors' || value.company_id, { path: ['company_id'], message: 'company_id is required for kind successfactors' }),
    OVERWRITE_ANNOTATIONS,
    async ({ name, kind, user, password, company_id, description, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `SET USER CREDENTIAL ${name}`);
      try {
        const outcome = await createOrReplace(`/UserCredentials(${key(name)})`, '/UserCredentials', existing => ({
          Name: name,
          Kind: kind,
          Description: description ?? existing?.Description ?? '',
          User: user,
          Password: password,
          CompanyId: company_id ?? ''
        }));
        return { [outcome]: true, name };
      } catch (error) {
        throw withoutSecret(error, password);
      }
    });

  register('cpi_set_oauth2_client_credential', 'Set CPI OAuth2 client credential',
    'Create or replace an OAuth2 Client Credentials security artifact. The client secret is write-only and never returned. Requires confirmation exactly equal to SET OAUTH2 CLIENT CREDENTIAL <name>.',
    {
      name: securityName,
      token_service_url: z.string().max(2048).regex(/^https:\/\/\S+$/, 'must be an https URL'),
      client_id: z.string().min(1).max(1024),
      client_secret: secretValue,
      client_authentication: z.enum(['body', 'header']).default('body'),
      scope: z.string().max(2048).optional(),
      scope_content_type: z.enum(['urlencoded', 'json']).default('urlencoded'),
      resource: z.string().max(2048).optional(),
      audience: z.string().max(2048).optional(),
      description: z.string().max(1024).optional(),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ name, token_service_url, client_id, client_secret, client_authentication, scope, scope_content_type, resource, audience, description, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `SET OAUTH2 CLIENT CREDENTIAL ${name}`);
      try {
        const outcome = await createOrReplace(`/OAuth2ClientCredentials(${key(name)})`, '/OAuth2ClientCredentials', existing => ({
          Name: name,
          Description: description ?? existing?.Description ?? '',
          TokenServiceUrl: token_service_url,
          ClientId: client_id,
          ClientSecret: client_secret,
          ClientAuthentication: client_authentication,
          Scope: scope ?? '',
          ScopeContentType: scope_content_type,
          Resource: resource ?? '',
          Audience: audience ?? ''
        }));
        return { [outcome]: true, name };
      } catch (error) {
        throw withoutSecret(error, client_secret);
      }
    });

  register('cpi_upload_certificate', 'Upload certificate to keystore',
    'Add a PEM certificate (max 10 KiB) to the tenant keystore under alias; pass update: true to replace an existing entry. Requires confirmation exactly equal to UPLOAD CERTIFICATE <alias>.',
    {
      alias: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
      certificate: z.string()
        .refine(value => Buffer.byteLength(value, 'utf8') <= MAX_CERTIFICATE_BYTES, 'must be at most 10 KiB')
        .refine(value => value.includes('-----BEGIN CERTIFICATE-----'), 'must be a PEM certificate (-----BEGIN CERTIFICATE-----)'),
      update: z.boolean().default(false),
      confirmation
    },
    OVERWRITE_ANNOTATIONS,
    async ({ alias, certificate, update, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `UPLOAD CERTIFICATE ${alias}`);
      // Keystore keys are the hex of the UTF-8 alias because slashes are not allowed in the URI even when encoded.
      const hexalias = Buffer.from(alias, 'utf8').toString('hex');
      try {
        await cpi('PUT', `/CertificateResources(${key(hexalias)})/$value`, {
          query: { fingerprintVerified: 'true', returnKeystoreEntries: 'false', update: String(update) },
          body: certificate,
          contentType: 'application/pkix-cert',
          responseType: 'text',
          expect: [200, 204]
        });
      } catch (error) {
        if (!update && /\(HTTP 400\)/.test(error?.message)) throw new IntegrationError(`Keystore alias ${alias} already exists; pass update: true to replace it`);
        throw error;
      }
      return { uploaded: true, alias, hexalias, replaced: update };
    });

  // ---------------------------------------------------------------- number ranges, partner directory

  register('cpi_list_number_ranges', 'List CPI number ranges',
    'List number range objects (Name, Description, MinValue, MaxValue, CurrentValue = next value, Rotate, FieldLength, deployment).',
    {},
    READ_ONLY_ANNOTATIONS,
    async () => list(await cpi('GET', '/NumberRanges')).map(range => ({
      ...pick(range, ['Name', 'Description', 'MinValue', 'MaxValue', 'CurrentValue', 'Rotate', 'FieldLength', 'DeployedBy']),
      ...dates(range, ['DeployedOn'])
    })));

  register('cpi_set_number_range', 'Set CPI number range',
    'Create or replace a number range object. Values are non-negative integers of at most 14 digits with min_value ≤ current_value ≤ max_value; current_value is the next value handed out (default: kept on update, min_value on create). field_length 0 means no zero padding. Requires confirmation exactly equal to SET NUMBER RANGE <name>.',
    z.object({
      name: z.string().regex(/^[A-Za-z0-9 _.-]{1,120}$/),
      description: z.string().max(1024).optional(),
      min_value: numberText,
      max_value: numberText,
      current_value: numberText.optional(),
      rotate: z.boolean().default(false),
      field_length: z.number().int().min(0).max(14).default(0),
      confirmation
    }).strict().superRefine((value, context) => {
      const min = BigInt(value.min_value);
      if (min > BigInt(value.max_value)) context.addIssue({ code: 'custom', path: ['max_value'], message: 'max_value must be at least min_value' });
      if (value.current_value !== undefined && (BigInt(value.current_value) < min || BigInt(value.current_value) > BigInt(value.max_value))) {
        context.addIssue({ code: 'custom', path: ['current_value'], message: 'current_value must be between min_value and max_value' });
      }
    }),
    OVERWRITE_ANNOTATIONS,
    async ({ name, description, min_value, max_value, current_value, rotate, field_length, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `SET NUMBER RANGE ${name}`);
      const [min, max] = [BigInt(min_value), BigInt(max_value)];
      let body;
      const outcome = await createOrReplace(`/NumberRanges(${key(name)})`, '/NumberRanges', existing => {
        let current = current_value === undefined ? existing?.CurrentValue ?? min_value : current_value;
        if (!/^\d{1,14}$/.test(String(current)) || BigInt(current) < min || BigInt(current) > max) {
          throw new IntegrationError(`Current value ${current} of number range ${name} is outside ${min}..${max}; pass current_value`);
        }
        current = BigInt(current).toString();
        body = {
          Name: name,
          Description: description ?? existing?.Description ?? '',
          MinValue: min.toString(),
          MaxValue: max.toString(),
          CurrentValue: current,
          Rotate: String(rotate),
          FieldLength: String(field_length)
        };
        return body;
      });
      return { [outcome]: true, ...pick(body, ['Name', 'MinValue', 'MaxValue', 'CurrentValue', 'Rotate', 'FieldLength']) };
    });

  register('cpi_list_partner_parameters', 'List Partner Directory parameters',
    'List Partner Directory string parameters (Pid, Id, Value) and binary parameter metadata (Pid, Id, ContentType; content is not returned), optionally for one partner id.',
    { pid: z.string().max(60).regex(partnerChars).optional(), top: topSchema(500, 200) },
    READ_ONLY_ANNOTATIONS,
    async ({ pid, top }) => {
      const query = { $filter: pid ? `Pid eq ${odataKey(pid)}` : undefined, $top: top };
      const audit = entry => ({ ...pick(entry, ['LastModifiedBy']), ...dates(entry, ['LastModifiedTime']) });
      const strings = list(await cpi('GET', '/StringParameters', { query })).map(entry => ({ ...pick(entry, ['Pid', 'Id', 'Value']), ...audit(entry) }));
      const binaries = list(await cpi('GET', '/BinaryParameters', { query })).map(entry => ({ ...pick(entry, ['Pid', 'Id', 'ContentType']), ...audit(entry) }));
      return { string_parameters: strings, binary_parameters: binaries };
    });

  register('cpi_set_partner_parameter', 'Set Partner Directory parameter',
    'Create or replace a Partner Directory string parameter (value up to 4000 characters) or binary parameter (base64 value up to 262144 characters, content_type required). Requires confirmation exactly equal to SET PARTNER PARAMETER <pid>/<id>.',
    z.object({
      pid: z.string().min(1).max(60).regex(partnerChars),
      id: z.string().min(1).max(1500).regex(partnerChars),
      type: z.enum(['string', 'binary']),
      value: z.string().max(262_144),
      content_type: z.enum(PARTNER_CONTENT_TYPES).optional(),
      confirmation
    }).strict().superRefine((value, context) => {
      if (value.type === 'string') {
        if (value.value.length > 4000) context.addIssue({ code: 'custom', path: ['value'], message: 'string parameter values are at most 4000 characters' });
        if (value.content_type) context.addIssue({ code: 'custom', path: ['content_type'], message: 'content_type is only allowed for binary parameters' });
        return;
      }
      if (!value.content_type) context.addIssue({ code: 'custom', path: ['content_type'], message: 'content_type is required for binary parameters' });
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.value) || value.value.length % 4 !== 0) {
        context.addIssue({ code: 'custom', path: ['value'], message: 'binary parameter values must be base64' });
      }
    }),
    OVERWRITE_ANNOTATIONS,
    async ({ pid, id, type, value, content_type, confirmation: confirmed }) => {
      requireConfirmation(confirmed, `SET PARTNER PARAMETER ${pid}/${id}`);
      const set = type === 'string' ? 'StringParameters' : 'BinaryParameters';
      const content = type === 'binary' ? { ContentType: content_type } : {};
      const outcome = await createOrReplace(`/${set}(Pid=${key(pid)},Id=${key(id)})`, `/${set}`,
        existing => (existing ? { Value: value, ...content } : { Pid: pid, Id: id, Value: value, ...content }),
        { putExpect: [200, 204], postExpect: [201] });
      return { [outcome]: true, pid, id, type };
    });

  // ---------------------------------------------------------------- data stores, variables, JMS (the data store APIs accept no query options)

  register('cpi_list_data_stores', 'List CPI data stores',
    'List data stores with their iFlow, type, visibility and message counts; optionally only stores with overdue entries.',
    { overdue_only: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ overdue_only }) => list(await cpi('GET', '/DataStores', { query: { overdueonly: overdue_only ? 'true' : undefined } }))
      .map(store => pick(store, ['DataStoreName', 'IntegrationFlow', 'Type', 'Visibility', 'NumberOfMessages', 'NumberOfOverdueMessages'])));

  register('cpi_list_data_store_entries', 'List data store entries',
    `List entries of one data store (Id, Status, MessageId, due/created/retain dates; up to ${MAX_LIST_ENTRIES}). Entry payloads are never read. type is empty for Global and iFlow data stores.`,
    { data_store: z.string().min(1).max(200), integration_flow: z.string().min(1).max(200), type: z.string().max(40).default('') },
    READ_ONLY_ANNOTATIONS,
    async ({ data_store, integration_flow, type }) => {
      const entries = list(await cpi('GET', `/DataStores(DataStoreName=${key(data_store)},IntegrationFlow=${key(integration_flow)},Type=${key(type)})/Entries`))
        .map(entry => ({ ...pick(entry, ['Id', 'Status', 'MessageId']), ...dates(entry, ['DueAt', 'CreatedAt', 'RetainUntil']) }));
      return { total: entries.length, returned: Math.min(entries.length, MAX_LIST_ENTRIES), entries: entries.slice(0, MAX_LIST_ENTRIES) };
    });

  register('cpi_list_variables', 'List CPI variables',
    'List global and iFlow variables (name, iFlow, visibility, updated/retain dates). Values are never read.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () => list(await cpi('GET', '/Variables'))
      .map(variable => ({ ...pick(variable, ['VariableName', 'IntegrationFlow', 'Visibility']), ...dates(variable, ['UpdatedAt', 'RetainUntil']) })));

  register('cpi_get_jms_broker_status', 'Get JMS broker status',
    'Return JMS broker capacity and limit flags (0 ok, 1 over limit) and the queues in warning (1) or critical (2) state.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () => {
      const broker = await cpi('GET', `/JmsBrokers(${key('Broker1')})`, { query: { $expand: 'QueueStates' } });
      const queues = list(broker?.QueueStates);
      const unhealthy = queues.filter(queue => Number(queue.State) !== 0).map(queue => pick(queue, ['Name', 'State']));
      return { broker: pick(broker, JMS_BROKER_FIELDS), queue_count: queues.length, unhealthy_queue_count: unhealthy.length, unhealthy_queues: unhealthy };
    });

  register('cpi_get_message_log_steps', 'Get message processing steps',
    `Return the processing steps of the latest run of a message (StepId, ModelStepId, Activity, Status, Error, start/stop), ordered by start time, up to ${MAX_RUN_STEPS}. Payloads are never read.`,
    { message_guid: messageGuid },
    READ_ONLY_ANNOTATIONS,
    async ({ message_guid }) => {
      const runs = list(await cpi('GET', `/MessageProcessingLogs(${key(message_guid)})/Runs`));
      if (!runs.length) return { run_count: 0, run: null, total_steps: 0, steps: [] };
      const latest = runs.reduce((best, run) => (time(run.RunStart) > time(best.RunStart) ? run : best));
      const steps = list(await cpi('GET', `/MessageProcessingLogRuns(${key(latest.Id)})/RunSteps`))
        .sort((left, right) => time(left.StepStart) - time(right.StepStart));
      return {
        run_count: runs.length,
        run: { ...pick(latest, ['Id', 'OverallState', 'LogLevel']), ...dates(latest, ['RunStart', 'RunStop']) },
        total_steps: steps.length,
        ...(steps.length > MAX_RUN_STEPS ? { truncated: true } : {}),
        steps: steps.slice(0, MAX_RUN_STEPS).map(step => ({
          ...pick(step, ['StepId', 'ModelStepId', 'Activity', 'Status']),
          Error: step.Error ? capText(String(step.Error), STEP_ERROR_CAP).text : null,
          ...dates(step, ['StepStart', 'StepStop'])
        }))
      };
    });
}

/** Names of every cpi_* tool, in registration order. */
export function cpiToolNames() {
  const names = [];
  registerCpiTools(name => names.push(name), null, {});
  return names;
}
