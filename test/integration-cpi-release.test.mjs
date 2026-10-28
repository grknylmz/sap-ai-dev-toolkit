import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { IntegrationError } from '../src/integration-http.mjs';
import { deployCpiArtifact } from '../src/cpi-release.mjs';
import { rememberValidation, validationEvidence } from '../src/integration-validation.mjs';
import { buildIflowBundle, readBundle, writeBundle, bundleDigest, strFromU8, strToU8, MANIFEST_PATH, PARAMETERS_PROP, parseProperties, replaceManifestVersion } from '../src/iflow-bundle.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const json = data => ({ status: 200, json: { d: data } });
const config = (ParameterKey, ParameterValue) => ({ ParameterKey, ParameterValue, DataType: 'xsd:string' });
const initialArchive = () => {
  const files = readBundle(buildIflowBundle({ id: 'Orders', name: 'Orders', version: '1.2.3', template: 'https-request-reply-http',
    templateParameters: { sender_path: '/orders', receiver_address: 'https://receiver.example', receiver_method: 'GET', receiver_authentication: 'None', receiver_timeout_ms: 60000 } }));
  files.set('binary/private.bin', new Uint8Array([0, 255, 1, 128]));
  return writeBundle(files);
};
async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/cpi-release-test', CPI_SERVICE_KEY: tenant.serviceKey() }, pollIntervalMs: 1, readBackDelayMs: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cpi-release-behavior', version: '1' });
  await runtime.server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return client;
}
async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, response.content[0].text);
  return JSON.parse(response.content[0].text);
}
function content(state, request) {
  if (!request.path.startsWith('/api/v1/IntegrationDesigntimeArtifacts(')) return;
  const selector = /Version='([^']+)'/.exec(request.path)?.[1];
  const selected = selector === 'active' || selector === state.version ? state : state.retained?.[selector];
  if (!selected) return { status: 404 };
  if (request.path.endsWith('/$value')) return { status: 200, body: Buffer.from(selected.archive) };
  if (request.path.endsWith('/Configurations')) return json({ results: selected.configurations });
  return json({ Id: 'Orders', Name: 'Orders', Version: selected.version });
}
const validateArgs = (version = 'active') => ({ iflow_id: 'Orders', version, confirmation: `VALIDATE IFLOW Orders VERSION ${version}` });
const readinessArgs = { cpi_iflow_ids: ['Orders'] };

for (const replacement of ['failed', 'unknown']) test(`latest ${replacement} validation replaces Passed without a digest change`, async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [config('BusinessValue', 'PRIVATE_CONFIG_VALUE')] };
  let result = 'Checkexecutionresult: Passed';
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/api/v1/ValidateIntegrationDesigntimeArtifact') return { status: 202, body: result };
    if (request.path.startsWith('/api/v1/IntegrationRuntimeArtifacts(')) return { status: 404 };
    return content(state, request);
  });
  const client = await connect(t, tenant);
  const first = await call(client, 'cpi_validate_iflow', validateArgs());
  assert.equal(first.passed, true); assert.equal(first.validation_accepted, true);
  const ready = await call(client, 'integration_check_release_readiness', readinessArgs);
  assert.equal(ready.readiness, 'ready');
  result = replacement === 'failed' ? 'Checkexecutionresult: Failed' + JSON.stringify([{ severity: 'Error', message: 'PRIVATE_CONFIG_VALUE <source/>', sourceObject: 'ComponentMetadataEditor/etype:MessageFlow', resourcePath: 'src/main/resources/scenarioflows/integrationflow', resourceName: 'Orders.iflw' }]) : 'HTTP accepted but validation business result unavailable PRIVATE_CONFIG_VALUE';
  const next = await call(client, 'cpi_validate_iflow', validateArgs());
  assert.equal(next.passed, replacement === 'failed' ? false : null);
  assert.equal(next.state_sha256, first.state_sha256);
  const checked = await call(client, 'integration_check_release_readiness', readinessArgs);
  assert.equal(checked.readiness, replacement === 'failed' ? 'blocked' : 'needs_review');
  assert.equal(checked.items[0].validation.result, replacement);
  assert.doesNotMatch(JSON.stringify([first, next, checked]), /PRIVATE_CONFIG_VALUE|<source\/>|ParameterValue/);
  const posts = tenant.apiRequests().filter(request => request.method === 'POST');
  assert.equal(posts.length, 2); assert.ok(posts.every(request => request.body === ''));
  assert.equal(posts[0].query.get('Id'), "'Orders'"); assert.equal(posts[0].query.get('Version'), "'active'");
});

