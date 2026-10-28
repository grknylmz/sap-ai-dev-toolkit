// MCP tools for SAP API Management (APIM) over the API portal Management.svc / Transport.svc APIs.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { attachPolicies, buildApiProxyBundle, bundleDocumentation, bundlePolicyNames, patchBundleDocumentation, patchProxyBundle } from './apim-bundle.mjs';
import { DOCUMENTATION_METHODS, MAX_DOCUMENTATION_BYTES, parseApiDocumentation, summarizeApiDocumentation } from './apim-documentation.mjs';
import {
  CREATE_ANNOTATIONS,
  OVERWRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  REDACTED,
  bundleFiles,
  confirmation,
  entity,
  key,
  list,
  pick,
  redactSecrets,
  registerODataReader,
  requireConfirmation,
  secretValue,
  top,
  withoutSecrets
} from './integration-common.mjs';
import { IntegrationError, odataKey } from './integration-http.mjs';
import { readBundle, writeBundle } from './iflow-bundle.mjs';
import { registerApimDeleteTools } from './apim-delete-tools.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { APIM_BASE, exportApiProxyBundle, importApiProxyBundle, readApiProxy } from './apim-content.mjs';
import { registerApimMonitoringTools } from './apim-monitoring.mjs';
import { registerApimPolicyStepTools } from './apim-policy-steps.mjs';

const RESERVED_PROVIDER_NAMES = new Set(['DEST_CI', 'APIMGMT_PORTAL', 'ContentCatalog', 'ON_PREM', 'TC']);

const apimName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const basePath = z.string().regex(/^\/[A-Za-z0-9_\-/.]{1,200}$/)
  .refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('/'), 'must not contain .. or // or end with /');
