import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, chmod, symlink, unlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { registerIntegrationReleaseTools } from '../src/integration-release-store.mjs';
import { integrationCredentialsPath } from '../src/integration-credentials.mjs';
import { readBundle, bundleDigest } from '../src/iflow-bundle.mjs';
import { canonicalJson, canonicalDigest, stateDigest } from '../src/integration-state.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const zip = (value = 'original') => zipSync({
  'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\r\nBundle-SymbolicName: FlowOne\r\nBundle-Version: 1.0.0\r\n'),
  'src/main/resources/parameters.prop': strToU8('Receiver=PRIVATE_DEFAULT\n'),
  'src/main/resources/scenarioflows/integrationflow/FlowOne.iflw': strToU8(`<definitions>${value}</definitions>`),
  'src/main/resources/binary.bin': Uint8Array.of(0, 255, 128, 1, 13, 10)
});
const proxyZip = (value = 'original') => zipSync({
  'APIProxy/ProxyOne.xml': strToU8('<APIProxy><name>ProxyOne</name><policies/></APIProxy>'),
  'APIProxy/APIProxyEndPoint/default.xml': strToU8('<ProxyEndPoint><name>default</name><base_path>/proxy</base_path></ProxyEndPoint>'),
  'APIProxy/FileResource/binary.bin': Uint8Array.of(0, 255, 128),
  'APIProxy/FileResource/source.js': strToU8(value)
});
const configuration = () => [{ ParameterKey: 'Receiver', ParameterValue: 'PRIVATE_CONFIGURED', DataType: 'xsd:string' }];
const cpiTarget = { kind: 'cpi_iflow', id: 'FlowOne' };
const apimTarget = { kind: 'apim_proxy', id: 'ProxyOne' };
const notFound = { status: 404, json: { error: { message: { value: 'not found' } } } };
function fakeState(overrides = {}) {
  return { bytes: zip(), configs: configuration(), name: 'Saved display name', draftVersion: '1.0.0', proxy: proxyZip(), failConfig: false, ignoreImport: false, resetConfigsOnPut: true, ...overrides };
}
function routes(state) {
  return request => {
    const path = decodeURIComponent(request.path);
    if (path === '/api/v1') return { status: 200, body: '', headers: { 'x-csrf-token': 'fixture-csrf' } };
    if (path.startsWith('/api/v1/IntegrationDesigntimeArtifacts(')) {
      if (!path.includes("Id='FlowOne'")) return notFound;
      if (request.method === 'PUT' && path.includes('/$links/Configurations(')) {
        if (state.failConfig) return { status: 400, json: { error: { message: { value: 'PRIVATE_CONFIGURED PRIVATE_TENANT_ERROR' } } } };
        const key = path.match(/Configurations\('([^']+)'\)/)[1];
        const body = JSON.parse(request.body);
        state.configs = state.configs.filter(row => row.ParameterKey !== key).concat({ ParameterKey: key, ...body });
        return { status: 204 };
      }
      if (request.method === 'PUT') {
        const body = JSON.parse(request.body);
        state.bytes = Buffer.from(body.ArtifactContent, 'base64');
        state.name = body.Name;
        if (state.resetConfigsOnPut) state.configs = [];
        return state.putReply ?? { status: 204 };
      }
      if (path.endsWith('/$value')) return { status: 200, body: Buffer.from(state.bytes), headers: { 'content-type': 'application/zip' } };
      if (path.endsWith('/Configurations')) return { status: 200, json: { d: { results: state.configs } } };
      const selected = path.match(/Version='([^']+)'/)[1];
      return { status: 200, json: { d: { Id: 'FlowOne', Name: state.name, Version: selected === 'active' ? state.draftVersion : selected } } };
    }
    if (path === "/apiportal/api/1.0/Management.svc/APIProxies('ProxyOne')") return { status: 200, json: { d: {
      name: 'ProxyOne', state: 'DEPLOYED', version: '1', proxyEndPoints: [{ base_path: '/proxy', virtualhosts: [{ virtual_host: 'runtime.example', isSSL: true }] }]
    } } };
    if (path === '/apiportal/api/1.0/Transport.svc/APIProxies') {
      if (request.method === 'POST') {
        if (!state.ignoreImport) state.proxy = Buffer.from(request.body, 'base64');
        return { status: 201 };
      }
      return { status: 200, body: Buffer.from(state.proxy), headers: { 'content-type': 'application/zip' } };
    }
    return notFound;
  };
}
async function connect(t, state = fakeState(), options = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'integration-release-'));
  if (!options.home) t.after(() => rm(home, { recursive: true, force: true }));
  const tenant = options.tenant ?? await startFakeTenant(t, routes(state));
  const env = { XDG_CONFIG_HOME: home, CPI_SERVICE_KEY: tenant.serviceKey(), APIM_SERVICE_KEY: tenant.serviceKey() };
  const runtime = createIntegrationServer({ env, readBackDelayMs: 0, pollIntervalMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-release-test', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close().catch(() => {}); await runtime.close(); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, response.content[0].text);
    assert.ok(Buffer.byteLength(response.content[0].text) < 96 * 1024);
    assert.ok(!response.content[0].text.includes('PRIVATE_'), response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const rejects = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, response.content[0].text);
    assert.ok(!response.content[0].text.includes('PRIVATE_'));
    return response;
  };
  return { tenant, state, home, env, runtime, client, call, rejects, root: join(home, 'sap-ai-dev-toolkit', 'releases') };
}
async function snapshot(fixture, targets = [cpiTarget]) {
  const preview = await fixture.call('integration_snapshot_content', { targets });
  return fixture.call('integration_snapshot_content', { targets, dry_run: false, confirmation: preview.required_confirmation });
}
const previewRestore = (fixture, snapshotId) => fixture.call('integration_restore_snapshot', { snapshot_id: snapshotId });
const executeRestore = (fixture, preview) => fixture.call('integration_restore_snapshot', { snapshot_id: preview.snapshot_id,
  dry_run: false, expected_current_digests: preview.expected_current_digests, confirmation: preview.required_confirmation });
