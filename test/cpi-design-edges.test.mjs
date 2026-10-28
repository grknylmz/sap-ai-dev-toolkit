import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strToU8, zipSync } from 'fflate';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const notFound = { status: 404, json: { error: { message: { value: 'not found' } } } };
const collection = (results, metadata = {}) => ({ status: 200, json: { d: { results, ...metadata } } });
const entity = value => ({ status: 200, json: { d: value } });
const archive = files => ({ status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(zipSync(files)) });

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: {
    XDG_CONFIG_HOME: '/nonexistent/cpi-design-edges', CPI_SERVICE_KEY: tenant.serviceKey()
  }, pollIntervalMs: 1, readBackDelayMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cpi-design-edges', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close().catch(() => {}); await runtime.close(); });
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: result.content[0].text };
}
function parsed(result) {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
}
function failure(result, pattern) {
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, pattern);
}

test('cpi_get_iflow selects retained content, separates configured values, and enforces exact UTF-8 file boundaries', async t => {
  let text = 'x'.repeat(48 * 1024);
  let malformed = false;
  let denied = false;
  const path = "/api/v1/IntegrationDesigntimeArtifacts(Id='Z_Flow',Version='2.3.4')";
  const tenant = await startFakeTenant(t, request => {
    if (denied) return { status: 403, json: { error: { message: { value: 'design access denied' } } } };
    if (request.path === `${path}/$value`) return malformed
      ? { status: 200, body: 'not a zip' }
      : archive({ 'resource.xml': strToU8(text), 'resource.bin': Uint8Array.of(0, 255, 128, 1) });
    if (request.path === `${path}/Configurations`) return collection([{ ParameterKey: 'Receiver', ParameterValue: 'configured-not-default', DataType: 'xsd:string' }]);
    if (request.path === path) return entity({ Id: 'Z_Flow', Version: '2.3.4', ArtifactContent: 'must-not-duplicate-archive', __metadata: { uri: 'private' } });
    return notFound;
  });
  const client = await connect(t, tenant);
  const args = { iflow_id: 'Z_Flow', version: '2.3.4' };
  const exact = parsed(await call(client, 'cpi_get_iflow', args));
  assert.equal(exact.files[0].text, text);
  assert.equal(exact.files[0].truncated, undefined);
  assert.deepEqual(exact.files[1], { path: 'resource.bin', bytes: 4 });
  assert.deepEqual(exact.configurations, [{ ParameterKey: 'Receiver', ParameterValue: 'configured-not-default', DataType: 'xsd:string' }]);
  assert.equal(exact.artifact.ArtifactContent, undefined);
  assert.equal(exact.artifact.__metadata, undefined);

  text = `${'x'.repeat(48 * 1024 - 1)}€`;
  const capped = parsed(await call(client, 'cpi_get_iflow', args)).files[0];
  assert.equal(capped.bytes, 48 * 1024 + 2);
  assert.equal(capped.text, 'x'.repeat(48 * 1024 - 1));
  assert.equal(capped.truncated, true);
  text = 'x'.repeat(90 * 1024);
  const before = tenant.apiRequests().length;
  const single = parsed(await call(client, 'cpi_get_iflow', { ...args, file_path: 'resource.xml' }));
  assert.equal(single.file.text, text);
  assert.equal(single.file.truncated, undefined);
  assert.equal(tenant.apiRequests().slice(before).some(request => request.path.endsWith('/Configurations')), false);
  text += '€';
  const over = parsed(await call(client, 'cpi_get_iflow', { ...args, file_path: 'resource.xml' })).file;
  assert.equal(Buffer.byteLength(over.text), 90 * 1024);
  assert.equal(over.truncated, true);
  failure(await call(client, 'cpi_get_iflow', { ...args, file_path: 'absent.xml' }), /file_path not found/);
  malformed = true;
  failure(await call(client, 'cpi_get_iflow', args), /bundle|archive|ZIP/i);
  denied = true;
  const deniedBefore = tenant.apiRequests().length;
  failure(await call(client, 'cpi_get_iflow', args), /HTTP 403/);
  assert.equal(tenant.apiRequests().length, deniedBefore + 1);
  assert.ok(tenant.apiRequests().every(request => request.path.startsWith(path)));
});

