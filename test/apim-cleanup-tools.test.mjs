import test from 'node:test';
import assert from 'node:assert/strict';
import { registerApimCleanupTools } from '../src/apim-cleanup-tools.mjs';
import { IntegrationError } from '../src/integration-http.mjs';

const SECRET = 'private-client-secret-never-return';
const HOST = 'https://user:password@private-tenant.example';

// A small mutable APIM domain: product membership and application subscriptions
// determine dependencies, and deletion operations recheck the current domain.
function domain({ products = {}, proxies = {}, applications = {} } = {}) {
  const state = {
    products: new Map(Object.entries(products).map(([name, members]) => [name, [...members]])),
    proxies: new Map(Object.entries(proxies).map(([name, lifecycle]) => [name, { state: lifecycle }])),
    applications: new Map(Object.entries(applications)),
    providers: new Set(['SharedProvider']),
    kvms: new Set(['SharedCredentials']),
    reads: [], mutations: [], inspectionErrors: new Set(), deletionErrors: new Set(), outcomes: new Map(),
    beforeDelete: null
  };
  const productApps = name => [...state.applications].filter(([, members]) => members.includes(name)).map(([app]) => app);
  const proxyProducts = name => [...state.products].filter(([, members]) => members.includes(name)).map(([product]) => product);
  const secrets = { host: HOST, password: SECRET, nested: { clientSecret: SECRET } };
  const before = async (kind, name) => {
    const id = `${kind}:${name}`;
    state.mutations.push(id);
    await state.beforeDelete?.(kind, name);
    if (state.deletionErrors.has(id)) throw new IntegrationError(`Deletion failed at ${HOST}: ${SECRET}`);
    return id;
  };
  const operations = {
    async inspectProduct(name) {
      state.reads.push(`product:${name}`);
      if (state.inspectionErrors.has(`product:${name}`)) throw new IntegrationError(`Cannot read ${HOST}: ${SECRET}`);
      return state.products.has(name) ? { name, blockingApplicationCount: productApps(name).length, ...secrets } : null;
    },
    async inspectProxy(name) {
      state.reads.push(`proxy:${name}`);
      if (state.inspectionErrors.has(`proxy:${name}`)) throw new IntegrationError(`Cannot read ${HOST}: ${SECRET}`);
      return state.proxies.has(name)
        ? { name, ...state.proxies.get(name), blockingProducts: proxyProducts(name), ...secrets } : null;
    },
    async deleteProduct(name) {
      const id = await before('product', name);
      if (!state.products.has(name)) return { already_absent: true, ...secrets };
      if (productApps(name).length) throw new IntegrationError('Application dependency appeared');
      if (state.outcomes.has(id)) return state.outcomes.get(id);
      state.products.delete(name);
      return { deleted: true, ...secrets };
    },
    async deleteProxy(name, { allow_deployed }) {
      const id = await before('proxy', name);
      if (!state.proxies.has(name)) return { already_absent: true, ...secrets };
      if (proxyProducts(name).length) throw new IntegrationError('Product dependency appeared');
      if (state.proxies.get(name).state === 'DEPLOYED' && !allow_deployed) throw new IntegrationError('Still deployed');
      if (state.outcomes.has(id)) {
        state.proxies.get(name).state = 'DELETING';
        return state.outcomes.get(id);
      }
      state.proxies.delete(name);
      return { deleted: true, ...secrets };
    }
  };
  let execute;
  registerApimCleanupTools((_name, _title, _description, _schema, _annotations, handler) => {
    execute = handler;
  }, operations);
  return { state, operations, execute };
}

const statuses = result => [...result.products, ...result.proxies].map(({ name, status }) => [name, status]);
const approved = (preview, args) => ({ ...args, dry_run: false, confirmation: preview.required_confirmation });

