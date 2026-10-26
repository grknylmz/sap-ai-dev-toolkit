import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', CPI_SERVICE_KEY: tenant.serviceKey() }, pollIntervalMs: 1, readBackDelayMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cpi-tools-test-client', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await runtime.close();
  });
  return client;
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return { isError: response.isError === true, text: response.content[0].text };
}

function parsed(result) {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
}

const notFound = { status: 404, json: { error: { message: { value: 'not found' } } } };
const decoded = request => decodeURIComponent(request.rawQuery);

test('cpi_undeploy_artifact refuses an artifact that is not deployed', async t => {
  const tenant = await startFakeTenant(t, () => notFound);
  const client = await connect(t, tenant);
  const result = await call(client, 'cpi_undeploy_artifact', { artifact_id: 'Z_VM', confirmation: 'UNDEPLOY ARTIFACT Z_VM' });
  assert.equal(result.text, 'Artifact Z_VM is not deployed');
  assert.equal(tenant.apiRequests().some(request => request.method === 'DELETE'), false);
});

test('cpi_undeploy_artifact deletes the runtime artifact and polls until 404', async t => {
  let deleted = false;
  let pollsAfterDelete = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'DELETE') {
      deleted = true;
      return { status: 202 };
    }
    if (deleted && ++pollsAfterDelete > 2) return notFound;
    return { status: 200, json: { d: { Id: 'Z_VM', Version: '1.0.1', Status: deleted ? 'STOPPING' : 'STARTED' } } };
  });
  const client = await connect(t, tenant);
  const result = parsed(await call(client, 'cpi_undeploy_artifact', { artifact_id: 'Z_VM', confirmation: 'UNDEPLOY ARTIFACT Z_VM' }));
  assert.deepEqual(result, { undeployed: true, artifact_id: 'Z_VM', previous_version: '1.0.1' });
  const requests = tenant.apiRequests();
  assert.equal(requests.find(request => request.method === 'DELETE').path, "/api/v1/IntegrationRuntimeArtifacts('Z_VM')");
  assert.equal(requests.filter(request => request.method === 'GET').length, 4);
});

test('cpi_undeploy_artifact reports timed_out when the artifact stays', async t => {
  const tenant = await startFakeTenant(t, request => (request.method === 'DELETE'
    ? { status: 202 }
    : { status: 200, json: { d: { Id: 'Z_VM', Status: 'STOPPING' } } }));
  const client = await connect(t, tenant);
  const result = parsed(await call(client, 'cpi_undeploy_artifact', { artifact_id: 'Z_VM', wait_seconds: 0, confirmation: 'UNDEPLOY ARTIFACT Z_VM' }));
  assert.equal(result.undeployed, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.runtime_status, 'STOPPING');
});

test('cpi_deploy_artifact calls the function import of the type and returns runtime error text', async t => {
  let runtimeReads = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') return { status: 202, body: '' };
    if (request.path.endsWith('/ErrorInformation/$value')) {
      return { status: 200, json: { message: { messageId: 'SCRIPT_FAILED' }, parameter: ['Script compile error in a.groovy'] } };
    }
    runtimeReads += 1;
    if (runtimeReads === 1) return notFound;
    if (runtimeReads === 2) return { status: 200, json: { d: { Id: 'Z_SC', Status: 'STARTING', Version: '1.0.0' } } };
    return { status: 200, json: { d: { Id: 'Z_SC', Status: 'ERROR', Version: '1.0.0', DeployedOn: '/Date(1700000000000)/' } } };
  });
  const client = await connect(t, tenant);
  const result = parsed(await call(client, 'cpi_deploy_artifact', { type: 'script_collection', artifact_id: 'Z_SC', confirmation: 'DEPLOY ARTIFACT Z_SC' }));
  assert.equal(result.runtime_status, 'ERROR');
  assert.equal(result.runtime_version, '1.0.0');
  assert.equal(result.deployed_on, '2023-11-14T22:13:20.000Z');
  assert.equal(result.error_information, 'SCRIPT_FAILED\nScript compile error in a.groovy');
  assert.equal(result.timed_out, false);
  const post = tenant.apiRequests().find(request => request.method === 'POST');
  assert.equal(post.path, '/api/v1/DeployScriptCollectionDesigntimeArtifact');
  assert.equal(decoded(post), "?Id='Z_SC'&Version='active'");

  for (const [type, functionImport] of [['value_mapping', 'DeployValueMappingDesigntimeArtifact'], ['message_mapping', 'DeployMessageMappingDesigntimeArtifact']]) {
    const before = tenant.apiRequests().length;
    runtimeReads = 5;
    parsed(await call(client, 'cpi_deploy_artifact', { type, artifact_id: 'Z_SC', wait_seconds: 0, confirmation: 'DEPLOY ARTIFACT Z_SC' }));
    assert.equal(tenant.apiRequests()[before].path, `/api/v1/${functionImport}`);
  }
});