const writes = tenant => tenant.apiRequests().filter(request => !['GET', 'HEAD'].includes(request.method));

test('registrar enumeration and absent snapshot store are side effect free', async t => {
  const names = [];
  registerIntegrationReleaseTools(name => names.push(name), {});
  assert.deepEqual(names, ['integration_snapshot_content', 'integration_list_snapshots', 'integration_restore_snapshot']);
  const fixture = await connect(t);
  const listed = await fixture.call('integration_list_snapshots');
  assert.deepEqual(listed.items, []);
  assert.equal(listed.complete, true);
  assert.equal(fixture.tenant.requests.length, 0);
  assert.equal(integrationCredentialsPath(fixture.env), join(fixture.home, 'sap-ai-dev-toolkit', 'integration-suite.json'));
});

test('snapshot previews bind canonical identities and hosts; strict selectors and confirmations make no requests', async t => {
  const fixture = await connect(t);
  const first = await fixture.call('integration_snapshot_content', { targets: [cpiTarget, apimTarget] });
  const second = await fixture.call('integration_snapshot_content', { targets: [apimTarget, { ...cpiTarget, version: 'active' }] });
  assert.equal(first.required_confirmation, second.required_confirmation);
  assert.equal(first.hosts.cpi, new URL(fixture.tenant.url).host);
  for (const args of [
    { targets: [{ ...apimTarget, version: 'active' }] }, { targets: [{ ...apimTarget, version: '1.0.0' }] },
    { targets: [cpiTarget], dry_run: 'false' }, { targets: [] }, { targets: Array(21).fill(cpiTarget) },
    { targets: [cpiTarget, cpiTarget] }, { targets: [cpiTarget], dry_run: false },
    { targets: [cpiTarget], dry_run: false, confirmation: first.required_confirmation }
  ]) await fixture.rejects('integration_snapshot_content', args);
  assert.equal(fixture.tenant.requests.length, 0);
});