test('configuration-only changes invalidate successful validation and read-only readiness never validates', async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [config('BusinessValue', 'PRIVATE_ONE')] };
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') return { status: 202, body: 'Checkexecutionresult: Passed' };
    if (request.path.startsWith('/api/v1/IntegrationRuntimeArtifacts(')) return { status: 404 };
    return content(state, request);
  });
  const client = await connect(t, tenant);
  const validated = await call(client, 'cpi_validate_iflow', validateArgs());
  state.configurations[0].ParameterValue = 'PRIVATE_TWO';
  const before = tenant.apiRequests().length;
  const checked = await call(client, 'integration_check_release_readiness', readinessArgs);
  assert.equal(checked.readiness, 'needs_review'); assert.equal(checked.items[0].validation.result, 'state_changed');
  assert.equal(checked.items[0].bundle_sha256, validated.bundle_sha256);
  assert.notEqual(checked.items[0].state_sha256, validated.state_sha256);
  assert.ok(tenant.apiRequests().slice(before).every(request => request.method === 'GET'));
});

test('validation HTTP failures retain status and remove prior successful approval', async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [] };
  let status = 202;
  const tenant = await startFakeTenant(t, request => request.method === 'POST'
    ? { status, body: status === 202 ? 'Checkexecutionresult: Passed' : 'PRIVATE_SOURCE_OR_VALUE' }
    : request.path.startsWith('/api/v1/IntegrationRuntimeArtifacts(') ? { status: 404 } : content(state, request));
  const client = await connect(t, tenant);
  await call(client, 'cpi_validate_iflow', validateArgs());
  for (status of [400, 404]) {
    const result = await call(client, 'cpi_validate_iflow', validateArgs());
    assert.equal(result.validation_accepted, false); assert.equal(result.passed, null); assert.equal(result.source_result.status, status);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE_OR_VALUE/);
    assert.equal((await call(client, 'integration_check_release_readiness', readinessArgs)).readiness, 'needs_review');
  }
});

test('validation is client-bound and expires after fifteen minutes', () => {
  const client = {}; const other = {};
  const state = { id: 'Orders', resolved_version: '1.2.3', state_sha256: 'state', bundle_sha256: 'bundle', passed: true };
  rememberValidation(client, state, 1000);
  assert.equal(validationEvidence(client, state, 1001).result, 'passed');
  assert.equal(validationEvidence(other, state, 1001).result, 'missing');
  assert.equal(validationEvidence(client, { ...state, resolved_version: '1.2.4' }, 1001).result, 'missing');
  assert.equal(validationEvidence(client, state, 901000).result, 'expired');
});

