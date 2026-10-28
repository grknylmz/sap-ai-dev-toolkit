// Static bundle evidence only: no policy/source text or effective-runtime security claims.
import { z } from 'zod';
import { strFromU8 } from 'fflate';
import { apiProxyLayout, bundlePolicyNames, bundleJwtIssuers, xmlLocate, xmlChildren, xmlText, xmlAttributes } from './apim-bundle.mjs';
import { exportApiProxyBundle, readApiProxy } from './apim-content.mjs';
import { bundleDigest } from './iflow-bundle.mjs';
import { stateDigest } from './integration-state.mjs';
import { READ_ONLY_ANNOTATIONS } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';

const local = element => element.name.split(':').at(-1);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.& -]{1,255}$/.test(value) ? value : null;
const field = (xml, element, name) => xmlChildren(xml, element).find(child => local(child) === name);
const value = (xml, element, name) => {
  const child = field(xml, element, name);
  return child ? xmlText(xml, child) : null;
};
const text = (files, path) => strFromU8(files.get(path));

export function inspectApiProxyBundle(files, name) {
  const layout = apiProxyLayout(files, name);
  const rootXml = text(files, layout.root);
  const root = xmlLocate(rootXml, []);
  const policyLists = xmlChildren(rootXml, root).filter(child => local(child) === 'policies');
  if (policyLists.length > 1) throw new IntegrationError('API proxy bundle has ambiguous policy registrations');
  const names = bundlePolicyNames(files, name);
  const registrations = policyLists[0] ? xmlChildren(rootXml, policyLists[0]).filter(child => local(child) === 'policy') : [];
  const attachments = [];
  const references = [];
  const unresolved = [];
  const addUnresolved = (source, reason) => {
    if (!unresolved.some(item => item.source === source && item.reason === reason)) unresolved.push({ source, reason });
  };
  const addReference = (source, kind, raw, dynamic = false) => {
    const alias = !dynamic && identifier(raw);
    if (alias) {
      if (!references.some(item => item.source === source && item.kind === kind && item.name === alias)) references.push({ source, kind, name: alias });
    } else addUnresolved(source, `dynamic_or_unrecognized_${kind}`);
  };
  const scanReferences = (xml, element, source) => {
    const attributes = xmlAttributes(xml, element);
    if (attributes.ref) addUnresolved(source, 'dynamic_policy_reference');
    if (local(element) === 'KeyValueMapOperations') {
      if (attributes.mapIdentifier !== undefined) addReference(source, 'kvm', attributes.mapIdentifier, Boolean(attributes.ref));
      else addUnresolved(source, 'dynamic_or_unrecognized_kvm');
    }
    const kind = ({ KeyStore: 'keystore', TrustStore: 'truststore', KeyAlias: 'certificate', CertificateAlias: 'certificate', certificate_alias: 'certificate', provider_id: 'provider', Provider: 'provider', APIProvider: 'provider' })[local(element)];
    if (kind) addReference(source, kind, xmlText(xml, element), Boolean(attributes.ref) || xmlChildren(xml, element).length > 0);
    for (const child of xmlChildren(xml, element)) scanReferences(xml, child, source);
  };
  const policies = names.map((policyName, index) => {
    if (!identifier(policyName)) throw new IntegrationError('API proxy has an unsupported policy identity');
    const path = `${layout.dir}Policy/${policyName}.xml`;
    const registeredType = identifier(xmlAttributes(rootXml, registrations[index]).type);
    if (!files.has(path)) {
      addUnresolved(policyName, 'missing_policy_document');
      return { name: policyName, registered_type: registeredType, type: null, document_present: false };
    }
    const xml = text(files, path);
    const policy = xmlLocate(xml, []);
    const type = identifier(local(policy));
    if (['Javascript', 'PythonScript', 'JavaCallout', 'ServiceCallout'].includes(type)) addUnresolved(policyName, 'custom_or_dynamic_behavior');
    const known = new Set(['AccessControl', 'AssignMessage', 'BasicAuth', 'DecodeJWT', 'ExtractVariable', 'GenerateJWT', 'GenerateSAMLAssertion', 'GetOAuthV2Info', 'Javascript', 'JSONThreatProtection', 'KeyValueMapOperations', 'LookupCache', 'OAuthV2', 'PopulateCache', 'PythonScript', 'Quota', 'RaiseFault', 'RegularExpressionProtection', 'ResponseCache', 'ServiceCallout', 'SetOAuthV2Info', 'SpikeArrest', 'ValidateSAMLAssertion', 'VerifyAPIKey', 'VerifyJWT', 'XMLThreatProtection']);
    if (!known.has(type)) addUnresolved(policyName, 'unrecognized_policy_type');
    if (registeredType && registeredType !== type) addUnresolved(policyName, 'policy_type_mismatch');
    scanReferences(xml, policy, policyName);
    return { name: policyName, registered_type: registeredType, type, document_present: true };
  });
  for (const [folder, endpoint] of [['APIProxyEndPoint', 'proxy'], ['APITargetEndPoint', 'target']]) {
    for (const path of files.keys()) {
      if (!path.startsWith(`${layout.dir}${folder}/`) || !path.endsWith('.xml')) continue;
      const xml = text(files, path);
      const endpointRoot = xmlLocate(xml, []);
      const endpointName = identifier(value(xml, endpointRoot, 'name'));
      const source = `${endpoint}:${endpointName ?? 'unknown'}`;
      scanReferences(xml, endpointRoot, source);
      const walk = (element, context) => {
        const tag = local(element);
        const next = { ...context };
        if (['preFlow', 'postFlow', 'conditionalFlows', 'faultRules', 'defaultFaultRule'].includes(tag)) next.flow = tag;
        if (tag === 'request' || tag === 'response') next.phase = tag;
        if (tag === 'condition' && xmlText(xml, element)) return;
        if (tag === 'step' || tag === 'Step') {
          const policyName = identifier(value(xml, element, 'policy_name') ?? value(xml, element, 'Name'));
          if (policyName) {
            const condition = value(xml, element, 'condition') ?? value(xml, element, 'Condition');
            attachments.push({ policy_name: policyName, endpoint, endpoint_name: endpointName, flow: next.flow ?? 'unknown', phase: next.phase ?? 'unknown', condition_present: Boolean(condition?.trim()) || Boolean(next.condition_present), registered: names.includes(policyName) });
          } else addUnresolved(source, 'unrecognized_policy_attachment');
        }
        const condition = value(xml, element, 'condition') ?? value(xml, element, 'Condition');
        if (condition?.trim()) next.condition_present = true;
        for (const child of xmlChildren(xml, element)) walk(child, next);
      };
      walk(endpointRoot, {});
    }
  }
  const unregisteredPolicyFiles = [...files.keys()].filter(path => path.startsWith(`${layout.dir}Policy/`) && path.endsWith('.xml') && !names.some(policyName => path === `${layout.dir}Policy/${policyName}.xml`)).map(path => identifier(path.slice(`${layout.dir}Policy/`.length, -4)) ?? 'unrecognized_identity');
  if ([...files.keys()].some(path => path.startsWith(`${layout.dir}FileResource/`))) addUnresolved('file_resources', 'custom_or_dynamic_behavior');
  const bundle_sha256 = bundleDigest(files);
  return {
    name, evidence: 'static_bundle', bundle_sha256, state_sha256: stateDigest(bundle_sha256), policies, attachments,
    unregistered_policy_files: unregisteredPolicyFiles,
    unattached_policies: names.filter(policyName => !attachments.some(item => item.policy_name === policyName)),
    references, jwt_issuers: bundleJwtIssuers(files, name), unresolved,
    effective_authentication: 'unverified', certificate_trust: 'unverified', effective_rate_limiting: 'unverified'
  };
}