test('snapshot saves exact original binary ZIP and configuration with private modes and named selector', async t => {
  const fixture = await connect(t);
  const original = Buffer.from(fixture.state.bytes);
  const saved = await snapshot(fixture, [{ ...cpiTarget, version: '1.0.0' }]);
  assert.equal(saved.saved, true);
  assert.equal(saved.targets[0].selector, '1.0.0');
  assert.equal(saved.targets[0].resolved_version, '1.0.0');
  const directory = join(fixture.root, saved.snapshot_id);
  assert.deepEqual((await readdir(directory)).sort(), ['0000-config.json', '0000.zip', 'manifest.json']);
  assert.deepEqual(await readFile(join(directory, '0000.zip')), original);
  assert.deepEqual(JSON.parse(await readFile(join(directory, '0000-config.json'), 'utf8')), configuration());
  for (const path of [fixture.root, directory]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const path of ['manifest.json', '0000.zip', '0000-config.json']) assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, 1);
  assert.equal(saved.snapshot_sha256, canonicalDigest(manifest));
  assert.equal(manifest.targets[0].archive_sha256, createHash('sha256').update(original).digest('hex'));
  assert.ok(fixture.tenant.apiRequests().every(request => request.path.includes("Version='1.0.0'")));
});

test('named CPI source restores original bytes/name/configuration only to active draft without deploying', async t => {
  const fixture = await connect(t);
  const original = Buffer.from(fixture.state.bytes);
  const saved = await snapshot(fixture, [{ ...cpiTarget, version: '1.0.0' }]);
  fixture.state.bytes = zip('changed'); fixture.state.name = 'Changed name';
  fixture.state.configs[0].ParameterValue = 'PRIVATE_CHANGED'; fixture.state.draftVersion = '2.0.0';
  const preview = await previewRestore(fixture, saved.snapshot_id);
  assert.deepEqual(preview.targets[0].changed_parameter_names, ['Receiver']);
  assert.equal(preview.targets[0].effects.deployment, false);
  assert.equal(writes(fixture.tenant).length, 0);
  const restored = await executeRestore(fixture, preview);
  assert.equal(restored.outcome, 'restored');
  assert.equal(restored.progress[0].accepted, true);
  assert.equal(restored.progress[0].content_verified, true);
  assert.equal(restored.progress[0].configuration_verified, true);
  assert.deepEqual(Buffer.from(fixture.state.bytes), original);
  assert.deepEqual(fixture.state.configs, configuration());
  assert.equal(fixture.state.name, 'Saved display name');
  assert.deepEqual(readBundle(fixture.state.bytes).get('src/main/resources/binary.bin'), Uint8Array.of(0, 255, 128, 1, 13, 10));
  assert.ok(writes(fixture.tenant).every(request => request.path.includes("Version='active'")));
  assert.ok(writes(fixture.tenant).every(request => request.method === 'PUT'));
});

test('restore confirmation and exact target-key preconditions reject before token or content reads', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  const preview = await previewRestore(fixture, saved.snapshot_id);
  const before = fixture.tenant.requests.length;
  for (const args of [
    { dry_run: false },
    { dry_run: false, expected_current_digests: {}, confirmation: preview.required_confirmation },
    { dry_run: false, expected_current_digests: { ...preview.expected_current_digests, 'apim_proxy:Other': 'a'.repeat(64) }, confirmation: preview.required_confirmation },
    { dry_run: false, expected_current_digests: preview.expected_current_digests, confirmation: 'wrong' },
    { dry_run: false, expected_current_digests: { 'cpi_iflow:FlowOne': 'b'.repeat(64) }, confirmation: preview.required_confirmation }
  ]) await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id, ...args });
  assert.equal(fixture.tenant.requests.length, before);
});

test('configuration-only state drift blocks restore before any write', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  const preview = await previewRestore(fixture, saved.snapshot_id);
  fixture.state.configs[0].ParameterValue = 'PRIVATE_DRIFT';
  const restored = await executeRestore(fixture, preview);
  assert.equal(restored.outcome, 'blocked');
  assert.equal(restored.reason, 'current_state_mismatch');
  assert.deepEqual(restored.progress, []);
  assert.equal(writes(fixture.tenant).length, 0);
});

