import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { buildApiProxyBundle, attachPolicies, editPolicySteps, xmlLocate, xmlChildren, xmlText } from '../src/apim-bundle.mjs';
import { bundleDigest, readBundle } from '../src/iflow-bundle.mjs';
import { registerApimPolicyStepTools } from '../src/apim-policy-steps.mjs';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const TRANSPORT = '/apiportal/api/1.0/Transport.svc/APIProxies';
const BASE = '/apiportal/api/1.0/Management.svc';
const PROXY = 'APIProxy/APIProxyEndPoint/default.xml';
const TARGET = 'APIProxy/APITargetEndPoint/default.xml';
const ROOT = 'APIProxy/Orders.xml';
const text = (files, path) => strFromU8(files.get(path));
const change = (files, path, before, after) => files.set(path, strToU8(text(files, path).replace(before, after)));
const request = files => ({ name: 'Orders', expected_bundle_sha256: bundleDigest(files), endpoint: 'proxy', endpoint_name: 'default', flow: 'pre', phase: 'request', steps: [], confirmation: 'EDIT API PROXY POLICY STEPS Orders' });

function fixture() {
  const files = readBundle(buildApiProxyBundle({ name: 'Orders', basePath: '/orders', serviceType: 'rest', target: { url: 'https://backend.example' } }));
  attachPolicies(files, 'Orders', [
    { name: 'A', template: 'verify_api_key', condition: 'PRIVATE_A = "keep"', params: { key_ref: 'request.header.apikey' } },
    { name: 'B', template: 'javascript', condition: 'PRIVATE_B = "old"', params: { file: 'shared', script: 'var PRIVATE_SCRIPT = true;' } },
    { name: 'C', template: 'custom', params: { type: 'Javascript', xml: '<Javascript xmlns="http://www.sap.com/apimgmt"><ResourceURL>jsc://shared.js</ResourceURL></Javascript>' } }
  ]);
  files.set('APIProxy/FileResource/opaque.bin', Uint8Array.from([0, 255, 128, 1, 2]));
  change(files, PROXY, '<step><policy_name>B', '<!-- preserve between assignments --><step><policy_name>B');
  return files;
}

function assignments(files, path = PROXY, flow = 'preFlow', phase = 'request') {
  const xml = text(files, path);
  const parent = xmlLocate(xml, [flow, phase, 'steps']);
  return parent ? xmlChildren(xml, parent).map(step => {
    const fields = xmlChildren(xml, step);
    const field = name => fields.find(item => item.name === name);
    return { policy_name: xmlText(xml, field('policy_name')), condition: field('condition') ? xmlText(xml, field('condition')) : '', sequence: Number(xmlText(xml, field('sequence'))) };
  }) : [];
}

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/policy-step-test', APIM_SERVICE_KEY: tenant.serviceKey() }, readBackDelayMs: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'policy-step-test', version: '1.0.0' });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close().catch(() => {}); await runtime.close(); });
  return client;
}

async function tenantFor(t, files, { stale = false } = {}) {
  const state = { uploaded: null };
  const tenant = await startFakeTenant(t, req => {
    if (req.path === TRANSPORT && req.method === 'GET') return { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from(zipSync(Object.fromEntries(stale ? files : state.uploaded ?? files))) };
    if (req.path === TRANSPORT && req.method === 'POST') {
      state.uploaded = readBundle(Buffer.from(req.body, 'base64'));
      return { status: 201, body: '' };
    }
    if (req.path === `${BASE}/APIProxies('Orders')`) return { status: 200, json: { d: { name: 'Orders', state: 'DEPLOYED', proxyEndPoints: { results: [{ base_path: '/orders', virtualhosts: { results: [{ virtual_host: 'runtime.example', virtual_port: 443, isSSL: true }] } }] } } } };
    return { status: 500 };
  });
  return { tenant, state, client: await connect(t, tenant) };
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  return { isError: response.isError === true, text: response.content[0].text };
}
const parsed = result => { assert.equal(result.isError, false, result.text); return JSON.parse(result.text); };