test('cpi_upsert_value_mappings quotes query values and stops at the first failure', async t => {
  let posts = 0;
  const tenant = await startFakeTenant(t, () => (++posts === 2
    ? { status: 400, json: { error: { message: { value: 'Agency pair is not configured' } } } }
    : { status: 202 }));
  const client = await connect(t, tenant);
  const pair = { src_agency: 'S4', src_identifier: 'Plant', tgt_agency: 'Ariba', tgt_identifier: 'Site', src_value: "O'Neil", tgt_value: 'ON 1' };
  const result = parsed(await call(client, 'cpi_upsert_value_mappings', {
    artifact_id: 'Z_VM',
    pairs: [pair, { ...pair, src_value: 'B' }, { ...pair, src_value: 'C' }],
    confirmation: 'UPDATE VALUE MAPPING Z_VM'
  }));
  assert.equal(result.upserted, 1);
  assert.equal(result.failed.index, 1);
  assert.match(result.failed.error, /HTTP 400.*Agency pair is not configured/);
  const requests = tenant.apiRequests();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/api/v1/UpsertValMaps');
  assert.equal(decoded(requests[0]),
    "?Id='Z_VM'&Version='active'&SrcAgency='S4'&SrcId='Plant'&TgtAgency='Ariba'&TgtId='Site'&SrcValue='O''Neil'&TgtValue='ON 1'&IsConfigured=true");
  assert.match(requests[0].rawQuery, /TgtValue=%27ON%201%27/);
});

test('cpi_set_user_credential posts when missing, puts when present, and never echoes the password', async t => {
  const password = 'S3cret-Pa55word-xyz';
  let exists = false;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') return exists ? { status: 200, json: { d: { Name: 'BACKEND', Description: 'kept', Password: null } } } : notFound;
    if (request.method === 'POST') return { status: 202 };
    return { status: 400, json: { error: { message: { value: `Invalid credential payload ${request.body}` } } } };
  });
  const client = await connect(t, tenant);
  const args = { name: 'BACKEND', user: 'tech_user', password, confirmation: 'SET USER CREDENTIAL BACKEND' };
  const created = await call(client, 'cpi_set_user_credential', args);
  assert.deepEqual(parsed(created), { created: true, name: 'BACKEND' });
  const post = tenant.apiRequests()[1];
  assert.equal(post.path, '/api/v1/UserCredentials');
  assert.deepEqual(JSON.parse(post.body), { Name: 'BACKEND', Kind: 'default', Description: '', User: 'tech_user', Password: password, CompanyId: '' });

  exists = true;
  const failed = await call(client, 'cpi_set_user_credential', args);
  assert.equal(failed.isError, true);
  assert.match(failed.text, /HTTP 400/);
  assert.equal(failed.text.includes(password), false);
  assert.equal(failed.text.includes(password.slice(0, 6)), false);
  const put = tenant.apiRequests().filter(request => request.method === 'PUT')[0];
  assert.equal(put.path, "/api/v1/UserCredentials('BACKEND')");
  assert.equal(JSON.parse(put.body).Description, 'kept');
  assert.equal(created.text.includes(password), false);

  const before = tenant.requests.length;
  const missingCompany = await call(client, 'cpi_set_user_credential', { ...args, kind: 'successfactors' });
  assert.equal(missingCompany.isError, true);
  assert.match(missingCompany.text, /company_id is required/);
  assert.equal(missingCompany.text.includes(password), false);
  const wrongConfirmation = await call(client, 'cpi_set_user_credential', { ...args, confirmation: 'SET USER CREDENTIAL OTHER' });
  assert.equal(wrongConfirmation.text, 'confirmation must equal SET USER CREDENTIAL BACKEND');
  assert.equal(tenant.requests.length, before);
});

