// MCP tools for SAP BTP core platform administration over the user's own btp
// CLI session: account hierarchy, entitlements and quotas, Service Manager
// instances and service keys, destinations, trust and Cloud Connectors.
// Writes are limited to confirmation-gated instance/key creation; every result
// passes through secret redaction and service-key credentials stay redacted.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CREATE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  confirmation,
  pick,
  redactSecrets,
  requireConfirmation,
  resultOf
} from './integration-common.mjs';
import { IntegrationError, createServiceClient } from './integration-http.mjs';
import { finalizeClientCredentials } from './integration-config.mjs';
import { redactText } from './redact.mjs';
import { parseCliJson } from './btp-cli.mjs';

export const BTP_TOOL_NAMES = Object.freeze([
  'btp_connection_info',
  'btp_get_account_hierarchy',
  'btp_list_entitlements',
  'btp_check_quota',
  'btp_list_service_instances',
  'btp_get_service_instance',
  'btp_list_service_keys',
  'btp_get_service_key',
  'btp_list_destinations',
  'btp_get_destination',
  'btp_get_trust',
  'btp_list_cloud_connectors',
  'btp_check_destination',
  'btp_create_service_instance',
  'btp_create_service_key'
]);

const CATALOG_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
// Default ("SAP BTP"/other) catalog first, then CF-only and Kyma-only offerings.
const ENVIRONMENTS = [undefined, 'cloudfoundry', 'kubernetes'];

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected a GUID (subaccounts, directories, instances, keys)');
const catalogName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'expected a technical service or plan name, e.g. hana-cloud or api_access');
const newName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'use letters, digits, ".", "_" or "-" (max 100)');
const lookupName = z.string().min(1).max(255).refine(value => !value.startsWith('-') && !/[\r\n']/.test(value), 'invalid name');
const destinationName = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, 'expected a destination name');
const payload = z.record(z.string(), z.unknown());
const top = z.number().int().min(1).max(500).default(200);
const nameContains = z.string().min(1).max(100).optional();

const SUBACCOUNT_FIELDS = ['guid', 'displayName', 'subdomain', 'region', 'state', 'parentGUID', 'parentType', 'usedForProduction', 'betaEnabled'];
const DIRECTORY_FIELDS = ['guid', 'displayName', 'parentGUID', 'directoryFeatures', 'entityState'];
const ASSIGNMENT_FIELDS = ['entityId', 'entityType', 'amount', 'requestedAmount', 'unlimitedAmountAssigned', 'parentId', 'parentType', 'parentAmount', 'parentRemainingAmount', 'entityState', 'stateMessage', 'autoAssigned'];
const TRUST_FIELDS = ['originKey', 'name', 'typeOfTrust', 'protocol', 'status', 'identityProvider', 'domain', 'availableForUserLogon', 'createShadowUsersDuringLogon', 'readOnly'];

const REQUIRED_AUTH_PROPERTIES = Object.freeze({
  BasicAuthentication: ['User', 'Password'],
  OAuth2ClientCredentials: ['clientId', 'clientSecret', 'tokenServiceURL'],
  OAuth2JWTBearer: ['clientId', 'clientSecret', 'tokenServiceURL'],
  OAuth2UserTokenExchange: ['clientId', 'clientSecret', 'tokenServiceURL'],
  OAuth2Password: ['clientId', 'clientSecret', 'tokenServiceURL', 'User', 'Password'],
  OAuth2SAMLBearerAssertion: ['audience', 'authnContextClassRef', 'clientKey', 'tokenServiceURL'],
  PrincipalPropagation: [],
  NoAuthentication: []
});

const PRINCIPAL_PROPAGATION_MANUAL = 'System certificate, principal-propagation CA certificate, synchronized IdP trust and the X.509 principal type of the system mapping are only visible in the Cloud Connector administration; verify there and the backend certificate mapping (e.g. CERTRULE).';

function rows(value) {
  if (Array.isArray(value)) return value;
  const nested = value?.value ?? value?.items;
  return Array.isArray(nested) ? nested : [];
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function msFrom(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  return number < 1e12 ? number * 1000 : number;
}

function isoFromMs(value) {
  const ms = msFrom(value);
  return ms === null ? null : new Date(ms).toISOString();
}

const byName = (left, right) => String(left.name ?? '').localeCompare(String(right.name ?? ''));
const contains = (value, needle) => String(value ?? '').toLowerCase().includes(needle.toLowerCase());
const bindingFilter = id => `service_instance_id eq '${id}'`;

/** Redact credential-shaped strings and the key/passwd fields redactSecrets does not cover. */
function redactCredentials(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
    name,
    /^key$|passwd/i.test(name) && entry !== null && entry !== '' && typeof entry !== 'object'
      ? '[redacted]'
      : redactCredentials(entry)
  ]));
}

