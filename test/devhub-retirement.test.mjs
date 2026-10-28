import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { registerDevhubRetirementTools } from '../src/devhub-retirement.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const DATA = '/odata/1.0/data.svc';
const APP = `${DATA}/APIMgmt.Applications('Consumer')`;
const SUB = `${DATA}/APIMgmt.Subscriptions('sub1')`;
const KEY = 'private-consumer-key-retirement';
const SECRET = 'private-consumer-secret-retirement';
const OWNER = 'private-owner@example.test';
const PRIVATE = [KEY, SECRET, OWNER, 'PrivateOwnerName', 'PrivateComment'];
const unsubscribeArgs = { application_id: 'Consumer', product: 'Product', dry_run: false, confirmation: 'UNSUBSCRIBE APPLICATION Consumer FROM Product' };
const ref = uri => [{ __metadata: { uri } }];
const clone = value => JSON.parse(JSON.stringify(value));

function batchResponse(statuses = [204], body = '') {
  return '--batch_response\r\nContent-Type: multipart/mixed; boundary=changeset_response\r\n\r\n'
    + statuses.map((status, index) => `--changeset_response\r\nContent-Type: application/http\r\nContent-ID: ${index + 1}\r\n\r\nHTTP/1.1 ${status} Result\r\n\r\n${body}\r\n`).join('')
    + '--changeset_response--\r\n--batch_response--\r\n';
}

