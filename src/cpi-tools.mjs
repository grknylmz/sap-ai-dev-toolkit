// MCP tools for SAP Cloud Integration (CPI) over the /api/v1 OData API.
import { z } from 'zod';
import { X509Certificate } from 'node:crypto';
import { registerCpiSecurityTools } from './cpi-security.mjs';
import { registerCpiOperationalTools } from './cpi-operational.mjs';
import { readCpiConfigurations, writeCpiConfigurations, cpiReleaseFailure, CPI_PACKAGE_ARTIFACT_SETS as PACKAGE_ARTIFACT_SETS } from './cpi-content.mjs';
import { registerCpiReleaseTools, CPI_ARTIFACT_TYPES as ARTIFACT_TYPES } from './cpi-release.mjs';
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
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { registerCpiMonitoringTools } from './cpi-monitoring.mjs';
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
const waitSeconds = fallback => z.number().int().min(0).max(50).default(fallback);
// Discover (SAP standard) package ids are longer than design-time ids and may contain periods.
const sourcePackageId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,199}$/);
const securityName = z.string().regex(/^[A-Za-z0-9 _.@-]{1,150}$/);
const partnerChars = /^[A-Za-z0-9\-._~@]+$/;
const numberText = z.union([z.number().int().min(0).max(99_999_999_999_999), z.string().regex(/^\d{1,14}$/)]);

const artifactType = z.enum(Object.keys(ARTIFACT_TYPES));
const RUNTIME_STATUSES = ['STARTED', 'STARTING', 'STOPPING', 'ERROR'];
const KEYSTORES = ['system', 'backup_admin_system', 'KeyRenewal'];
const PARTNER_CONTENT_TYPES = ['xml', 'xsl', 'xsd', 'json', 'text', 'zip', 'gz', 'zlib', 'crt'];
const MAX_VALUES_PER_PAIR = 500;
const collectionInputs = { top: topSchema(200, 100), cursor: cursorSchema };
const MAX_CERTIFICATE_BYTES = 10 * 1024;

const dates = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, odataDate(value[field])]));

function endpointUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return null; }
}

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
export function registerCpiTools(register, client, { pollIntervalMs, summary }) {
  const cpi = (method, path, options) => client.request(method, `${CPI_BASE}${path}`, options);
  const pager = createCollectionPager(client, { root: CPI_BASE, request: cpi });
  registerCpiMonitoringTools(register, client);
  registerCpiSecurityTools(register, client);
  registerCpiOperationalTools(register, client, { summary });
  registerCpiReleaseTools(register, client, { pollIntervalMs });
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
    client,
    root: CPI_BASE,
    examples: "/JmsBrokers('Broker1') with $expand=QueueStates, /AccessPolicies, /KeystoreEntries with keystoreName=system, /MessageProcessingLogs('<guid>')/Runs"
  });

  register('cpi_list_packages', 'List CPI packages',
    'List Cloud Integration design-time packages (Id, Name, ShortText, Version, Mode).',
    collectionInputs,
    READ_ONLY_ANNOTATIONS,
    // The CPI tenant rejects $select on IntegrationPackages (HTTP 501); project client-side.
    async args => pager.page({ ...args, path: '/IntegrationPackages', orderBy: 'Name',
      project: entry => pick(entry, ['Id', 'Name', 'ShortText', 'Version', 'Mode']) }));

  register('cpi_list_iflows', 'List iFlows in a package',
    'List the integration flows of one CPI package (Id, Name, Version, Description).',
    { package_id: packageId, ...collectionInputs },
    READ_ONLY_ANNOTATIONS,
    async ({ package_id, ...args }) => pager.page({ ...args,
      path: `/IntegrationPackages(${key(package_id)})/IntegrationDesigntimeArtifacts`,
      mode: 'local', sourceComplete: false,
      project: artifact => pick(artifact, ['Id', 'Name', 'Version', 'Description']) }));

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
    { iflow_id: iflowId.optional(), ...collectionInputs },
    READ_ONLY_ANNOTATIONS,
    async ({ iflow_id, ...args }) => pager.page({ ...args, path: '/ServiceEndpoints', mode: 'local',
      query: { $expand: 'EntryPoints' }, identity: iflow_id,
      filter: iflow_id ? endpoint => endpoint.Name === iflow_id || endpoint.Id === iflow_id : undefined,
      project: endpoint => ({
        name: endpoint.Name,
        urls: list(endpoint.EntryPoints).map(entryPoint => endpointUrl(entryPoint.Url)).filter(Boolean)
      })
    }));


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
    'Replace/add bundle resources in the active draft and bump its bundle version, preserving fresh configured values below explicit parameter overrides. Reapply surviving configuration after PUT and report exact partial progress. No retained history is created. Fails before writing on expected_version mismatch. Exact confirmation: UPDATE IFLOW <iflow_id>.',
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
      const previousDefaults = bundle.has(PARAMETERS_PROP) ? parseProperties(strFromU8(bundle.get(PARAMETERS_PROP))) : {};
      const changed = new Set();
      for (const file of files) {
        bundle.set(file.path, strToU8(file.content));
        changed.add(file.path);
      }
      // Read tenant configuration immediately before the draft replacement, not stale bundled defaults.
      const configured = await readCpiConfigurations(client, iflow_id);
      const defaults = bundle.has(PARAMETERS_PROP) ? parseProperties(strFromU8(bundle.get(PARAMETERS_PROP))) : {};
      const removed = new Set(Object.keys(previousDefaults).filter(key => !Object.hasOwn(defaults, key) && !Object.hasOwn(parameters ?? {}, key)));
      const retained = configured.filter(entry => !removed.has(entry.ParameterKey));
      const effective = { ...defaults, ...Object.fromEntries(retained.map(entry => [entry.ParameterKey, entry.ParameterValue])), ...parameters };
      if (retained.length || Object.keys(parameters ?? {}).length) {
        bundle.set(PARAMETERS_PROP, strToU8(propertiesText(effective)));
        const propdef = bundle.has(PARAMETERS_PROPDEF) ? strFromU8(bundle.get(PARAMETERS_PROPDEF)) : '';
        const updatedPropdef = mergePropdef(propdef, Object.keys(effective));
        if (updatedPropdef !== propdef) {
          bundle.set(PARAMETERS_PROPDEF, strToU8(updatedPropdef));
          changed.add(PARAMETERS_PROPDEF);
        }
        changed.add(PARAMETERS_PROP);
      }
      if (!bundle.has(MANIFEST_PATH)) throw new IntegrationError(`iFlow ${iflow_id} bundle has no ${MANIFEST_PATH}`);
      bundle.set(MANIFEST_PATH, strToU8(replaceManifestVersion(strFromU8(bundle.get(MANIFEST_PATH)), newVersion)));
      changed.add(MANIFEST_PATH);
      const reapply = new Map(retained.map(entry => [entry.ParameterKey, entry]));
      for (const [ParameterKey, ParameterValue] of Object.entries(parameters ?? {})) reapply.set(ParameterKey, {
        ParameterKey, ParameterValue, DataType: reapply.get(ParameterKey)?.DataType ?? 'xsd:string'
      });
      const parameter_names = { source_defaults: Object.keys(defaults).sort(), configured: [...reapply.keys()].sort(),
        explicit_overrides: Object.keys(parameters ?? {}).sort() };
      // Preserve exact progress within the output budget; reject before the accepted content write otherwise.
      if (Buffer.byteLength(JSON.stringify(parameter_names)) > 40000 || Buffer.byteLength(JSON.stringify([...reapply.keys()])) > 24000) {
        throw new IntegrationError('CPI parameter names exceed the safe mutation progress-report limit');
      }
      const result = { updated: true, content_updated: true, previous_version: current, new_version: newVersion,
        retained_version_created: false, changed_files: [...changed], parameter_names };
      try {
        await cpi('PUT', path, {
          json: { Name: name ?? artifact.Name, ArtifactContent: Buffer.from(writeBundle(bundle)).toString('base64') },
          expect: [200, 202, 204], responseType: 'none', accept: '*/*'
        });
      } catch (error) {
        const status = Number(error?.status);
        const accepted = status >= 200 && status < 300 ? true : status >= 400 ? false : null;
        return { ...result, updated: accepted, content_updated: accepted, outcome: 'unverified',
          configuration: { updated: [], failed: null, attempted: false }, source_result: cpiReleaseFailure(error) };
      }
      try {
        const configuration = await writeCpiConfigurations(client, iflow_id, [...reapply.values()]);
        return { ...result, configuration, outcome: configuration.failed ? 'partial' : 'succeeded' };
      } catch (error) {
        return { ...result, outcome: 'partial', configuration: { updated: [], failed: cpiReleaseFailure(error) } };
      }
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
      return writeCpiConfigurations(client, iflow_id, parameters.map(parameter => ({
        ParameterKey: parameter.key, ParameterValue: parameter.value, DataType: parameter.data_type
      })));
    });


  register('cpi_list_runtime_artifacts', 'List deployed CPI artifacts',
    'List deployed (runtime) Cloud Integration artifacts of every type (iFlows, value mappings, script collections, message mappings, …) with status and deployment time; optionally only one status.',
    { status: z.enum(RUNTIME_STATUSES).optional(), top: topSchema(500, 200), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS,
    async ({ status, ...args }) => pager.page({ ...args, path: '/IntegrationRuntimeArtifacts', orderBy: 'Id',
      query: { $filter: status ? `Status eq '${status}'` : undefined }, project: runtimeSummary }));

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
    z.object({ package_id: packageId, type: z.enum(Object.keys(PACKAGE_ARTIFACT_SETS)).optional(), ...collectionInputs }).strict()
      .refine(value => !value.cursor || value.type, { path: ['cursor'], message: 'cursor requires a concrete artifact type' }),
    READ_ONLY_ANNOTATIONS,
    async ({ package_id, type, ...args }) => {
      const read = group => pager.page({ ...args, maxBytes: type ? 95 * 1024 : 22 * 1024, path: `/IntegrationPackages(${key(package_id)})/${PACKAGE_ARTIFACT_SETS[group]}`,
        mode: 'local', sourceComplete: false,
        project: artifact => pick(artifact, ['Id', 'Name', 'Version', 'Description']) });
      if (type) return read(type);
      const result = {};
      for (const group of Object.keys(PACKAGE_ARTIFACT_SETS)) result[group] = await read(group);
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
    `Read bounded agency/identifier pairs of a value mapping (up to 20 pairs and ${MAX_VALUES_PER_PAIR} values/defaults per pair, subject to the response byte budget). Nested collection completeness is unverified; no continuation route is inferred.`,
    { artifact_id: artifactId, version: artifactVersion },
    READ_ONLY_ANNOTATIONS,
    async ({ artifact_id, version }) => {
      const path = designtimePath('value_mapping', artifact_id, version);
      const valMap = entry => ({ Id: entry.Id, SrcValue: entry.Value?.SrcValue ?? null, TgtValue: entry.Value?.TgtValue ?? null });
      // These nested APIs have no verified traversal contract. Keep source counts, but never
      // turn a capped or continuation-bearing response into an exhaustive value inventory.
      const bounded = async (nestedPath, project, top, maxBytes) => {
        const page = await pager.page({ path: nestedPath, mode: 'local', sourceComplete: false, project, top, maxBytes });
        const envelope = { ...page, next_cursor: null, complete: false, stop_reason: 'source_limit' };
        // Account for the actual pretty-printed result at its deepest nesting level.
        const fits = count => Buffer.byteLength(JSON.stringify({ ...envelope, items: page.items.slice(0, count), returned: count }, null, 2)
          .replaceAll('\n', '\n        ')) <= maxBytes;
        let low = 0;
        let high = page.items.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(middle)) low = middle;
          else high = middle - 1;
        }
        return { ...envelope, items: page.items.slice(0, low), returned: low };
      };
      const schemas = await bounded(`${path}/ValMapSchema`,
        schema => pick(schema, ['SrcAgency', 'SrcId', 'TgtAgency', 'TgtId', 'State']), 20, 8 * 1024);
      const pairs = [];
      const valueBudget = Math.floor(76 * 1024 / (Math.max(1, schemas.items.length) * 2));
      for (const schema of schemas.items) {
        const pairPath = `${path}/ValMapSchema(SrcAgency=${key(schema.SrcAgency)},SrcId=${key(schema.SrcId)},TgtAgency=${key(schema.TgtAgency)},TgtId=${key(schema.TgtId)})`;
        pairs.push({
          ...schema,
          values: await bounded(`${pairPath}/ValMaps`, valMap, MAX_VALUES_PER_PAIR, valueBudget),
          default_values: await bounded(`${pairPath}/DefaultValMaps`, valMap, MAX_VALUES_PER_PAIR, valueBudget)
        });
      }
      return { artifact_id, version, agency_pairs: { ...schemas, items: pairs } };
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
          expect: [200, 201], withStatus: true, responseType: 'text', accept: 'application/json'
        });
      } catch (error) {
        if (/\(HTTP 409\)/.test(error?.message)) {
          throw new IntegrationError(`Package ${package_id} conflicts with an existing design-time package (HTTP 409); use import_mode OVERWRITE_MERGE or CREATE_COPY with a different suffix`);
        }
        throw error;
      }
      let metadata;
      try {
        const body = JSON.parse(copied.data);
        metadata = entity(body?.d ?? body);
      } catch { /* HTTP acceptance is still evidence when the reply is not usable JSON. */ }
      const identified = typeof metadata?.Id === 'string' && metadata.Id.length > 0;
      return { accepted: true, copied: identified, outcome: identified ? 'succeeded' : 'unverified',
        http_status: copied.status, import_mode, package: pick(metadata, ['Id', 'Name', 'Version']) };
    });

  // ---------------------------------------------------------------- security material

  const deployment = descriptor => (descriptor ? { ...pick(descriptor, ['Type', 'Status', 'DeployedBy']), ...dates(descriptor, ['DeployedOn']) } : null);
  register('cpi_list_security_material', 'List CPI security material',
    'List user credentials, OAuth2 client credentials or keystore entries (keystore system, backup_admin_system or KeyRenewal; default system) with deployment status. Passwords, client secrets and keys are never returned.',
    z.object({
      kind: z.enum(['user_credentials', 'oauth2_client_credentials', 'keystore_entries']),
      keystore: z.enum(KEYSTORES).optional(),
      ...collectionInputs
    }).strict().refine(value => !value.keystore || value.kind === 'keystore_entries', { path: ['keystore'], message: 'keystore is only allowed with kind keystore_entries' }),
    READ_ONLY_ANNOTATIONS,
    async ({ kind, keystore, ...args }) => {
      if (kind === 'user_credentials') {
        return pager.page({ ...args, path: '/UserCredentials', mode: 'local', project: entry => redactSecrets({
          ...pick(entry, ['Name', 'Kind', 'Description']),
          deployment: deployment(entry.SecurityArtifactDescriptor)
        }) });
      }
      if (kind === 'oauth2_client_credentials') {
        return pager.page({ ...args, path: '/OAuth2ClientCredentials', mode: 'local', project: entry => redactSecrets({
          ...pick(entry, ['Name', 'Description', 'ClientAuthentication', 'ScopeContentType']),
          deployment: deployment(entry.SecurityArtifactDescriptor)
        }) });
      }
      return pager.page({ ...args, path: '/KeystoreEntries', mode: 'local', query: { keystoreName: keystore ?? 'system' },
        project: entry => ({
          ...pick(entry, ['Alias', 'Hexalias', 'Type', 'KeyType', 'Status']),
          ...dates(entry, ['ValidNotBefore', 'ValidNotAfter'])
        }) });
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
      client_authentication: z.enum(['body', 'header']).optional(),
      scope: z.string().max(2048).optional(),
      scope_content_type: z.enum(['urlencoded', 'json']).optional(),
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
          ClientAuthentication: client_authentication ?? existing?.ClientAuthentication ?? 'body',
          Scope: scope ?? existing?.Scope ?? '',
          ScopeContentType: scope_content_type ?? existing?.ScopeContentType ?? 'urlencoded',
          Resource: resource ?? existing?.Resource ?? '',
          Audience: audience ?? existing?.Audience ?? ''
        }));
        return { [outcome]: true, name };
      } catch (error) {
        const evidence = cpiReleaseFailure(error);
        throw new IntegrationError(`CPI OAuth2 client credential write failed${evidence.status ? ` (HTTP ${evidence.status})` : ''}; tenant response withheld`, evidence);
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
      let parsedCertificate;
      try { parsedCertificate = new X509Certificate(certificate); }
      catch { throw new IntegrationError('Malformed PEM certificate'); }
      const fingerprint_sha256 = parsedCertificate.fingerprint256.replaceAll(':', '').toLowerCase();
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
        if (!update && (error?.status === 400 || /\(HTTP 400\)/.test(error?.message))) {
          let exists = /\b(?:entry|alias|certificate)\b.{0,80}\b(?:already exists|exists already|exists)\b/i.test(error.message);
          if (!exists) {
            try {
              const fresh = await cpi('GET', '/KeystoreEntries', { query: { keystoreName: 'system' } });
              exists = list(fresh).some(entry => entry.Alias === alias || entry.Hexalias === hexalias);
            } catch { /* Preserve the original upload cause when alias evidence is unavailable. */ }
          }
          if (exists) throw new IntegrationError(`Keystore alias ${alias} already exists; pass update: true to replace it`);
        }
        throw error;
      }
      return { uploaded: true, alias, hexalias, replaced: update, fingerprint_sha256, fingerprint_source: 'local_X509Certificate', tenant_fingerprint_verified: false };
    });

  // ---------------------------------------------------------------- number ranges, partner directory

  register('cpi_list_number_ranges', 'List CPI number ranges',
    'List number range objects (Name, Description, MinValue, MaxValue, CurrentValue = next value, Rotate, FieldLength, deployment).',
    collectionInputs,
    READ_ONLY_ANNOTATIONS,
    async args => pager.page({ ...args, path: '/NumberRanges', mode: 'local', project: range => ({
      ...pick(range, ['Name', 'Description', 'MinValue', 'MaxValue', 'CurrentValue', 'Rotate', 'FieldLength']),
      ...dates(range, ['DeployedOn'])
    }) }));

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
    'List Partner Directory parameter identities and binary content types, optionally for one partner id. Parameter values and binary content are not returned.',
    z.object({ pid: z.string().max(60).regex(partnerChars).optional(), type: z.enum(['string', 'binary', 'all']).default('all'), ...collectionInputs }).strict()
      .refine(value => !value.cursor || value.type !== 'all', { path: ['cursor'], message: 'cursor requires string or binary type' }),
    READ_ONLY_ANNOTATIONS,
    async ({ pid, type, ...args }) => {
      const query = { $filter: pid ? `Pid eq ${odataKey(pid)}` : undefined };
      const read = selected => pager.page({ ...args, maxBytes: type === 'all' ? 46 * 1024 : 95 * 1024, path: selected === 'string' ? '/StringParameters' : '/BinaryParameters',
        query, orderBy: 'Pid,Id', project: entry => ({
          ...pick(entry, selected === 'string' ? ['Pid', 'Id'] : ['Pid', 'Id', 'ContentType']),
          ...dates(entry, ['LastModifiedTime'])
        }) });
      if (type !== 'all') return read(type);
      return { string_parameters: await read('string'), binary_parameters: await read('binary') };
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

}

/** Names of every cpi_* tool, in registration order. */
export function cpiToolNames() {
  const names = [];
  registerCpiTools(name => names.push(name), null, {});
  return names;
}