function instanceContext(instance) {
  const context = parseMaybeJson(instance?.context);
  return context && typeof context === 'object' ? context : {};
}

function instanceRow(instance, planInfo) {
  const context = instanceContext(instance);
  return {
    id: instance?.id,
    name: instance?.name,
    offering: planInfo?.offering ?? null,
    plan: planInfo?.plan ?? null,
    service_plan_id: instance?.service_plan_id,
    platform: context.platform ?? instance?.platform_id ?? null,
    org: context.organization_name ?? null,
    space: context.space_name ?? null,
    ready: instance?.ready,
    usable: instance?.usable,
    shared: instance?.shared,
    created_at: instance?.created_at,
    updated_at: instance?.updated_at,
    labels: instance?.labels
  };
}

function keyRow(binding, instanceName) {
  const context = instanceContext(binding);
  return {
    id: binding?.id,
    name: binding?.name,
    service_instance_id: binding?.service_instance_id,
    instance_name: instanceName ?? null,
    ready: binding?.ready,
    platform: context.platform ?? null,
    created_at: binding?.created_at,
    updated_at: binding?.updated_at,
    labels: binding?.labels
  };
}

const lastOperation = value => (value?.last_operation ? pick(value.last_operation, ['type', 'state', 'description', 'updated_at']) : null);