export async function inspectApiProxySecurity(client, name, { deadline } = {}) {
  const files = await exportApiProxyBundle(client, name, { deadline });
  if (!files) throw new IntegrationError(`API proxy ${name} does not exist`);
  return inspectApiProxyBundle(files, name);
}

function safeRuntimeUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

export function registerApimInspectionTools(register, client) {
  const input = { name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/) };
  register('apim_get_api_proxy_status', 'Get API proxy operational status',
    'Read allowlisted management state and deployment metadata. Runtime health remains unverified; runtime URL excludes credentials and query.', input, READ_ONLY_ANNOTATIONS,
    async ({ name }) => {
      const proxy = await readApiProxy(client, name);
      if (!proxy) throw new IntegrationError(`API proxy ${name} does not exist`);
      const safeScalar = entry => typeof entry === 'number' || typeof entry === 'boolean' ? entry : typeof entry === 'string' && /^[A-Za-z0-9_. :+TZ-]{1,255}$/.test(entry) ? entry : null;
      const rawDeployments = proxy.deploymentInfo;
      const deployments = Array.isArray(rawDeployments) ? rawDeployments : rawDeployments ? [rawDeployments] : [];
      return { name, state: safeScalar(proxy.state), version: safeScalar(proxy.version),
        deployment_metadata: deployments.length ? deployments.map(item => Object.fromEntries(['state', 'status', 'version', 'revision', 'deployedAt', 'deploymentTime'].filter(key => item[key] !== undefined).map(key => [key, safeScalar(item[key])]))) : null,
        runtime_url: safeRuntimeUrl(proxy.runtime_url), runtime_health: 'unverified' };
    });
  register('apim_inspect_api_proxy_security', 'Inspect API proxy static security evidence',
    'Privately inspect exported policy registrations, attachments and identifiable dependency aliases. Returns digests and static metadata, never source or proof of effective security.', input, READ_ONLY_ANNOTATIONS,
    ({ name }) => inspectApiProxySecurity(client, name));
}
