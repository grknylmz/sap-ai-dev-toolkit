// Native APIM object deletion. Never cascade to consumers, providers or credentials.
import { z } from 'zod';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { confirmation, entity, key, list, OVERWRITE_ANNOTATIONS, requireConfirmation, sleep } from './integration-common.mjs';
import { registerApimCleanupTools } from './apim-cleanup-tools.mjs';

const apimName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const INACTIVE_STATES = new Set(['CREATED', 'UNDEPLOYED']);
const MAX_DEPENDENCIES = 1000;

export function registerApimDeleteTools(register, { request, readBackDelayMs = 5000 }) {
  const pathFor = (collection, name) => `/${collection}(${key(name)})`;

  async function named(collection, name) {
    const { status, data } = await request('GET', pathFor(collection, name), { expect: [200, 404], withStatus: true });
    if (status === 404) return null;
    const value = entity(data);
    if (value?.name !== name) throw new IntegrationError(`Cannot establish the identity of ${collection} ${name}; deletion refused`);
    return value;
  }

  async function count(path, query) {
    const text = await request('GET', `${path}/$count`, { query, accept: 'text/plain', responseType: 'text' });
    if (typeof text !== 'string' || !/^\s*\d+\s*$/.test(text)) throw new IntegrationError('Invalid dependency count; deletion refused');
    const value = Number(text.trim());
    if (!Number.isSafeInteger(value)) throw new IntegrationError('Unsafe dependency count; deletion refused');
    return value;
  }

  const deployments = name => count('/APIProxyDeployments', { $filter: `name eq ${odataKey(name)}` });

  async function productDependencies(name) {
    const path = `${pathFor('APIProxies', name)}/apiProducts`;
    const names = new Set();
    let expected = null;
    let offset = 0;
    do {
      const raw = await request('GET', path, {
        query: { $select: 'name', $orderby: 'name', $top: 100, $skip: offset, $inlinecount: 'allpages' }, unwrap: false
      });
      const page = raw?.d ?? raw;
      const total = typeof page?.__count === 'string' && /^\d+$/.test(page.__count) ? Number(page.__count) : NaN;
      if (!Number.isSafeInteger(total) || total > MAX_DEPENDENCIES || (expected !== null && total !== expected)) {
        throw new IntegrationError('Cannot establish a complete stable product dependency list; deletion refused');
      }
      expected = total;
      const rows = list(page);
      if (!Array.isArray(page?.results) || (rows.length === 0 && names.size < expected)) {
        throw new IntegrationError('Incomplete product dependency page; deletion refused');
      }
      for (const row of rows) {
        if (typeof row?.name !== 'string' || !row.name || names.has(row.name)) {
          throw new IntegrationError('Invalid or repeated product dependency; deletion refused');
        }
        names.add(row.name);
      }
      if (names.size > expected) throw new IntegrationError('Product dependencies changed during inspection; deletion refused');
      offset += rows.length;
    } while (names.size < expected);
    if (await count(path) !== expected) throw new IntegrationError('Product dependencies changed during inspection; deletion refused');
    return [...names];
  }

  async function inspectProduct(name) {
    if (!(await named('APIProducts', name))) return null;
    return { name, blockingApplicationCount: await count(`${pathFor('APIProducts', name)}/applications`) };
  }

  async function inspectProxy(name) {
    const proxy = await named('APIProxies', name);
    if (!proxy) {
      if (await deployments(name)) throw new IntegrationError(`API proxy ${name} has no definition but still has deployment records; deletion is unverified`);
      return null;
    }
    return { name, state: proxy.state, blockingProducts: await productDependencies(name) };
  }

  async function remove(collection, name) {
    const { status } = await request('DELETE', pathFor(collection, name), {
      expect: [200, 202, 204, 404], responseType: 'text', withStatus: true
    });
    // A successful HTTP response is not proof of deletion. Never retry DELETE.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await sleep(readBackDelayMs);
      const definition = await named(collection, name);
      if (!definition && (collection !== 'APIProxies' || await deployments(name) === 0)) {
        return { name, ...(status === 404 ? { already_absent: true } : { deleted: true }), deletion_verified: true };
      }
    }
    return { name, deleted: false, deletion_verified: false, pending: true,
      note: 'Deletion is not yet verified: a definition or deployment record remains. Re-read before another deletion attempt.' };
  }

  async function deleteProduct(name) {
    const product = await inspectProduct(name);
    if (!product) return { name, already_absent: true, deletion_verified: true };
    if (product.blockingApplicationCount) {
      throw new IntegrationError(`API product ${name} is associated with ${product.blockingApplicationCount} application(s); deletion refused`);
    }
    return remove('APIProducts', name);
  }

  async function deleteProxy(name, { allow_deployed = false } = {}) {
    const proxy = await inspectProxy(name);
    if (!proxy) return { name, already_absent: true, deletion_verified: true };
    if (proxy.blockingProducts.length) {
      throw new IntegrationError(`API proxy ${name} is associated with ${proxy.blockingProducts.length} product(s); delete or disassociate those products first`);
    }
    if (proxy.state === 'DEPLOYED') {
      if (!allow_deployed) throw new IntegrationError(`API proxy ${name} is deployed; allow_deployed=true is required to approve runtime removal`);
    } else if (!INACTIVE_STATES.has(proxy.state)) {
      throw new IntegrationError(`API proxy ${name} has an unknown or transitional lifecycle state; deletion refused`);
    }
    return remove('APIProxies', name);
  }

  register('apim_delete_api_product', 'Delete API product',
    'Delete exactly one API product, including a published product, only when no application associations exist. '
      + 'Never detaches or deletes applications or proxies. Verifies named-object absence after DELETE. '
      + 'Requires confirmation exactly equal to DELETE API PRODUCT <name>.',
    z.object({ name: apimName, confirmation }).strict(), OVERWRITE_ANNOTATIONS,
    async ({ name, confirmation: approved }) => {
      requireConfirmation(approved, `DELETE API PRODUCT ${name}`);
      return deleteProduct(name);
    });

  register('apim_delete_api_proxy', 'Delete API proxy',
    'Delete exactly one API proxy after proving it has no product associations. '
      + 'Deployed proxies require allow_deployed=true to approve removal from runtime. '
      + 'Uses native deletion, never guessed undeploy endpoints; verifies definition and deployment-record absence. '
      + 'Never deletes providers, KVMs or credentials. Requires confirmation exactly equal to DELETE API PROXY <name>.',
    z.object({ name: apimName, allow_deployed: z.boolean().default(false), confirmation }).strict(), OVERWRITE_ANNOTATIONS,
    async ({ name, allow_deployed, confirmation: approved }) => {
      requireConfirmation(approved, `DELETE API PROXY ${name}`);
      return deleteProxy(name, { allow_deployed });
    });

  registerApimCleanupTools(register, { inspectProduct, inspectProxy, deleteProduct, deleteProxy });
}