function noSecrets(result) {
  const output = JSON.stringify(result);
  assert.equal(output.includes(SECRET), false);
  assert.equal(output.includes(HOST), false);
  assert.equal(output.includes('password'), false);
  assert.equal(output.includes('clientSecret'), false);
}

test('default dry-run preflights every explicit target, reports absence and never mutates', async () => {
  const { state, execute } = domain({
    products: { OldProduct: ['OldProxy'], KeepProduct: ['KeepProxy'] },
    proxies: { OldProxy: 'UNDEPLOYED', KeepProxy: 'DEPLOYED' },
    applications: { KeepApp: ['KeepProduct'] }
  });
  const result = await execute({ products: ['OldProduct', 'AbsentProduct'], proxies: ['OldProxy', 'AbsentProxy'] });
  assert.equal(result.dry_run, true);
  assert.equal(result.allow_deployed, false);
  assert.equal(result.complete, false);
  assert.equal(result.preflight_ok, true);
  assert.deepEqual(statuses(result), [
    ['AbsentProduct', 'already_absent'], ['OldProduct', 'ready'],
    ['AbsentProxy', 'already_absent'], ['OldProxy', 'ready']
  ]);
  assert.deepEqual(state.reads, ['product:AbsentProduct', 'product:OldProduct', 'proxy:AbsentProxy', 'proxy:OldProxy']);
  assert.deepEqual(state.mutations, []);
  assert.equal(state.products.size, 2);
  assert.equal(state.proxies.size, 2);
  noSecrets(result);
});

test('exact-set approval uses canonical sorted lists and deployment permission', async () => {
  const { state, execute } = domain({
    products: { ZProduct: ['OldProxy'], AProduct: [] }, proxies: { OldProxy: 'DEPLOYED' }
  });
  const args = { products: ['ZProduct', 'AProduct'], proxies: ['OldProxy'], allow_deployed: true };
  const preview = await execute(args);
  assert.equal(preview.preflight_ok, true);
  const result = await execute(approved(preview, { ...args, products: ['AProduct', 'ZProduct'] }));
  assert.equal(result.complete, true);
  assert.deepEqual(statuses(result), [['AProduct', 'deleted'], ['ZProduct', 'deleted'], ['OldProxy', 'deleted']]);
  assert.deepEqual(state.mutations, ['product:AProduct', 'product:ZProduct', 'proxy:OldProxy']);
  assert.equal(state.products.size, 0);
  assert.equal(state.proxies.size, 0);
});

test('altered targets or allow_deployed invalidate approval before any read', async () => {
  const { state, execute } = domain({ products: { OldProduct: [] }, proxies: { OldProxy: 'UNDEPLOYED' } });
  const args = { products: ['OldProduct'], proxies: ['OldProxy'] };
  const preview = await execute(args);
  state.reads.length = 0;
  for (const change of [
    { products: ['OldProduct', 'ExtraProduct'] }, { products: [] },
    { proxies: ['OldProxy', 'ExtraProxy'] }, { proxies: [] }, { allow_deployed: true },
    { confirmation: 'DELETE APIM OBJECTS wrong' }
  ]) {
    await assert.rejects(execute({ ...approved(preview, args), ...change }), /confirmation must equal DELETE APIM OBJECTS [a-f0-9]{64}/);
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.mutations, []);
  }
  await assert.rejects(execute({ ...args, dry_run: false }), /confirmation must equal/);
  assert.deepEqual(state.reads, []);
});

test('unselected cross-product dependency blocks the whole batch without cascading', async () => {
  const { state, execute } = domain({
    products: { Selected: ['OldProxy'], Unrelated: ['OldProxy'] }, proxies: { OldProxy: 'UNDEPLOYED' }
  });
  const args = { products: ['Selected'], proxies: ['OldProxy'] };
  const preview = await execute(args);
  assert.equal(preview.preflight_ok, false);
  assert.deepEqual(preview.proxies[0].blockers, [{ code: 'product_dependencies', count: 1 }]);
  const result = await execute(approved(preview, args));
  assert.equal(result.complete, false);
  assert.deepEqual(statuses(result), [['Selected', 'not_attempted'], ['OldProxy', 'blocked']]);
  assert.deepEqual(state.mutations, []);
  assert.deepEqual([...state.products.keys()], ['Selected', 'Unrelated']);
});

