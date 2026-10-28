// Read-only source/node evidence. Content Agent assembly and cTMS promotion remain native.
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, key } from './integration-common.mjs';
import { createCollectionPager, cursorSchema, decodeCollection } from './integration-collections.mjs';
import { CPI_BASE, CPI_PACKAGE_ARTIFACT_SETS } from './cpi-content.mjs';
import { checkReleaseReadiness } from './integration-analysis.mjs';
import { snapshotEvidenceForTargets } from './integration-release-store.mjs';
import { capabilityCatalog } from './integration-capabilities.mjs';
import { IntegrationError } from './integration-http.mjs';

const packageId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/);
const proxyName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const artifactId = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const version = /^\d+\.\d+\.\d+$/;
const nodeName = z.string().min(1).max(255).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const schema = z.object({
  source_package_ids: z.array(packageId).min(1).max(20).optional(),
  apim_proxy_names: z.array(proxyName).min(1).max(20).optional(),
  target_node_name: nodeName
}).strict().refine(value => value.source_package_ids?.length || value.apim_proxy_names?.length, 'At least one source package or API proxy is required');
const MAX_MEMBERS = 500;
const MAX_PAGES = 20;
const safeText = (value, max = 255) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const safeFailure = error => ({ result: error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : [404, 501].includes(error?.status) ? 'unavailable' : 'error',
  ...(Number.isInteger(error?.status) ? { status: error.status } : {}), ...(error?.code === 'INTEGRATION_DEADLINE' ? { stop_reason: 'deadline' } : {}) });
const host = client => { try { return new URL(client?.origin).host; } catch { return null; } };

function nodeProjection(row) {
  return { id: typeof row?.id === 'string' ? safeText(row.id) : Number.isSafeInteger(row?.id) ? row.id : null,
    name: safeText(row?.name), upload_eligibility: 'unknown', import_eligibility: 'unknown' };
}

export async function readCtmsNodes(client, { top = 100, cursor, deadline } = {}) {
  const pager = createCollectionPager(client, { root: '/v2', request: async (method, path, options) => {
    const body = await client.request(method, `/v2${path}`, options);
    if (!Array.isArray(body?.nodes)) throw new IntegrationError('cTMS nodes response is not the documented nodes collection');
    return { value: body.nodes, '@odata.count': body.nodes.length };
  } });
  return pager.page({ path: '/nodes', top, cursor, mode: 'local', deadline, project: nodeProjection });
}

export function registerCtmsTools(register, client) {
  register('ctms_list_nodes', 'List Cloud Transport Management nodes',
    'Read GET /v2/nodes with bounded local paging. Node identity/name access does not establish upload/import eligibility, route, Content Agent, entitlement or target readiness.',
    z.object({ top: z.number().int().min(1).max(200).default(100), cursor: cursorSchema }).strict(), READ_ONLY_ANNOTATIONS,
    args => readCtmsNodes(client, args));
}

async function enumerateGroup(client, package_id, type, remaining, deadline) {
  if (remaining <= 0) return { items: [], returned: 0, total: null, complete: false, stop_reason: 'source_limit' };
  const path = `/IntegrationPackages(${key(package_id)})/${CPI_PACKAGE_ARTIFACT_SETS[type]}`;
  try {
    const raw = await client.request('GET', `${CPI_BASE}${path}`, { unwrap: false, deadline });
    // A finite explicit server count is evidence; a capped navigation with no count is not a complete package.
    const counted = decodeCollection(raw).total !== null;
    const pager = createCollectionPager(client, { root: CPI_BASE });
    const items = [], seen = new Set();
    let cursor, last;
    for (let index = 0; index < MAX_PAGES; index++) {
      last = await pager.page({ path, raw, cursor, top: Math.min(200, remaining - items.length), deadline,
        sourceComplete: counted, consistency: 'best_effort', identity: 'Id',
        project: row => ({ id: typeof row?.Id === 'string' && artifactId.test(row.Id) ? row.Id : null,
          version: typeof row?.Version === 'string' && row.Version.length <= 100 && version.test(row.Version) ? row.Version : null }) });
      for (const row of last.items) {
        if (!row.id || !row.version || seen.has(row.id)) return { items, returned: items.length, total: last.total, complete: false, stop_reason: 'source_changed_or_invalid_identity' };
        seen.add(row.id); items.push(row);
      }
      if (last.complete || !last.next_cursor || items.length >= remaining) break;
      cursor = last.next_cursor;
    }
    const complete = last.complete && (last.total === null || last.total === items.length);
    return { items, returned: items.length, total: last.total, complete,
      stop_reason: complete ? 'end' : last.next_cursor ? 'source_limit' : last.stop_reason,
      consistency: 'best_effort_not_transactional' };
  } catch (error) { return { items: [], returned: 0, total: null, complete: false, stop_reason: error?.code === 'INTEGRATION_DEADLINE' ? 'deadline' : 'source_error', source_result: safeFailure(error) }; }
}

