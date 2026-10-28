// CPI release operations keep acceptance separate from completed business/content/runtime evidence.
import { z } from 'zod';
import { CREATE_ANNOTATIONS, READ_ONLY_ANNOTATIONS, confirmation, key, requireConfirmation, sleep } from './integration-common.mjs';
import { IntegrationError, odataDate, odataKey } from './integration-http.mjs';
import { CPI_BASE, cpiArtifactPath, readCpiContent, cpiReleaseFailure } from './cpi-content.mjs';
import { rememberValidation } from './integration-validation.mjs';
import { bundleDigest, MANIFEST_PATH, replaceManifestVersion, strFromU8, strToU8 } from './iflow-bundle.mjs';
import { stateDigest } from './integration-state.mjs';

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/);
const namedVersion = z.string().regex(/^\d+\.\d+\.\d+$/);
export const cpiVersionSchema = z.string().regex(/^(?:active|\d+\.\d+\.\d+)$/).default('active');
const waitSchema = z.number().int().min(0).max(50).default(45);
const taskSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const tasks = new WeakMap();
const artifactTypes = {
  value_mapping: { set: 'ValueMappingDesigntimeArtifacts', deploy: 'DeployValueMappingDesigntimeArtifact' },
  script_collection: { set: 'ScriptCollectionDesigntimeArtifacts', deploy: 'DeployScriptCollectionDesigntimeArtifact' },
  message_mapping: { set: 'MessageMappingDesigntimeArtifacts', deploy: 'DeployMessageMappingDesigntimeArtifact' }
};
export const CPI_ARTIFACT_TYPES = Object.freeze(artifactTypes);
function privateError(error) {
  const evidence = cpiReleaseFailure(error);
  return new IntegrationError(`CPI release source request failed${evidence.status ? ` (HTTP ${evidence.status})` : ''}; tenant text withheld`, {
    ...evidence, ...(error?.code === 'INTEGRATION_DEADLINE' ? { code: error.code } : {})
  });
}
async function request(client, method, path, options) {
  try { return await client.request(method, `${CPI_BASE}${path}`, options); }
  catch (error) { throw privateError(error); }
}
async function releaseContent(client, id, version, options) {
  try {
    const content = await readCpiContent(client, id, version, options);
    if (version !== 'active' && content.resolved_version !== version) throw new IntegrationError('CPI selected retained version identity mismatch');
    return content;
  }
  catch (error) { throw privateError(error); }
}
const safeStatus = value => typeof value === 'string' && /^[A-Za-z0-9_ -]{1,100}$/.test(value) ? value : null;
const runtimePath = id => `/IntegrationRuntimeArtifacts(${key(id)})`;

export function parseCpiValidation(text) {
  const match = /^\s*Checkexecutionresult:\s*(Passed|Failed)\b/i.exec(typeof text === 'string' ? text : '');
  const passed = match ? match[1].toLowerCase() === 'passed' : null;
  const diagnostics = [];
  let diagnostics_truncated = false;
  if (match && passed === false) {
    try {
      const raw = JSON.parse(text.slice(match[0].length).trim());
      if (Array.isArray(raw)) {
        diagnostics_truncated = raw.length > 50;
        for (const item of raw.slice(0, 50)) {
          const identity = (value, pattern, max) => typeof value === 'string' && value.length <= max && pattern.test(value) ? value : null;
          diagnostics.push({ severity: identity(item?.severity, /^(?:Error|Warning|Info|Information)$/i, 20),
            // Arbitrary tenant messages can echo source/configuration. Structural identities remain useful without that unsafe text.
            message: 'CPI validation diagnostic; free-form message withheld.', message_withheld: true,
            sourceObject: identity(item?.sourceObject, /^[A-Za-z0-9_./: -]+$/, 500),
            resourcePath: identity(item?.resourcePath, /^src\/[A-Za-z0-9_./ -]+$/, 300),
            resourceName: identity(item?.resourceName, /^[A-Za-z0-9_. -]+$/, 200) });
        }
      } else diagnostics_truncated = true;
    } catch { diagnostics_truncated = true; }
  }
  return { passed, diagnostics, diagnostics_truncated, response_recognized: passed !== null };
}