test('selected unblocked dependent product is deleted before proxy; unrelated objects remain', async () => {
  const { state, execute } = domain({
    products: { OldProduct: ['OldProxy'], KeepProduct: ['KeepProxy'] },
    proxies: { OldProxy: 'CREATED', KeepProxy: 'DEPLOYED' }, applications: { KeepApp: ['KeepProduct'] }
  });
  const args = { products: ['OldProduct'], proxies: ['OldProxy'] };
  const result = await execute(approved(await execute(args), args));
  assert.equal(result.complete, true);
  assert.deepEqual(state.mutations, ['product:OldProduct', 'proxy:OldProxy']);
  assert.deepEqual(statuses(result), [['OldProduct', 'deleted'], ['OldProxy', 'deleted']]);
  assert.ok(result.products[0].deletion_verified);
  assert.ok(result.proxies[0].deletion_verified);
  assert.deepEqual([...state.products], [['KeepProduct', ['KeepProxy']]]);
  assert.deepEqual([...state.proxies.keys()], ['KeepProxy']);
  assert.deepEqual([...state.applications], [['KeepApp', ['KeepProduct']]]);
  assert.deepEqual([...state.providers], ['SharedProvider']);
  assert.deepEqual([...state.kvms], ['SharedCredentials']);
  noSecrets(result);
});

test('selected product application dependency also blocks its selected proxy and all other mutations', async () => {
  const { state, execute } = domain({
    products: { BlockedProduct: ['OldProxy'], SafeProduct: [] }, proxies: { OldProxy: 'UNDEPLOYED' },
    applications: { SubscribedApp: ['BlockedProduct'] }
  });
  const args = { products: ['SafeProduct', 'BlockedProduct'], proxies: ['OldProxy'] };
  const preview = await execute(args);
  assert.equal(preview.preflight_ok, false);
  assert.deepEqual(preview.products[0].blockers, [{ code: 'application_dependencies', count: 1 }]);
  assert.deepEqual(preview.proxies[0].blockers, [{ code: 'product_dependencies', count: 1 }]);
  const result = await execute(approved(preview, args));
  assert.deepEqual(statuses(result), [['BlockedProduct', 'blocked'], ['SafeProduct', 'not_attempted'], ['OldProxy', 'blocked']]);
  assert.deepEqual(state.mutations, []);
  assert.equal(state.applications.size, 1);
});

test('inspection failure still preflights every object and prevents all mutations without leaking errors', async () => {
  const { state, execute } = domain({ products: { AProduct: [], ZProduct: [] }, proxies: { OldProxy: 'UNDEPLOYED' } });
  state.inspectionErrors.add('product:AProduct');
  const args = { products: ['AProduct', 'ZProduct'], proxies: ['OldProxy'] };
  const preview = await execute(args);
  state.reads.length = 0;
  const result = await execute(approved(preview, args));
  assert.equal(result.preflight_ok, false);
  assert.equal(result.complete, false);
  assert.deepEqual(state.reads, ['product:AProduct', 'product:ZProduct', 'proxy:OldProxy']);
  assert.deepEqual(statuses(result), [['AProduct', 'failed'], ['ZProduct', 'not_attempted'], ['OldProxy', 'not_attempted']]);
  assert.deepEqual(result.products[0].blockers, [{ code: 'inspection_failed' }]);
  assert.deepEqual(state.mutations, []);
  noSecrets(result);
});