export async function transportReadiness(clients, input, { deadline = Date.now() + 60000, env = process.env, readiness = checkReleaseReadiness, snapshots = snapshotEvidenceForTargets } = {}) {
  const args = schema.parse(input);
  const blockers = new Set(), members = [], packages = [];
  const selectedPackages = [...new Set(args.source_package_ids ?? [])];
  const selectedProxies = [...new Set(args.apim_proxy_names ?? [])];
  if (selectedPackages.length && !clients.cpi) blockers.add('cpi_unconfigured');
  if (selectedProxies.length && !clients.apim) blockers.add('apim_unconfigured');
  for (const id of selectedPackages) {
    const groups = {};
    if (clients.cpi) for (const type of Object.keys(CPI_PACKAGE_ARTIFACT_SETS)) {
      const group = await enumerateGroup(clients.cpi, id, type, MAX_MEMBERS - members.length, deadline);
      const { items, ...evidence } = group;
      groups[type] = evidence;
      for (const item of items) members.push({ package_id: id, type, ...item });
      if (!group.complete) blockers.add('source_enumeration_incomplete');
    }
    packages.push({ id, groups, complete: Object.keys(groups).length === 4 && Object.values(groups).every(group => group.complete) });
  }
  if (!members.length && !selectedProxies.length) blockers.add('no_transportable_members_observed');
  let node = null, nodes = { result: clients.ctms ? 'ok' : 'unconfigured', complete: false };
  if (clients.ctms) try {
    const matches = [];
    let cursor;
    for (let index = 0; index < MAX_PAGES; index++) {
      const page = await readCtmsNodes(clients.ctms, { top: 200, cursor, deadline });
      matches.push(...page.items.filter(item => item.name === args.target_node_name));
      nodes.complete = page.complete; nodes.stop_reason = page.stop_reason;
      if (page.complete || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    if (matches.length === 1 && matches[0].id !== null) node = matches[0];
    else blockers.add(matches.length > 1 ? 'target_node_ambiguous' : 'target_node_missing_or_identity_unverified');
  } catch (error) { nodes = { ...safeFailure(error), complete: false }; }
  if (!nodes.complete) blockers.add('target_node_inventory_unverified');

  const identities = new Map();
  for (const member of members) {
    member.kind = member.type === 'iflows' ? 'cpi_iflow' : member.type;
    if (member.type !== 'iflows') { member.readiness = 'native_review_required'; blockers.add('unchecked_non_iflow_members'); continue; }
    const prior = identities.get(member.id);
    if (prior) { blockers.add('duplicate_source_iflow_identity'); member.readiness = 'source_identity_ambiguous'; }
    else identities.set(member.id, member);
  }
  const flows = [...identities.values()];
  const checked = [];
  for (let offset = 0; offset < flows.length; offset += 20) {
    const batch = flows.slice(offset, offset + 20);
    try {
      const report = await readiness(clients, { cpi_iflow_ids: batch.map(row => row.id), expected_versions: Object.fromEntries(batch.map(row => [`cpi_iflow:${row.id}`, row.version])) }, { deadline });
      for (const row of batch) {
        const evidence = report.items.find(item => item.kind === 'cpi_iflow' && item.id === row.id);
        if (evidence) { Object.assign(row, projectReadiness(evidence)); checked.push(evidence); }
        else row.readiness = 'unchecked';
        if (row.readiness !== 'ready') blockers.add('source_release_checks_not_ready');
      }
    } catch (error) {
      blockers.add('source_release_checks_unavailable');
      for (const row of batch) Object.assign(row, { readiness: 'unchecked', source_result: safeFailure(error) });
    }
  }
  const proxies = [];
  if (selectedProxies.length && clients.apim) try {
    const report = await readiness(clients, { apim_proxy_names: selectedProxies }, { deadline });
    for (const id of selectedProxies) {
      const evidence = report.items.find(item => item.kind === 'apim_proxy' && item.id === id);
      proxies.push(evidence ? { id, ...projectReadiness(evidence) } : { id, readiness: 'unchecked' });
      if (evidence) checked.push(evidence);
      if (evidence?.readiness !== 'ready') blockers.add('source_release_checks_not_ready');
    }
  } catch (error) { blockers.add('source_release_checks_unavailable'); proxies.push(...selectedProxies.map(id => ({ id, readiness: 'unchecked', source_result: safeFailure(error) }))); }

  const snapshotEvidence = await snapshots(clients, checked.filter(item => item.state_sha256), { env, deadline });
  for (const target of checked) {
    if (!target.state_sha256 || !snapshotEvidence.items.some(snapshot => snapshot.targets.some(item => item.kind === target.kind && item.id === target.id && item.state_sha256 === target.state_sha256))) blockers.add('matching_verified_snapshot_required');
  }
  if (snapshotEvidence.result !== 'ok') blockers.add('snapshot_evidence_unreadable');
  if (!snapshotEvidence.complete) blockers.add('snapshot_evidence_incomplete');
  const ctms = capabilityCatalog({ summary: clients.summary }).ctms;
  const result = {
    readiness: blockers.size ? 'blocked' : 'needs_admin_confirmation',
    evidence_scope: 'observed_source_versions_dependencies_validation_and_private_backups',
    source_hosts: { cpi: host(clients.cpi), apim: host(clients.apim) }, ctms_host: host(clients.ctms),
    target_node_name: args.target_node_name, target_node: node, node_inventory: nodes,
    packages, enumeration_complete: packages.every(item => item.complete), members, api_proxies: proxies,
    checked_iflows: flows.filter(item => item.readiness !== 'unchecked' && item.state_sha256).length,
    observed_members: members.length, member_output_complete: true, snapshots: snapshotEvidence,
    target_verification: 'requires_independent_target_bound_server',
    native_prerequisites: ['Content Agent assembly in its supported format', 'Source/target destinations and export node', 'Transport route and node eligibility', 'Named request set and separate upload/import authorization'].map(name => ({ name, verification: 'needs_admin_confirmation' })),
    blockers: [...blockers], native_handoff: ctms.native_handoff, source_links: ctms.source_links, contract_boundaries: ctms.contract_boundaries
  };
  while (Buffer.byteLength(JSON.stringify(result, null, 2)) > 94 * 1024 && result.members.length) {
    result.members.pop(); result.member_output_complete = false;
  }
  if (!result.member_output_complete) { result.readiness = 'blocked'; result.blockers.push('member_output_limit'); }
  return result;
}

function projectReadiness(item) {
  return { readiness: item.readiness, checked_version: item.version, bundle_sha256: item.bundle_sha256, state_sha256: item.state_sha256,
    blockers: item.blockers ?? [], reviews: item.reviews ?? [] };
}

export function registerIntegrationTransportTools(register, clients = {}, options = {}) {
  register('integration_transport_readiness', 'Check native integration promotion prerequisites',
    'Read-only complete bounded package-group traversal, exact observed versions and batches of at most 20 iFlow release checks, APIM checks, private matching snapshots and named cTMS node evidence. Unknown/unchecked members block. Never assembles an MTAR, uploads, imports, resets or claims target readiness; native approvals and independent target-bound verification remain required.',
    schema, READ_ONLY_ANNOTATIONS, args => transportReadiness(clients, args, options));
}