async function validate(client, { iflow_id, version, confirmation: confirmed }) {
  requireConfirmation(confirmed, `VALIDATE IFLOW ${iflow_id} VERSION ${version}`);
  const deadline = Date.now() + 55000;
  const before = await releaseContent(client, iflow_id, version, { deadline });
  let response;
  try {
    response = await request(client, 'POST', '/ValidateIntegrationDesigntimeArtifact', {
      query: { Id: odataKey(iflow_id), Version: odataKey(version) }, responseType: 'text', accept: '*/*', expect: [200, 202], withStatus: true, deadline
    });
  } catch (error) {
    rememberValidation(client, { id: iflow_id, ...before, passed: null, matching_state: false });
    const status = Number(error?.status);
    return { iflow_id, selector: version, resolved_version: before.resolved_version, passed: null,
      validation_accepted: status >= 200 && status < 300 ? true : status >= 400 ? false : null,
      validation: 'unverified', source_result: cpiReleaseFailure(error), scope: 'iflow_all_option_configuration' };
  }
  const result = parseCpiValidation(response.data);
  let matching_state = false;
  let source_result;
  try {
    const after = await readCpiContent(client, iflow_id, version, { deadline });
    matching_state = after.resolved_version === before.resolved_version && after.state_sha256 === before.state_sha256;
  } catch (error) { source_result = cpiReleaseFailure(error); }
  rememberValidation(client, { id: iflow_id, ...before, passed: result.passed, matching_state });
  return { iflow_id, selector: version, resolved_version: before.resolved_version, ...result,
    validation_accepted: true, http_status: response.status, matching_state,
    bundle_sha256: before.bundle_sha256, state_sha256: before.state_sha256,
    ...(source_result ? { source_result } : {}), scope: 'iflow_all_option_configuration' };
}

function normalizedBundleDigest(content, version) {
  const files = new Map(content.files);
  if (!files.has(MANIFEST_PATH)) throw new IntegrationError('CPI bundle has no manifest for retained-version comparison');
  files.set(MANIFEST_PATH, strToU8(replaceManifestVersion(strFromU8(files.get(MANIFEST_PATH)), version)));
  return bundleDigest(files);
}

async function saveVersion(client, { iflow_id, version, expected_current_version, expected_bundle_sha256, confirmation: confirmed }) {
  requireConfirmation(confirmed, `SAVE IFLOW VERSION ${iflow_id} ${version}`);
  const deadline = Date.now() + 55000;
  const current = await releaseContent(client, iflow_id, 'active', { deadline });
  if (current.resolved_version !== expected_current_version || current.bundle_sha256 !== expected_bundle_sha256) {
    throw new IntegrationError('CPI current draft version/content changed; re-read before saving a retained version');
  }
  const existing = await request(client, 'GET', cpiArtifactPath(iflow_id, version), { expect: [200, 404], withStatus: true, deadline });
  if (existing.status !== 404) throw new IntegrationError('The requested retained iFlow version already exists');
  // Do not upload or silently save a new draft: this operation saves the approved current draft exactly once.
  let response;
  try {
    response = await request(client, 'POST', '/IntegrationDesigntimeArtifactSaveAsVersion', {
      query: { Id: odataKey(iflow_id), SaveAsVersion: odataKey(version) }, responseType: 'none', accept: '*/*', expect: [200, 201, 202, 204], withStatus: true, deadline
    });
  } catch (error) {
    const status = Number(error?.status);
    return { iflow_id, version, saved: false, save_accepted: status >= 200 && status < 300 ? true : status >= 400 ? false : null,
      retained_version_created: null, outcome: 'unverified', source_result: cpiReleaseFailure(error) };
  }
  const result = { iflow_id, version, previous_version: current.resolved_version, save_accepted: true,
    http_status: response.status, retained_version_created: null, saved: false, outcome: 'unverified',
    validation_required: true, note: 'Validate this exact saved version before release readiness.' };
  try {
    const saved = await readCpiContent(client, iflow_id, version, { deadline });
    const matches = saved.resolved_version === version && normalizedBundleDigest(saved, version) === normalizedBundleDigest(current, version)
      && stateDigest('', saved.configurations) === stateDigest('', current.configurations);
    return { ...result, saved: matches, retained_version_created: saved.resolved_version === version ? true : null, outcome: matches ? 'succeeded' : 'unverified',
      resolved_version: saved.resolved_version, bundle_sha256: saved.bundle_sha256, state_sha256: saved.state_sha256,
      content_verified: matches };
  } catch (error) { return { ...result, source_result: cpiReleaseFailure(error) }; }
}