test('draft replacement merges defaults < fresh configuration < overrides and reports reapply failure exactly', async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [config('A', 'PRIVATE_CONFIG_A'), config('B', 'PRIVATE_CONFIG_B'), config('Removed', 'PRIVATE_REMOVED')] };
  const files = readBundle(state.archive); files.set(PARAMETERS_PROP, strToU8('A=PRIVATE_DEFAULT_A\nB=PRIVATE_DEFAULT_B\nC=PRIVATE_DEFAULT_C\nRemoved=PRIVATE_DEFAULT_REMOVED\n')); state.archive = writeBundle(files);
  let uploaded;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'PUT' && request.path.includes('/$links/Configurations')) {
      return request.path.endsWith("('B')") ? { status: 400, body: 'PRIVATE_OVERRIDE_B PRIVATE_CONFIG_B' } : { status: 202 };
    }
    if (request.method === 'PUT') { uploaded = readBundle(Buffer.from(JSON.parse(request.body).ArtifactContent, 'base64')); return { status: 202 }; }
    return content(state, request);
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_update_iflow', { iflow_id: 'Orders', expected_version: '1.2.3', files: [
    { path: 'src/main/resources/notes.txt', content: 'PRIVATE_SOURCE' },
    { path: PARAMETERS_PROP, content: 'A=PRIVATE_DEFAULT_A\nB=PRIVATE_DEFAULT_B\nC=PRIVATE_DEFAULT_C\n' }
  ], parameters: { B: 'PRIVATE_OVERRIDE_B' }, confirmation: 'UPDATE IFLOW Orders' });
  assert.equal(result.content_updated, true); assert.equal(result.outcome, 'partial'); assert.equal(result.retained_version_created, false); assert.equal(result.new_version, '1.2.4');
  assert.deepEqual(result.configuration.updated, ['A']); assert.equal(result.configuration.failed.key, 'B'); assert.equal(result.configuration.failed.status, 400);
  assert.deepEqual(parseProperties(strFromU8(uploaded.get(PARAMETERS_PROP))), { A: 'PRIVATE_CONFIG_A', B: 'PRIVATE_OVERRIDE_B', C: 'PRIVATE_DEFAULT_C' });
  assert.deepEqual(uploaded.get('binary/private.bin'), new Uint8Array([0, 255, 1, 128]));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  const requests = tenant.apiRequests(); const putIndex = requests.findIndex(request => request.method === 'PUT');
  assert.ok(requests.slice(0, putIndex).some(request => request.path.endsWith('/Configurations')));
  assert.equal(requests.filter(request => request.method === 'PUT').length, 3);
  assert.equal(requests.some(request => request.method === 'POST'), false);
});

test('save retained version is bodyless once, verifies exact version and requires fresh validation', async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [config('BusinessValue', 'PRIVATE_VALUE')], retained: {} };
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/api/v1/ValidateIntegrationDesigntimeArtifact') return { status: 202, body: 'Checkexecutionresult: Passed' };
    if (request.path === '/api/v1/IntegrationDesigntimeArtifactSaveAsVersion') {
      state.version = '2.0.0'; const files = readBundle(state.archive);
      files.set(MANIFEST_PATH, strToU8(replaceManifestVersion(strFromU8(files.get(MANIFEST_PATH)), state.version))); state.archive = writeBundle(files);
      return { status: 202 };
    }
    if (request.path.startsWith('/api/v1/IntegrationRuntimeArtifacts(')) return { status: 404 };
    return content(state, request);
  });
  const client = await connect(t, tenant);
  await call(client, 'cpi_validate_iflow', validateArgs());
  const digest = bundleDigest(readBundle(state.archive));
  const saved = await call(client, 'cpi_save_iflow_version', { iflow_id: 'Orders', version: '2.0.0', expected_current_version: '1.2.3', expected_bundle_sha256: digest, confirmation: 'SAVE IFLOW VERSION Orders 2.0.0' });
  assert.equal(saved.saved, true); assert.equal(saved.retained_version_created, true); assert.equal(saved.validation_required, true);
  assert.equal((await call(client, 'integration_check_release_readiness', readinessArgs)).readiness, 'needs_review');
  const validated = await call(client, 'cpi_validate_iflow', validateArgs('2.0.0')); assert.equal(validated.resolved_version, '2.0.0');
  assert.equal((await call(client, 'integration_check_release_readiness', readinessArgs)).readiness, 'ready');
  const posts = tenant.apiRequests().filter(request => request.path.endsWith('SaveAsVersion'));
  assert.equal(posts.length, 1); assert.equal(posts[0].body, ''); assert.equal(posts[0].query.get('SaveAsVersion'), "'2.0.0'");
});

