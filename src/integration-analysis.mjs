// Read-only, bounded static dependency evidence. No source, configuration values or tenant error bodies leave this module.
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, entity, key } from './integration-common.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { readCpiContent, CPI_BASE } from './cpi-content.mjs';
import { APIM_BASE, readApiProxy, exportApiProxyBundle } from './apim-content.mjs';
import { inspectApiProxyBundle } from './apim-inspection.mjs';
import { xmlLocate, xmlChildren, xmlText, xmlAttributes } from './apim-bundle.mjs';
import { parseProperties, strFromU8 } from './iflow-bundle.mjs';
import { canonicalDigest } from './integration-state.mjs';
import { readCertificateHealth, evaluateCertificate } from './cpi-security.mjs';
import { IntegrationError } from './integration-http.mjs';
import { validationEvidence } from './integration-validation.mjs';
import { capabilityCatalog } from './integration-capabilities.mjs';
import { validateNativeRules } from './integration-alerts.mjs';

const cpiId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/);
const proxyId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const targetInputs = { cpi_iflow_ids: z.array(cpiId).min(1).max(20).optional(), apim_proxy_names: z.array(proxyId).min(1).max(20).optional() };
const targetsSchema = z.object(targetInputs).strict().refine(args => args.cpi_iflow_ids?.length || args.apim_proxy_names?.length, 'At least one explicit target is required');
const dependencySchema = z.object({ ...targetInputs, top: z.number().int().min(1).max(200).default(100), cursor: cursorSchema }).strict()
  .refine(args => args.cpi_iflow_ids?.length || args.apim_proxy_names?.length, 'At least one explicit target is required');
const readinessSchema = z.object({ ...targetInputs, expected_versions: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)).optional(), warning_days: z.number().int().min(1).max(365).default(30) }).strict()
  .refine(args => args.cpi_iflow_ids?.length || args.apim_proxy_names?.length, 'At least one explicit target is required');
const local = element => element.name.split(':').at(-1);
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_.& -]{1,255}$/.test(value) ? value : null;
const safeVersion = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
const SOURCE_LIMIT = 128;
const MODEL_ELEMENTS = new Set(['definitions', 'collaboration', 'extensionElements', 'property', 'key', 'value', 'participant', 'messageFlow', 'process', 'startEvent', 'endEvent', 'serviceTask', 'sequenceFlow', 'incoming', 'outgoing', 'messageEventDefinition', 'BPMNDiagram', 'BPMNPlane', 'BPMNShape', 'BPMNEdge', 'Bounds', 'waypoint', 'BPMNLabel']);
const byteLength = value => Buffer.byteLength(JSON.stringify(value, null, 2));

function targets(args) {
  return [...new Set(args.cpi_iflow_ids ?? [])].sort().map(id => ({ kind: 'cpi_iflow', id, key: `cpi_iflow:${id}` }))
    .concat([...new Set(args.apim_proxy_names ?? [])].sort().map(id => ({ kind: 'apim_proxy', id, key: `apim_proxy:${id}` })));
}
function binding({ cpi, apim, summary = {} }) {
  const host = side => {
    try { return new URL(side?.origin).host; } catch { return null; }
  };
  return { environment: typeof summary.environment === 'string' ? summary.environment : 'default',
    hosts: { cpi: host(cpi) ?? summary.cpi?.host ?? null, apim: host(apim) ?? summary.apim?.host ?? null } };
}
function failure(error) {
  const status = Number(error?.status);
  return { result: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : [404, 501].includes(status) ? 'unavailable' : 'error',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(error?.code === 'INTEGRATION_DEADLINE' ? { stop_reason: 'deadline' } : {}) };
}
function unresolved(report, reason) {
  if (!report.unresolved.some(item => item.reason === reason)) report.unresolved.push({ reason });
}
function addReference(report, kind, raw, required = true) {
  const name = safeName(raw);
  if (!name) {
    if (required && raw === '') report.dependencies.push({ kind, name: null, required, existence: 'missing' });
    else unresolved(report, `dynamic_or_unrecognized_${kind}`);
    return;
  }
  if (!report.dependencies.some(item => item.kind === kind && item.name === name)) report.dependencies.push({ kind, name, required, existence: 'unknown' });
}