test('cpi_upload_certificate puts the PEM under the hex alias with pkix content type', async t => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  let status = 204;
  const tenant = await startFakeTenant(t, () => ({ status, json: status === 400 ? { error: { message: { value: 'Entry exists' } } } : undefined }));
  const client = await connect(t, tenant);
  const result = parsed(await call(client, 'cpi_upload_certificate', { alias: 'my.cert', certificate: pem, confirmation: 'UPLOAD CERTIFICATE my.cert' }));
  assert.equal(result.hexalias, '6d792e63657274');
  const [put] = tenant.apiRequests();
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, "/api/v1/CertificateResources('6d792e63657274')/$value");
  assert.equal(put.rawQuery, '?fingerprintVerified=true&returnKeystoreEntries=false&update=false');
  assert.equal(put.headers['content-type'], 'application/pkix-cert');
  assert.equal(put.body, pem);

  status = 400;
  const exists = await call(client, 'cpi_upload_certificate', { alias: 'my.cert', certificate: pem, confirmation: 'UPLOAD CERTIFICATE my.cert' });
  assert.equal(exists.text, 'Keystore alias my.cert already exists; pass update: true to replace it');
  status = 200;
  parsed(await call(client, 'cpi_upload_certificate', { alias: 'my.cert', certificate: pem, update: true, confirmation: 'UPLOAD CERTIFICATE my.cert' }));
  assert.match(tenant.apiRequests().at(-1).rawQuery, /update=true$/);
});

test('cpi_set_partner_parameter posts new parameters and puts existing ones', async t => {
  const existing = new Set(["/api/v1/BinaryParameters(Pid='PartnerZ',Id='Z_XSD')"]);
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') return existing.has(request.path) ? { status: 200, json: { d: { Pid: 'PartnerZ' } } } : notFound;
    if (request.method === 'POST') return { status: 201, json: { d: {} } };
    if (request.method === 'PUT') return { status: 204 };
    return { status: 500 };
  });
  const client = await connect(t, tenant);
  assert.deepEqual(parsed(await call(client, 'cpi_set_partner_parameter', {
    pid: 'PartnerZ', id: 'ReceiverAddress', type: 'string', value: 'https://x.example', confirmation: 'SET PARTNER PARAMETER PartnerZ/ReceiverAddress'
  })), { created: true, pid: 'PartnerZ', id: 'ReceiverAddress', type: 'string' });
  assert.deepEqual(parsed(await call(client, 'cpi_set_partner_parameter', {
    pid: 'PartnerZ', id: 'Z_XSD', type: 'binary', value: 'PHg+PC94Pg==', content_type: 'xsd', confirmation: 'SET PARTNER PARAMETER PartnerZ/Z_XSD'
  })).updated, true);
  const writes = tenant.apiRequests().filter(request => request.method !== 'GET');
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].path, '/api/v1/StringParameters');
  assert.deepEqual(JSON.parse(writes[0].body), { Pid: 'PartnerZ', Id: 'ReceiverAddress', Value: 'https://x.example' });
  assert.equal(writes[1].method, 'PUT');
  assert.equal(writes[1].path, "/api/v1/BinaryParameters(Pid='PartnerZ',Id='Z_XSD')");
  assert.deepEqual(JSON.parse(writes[1].body), { Value: 'PHg+PC94Pg==', ContentType: 'xsd' });

  const missingType = await call(client, 'cpi_set_partner_parameter', {
    pid: 'PartnerZ', id: 'Z_XSD', type: 'binary', value: 'PHg+', confirmation: 'SET PARTNER PARAMETER PartnerZ/Z_XSD'
  });
  assert.match(missingType.text, /content_type is required/);
});