async function readRuntime(client, id, deadline) {
  const response = await request(client, 'GET', runtimePath(id), { expect: [200, 404], withStatus: true, deadline });
  const value = response.status === 200 ? response.data : null;
  return { present: response.status === 200, status: safeStatus(value?.Status),
    version: typeof value?.Version === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value.Version) ? value.Version : null,
    deployed_on: typeof value?.DeployedOn === 'string' && Number.isFinite(Date.parse(odataDate(value.DeployedOn))) ? odataDate(value.DeployedOn) : null };
}
function runtimeFields(runtime) {
  return { runtime_status: runtime.status, runtime_version: runtime.version, deployed_on: runtime.deployed_on };
}
function freshRuntime(context, runtime) {
  const previous = context.pre_deploy_runtime;
  if (!previous || !runtime.present || runtime.status !== 'STARTED' || !context.requested_version || runtime.version !== context.requested_version) return false;
  return !previous.present || runtime.version !== previous.version
    || runtime.deployed_on !== null && previous.deployed_on !== null && Date.parse(runtime.deployed_on) > Date.parse(previous.deployed_on);
}
function outcome(context, build, runtime) {
  if (['FAIL', 'FAIL_ON_LICENSE_ERROR'].includes(build)) return 'failed';
  const fresh = freshRuntime(context, runtime);
  const runtimeChanged = !context.pre_deploy_runtime?.present || runtime.version !== context.pre_deploy_runtime.version
    || runtime.deployed_on !== null && runtime.deployed_on !== context.pre_deploy_runtime.deployed_on;
  if (runtime.status === 'ERROR' && runtimeChanged) return 'failed';
  if (build === 'DEPLOYING') return 'pending';
  if (build === 'SUCCESS' && fresh) return 'succeeded';
  // Shared-artifact imports may return no task ID. Fresh exact runtime identity is then the available authoritative evidence.
  if (!context.task_required && !context.task_id && fresh) return 'succeeded';
  if (build === 'SUCCESS' && (runtime.status === null || runtime.status === 'STARTING')) return 'pending';
  if (!context.task_required && !context.task_id && (runtime.status === null || runtime.status === 'STARTING')) return 'pending';
  return 'unverified';
}
async function runtimeErrorEvidence(client, context, result, deadline) {
  if (result.runtime_status !== 'ERROR') return;
  try {
    const response = await request(client, 'GET', `${runtimePath(context.artifact_id)}/ErrorInformation/$value`, { responseType: 'text', accept: '*/*', expect: [200, 204], deadline });
    result.error_information = response ? 'CPI runtime error information is available; free-form text withheld.' : null;
    result.error_information_withheld = Boolean(response);
  } catch (error) { result.error_source_result = cpiReleaseFailure(error); }
}
async function observe(client, context, deadline) {
  const result = { ...context, outcome: 'unverified', build_status: null, runtime_status: null, runtime_version: null, deployed_on: null,
    error_information: null, timed_out: false };
  try {
    if (context.task_id) {
      const build = await request(client, 'GET', `/BuildAndDeployStatus(TaskId=${key(context.task_id)})`, { deadline });
      result.build_status = safeStatus(build?.Status);
      if (build?.TaskId !== undefined && build.TaskId !== context.task_id) {
        result.source_result = { result: 'error', reason: 'task_identity_mismatch' };
        return result;
      }
    }
    const runtime = context.artifact_id ? await readRuntime(client, context.artifact_id, deadline) : { present: false, status: null, version: null, deployed_on: null };
    Object.assign(result, runtimeFields(runtime));
    result.outcome = outcome(context, result.build_status, runtime);
    await runtimeErrorEvidence(client, context, result, deadline);
  } catch (error) {
    result.source_result = cpiReleaseFailure(error);
    result.timed_out = error?.code === 'INTEGRATION_DEADLINE';
    result.outcome = ['FAIL', 'FAIL_ON_LICENSE_ERROR'].includes(result.build_status) ? 'failed' : result.timed_out ? 'pending' : 'unverified';
  }
  return result;
}