function inspectCpi(report, content) {
  const defaults = content.files.get('src/main/resources/parameters.prop');
  const parameters = new Map(Object.entries(defaults ? parseProperties(strFromU8(defaults)) : {}));
  for (const entry of content.configurations) parameters.set(entry.ParameterKey, entry.ParameterValue);
  const parameterNames = new Set(content.parameter_names);
  const resolve = raw => {
    if (typeof raw !== 'string') return undefined;
    let missing = false;
    const value = raw.replace(/\{\{([^{}]+)\}\}/g, (_, name) => {
      parameterNames.add(name);
      if (!parameters.has(name)) { missing = true; unresolved(report, 'missing_externalized_parameter'); return ''; }
      return parameters.get(name);
    });
    if (missing) return undefined;
    if (/\{\{|\}\}|\$\{|\{[^}]*\}/.test(value)) { unresolved(report, 'dynamic_configuration_value'); return undefined; }
    return value.trim();
  };
  let models = 0;
  let nodeCount = 0;
  for (const [path, bytes] of content.files) {
    if (/\.(?:groovy|gsh|js|py|jar|mmap|xsl|xslt)$/i.test(path) || /(?:scriptcollection|valuemapping|messagemapping)/i.test(path)) unresolved(report, 'custom_or_shared_content');
    if (!path.endsWith('.iflw')) continue;
    models += 1;
    const xml = strFromU8(bytes);
    const walk = (element, depth = 0) => {
      if (++nodeCount > 20000 || depth > 100) throw new IntegrationError('CPI model exceeds the structural inspection limit');
      if (!MODEL_ELEMENTS.has(local(element))) unresolved(report, 'unrecognized_model_element');
      const children = xmlChildren(xml, element);
      if (!children.length) resolve(xmlText(xml, element));
      for (const value of Object.values(xmlAttributes(xml, element))) resolve(value);
      if (local(element) === 'extensionElements') {
        const properties = new Map();
        for (const property of children.filter(child => local(child) === 'property')) {
          const fields = xmlChildren(xml, property);
          const field = name => fields.find(child => local(child) === name);
          if (!field('key') || !field('value')) continue;
          const name = xmlText(xml, field('key'));
          if (properties.has(name)) unresolved(report, 'ambiguous_adapter_properties');
          properties.set(name, xmlText(xml, field('value')));
        }
        const get = name => resolve(properties.get(name));
        const credential = properties.has('credentialName') ? get('credentialName') : '';
        if (properties.has('ComponentType')) {
          const type = get('ComponentType');
          if (!['HTTP', 'HTTPS'].includes(type)) unresolved(report, 'unrecognized_adapter');
          if (['HTTP', 'HTTPS'].includes(type)) {
            const auth = get('authenticationMethod');
            if (auth === 'Basic') addReference(report, 'user_credential', credential);
            else if (auth === 'OAuth2 Client Credentials') addReference(report, 'oauth2_client_credential', credential);
            else if (auth === 'Client Certificate') addReference(report, 'certificate', credential);
            else if (auth !== undefined && !['None', 'Principal Propagation'].includes(auth)) unresolved(report, 'unrecognized_authentication_method');
            else if (properties.has('authenticationMethod') && auth === undefined) unresolved(report, 'dynamic_authentication_method');
            else if (type === 'HTTP' && !properties.has('authenticationMethod')) unresolved(report, 'missing_authentication_method');
            if (auth === 'Principal Propagation') unresolved(report, 'principal_propagation_native_configuration');
          }
        }
        if (properties.has('clientCertificates')) {
          const aliases = get('clientCertificates');
          if (aliases === undefined) unresolved(report, 'dynamic_certificate');
          else if (aliases) for (const alias of aliases.split(/[,;]/)) addReference(report, 'certificate', alias.trim());
        }
        const variant = get('cmdVariantUri');
        if (variant && !/\/cname::(?:IFlowConfiguration|IntegrationProcess|MessageStartEvent|MessageEndEvent|ExternalCall|sap:HTTP|sap:HTTPS)\//.test(variant)) unresolved(report, 'unrecognized_or_shared_flow_element');
        if ([...properties.keys()].some(name => /^(?:script|mapping|resource|credential|certificate|keystore|alias)/i.test(name) && !['credentialName', 'clientCertificates'].includes(name))) unresolved(report, 'unrecognized_dependency_property');
      }
      for (const child of children) walk(child, depth + 1);
    };
    walk(xmlLocate(xml, []));
  }
  if (!models) unresolved(report, 'missing_iflow_model');
  report.parameter_names = [...parameterNames].filter(name => /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(name)).sort();
  if (report.parameter_names.length !== parameterNames.size) unresolved(report, 'unrecognized_parameter_identity');
}

async function collectPages(read) {
  const items = [];
  let cursor;
  for (let index = 0; index < 10; index += 1) {
    const page = await read(cursor);
    items.push(...page.items);
    if (page.complete) return { items, complete: true };
    if (!page.next_cursor) return { items, complete: false, stop_reason: page.stop_reason };
    cursor = page.next_cursor;
  }
  return { items, complete: false, stop_reason: 'source_limit' };
}

function inventoryReaders(clients, { deadline, warning_days, evaluated_at }) {
  const cache = new Map();
  return async function inventory(kind) {
    if (!cache.has(kind)) cache.set(kind, (async () => {
      try {
        if (kind === 'certificate') return await collectPages(cursor => readCertificateHealth(clients.cpi, { top: 200, cursor, deadline, warning_days, evaluated_at }));
        const cpi = ['user_credential', 'oauth2_client_credential'].includes(kind);
        const client = cpi ? clients.cpi : clients.apim;
        if (!client) return { items: [], complete: false, source_result: { result: 'unconfigured' } };
        const root = cpi ? CPI_BASE : APIM_BASE;
        const path = ({ user_credential: '/UserCredentials', oauth2_client_credential: '/OAuth2ClientCredentials', apim_certificate: '/CertificateStoreReferences' })[kind];
        const pager = createCollectionPager(client, { root });
        return await collectPages(cursor => pager.page({ path, mode: 'local', top: 200, cursor, deadline,
          project: entry => cpi ? { name: safeName(entry.Name) } : { name: safeName(entry.name), alias: safeName(entry.alias), id: safeName(entry.id),
            ...evaluateCertificate({ Alias: entry.alias ?? entry.name, Type: entry.type, ValidNotBefore: entry.ValidNotBefore, ValidNotAfter: entry.ValidNotAfter }, { warning_days, evaluated_at }) } }));
      } catch (error) { return { items: [], complete: false, source_result: failure(error) }; }
    })());
    return cache.get(kind);
  };
}

async function checkReferences(report, clients, inventory, options) {
  for (const dependency of report.dependencies) {
    if (dependency.existence === 'missing') continue;
    try {
      if (['provider', 'kvm'].includes(dependency.kind)) {
        const set = dependency.kind === 'provider' ? 'APIProviders' : 'KeyMapEntries';
        const response = await clients.apim.request('GET', `${APIM_BASE}/${set}(${key(dependency.name)})`, {
          query: { $select: 'name' }, expect: [200, 404], withStatus: true, deadline: options.deadline
        });
        dependency.existence = response.status === 404 ? 'missing' : entity(response.data)?.name === dependency.name ? 'present' : 'unknown';
        continue;
      }
      const kind = report.kind === 'apim_proxy' ? 'apim_certificate' : dependency.kind;
      const source = await inventory(kind);
      const inventoryComplete = source.complete && source.items.every(item => typeof (item.Alias ?? item.name ?? item.alias ?? item.id) === 'string');
      const matches = source.items.filter(item => (item.Alias ?? item.name) === dependency.name || item.alias === dependency.name || item.id === dependency.name);
      dependency.existence = matches.length === 1 ? 'present' : matches.length > 1 ? 'unknown' : inventoryComplete ? 'missing' : 'unknown';
      if (!inventoryComplete) dependency.inventory_complete = false;
      if (source.source_result) dependency.source_result = source.source_result;
      if (source.stop_reason) dependency.stop_reason = source.stop_reason;
      if (['certificate', 'keystore', 'truststore'].includes(dependency.kind) && matches.length === 1) {
        const certificate = matches[0];
        dependency.certificate = Object.fromEntries(['Type', 'KeyType', 'ValidNotBefore', 'ValidNotAfter', 'evaluated_at', 'days_remaining', 'validity'].filter(name => certificate[name] !== undefined).map(name => [name, certificate[name]]));
      }
    } catch (error) { dependency.existence = 'unknown'; dependency.source_result = failure(error); }
  }
}

async function deployment(report, client, deadline) {
  try {
    if (report.kind === 'cpi_iflow') {
      const result = await client.request('GET', `${CPI_BASE}/IntegrationRuntimeArtifacts(${key(report.id)})`, { expect: [200, 404], withStatus: true, deadline });
      report.deployment = { result: 'ok', present: result.status === 200,
        ...(result.status === 200 ? { state: safeName(result.data?.Status), version: safeVersion(result.data?.Version) } : {}) };
    } else {
      const proxy = await readApiProxy(client, report.id, { deadline });
      report.deployment = { result: proxy ? 'ok' : 'unavailable', present: Boolean(proxy), state: safeName(proxy?.state), runtime_health: 'unverified' };
      if (proxy) report.version = safeVersion(proxy.version);
    }
  } catch (error) { report.deployment = failure(error); }
}

async function inspectTarget(clients, target, inventory, options) {
  const report = { ...target, version: null, parameter_names: [], dependencies: [], unresolved: [], sources: [], evidence: 'static_dependencies' };
  const client = target.kind === 'cpi_iflow' ? clients.cpi : clients.apim;
  if (!client) { report.sources.push({ source: 'content', result: 'unconfigured' }); return report; }
  try {
    if (target.kind === 'cpi_iflow') {
      const content = await readCpiContent(client, target.id, 'active', options);
      Object.assign(report, { version: safeVersion(content.resolved_version), selector: content.selector, bundle_sha256: content.bundle_sha256, state_sha256: content.state_sha256 });
      inspectCpi(report, content);
      report.validation = validationEvidence(client, { id: target.id, resolved_version: content.resolved_version, state_sha256: content.state_sha256 });
    } else {
      const files = await exportApiProxyBundle(client, target.id, options);
      if (!files) { report.sources.push({ source: 'content', result: 'unavailable', status: 404 }); return report; }
      const inspection = inspectApiProxyBundle(files, target.id);
      Object.assign(report, { bundle_sha256: inspection.bundle_sha256, state_sha256: inspection.state_sha256,
        policy_attachment: { policies: inspection.policies, attachments: inspection.attachments, unattached_policies: inspection.unattached_policies, unregistered_policy_files: inspection.unregistered_policy_files } });
      for (const reference of inspection.references) addReference(report, reference.kind, reference.name);
      for (const item of inspection.unresolved) unresolved(report, item.reason);
      if (inspection.attachments.some(item => !item.registered) || inspection.policies.some(item => !item.document_present)) unresolved(report, 'missing_policy_registration_or_document');
    }
    report.sources.push({ source: 'content', result: 'ok' });
  } catch (error) { report.sources.push({ source: 'content', ...failure(error) }); }
  if (report.dependencies.length > SOURCE_LIMIT) { report.dependencies.length = SOURCE_LIMIT; unresolved(report, 'dependency_source_limit'); }
  await checkReferences(report, clients, inventory, options);
  await deployment(report, client, options.deadline);
  return report;
}

function disposition(report, expected) {
  const blockers = [];
  const reviews = [];
  if (expected !== undefined && report.version !== null && report.version !== expected) blockers.push('version_mismatch');
  else if (expected !== undefined && report.version === null) reviews.push('version_unreadable');
  if (report.sources.some(source => source.result !== 'ok')) reviews.push('content_unreadable');
  if (report.unresolved.length) reviews.push('unresolved_dependencies');
  if (!report.deployment || report.deployment.result !== 'ok') reviews.push('deployment_access_unverified');
  if (report.deployment?.state === 'ERROR') reviews.push('existing_runtime_error');
  if (report.kind === 'cpi_iflow') {
    if (report.validation?.result === 'failed') blockers.push('latest_validation_failed');
    else if (report.validation?.result !== 'passed') reviews.push('matching_validation_required');
  }
  for (const dependency of report.dependencies) {
    if (dependency.required && dependency.existence === 'missing') blockers.push('missing_required_dependency');
    if (dependency.existence === 'unknown') reviews.push('dependency_unverified');
    const validity = dependency.certificate?.validity;
    if (['expired', 'not_yet_valid'].includes(validity)) blockers.push('referenced_certificate_invalid');
    if (['certificate', 'keystore', 'truststore'].includes(dependency.kind) && dependency.existence === 'present' && (!validity || validity === 'unknown')) reviews.push('certificate_validity_unknown');
    if (validity === 'expiring') reviews.push('referenced_certificate_expiring');
  }
  return { readiness: blockers.length ? 'blocked' : reviews.length ? 'needs_review' : 'ready', blockers: [...new Set(blockers)], reviews: [...new Set(reviews)] };
}

function boundReport(report, maxBytes) {
  if (byteLength(report) <= maxBytes) return report;
  const bounded = { ...report, dependencies: [], parameter_names: [], unresolved: [{ reason: 'output_limit' }], evidence_complete: false };
  delete bounded.policy_attachment;
  return bounded;
}

export async function inspectDependencies(clients, input, { deadline = Date.now() + 60000 } = {}) {
  const args = dependencySchema.parse(input);
  const selected = targets(args);
  const client = clients.cpi ?? clients.apim;
  if (!client) throw new IntegrationError('No integration component is configured');
  const identity = canonicalDigest(selected);
  let rows = [];
  const pager = createCollectionPager(client, { root: '/integration-analysis', request: async () => rows });
  const context = args.cursor ? pager.cursorContext(args.cursor, { scope: 'dependencies' }) : { targets: identity, evaluated_at: new Date().toISOString() };
  if (context.targets !== identity) throw new IntegrationError('Collection cursor targets changed; restart the listing');
  const options = { deadline, warning_days: 30, evaluated_at: context.evaluated_at };
  const inventory = inventoryReaders(clients, options);
  for (const target of selected) rows.push(boundReport(await inspectTarget(clients, target, inventory, options), 20000));
  const page = await pager.page({ path: '/Dependencies', mode: 'local', raw: rows, top: args.top, cursor: args.cursor, scope: 'dependencies', context, deadline, maxBytes: 88 * 1024 });
  return { ...binding(clients), ...page, evidence: 'static_dependencies', graph_completeness: 'not_a_complete_dependency_graph' };
}

export async function checkReleaseReadiness(clients, input, { deadline = Date.now() + 60000 } = {}) {
  const args = readinessSchema.parse(input);
  targetsSchema.parse({ cpi_iflow_ids: args.cpi_iflow_ids, apim_proxy_names: args.apim_proxy_names });
  const selected = targets(args);
  for (const name of Object.keys(args.expected_versions ?? {})) if (!selected.some(target => target.key === name)) throw new IntegrationError('expected_versions contains an unselected target');
  const options = { deadline, warning_days: args.warning_days, evaluated_at: new Date().toISOString() };
  const inventory = inventoryReaders(clients, options);
  const items = [];
  let used = 0;
  for (const target of selected) {
    const report = await inspectTarget(clients, target, inventory, options);
    Object.assign(report, disposition(report, args.expected_versions?.[target.key]));
    if (args.expected_versions?.[target.key] !== undefined) report.expected_version = args.expected_versions[target.key];
    const bounded = boundReport(report, Math.min(16000, Math.max(1200, 78 * 1024 - used - (selected.length - items.length) * 1200)));
    // Omitted evidence must never acquire a stronger readiness claim.
    if (bounded.evidence_complete === false && bounded.readiness === 'ready') { bounded.readiness = 'needs_review'; bounded.reviews = [...bounded.reviews, 'output_limit']; }
    items.push(bounded);
    used += byteLength(bounded);
  }
  return { ...binding(clients), evaluated_at: options.evaluated_at, readiness: items.some(item => item.readiness === 'blocked') ? 'blocked' : items.some(item => item.readiness === 'needs_review') ? 'needs_review' : 'ready',
    readiness_scope: 'static_dependencies_management_access_and_matching_iflow_validation', validation: 'required_for_cpi_iflows', runtime_health: 'unverified', items,
    complete: items.every(item => item.sources.every(source => source.result === 'ok') && item.deployment?.result === 'ok' && item.dependencies.every(dependency => dependency.existence !== 'unknown') && !item.unresolved.length && item.evidence_complete !== false && (item.kind !== 'cpi_iflow' || ['passed', 'failed', 'unknown'].includes(item.validation?.result))) };
}

export function registerIntegrationAnalysisTools(register, { cpi, apim, summary } = {}) {
  const clients = { cpi, apim, summary };
  register('integration_inspect_dependencies', 'Inspect explicit integration dependencies',
    'Privately read fresh bundles and configurations; return bounded static alias/provider/KVM/certificate evidence, identity digests and parameter names only. Not a complete dependency graph.', dependencySchema, READ_ONLY_ANNOTATIONS,
    args => inspectDependencies(clients, args));
  register('integration_check_release_readiness', 'Check static integration release readiness',
    'Read-only explicit-target dependency/version/management checks and latest matching iFlow validation evidence. Missing required aliases, referenced invalid certificates and latest failed validation block; missing/stale/unknown validation and dynamic/unreadable evidence require review. Never initiates validation or deployment.', readinessSchema, READ_ONLY_ANNOTATIONS,
    args => checkReleaseReadiness(clients, args));
}

const monitoringSchema = z.object({
  components: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(20).optional(),
  node_names: z.array(z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value))).min(1).max(20).optional()
}).strict();
const MONITORING_CHECKS = Object.freeze({
  cpi: ['Deployed artifacts', 'Message logs', 'MPL counts', 'Keystore validity', 'Data stores', 'JMS queues', 'Queue metadata'],
  apim: ['API proxies', 'API analytics'],
  ctms: ['Transport nodes'],
  ans: ['Alert subscription metadata', 'Alert condition metadata', 'Alert action metadata'],
  event_mesh: ['Named queue management'],
  aem: ['GA event broker services'],
  aem_semp: ['VPN queue metadata'],
  open_connectors: ['Connector instance identities'],
  edge: ['Local OData metadata']
});
const CTMS_EVENTS = Object.freeze(['TmsImportStarted', 'TmsImportFinished', 'TmsTransportRequestAdded', 'TmsNodeImportJobDeactivated', 'TmsStorageQuotaUsage']);
const ACCESS_RESULTS = new Set(['ok', 'unauthenticated', 'forbidden', 'unavailable', 'untested', 'error']);
const ALM_PERMISSIONS = Object.freeze(['MonitoringDataRead', 'MonitoringArtifactsDeploy', 'HealthCheckMonitoringDataRead']);