test('cpi_list_message_logs sends the custom header query option and id filters', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 200, json: { d: { __count: '1', results: [{ MessageGuid: 'g1', Status: 'FAILED' }] } } }));
  const client = await connect(t, tenant);
  const result = parsed(await call(client, 'cpi_list_message_logs', {
    correlation_id: 'corr-1',
    custom_header: { name: 'po_number', value: "12'5" },
    top: 5
  }));
  assert.equal(result.total, 1);
  const [request] = tenant.apiRequests();
  assert.equal(request.query.get('filterCustomHeaderProperties'), "'po_number' eq '12''5'");
  assert.equal(request.query.get('$filter'), "CorrelationId eq 'corr-1'");
  assert.doesNotMatch(request.rawQuery, /\+/);
});

test('cpi_update_script_collection writes the script into the bundle and keeps other files', async t => {
  const bundle = zipSync({
    'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\r\nBundle-Version: 1.0.2\r\n'),
    'src/main/resources/script/old.groovy': strToU8('old'),
    'src/main/resources/script/keep.groovy': strToU8('keep')
  });
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET' && request.path.endsWith('/$value')) return { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(bundle) };
    if (request.method === 'GET') return { status: 200, json: { d: { Id: 'Z_SC', Version: '1.0.2', Name: 'Scripts' } } };
    if (request.method === 'PUT') return { status: 200, json: { d: {} } };
    return { status: 500 };
  });
  const client = await connect(t, tenant);
  const stale = await call(client, 'cpi_update_script_collection', {
    artifact_id: 'Z_SC', expected_version: '1.0.1', files: [{ name: 'old.groovy', content: 'x' }], confirmation: 'UPDATE SCRIPT COLLECTION Z_SC'
  });
  assert.match(stale.text, /is at version 1\.0\.2, not 1\.0\.1/);
  assert.equal(tenant.apiRequests().some(request => request.method === 'PUT'), false);

  const result = parsed(await call(client, 'cpi_update_script_collection', {
    artifact_id: 'Z_SC',
    expected_version: '1.0.2',
    files: [{ name: 'old.groovy', content: 'new body' }, { name: 'added.js', content: 'var a;' }],
    confirmation: 'UPDATE SCRIPT COLLECTION Z_SC'
  }));
  assert.deepEqual(result.changed_files, ['src/main/resources/script/old.groovy', 'src/main/resources/script/added.js']);
  const put = tenant.apiRequests().find(request => request.method === 'PUT');
  assert.equal(put.path, "/api/v1/ScriptCollectionDesigntimeArtifacts(Id='Z_SC',Version='active')");
  const body = JSON.parse(put.body);
  assert.equal(body.Name, 'Scripts');
  const files = unzipSync(Buffer.from(body.ArtifactContent, 'base64'));
  assert.equal(strFromU8(files['src/main/resources/script/old.groovy']), 'new body');
  assert.equal(strFromU8(files['src/main/resources/script/added.js']), 'var a;');
  assert.equal(strFromU8(files['src/main/resources/script/keep.groovy']), 'keep');
  assert.match(strFromU8(files['META-INF/MANIFEST.MF']), /Bundle-Version: 1\.0\.2/);
});