// Structural assertions observe behavior and retained bytes, not generated source wording.
test('complete ordered steps preserve omitted conditions, update explicit conditions and retain shared/binary resources', async t => {
  const files = fixture();
  const originalTarget = files.get(TARGET);
  const originalScript = files.get('APIProxy/FileResource/shared.js');
  const originalBinary = files.get('APIProxy/FileResource/opaque.bin');
  const { client, state } = await tenantFor(t, files);
  const result = parsed(await call(client, 'apim_edit_policy_steps', {
    ...request(files), steps: [{ policy_name: 'B', condition: 'PRIVATE_NEW = "changed"' }, { policy_name: 'A' }], remove_unreferenced: ['C']
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.assignments_verified, true);
  assert.equal(result.content_verified, true);
  assert.equal(result.runtime_verified, false);
  assert.equal(result.outcome, 'unverified');
  assert.deepEqual(result.effects, { draft_created_or_replaced: true, new_revision_imported: true, deployment_requested: true });
  assert.deepEqual(result.steps, [{ policy_name: 'B', sequence: 1, condition_present: true }, { policy_name: 'A', sequence: 2, condition_present: true }]);
  assert.deepEqual(assignments(state.uploaded), [
    { policy_name: 'B', condition: 'PRIVATE_NEW = "changed"', sequence: 1 },
    { policy_name: 'A', condition: 'PRIVATE_A = "keep"', sequence: 2 }
  ]);
  assert.match(text(state.uploaded, PROXY), /<!-- preserve between assignments -->/);
  assert.deepEqual(state.uploaded.get(TARGET), originalTarget);
  assert.deepEqual(state.uploaded.get('APIProxy/FileResource/shared.js'), originalScript);
  assert.deepEqual(state.uploaded.get('APIProxy/FileResource/opaque.bin'), originalBinary);
  assert.equal(state.uploaded.has('APIProxy/Policy/C.xml'), false);
  assert.doesNotMatch(text(state.uploaded, ROOT), />C</);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NEW|PRIVATE_A|PRIVATE_SCRIPT|changed|keep/);
});

test('a new assignment starts unconditional, exact target/post/response selection preserves every other member', () => {
  const files = fixture();
  const old = new Map(files);
  editPolicySteps(files, 'Orders', { endpoint: 'target', endpoint_name: 'default', flow: 'post', phase: 'response', steps: [{ policy_name: 'A' }, { policy_name: 'C', condition: '' }] });
  assert.deepEqual(assignments(files, TARGET, 'postFlow', 'response'), [
    { policy_name: 'A', condition: '', sequence: 1 }, { policy_name: 'C', condition: '', sequence: 2 }
  ]);
  for (const [path, bytes] of old) if (path !== TARGET) assert.deepEqual(files.get(path), bytes, path);
});

test('complete empty steps remove only the chosen phase assignments and allow explicit unreferenced policy removal', () => {
  const files = fixture();
  const target = files.get(TARGET);
  editPolicySteps(files, 'Orders', { ...request(files), steps: [], remove_unreferenced: ['A', 'B', 'C'] });
  assert.deepEqual(assignments(files), []);
  assert.deepEqual(files.get(TARGET), target);
  assert.ok(files.has('APIProxy/FileResource/shared.js'));
  assert.ok(files.has('APIProxy/FileResource/opaque.bin'));
  assert.doesNotMatch(text(files, ROOT), /<policy /);
});

test('retained conditional, fault, unknown and out-of-endpoint references block explicit deletion before import', async t => {
  const variants = [
    '<conditionalFlows><flow><condition>PRIVATE_FLOW</condition><response><steps><step><policy_name>C</policy_name><condition/><sequence>1</sequence></step></steps></response></flow></conditionalFlows>',
    '<faultRules><faultRule><steps><step><policy_name>C</policy_name><sequence>1</sequence></step></steps></faultRule></faultRules><conditionalFlows/>',
    '<defaultFaultRule><Step><Name>C</Name></Step></defaultFaultRule><conditionalFlows/>',
    '<extension><step ref="private.dynamic"><condition>PRIVATE_UNKNOWN</condition></step></extension><conditionalFlows/>',
    '<extension><policy_name>C</policy_name></extension><conditionalFlows/>'
  ];
  for (const extra of variants) {
    const files = fixture();
    change(files, TARGET, '<conditionalFlows/>', extra);
    const { tenant, client } = await tenantFor(t, files);
    const result = await call(client, 'apim_edit_policy_steps', { ...request(files), steps: [{ policy_name: 'A' }, { policy_name: 'B' }], remove_unreferenced: ['C'] });
    assert.equal(result.isError, true);
    assert.equal(tenant.apiRequests().filter(req => req.method === 'POST').length, 0);
    assert.doesNotMatch(result.text, /PRIVATE_FLOW|PRIVATE_UNKNOWN/);
  }
});

test('wrong confirmation has no token/network; stale digest, duplicate and ambiguous layouts have no import', async t => {
  const files = fixture();
  const first = await tenantFor(t, files);
  const wrong = await call(first.client, 'apim_edit_policy_steps', { ...request(files), confirmation: 'EDIT API PROXY Orders' });
  assert.equal(wrong.isError, true);
  assert.equal(first.tenant.requests.length, 0);
  const stale = await call(first.client, 'apim_edit_policy_steps', { ...request(files), expected_bundle_sha256: '0'.repeat(64) });
  assert.equal(stale.isError, true);
  assert.equal(first.state.uploaded, null);
  const variants = [
    files => change(files, PROXY, '<preFlow>', '<preFlow/><preFlow>'),
    files => files.set('APIProxy/APIProxyEndPoint/duplicate.xml', files.get(PROXY)),
    files => change(files, PROXY, '<sequence>2</sequence>', '<sequence>1</sequence>'),
    files => change(files, PROXY, '<policy_name>A</policy_name>', '<policy_name>A</policy_name><policy_name>A</policy_name>'),
    files => change(files, ROOT, '</policies>', '<policy type="Javascript">C</policy></policies>')
  ];
  for (const mutate of variants) {
    const content = fixture(); mutate(content);
    const { client, state } = await tenantFor(t, content);
    const result = await call(client, 'apim_edit_policy_steps', { ...request(content), steps: [{ policy_name: 'A' }] });
    assert.equal(result.isError, true);
    assert.equal(state.uploaded, null);
  }
  const duplicate = await call(first.client, 'apim_edit_policy_steps', { ...request(files), steps: [{ policy_name: 'A' }, { policy_name: 'A' }] });
  assert.equal(duplicate.isError, true);
  assert.equal(first.state.uploaded, null);
});

test('a stale old export after accepted import never verifies the requested assignments', async t => {
  const files = fixture();
  const { client, state, tenant } = await tenantFor(t, files, { stale: true });
  const result = parsed(await call(client, 'apim_edit_policy_steps', { ...request(files), steps: [{ policy_name: 'B' }, { policy_name: 'A' }] }));
  assert.equal(result.accepted, true);
  assert.equal(result.assignments_verified, false);
  assert.equal(result.updated, false);
  assert.equal(result.content_verified, false);
  assert.equal(result.runtime_verified, false);
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.state, 'DEPLOYED');
  assert.ok(state.uploaded);
  assert.equal(tenant.apiRequests().filter(req => req.method === 'POST').length, 1);
});