test('all target preconditions are checked before any write and each target is checked again', async t => {
  const state = fakeState();
  const fixture = await connect(t, state);
  const saved = await snapshot(fixture, [cpiTarget, apimTarget]);
  const preview = await previewRestore(fixture, saved.snapshot_id);
  state.configs[0].ParameterValue = 'PRIVATE_DRIFT';
  assert.equal((await executeRestore(fixture, preview)).outcome, 'blocked');
  assert.equal(writes(fixture.tenant).length, 0);
  state.configs = configuration();
  let configReads = 0;
  const baseRoute = routes(state);
  const raceTenant = await startFakeTenant(t, request => {
    if (request.path.endsWith('/Configurations') && ++configReads === 2) state.configs[0].ParameterValue = 'PRIVATE_CONCURRENT';
    return baseRoute(request);
  });
  // A separate tenant binding cannot use this snapshot; the same-origin race is tested through its existing handler state below.
  const race = await connect(t, state, { tenant: raceTenant });
  const raceSaved = await snapshot(race);
  configReads = 0;
  const racePreview = await previewRestore(race, raceSaved.snapshot_id);
  configReads = 0;
  const outcome = await executeRestore(race, racePreview);
  assert.equal(outcome.outcome, 'blocked');
  assert.equal(outcome.progress[0].reason, 'current_state_mismatch');
  assert.equal(writes(race.tenant).length, 0);
});

test('cross-tenant snapshot restore is rejected without any network request', async t => {
  const first = await connect(t);
  const saved = await snapshot(first);
  const second = await connect(t, fakeState(), { home: first.home });
  const response = await second.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  assert.match(response.content[0].text, /same bound tenant/);
  assert.equal(second.tenant.requests.length, 0);
});

test('snapshot member corruption, oversized member, traversal and symlink are rejected before network', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  const directory = join(fixture.root, saved.snapshot_id);
  const archivePath = join(directory, '0000.zip');
  const original = await readFile(archivePath);
  const manifestPath = join(directory, 'manifest.json');
  const originalManifest = await readFile(manifestPath);
  const before = fixture.tenant.requests.length;
  await writeFile(archivePath, Buffer.from('corrupt'));
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  const listed = await fixture.call('integration_list_snapshots');
  assert.equal(listed.items[0].valid, false);
  await writeFile(archivePath, original);
  await truncate(archivePath, 20 * 1024 * 1024 + 1);
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  await writeFile(archivePath, original);
  const manifest = JSON.parse(originalManifest);
  manifest.targets[0].archive_file = '../0000.zip';
  await writeFile(manifestPath, canonicalJson(manifest));
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  await writeFile(manifestPath, originalManifest);
  await unlink(archivePath);
  const external = join(fixture.home, 'private-archive.zip');
  await writeFile(external, original, { mode: 0o600 });
  await symlink(external, archivePath);
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  assert.equal(fixture.tenant.requests.length, before);
});

test('partial configuration restore preserves accepted content PUT and stops without deploy or compensation', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  fixture.state.bytes = zip('changed');
  const preview = await previewRestore(fixture, saved.snapshot_id);
  fixture.state.failConfig = true;
  const restored = await executeRestore(fixture, preview);
  assert.equal(restored.outcome, 'partial');
  assert.equal(restored.progress[0].accepted, true);
  assert.equal(restored.progress[0].draft_replaced, true);
  assert.equal(restored.progress[0].reason, 'configuration_restore_failed');
  assert.equal(restored.progress[0].failed_parameter_name, 'Receiver');
  assert.equal(restored.progress[0].failure.status, 400);
  assert.equal(writes(fixture.tenant).length, 2);
});

test('extra tenant configuration is not silently removed or claimed fully restored', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  fixture.state.resetConfigsOnPut = false;
  fixture.state.configs.push({ ParameterKey: 'Extra', ParameterValue: 'PRIVATE_EXTRA', DataType: 'xsd:string' });
  const restored = await executeRestore(fixture, await previewRestore(fixture, saved.snapshot_id));
  assert.equal(restored.outcome, 'partial');
  assert.equal(restored.progress[0].content_verified, true);
  assert.equal(restored.progress[0].configuration_verified, false);
  assert.equal(restored.progress[0].outcome, 'unverified');
  assert.ok(fixture.state.configs.some(row => row.ParameterKey === 'Extra'));
  assert.equal(writes(fixture.tenant).some(request => request.method === 'DELETE'), false);
});

