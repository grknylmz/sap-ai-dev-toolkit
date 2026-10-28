import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const BASE = '/apiportal/api/1.0/Management.svc';

async function fixture(t, { products = {}, proxies = {}, applicationCounts = {}, retainDeleted = false, failDelete = false, pageSize = 2, completeCounts = true, orphanDeployment = false } = {}) {
  const state = { products: new Map(Object.entries(products)), proxies: new Map(Object.entries(proxies)), deletes: [] };
  const tenant = await startFakeTenant(t, request => {
    const relative = request.path.slice(BASE.length);
    const proxy = /^\/APIProxies\('([^']+)'\)(.*)$/.exec(relative);
    const product = /^\/APIProducts\('([^']+)'\)(.*)$/.exec(relative);
    const named = proxy ?? product;
    if (named) {
      const [, name, suffix] = named;
      const objects = proxy ? state.proxies : state.products;
      if (request.method === 'GET') {
        if (!objects.has(name)) return { status: 404 };
        if (suffix === '/applications/$count') return { status: 200, body: String(applicationCounts[name] ?? 0) };
        if (suffix === '/apiProducts/$count') return { status: 200, body: String([...state.products.values()].filter(members => members.includes(name)).length) };
        if (suffix === '/apiProducts') {
          const all = [...state.products].filter(([, members]) => members.includes(name)).map(([name]) => ({ name })).sort((a, b) => a.name.localeCompare(b.name));
          const skip = Number(request.query.get('$skip') ?? 0);
          return { status: 200, json: { d: { results: all.slice(skip, skip + pageSize), ...(completeCounts ? { __count: String(all.length) } : {}) } } };
        }
        if (suffix) return { status: 404 };
        return { status: 200, json: { d: proxy ? { name, state: objects.get(name) } : { name, isPublished: true, status_code: 'PUBLISHED' } } };
      }
      if (request.method === 'DELETE' && !suffix) {
        state.deletes.push({ kind: proxy ? 'proxy' : 'product', name });
        if (failDelete) return { status: 500, json: { error: { message: { value: 'Backend refused deletion' } } } };
        if (product && applicationCounts[name]) return { status: 409 };
        if (proxy && [...state.products.values()].some(members => members.includes(name))) return { status: 409 };
        if (!retainDeleted) objects.delete(name);
        return { status: retainDeleted ? 202 : 204 };
      }
    }
    if (request.method === 'GET' && relative === '/APIProxyDeployments/$count') {
      const name = /name eq '([^']+)'/.exec(request.query.get('$filter') ?? '')?.[1];
      return { status: 200, body: String(orphanDeployment || state.proxies.get(name) === 'DEPLOYED' ? 1 : 0) };
    }
    return { status: 500 };
  });
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-delete-test', APIM_SERVICE_KEY: tenant.serviceKey() }, readBackDelayMs: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'delete-test', version: '1' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content[0].text;
    return { isError: response.isError === true, value: response.isError ? null : JSON.parse(text) };
  };
  return { state, tenant, call };
}

test('deleting a published product preserves its proxy and requires confirmation before reads', async t => {
  const { state, tenant, call } = await fixture(t, { products: { OldProduct: ['OldProxy'] }, proxies: { OldProxy: 'DEPLOYED' } });
  assert.equal((await call('apim_delete_api_product', { name: 'OldProduct', confirmation: 'wrong' })).isError, true);
  assert.equal(tenant.requests.length, 0);
  const result = await call('apim_delete_api_product', { name: 'OldProduct', confirmation: 'DELETE API PRODUCT OldProduct' });
  assert.equal(result.isError, false);
  assert.equal(result.value.deleted, true);
  assert.equal(result.value.deletion_verified, true);
  assert.equal(state.products.has('OldProduct'), false);
  assert.equal(state.proxies.get('OldProxy'), 'DEPLOYED');
});

test('application associations block product deletion without changing subscriptions', async t => {
  const { state, call } = await fixture(t, { products: { UsedProduct: ['OldProxy'] }, applicationCounts: { UsedProduct: 2 } });
  assert.equal((await call('apim_delete_api_product', { name: 'UsedProduct', confirmation: 'DELETE API PRODUCT UsedProduct' })).isError, true);
  assert.equal(state.products.has('UsedProduct'), true);
  assert.deepEqual(state.deletes, []);
});