const SAP_SERVICE_PATH = /^\/sap\/opu\/odata4?\//;
const relativePath = z.string().max(1024).regex(/^\//, 'must start with /')
  .refine(value => !value.includes('..') && !value.includes('?') && !value.includes('#'), 'must not contain .., ? or #');

const proxyTarget = z.union([
  z.object({ provider: apimName, relative_path: relativePath }).strict(),
  z.object({ url: z.string().max(2048).url().regex(/^https:\/\//, 'must be an https URL') }).strict()
]);

const proxyInput = z.object({
  name: apimName,
  title: z.string().max(255).optional(),
  description: z.string().max(4096).optional()
    .describe('Stored by API Management as HTML: plain-text <, > and & come back HTML-escaped.'),
  base_path: basePath,
  service_type: z.enum(['odata', 'rest']),
  target: proxyTarget,
  confirmation
}).strict().superRefine((value, context) => {
  if (value.service_type === 'odata' && value.target?.provider && !SAP_SERVICE_PATH.test(value.target.relative_path)) {
    context.addIssue({ code: 'custom', path: ['target', 'relative_path'], message: 'OData provider targets must use a /sap/opu/odata/ or /sap/opu/odata4/ service path' });
  }
});

// ---------------------------------------------------------------- policy templates

const POLICY_TYPES = ['AccessControl', 'AssignMessage', 'BasicAuth', 'DecodeJWT', 'ExtractVariable', 'GenerateJWT', 'GenerateSAMLAssertion',
  'GetOAuthV2Info', 'Javascript', 'JSONThreatProtection', 'KeyValueMapOperations', 'LookupCache', 'OAuthV2', 'PopulateCache', 'PythonScript',
  'Quota', 'RaiseFault', 'RegularExpressionProtection', 'ResponseCache', 'ServiceCallout', 'SetOAuthV2Info', 'SpikeArrest',
  'ValidateSAMLAssertion', 'VerifyAPIKey', 'VerifyJWT', 'XMLThreatProtection'];
const MAX_SCRIPT_BYTES = 64 * 1024;
const policyName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const variableRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/, 'must be a flow variable such as request.header.apikey');
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, 'must be an HTTP header name');
const headerValue = z.string().max(1024).regex(/^[^\r\n]*$/, 'must be a single line');
const timeUnit = z.enum(['minute', 'hour', 'day', 'week', 'month']);
const kvmEntryName = z.string().min(1).max(255).regex(/^[^\x00-\x1f]+$/, 'must not contain control characters');
const ipv4Cidr = z.string().regex(/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/(?:3[0-2]|[12]?\d))?$/, 'must be an IPv4 address with optional /mask');

const placement = {
  name: policyName,
  endpoint: z.enum(['proxy', 'target']).optional().describe('Endpoint whose flow gets the step (default proxy; basic_auth_from_kvm defaults to target).'),
  flow: z.enum(['pre', 'post']).optional().describe('preFlow or postFlow (default pre).'),
  phase: z.enum(['request', 'response']).optional().describe('Request or response side of the flow (default request; cors response; assign_headers its message).'),
  condition: z.string().max(1024).optional().describe('Step condition, e.g. request.verb = "GET".')
};
const template = (name, params) => z.object({ ...placement, template: z.literal(name), params }).strict();

const policySpec = z.discriminatedUnion('template', [
  template('verify_api_key', z.object({ key_ref: variableRef.default('request.header.apikey') }).strict().prefault({})),
  template('quota', z.object({
    count: z.number().int().min(1).max(1_000_000_000),
    interval: z.number().int().min(1).max(1_000_000),
    time_unit: timeUnit
  }).strict()),
  template('spike_arrest', z.object({ rate: z.string().regex(/^\d{1,6}p[sm]$/, 'must look like 30ps or 100pm') }).strict()),
  template('cors', z.object({
    allow_origin: headerValue.default('*'),
    allow_methods: headerValue,
    allow_headers: headerValue,
    expose_headers: headerValue.optional(),
    max_age: z.number().int().min(0).max(31_536_000).optional()
  }).strict()).refine(value => value.phase !== 'request', { path: ['phase'], message: 'cors headers are added to the response; phase must be response' }),
  template('assign_headers', z.object({
    message: z.enum(['request', 'response']),
    set: z.record(headerName, headerValue).default({}),
    remove: z.array(headerName).max(50).default([])
  }).strict().refine(value => Object.keys(value.set).length || value.remove.length, 'set or remove at least one header')
    .refine(value => Object.keys(value.set).length <= 50, 'at most 50 headers can be set'))
    .refine(value => !value.phase || value.phase === value.params.message, { path: ['phase'], message: 'phase must match params.message' }),
  template('oauth_verify_access_token', z.object({}).strict().prefault({})),
  template('ip_allow', z.object({ addresses: z.array(ipv4Cidr).min(1).max(100) }).strict()),
  template('response_cache', z.object({
    timeout_seconds: z.number().int().min(1).max(31_536_000),
    key_fragments: z.array(variableRef).min(1).max(10).optional().describe('Cache key flow variables (default request.uri).')
  }).strict()),
  template('basic_auth_from_kvm', z.object({ kvm: apimName, user_key: kvmEntryName, password_key: kvmEntryName }).strict()),
  template('raise_fault', z.object({
    status_code: z.number().int().min(100).max(599),
    reason_phrase: headerValue.max(128),
    payload: z.string().max(16 * 1024).optional(),
    content_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+(?:;\s*[\w-]+=[\w.-]+)*$/).optional()
  }).strict()),
  template('javascript', z.object({
    file: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).describe('Script name without .js; stored as FileResource/<file>.js.'),
    script: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= MAX_SCRIPT_BYTES, 'script must be at most 64 KiB')
  }).strict()),
  template('custom', z.object({
    type: z.enum(POLICY_TYPES),
    xml: z.string().max(MAX_SCRIPT_BYTES)
      .refine(value => value.trimStart().startsWith('<'), 'xml must start with <')
      .refine(value => /xmlns=(["'])http:\/\/www\.sap\.com\/apimgmt\1/.test(value), 'xml must declare xmlns="http://www.sap.com/apimgmt"')
  }).strict())
]);

// ---------------------------------------------------------------- products, key value maps

const quotaInput = z.object({ count: z.number().int().min(1).max(1_000_000_000), interval: z.number().int().min(1).max(1_000_000), time_unit: timeUnit }).strict();
const PRODUCT_FIELDS = ['name', 'title', 'description', 'version', 'isPublished', 'status_code', 'quotaCount', 'quotaInterval', 'quotaTimeUnit', 'scope'];
const PRODUCT_PUT_FIELDS = [...PRODUCT_FIELDS, 'shortText', 'isRestricted'];
const kvmEntries = z.array(z.object({ name: kvmEntryName, value: secretValue }).strict()).min(1).max(100)
  .refine(entries => new Set(entries.map(entry => entry.name)).size === entries.length, 'entry names must be unique');

function quotaFields(quota) {
  return quota
    ? { quotaCount: quota.count, quotaInterval: quota.interval, quotaTimeUnit: quota.time_unit }
    : { quotaCount: -99, quotaInterval: -99, quotaTimeUnit: null };
}

/** Rebuild an IntegrationError without any of the given secret values (tenant error text may echo a body). */
function withoutValues(error, values) {
  if (error?.name !== 'IntegrationError') return new IntegrationError('API Management request failed');
  let message = error.message;
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) message = message.replaceAll(form, REDACTED);
  }
  return new IntegrationError(message);
}

function requireNamedMetadata(value, name, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== name) {
    throw new IntegrationError(`${kind} ${name} returned malformed metadata; response withheld`);
  }
  return value;
}

