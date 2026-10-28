import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServiceClient } from '../src/integration-http.mjs';
import { readCtmsNodes, transportReadiness } from '../src/integration-transport.mjs';
import { buildIflowBundle } from '../src/iflow-bundle.mjs';
import { readCpiContent } from '../src/cpi-content.mjs';
import { rememberValidation } from '../src/integration-validation.mjs';
import { registerIntegrationReleaseTools, snapshotEvidenceForTargets } from '../src/integration-release-store.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

async function fixture(t, { count = 25, counted = true, mixed = false, failed = false, nodes = [{ id: 17, name: 'QA', credentials: 'PRIVATE_NODE' }] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'integration-transport-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: home };
  const rows = Array.from({ length: count }, (_, index) => ({ Id: `Flow${index}`, Version: '1.2.3', Name: 'PRIVATE_NAME' }));
  const archives = new Map(rows.map((row, index) => [row.Id, buildIflowBundle({ id: row.Id, name: row.Id, version: row.Version, template: 'https-request-reply-http', templateParameters: {
    sender_path: '/test', receiver_address: 'https://backend.example', receiver_method: 'GET', receiver_authentication: index === 24 ? 'Basic' : 'None', receiver_credential_name: 'MissingAlias', receiver_timeout_ms: 60000
  } })]));
  let secret = 'PRIVATE_CONFIGURATION';
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/v2/nodes') return { status: 200, json: { nodes } };
    if (request.path.startsWith('/api/v1/IntegrationPackages(')) {
      const group = request.path.split('/').at(-1);
      if (failed && group === 'MessageMappingDesigntimeArtifacts') return { status: 403, body: 'PRIVATE_FAILURE' };
      const data = group === 'IntegrationDesigntimeArtifacts' ? rows : mixed && group === 'ValueMappingDesigntimeArtifacts' ? [{ Id: 'Codes', Version: '2.0.0' }] : [];
      const skip = Number(request.query.get('$skip') ?? 0), page = data.slice(skip, skip + 7);
      return { status: 200, json: { d: { results: page, ...(counted ? { __count: String(data.length) } : {}),
        ...(skip + page.length < data.length ? { __next: `${request.path}?$skip=${skip + page.length}` } : {}) } } };
    }
    if (request.path.startsWith('/api/v1/IntegrationDesigntimeArtifacts(')) {
      const id = /Id='([^']+)'/.exec(request.path)?.[1];
      if (request.path.endsWith('/$value')) return { status: 200, body: Buffer.from(archives.get(id)) };
      if (request.path.endsWith('/Configurations')) return { status: 200, json: { d: { results: [{ ParameterKey: 'Business', ParameterValue: secret, DataType: 'xsd:string' }] } } };
      return { status: 200, json: { d: { Id: id, Name: id, Version: '1.2.3' } } };
    }
    if (request.path.startsWith('/api/v1/IntegrationRuntimeArtifacts(')) return { status: 404 };
    if (['/api/v1/UserCredentials', '/api/v1/OAuth2ClientCredentials', '/api/v1/KeystoreEntries'].includes(request.path)) return { status: 200, json: { d: { results: [] } } };
    return { status: 404 };
  });
  const client = createServiceClient({ label: 'transport', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`, clientId: 'client', clientSecret: 'PRIVATE_CLIENT', env: {} });
  const clients = { cpi: client, ctms: client, summary: { environment: 'QA-source' } };
  return { env, tenant, client, clients, rows, changeConfiguration: () => { secret = 'PRIVATE_CHANGED'; } };
}

async function validateAll(f) {
  for (const row of f.rows) {
    const content = await readCpiContent(f.client, row.Id);
    rememberValidation(f.client, { id: row.Id, resolved_version: content.resolved_version, state_sha256: content.state_sha256, bundle_sha256: content.bundle_sha256, passed: true });
  }
}

function privateResult(result) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes('PRIVATE_'));
  assert.ok(!text.includes('ParameterValue'));
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) < 96 * 1024);
}

test('multi-page packages check beyond the 20-target boundary and retain a later blocked member', async t => {
  const f = await fixture(t);
  await validateAll(f);
  const result = await transportReadiness(f.clients, { source_package_ids: ['Orders'], target_node_name: 'QA' }, { env: f.env });
  assert.equal(result.enumeration_complete, true);
  assert.equal(result.checked_iflows, 25);
  assert.equal(result.members.length, 25);
  assert.equal(result.members.find(row => row.id === 'Flow24').readiness, 'blocked');
  assert.ok(result.members.find(row => row.id === 'Flow24').blockers.includes('missing_required_dependency'));
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.target_node.import_eligibility, 'unknown');
  assert.ok(f.tenant.apiRequests().every(request => request.method === 'GET'));
  privateResult(result);
});

test('countless capped navigation and failed groups cannot claim complete source readiness', async t => {
  const f = await fixture(t, { count: 3, counted: false, mixed: true, failed: true });
  const result = await transportReadiness(f.clients, { source_package_ids: ['Orders'], target_node_name: 'QA' }, { env: f.env });
  assert.equal(result.enumeration_complete, false);
  assert.ok(result.blockers.includes('source_enumeration_incomplete'));
  assert.ok(result.blockers.includes('unchecked_non_iflow_members'));
  assert.equal(result.packages[0].groups.message_mappings.source_result.result, 'forbidden');
  assert.equal(result.members.find(row => row.id === 'Codes').readiness, 'native_review_required');
  privateResult(result);
});

test('matching verified backups are origin- and configuration-bound; native promotion never becomes ready', async t => {
  const f = await fixture(t, { count: 1 });
  await validateAll(f);
  const tools = new Map();
  registerIntegrationReleaseTools((name, title, description, schema, annotations, handler) => tools.set(name, handler), { ...f.clients, env: f.env });
  const targets = [{ kind: 'cpi_iflow', id: 'Flow0', version: 'active' }];
  const preview = await tools.get('integration_snapshot_content')({ targets });
  const saved = await tools.get('integration_snapshot_content')({ targets, dry_run: false, confirmation: preview.required_confirmation });
  const ready = await transportReadiness(f.clients, { source_package_ids: ['Orders'], target_node_name: 'QA' }, { env: f.env });
  assert.equal(ready.readiness, 'needs_admin_confirmation');
  assert.equal(ready.snapshots.items[0].snapshot_id, saved.snapshot_id);
  assert.equal(ready.target_verification, 'requires_independent_target_bound_server');
  const evidence = ready.members[0];
  const wrongTenant = await snapshotEvidenceForTargets({ cpi: { origin: 'https://other.example' } }, [{ ...evidence, kind: 'cpi_iflow' }], { env: f.env });
  assert.deepEqual(wrongTenant.items, []);
  f.changeConfiguration();
  const changed = await transportReadiness(f.clients, { source_package_ids: ['Orders'], target_node_name: 'QA' }, { env: f.env });
  assert.ok(changed.blockers.includes('matching_verified_snapshot_required'));
  assert.deepEqual(changed.snapshots.items, []);
  privateResult(ready); privateResult(changed);
});

test('node paging is credential-safe, query-bound and does not invent eligibility', async t => {
  const f = await fixture(t, { count: 0, nodes: [{ id: 1, name: 'One', secret: 'PRIVATE_ONE' }, { id: 2, name: 'QA', destination: 'PRIVATE_TWO' }] });
  const first = await readCtmsNodes(f.client, { top: 1 });
  const second = await readCtmsNodes(f.client, { top: 1, cursor: first.next_cursor });
  assert.deepEqual(second.items, [{ id: 2, name: 'QA', upload_eligibility: 'unknown', import_eligibility: 'unknown' }]);
  assert.equal(second.complete, true);
  const result = await transportReadiness(f.clients, { source_package_ids: ['Orders'], target_node_name: 'Absent' }, { env: f.env });
  assert.ok(result.blockers.includes('no_transportable_members_observed'));
  assert.ok(result.blockers.includes('target_node_missing_or_identity_unverified'));
  privateResult(result);
});

test('incomplete backup traversal cannot satisfy native promotion readiness', async () => {
  const item = { kind: 'apim_proxy', id: 'Orders', readiness: 'ready', state_sha256: 'a'.repeat(64) };
  const result = await transportReadiness({
    apim: { origin: 'https://source.example' },
    ctms: { origin: 'https://ctms.example', request: async () => ({ nodes: [{ id: 1, name: 'QA' }] }) }
  }, { apim_proxy_names: ['Orders'], target_node_name: 'QA' }, {
    readiness: async () => ({ items: [item] }),
    snapshots: async () => ({ result: 'ok', complete: false, stop_reason: 'source_limit', items: [{ targets: [item] }] })
  });
  assert.equal(result.readiness, 'blocked');
  assert.ok(result.blockers.includes('snapshot_evidence_incomplete'));
  assert.equal(result.target_verification, 'requires_independent_target_bound_server');
});