test('proxy deletion requires removal of product dependencies and explicit deployed permission', async t => {
  const { state, call } = await fixture(t, { products: { OldProduct: ['OldProxy'] }, proxies: { OldProxy: 'DEPLOYED' } });
  const args = { name: 'OldProxy', confirmation: 'DELETE API PROXY OldProxy' };
  assert.equal((await call('apim_delete_api_proxy', { ...args, allow_deployed: true })).isError, true);
  assert.equal(state.proxies.has('OldProxy'), true);
  assert.deepEqual(state.deletes, []);
  assert.equal((await call('apim_delete_api_product', { name: 'OldProduct', confirmation: 'DELETE API PRODUCT OldProduct' })).isError, false);
  assert.equal((await call('apim_delete_api_proxy', args)).isError, true);
  assert.equal(state.proxies.get('OldProxy'), 'DEPLOYED');
  const result = await call('apim_delete_api_proxy', { ...args, allow_deployed: true });
  assert.equal(result.isError, false);
  assert.equal(result.value.deleted, true);
  assert.equal(result.value.deletion_verified, true);
  assert.equal(state.proxies.has('OldProxy'), false);
});

test('bulk cleanup follows complete dependency pages before deleting products then proxy', async t => {
  const { state, call } = await fixture(t, { products: { AProduct: ['OldProxy'], BProduct: ['OldProxy'], ZProduct: ['OldProxy'] }, proxies: { OldProxy: 'UNDEPLOYED' } });
  const args = { products: ['AProduct', 'BProduct', 'ZProduct'], proxies: ['OldProxy'] };
  const preview = await call('apim_cleanup_api_objects', args);
  assert.equal(preview.isError, false);
  assert.equal(preview.value.preflight_ok, true);
  assert.deepEqual(state.deletes, []);
  const result = await call('apim_cleanup_api_objects', { ...args, dry_run: false, confirmation: preview.value.required_confirmation });
  assert.equal(result.value.complete, true);
  assert.deepEqual(state.deletes, [{ kind: 'product', name: 'AProduct' }, { kind: 'product', name: 'BProduct' }, { kind: 'product', name: 'ZProduct' }, { kind: 'proxy', name: 'OldProxy' }]);
  assert.equal(state.proxies.size, 0);
});

test('incomplete dependency reads prevent every batch mutation', async t => {
  const { state, call } = await fixture(t, { products: { OldProduct: ['OldProxy'] }, proxies: { OldProxy: 'UNDEPLOYED' }, completeCounts: false });
  const args = { products: ['OldProduct'], proxies: ['OldProxy'] };
  const preview = await call('apim_cleanup_api_objects', args);
  assert.equal(preview.value.preflight_ok, false);
  const result = await call('apim_cleanup_api_objects', { ...args, dry_run: false, confirmation: preview.value.required_confirmation });
  assert.equal(result.value.complete, false);
  assert.deepEqual(state.deletes, []);
  assert.equal(state.products.has('OldProduct'), true);
});

test('an accepted deletion is not reported as verified when the object remains', async t => {
  const { state, call } = await fixture(t, { products: { OldProduct: [] }, retainDeleted: true });
  const result = await call('apim_delete_api_product', { name: 'OldProduct', confirmation: 'DELETE API PRODUCT OldProduct' });
  assert.equal(result.isError, false);
  assert.equal(result.value.deleted, false);
  assert.equal(result.value.pending, true);
  assert.equal(result.value.deletion_verified, false);
  assert.equal(state.products.has('OldProduct'), true);
  assert.equal(state.deletes.length, 1);
});

test('failed deletion is not automatically retried', async t => {
  const { state, call } = await fixture(t, { products: { OldProduct: [] }, failDelete: true });
  assert.equal((await call('apim_delete_api_product', { name: 'OldProduct', confirmation: 'DELETE API PRODUCT OldProduct' })).isError, true);
  assert.equal(state.products.has('OldProduct'), true);
  assert.equal(state.deletes.length, 1);
});

test('an orphan runtime deployment is not reported already absent', async t => {
  const { call } = await fixture(t, { orphanDeployment: true });
  const result = await call('apim_delete_api_proxy', { name: 'OldProxy', confirmation: 'DELETE API PROXY OldProxy' });
  assert.equal(result.isError, true);
});