function monitoringSources(component, report) {
  return MONITORING_CHECKS[component].map(area => {
    const check = report?.checks?.find(entry => entry.area === area);
    return {
      component, area, method: 'GET',
      result: !report?.configured ? 'unconfigured' : ACCESS_RESULTS.has(check?.result) ? check.result : 'missing_evidence',
      status: Number.isInteger(check?.status) && check.status >= 100 && check.status <= 599 ? check.status : null,
      ...(check?.stop_reason === 'deadline' || check?.source?.stop_reason === 'deadline' ? { stop_reason: 'deadline' } : {})
    };
  });
}

function monitoringHandoffs(component, catalog) {
  if (component === 'cpi' || component === 'cloud_alm') return [{
    owner: 'Cloud ALM administrator',
    prerequisites: ['Dedicated CPI API credential for Cloud ALM; do not reuse or grant permissions to the developer credential',
      ...ALM_PERMISSIONS.map(permission => `${permission}: separate setup requirement; not granted by this tool`)],
    steps: ['Configure the CPI endpoint in Cloud ALM Landscape Management',
      'Enable Integration & Exception Monitoring collection and required categories',
      'Enable Health Monitoring for CPI performance, certificates, JMS and resources',
      'Configure native event thresholds and notification recipients',
      'Observe incoming collection data and an explicitly approved synthetic notification delivery'],
    safety: 'Accessible CPI management APIs do not establish continuous collection. A CPI processing failure is not automatically an ANS event.',
    post_action_verification: ['Administrator supplies collection and notification-delivery evidence for this bound CPI tenant']
  }];
  if (component === 'ctms') return [{
    owner: 'cTMS and ANS administrators',
    prerequisites: ['Existing cTMS and ANS in the intended subaccount; exact node identities and approved notification action',
      'Common-subaccount identity remains unverified by these independent credentials'],
    steps: ['Use the current trusted internal ANS integration for the subaccount',
      'Select intentional eventType conditions for the five supported cTMS event types',
      'Constrain subscriptions with tags.nodeName or tags.nodeId for the intended nodes',
      'Enable the intended subscriptions and actions; inspect native notification status',
      'Observe an explicitly approved synthetic event and its delivered notification'],
    safety: 'Do not create the obsolete ALERT_NOTIFICATION_SERVICE destination; SAP schedules its removal in Q4 2026. Node/rule reads do not prove event collection or delivery.',
    post_action_verification: ['Inspect exact event/node rule scope and administrator-provided collection/delivery evidence']
  }];
  if (component === 'apim') return [{
    owner: 'API Management and alerting administrators',
    prerequisites: ['Exact proxy identities and native anomaly-event/notification configuration'],
    steps: ['Inspect analytics source coverage and watermark separately from native anomaly events',
      'Configure native anomaly-event collection, thresholds and notification actions for the intended proxies',
      'Observe event collection and an explicitly approved synthetic notification delivery'],
    safety: 'Analytics polling is on-demand management evidence, not verified anomaly-event collection or notification delivery.',
    post_action_verification: ['Administrator confirms native anomaly-event collection and delivered notification for the selected tenant']
  }];
  return catalog[component]?.native_handoff ?? [];
}

