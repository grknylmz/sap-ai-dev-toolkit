// Explicit complete-order policy assignment edits; source and condition values stay private.
import { z } from 'zod';
import { editPolicySteps } from './apim-bundle.mjs';
import { exportApiProxyBundle, importApiProxyBundle } from './apim-content.mjs';
import { bundleDigest, writeBundle } from './iflow-bundle.mjs';
import { confirmation, requireConfirmation, OVERWRITE_ANNOTATIONS } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';

export function registerApimPolicyStepTools(register, client, { readBackDelayMs } = {}) {
  const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
  register('apim_edit_policy_steps', 'Edit API proxy policy steps',
    'Replace the complete ordered steps for one exact named proxy/target endpoint pre/post request/response phase. Requires the fresh exported bundle SHA-256; omitted step conditions preserve existing conditions (new steps are unconditional). Explicit remove_unreferenced deletes only unreferenced policy registrations/documents after a full static reference inventory, never shared scripts/resources. Ambiguous layouts fail before import. Import replaces the draft, imports a new revision and requests deployment. Content/order/condition verification is separate from runtime freshness. Requires confirmation exactly equal to EDIT API PROXY POLICY STEPS <name>.',
    z.object({
      name, expected_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      endpoint: z.enum(['proxy', 'target']), endpoint_name: name,
      flow: z.enum(['pre', 'post']), phase: z.enum(['request', 'response']),
      steps: z.array(z.object({ policy_name: name, condition: z.string().max(4096).optional() }).strict()).max(200),
      remove_unreferenced: z.array(name).max(200).optional(), confirmation
    }).strict(), OVERWRITE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `EDIT API PROXY POLICY STEPS ${args.name}`);
      const files = await exportApiProxyBundle(client, args.name);
      if (!files) throw new IntegrationError(`API proxy ${args.name} does not exist`);
      if (bundleDigest(files) !== args.expected_bundle_sha256) throw new IntegrationError('API proxy bundle changed; inspect the fresh bundle and approve its digest before editing policy steps');
      const assignments = editPolicySteps(files, args.name, args);
      // Shared import compares every member, including exact assignment XML, order and conditions.
      // A stale export therefore cannot verify an accepted import, even if runtime says DEPLOYED.
      const deployment = await importApiProxyBundle(client, args.name, writeBundle(files), { readBackDelayMs });
      return { ...deployment, updated: deployment.content_verified, assignments_verified: deployment.content_verified, ...assignments };
    });
}