for (const [type, set] of [
  ['value_mapping', 'ValueMappingDesigntimeArtifacts'],
  ['script_collection', 'ScriptCollectionDesigntimeArtifacts'],
  ['message_mapping', 'MessageMappingDesigntimeArtifacts']
]) {
  test(`cpi_get_artifact reads ${type} retained source and distinguishes absent members from corrupt archives`, async t => {
    let corrupt = false;
    let content = '<mapping>business transformation</mapping>';
    const path = `/api/v1/${set}(Id='Z_Content',Version='1.2.3')`;
    const tenant = await startFakeTenant(t, request => {
      if (request.path === `${path}/$value`) return corrupt
        ? { status: 200, body: 'invalid archive' }
        : archive({ 'mapping.xml': strToU8(content), 'binary.dat': Uint8Array.of(255, 0, 3) });
      return request.path === path ? entity({ Id: 'Z_Content', Version: '1.2.3', ArtifactContent: 'omit' }) : notFound;
    });
    const client = await connect(t, tenant);
    const args = { type, artifact_id: 'Z_Content', version: '1.2.3' };
    const result = parsed(await call(client, 'cpi_get_artifact', args));
    assert.deepEqual(result.files, [
      { path: 'mapping.xml', bytes: 42, text: '<mapping>business transformation</mapping>' },
      { path: 'binary.dat', bytes: 3 }
    ]);
    assert.equal(result.artifact.ArtifactContent, undefined);
    assert.deepEqual(parsed(await call(client, 'cpi_get_artifact', { ...args, file_path: 'binary.dat' })).file,
      { path: 'binary.dat', bytes: 3 });
    content = `${'x'.repeat(90 * 1024)}€`;
    const cappedSingle = parsed(await call(client, 'cpi_get_artifact', { ...args, file_path: 'mapping.xml' })).file;
    assert.equal(cappedSingle.bytes, 90 * 1024 + 3);
    assert.equal(cappedSingle.text, 'x'.repeat(90 * 1024));
    assert.equal(cappedSingle.truncated, true);
    const cappedList = parsed(await call(client, 'cpi_get_artifact', args)).files[0];
    assert.equal(cappedList.text, 'x'.repeat(48 * 1024));
    assert.equal(cappedList.truncated, true);
    failure(await call(client, 'cpi_get_artifact', { ...args, file_path: 'absent.xml' }), /file_path not found/);
    corrupt = true;
    failure(await call(client, 'cpi_get_artifact', args), /bundle|archive|ZIP/i);
    assert.ok(tenant.apiRequests().every(request => request.path === path || request.path === `${path}/$value`));
  });
}