async function fixture(t, options = {}) {
  const state = {
    subscriptions: [{ id: 'sub1', app_id: 'Consumer', product_id: 'Product', developer_id: OWNER, reg_id: 'registration1', ratePlan_id: 'rate1', isSubscribed: true, status: 'approved',
      ToAPIProduct: ref("APIMgmt.APIProducts('Product')"), ToApplication: ref("APIMgmt.Applications('Consumer')"), ToRatePlan: ref("APIMgmt.RatePlans('rate1')"),
      app_key: KEY, app_secret: SECRET, comment: 'PrivateComment' }],
    legacy: [], owner: OWNER, memberStatuses: [204], applyUnsubscribe: true, batchBody: undefined,
    deletionRequested: false, propagationReads: 0, deleteStatus: 204, deleteReadStatus: 200,
    omitSubscriptions: false, omitLegacy: false, subscriptionEnvelope: null, applicationReads: 0, batchWrites: [], deleteWrites: [], ...options
  };
  const tenant = await startFakeTenant(t, request => {
    if (request.path === APP && request.method === 'GET') {
      state.applicationReads++;
      if (state.deletionRequested) {
        if (state.deleteReadStatus !== 200) return { status: state.deleteReadStatus };
        if (state.propagationReads-- <= 0) return { status: 404 };
      }
      const application = { id: 'Consumer', developer_id: state.owner, reg_id: 'registration1', app_key: KEY, app_secret: SECRET, firstName: 'PrivateOwnerName' };
      if (!state.omitSubscriptions) application.ToSubscriptions = state.subscriptionEnvelope ?? { results: clone(state.subscriptions) };
      if (!state.omitLegacy) application.ToAPIProductsDetails = { results: clone(state.legacy) };
      return { status: 200, json: { d: application } };
    }
    if (request.path === SUB && request.method === 'GET') return { status: 200, json: { d: clone(state.subscriptions.find(row => row.id === 'sub1')) } };
    if (request.path === `${DATA}/$batch` && request.method === 'POST') {
      state.batchWrites.push(request);
      const match = /PUT APIMgmt\.Subscriptions\('sub1'\) HTTP\/1\.1\r\nContent-Type: application\/json\r\nAccept: application\/json\r\n\r\n([^\r\n]*)\r\n--/.exec(request.body);
      if (!match) return { status: 400 };
      state.lastPut = JSON.parse(match[1]);
      if (state.applyUnsubscribe && state.memberStatuses.length === 1 && state.memberStatuses[0] >= 200 && state.memberStatuses[0] < 300) state.subscriptions[0].isSubscribed = false;
      if (state.afterBatch) state.afterBatch(state);
      return { status: 202, headers: { 'content-type': 'multipart/mixed; boundary=batch_response' }, body: state.batchBody ?? batchResponse(state.memberStatuses) };
    }
    if (request.path === APP && request.method === 'DELETE') {
      state.deleteWrites.push(request);
      state.deletionRequested = true;
      return { status: state.deleteStatus, body: state.deleteStatus === 204 ? '' : `${KEY} ${SECRET}` };
    }
    if (options.handler) return options.handler(request, state, tenant);
    return { status: 404 };
  });
  const runtime = createIntegrationServer({
    env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', DEVHUB_SERVICE_KEY: tenant.serviceKey() }, readBackDelayMs: 1
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'consumer-retirement-behavior', version: '1' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return { tenant, client, state };
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content[0].text;
  for (const value of PRIVATE) assert.equal(text.includes(value), false, `private value leaked: ${value}`);
  return { error: response.isError === true, text, data: response.isError ? null : JSON.parse(text) };
}

async function deletionPreview(client, permission = false) {
  const result = await call(client, 'devhub_delete_application', { application_id: 'Consumer', allow_active_subscriptions: permission });
  assert.equal(result.error, false);
  return result.data;
}

const deleteArgs = preview => ({ application_id: 'Consumer', dry_run: false, allow_active_subscriptions: preview.allow_active_subscriptions, confirmation: preview.required_confirmation });

test('consumer retirement registrar supports null-client name enumeration', () => {
  const names = [];
  registerDevhubRetirementTools(name => names.push(name), null);
  assert.deepEqual(names, ['devhub_list_subscriptions', 'devhub_unsubscribe_application', 'devhub_delete_application']);
});

test('subscription inventory is safely bounded, resumable and explicit about legacy models', async t => {
  const { tenant, client, state } = await fixture(t);
  state.subscriptions = Array.from({ length: 205 }, (_, index) => ({ ...state.subscriptions[0], id: `sub${index}`, product_id: `Product${index}` }));
  let cursor;
  const ids = [];
  do {
    const page = await call(client, 'devhub_list_subscriptions', { application_id: 'Consumer', top: 100, ...(cursor ? { cursor } : {}) });
    assert.equal(page.error, false);
    assert.equal(page.data.total, null, 'unknown server count is not a sampled total');
    assert.equal(page.data.model, 'subscription');
    ids.push(...page.data.items.map(row => row.subscription_id));
    cursor = page.data.next_cursor;
    assert.equal(page.data.complete, cursor === null);
  } while (cursor);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  assert.ok(tenant.apiRequests().every(request => request.path === APP));
  state.subscriptions = [];
  state.legacy = [{ name: 'LegacyProduct', app_key: KEY }];
  const legacy = await call(client, 'devhub_list_subscriptions', { application_id: 'Consumer' });
  assert.equal(legacy.data.model, 'legacy');
  assert.equal(legacy.data.legacy_product_link_count, 1);
});

test('invalid or cross-application subscription cursors make no network requests', async t => {
  const { tenant, client, state } = await fixture(t);
  state.subscriptions.push({ ...state.subscriptions[0], id: 'sub2', product_id: 'Product2' });
  const first = await call(client, 'devhub_list_subscriptions', { application_id: 'Consumer', top: 1 });
  const before = tenant.requests.length;
  for (const args of [
    { application_id: 'Consumer', cursor: `${first.data.next_cursor}x` },
    { application_id: 'Different', cursor: first.data.next_cursor }
  ]) {
    const result = await call(client, 'devhub_list_subscriptions', args);
    assert.equal(result.error, true);
  }
  assert.equal(tenant.requests.length, before);
});

test('unsubscribe previews without writing and preserves all actual scalar IDs and references in one batch member', async t => {
  const { tenant, client, state } = await fixture(t);
  state.subscriptions[0].ToApplication = ref(`${tenant.url}${APP}`);
  const preview = await call(client, 'devhub_unsubscribe_application', { application_id: 'Consumer', product: 'Product' });
  assert.equal(preview.data.dry_run, true);
  assert.equal(preview.data.required_confirmation, unsubscribeArgs.confirmation);
  assert.equal(state.batchWrites.length, 0);
  const before = clone(state.subscriptions[0]);
  const result = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(result.data.accepted, true);
  assert.equal(result.data.unsubscribed, true);
  assert.equal(result.data.read_back_verified, true);
  assert.equal(result.data.api_key_invalidation, 'unverified');
  assert.equal(result.data.issued_oauth_token_revocation, 'unverified');
  assert.equal(state.batchWrites.length, 1);
  assert.equal((state.batchWrites[0].body.match(/PUT /g) ?? []).length, 1);
  assert.equal(/(?<!\r)\n/.test(state.batchWrites[0].body), false, 'batch uses CRLF');
  assert.deepEqual(state.lastPut, {
    id: 'sub1', app_id: 'Consumer', product_id: 'Product', developer_id: OWNER, reg_id: 'registration1', ratePlan_id: 'rate1', isSubscribed: false,
    ToAPIProduct: before.ToAPIProduct, ToApplication: before.ToApplication, ToRatePlan: before.ToRatePlan
  });
});

test('genuinely absent nullable rate plans are omitted rather than invented', async t => {
  const { client, state } = await fixture(t);
  state.subscriptions[0].ratePlan_id = null;
  state.subscriptions[0].ToRatePlan = null;
  const result = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(result.data.unsubscribed, true);
  assert.equal('ToRatePlan' in state.lastPut, false);
  assert.equal(state.lastPut.ratePlan_id, null);
});

test('an unresolved nullable rate plan is refused and changed actual references cannot pass read-back', async t => {
  const { client, state } = await fixture(t);
  state.subscriptions[0].ToRatePlan = { __deferred: { uri: "APIMgmt.RatePlans('rate1')" } };
  assert.equal((await call(client, 'devhub_unsubscribe_application', unsubscribeArgs)).error, true);
  assert.equal(state.batchWrites.length, 0);
  delete state.subscriptions[0].ratePlan_id;
  state.subscriptions[0].ToRatePlan = ref("APIMgmt.RatePlans('rate1')");
  state.afterBatch = current => { current.subscriptions[0].ToRatePlan = ref("APIMgmt.RatePlans('differentRate')"); };
  const changed = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(changed.data.accepted, true);
  assert.equal(changed.data.read_back_verified, false);
  assert.equal(changed.data.unsubscribed, false);
  assert.equal(state.batchWrites.length, 1);
});

test('wrong unsubscribe confirmations and missing deletion approvals do not even acquire a token', async t => {
  const { tenant, client } = await fixture(t);
  const unconfirmed = await call(client, 'devhub_unsubscribe_application', { ...unsubscribeArgs, confirmation: 'WRONG' });
  assert.equal(unconfirmed.error, true);
  const missing = await call(client, 'devhub_delete_application', { application_id: 'Consumer', dry_run: false, confirmation: `DELETE CONSUMER APPLICATION ${'0'.repeat(64)}` });
  assert.equal(missing.error, true);
  assert.deepEqual(tenant.requests, []);
});

test('batch outer success does not hide an embedded subscription failure or an ambiguous member count', async t => {
  const { client, state } = await fixture(t, { memberStatuses: [403], batchBody: batchResponse([403], JSON.stringify({ error: { message: KEY } })) });
  const rejected = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(rejected.data.batch_accepted, true);
  assert.equal(rejected.data.accepted, false);
  assert.equal(rejected.data.unsubscribed, false);
  assert.equal(rejected.data.outcome, 'failed');
  assert.deepEqual(rejected.data.member_statuses, [403]);
  state.batchBody = batchResponse([204, 204]);
  const ambiguous = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(ambiguous.data.accepted, null);
  assert.equal(ambiguous.data.read_back_verified, false);
  assert.equal(ambiguous.data.outcome, 'unverified');
  assert.equal(state.batchWrites.length, 2, 'never tries an alternative write');
});

test('unsupported batch bodies and stale subscription read-back stay unverified without alternative writes', async t => {
  const { client, state } = await fixture(t, { applyUnsubscribe: false });
  const stale = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(stale.data.accepted, true);
  assert.equal(stale.data.read_back_verified, false);
  assert.equal(stale.data.unsubscribed, false);
  state.batchBody = batchResponse([204], 'unrecognized body');
  const unknown = await call(client, 'devhub_unsubscribe_application', unsubscribeArgs);
  assert.equal(unknown.data.outcome, 'unverified');
  assert.equal(unknown.data.unsubscribed, false);
  assert.equal(state.batchWrites.length, 2);
});

test('legacy, duplicate and unresolved subscription models refuse unsubscribe before mutation', async t => {
  const { client, state } = await fixture(t);
  state.legacy = [{ name: 'LegacyProduct' }];
  assert.equal((await call(client, 'devhub_unsubscribe_application', unsubscribeArgs)).error, true);
  state.legacy = [];
  state.subscriptions.push({ ...state.subscriptions[0], id: 'sub2' });
  assert.equal((await call(client, 'devhub_unsubscribe_application', unsubscribeArgs)).error, true);
  state.subscriptions.pop();
  delete state.subscriptions[0].ToApplication;
  assert.equal((await call(client, 'devhub_unsubscribe_application', unsubscribeArgs)).error, true);
  state.subscriptions[0].ToApplication = ref("APIMgmt.Applications('Other')");
  assert.equal((await call(client, 'devhub_unsubscribe_application', unsubscribeArgs)).error, true);
  assert.equal(state.batchWrites.length, 0);
});

test('active subscriptions and legacy-only links require separately hashed deletion permission', async t => {
  const { client, state } = await fixture(t);
  const active = await deletionPreview(client);
  assert.equal(active.blocked, true);
  assert.equal(active.subscriptions.active_count, 1);
  assert.equal(active.required_confirmation, undefined);
  state.subscriptions = [];
  state.legacy = [{ name: 'LegacyProduct' }];
  const legacy = await deletionPreview(client);
  assert.equal(legacy.complete, true);
  assert.equal(legacy.blocked, true);
  assert.equal(legacy.subscriptions.count, 0);
  assert.equal(legacy.legacy_product_links.count, 1);
  const allowed = await deletionPreview(client, true);
  assert.equal(allowed.blocked, false);
  assert.match(allowed.required_confirmation, /^DELETE CONSUMER APPLICATION [a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(allowed.owner), ['identity_sha256']);
  assert.equal(state.deleteWrites.length, 0);
  const result = await call(client, 'devhub_delete_application', deleteArgs(allowed));
  assert.equal(result.data.deletion_verified, true);
  assert.equal(result.data.deleted, true);
  assert.equal(state.deleteWrites.length, 1);
});

test('missing, incomplete, malformed or unknown-state dependencies block deletion even with permission', async t => {
  const { client, state } = await fixture(t);
  state.omitLegacy = true;
  assert.equal((await deletionPreview(client, true)).blocked, true);
  const incompleteList = await call(client, 'devhub_list_subscriptions', { application_id: 'Consumer' });
  assert.equal(incompleteList.data.complete, false);
  assert.equal(incompleteList.data.model, 'unknown');
  assert.equal(incompleteList.data.stop_reason, 'source_limit');
  state.omitLegacy = false;
  state.subscriptionEnvelope = { results: clone(state.subscriptions), __count: '2' };
  const incomplete = await deletionPreview(client, true);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.required_confirmation, undefined);
  state.subscriptionEnvelope = { results: clone(state.subscriptions), __count: 'not-a-count' };
  assert.equal((await deletionPreview(client, true)).complete, false);
  state.subscriptionEnvelope = null;
  state.subscriptions[0].isSubscribed = 'unknown';
  assert.equal((await deletionPreview(client, true)).complete, false);
  assert.equal(state.deleteWrites.length, 0);
});

test('deletion confirmation cache expires before token or relationship requests', async t => {
  const { tenant, client } = await fixture(t);
  const preview = await deletionPreview(client, true);
  const before = tenant.requests.length;
  const actualNow = Date.now;
  t.mock.method(Date, 'now', () => actualNow() + 15 * 60 * 1000 + 1);
  const expired = await call(client, 'devhub_delete_application', deleteArgs(preview));
  assert.equal(expired.error, true);
  assert.match(expired.text, /new dry run/);
  assert.equal(tenant.requests.length, before);
});

test('changing a cached permission or confirmation cannot authorize new requests', async t => {
  const { tenant, client } = await fixture(t);
  const preview = await deletionPreview(client, true);
  const before = tenant.requests.length;
  for (const args of [
    { ...deleteArgs(preview), allow_active_subscriptions: false },
    { ...deleteArgs(preview), application_id: 'Other' },
    { ...deleteArgs(preview), confirmation: preview.required_confirmation.replace(/.$/, 'z') }
  ]) assert.equal((await call(client, 'devhub_delete_application', args)).error, true);
  assert.equal(tenant.requests.length, before);
});

test('either dependency set, owner, or an actual relationship reference drifting invalidates deletion approval', async t => {
  const { client, state } = await fixture(t);
  for (const mutate of [
    () => { state.subscriptions.push({ ...state.subscriptions[0], id: 'newSubscription', product_id: 'OtherProduct' }); },
    () => { state.legacy.push({ name: 'NewLegacyProduct' }); },
    () => { state.owner = 'different-owner@example.test'; },
    () => { state.subscriptions[0].ToRatePlan = ref("APIMgmt.RatePlans('differentRate')"); }
  ]) {
    const preview = await deletionPreview(client, true);
    mutate();
    const result = await call(client, 'devhub_delete_application', deleteArgs(preview));
    assert.equal(result.error, true);
    assert.match(result.text, /changed|incomplete/);
    assert.equal(state.deleteWrites.length, 0);
  }
});

test('application deletion is accepted once and waits for authoritative named absence without claiming credential revocation', async t => {
  const { tenant, client, state } = await fixture(t, { propagationReads: 2, deleteStatus: 202 });
  state.subscriptions[0].isSubscribed = false;
  const preview = await deletionPreview(client);
  assert.equal(preview.blocked, false);
  const result = await call(client, 'devhub_delete_application', deleteArgs(preview));
  assert.equal(result.data.accepted, true);
  assert.equal(result.data.http_status, 202);
  assert.equal(result.data.deleted, true);
  assert.equal(result.data.deletion_verified, true);
  assert.equal(result.data.api_key_invalidation, 'unverified');
  assert.equal(result.data.issued_oauth_token_revocation, 'unverified');
  assert.equal(state.deleteWrites.length, 1);
  assert.equal(tenant.apiRequests().filter(request => request.method === 'GET' && request.path === APP && !request.query.has('$expand')).length, 3);
  const before = tenant.requests.length;
  assert.equal((await call(client, 'devhub_delete_application', deleteArgs(preview))).error, true, 'consumed approval is not reused');
  assert.equal(tenant.requests.length, before);
});

test('a cached deletion approval cannot be executed concurrently twice', async t => {
  const { client, state } = await fixture(t);
  const preview = await deletionPreview(client, true);
  const results = await Promise.all([
    call(client, 'devhub_delete_application', deleteArgs(preview)),
    call(client, 'devhub_delete_application', deleteArgs(preview))
  ]);
  assert.equal(results.filter(result => result.error).length, 1);
  assert.equal(results.filter(result => result.data?.deletion_verified === true).length, 1);
  assert.equal(state.deleteWrites.length, 1);
});

test('accepted deletion with lingering definition or forbidden read-back remains unverified', async t => {
  const { client, state } = await fixture(t, { propagationReads: 10 });
  const preview = await deletionPreview(client, true);
  const pending = await call(client, 'devhub_delete_application', deleteArgs(preview));
  assert.equal(pending.data.accepted, true);
  assert.equal(pending.data.deleted, false);
  assert.equal(pending.data.pending, true);
  assert.equal(pending.data.deletion_verified, false);
  state.deletionRequested = false;
  state.deleteReadStatus = 403;
  const another = await deletionPreview(client, true);
  const forbidden = await call(client, 'devhub_delete_application', deleteArgs(another));
  assert.equal(forbidden.data.accepted, true);
  assert.equal(forbidden.data.deletion_verified, false);
  assert.equal(forbidden.data.source_result.status, 403);
  assert.equal(state.deleteWrites.length, 2);
});

test('explicit same-navigation continuations are completely inventoried before dependency approval', async t => {
  const { client, state, tenant } = await fixture(t, {
    handler: request => request.path === `${APP}/ToSubscriptions`
      ? { status: 200, json: { d: { results: [{ id: 'sub2', app_id: 'Consumer', product_id: 'Product2', isSubscribed: true }], __count: '2' } } }
      : { status: 404 }
  });
  state.subscriptions[0].isSubscribed = false;
  state.subscriptionEnvelope = { results: clone(state.subscriptions), __count: '2', __next: `${tenant.url}${APP}/ToSubscriptions?$skip=1` };
  const result = await deletionPreview(client);
  assert.equal(result.complete, true);
  assert.equal(result.subscriptions.count, 2);
  assert.equal(result.subscriptions.active_count, 1);
  assert.equal(result.blocked, true);
});

test('off-origin continuations never become authority for consumer dependency reads', async t => {
  const { tenant, client, state } = await fixture(t);
  state.subscriptionEnvelope = { results: clone(state.subscriptions), __next: 'https://attacker.example/odata/1.0/data.svc/anything' };
  const result = await deletionPreview(client, true);
  assert.equal(result.complete, false);
  assert.equal(result.blocked, true);
  assert.ok(tenant.apiRequests().every(request => request.path === APP));
  assert.equal(state.deleteWrites.length, 0);
});
