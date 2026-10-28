// Integration Suite credentials from the logged-in Cloud Foundry space: find the Process Integration
// Runtime (plan api), API Management (plan apiportal-apiaccess) and Developer Hub (devportal-apiaccess) instances;
// reuse or create a named service key, and optionally create a dedicated instance with the roles the tools need.
import { execFile as nodeExecFile } from 'node:child_process';
import { cfJson, getCloudFoundryTarget, runCf, serviceInstances, serviceKeyCredentials } from './cf-destination.mjs';

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
  }),
  DEVHUB: Object.freeze({
    // SAP-samples/btp-service-metadata v1 inventory identifies this Developer Hub CF service offering.
    offering: 'apimanagement-devportal',
    plan: 'devportal-apiaccess',
    label: 'API Management, Developer Hub',
    dedicatedInstance: 'sap-ai-dev-integration-devhub',
    parameters: Object.freeze({ role: 'AuthGroup.API.Admin' })
  })
});

/** Integration Suite instances in the space, by side: { CPI: [...], APIM: [...], DEVHUB: [...] }. */
export async function findIntegrationInstances({ env = process.env, spaceGuid, execFileImpl = nodeExecFile } = {}) {
  const options = { env, execFileImpl };
  const plans = new Map();
  const found = { CPI: [], APIM: [], DEVHUB: [] };
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

/** Create a dedicated instance only from a plan visible in the targeted CF space. */
export async function createIntegrationInstance(side, { env = process.env, execFileImpl = nodeExecFile } = {}) {
  const service = INTEGRATION_CF_SERVICES[side];
  const options = { env, execFileImpl };
  const target = await getCloudFoundryTarget(options);
  if (!target.available) throw new Error(target.reason);
  const query = `/v3/service_plans?names=${encodeURIComponent(service.plan)}&include=service_offering`;
  const matchingPlans = payload => (payload.resources || []).filter(plan =>
    payload.included?.service_offerings?.some(offering =>
      offering.guid === plan.relationships?.service_offering?.data?.guid && offering.name === service.offering));
  const scoped = await cfJson(`${query}&space_guids=${encodeURIComponent(target.spaceGuid)}&available=true`, options);
  const plans = matchingPlans(scoped);
  if (!plans.length) {
    const catalog = await cfJson(query, options);
    const scopes = [];
    for (const plan of matchingPlans(catalog)) {
      try {
        const visibility = await cfJson(`/v3/service_plans/${encodeURIComponent(plan.guid)}/visibility`, options);
        scopes.push(...(visibility.organizations || []).map(org => org.name || org.guid));
      } catch {
        scopes.push('visibility details unavailable');
      }
    }
    const detail = scopes.length ? ` Catalog organization visibility: ${[...new Set(scopes)].join(', ')}.` : ' No matching plan is visible in the catalog.';
    throw new Error(`${service.offering}/${service.plan} is not available in ${target.orgName} / ${target.spaceName}.${detail} Assign the entitlement to the intended subaccount. No instance was created.`);
  }
  if (plans.length !== 1) throw new Error(`Multiple ${service.offering}/${service.plan} plans are visible in ${target.orgName} / ${target.spaceName}; broker selection is ambiguous. No instance was created.`);
  const offering = scoped.included.service_offerings.find(item => item.guid === plans[0].relationships.service_offering.data.guid);
  const brokerGuid = offering.relationships?.service_broker?.data?.guid;
  if (!brokerGuid) throw new Error('The visible service offering has no broker reference. No instance was created.');
  // Broker names are visible through offering fields even when broker-admin details are hidden.
  const projected = await cfJson(`/v3/service_offerings/${encodeURIComponent(offering.guid)}?fields[service_broker]=guid,name`, options);
  const broker = projected.included?.service_brokers?.find(item => item.guid === brokerGuid);
  if (!broker?.name) throw new Error('The visible service broker has no accessible name. No instance was created.');
  await runCf(['create-service', service.offering, service.plan, service.dedicatedInstance, '-b', broker.name, '-c', JSON.stringify(service.parameters), '--wait'], options);
  return { name: service.dedicatedInstance };
}