for (const mode of ['rejected', 'readback_missing']) test(`save ${mode} preserves partial evidence without repeating POST`, async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [] };
  const tenant = await startFakeTenant(t, request => request.path.endsWith('SaveAsVersion') ? { status: mode === 'rejected' ? 500 : 202, body: 'PRIVATE_SAVE_ERROR' } : content(state, request));
  const client = await connect(t, tenant);
  const saved = await call(client, 'cpi_save_iflow_version', { iflow_id: 'Orders', version: '2.0.0', expected_current_version: '1.2.3', expected_bundle_sha256: bundleDigest(readBundle(state.archive)), confirmation: 'SAVE IFLOW VERSION Orders 2.0.0' });
  assert.equal(saved.saved, false); assert.equal(saved.save_accepted, mode !== 'rejected'); assert.equal(saved.outcome, 'unverified');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1); assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/);
});

test('save existing target and stale current draft never send SaveAsVersion', async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [], retained: { '2.0.0': { version: '2.0.0', archive: initialArchive(), configurations: [] } } };
  const tenant = await startFakeTenant(t, request => content(state, request)); const client = await connect(t, tenant);
  const args = { iflow_id: 'Orders', version: '2.0.0', expected_current_version: '1.2.3', expected_bundle_sha256: bundleDigest(readBundle(state.archive)), confirmation: 'SAVE IFLOW VERSION Orders 2.0.0' };
  for (const input of [args, { ...args, expected_current_version: '1.0.0' }, { ...args, expected_bundle_sha256: '0'.repeat(64) }]) {
    assert.equal((await client.callTool({ name: 'cpi_save_iflow_version', arguments: input })).isError, true);
  }
  assert.ok(tenant.apiRequests().every(request => request.method === 'GET'));
});

for (const buildStatus of ['FAIL', 'FAIL_ON_LICENSE_ERROR']) test(`build ${buildStatus} cannot be overridden by old STARTED runtime`, async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') return { status: 202, body: 'task1' };
    if (request.path.includes('BuildAndDeployStatus')) return json({ TaskId: 'task1', Status: buildStatus });
    if (request.path.includes('IntegrationRuntimeArtifacts')) return json({ Id: 'Orders', Version: '1.0.0', Status: 'STARTED', DeployedOn: '/Date(1000)/' });
    return json({ Id: 'Orders', Version: '1.2.3' });
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_deploy_iflow', { iflow_id: 'Orders', version: '1.2.3', confirmation: 'DEPLOY IFLOW Orders' });
  assert.equal(result.outcome, 'failed'); assert.equal(result.build_status, buildStatus); assert.equal(result.runtime_status, 'STARTED');
  assert.equal(result.requested_version, '1.2.3'); assert.equal(result.pre_deploy_runtime.version, '1.0.0');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
});

test('successful build waits past stale runtime until requested version has fresh identity', async t => {
  let deployed = false; let runtimeReads = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') { deployed = true; return { status: 202, body: 'task2' }; }
    if (request.path.includes('BuildAndDeployStatus')) return json({ TaskId: 'task2', Status: 'SUCCESS' });
    if (request.path.includes('IntegrationRuntimeArtifacts')) {
      if (deployed) runtimeReads++;
      return json({ Id: 'Orders', Version: runtimeReads >= 2 ? '1.2.3' : '1.0.0', Status: 'STARTED', DeployedOn: `/Date(${runtimeReads >= 2 ? 2000 : 1000})/` });
    }
    return json({ Id: 'Orders', Version: '1.2.3' });
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_deploy_iflow', { iflow_id: 'Orders', version: '1.2.3', confirmation: 'DEPLOY IFLOW Orders' });
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.runtime_version, '1.2.3'); assert.equal(result.deployed_on, '1970-01-01T00:00:02.000Z');
  assert.equal(runtimeReads, 2); assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
});