/** On-demand source access and native setup evidence; never a continuous-monitoring sign-off. */
export async function monitoringReadiness(clients, input = {}) {
  const args = monitoringSchema.parse(input);
  const { cpi, apim, ans, summary = {}, verify } = clients;
  const configured = component => Boolean(({ cpi, apim, ans })[component]) || summary[component]?.configured === true;
  const selected = [...new Set(args.components ?? Object.keys(MONITORING_CHECKS).filter(configured))];
  const evaluated_at = new Date().toISOString();
  const deadline = Date.now() + 60000;
  const needsRules = selected.some(component => component === 'ans' || component === 'ctms');
  const [verification, nativeRules] = await Promise.all([
    (async () => {
      try { return typeof verify === 'function' ? await verify() : {}; }
      catch (error) { return { source_failure: failure(error) }; }
    })(),
    (async () => {
      if (!needsRules || !ans) return null;
      try { return await validateNativeRules(ans, { ...(args.node_names ? { node_names: args.node_names } : {}) }, { deadline }); }
      catch (error) {
        return { complete: false, outcome: 'blocked', collection: 'needs_admin_confirmation', delivery: 'needs_admin_confirmation',
          findings: [{ code: 'rule_source_failed', severity: 'blocked', source_result: failure(error) }], items: [] };
      }
    })()
  ]);
  const catalog = capabilityCatalog({ summary, verification });
  const ruleSourceFailures = [...(nativeRules?.findings ?? []), ...(nativeRules?.items ?? []).flatMap(item => item.findings ?? [])]
    .filter(finding => finding.source_result && finding.source_result.result !== 'ok');
  const hosts = {};
  for (const component of [...new Set([...selected.map(name => name === 'cloud_alm' ? 'cpi' : name), ...(needsRules ? ['ans'] : [])])]) {
    if (!Object.hasOwn(MONITORING_CHECKS, component)) continue;
    const client = ({ cpi, apim, ans })[component];
    try { hosts[component] = new URL(client?.origin ?? `https://${summary[component]?.host}`).host; }
    catch { hosts[component] = null; }
    if (!client?.origin && !summary[component]?.host) hosts[component] = null;
  }
  const items = selected.map(component => {
    const sourceComponent = component === 'cloud_alm' ? 'cpi' : component;
    if (!Object.hasOwn(MONITORING_CHECKS, sourceComponent)) return {
      component, configuration: 'unsupported', readiness: 'blocked', continuous_monitoring: 'unverified',
      sources: [], findings: [{ code: 'unsupported_component', severity: 'blocked' }],
      native_handoff: catalog[component]?.native_handoff ?? [],
      next_steps: [`Select a supported monitoring component: ${[...Object.keys(MONITORING_CHECKS), 'cloud_alm'].join(', ')}`]
    };
    const report = verification[sourceComponent];
    const isConfigured = configured(sourceComponent) || report?.configured === true;
    const sources = monitoringSources(sourceComponent, { ...report, configured: isConfigured });
    if (verification.source_failure) for (const source of sources) Object.assign(source, verification.source_failure);
    if (component === 'ctms') sources.push(...monitoringSources('ans', { ...verification.ans, configured: Boolean(ans) }));
    const findings = sources.filter(source => source.result !== 'ok').map(source => ({
      code: source.result === 'untested' ? 'management_source_untested' : 'required_management_source_unavailable',
      severity: source.result === 'untested' ? 'needs_review' : 'blocked', component: source.component, area: source.area, result: source.result
    }));
    if (component === 'ctms' || component === 'ans') {
      if (!ans) findings.push({ code: 'ans_configuration_required', severity: 'blocked' });
      if (ruleSourceFailures.length) findings.push({ code: 'required_rule_source_unavailable', severity: 'blocked' });
      if (nativeRules?.outcome === 'blocked') findings.push({ code: 'native_rules_blocked', severity: 'blocked' });
      else if (nativeRules && (nativeRules.outcome !== 'rules_validated' || !nativeRules.complete)) findings.push({ code: 'native_rules_require_review', severity: 'needs_review' });
    }
    if (component === 'ctms' && nativeRules) {
      const scoped = (nativeRules.items ?? []).filter(item => item.outcome === 'rules_validated' && item.scope?.verified);
      const coveredEvents = new Set(scoped.flatMap(item => item.scope.event_types ?? []));
      const missingEvents = CTMS_EVENTS.filter(event => !coveredEvents.has(event));
      if (missingEvents.length) findings.push({ code: 'ctms_event_coverage_unconfirmed', severity: 'needs_review', event_types: missingEvents });
      if (!args.node_names?.length) findings.push({ code: 'intended_ctms_nodes_not_supplied', severity: 'needs_review' });
      else for (const node of args.node_names) {
        if (!scoped.some(item => item.scope.node_names?.includes(node))) findings.push({ code: 'ctms_node_coverage_unconfirmed', severity: 'needs_review', node_name: node });
      }
    }
    return {
      component, configuration: isConfigured ? 'configured' : 'absent',
      readiness: findings.some(finding => finding.severity === 'blocked') ? 'blocked' : 'needs_admin_confirmation',
      continuous_monitoring: 'unverified', collection: 'needs_admin_confirmation', delivery: 'needs_admin_confirmation',
      activation: 'unknown', entitlement: 'unknown', sources, findings,
      ...(component === 'apim' ? { analytics_polling: sources.find(source => source.area === 'API analytics')?.result ?? 'missing_evidence', anomaly_events: 'needs_admin_confirmation' } : {}),
      ...(component === 'ctms' ? { event_types: CTMS_EVENTS, node_names: args.node_names ?? [], integration: 'trusted_internal_ans' } : {}),
      ...(component === 'cpi' || component === 'cloud_alm' ? { monitoring_permissions: ALM_PERMISSIONS, permission_effect: 'setup_requirements_only_no_grants', cloud_alm_client: 'not_configured' } : {}),
      setup_requirements: catalog[component]?.setup_requirements ?? [],
      source_links: [...new Set([...(catalog[component]?.source_links ?? []), ...(component === 'cpi' ? catalog.cloud_alm.source_links : [])])],
      native_handoff: monitoringHandoffs(component, catalog)
    };
  });
  return {
    environment: typeof summary.environment === 'string' ? summary.environment : 'default', hosts, evaluated_at,
    readiness: !items.length || items.some(item => item.readiness === 'blocked') ? 'blocked' : 'needs_admin_confirmation',
    readiness_scope: 'accessible_on_demand_management_and_native_monitoring_setup',
    continuous_monitoring: 'unverified', collection: 'needs_admin_confirmation', delivery: 'needs_admin_confirmation',
    common_subaccount: 'unverified', complete: false,
    evidence_complete: items.length > 0 && items.every(item => item.sources.length > 0 && item.sources.every(source => source.result === 'ok')) && (!needsRules || nativeRules?.complete === true),
    findings: items.length ? [] : [{ code: 'no_configured_monitoring_components', severity: 'blocked' }],
    items, ...(nativeRules ? { native_rules: nativeRules } : {}),
    verification_scope: 'source_access_only_not_health_or_continuous_collection',
    runtime_behavior: 'on_demand_only_no_daemon_scheduler_or_provisioning'
  };
}

export function registerMonitoringReadinessTools(register, { cpi, apim, ans, summary, verify } = {}) {
  register('integration_monitoring_readiness', 'Inspect native monitoring readiness',
    'Read-only management/rule evidence plus administrator-run native setup requirements. API access does not verify continuous collection, anomaly events or notification delivery; missing or denied required sources block readiness. No daemon, provisioning or permission grants.',
    monitoringSchema, READ_ONLY_ANNOTATIONS, args => monitoringReadiness({ cpi, apim, ans, summary, verify }, args));
}