export async function deployCpiArtifact(client, { artifact_id, type = 'iflow', version = 'active', wait_seconds = 45 }, { pollIntervalMs = 1000 } = {}) {
  // Zero wait still initiates once, but performs no post-acceptance reads. Prerequisites/POST use a bounded request deadline.
  const started = Date.now();
  const deadline = started + (wait_seconds === 0 ? 50000 : wait_seconds * 1000);
  const kind = type === 'iflow' ? { set: 'IntegrationDesigntimeArtifacts', deploy: 'DeployIntegrationDesigntimeArtifact' } : artifactTypes[type];
  const design = await request(client, 'GET', `/${kind.set}(Id=${key(artifact_id)},Version=${key(version)})`, { deadline });
  if (design?.Id !== artifact_id || typeof design?.Version !== 'string' || !/^\d+\.\d+\.\d+$/.test(design.Version)
    || version !== 'active' && design.Version !== version) throw new IntegrationError('CPI requested design identity/version is unavailable or mismatched');
  const pre_deploy_runtime = await readRuntime(client, artifact_id, deadline);
  const context = { artifact_id, ...(type === 'iflow' ? { iflow_id: artifact_id } : { type }), requested_selector: version, requested_version: design.Version,
    pre_deploy_runtime, task_id: null, task_required: type === 'iflow', deployment_accepted: true };
  let response;
  try {
    response = await request(client, 'POST', `/${kind.deploy}`, { query: { Id: odataKey(artifact_id), Version: odataKey(version) },
      responseType: 'text', accept: '*/*', expect: [200, 201, 202], withStatus: true, deadline });
  } catch (error) {
    const status = Number(error?.status);
    return { ...context, deployment_accepted: status >= 200 && status < 300 ? true : status >= 400 ? false : null,
      outcome: 'unverified', build_status: null, ...runtimeFields(pre_deploy_runtime), source_result: cpiReleaseFailure(error), timed_out: error?.code === 'INTEGRATION_DEADLINE' };
  }
  context.acceptance_status = response.status;
  const body = typeof response.data === 'string' ? response.data.trim().replace(/^"|"$/g, '') : '';
  context.task_id = taskSchema.safeParse(body).success ? body : null;
  context.response_body_present = body.length > 0;
  if (context.task_id) {
    let entries = tasks.get(client);
    if (!entries) { entries = new Map(); tasks.set(client, entries); }
    // Keep bounded private continuation baselines, not an unbounded deployment history.
    if (entries.size >= 200) entries.delete(entries.keys().next().value);
    entries.set(context.task_id, context);
  }
  let result = { ...context, outcome: 'pending', build_status: null, runtime_status: null, runtime_version: null, deployed_on: null, error_information: null, timed_out: false };
  if (wait_seconds === 0) return result;
  if (context.task_required && !context.task_id) return { ...result, outcome: 'unverified', note: 'Deployment was accepted without a usable task ID; do not redeploy to recover observation.' };
  for (;;) {
    if (Date.now() >= deadline) return { ...result, timed_out: true };
    result = await observe(client, context, deadline);
    if (['succeeded', 'failed'].includes(result.outcome) || result.source_result || result.build_status !== null && !['DEPLOYING', 'SUCCESS'].includes(result.build_status)) return result;
    if (context.task_id && result.build_status === null) return result;
    if (Date.now() >= deadline) return { ...result, timed_out: true };
    // A completed same-version deployment with unchanged timestamp has no provable fresh identity.
    if (result.outcome === 'unverified' && result.runtime_status === 'STARTED' && result.runtime_version === context.requested_version && context.pre_deploy_runtime.version === context.requested_version) return result;
    await sleep(Math.min(Math.max(1, pollIntervalMs), Math.max(1, deadline - Date.now())));
  }
}