test('existing attach assignment updates only a supplied condition, and omission preserves it without duplication', async t => {
  const files = fixture();
  const { client, state } = await tenantFor(t, files);
  const attach = condition => call(client, 'apim_attach_api_proxy_policies', {
    name: 'Orders', policies: [{ name: 'A', template: 'verify_api_key', params: { key_ref: 'request.header.apikey' }, ...(condition === undefined ? {} : { condition }) }],
    confirmation: 'UPDATE API PROXY POLICIES Orders'
  });
  parsed(await attach('PRIVATE_UPDATED = "yes"'));
  assert.equal(assignments(state.uploaded)[0].condition, 'PRIVATE_UPDATED = "yes"');
  assert.deepEqual(assignments(state.uploaded).map(step => step.policy_name), ['A', 'B', 'C']);
  parsed(await attach());
  assert.equal(assignments(state.uploaded)[0].condition, 'PRIVATE_UPDATED = "yes"');
  parsed(await attach(''));
  assert.equal(assignments(state.uploaded)[0].condition, '');
  assert.deepEqual(assignments(state.uploaded).map(step => step.policy_name), ['A', 'B', 'C']);
});

test('policy-step registrar enumerates without a client or requests', () => {
  const names = [];
  registerApimPolicyStepTools(name => names.push(name), null);
  assert.deepEqual(names, ['apim_edit_policy_steps']);
});