test('deployed proxy requires explicit permission; unknown and transitional states always block', async () => {
  const deployed = domain({ proxies: { OldProxy: 'DEPLOYED' } });
  const preview = await deployed.execute({ proxies: ['OldProxy'] });
  assert.equal(preview.preflight_ok, false);
  assert.deepEqual(preview.proxies[0].blockers, [{ code: 'deployed_requires_approval' }]);
  const blocked = await deployed.execute(approved(preview, { proxies: ['OldProxy'] }));
  assert.equal(blocked.complete, false);
  assert.deepEqual(deployed.state.mutations, []);
  const allowed = { proxies: ['OldProxy'], allow_deployed: true };
  const result = await deployed.execute(approved(await deployed.execute(allowed), allowed));
  assert.equal(result.complete, true);
  assert.equal(deployed.state.proxies.size, 0);

  for (const lifecycle of [undefined, null, '', 'UNKNOWN', 'DEPLOYING', 'DELETING', 'deployed', SECRET]) {
    const { state, execute } = domain({ proxies: { OldProxy: lifecycle } });
    const args = { proxies: ['OldProxy'], allow_deployed: true };
    const plan = await execute(args);
    assert.deepEqual(plan.proxies[0].blockers, [{ code: 'unknown_lifecycle_state' }]);
    const outcome = await execute(approved(plan, args));
    assert.equal(outcome.complete, false);
    assert.deepEqual(state.mutations, []);
    noSecrets(outcome);
  }
});

test('mid-batch error preserves verified partial state and stops every later deletion', async () => {
  const { state, execute } = domain({
    products: { AProduct: [], BProduct: [], CProduct: [] }, proxies: { OldProxy: 'UNDEPLOYED' }
  });
  state.deletionErrors.add('product:BProduct');
  const args = { products: ['CProduct', 'BProduct', 'AProduct'], proxies: ['OldProxy'] };
  const result = await execute(approved(await execute(args), args));
  assert.equal(result.preflight_ok, true);
  assert.equal(result.complete, false);
  assert.deepEqual(statuses(result), [
    ['AProduct', 'deleted'], ['BProduct', 'failed'], ['CProduct', 'not_attempted'], ['OldProxy', 'not_attempted']
  ]);
  assert.equal(result.products[0].deletion_verified, true);
  assert.equal(result.products[1].deletion_verified, false);
  assert.deepEqual(state.mutations, ['product:AProduct', 'product:BProduct']);
  assert.equal(state.products.has('AProduct'), false);
  assert.equal(state.products.has('BProduct'), true);
  assert.equal(state.proxies.has('OldProxy'), true);
  noSecrets(result);
});

test('delete callback revalidation catches dependencies appearing after preflight', async () => {
  const { state, execute } = domain({ products: { OldProduct: ['OldProxy'] }, proxies: { OldProxy: 'UNDEPLOYED' } });
  const args = { products: ['OldProduct'], proxies: ['OldProxy'] };
  state.beforeDelete = (kind, name) => {
    if (kind === 'product') state.applications.set('NewSubscription', [name]);
  };
  const result = await execute(approved(await execute(args), args));
  assert.equal(result.preflight_ok, true);
  assert.equal(result.complete, false);
  assert.deepEqual(statuses(result), [['OldProduct', 'failed'], ['OldProxy', 'not_attempted']]);
  assert.deepEqual(state.mutations, ['product:OldProduct']);
  assert.equal(state.products.has('OldProduct'), true);
  assert.equal(state.proxies.has('OldProxy'), true);
});