/** Parameters go to a private temp file, never argv (they may hold passwords). */
async function withTempJson(value, fn) {
  if (value === undefined) return fn(undefined);
  const dir = await mkdtemp(join(tmpdir(), 'sap-ai-btp-'));
  try {
    const path = join(dir, 'parameters.json');
    await writeFile(path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function virtualHost(url) {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname}:${port}`.toLowerCase();
}

/** Register all SAP BTP tools; returns the registered names. */
export function registerBtpTools(server, { cli, summary, verify, env = process.env, now = Date.now } = {}) {
  const registeredNames = [];
  const register = (name, title, description, inputSchema, annotations, handler) => {
    registeredNames.push(name);
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(
      async () => redactSecrets(await handler(args)),
      { product: 'SAP BTP', fallback: 'SAP BTP request failed. Check the btp CLI login (btp login --sso), the subaccount id and your role collections.' }
    ));
  };

  // ------------------------------------------------------------ catalog

  const catalogCache = new Map();
  const catalog = (subaccount, environment) => {
    const cacheKey = `${subaccount}|${environment ?? 'sapbtp'}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.promise;
    const promise = (async () => {
      const offerings = rows(await cli.json(['list', 'services/offering'], { subaccount, environment }));
      const plans = rows(await cli.json(['list', 'services/plan'], { subaccount, environment }));
      const offeringNames = new Map(offerings.map(offering => [offering.id, offering.name]));
      return new Map(plans.map(plan => [plan.id, {
        id: plan.id,
        plan: plan.name,
        offering: offeringNames.get(plan.service_offering_id) ?? null,
        offering_id: plan.service_offering_id
      }]));
    })();
    catalogCache.set(cacheKey, { at: now(), promise });
    promise.catch(() => {
      if (catalogCache.get(cacheKey)?.promise === promise) catalogCache.delete(cacheKey);
    });
    return promise;
  };

  const describePlans = async (subaccount, planIds) => {
    const wanted = new Set([...planIds].filter(Boolean));
    const found = new Map();
    for (const environment of ENVIRONMENTS) {
      if ([...wanted].every(id => found.has(id))) break;
      const plans = await catalog(subaccount, environment);
      for (const id of wanted) if (!found.has(id) && plans.has(id)) found.set(id, plans.get(id));
    }
    return found;
  };

  const planIdsFor = async (subaccount, offering, plan) => {
    for (const environment of ENVIRONMENTS) {
      const plans = await catalog(subaccount, environment);
      const ids = new Set([...plans.values()].filter(info => info.offering === offering && info.plan === plan).map(info => info.id));
      if (ids.size) return ids;
    }
    return new Set();
  };

  const listInstances = async subaccount => rows(await cli.json(['list', 'services/instance'], { subaccount }));
  const getInstance = (subaccount, { id, name }) => cli.json(['get', 'services/instance'], id ? { subaccount, id } : { subaccount, name });
  const getBinding = (subaccount, { id, name }) => cli.json(['get', 'services/binding'], id ? { subaccount, id } : { subaccount, name });
  const bindingsOf = async (subaccount, instanceId) => rows(await cli.json(['list', 'services/binding'], { subaccount, 'fields-filter': bindingFilter(instanceId) }))
    .filter(binding => binding.service_instance_id === instanceId);

  const describeInstance = async (subaccount, instance) => {
    const plans = await describePlans(subaccount, [instance?.service_plan_id]);
    return {
      ...instanceRow(instance, plans.get(instance?.service_plan_id)),
      dashboard_url: instance?.dashboard_url,
      last_operation: lastOperation(instance)
    };
  };

  const keyResult = (binding, subaccount) => ({
    key: { ...keyRow(binding), last_operation: lastOperation(binding) },
    credentials: redactCredentials(binding?.credentials ?? {}),
    credentials_note: `Secrets are redacted. Fetch the full key in your own terminal: btp get services/binding --name ${binding?.name} --subaccount ${subaccount}`
  });

  // ------------------------------------------------------------ quota

  const checkQuota = async ({ subaccount, service, plan, amount }) => {
    const planIds = await planIdsFor(subaccount, service, plan);
    if (!planIds.size) {
      return {
        subaccount, service, plan, requested: amount,
        verdict: 'not_entitled',
        entitlement: null,
        reasons: [`${service}/${plan} is not in the Service Manager catalog of subaccount ${subaccount}: not entitled, or not offered in this region/environment`]
      };
    }
    const entitlements = await cli.json(['list', 'accounts/entitlement'], { subaccount });
    const plans = rows(entitlements?.assignedServices)
      .filter(entry => entry.name === service)
      .flatMap(entry => rows(entry.servicePlans))
      .filter(entry => entry.name === plan);
    let planEntry = plans[0];
    let assignment;
    for (const candidate of plans) {
      const row = rows(candidate.assignmentInfo).find(info => info.entityId === subaccount);
      if (row) {
        planEntry = candidate;
        assignment = row;
        break;
      }
    }
    const category = planEntry?.category ?? null;
    const result = {
      subaccount, service, plan, requested: amount,
      verdict: 'available',
      entitlement: assignment ? {
        category,
        assigned_amount: assignment.amount,
        unlimited: assignment.unlimitedAmountAssigned === true,
        entity_state: assignment.entityState,
        state_message: assignment.stateMessage
      } : null
    };
    if (assignment?.parentId) result.parent = { type: assignment.parentType, id: assignment.parentId, remaining: assignment.parentRemainingAmount };
    const reasons = [];
    if (assignment?.entityState && assignment.entityState !== 'OK') {
      result.verdict = 'assignment_not_ready';
      reasons.push(`entitlement assignment is ${assignment.entityState}: ${assignment.stateMessage ?? ''}`.trim());
    } else if (!assignment || assignment.unlimitedAmountAssigned === true || category !== 'SERVICE') {
      reasons.push(`no numeric instance quota applies (${category ?? 'always-available plan'})`);
    } else {
      const instances = (await listInstances(subaccount)).filter(instance => planIds.has(instance.service_plan_id));
      const assigned = Number(assignment.amount ?? 0);
      const remaining = assigned - instances.length;
      result.usage = { basis: 'service instances of this plan in the subaccount', instances: instances.length, names: instances.slice(0, 20).map(instance => instance.name) };
      result.remaining = remaining;
      if (remaining >= amount) {
        reasons.push(`${instances.length} of ${assigned} instances exist; ${remaining} remaining`);
      } else {
        result.verdict = 'insufficient_quota';
        reasons.push(`${instances.length} of ${assigned} instances already exist`);
      }
    }
    return { ...result, reasons };
  };

  // ------------------------------------------------------------ connectivity

  const connectivityApi = async (subaccount, instanceName) => {
    const ids = await planIdsFor(subaccount, 'connectivity', 'api_access');
    const instances = (ids.size ? await listInstances(subaccount) : [])
      .filter(instance => ids.has(instance.service_plan_id) && (!instanceName || instance.name === instanceName))
      .sort(byName);
    if (!instances.length) {
      throw new IntegrationError(`No Connectivity service instance with plan api_access in subaccount ${subaccount}${instanceName ? ` named ${instanceName}` : ''}. Create one with btp_create_service_instance (offering connectivity, plan api_access) and a service key with btp_create_service_key, then retry.`);
    }
    const instance = instances[0];
    const keys = (await bindingsOf(subaccount, instance.id)).filter(binding => binding.ready !== false).sort(byName);
    if (!keys.length) throw new IntegrationError(`Connectivity instance ${instance.name} has no service key. Create one with btp_create_service_key, then retry.`);
    const key = await getBinding(subaccount, { id: keys[0].id });
    const keyName = key?.name ?? keys[0].name;
    const credentials = key?.credentials;
    if (!credentials || typeof credentials !== 'object' || !Object.keys(credentials).length) {
      throw new IntegrationError(`Service key ${keyName} of ${instance.name} returned no credentials; create a Service Manager service key with btp_create_service_key.`);
    }
    if (!credentials.clientsecret && (credentials.certificate || credentials.key)) {
      throw new IntegrationError(`Service key ${keyName} is certificate-based; create a service key with client secret credentials.`);
    }
    const service = credentials.connectivity_service ?? {};
    if (!service.url || !service.scc_info_path) {
      throw new IntegrationError(`Service key ${keyName} has no connectivity_service.url/scc_info_path; use a key of a Connectivity api_access instance.`);
    }
    let config;
    try {
      config = finalizeClientCredentials('BTP_CONNECTIVITY', 'service-key', {
        url: service.url,
        tokenUrl: credentials.token_service_url,
        clientId: credentials.clientid,
        clientSecret: credentials.clientsecret
      });
    } catch (error) {
      throw new IntegrationError(`Service key ${keyName} is unusable: ${error.message}`);
    }
    const path = service.scc_info_path.startsWith('/') ? service.scc_info_path : `/${service.scc_info_path}`;
    const client = createServiceClient({ label: 'BTP_CONNECTIVITY', url: config.url, tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, env });
    const answer = await client.request('GET', path);
    const cloudConnectors = rows(answer).map(entry => {
      const a = entry?.attributes ?? entry ?? {};
      return {
        location_id: a.location_id ?? a.locationId ?? null,
        connected_by: a.connected_by,
        connected_since: isoFromMs(a.connected_since),
        agent_version: a.agent_version,
        agent_type: a.agent_type,
        security_status: parseMaybeJson(a.security_status),
        exposed_systems: rows(parseMaybeJson(a.exposed_systems)).map(system => pick(system, ['protocol', 'host', 'type', 'status', 'description']))
      };
    });
    return { instance: instance.name, service_key: keyName, cloud_connectors: cloudConnectors };
  };

  const loadDestination = async (subaccount, name, serviceInstance) => {
    const result = await cli.json(['get', 'connectivity/destination'], { subaccount, name, 'service-instance': serviceInstance });
    return { configuration: result?.destinationConfiguration ?? {}, metadata: result?.systemMetadata ?? {} };
  };

  const destinationTrust = async subaccount => {
    try {
      const trust = await cli.json(['get', 'connectivity/destination-trust'], { subaccount, active: true });
      const expiry = msFrom(trust?.expirationTimestamp);
      return {
        name: trust?.Name,
        active: trust?.active,
        generated_on: trust?.generatedOn,
        expires_at: isoFromMs(trust?.expirationTimestamp),
        days_left: expiry === null ? null : Math.floor((expiry - now()) / DAY_MS),
        certificate_base64: trust?.x509PublicKeyBase64
      };
    } catch (error) {
      if (error?.name !== 'IntegrationError') throw error;
      return { error: error.message };
    }
  };

  const listTrust = async subaccount => rows(await cli.json(['list', 'security/trust'], { subaccount }));

  // ------------------------------------------------------------ connection

  register('btp_connection_info', 'BTP connection info',
    'Report which btp CLI executable and configuration file the server uses and who acts (the user signed in with btp login --sso). verify: true runs btp --version and reads the global account to prove the session is valid.',
    { verify: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ verify: online }) => {
      const verification = online && verify ? await verify() : undefined;
      return { ...summary, ...(verification ? { verification } : {}) };
    });

  // ------------------------------------------------------------ accounts and entitlements

  register('btp_get_account_hierarchy', 'Get global account hierarchy',
    'Read the global account with its directories and subaccounts (GUIDs, subdomains, regions, states). Use it to resolve the subaccount GUID every subaccount-scoped tool needs.',
    { name_contains: nameContains, top },
    READ_ONLY_ANNOTATIONS,
    async ({ name_contains: needle, top: limit }) => {
      const account = await cli.json(['get', 'accounts/global-account'], { 'show-hierarchy': true });
      const directories = [];
      const subaccounts = [...rows(account?.subaccounts)];
      const walk = nodes => {
        for (const node of rows(nodes)) {
          const features = rows(node.directoryFeatures);
          directories.push({ ...pick(node, DIRECTORY_FIELDS), manages_entitlements: features.includes('ENTITLEMENTS') });
          subaccounts.push(...rows(node.subaccounts));
          walk(node.children);
        }
      };
      walk(account?.children);
      const matching = subaccounts
        .filter(subaccount => !needle || contains(subaccount.displayName, needle) || contains(subaccount.subdomain, needle))
        .map(subaccount => pick(subaccount, SUBACCOUNT_FIELDS))
        .sort((left, right) => String(left.displayName ?? '').localeCompare(String(right.displayName ?? '')));
      return {
        global_account: pick(account, ['guid', 'displayName', 'subdomain', 'licenseType', 'commercialModel']),
        directories,
        total_subaccounts: subaccounts.length,
        returned_subaccounts: Math.min(matching.length, limit),
        subaccounts: matching.slice(0, limit)
      };
    });

  register('btp_list_entitlements', 'List entitlements',
    'List entitlements and quota assignments of the global account (no scope), a directory or a subaccount. Subaccount scope returns the plans assigned to that subaccount; directory/global-account scope returns entitled plans with remaining amounts and, with service, every per-subaccount assignment of that service.',
    z.object({ subaccount: guid.optional(), directory: guid.optional(), service: catalogName.optional(), top })
      .refine(args => !(args.subaccount && args.directory), 'provide at most one of subaccount, directory'),
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, directory, service, top: limit }) => {
      const result = await cli.json(['list', 'accounts/entitlement'], subaccount ? { subaccount } : directory ? { directory } : {});
      const scope = subaccount
        ? { type: 'subaccount', id: subaccount }
        : directory ? { type: 'directory', id: directory } : { type: 'global-account', id: null };
      const services = list => rows(list).filter(entry => !service || entry.name === service);
      const sorted = list => list.sort((left, right) => left.service.localeCompare(right.service) || String(left.plan).localeCompare(String(right.plan)));
      const page = (key, list) => ({ [`${key}_total`]: list.length, [`${key}_returned`]: Math.min(list.length, limit), [key]: list.slice(0, limit) });
      if (subaccount) {
        const assigned = sorted(services(result?.assignedServices).flatMap(entry => rows(entry.servicePlans).flatMap(plan => rows(plan.assignmentInfo)
          .filter(info => info.entityId === subaccount)
          .map(info => ({
            service: entry.name,
            plan: plan.name,
            category: plan.category,
            amount: info.amount,
            unlimited: info.unlimitedAmountAssigned === true,
            entity_state: info.entityState,
            state_message: info.stateMessage,
            parent_remaining: info.parentRemainingAmount
          })))));
        return { scope, ...page('assigned', assigned) };
      }
      const entitled = sorted(services(result?.entitledServices).flatMap(entry => rows(entry.servicePlans).map(plan => ({
        service: entry.name,
        plan: plan.name,
        category: plan.category,
        amount: plan.amount,
        remaining: plan.remainingAmount,
        unlimited: plan.unlimited,
        max_per_subaccount: plan.maxAllowedSubaccountQuota
      }))));
      if (!service) return { scope, ...page('entitled', entitled), assignments_omitted: 'pass service to list per-subaccount assignments' };
      const assigned = sorted(services(result?.assignedServices).flatMap(entry => rows(entry.servicePlans).flatMap(plan => rows(plan.assignmentInfo)
        .map(info => ({ service: entry.name, plan: plan.name, ...pick(info, ASSIGNMENT_FIELDS) })))));
      return { scope, ...page('entitled', entitled), ...page('assigned', assigned) };
    });

  register('btp_check_quota', 'Check service quota',
    'Check whether `amount` more instances of service plan <service>/<plan> can be created in a subaccount: catalog visibility, entitlement assignment state and, for numeric SERVICE quotas, existing instances of the plan versus the assigned amount.',
    { subaccount: guid, service: catalogName, plan: catalogName, amount: z.number().int().min(1).max(1000).default(1) },
    READ_ONLY_ANNOTATIONS,
    async args => checkQuota(args));

  // ------------------------------------------------------------ instances and keys

  register('btp_list_service_instances', 'List service instances',
    'List Service Manager service instances of a subaccount (all environments) with offering and plan names, platform, CF org/space and readiness.',
    { subaccount: guid, offering: catalogName.optional(), plan: catalogName.optional(), name_contains: nameContains, top },
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, offering, plan, name_contains: needle, top: limit }) => {
      const instances = await listInstances(subaccount);
      const plans = await describePlans(subaccount, instances.map(instance => instance.service_plan_id));
      const matching = instances
        .map(instance => instanceRow(instance, plans.get(instance.service_plan_id)))
        .filter(row => (!offering || row.offering === offering) && (!plan || row.plan === plan) && (!needle || contains(row.name, needle)))
        .sort(byName);
      return { total: matching.length, returned: Math.min(matching.length, limit), instances: matching.slice(0, limit) };
    });

  register('btp_get_service_instance', 'Get service instance',
    'Read one service instance by id or name with its last operation and service keys (without credentials). include_parameters returns the redacted instance parameters when the offering allows retrieving them.',
    z.object({ subaccount: guid, id: guid.optional(), name: lookupName.optional(), include_parameters: z.boolean().default(false) })
      .refine(args => [args.id, args.name].filter(value => value !== undefined).length === 1, 'provide exactly one of id, name'),
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, id, name, include_parameters: withParameters }) => {
      const raw = await getInstance(subaccount, { id, name });
      const instance = await describeInstance(subaccount, raw);
      const result = {
        instance,
        service_keys: (await bindingsOf(subaccount, instance.id)).map(binding => keyRow(binding, instance.name)).sort(byName)
      };
      if (withParameters) {
        try {
          const parameters = await cli.json(['get', 'services/instance'], { subaccount, id: instance.id, 'show-parameters': true });
          result.parameters = redactCredentials(parameters?.data ?? parameters ?? {});
        } catch (error) {
          if (error?.name !== 'IntegrationError') throw error;
          result.parameters_error = error.message;
        }
      }
      return result;
    });

  register('btp_list_service_keys', 'List service keys',
    'List service keys (Service Manager bindings) of a subaccount or of one instance. Credentials are never returned here; use btp_get_service_key for a redacted view.',
    z.object({ subaccount: guid, instance_id: guid.optional(), instance_name: lookupName.optional(), top })
      .refine(args => !(args.instance_id && args.instance_name), 'provide at most one of instance_id, instance_name'),
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, instance_id: instanceId, instance_name: instanceName, top: limit }) => {
      let id = instanceId;
      let names;
      if (instanceName) {
        const instance = await getInstance(subaccount, { name: instanceName });
        id = instance?.id;
        if (!id) throw new IntegrationError(`Service instance ${instanceName} was not found in subaccount ${subaccount}`);
        names = new Map([[id, instance.name]]);
      }
      const bindings = id
        ? await bindingsOf(subaccount, id)
        : rows(await cli.json(['list', 'services/binding'], { subaccount }));
      names ??= new Map((await listInstances(subaccount)).map(instance => [instance.id, instance.name]));
      const keys = bindings.map(binding => keyRow(binding, names.get(binding.service_instance_id))).sort(byName);
      return { total: keys.length, returned: Math.min(keys.length, limit), service_keys: keys.slice(0, limit) };
    });

  register('btp_get_service_key', 'Get service key',
    'Read one service key by id or name with its credentials redacted (URLs and client ids stay visible). The user fetches the full key in their own terminal.',
    z.object({ subaccount: guid, id: guid.optional(), name: lookupName.optional() })
      .refine(args => [args.id, args.name].filter(value => value !== undefined).length === 1, 'provide exactly one of id, name'),
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, id, name }) => keyResult(await getBinding(subaccount, { id, name }), subaccount));

  // ------------------------------------------------------------ destinations and trust

  register('btp_list_destinations', 'List destinations',
    'List subaccount-level destinations, or instance-level destinations of one Destination service instance, without secret properties.',
    { subaccount: guid, service_instance: guid.optional(), name_contains: nameContains, top },
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, service_instance: serviceInstance, name_contains: needle, top: limit }) => {
      const result = await cli.json(['list', 'connectivity/destination'], { subaccount, 'service-instance': serviceInstance });
      const destinations = rows(result).map(row => {
        const c = row?.destinationConfiguration ?? {};
        return {
          name: c.Name,
          type: c.Type,
          url: redactText(c.URL ?? ''),
          authentication: c.Authentication,
          proxy_type: c.ProxyType,
          location_id: c.CloudConnectorLocationId ?? null,
          description: c.Description ?? null,
          modified: row?.systemMetadata?.modification_time
        };
      }).filter(row => !needle || contains(row.name, needle)).sort(byName);
      return {
        level: serviceInstance ? 'service-instance' : 'subaccount',
        total: destinations.length,
        returned: Math.min(destinations.length, limit),
        destinations: destinations.slice(0, limit)
      };
    });

  register('btp_get_destination', 'Get destination',
    'Read one destination configuration with secret properties redacted.',
    { subaccount: guid, name: destinationName, service_instance: guid.optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, name, service_instance: serviceInstance }) => {
      const { configuration, metadata } = await loadDestination(subaccount, name, serviceInstance);
      return { destination: redactCredentials(configuration), system_metadata: pick(metadata, ['creation_time', 'modification_time']) };
    });

  register('btp_get_trust', 'Get trust configuration',
    'Read the identity provider trust configurations of a subaccount and the active destination trust (SAML/OAuth signing certificate) with its expiry.',
    { subaccount: guid, include_certificate: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, include_certificate: withCertificate }) => {
      const identityProviders = (await listTrust(subaccount)).map(row => pick(row, TRUST_FIELDS));
      const { certificate_base64: certificate, ...trust } = await destinationTrust(subaccount);
      return {
        identity_providers: identityProviders,
        destination_trust: withCertificate && certificate !== undefined ? { ...trust, certificate_base64: certificate } : trust
      };
    });

  register('btp_list_cloud_connectors', 'List Cloud Connectors',
    'List the Cloud Connectors connected to a subaccount with their exposed virtual systems, using the BTP-side Connectivity API. Needs a Connectivity service instance with plan api_access and a client-secret service key.',
    { subaccount: guid, instance_name: lookupName.optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, instance_name: instanceName }) => ({ subaccount, ...await connectivityApi(subaccount, instanceName) }));

  register('btp_check_destination', 'Check destination',
    'Verify an HTTP destination: URL, required authentication properties, principal-propagation prerequisites (proxy type, IdP trust), destination trust for SAML bearer, and for OnPremise destinations the Cloud Connector location and exposed virtual host. Items only visible in the Cloud Connector or backend are reported as unknown.',
    { subaccount: guid, name: destinationName, service_instance: guid.optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ subaccount, name, service_instance: serviceInstance }) => {
      const { configuration: c } = await loadDestination(subaccount, name, serviceInstance);
      const checks = [];
      const add = (id, status, detail) => checks.push({ id, status, detail });
      let url = null;
      if (c.Type !== 'HTTP') {
        add('type', 'unknown', 'only HTTP destinations are verified');
      } else {
        try {
          const parsed = new URL(c.URL);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed;
        } catch {
          // Reported below.
        }
        add('url', url ? 'pass' : 'fail', url ? `valid ${url.protocol.slice(0, -1)} URL` : 'URL is missing or not an http(s) URL');

        const required = REQUIRED_AUTH_PROPERTIES[c.Authentication];
        if (!required) {
          add('authentication_properties', 'unknown', `authentication type ${c.Authentication ?? '(none)'} is not verified`);
        } else {
          const missing = required.filter(property => c[property] === undefined || c[property] === null || c[property] === '');
          add('authentication_properties', missing.length ? 'fail' : 'pass', missing.length ? `missing properties: ${missing.join(', ')}` : `all properties for ${c.Authentication} are set`);
        }

        if (c.Authentication === 'PrincipalPropagation') {
          add('proxy_type', c.ProxyType === 'OnPremise' ? 'pass' : 'fail', c.ProxyType === 'OnPremise' ? 'ProxyType is OnPremise' : 'PrincipalPropagation requires ProxyType OnPremise');
          const active = (await listTrust(subaccount)).filter(trust => String(trust.status).toLowerCase() === 'active').map(trust => trust.originKey);
          add('identity_provider_trust', active.length ? 'pass' : 'fail', active.length ? `active identity provider trust: ${active.join(', ')}` : 'no active identity provider trust in the subaccount');
          add('cloud_connector_principal_propagation', 'unknown', PRINCIPAL_PROPAGATION_MANUAL);
        }

        if (c.Authentication === 'OAuth2SAMLBearerAssertion') {
          const trust = await destinationTrust(subaccount);
          if (trust.error || trust.days_left === null || trust.days_left === undefined) add('destination_trust', 'fail', trust.error ? `destination trust could not be read: ${trust.error}` : 'no active destination trust certificate');
          else if (trust.days_left < 0) add('destination_trust', 'fail', `destination trust certificate expired on ${trust.expires_at}`);
          else if (trust.days_left < 30) add('destination_trust', 'warn', `destination trust certificate expires in ${trust.days_left} days (${trust.expires_at})`);
          else add('destination_trust', 'pass', `destination trust certificate valid until ${trust.expires_at}`);
        }

        if (c.ProxyType === 'OnPremise') {
          let api;
          try {
            api = await connectivityApi(subaccount);
          } catch (error) {
            if (error?.name !== 'IntegrationError') throw error;
            add('cloud_connector', 'unknown', error.message);
          }
          if (api) {
            const location = c.CloudConnectorLocationId ?? '';
            const connectors = api.cloud_connectors;
            let candidates = [];
            if (!connectors.length) {
              add('cloud_connector', 'fail', 'no Cloud Connector is connected to the subaccount');
            } else if (location && !connectors.some(connector => connector.location_id)) {
              add('cloud_connector', 'unknown', 'location ids not reported by the Connectivity API');
              candidates = connectors;
            } else {
              candidates = connectors.filter(connector => (connector.location_id ?? '') === location);
              add('cloud_connector', candidates.length ? 'pass' : 'fail', candidates.length
                ? `Cloud Connector connected for location ${location || '(default)'}`
                : `no Cloud Connector is connected for location ${location || '(default)'}`);
            }
            if (candidates.length && url) {
              const host = virtualHost(url);
              const exposed = candidates.flatMap(connector => connector.exposed_systems).find(system => String(system.host ?? '').toLowerCase() === host);
              add('exposed_system', exposed ? 'pass' : 'fail', exposed
                ? `virtual host ${host} is exposed (${exposed.protocol ?? 'unknown protocol'}, ${exposed.status ?? 'unknown status'})`
                : `virtual host ${host} is not exposed by the Cloud Connector`);
            }
          }
        }
      }
      const summaryCounts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
      for (const check of checks) summaryCounts[check.status] += 1;
      return {
        destination: {
          name: c.Name,
          type: c.Type,
          url: redactText(c.URL ?? ''),
          authentication: c.Authentication,
          proxy_type: c.ProxyType,
          location_id: c.CloudConnectorLocationId ?? null
        },
        checks,
        summary: summaryCounts
      };
    });

  // ------------------------------------------------------------ confirmed writes

  const timedOut = name => ({
    created: 'unknown',
    note: `The btp CLI did not answer within 120 s; check btp_list_service_instances / btp_list_service_keys for ${name} before retrying.`
  });

  register('btp_create_service_instance', 'Create service instance',
    'Create a Service Manager service instance (Other environment, not a CF space instance) after a quota check. Parameters are passed through a private temporary file. Provisioning is asynchronous. Requires confirmation "CREATE BTP SERVICE INSTANCE <name>".',
    { subaccount: guid, offering: catalogName, plan: catalogName, name: newName, parameters: payload.optional(), confirmation },
    CREATE_ANNOTATIONS,
    async ({ subaccount, offering, plan, name, parameters, confirmation: given }) => {
      requireConfirmation(given, `CREATE BTP SERVICE INSTANCE ${name}`);
      const quota = await checkQuota({ subaccount, service: offering, plan, amount: 1 });
      if (quota.verdict !== 'available') throw new IntegrationError(`No instance was created: ${quota.reasons.join('; ')}`);
      let stdout;
      try {
        stdout = await withTempJson(parameters, file => cli.text(['create', 'services/instance'], {
          subaccount, 'offering-name': offering, 'plan-name': plan, name, parameters: file
        }));
      } catch (error) {
        if (error?.code === 'BTP_CLI_TIMEOUT') return timedOut(name);
        throw error;
      }
      const id = parseCliJson(stdout)?.id;
      try {
        const instance = await describeInstance(subaccount, await getInstance(subaccount, id ? { id } : { name }));
        return { created: true, instance, note: 'Provisioning is asynchronous; poll btp_get_service_instance until last_operation.state is succeeded.' };
      } catch (error) {
        return { created: true, instance: null, read_back_error: error?.message ?? String(error) };
      }
    });

  register('btp_create_service_key', 'Create service key',
    'Create a service key (Service Manager binding) for an instance given by id or name. Parameters are passed through a private temporary file; returned credentials are redacted. Requires confirmation "CREATE BTP SERVICE KEY <name>".',
    z.object({
      subaccount: guid,
      instance_id: guid.optional(),
      instance_name: lookupName.optional(),
      name: newName,
      parameters: payload.optional(),
      confirmation
    }).refine(args => [args.instance_id, args.instance_name].filter(value => value !== undefined).length === 1, 'provide exactly one of instance_id, instance_name'),
    CREATE_ANNOTATIONS,
    async ({ subaccount, instance_id: instanceId, instance_name: instanceName, name, parameters, confirmation: given }) => {
      requireConfirmation(given, `CREATE BTP SERVICE KEY ${name}`);
      let stdout;
      try {
        stdout = await withTempJson(parameters, file => cli.text(['create', 'services/binding'], {
          subaccount, binding: name, 'service-instance': instanceId, 'instance-name': instanceName, parameters: file
        }));
      } catch (error) {
        if (error?.code === 'BTP_CLI_TIMEOUT') return timedOut(name);
        throw error;
      }
      const id = parseCliJson(stdout)?.id;
      let binding;
      try {
        binding = await getBinding(subaccount, id ? { id } : { name });
      } catch (error) {
        return { created: true, key: null, read_back_error: error?.message ?? String(error) };
      }
      return {
        created: true,
        ...keyResult(binding, subaccount),
        ...(binding?.ready === false ? { note: 'Binding is still being created; poll btp_get_service_key.' } : {})
      };
    });

  return registeredNames;
}