test('same-version redeployment needs a changed timestamp; task continuation never redeploys', async t => {
  let timestamp = 1000;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') return { status: 202, body: 'task3' };
    if (request.path.includes('BuildAndDeployStatus')) return json({ TaskId: 'task3', Status: 'SUCCESS' });
    if (request.path.includes('IntegrationRuntimeArtifacts')) return json({ Id: 'Orders', Version: '1.2.3', Status: 'STARTED', DeployedOn: `/Date(${timestamp})/` });
    return json({ Id: 'Orders', Version: '1.2.3' });
  });
  const client = await connect(t, tenant);
  const first = await call(client, 'cpi_deploy_iflow', { iflow_id: 'Orders', confirmation: 'DEPLOY IFLOW Orders' });
  assert.equal(first.outcome, 'unverified'); timestamp = 2000;
  const next = await call(client, 'cpi_get_deployment_task', { task_id: 'task3', iflow_id: 'Orders', expected_version: '1.2.3' });
  assert.equal(next.outcome, 'succeeded'); assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
  const before = tenant.requests.length;
  assert.equal((await client.callTool({ name: 'cpi_get_deployment_task', arguments: { task_id: 'task3', iflow_id: 'Other' } })).isError, true);
  assert.equal(tenant.requests.length, before);
});

test('zero wait initiates once without post-polling, unknown task status remains unverified', async t => {
  const tenant = await startFakeTenant(t, request => request.method === 'POST' ? { status: 202, body: 'task4' }
    : request.path.includes('BuildAndDeployStatus') ? json({ TaskId: 'task4', Status: 'NEW_UNKNOWN_STATE' })
      : request.path.includes('IntegrationRuntimeArtifacts') ? { status: 404 } : json({ Id: 'Orders', Version: '1.2.3' }));
  const client = await connect(t, tenant);
  const first = await call(client, 'cpi_deploy_iflow', { iflow_id: 'Orders', wait_seconds: 0, confirmation: 'DEPLOY IFLOW Orders' });
  assert.equal(first.outcome, 'pending'); assert.equal(first.task_id, 'task4'); assert.equal(tenant.apiRequests().at(-1).method, 'POST');
  assert.equal(tenant.apiRequests().some(request => request.path.includes('BuildAndDeployStatus')), false);
  const next = await call(client, 'cpi_get_deployment_task', { task_id: 'task4' });
  assert.equal(next.build_status, 'NEW_UNKNOWN_STATE'); assert.equal(next.outcome, 'unverified');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
});

test('absolute observation deadline retains accepted task and does not retry deployment', async () => {
  const requests = [];
  const client = { request: async (method, path, options) => {
    requests.push({ method, path, deadline: options.deadline });
    if (method === 'POST') return { status: 202, data: 'deadline-task' };
    if (path.includes('BuildAndDeployStatus')) throw new IntegrationError('deadline', { code: 'INTEGRATION_DEADLINE' });
    if (path.includes('IntegrationRuntimeArtifacts')) return { status: 404, data: null };
    return { Id: 'Orders', Version: '1.2.3' };
  } };
  const result = await deployCpiArtifact(client, { artifact_id: 'Orders', version: '1.2.3', wait_seconds: 1 }, { pollIntervalMs: 1 });
  assert.equal(result.deployment_accepted, true); assert.equal(result.task_id, 'deadline-task'); assert.equal(result.timed_out, true); assert.equal(result.outcome, 'pending');
  assert.equal(new Set(requests.map(request => request.deadline)).size, 1); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
});

for (const type of ['value_mapping', 'script_collection', 'message_mapping']) test(`${type} deployment never accepts unchanged prior runtime`, async t => {
  const tenant = await startFakeTenant(t, request => request.method === 'POST' ? { status: 202, body: '' }
    : request.path.includes('IntegrationRuntimeArtifacts') ? json({ Id: 'Orders', Version: '1.2.3', Status: 'STARTED', DeployedOn: '/Date(1000)/' }) : json({ Id: 'Orders', Version: '1.2.3' }));
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_deploy_artifact', { type, artifact_id: 'Orders', confirmation: 'DEPLOY ARTIFACT Orders' });
  assert.equal(result.outcome, 'unverified'); assert.equal(result.requested_version, '1.2.3');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
});