export function registerCpiReleaseTools(register, client, { pollIntervalMs } = {}) {
  register('cpi_validate_iflow', 'Validate iFlow configuration',
    'Validate one selected iFlow and its All-option configuration through the documented bodyless POST. HTTP acceptance is distinct from Passed/Failed. Exact confirmation: VALIDATE IFLOW <iflow_id> VERSION <version>.',
    { iflow_id: idSchema, version: cpiVersionSchema, confirmation }, CREATE_ANNOTATIONS, args => validate(client, args));
  register('cpi_save_iflow_version', 'Save retained iFlow version',
    'Save the approved current draft as a retained version, without uploading or deploying. Fresh current-version and bundle-digest preconditions are required. Validate the exact saved version separately. Exact confirmation: SAVE IFLOW VERSION <iflow_id> <version>.',
    { iflow_id: idSchema, version: namedVersion, expected_current_version: namedVersion, expected_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/), confirmation }, CREATE_ANNOTATIONS, args => saveVersion(client, args));
  register('cpi_deploy_iflow', 'Deploy selected iFlow version',
    'Deploy active or an exact retained version once. Report build/task and fresh requested-version runtime evidence separately; prior STARTED state is not success. Zero wait initiates without polling. Continue by task ID, never redeploy on timeout. Exact confirmation: DEPLOY IFLOW <iflow_id>.',
    { iflow_id: idSchema, version: cpiVersionSchema, wait_seconds: waitSchema, confirmation }, CREATE_ANNOTATIONS,
    args => { requireConfirmation(args.confirmation, `DEPLOY IFLOW ${args.iflow_id}`); return deployCpiArtifact(client, { ...args, artifact_id: args.iflow_id }, { pollIntervalMs }); });
  register('cpi_deploy_artifact', 'Deploy selected shared CPI artifact version',
    'Deploy a selected value mapping, script collection or message mapping once. Require fresh exact-version runtime evidence, not an already STARTED artifact. Zero wait does not poll. Exact confirmation: DEPLOY ARTIFACT <artifact_id>.',
    { type: z.enum(Object.keys(artifactTypes)), artifact_id: idSchema, version: cpiVersionSchema, wait_seconds: waitSchema, confirmation }, CREATE_ANNOTATIONS,
    args => { requireConfirmation(args.confirmation, `DEPLOY ARTIFACT ${args.artifact_id}`); return deployCpiArtifact(client, args, { pollIntervalMs }); });
  register('cpi_get_deployment_task', 'Observe CPI deployment task',
    'Read the documented build task once, optionally with runtime evidence. Same-runtime continuation retains the original pre-deploy baseline. Unknown baselines/versions cannot prove success; no deployment is initiated.',
    { task_id: taskSchema, iflow_id: idSchema.optional(), expected_version: namedVersion.optional() }, READ_ONLY_ANNOTATIONS,
    async ({ task_id, iflow_id, expected_version }) => {
      const cached = tasks.get(client)?.get(task_id);
      if (cached && (iflow_id !== undefined && iflow_id !== cached.artifact_id || expected_version !== undefined && expected_version !== cached.requested_version)) {
        throw new IntegrationError('Deployment task identity/version differs from its recorded request');
      }
      const context = cached ?? { task_id, artifact_id: iflow_id ?? null, iflow_id: iflow_id ?? null, requested_version: expected_version ?? null,
        requested_selector: null, pre_deploy_runtime: null, task_required: true, deployment_accepted: null };
      return observe(client, context, Date.now() + 30000);
    });
}