test('APIM restore compares original binary resources and never trusts an old DEPLOYED proxy', async t => {
  const fixture = await connect(t);
  const original = Buffer.from(fixture.state.proxy);
  const saved = await snapshot(fixture, [apimTarget]);
  fixture.state.proxy = proxyZip('changed'); fixture.state.ignoreImport = true;
  const preview = await previewRestore(fixture, saved.snapshot_id);
  assert.equal(preview.targets[0].effects.imports_new_revision, true);
  const failed = await executeRestore(fixture, preview);
  assert.equal(failed.outcome, 'partial');
  assert.equal(failed.progress[0].accepted, true);
  assert.equal(failed.progress[0].content_verified, false);
  assert.equal(failed.progress[0].runtime_verified, false);
  assert.equal(writes(fixture.tenant).filter(request => request.method === 'POST').length, 1);
  fixture.state.ignoreImport = false;
  const restored = await executeRestore(fixture, await previewRestore(fixture, saved.snapshot_id));
  assert.equal(restored.outcome, 'restored');
  assert.equal(restored.progress[0].runtime_verified, false);
  assert.deepEqual(Buffer.from(fixture.state.proxy), original);
  assert.equal(restored.progress[0].configuration_verified, true);
});

test('snapshot listing has signed resumable pages and rejects forged or restarted cursors', async t => {
  const fixture = await connect(t);
  const saved = [];
  for (let index = 0; index < 3; index++) saved.push(await snapshot(fixture));
  const first = await fixture.call('integration_list_snapshots', { top: 1 });
  assert.equal(first.returned, 1);
  assert.equal(first.complete, false);
  assert.equal(first.stop_reason, 'more');
  const second = await fixture.call('integration_list_snapshots', { top: 1, cursor: first.next_cursor });
  const third = await fixture.call('integration_list_snapshots', { top: 1, cursor: second.next_cursor });
  assert.equal(third.complete, true);
  assert.equal(new Set([first, second, third].map(page => page.items[0].snapshot_id)).size, 3);
  const before = fixture.tenant.requests.length;
  await fixture.rejects('integration_list_snapshots', { cursor: `${first.next_cursor.slice(0, -1)}!` });
  const restarted = await connect(t, fixture.state, { home: fixture.home, tenant: fixture.tenant });
  await restarted.rejects('integration_list_snapshots', { cursor: first.next_cursor });
  assert.equal(fixture.tenant.requests.length, before);
});

test('failed archive capture never publishes a completed snapshot', async t => {
  const fixture = await connect(t);
  fixture.state.bytes = Uint8Array.of(1, 2, 3);
  const preview = await fixture.call('integration_snapshot_content', { targets: [cpiTarget] });
  await fixture.rejects('integration_snapshot_content', { targets: [cpiTarget], dry_run: false, confirmation: preview.required_confirmation });
  await assert.rejects(readdir(fixture.root), { code: 'ENOENT' });
  assert.equal(writes(fixture.tenant).length, 0);
});

test('restore checks configuration-file hash and private member permissions before tenant reads', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  const config = join(fixture.root, saved.snapshot_id, '0000-config.json');
  const original = await readFile(config);
  const before = fixture.tenant.requests.length;
  await writeFile(config, JSON.stringify([{ ...configuration()[0], ParameterValue: 'PRIVATE_TAMPERED' }]));
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  await writeFile(config, original);
  await chmod(config, 0o644);
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  assert.equal(fixture.tenant.requests.length, before);
});

test('capture enforces per-archive and aggregate snapshot budgets before publishing', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-release-budget-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'sap-ai-dev-toolkit', 'releases');
  const opaque = randomBytes(6 * 1024 * 1024);
  let oversized = true;
  let writes = 0;
  const client = { origin: 'https://cpi.example', request: async (method, path) => {
    assert.equal(method, 'GET');
    if (method !== 'GET') writes++;
    const name = decodeURIComponent(path).match(/Id='([^']+)'/)[1];
    if (path.endsWith('/Configurations')) return { d: { results: [] } };
    if (path.endsWith('/$value')) {
      if (oversized) return new Uint8Array(20 * 1024 * 1024 + 1);
      return zipSync({
        'META-INF/MANIFEST.MF': [strToU8(`Manifest-Version: 1.0\r\nBundle-SymbolicName: ${name}\r\nBundle-Version: 1.0.0\r\n`), { level: 0 }],
        'src/main/resources/binary.bin': [opaque, { level: 0 }]
      });
    }
    return { Id: name, Name: name, Version: '1.0.0' };
  } };
  const handlers = new Map();
  registerIntegrationReleaseTools((name, _title, _description, _schema, _annotations, handler) => handlers.set(name, handler),
    { cpi: client, env: { XDG_CONFIG_HOME: home } });
  const capture = handlers.get('integration_snapshot_content');
  let targets = [cpiTarget];
  let preview = await capture({ targets });
  await assert.rejects(capture({ targets, dry_run: false, confirmation: preview.required_confirmation }), /could not be read completely/);
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  oversized = false;
  targets = Array.from({ length: 18 }, (_, index) => ({ kind: 'cpi_iflow', id: `Flow${index}` }));
  preview = await capture({ targets });
  await assert.rejects(capture({ targets, dry_run: false, confirmation: preview.required_confirmation }), /100 MiB/);
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  assert.equal(writes, 0);
});