test('all release confirmations and invalid versions fail before token or tenant requests', async t => {
  const tenant = await startFakeTenant(t); const client = await connect(t, tenant);
  const inputs = [
    ['cpi_validate_iflow', { iflow_id: 'Orders', confirmation: 'wrong' }],
    ['cpi_save_iflow_version', { iflow_id: 'Orders', version: '2.0.0', expected_current_version: '1.2.3', expected_bundle_sha256: 'a'.repeat(64), confirmation: 'wrong' }],
    ['cpi_deploy_iflow', { iflow_id: 'Orders', confirmation: 'wrong' }],
    ['cpi_deploy_artifact', { type: 'value_mapping', artifact_id: 'Orders', confirmation: 'wrong' }],
    ['cpi_deploy_iflow', { iflow_id: 'Orders', version: 'latest', confirmation: 'DEPLOY IFLOW Orders' }]
  ];
  for (const [name, args] of inputs) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  assert.equal(tenant.requests.length, 0);
});

test('fresh tenant-only configured keys survive draft replacement without changing name-only output', async t => {
  const state = { version: '1.2.3', archive: initialArchive(), configurations: [config('TenantOnly', 'PRIVATE_TENANT_VALUE')] };
  let uploaded; const writes = [];
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'PUT' && request.path.includes('/$links/Configurations')) { writes.push(JSON.parse(request.body)); return { status: 202 }; }
    if (request.method === 'PUT') { uploaded = readBundle(Buffer.from(JSON.parse(request.body).ArtifactContent, 'base64')); return { status: 202 }; }
    return content(state, request);
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_update_iflow', { iflow_id: 'Orders', expected_version: '1.2.3', files: [{ path: 'src/main/resources/file.txt', content: 'replacement' }], confirmation: 'UPDATE IFLOW Orders' });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(parseProperties(strFromU8(uploaded.get(PARAMETERS_PROP))).TenantOnly, 'PRIVATE_TENANT_VALUE');
  assert.equal(writes[0].ParameterValue, 'PRIVATE_TENANT_VALUE');
  assert.ok(!result.parameter_names.source_defaults.includes('TenantOnly'));
  assert.ok(result.parameter_names.configured.includes('TenantOnly'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TENANT_VALUE|ParameterValue/);
});

test('shared-artifact deployment verifies a fresh exact-version runtime even without a task body', async t => {
  let deployed = false;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') { deployed = true; return { status: 202 }; }
    if (request.path.includes('IntegrationRuntimeArtifacts')) return json({ Id: 'Orders', Version: '1.2.3', Status: 'STARTED', DeployedOn: `/Date(${deployed ? 2000 : 1000})/` });
    return json({ Id: 'Orders', Version: '1.2.3' });
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_deploy_artifact', { type: 'value_mapping', artifact_id: 'Orders', version: '1.2.3', confirmation: 'DEPLOY ARTIFACT Orders' });
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.task_id, null); assert.equal(result.deployed_on, '1970-01-01T00:00:02.000Z');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1);
});

test('accepted deployment remains accepted when its response exceeds the transport cap', async t => {
  const tenant = await startFakeTenant(t, request => request.method === 'POST'
    ? { status: 202, body: 'PRIVATE_RESPONSE', headers: { 'content-length': String(3 * 1024 * 1024) } }
    : request.path.includes('IntegrationRuntimeArtifacts') ? { status: 404 } : json({ Id: 'Orders', Version: '1.2.3' }));
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_deploy_iflow', { iflow_id: 'Orders', confirmation: 'DEPLOY IFLOW Orders' });
  assert.equal(result.deployment_accepted, true); assert.equal(result.source_result.status, 202); assert.equal(result.outcome, 'unverified');
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RESPONSE/);
});