// Management metadata is not an authoring/source surface. Keep operational URL
// paths, but never return embedded credentials or request query/fragment values.
function safeMetadata(value) {
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, safeMetadata(entry)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.href;
    } catch { return null; }
  }
  return value;
}



/** Register apim_* tools for one APIM client. */
export function registerApimTools(register, client, { readBackDelayMs }) {
  const apim = (method, path, options) => client.request(method, `${APIM_BASE}${path}`, options);
  const collections = createCollectionPager(client, { root: APIM_BASE, request: apim });
  registerApimDeleteTools(register, { request: apim, readBackDelayMs });
  registerApimMonitoringTools(register, client);
  registerApimPolicyStepTools(register, client, { readBackDelayMs });

  async function exists(collection, name) {
    // Name-only collection reads avoid resolving provider destinations or proxy details.
    const matches = list(await apim('GET', collection, {
      query: { $filter: `name eq ${odataKey(name)}`, $select: 'name', $top: 1 }
    }));
    return matches.some(entry => entry.name === name);
  }

  async function getProvider(name) {
    const { status, data } = await apim('GET', `/APIProviders(${key(name)})`, { expect: [200, 404], withStatus: true });
    if (status === 404) return null;
    const provider = requireNamedMetadata(entity(data), name, 'API provider');
    // $expand=additionalProperties returns an empty list on live tenants; the navigation link is reliable.
    const additional = list(await apim('GET', `/APIProviders(${key(name)})/additionalProperties`))
      .map(entry => pick(entry, ['name', 'value']));
    return safeMetadata(withoutSecrets(redactSecrets({ ...provider, additionalProperties: additional })));
  }

  async function writeSapClient(name, sapClient) {
    await apim('POST', '/APIProviderAdditionalPropertys', {
      json: { entityId: name, name: 'sap-client', value: sapClient },
      expect: [200, 201, 204]
    });
  }


  const getProxy = name => readApiProxy(client, name);
  const exportBundle = name => exportApiProxyBundle(client, name);

  async function requireBundle(name, missingHint = '') {
    const files = await exportBundle(name);
    if (!files) throw new IntegrationError(`API proxy ${name} does not exist${missingHint}`);
    return files;
  }

  const importBundle = (name, bytes) => importApiProxyBundle(client, name, bytes, { readBackDelayMs });

  async function requireProvider(target) {
    if (target.provider && !(await exists('/APIProviders', target.provider))) {
      throw new IntegrationError(`API provider ${target.provider} does not exist; create it with apim_create_api_provider`);
    }
    return target.provider ? { provider: target.provider, relativePath: target.relative_path } : { url: target.url };
  }

  async function getProduct(name) {
    const { status, data } = await apim('GET', `/APIProducts(${key(name)})`, { query: { $expand: 'apiProxies' }, expect: [200, 404], withStatus: true });
    if (status === 404) return null;
    const { apiProxies, ...product } = requireNamedMetadata(entity(data), name, 'API product');
    return { ...pick(product, PRODUCT_PUT_FIELDS), api_proxies: list(apiProxies).map(proxy => proxy?.name).filter(Boolean) };
  }

  async function getKeyValueMap(name) {
    const { status, data } = await apim('GET', `/KeyMapEntries(${key(name)})`, { query: { $expand: 'keyMapEntryValues' }, expect: [200, 404], withStatus: true });
    return status === 404 ? null : requireNamedMetadata(entity(data), name, 'Key value map');
  }

  registerODataReader(register, {
    name: 'apim_odata_get',
    title: 'Read APIM OData API',
    service: 'API Management Management.svc',
    request: apim,
    client,
    root: APIM_BASE,
    examples: '/Applications, /Developers, /CertificateStoreReferences, /APIResources with $filter'
  });

  // ---------------------------------------------------------------- providers

  register('apim_list_api_providers', 'List API providers',
    'List API Management API providers (connection metadata only; credential fields are never selected).',
    { top: top(), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS,
    async args => collections.page({
      ...args, path: '/APIProviders', orderBy: 'name asc', identity: provider => provider.name,
      query: { $select: 'name,title,description,destType,host,port,useSSL,isOnPremise,cloudConnectorLocation,pathPrefix' },
      project: provider => pick(provider, ['name', 'title', 'description', 'destType', 'host', 'port', 'useSSL', 'isOnPremise', 'cloudConnectorLocation', 'pathPrefix'])
    }));

  register('apim_get_api_provider', 'Get API provider',
    'Read one API provider; credential properties are removed before returning.',
    { name: apimName },
    READ_ONLY_ANNOTATIONS,
    async ({ name }) => {
      const provider = await getProvider(name);
      if (!provider) throw new IntegrationError(`API provider ${name} does not exist`);
      return provider;
    });

  register('apim_create_api_provider', 'Create API provider',
    'Create an Internet or On-Premise (Cloud Connector) API provider. No credentials are sent; backend auth is forwarded per request or configured in the Cloud Connector. Requires confirmation exactly equal to CREATE API PROVIDER <name>.',
    z.object({
      name: apimName,
      title: z.string().max(255).optional(),
      description: z.string().max(4096).optional(),
      type: z.enum(['internet', 'on_premise']),
      host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
      port: z.number().int().min(1).max(65535),
      use_ssl: z.boolean().optional(),
      location_id: z.string().max(2048).optional(),
      sap_client: z.string().regex(/^\d{3}$/).optional(),
      path_prefix: basePath.optional(),
      confirmation
    }).strict().superRefine((value, context) => {
      if (value.type === 'internet' && value.location_id !== undefined) {
        context.addIssue({ code: 'custom', path: ['location_id'], message: 'location_id applies to on_premise providers only' });
      }
    }),
    CREATE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `CREATE API PROVIDER ${args.name}`);
      if (RESERVED_PROVIDER_NAMES.has(args.name) || args.name.startsWith('Apimgmt_rt') || args.name.startsWith('TC_')) {
        throw new IntegrationError(`API provider name ${args.name} is reserved by API Management`);
      }
      // Write format verified on a live tenant: uppercase destType plus authType NONE; omitting authType
      // fails with DEST_CREATION_FAILED_AUTH_ISSUE_MSG, and the read-back forms (Internet/OnPremise/NOAUTH)
      // are rejected on write. A nested additionalProperties insert is not reliably stored, so sap-client
      // is written through the APIProviderAdditionalPropertys entity set.
      const onPremise = args.type === 'on_premise';
      const body = {
        name: args.name,
        title: args.title ?? args.name,
        description: args.description ?? '',
        destType: onPremise ? 'ON_PREMISE' : 'INTERNET',
        host: args.host,
        port: args.port,
        useSSL: args.use_ssl ?? !onPremise,
        isOnPremise: onPremise,
        authType: 'NONE'
      };
      if (onPremise) body.cloudConnectorLocation = args.location_id ?? '';
      else body.trustAll = false;
      if (args.path_prefix) body.pathPrefix = args.path_prefix;
      await apim('POST', '/APIProviders', { json: body, expect: [201] });
      if (args.sap_client) await writeSapClient(args.name, args.sap_client);
      const result = {
        created: true,
        name: args.name,
        provider: null,
        note: 'Provider created. APIM reads may lag; re-read with apim_get_api_provider if provider is null. Do not repeat creation.'
      };
      try {
        result.provider = await getProvider(args.name);
      } catch (error) {
        if (!(error instanceof IntegrationError)) throw error;
        result.read_back_error = error.message;
      }
      return result;
    });

  register('apim_update_api_provider', 'Update API provider',
    'Update an existing API provider; omitted fields keep their current values. Providers with stored backend credentials are refused because the update is written with authType NONE. sap_client is added only when given. Requires confirmation exactly equal to UPDATE API PROVIDER <name>.',
    z.object({
      name: apimName,
      title: z.string().max(255).optional(),
      description: z.string().max(4096).optional(),
      type: z.enum(['internet', 'on_premise']).optional(),
      host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      use_ssl: z.boolean().optional(),
      location_id: z.string().max(2048).optional(),
      sap_client: z.string().regex(/^\d{3}$/).optional(),
      path_prefix: basePath.optional(),
      confirmation
    }).strict(),
    OVERWRITE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `UPDATE API PROVIDER ${args.name}`);
      const { status, data } = await apim('GET', `/APIProviders(${key(args.name)})`, { expect: [200, 404], withStatus: true });
      if (status === 404) throw new IntegrationError(`API provider ${args.name} does not exist; use apim_create_api_provider`);
      const current = entity(data) ?? {};
      if (current.authType && !['NONE', 'NOAUTH'].includes(String(current.authType).toUpperCase())) {
        throw new IntegrationError(`API provider ${args.name} uses authType ${current.authType}; update it in the API Management UI so its credentials are kept`);
      }
      const wasOnPremise = current.isOnPremise === true || /^on_?prem/i.test(String(current.destType ?? ''));
      const onPremise = args.type ? args.type === 'on_premise' : wasOnPremise;
      if (!onPremise && args.location_id !== undefined) throw new IntegrationError('location_id applies to on_premise providers only');
      const typeChanged = onPremise !== wasOnPremise;
      const host = args.host ?? current.host;
      const port = args.port ?? Number(current.port);
      if (!host || !Number.isInteger(port) || port < 1) throw new IntegrationError(`API provider ${args.name} has no host/port; pass host and port`);
      const body = {
        name: args.name,
        title: args.title ?? current.title ?? args.name,
        description: args.description ?? current.description ?? '',
        destType: onPremise ? 'ON_PREMISE' : 'INTERNET',
        host,
        port,
        useSSL: args.use_ssl ?? (typeChanged || typeof current.useSSL !== 'boolean' ? !onPremise : current.useSSL),
        isOnPremise: onPremise,
        authType: 'NONE'
      };
      if (onPremise) body.cloudConnectorLocation = args.location_id ?? (typeChanged ? '' : current.cloudConnectorLocation ?? '');
      else body.trustAll = typeof current.trustAll === 'boolean' && !typeChanged ? current.trustAll : false;
      const pathPrefix = args.path_prefix ?? current.pathPrefix;
      if (pathPrefix) body.pathPrefix = pathPrefix;
      await apim('PUT', `/APIProviders(${key(args.name)})`, { json: body, expect: [200, 204] });
      if (args.sap_client) await writeSapClient(args.name, args.sap_client);
      return { updated: true, provider: await getProvider(args.name) };
    });

  // ---------------------------------------------------------------- proxies

  register('apim_list_api_proxies', 'List API proxies',
    'List API Management API proxies (name, title, service type, state, version, provider).',
    { top: top(), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS,
    async args => collections.page({
      ...args, path: '/APIProxies', orderBy: 'name asc', identity: proxy => proxy.name,
      query: { $select: 'name,title,description,service_code,state,version,provider_name' },
      project: proxy => pick(proxy, ['name', 'title', 'description', 'service_code', 'state', 'version', 'provider_name'])
    }));

  register('apim_get_api_proxy', 'Get API proxy',
    'Read one API proxy with its proxy/target endpoints, virtual hosts and deployment info, plus the computed runtime_url.',
    { name: apimName },
    READ_ONLY_ANNOTATIONS,
    async ({ name }) => {
      const proxy = await getProxy(name);
      if (!proxy) throw new IntegrationError(`API proxy ${name} does not exist`);
      return safeMetadata(withoutSecrets(redactSecrets(requireNamedMetadata(proxy, name, 'API proxy'))));
    });

  register('apim_export_api_proxy', 'Export API proxy bundle',
    'Export an API proxy bundle (Transport.svc) and return its text files: root APIProxy XML, endpoints, Policy/*.xml and FileResource scripts. Pass file_path for one file.',
    { name: apimName, file_path: z.string().max(400).optional() },
    READ_ONLY_ANNOTATIONS,
    async ({ name, file_path: filePath }) => ({ name, ...bundleFiles(await requireBundle(name), filePath) }));

  register('apim_list_virtual_hosts', 'List virtual hosts',
    'List API Management virtual hosts (host, port, SSL, default flag).',
    { top: top(), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS,
    async args => collections.page({
      ...args, path: '/VirtualHosts', mode: 'local',
      project: host => pick(host, ['id', 'name', 'virtual_host', 'virtual_port', 'isSSL', 'isDefault'])
    }));

  register('apim_create_api_proxy', 'Create API proxy',
    'Create and deploy an API proxy (Transport.svc import) for an existing API provider or a fixed https URL; for OData provider targets relative_path must be a /sap/opu/odata(4)/ service path. Optional policies use the same templates as apim_attach_api_proxy_policies and are included before the first deployment, avoiding an unsecured revision. Returns the runtime_url. Requires confirmation exactly equal to CREATE API PROXY <name>.',
    proxyInput.safeExtend({ policies: z.array(policySpec).min(1).max(10).optional() }),
    CREATE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `CREATE API PROXY ${args.name}`);
      if (await exists('/APIProxies', args.name)) throw new IntegrationError(`API proxy ${args.name} already exists; use apim_update_api_proxy`);
      const target = await requireProvider(args.target);
      let bundle = buildApiProxyBundle({
        name: args.name,
        title: args.title ?? args.name,
        description: args.description ?? '',
        basePath: args.base_path,
        serviceType: args.service_type,
        target
      });
      if (args.policies) {
        const files = readBundle(bundle);
        attachPolicies(files, args.name, args.policies);
        bundle = writeBundle(files);
      }
      return { imported: true, base_path: args.base_path, ...(await importBundle(args.name, bundle)) };
    });

  register('apim_update_api_proxy', 'Update API proxy',
    'Change an existing API proxy\'s base path, target, service type and (when given) title/description: exports the current bundle, patches those elements in place (policies, flow steps and scripts are kept) and re-imports it, which deploys a new revision. Requires confirmation exactly equal to UPDATE API PROXY <name>.',
    proxyInput,
    OVERWRITE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `UPDATE API PROXY ${args.name}`);
      const target = await requireProvider(args.target);
      const files = await requireBundle(args.name, '; use apim_create_api_proxy');
      const { preservedPolicies } = patchProxyBundle(files, args.name, {
        title: args.title,
        description: args.description,
        serviceType: args.service_type,
        basePath: args.base_path,
        target
      });
      const deployment = await importBundle(args.name, writeBundle(files));
      return {
        updated: deployment.content_verified,
        base_path: args.base_path,
        preserved_policies: preservedPolicies,
        ...deployment
      };
    });

  register('apim_attach_api_proxy_policies', 'Attach API proxy policies',
    'Add or replace policies from templates (verify_api_key, quota, spike_arrest, cors, assign_headers, oauth_verify_access_token, ip_allow, response_cache, basic_auth_from_kvm, raise_fault, javascript, custom). Export, replace policy XML, register, append new steps and import; this replaces the draft, imports a new revision and requests deployment. Re-attaching replaces policy XML without duplicating or moving its exact supported assignment; a supplied condition updates that assignment, while omission preserves its condition. Use apim_edit_policy_steps for moves, removals or ordering. response_cache steps on proxy preFlow request and postFlow response; basic_auth_from_kvm adds <name>_kvm then <name>, default target preFlow request. Requires confirmation exactly equal to UPDATE API PROXY POLICIES <name>.',
    z.object({ name: apimName, policies: z.array(policySpec).min(1).max(10), confirmation }).strict(),
    OVERWRITE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `UPDATE API PROXY POLICIES ${args.name}`);
      const files = await requireBundle(args.name);
      const { policies, stepsAdded } = attachPolicies(files, args.name, args.policies);
      const deployment = await importBundle(args.name, writeBundle(files));
      return { updated: deployment.content_verified, policies, steps_added: stepsAdded, ...deployment };
    });

  register('apim_get_api_documentation', 'Get API documentation',
    'Read registered OpenAPI JSON as a safe summary of version, security schemes and path/method inventory (100 operations per page; continue with next_operation_offset), optionally selecting one bounded operation. Examples, raw schemas and arbitrary extension payloads are never returned.',
    z.object({
      name: apimName,
      path: z.string().min(1).max(2048).optional(),
      method: z.enum(DOCUMENTATION_METHODS).optional(),
      operation_offset: z.number().int().min(0).max(1_000_000).default(0)
    }).strict().superRefine((value, context) => {
      if ((value.path === undefined) !== (value.method === undefined)) context.addIssue({ code: 'custom', message: 'path and method must be supplied together' });
    }),
    READ_ONLY_ANNOTATIONS,
    async ({ name, path, method, operation_offset }) => {
      const document = bundleDocumentation(await requireBundle(name), name);
      return { name, documentation_path: document.path, ...summarizeApiDocumentation(document.text, { path, method, operationOffset: operation_offset }) };
    });

  register('apim_update_api_documentation', 'Update API documentation',
    'Replace the registered English SWAGGER_JSON documentation of an existing proxy with self-contained OpenAPI 2.0 or 3.0/3.1 JSON (maximum 1 MiB). Its explicit HTTPS public runtime URL must match the named proxy; external references and ambiguous layouts are rejected. Exports fresh, changes only documentation bytes, imports/redeploys and reads the decoded document back. Requires confirmation exactly equal to UPDATE API DOCUMENTATION <name>.',
    z.object({
      name: apimName,
      openapi_json: z.string().min(2).max(MAX_DOCUMENTATION_BYTES).refine(value => Buffer.byteLength(value, 'utf8') <= MAX_DOCUMENTATION_BYTES, 'must not exceed 1 MiB'),
      confirmation
    }).strict(),
    OVERWRITE_ANNOTATIONS,
    async ({ name, openapi_json, confirmation: approved }) => {
      requireConfirmation(approved, `UPDATE API DOCUMENTATION ${name}`);
      parseApiDocumentation(openapi_json);
      const proxy = await getProxy(name);
      if (!proxy) throw new IntegrationError(`API proxy ${name} does not exist`);
      if (!proxy.runtime_url) throw new IntegrationError(`API proxy ${name} has no resolved public runtime URL`);
      parseApiDocumentation(openapi_json, proxy.runtime_url);
      const files = await requireBundle(name);
      const { path } = patchBundleDocumentation(files, name, openapi_json);
      const deployment = await importBundle(name, writeBundle(files));
      const summary = summarizeApiDocumentation(openapi_json);
      return {
        updated: deployment.content_verified, ...deployment, documentation_path: path,
        title: summary.title, version: summary.version, openapi_version: summary.openapi_version,
        submitted_sha256: summary.sha256, submitted_bytes: summary.bytes,
        path_count: summary.path_count, operation_count: summary.operation_count
      };
    });

  // ---------------------------------------------------------------- products

  register('apim_list_api_products', 'List API products',
    'List API Management products (publish state, quota, scope).',
    { top: top(), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS,
    async args => collections.page({
      ...args, path: '/APIProducts', orderBy: 'name asc', identity: product => product.name,
      query: { $select: PRODUCT_FIELDS.join(',') }, project: product => pick(product, PRODUCT_FIELDS)
    }));

  register('apim_get_api_product', 'Get API product',
    'Read one API product with the names of its API proxies (api_proxies).',
    { name: apimName },
    READ_ONLY_ANNOTATIONS,
    async ({ name }) => {
      const product = await getProduct(name);
      if (!product) throw new IntegrationError(`API product ${name} does not exist`);
      return product;
    });

  register('apim_create_api_product', 'Create API product',
    'Create an API product bundling existing API proxies (membership is fixed at creation; apim_update_api_product changes only its own fields). Every proxy is checked first. publish (default true) publishes it to the developer portal; proxies should be deployed. Product quota is enforced only by proxies with VerifyAPIKey + Quota policies. Requires confirmation exactly equal to CREATE API PRODUCT <name>.',
    z.object({
      name: apimName,
      title: z.string().max(255).optional(),
      description: z.string().max(4096).optional(),
      scope: z.string().max(1024).optional(),
      proxies: z.array(apimName).min(1).max(50).refine(names => new Set(names).size === names.length, 'proxy names must be unique'),
      quota: quotaInput.optional(),
      publish: z.boolean().default(true),
      confirmation
    }).strict(),
    CREATE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `CREATE API PRODUCT ${args.name}`);
      if (await exists('/APIProducts', args.name)) throw new IntegrationError(`API product ${args.name} already exists; use apim_update_api_product`);
      for (const proxy of args.proxies) {
        if (!(await exists('/APIProxies', proxy))) throw new IntegrationError(`API proxy ${proxy} does not exist; nothing was created`);
      }
      const body = {
        name: args.name,
        title: args.title ?? args.name,
        description: args.description ?? '',
        version: '1',
        scope: args.scope ?? '',
        isPublished: args.publish,
        status_code: args.publish ? 'PUBLISHED' : 'DRAFT',
        ...quotaFields(args.quota),
        apiProxies: args.proxies.map(proxy => ({ __metadata: { uri: `APIProxies(name=${odataKey(proxy)})` } }))
      };
      await apim('POST', '/APIProducts', { json: body, expect: [201] });
      return { created: true, product: await getProduct(args.name) };
    });

  register('apim_update_api_product', 'Update API product',
    'Update an API product\'s title, description, scope, quota (null removes it) or publish state; omitted fields keep their values and proxy membership is unchanged. Requires confirmation exactly equal to UPDATE API PRODUCT <name>.',
    z.object({
      name: apimName,
      title: z.string().max(255).optional(),
      description: z.string().max(4096).optional(),
      scope: z.string().max(1024).optional(),
      quota: quotaInput.nullable().optional(),
      publish: z.boolean().optional(),
      confirmation
    }).strict(),
    OVERWRITE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `UPDATE API PRODUCT ${args.name}`);
      const { status, data } = await apim('GET', `/APIProducts(${key(args.name)})`, { expect: [200, 404], withStatus: true });
      if (status === 404) throw new IntegrationError(`API product ${args.name} does not exist; use apim_create_api_product`);
      const body = { ...pick(entity(data), PRODUCT_PUT_FIELDS), name: args.name };
      if (args.title !== undefined) body.title = args.title;
      if (args.description !== undefined) body.description = args.description;
      if (args.scope !== undefined) body.scope = args.scope;
      if (args.quota !== undefined) Object.assign(body, quotaFields(args.quota));
      if (args.publish === true) Object.assign(body, { isPublished: true, status_code: 'PUBLISHED' });
      if (args.publish === false) Object.assign(body, { isPublished: false, status_code: 'DRAFT' });
      const batch = `batch_${randomUUID()}`;
      const changeset = `changeset_${randomUUID()}`;
      const payload = [
        `--${batch}`,
        `Content-Type: multipart/mixed; boundary=${changeset}`,
        '',
        `--${changeset}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        'Content-ID: 1',
        '',
        `PUT APIProducts(name=${odataKey(args.name)}) HTTP/1.1`,
        'Content-Type: application/json',
        'Accept: application/json',
        '',
        JSON.stringify(body),
        `--${changeset}--`,
        `--${batch}--`,
        ''
      ].join('\r\n');
      const response = await apim('POST', '/$batch', {
        body: payload,
        contentType: `multipart/mixed; boundary=${batch}`,
        accept: 'multipart/mixed',
        responseType: 'text',
        expect: [200, 202]
      });
      const statuses = [...String(response).matchAll(/(?:^|\r?\n)HTTP\/1\.[01] (\d{3})(?:[ \r\n])/g)].map(match => Number(match[1]));
      if (statuses.length !== 1 || ![200, 204].includes(statuses[0])) {
        throw new IntegrationError(statuses.length
          ? `API product update changeset failed (HTTP ${statuses.join(', ')})`
          : 'API product update returned no embedded HTTP result; update is not confirmed');
      }
      const inner = String(response).slice(String(response).search(/HTTP\/1\.[01] /));
      const headerEnd = /\r?\n\r?\n/.exec(inner);
      const responseBody = headerEnd ? inner.slice(headerEnd.index + headerEnd[0].length).split(/\r?\n--/)[0].trim() : '';
      if (responseBody) {
        let decoded;
        try { decoded = JSON.parse(responseBody); } catch {
          throw new IntegrationError('API product update returned an unreadable embedded response; update is not confirmed');
        }
        if (decoded?.error) throw new IntegrationError('API product update changeset returned an embedded OData error');
      }
      return { updated: true, product: await getProduct(args.name) };
    });

  // ---------------------------------------------------------------- key value maps

  register('apim_list_key_value_maps', 'List key value maps',
    'List environment key value maps (name, encrypted, scope); values are not read.',
    { top: top(), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS,
    async args => collections.page({
      ...args, path: '/KeyMapEntries', orderBy: 'name asc', identity: map => map.name,
      query: { $select: 'name,encrypted,scope' }, project: map => pick(map, ['name', 'encrypted', 'scope'])
    }));

  register('apim_get_key_value_map', 'Get key value map',
    'Read one key value map with its entry names; all values are write-only and returned as [redacted], regardless of encryption.',
    { name: apimName },
    READ_ONLY_ANNOTATIONS,
    async ({ name }) => {
      const map = await getKeyValueMap(name);
      if (!map) throw new IntegrationError(`Key value map ${name} does not exist`);
      return {
        ...pick(map, ['name', 'encrypted', 'scope']),
        entries: list(map.keyMapEntryValues).map(entry => ({ name: entry.name, value: REDACTED }))
      };
    });

  register('apim_create_key_value_map', 'Create key value map',
    'Create an environment-scoped key value map (encrypted by default). Values are write-only and never returned. Requires confirmation exactly equal to CREATE KEY VALUE MAP <name>.',
    z.object({ name: apimName, encrypted: z.boolean().default(true), entries: kvmEntries, confirmation }).strict(),
    CREATE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `CREATE KEY VALUE MAP ${args.name}`);
      if (await getKeyValueMap(args.name)) throw new IntegrationError(`Key value map ${args.name} already exists; use apim_set_key_value_map_entries`);
      try {
        await apim('POST', '/KeyMapEntries', {
          json: {
            name: args.name,
            encrypted: args.encrypted,
            scope: 'ENV',
            keyMapEntryValues: args.entries.map(entry => ({ name: entry.name, map_name: args.name, value: entry.value }))
          },
          expect: [200, 201]
        });
      } catch (error) {
        throw withoutValues(error, args.entries.map(entry => entry.value));
      }
      return { created: true, name: args.name, encrypted: args.encrypted, entries: args.entries.map(entry => entry.name) };
    });

  register('apim_set_key_value_map_entries', 'Set key value map entries',
    'Create or overwrite entries of an existing key value map, one request per entry in order; stops at the first failure and reports updated/created/failed entry names. Values are write-only and never returned. Requires confirmation exactly equal to UPDATE KEY VALUE MAP <name>.',
    z.object({ name: apimName, entries: kvmEntries, confirmation }).strict(),
    OVERWRITE_ANNOTATIONS,
    async args => {
      requireConfirmation(args.confirmation, `UPDATE KEY VALUE MAP ${args.name}`);
      const map = await getKeyValueMap(args.name);
      if (!map) throw new IntegrationError(`Key value map ${args.name} does not exist; use apim_create_key_value_map`);
      const existing = new Set(list(map.keyMapEntryValues).map(entry => entry.name));
      const values = args.entries.map(entry => entry.value);
      const result = { name: args.name, updated: [], created: [] };
      for (const entry of args.entries) {
        const json = { map_name: args.name, name: entry.name, value: entry.value };
        try {
          if (existing.has(entry.name)) {
            await apim('PUT', `/KeyMapEntryValues(map_name=${key(args.name)},name=${key(entry.name)})`, { json, expect: [200, 204] });
            result.updated.push(entry.name);
          } else {
            await apim('POST', '/KeyMapEntryValues', { json, expect: [200, 201, 204] });
            result.created.push(entry.name);
          }
        } catch (error) {
          result.failed = { name: entry.name, error: withoutValues(error, values).message };
          break;
        }
      }
      return result;
    });
}

/** Names of every apim_* tool, in registration order. */
export function apimToolNames() {
  const names = [];
  registerApimTools(name => names.push(name), null, {});
  return names;
}