test('pending, unknown and contradictory deletion outcomes never count as verified success or retry', async () => {
  for (const outcome of [undefined, null, {}, { pending: true }, { deleted: false }, { status: 'pending' },
    { already_absent: false }, { deleted: true, verified: false }, { deleted: true, deletion_verified: false },
    { deleted: true, already_absent: true }, { already_absent: true, pending: true }]) {
    const { state, execute } = domain({ proxies: { AProxy: 'UNDEPLOYED', ZProxy: 'UNDEPLOYED' } });
    state.outcomes.set('proxy:AProxy', outcome);
    const args = { proxies: ['AProxy', 'ZProxy'] };
    const result = await execute(approved(await execute(args), args));
    assert.equal(result.complete, false);
    assert.deepEqual(statuses(result), [['AProxy', 'failed'], ['ZProxy', 'not_attempted']]);
    assert.deepEqual(result.proxies[0].blockers, [{ code: 'deletion_unverified' }]);
    assert.equal(result.proxies[0].deletion_verified, false);
    assert.deepEqual(state.mutations, ['proxy:AProxy']);
    assert.equal(state.proxies.get('AProxy').state, 'DELETING');
    assert.equal(state.proxies.get('ZProxy').state, 'UNDEPLOYED');
  }
});

test('already-absent targets and objects disappearing during execution are not claimed as deletions', async () => {
  const { state, execute } = domain({ products: { OldProduct: [] }, proxies: { OldProxy: 'UNDEPLOYED' } });
  const args = { products: ['OldProduct', 'MissingProduct'], proxies: ['OldProxy', 'MissingProxy'] };
  state.beforeDelete = (kind, name) => {
    if (kind === 'product') state.products.delete(name);
    else state.proxies.delete(name);
  };
  const result = await execute(approved(await execute(args), args));
  assert.equal(result.complete, true);
  assert.deepEqual(statuses(result), [
    ['MissingProduct', 'already_absent'], ['OldProduct', 'already_absent'],
    ['MissingProxy', 'already_absent'], ['OldProxy', 'already_absent']
  ]);
  assert.deepEqual(state.mutations, ['product:OldProduct', 'proxy:OldProxy']);
  assert.equal(result.products.some(entry => entry.deletion_verified === true), false);
  noSecrets(result);
});

test('duplicate names, wildcard discovery, extra fields and invalid target sizes fail before reads', async () => {
  const { state, execute } = domain();
  for (const args of [
    {}, { products: [] }, { products: ['OldProduct', 'OldProduct'] }, { proxies: ['OldProxy', 'OldProxy'] },
    { products: ['Old*'] }, { proxies: ['*'] }, { proxies: ['https://private.example'] },
    { products: ['_Invalid'] }, { proxies: ['Invalid.Name'] }, { products: ['A'.repeat(101)] },
    { products: ['OldProduct'], force: true }, { proxies: ['OldProxy'], cascade: true },
    { products: Array.from({ length: 101 }, (_, i) => `Product${i}`) },
    { proxies: Array.from({ length: 101 }, (_, i) => `Proxy${i}`) }
  ]) {
    await assert.rejects(execute(args), error => error.name === 'ZodError');
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.mutations, []);
  }
  const valid = {
    products: Array.from({ length: 100 }, (_, i) => `Product${i}`),
    proxies: Array.from({ length: 100 }, (_, i) => `Proxy${i}`)
  };
  const result = await execute(valid);
  assert.equal(result.preflight_ok, true);
  assert.equal(state.reads.length, 200);
  assert.deepEqual(state.mutations, []);
});

test('malformed inspection results cannot bypass conservative preflight', async () => {
  const { state, operations, execute } = domain({ proxies: { OldProxy: 'UNDEPLOYED' } });
  operations.inspectProduct = async () => ({ name: 'OtherProduct', blockingApplicationCount: 0, password: SECRET });
  operations.inspectProxy = async () => ({ name: 'OldProxy', state: 'UNDEPLOYED', blockingProducts: null });
  const args = { products: ['OldProduct'], proxies: ['OldProxy'] };
  const preview = await execute(args);
  const result = await execute(approved(preview, args));
  assert.equal(result.preflight_ok, false);
  assert.deepEqual(statuses(result), [['OldProduct', 'failed'], ['OldProxy', 'failed']]);
  assert.deepEqual(result.products[0].blockers, [{ code: 'invalid_inspection' }]);
  assert.deepEqual(state.mutations, []);
  noSecrets(result);
});
