// Explicit-set APIM cleanup orchestration; native lifecycle operations are injected.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { confirmation, OVERWRITE_ANNOTATIONS, requireConfirmation } from './integration-common.mjs';

const APIM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const names = z.array(z.string().regex(APIM_NAME)).max(100)
  .refine(value => new Set(value).size === value.length, 'names must be unique').default([]);
const cleanupInput = z.object({
  products: names,
  proxies: names,
  allow_deployed: z.boolean().default(false),
  dry_run: z.boolean().default(true),
  confirmation: confirmation.optional()
}).strict().refine(value => value.products.length + value.proxies.length > 0, 'select at least one product or proxy')
  .refine(value => value.products.length + value.proxies.length <= 200, 'select at most 200 objects');

// Unknown and transitional states are never treated as safe inactive proxies.
const INACTIVE_STATES = new Set(['CREATED', 'UNDEPLOYED']);

function approvalFor(products, proxies, allow_deployed) {
  const digest = createHash('sha256').update(JSON.stringify({ products, proxies, allow_deployed })).digest('hex');
  return `DELETE APIM OBJECTS ${digest}`;
}

function validInspection(value, name, dependencyField) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== name) return false;
  const dependencies = value[dependencyField];
  return dependencyField === 'blockingApplicationCount'
    ? Number.isSafeInteger(dependencies) && dependencies >= 0
    : Array.isArray(dependencies) && dependencies.every(dependency => typeof dependency === 'string' && dependency.length > 0);
}

async function inspect(name, operation, dependencyField) {
  try {
    const value = await operation(name);
    if (value === null) return { entry: { name, status: 'already_absent', blockers: [] }, value: null };
    if (!validInspection(value, name, dependencyField)) {
      return { entry: { name, status: 'failed', blockers: [{ code: 'invalid_inspection' }] }, value: null };
    }
    return { entry: { name, status: 'ready', blockers: [] }, value };
  } catch {
    // Callback errors and complete tenant entities may contain hosts or credentials.
    return { entry: { name, status: 'failed', blockers: [{ code: 'inspection_failed' }] }, value: null };
  }
}

function verifiedOutcome(value) {
  if (!value || typeof value !== 'object' || value.pending === true || value.verified === false
    || value.deletion_verified === false) return null;
  if (value.deleted === true && value.already_absent !== true) return 'deleted';
  if (value.already_absent === true && value.deleted !== true) return 'already_absent';
  return null;
}

export function registerApimCleanupTools(register, operations) {
  register('apim_cleanup_api_objects', 'Clean up explicit API products and proxies',
    'Preflight explicit product/proxy lists (maximum 100 each, 200 total); dry_run defaults to true. '
      + 'Never discovers targets, cascades, or deletes providers, KVMs, applications or credentials. '
      + 'Products with application dependencies and proxies with unselected or blocked product dependencies block the entire batch. '
      + 'DEPLOYED proxies additionally require allow_deployed=true; unknown lifecycle states block cleanup. '
      + 'Execute only with the exact required_confirmation from a dry run of the same lists and allow_deployed value: '
      + 'DELETE APIM OBJECTS <SHA256 of JSON {products:sorted names,proxies:sorted names,allow_deployed}>. '
      + 'Deletes products first, stops at the first error or unverified result, and never retries. '
      + 'complete is true only after execution verifies every selected object deleted or already absent.',
    cleanupInput, OVERWRITE_ANNOTATIONS,
    async input => {
      const { products, proxies, allow_deployed, dry_run, confirmation: approved } = cleanupInput.parse(input);
      const productNames = [...products].sort();
      const proxyNames = [...proxies].sort();
      const required_confirmation = approvalFor(productNames, proxyNames, allow_deployed);
      // Approval is bound to the exact explicit set and deployment permission before any reads.
      if (!dry_run) requireConfirmation(approved, required_confirmation);

      const productEntries = [];
      for (const name of productNames) {
        const { entry, value } = await inspect(name, operations.inspectProduct, 'blockingApplicationCount');
        if (value?.blockingApplicationCount) {
          entry.status = 'blocked';
          entry.blockers.push({ code: 'application_dependencies', count: value.blockingApplicationCount });
        }
        productEntries.push(entry);
      }
      const selectedProducts = new Map(productEntries.map(entry => [entry.name, entry]));
      const proxyEntries = [];
      for (const name of proxyNames) {
        const { entry, value } = await inspect(name, operations.inspectProxy, 'blockingProducts');
        if (value) {
          const blocking = value.blockingProducts.filter(product => {
            const selected = selectedProducts.get(product);
            return !selected || !['ready', 'already_absent'].includes(selected.status);
          });
          if (blocking.length) {
            entry.blockers.push({ code: 'product_dependencies', count: blocking.length });
          }
          if (value.state === 'DEPLOYED') {
            if (!allow_deployed) entry.blockers.push({ code: 'deployed_requires_approval' });
          } else if (!INACTIVE_STATES.has(value.state)) {
            entry.blockers.push({ code: 'unknown_lifecycle_state' });
          }
          if (entry.blockers.length) entry.status = 'blocked';
        }
        proxyEntries.push(entry);
      }

      const all = [...productEntries, ...proxyEntries];
      const preflight_ok = all.every(entry => ['ready', 'already_absent'].includes(entry.status));
      const result = {
        dry_run, allow_deployed, required_confirmation, preflight_ok, complete: false,
        products: productEntries, proxies: proxyEntries
      };
      if (dry_run) return result;
      for (const entry of all) {
        if (entry.status === 'ready') entry.status = 'not_attempted';
      }
      if (!preflight_ok) return result;

      const queue = [
        ...productEntries.map(entry => ({ entry, remove: () => operations.deleteProduct(entry.name) })),
        ...proxyEntries.map(entry => ({ entry, remove: () => operations.deleteProxy(entry.name, { allow_deployed }) }))
      ];
      for (const { entry, remove } of queue) {
        if (entry.status === 'already_absent') continue;
        let outcome;
        try {
          outcome = verifiedOutcome(await remove());
        } catch {
          entry.status = 'failed';
          entry.blockers.push({ code: 'deletion_failed' });
          entry.deletion_verified = false;
          return result;
        }
        if (!outcome) {
          entry.status = 'failed';
          entry.blockers.push({ code: 'deletion_unverified' });
          entry.deletion_verified = false;
          return result;
        }
        entry.status = outcome;
        if (outcome === 'deleted') entry.deletion_verified = true;
      }
      result.complete = true;
      return result;
    });
}