test('archive identity drift remains rejected even when ordinary hashes have been recomputed', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture, [apimTarget]);
  const directory = join(fixture.root, saved.snapshot_id);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bytes = zipSync({ 'APIProxy/Other.xml': strToU8('<APIProxy><name>Other</name></APIProxy>') });
  const record = manifest.targets[0];
  record.archive_bytes = bytes.byteLength;
  record.archive_sha256 = createHash('sha256').update(bytes).digest('hex');
  record.bundle_sha256 = bundleDigest(readBundle(bytes));
  record.state_sha256 = stateDigest(record.bundle_sha256);
  manifest.total_bytes = bytes.byteLength;
  delete manifest.manifest_sha256;
  manifest.manifest_sha256 = canonicalDigest(manifest);
  await writeFile(join(directory, record.archive_file), bytes);
  await writeFile(manifestPath, canonicalJson(manifest));
  const before = fixture.tenant.requests.length;
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  assert.equal(fixture.tenant.requests.length, before);
});

test('accepted content replacement survives an oversized irrelevant successful response body', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  fixture.state.bytes = zip('changed');
  fixture.state.putReply = { status: 200, body: 'PRIVATE_UNUSED_BODY'.repeat(150000) };
  const restored = await executeRestore(fixture, await previewRestore(fixture, saved.snapshot_id));
  assert.equal(restored.outcome, 'restored');
  assert.equal(restored.progress[0].accepted, true);
  assert.equal(restored.progress[0].configuration_verified, true);
  assert.equal(writes(fixture.tenant).length, 2);
});

test('manifest and snapshot-directory symlinks cannot authorize restore reads', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  const directory = join(fixture.root, saved.snapshot_id);
  const manifest = join(directory, 'manifest.json');
  const bytes = await readFile(manifest);
  const externalManifest = join(fixture.home, 'manifest-copy.json');
  await writeFile(externalManifest, bytes, { mode: 0o600 });
  await unlink(manifest);
  await symlink(externalManifest, manifest);
  const before = fixture.tenant.requests.length;
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  await unlink(manifest);
  await writeFile(manifest, bytes, { mode: 0o600 });
  const externalDirectory = join(fixture.home, 'snapshot-copy');
  // Moving the test-owned directory preserves valid members while changing its entry to a symlink.
  const { rename } = await import('node:fs/promises');
  await rename(directory, externalDirectory);
  await symlink(externalDirectory, directory);
  await fixture.rejects('integration_restore_snapshot', { snapshot_id: saved.snapshot_id });
  assert.equal(fixture.tenant.requests.length, before);
});

test('restore preview reports changed bundled-default names without disclosing either value', async t => {
  const fixture = await connect(t);
  const saved = await snapshot(fixture);
  const files = readBundle(fixture.state.bytes);
  files.set('src/main/resources/parameters.prop', strToU8('Receiver=PRIVATE_NEW_DEFAULT\nOther=PRIVATE_OTHER\n'));
  fixture.state.bytes = zipSync(Object.fromEntries(files));
  const preview = await previewRestore(fixture, saved.snapshot_id);
  assert.deepEqual(preview.targets[0].changed_parameter_names, ['Other', 'Receiver']);
  assert.equal(preview.targets[0].changed_parameter_count, 2);
  assert.equal(writes(fixture.tenant).length, 0);
});