test('cpi_get_value_mappings preserves authoring values/defaults and does not invent exhaustive nested results', async t => {
  let large = false;
  let malformed = false;
  const schema = { SrcAgency: "O'Neil", SrcId: 'Plant', TgtAgency: 'ERP', TgtId: 'Site', State: 'configured' };
  const value = index => ({ Id: String(index), Value: { SrcValue: `source-${index}`, TgtValue: `target-${index}` } });
  const path = "/api/v1/ValueMappingDesigntimeArtifacts(Id='Z_VM',Version='3.2.1')";
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${path}/ValMapSchema`) return malformed ? entity({ wrong: [] })
      : collection([schema], large ? { __count: '22', __next: 'do-not-follow-unverified-schema-navigation' } : {});
    if (request.path.endsWith('/DefaultValMaps')) return collection(large ? Array.from({ length: 501 }, (_, i) => value(i)) : [value('default')], large ? { __count: '900', __next: 'do-not-follow-default-navigation' } : {});
    if (request.path.endsWith('/ValMaps')) return collection(large ? Array.from({ length: 501 }, (_, i) => value(i)) : [value('A')], large ? { __count: '700', __next: 'do-not-follow-value-navigation' } : {});
    return notFound;
  });
  const client = await connect(t, tenant);
  const args = { artifact_id: 'Z_VM', version: '3.2.1' };
  const result = parsed(await call(client, 'cpi_get_value_mappings', args));
  const pair = result.agency_pairs.items[0];
  assert.deepEqual(pair.values.items, [{ Id: 'A', SrcValue: 'source-A', TgtValue: 'target-A' }]);
  assert.deepEqual(pair.default_values.items, [{ Id: 'default', SrcValue: 'source-default', TgtValue: 'target-default' }]);
  for (const page of [result.agency_pairs, pair.values, pair.default_values]) {
    assert.equal(page.total, null);
    assert.equal(page.complete, false);
    assert.equal(page.stop_reason, 'source_limit');
    assert.equal(page.next_cursor, null);
  }
  assert.ok(tenant.apiRequests()[1].path.includes("SrcAgency='O''Neil'"));
  large = true;
  const before = tenant.apiRequests().length;
  const response = await call(client, 'cpi_get_value_mappings', args);
  const bounded = parsed(response);
  assert.ok(Buffer.byteLength(response.text) < 96 * 1024);
  assert.equal(bounded.agency_pairs.total, 22);
  for (const [name, total] of [['values', 700], ['default_values', 900]]) {
    const page = bounded.agency_pairs.items[0][name];
    assert.equal(page.total, total);
    assert.ok(page.returned > 0 && page.returned <= 500);
    assert.equal(page.items.length, page.returned);
    assert.equal(page.complete, false);
    assert.equal(page.next_cursor, null);
  }
  assert.equal(tenant.apiRequests().length, before + 3);
  malformed = true;
  failure(await call(client, 'cpi_get_value_mappings', args), /Expected a collection response/);
});

test('cpi_update_package preserves omitted metadata, permits explicit clearing, and never writes missing/no-change requests', async t => {
  let current = { Id: 'ZPKG', Name: 'Original', ShortText: 'Summary', Description: 'Keep details', Version: '4.5.6' };
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') return current ? entity(current) : notFound;
    if (request.method === 'PUT') { current = { ...current, ...JSON.parse(request.body) }; return { status: 204 }; }
    return notFound;
  });
  const client = await connect(t, tenant);
  const args = { package_id: 'ZPKG', confirmation: 'UPDATE CPI PACKAGE ZPKG' };
  const untouched = tenant.requests.length;
  failure(await call(client, 'cpi_update_package', args), /at least one/);
  failure(await call(client, 'cpi_update_package', { ...args, name: 'Changed', confirmation: 'UPDATE CPI PACKAGE OTHER' }), /confirmation must equal/);
  assert.equal(tenant.requests.length, untouched);
  assert.equal(parsed(await call(client, 'cpi_update_package', { ...args, name: 'Changed' })).updated, true);
  assert.deepEqual(current, { Id: 'ZPKG', Name: 'Changed', ShortText: 'Summary', Description: 'Keep details', Version: '4.5.6' });
  parsed(await call(client, 'cpi_update_package', { ...args, description: '' }));
  assert.equal(current.Description, '');
  current = null;
  const writes = tenant.apiRequests().filter(request => request.method === 'PUT').length;
  failure(await call(client, 'cpi_update_package', { ...args, version: '5.0.0' }), /HTTP 404/);
  assert.equal(tenant.apiRequests().filter(request => request.method === 'PUT').length, writes);
});

test('cpi_copy_package distinguishes copied identity, accepted malformed replies and conflicts without replaying the POST', async t => {
  let reply = { status: 201, json: { d: { Id: 'SAP.Standard.Copy', Name: 'Standard.Copy', Version: '1.0.0' } } };
  const tenant = await startFakeTenant(t, () => reply);
  const client = await connect(t, tenant);
  const args = { package_id: 'SAP.Standard', suffix: 'Copy', confirmation: 'COPY CPI PACKAGE SAP.Standard' };
  failure(await call(client, 'cpi_copy_package', { ...args, confirmation: 'COPY CPI PACKAGE OTHER' }), /confirmation must equal/);
  assert.equal(tenant.requests.length, 0);
  const copied = parsed(await call(client, 'cpi_copy_package', args));
  assert.equal(copied.copied, true);
  assert.equal(copied.accepted, true);
  assert.equal(copied.package.Id, 'SAP.Standard.Copy');
  assert.equal(copied.outcome, 'succeeded');
  assert.equal(tenant.apiRequests()[0].query.get('Suffix'), "'Copy'");
  for (const body of ['{bad-json', JSON.stringify({ d: { unrelated: 'not an identity' } }), '']) {
    reply = { status: 200, body };
    const before = tenant.apiRequests().length;
    const accepted = parsed(await call(client, 'cpi_copy_package', args));
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.copied, false);
    assert.equal(accepted.outcome, 'unverified');
    assert.equal(accepted.http_status, 200);
    assert.deepEqual(accepted.package, {});
    assert.equal(tenant.apiRequests().length, before + 1);
  }
  reply = { status: 409, json: { error: { message: { value: 'already exists' } } } };
  const before = tenant.apiRequests().length;
  failure(await call(client, 'cpi_copy_package', args), /HTTP 409.*OVERWRITE_MERGE/);
  assert.equal(tenant.apiRequests().length, before + 1);
  reply = { status: 200, json: { d: { Id: 'SAP.Standard.Copy' } } };
  parsed(await call(client, 'cpi_copy_package', { package_id: 'SAP.Standard', import_mode: 'OVERWRITE_MERGE', confirmation: args.confirmation }));
  assert.equal(tenant.apiRequests().at(-1).query.get('ImportMode'), "'OVERWRITE_MERGE'");
  assert.equal(tenant.apiRequests().at(-1).query.has('Suffix'), false);
});

test('cpi_set_oauth2_client_credential creates, preserves omitted update metadata and withholds escaped reflected secrets', async t => {
  const secret = 'credential-"quoted"\nline-PRIVATE';
  let state;
  let reject = false;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') return state ? entity(state) : notFound;
    if (reject) return { status: 400, json: { error: { message: { value: `Reflected ${request.body}` } } } };
    state = JSON.parse(request.body);
    return { status: request.method === 'POST' ? 201 : 204 };
  });
  const client = await connect(t, tenant);
  const args = { name: 'BACKEND', token_service_url: 'https://identity.example/oauth/token', client_id: 'technical', client_secret: secret, confirmation: 'SET OAUTH2 CLIENT CREDENTIAL BACKEND' };
  failure(await call(client, 'cpi_set_oauth2_client_credential', { ...args, confirmation: 'SET OAUTH2 CLIENT CREDENTIAL OTHER' }), /confirmation must equal/);
  assert.equal(tenant.requests.length, 0);
  const created = parsed(await call(client, 'cpi_set_oauth2_client_credential', { ...args, client_authentication: 'header', scope_content_type: 'json', scope: 'scope-one', resource: 'resource', audience: 'audience', description: 'Keep me' }));
  assert.equal(created.created, true);
  assert.equal(JSON.stringify(created).includes('PRIVATE'), false);
  const updated = parsed(await call(client, 'cpi_set_oauth2_client_credential', { ...args, client_id: 'replacement' }));
  assert.equal(updated.updated, true);
  assert.equal(state.ClientId, 'replacement');
  assert.deepEqual([state.Description, state.ClientAuthentication, state.ScopeContentType, state.Scope, state.Resource, state.Audience],
    ['Keep me', 'header', 'json', 'scope-one', 'resource', 'audience']);
  assert.deepEqual(tenant.apiRequests().map(request => request.method), ['GET', 'POST', 'GET', 'PUT']);
  reject = true;
  const before = tenant.apiRequests().length;
  const failed = await call(client, 'cpi_set_oauth2_client_credential', args);
  failure(failed, /HTTP 400.*withheld/);
  for (const value of [secret, JSON.stringify(secret).slice(1, -1), 'PRIVATE', 'Reflected', 'technical']) assert.equal(failed.text.includes(value), false);
  assert.equal(tenant.apiRequests().length, before + 2);
});

test('cpi_set_number_range handles 14-digit boundaries, preserves the next number and blocks unsafe implicit resets', async t => {
  let state;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'GET') return state ? entity(state) : notFound;
    state = JSON.parse(request.body);
    return { status: request.method === 'POST' ? 201 : 204 };
  });
  const client = await connect(t, tenant);
  const args = { name: 'Orders', min_value: '0', max_value: '99999999999999', confirmation: 'SET NUMBER RANGE Orders' };
  const created = parsed(await call(client, 'cpi_set_number_range', args));
  assert.equal(created.CurrentValue, '0');
  assert.equal(state.MaxValue, '99999999999999');
  state.CurrentValue = '00000000000012';
  state.Description = 'Preserved';
  const updated = parsed(await call(client, 'cpi_set_number_range', { ...args, min_value: 10, field_length: 14, rotate: true }));
  assert.equal(updated.updated, true);
  assert.equal(updated.CurrentValue, '12');
  assert.equal(state.Description, 'Preserved');
  assert.equal(state.Rotate, 'true');
  assert.equal(state.FieldLength, '14');
  const writes = tenant.apiRequests().filter(request => request.method !== 'GET').length;
  failure(await call(client, 'cpi_set_number_range', { ...args, min_value: 20 }), /Current value 12.*pass current_value/);
  assert.equal(tenant.apiRequests().filter(request => request.method !== 'GET').length, writes);
  const before = tenant.requests.length;
  failure(await call(client, 'cpi_set_number_range', { ...args, current_value: '100000000000000' }), /14|Invalid/);
  failure(await call(client, 'cpi_set_number_range', { ...args, min_value: 10, current_value: 9 }), /between min_value and max_value/);
  assert.equal(tenant.requests.length, before);
  assert.equal(parsed(await call(client, 'cpi_set_number_range', { ...args, current_value: '99999999999999' })).CurrentValue, '99999999999999');
});

test('CPI endpoint selection is exact and never exposes URL credentials or query secrets', async t => {
  const tenant = await startFakeTenant(t, () => collection([
    { Name: 'Z_Flow', Id: 'first', EntryPoints: { results: [
      { Url: 'https://runtime.example/http/flow?token=PRIVATE#secret' },
      { Url: 'https://user:password@runtime.example/credential' },
      { Url: 'file:///private' }, { Url: 'not a URL' }
    ] } },
    { Name: 'Other', Id: 'Z_Flow2', EntryPoints: { results: [{ Url: 'https://runtime.example/unrelated' }] } },
    { Name: 'Exact-id', Id: 'Z_Flow', EntryPoints: { results: [{ Url: 'http://runtime.example/exact' }] } }
  ]));
  const client = await connect(t, tenant);
  const response = await call(client, 'cpi_list_service_endpoints', { iflow_id: 'Z_Flow' });
  const result = parsed(response);
  assert.deepEqual(result.items, [
    { name: 'Z_Flow', urls: ['https://runtime.example/http/flow'] },
    { name: 'Exact-id', urls: ['http://runtime.example/exact'] }
  ]);
  assert.doesNotMatch(response.text, /PRIVATE|password|unrelated|credential|secret/);
  assert.equal(parsed(await call(client, 'cpi_list_service_endpoints', { iflow_id: 'Missing' })).returned, 0);
});

test('CPI security and number-range inventories page locally without leaking private fields or masking truncation', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/NumberRanges')) return collection([
      { Name: 'First', CurrentValue: '99999999999999', MaxValue: '99999999999999', DeployedOn: '/Date(0)/', Secret: 'PRIVATE' },
      { Name: 'Second', CurrentValue: '0' }
    ], { __count: '3', __next: 'unverified-remaining-source' });
    if (request.path.endsWith('/OAuth2ClientCredentials')) return collection([
      { Name: 'One', ClientSecret: 'PRIVATE', TokenServiceUrl: 'https://identity.example/?secret=PRIVATE', ClientId: 'PRIVATE', SecurityArtifactDescriptor: { Status: 'DEPLOYED', DeployedOn: '/Date(0)/', Token: 'PRIVATE' } },
      { Name: 'Two', Scope: 'PRIVATE' }
    ]);
    if (request.path.endsWith('/UserCredentials')) return collection([{ Name: 'User', User: 'PRIVATE', Password: 'PRIVATE', SecurityArtifactDescriptor: { Status: 'ERROR' } }]);
    if (request.path.endsWith('/KeystoreEntries')) return collection([{ Alias: 'Cert', ValidNotAfter: '/Date(0)/', PrivateKey: 'PRIVATE', SubjectDN: 'PRIVATE' }]);
    return notFound;
  });
  const client = await connect(t, tenant);
  const first = parsed(await call(client, 'cpi_list_number_ranges', { top: 1 }));
  assert.equal(first.items[0].CurrentValue, '99999999999999');
  assert.equal(first.items[0].DeployedOn, '1970-01-01T00:00:00.000Z');
  assert.equal(first.total, 3);
  assert.equal(first.complete, false);
  const second = parsed(await call(client, 'cpi_list_number_ranges', { top: 1, cursor: first.next_cursor }));
  assert.equal(second.items[0].Name, 'Second');
  assert.equal(second.complete, false);
  assert.equal(second.stop_reason, 'source_limit');
  assert.equal(second.next_cursor, null);
  const oauth = parsed(await call(client, 'cpi_list_security_material', { kind: 'oauth2_client_credentials', top: 1 }));
  assert.equal(oauth.items[0].deployment.Status, 'DEPLOYED');
  assert.equal(oauth.complete, false);
  assert.equal(parsed(await call(client, 'cpi_list_security_material', { kind: 'oauth2_client_credentials', top: 1, cursor: oauth.next_cursor })).items[0].Name, 'Two');
  const user = parsed(await call(client, 'cpi_list_security_material', { kind: 'user_credentials' }));
  assert.equal(user.items[0].deployment.Status, 'ERROR');
  const cert = parsed(await call(client, 'cpi_list_security_material', { kind: 'keystore_entries', keystore: 'KeyRenewal' }));
  assert.equal(cert.items[0].ValidNotAfter, '1970-01-01T00:00:00.000Z');
  assert.equal(tenant.apiRequests().at(-1).query.get('keystoreName'), 'KeyRenewal');
  for (const result of [first, second, oauth, user, cert]) assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.ok(tenant.apiRequests().every(request => !request.query.has('$top') && !request.query.has('$skip')));
});

test('CPI package creation, configuration progress and absent/unknown runtime states retain actual outcomes', async t => {
  let packageExists = false;
  let deployed = false;
  const applied = [];
  const tenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/IntegrationPackages')) {
      if (packageExists) return { status: 409, json: { error: { message: { value: 'duplicate package' } } } };
      packageExists = true;
      return { status: 201 };
    }
    if (request.method === 'PUT') {
      if (request.path.endsWith("Configurations('Second')")) return { status: 400, json: { error: { message: { value: `PRIVATE ${request.body}` } } } };
      applied.push(request.path);
      return { status: 204 };
    }
    return deployed ? entity({ Id: 'Z_Flow', Status: 'NEW_VENDOR_STATE', Version: '1.0.0' }) : notFound;
  });
  const client = await connect(t, tenant);
  const create = { package_id: 'ZPKG', name: 'Package', short_text: 'Package', confirmation: 'CREATE CPI PACKAGE ZPKG' };
  failure(await call(client, 'cpi_create_package', { ...create, confirmation: 'CREATE CPI PACKAGE OTHER' }), /confirmation must equal/);
  assert.equal(tenant.requests.length, 0);
  assert.equal(parsed(await call(client, 'cpi_create_package', create)).created, true);
  failure(await call(client, 'cpi_create_package', create), /HTTP 409/);
  assert.equal(tenant.apiRequests().filter(request => request.method === 'POST').length, 2);
  const progress = await call(client, 'cpi_update_iflow_configuration', {
    iflow_id: 'Z_Flow', parameters: ['First', 'Second', 'Third'].map(key => ({ key, value: 'PRIVATE' })), confirmation: 'CONFIGURE IFLOW Z_Flow'
  });
  const configured = parsed(progress);
  assert.deepEqual(configured.updated, ['First']);
  assert.equal(configured.failed.key, 'Second');
  assert.equal(configured.failed.status, 400);
  assert.equal(progress.text.includes('PRIVATE'), false);
  assert.equal(applied.length, 1);
  assert.equal(tenant.apiRequests().filter(request => request.method === 'PUT').length, 2);
  assert.equal(parsed(await call(client, 'cpi_get_iflow_runtime_status', { iflow_id: 'Z_Flow' })).deployed, false);
  deployed = true;
  const unknown = parsed(await call(client, 'cpi_get_iflow_runtime_status', { iflow_id: 'Z_Flow' }));
  assert.equal(unknown.deployed, true);
  assert.equal(unknown.Status, 'NEW_VENDOR_STATE');
  assert.equal(unknown.error_information, undefined);
  assert.equal(tenant.apiRequests().some(request => request.path.includes('ErrorInformation')), false);
});

test('cpi_upsert_value_mappings applies approved business mappings once and rejects confirmation before authentication', async t => {
  const mappings = new Map();
  const tenant = await startFakeTenant(t, request => {
    if (request.method !== 'POST' || request.path !== '/api/v1/UpsertValMaps') return notFound;
    mappings.set(request.query.get('SrcValue'), request.query.get('TgtValue'));
    return { status: 204 };
  });
  const client = await connect(t, tenant);
  const pair = { src_agency: 'ERP', src_identifier: 'Plant', tgt_agency: 'Network', tgt_identifier: 'Site', src_value: "O'Neil", tgt_value: 'Target' };
  const args = { artifact_id: 'Z_VM', pairs: [pair], confirmation: 'UPDATE VALUE MAPPING Z_VM' };
  failure(await call(client, 'cpi_upsert_value_mappings', { ...args, confirmation: 'UPDATE VALUE MAPPING OTHER' }), /confirmation must equal/);
  assert.equal(tenant.requests.length, 0);
  const result = parsed(await call(client, 'cpi_upsert_value_mappings', args));
  assert.equal(result.upserted, 1);
  assert.equal(result.failed, null);
  assert.equal(mappings.get("'O''Neil'"), "'Target'");
  assert.equal(tenant.apiRequests().length, 1);
  parsed(await call(client, 'cpi_upsert_value_mappings', { ...args, pairs: [{ ...pair, tgt_value: 'Replacement' }] }));
  assert.equal(mappings.get("'O''Neil'"), "'Replacement'");
  assert.equal(mappings.size, 1);
  assert.equal(tenant.apiRequests().length, 2);
});
