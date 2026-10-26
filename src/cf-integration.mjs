// Integration Suite credentials from the logged-in Cloud Foundry space: find the Process Integration
// Runtime (plan api) and API Management (plan apiportal-apiaccess) instances, reuse or create one
// named service key per instance, and optionally create a dedicated instance with the roles the tools need.
import { execFile as nodeExecFile } from 'node:child_process';
import { cfJson, runCf, serviceInstances, serviceKeyCredentials } from './cf-destination.mjs';

// Not the toolkit's destination-key prefix: the destination orphan sweep must not offer to delete these keys.
export const INTEGRATION_KEY_NAME = 'sap-ai-dev-integration';

export const INTEGRATION_CF_SERVICES = Object.freeze({
  CPI: Object.freeze({
    offering: 'it-rt',
    plan: 'api',
    label: 'Process Integration Runtime',
    dedicatedInstance: 'sap-ai-dev-integration-cpi',
    // Role templates of the Cloud Integration API plan covering design, deployment, monitoring,
    // security material and Partner Directory work done by the cpi_* tools.
    parameters: Object.freeze({
      'grant-types': ['client_credentials'],
      'redirect-uris': [],
      roles: ['AuthGroup_Administrator', 'AuthGroup_BusinessExpert', 'AuthGroup_IntegrationDeveloper', 'AuthGroup_TenantPartnerDirectoryConfigurator', 'AccessAllAccessPoliciesArtifacts']
    })
  }),
  APIM: Object.freeze({
    offering: 'apimanagement-apiportal',
    plan: 'apiportal-apiaccess',
    label: 'API Management, API portal',
    dedicatedInstance: 'sap-ai-dev-integration-apim',
    parameters: Object.freeze({ role: 'APIPortal.Administrator' })
  })
});

/** Integration Suite instances in the space, by side: { CPI: [{ guid, name }], APIM: [...] }. */
export async function findIntegrationInstances({ env = process.env, spaceGuid, execFileImpl = nodeExecFile } = {}) {
  const options = { env, execFileImpl };
  const plans = new Map();
  const found = { CPI: [], APIM: [] };
  for (const instance of await serviceInstances(spaceGuid, options)) {
    const planGuid = instance?.relationships?.service_plan?.data?.guid;
    if (!planGuid || !instance?.name) continue;
    if (!plans.has(planGuid)) {
      try {
        const plan = await cfJson(`/v3/service_plans/${encodeURIComponent(planGuid)}?include=service_offering`, options);
        plans.set(planGuid, { plan: plan?.name, offering: plan?.included?.service_offerings?.[0]?.name });
      } catch {
        plans.set(planGuid, {});
      }
    }
    const { plan, offering } = plans.get(planGuid);
    for (const [side, service] of Object.entries(INTEGRATION_CF_SERVICES)) {
      if (offering === service.offering && plan === service.plan) found[side].push({ guid: String(instance.guid), name: String(instance.name) });
    }
  }
  return found;
}

/** Credentials of the toolkit's service key on an instance; the key is created when it does not exist yet. */
export async function integrationServiceKey(instanceName, { env = process.env, execFileImpl = nodeExecFile } = {}) {
  const options = { env, execFileImpl };
  try {
    return { keyName: INTEGRATION_KEY_NAME, created: false, credentials: await serviceKeyCredentials(instanceName, INTEGRATION_KEY_NAME, 'Integration Suite', options) };
  } catch {
    // No readable key of that name yet.
  }
  await runCf(['create-service-key', instanceName, INTEGRATION_KEY_NAME, '--wait'], options);
  return { keyName: INTEGRATION_KEY_NAME, created: true, credentials: await serviceKeyCredentials(instanceName, INTEGRATION_KEY_NAME, 'Integration Suite', options) };
}

/** Create the dedicated instance for a side with the roles the tools need; returns { guid?, name }. */
export async function createIntegrationInstance(side, { env = process.env, execFileImpl = nodeExecFile } = {}) {
  const service = INTEGRATION_CF_SERVICES[side];
  await runCf(['create-service', service.offering, service.plan, service.dedicatedInstance, '-c', JSON.stringify(service.parameters), '--wait'], { env, execFileImpl });
  return { name: service.dedicatedInstance };
}
