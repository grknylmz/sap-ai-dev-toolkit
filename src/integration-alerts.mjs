// Native ANS configuration inspection: rule evidence is not collection or delivery evidence.
import { z } from 'zod';
import { IntegrationError } from './integration-http.mjs';
import { READ_ONLY_ANNOTATIONS, OVERWRITE_ANNOTATIONS, requireConfirmation, top, entity } from './integration-common.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { canonicalDigest } from './integration-state.mjs';

const ROOT = '/cf/configuration/v1';
const PAGE_SIZE = 200;
const MAX_REFERENCES = 1000;
const MAX_OUTPUT = 60 * 1024;
const name = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/).refine(value => value.trim().length > 0 && value !== '.' && value !== '..', 'Invalid ANS identity');
const names = z.array(name).min(1).max(20);
const digest = z.string().regex(/^[a-f0-9]{64}$/).optional();
const PREDICATES = ['CONTAINS', 'DOES_NOT_CONTAIN', 'STARTS_WITH', 'DOES_NOT_START_WITH', 'ENDS_WITH', 'DOES_NOT_END_WITH', 'EQUALS', 'NOT_EQUALS', 'ANY', 'NO_VALUE', 'LESS_THAN', 'GREATER_THAN', 'NUMBER_EQUALS'];
const CTMS_EVENTS = new Set(['TmsImportStarted', 'TmsImportFinished', 'TmsTransportRequestAdded', 'TmsNodeImportJobDeactivated', 'TmsStorageQuotaUsage']);
const ruleInputs = { subscription_names: names.optional(), node_names: names.optional() };
const conditionInput = z.object({ name, propertyKey: name, predicate: z.enum(PREDICATES), propertyValue: z.string().max(4096).optional(), mandatory: z.boolean().optional() }).strict();
const validName = value => name.safeParse(value).success;
const safeScopeValue = value => typeof value === 'string' && /^[A-Za-z0-9_. -]{1,128}$/.test(value) && !/^[A-Za-z0-9_-]{40,}$/.test(value);
const strings = value => Array.isArray(value) && value.every(validName) && new Set(value).size === value.length;
const text = value => typeof value === 'string' ? value.slice(0, 256) : null;
const issue = (code, severity = 'needs_review', reference) => ({ code, severity, ...(reference ? { reference: text(reference) } : {}) });
const outcome = findings => findings.some(row => row.severity === 'blocked') ? 'blocked' : findings.length ? 'needs_review' : 'rules_validated';
const sourceFailure = error => ({ result: error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : error?.status === 404 || error?.status === 501 ? 'unavailable' : 'error', status: Number.isInteger(error?.status) ? error.status : null, ...(error?.code === 'INTEGRATION_DEADLINE' ? { stop_reason: 'deadline' } : {}) });

function projection(kind, row) {
  const base = { name: text(row.name) };
  if (kind === 'action') return { ...base, type: text(row.type), state: text(row.state), fallbackAction: text(row.fallbackAction), enableDeliveryStatus: typeof row.enableDeliveryStatus === 'boolean' ? row.enableDeliveryStatus : null };
  if (kind === 'condition') return { ...base, propertyKey: text(row.propertyKey), predicate: text(row.predicate), ...(typeof row.mandatory === 'boolean' ? { mandatory: row.mandatory } : {}), property_value: row.propertyValue === undefined ? 'absent' : 'withheld', configuration_digest: canonicalDigest(row) };
  return { ...base, state: text(row.state), snoozeTimestamp: Number.isFinite(row.snoozeTimestamp) ? row.snoozeTimestamp : null,
    conditions: strings(row.conditions) ? row.conditions.map(text).slice(0, 50) : null, actions: strings(row.actions) ? row.actions.map(text).slice(0, 50) : null,
    references_truncated: (row.conditions?.length ?? 0) > 50 || (row.actions?.length ?? 0) > 50, configuration_digest: canonicalDigest(row) };
}

function decodePage(raw, page) {
  const meta = raw?.metadata;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (!Array.isArray(raw?.results) || !meta || !['page', 'pageSize', 'totalPages', 'totalResultsCount'].every(key => integer(meta[key]))
    || meta.page !== page || meta.pageSize !== PAGE_SIZE || meta.totalPages !== Math.ceil(meta.totalResultsCount / PAGE_SIZE) && !(meta.totalResultsCount === 0 && meta.totalPages === 1)
    || raw.results.length !== Math.min(PAGE_SIZE, Math.max(0, meta.totalResultsCount - page * PAGE_SIZE))
    || raw.results.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !validName(row.name))
    || new Set(raw.results.map(row => row.name)).size !== raw.results.length) throw new IntegrationError('ANS collection response has invalid paging metadata or identities');
  return { rows: raw.results, total: meta.totalResultsCount };
}

function createReader(client) {
  return createCollectionPager(client, { root: ROOT, request: async (method, path, options) => {
    const skip = Number(options.query?.$skip ?? 0);
    const page = Math.floor(skip / PAGE_SIZE);
    const raw = await client.request('GET', `${ROOT}${path}`, { query: { page, pageSize: PAGE_SIZE }, unwrap: false, deadline: options.deadline });
    const decoded = decodePage(raw, page);
    return { d: { results: decoded.rows.slice(skip % PAGE_SIZE), __count: String(decoded.total) } };
  } });
}

async function named(client, kind, value, deadline) {
  const result = await client.request('GET', `${ROOT}/${kind}/${encodeURIComponent(value)}`, { expect: [200, 404], withStatus: true, unwrap: false, deadline });
  if (result.status === 404) return null;
  const row = result.data;
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.name !== value) throw new IntegrationError('ANS named response identity does not match the requested resource');
  return entity(row);
}

function resolver(client, deadline) {
  const cache = new Map();
  return (kind, value) => {
    if (!validName(value)) return Promise.reject(new IntegrationError('ANS reference identity is invalid'));
    const key = `${kind}:${value}`;
    if (!cache.has(key)) {
      if (cache.size >= MAX_REFERENCES) return Promise.reject(new IntegrationError('ANS reference inspection exceeded its bounded source limit'));
      cache.set(key, named(client, kind, value, deadline));
    }
    return cache.get(key);
  };
}

// A mandatory exact condition can constrain an otherwise broad OR group. Explicit optional
// mixtures have no locally established truth table and must never be called a verified match.
function exactScope(conditions, key) {
  const group = conditions.filter(row => row.propertyKey === key);
  const mandatory = group.filter(row => row.mandatory === true);
  const candidates = conditions.some(row => row.mandatory === true) ? mandatory : group;
  if (!candidates.length || candidates.some(row => row.predicate !== 'EQUALS' || !safeScopeValue(row.propertyValue))) return null;
  const values = [...new Set(candidates.map(row => row.propertyValue))];
  if (mandatory.length && values.length !== 1) return null;
  return values;
}

async function inspectSubscription(subscription, resolve, { node_names, now = Date.now() } = {}) {
  const findings = [];
  let complete = true;
  const conditions = [];
  const actions = [];
  if (subscription.state === 'DISABLED') findings.push(issue('subscription_disabled', 'blocked'));
  else if (subscription.state !== 'ENABLED') findings.push(issue('subscription_state_unknown'));
  const snooze = subscription.snoozeTimestamp;
  // Normalize Unix seconds; tolerate epoch-millisecond representations without exposing dates.
  const snoozeMillis = typeof snooze === 'number' && snooze < 100_000_000_000 ? snooze * 1000 : snooze;
  const snoozed = typeof snoozeMillis === 'number' && Number.isFinite(snoozeMillis) && snoozeMillis > now;
  if (snoozed) findings.push(issue('subscription_snoozed', 'blocked'));
  if (snooze !== undefined && (!Number.isSafeInteger(snooze) || snooze < 0)) findings.push(issue('subscription_snooze_unknown'));
  const resolveRefs = async (kind, refs, target) => {
    if (!strings(refs) || refs.length === 0 || refs.length > 50) { findings.push(issue(`${kind}_references_invalid`, 'blocked')); complete = false; return; }
    for (const ref of refs) {
      try {
        const row = await resolve(kind, ref);
        if (row) target.push(row);
        else findings.push(issue(`${kind}_missing`, 'blocked', ref));
      } catch (error) { complete = false; findings.push({ ...issue(`${kind}_unreadable`, 'needs_review', ref), source_result: sourceFailure(error) }); }
    }
  };
  await resolveRefs('condition', subscription.conditions, conditions);
  await resolveRefs('action', subscription.actions, actions);
  const visited = new Set();
  async function fallback(row, stack = new Set()) {
    if (stack.has(row.name)) { findings.push(issue('action_fallback_cycle', 'needs_review', row.name)); return; }
    if (visited.has(row.name)) return;
    visited.add(row.name);
    if (row.state === 'DISABLED') findings.push(issue('action_disabled', 'blocked', row.name));
    else if (row.state !== 'ENABLED') findings.push(issue('action_state_unknown', 'needs_review', row.name));
    if (row.fallbackAction !== undefined && row.fallbackAction !== null && row.fallbackAction !== '') {
      try {
        const next = await resolve('action', row.fallbackAction);
        if (!next) findings.push(issue('action_missing', 'blocked', row.fallbackAction));
        else { if (!actions.some(action => action.name === next.name)) actions.push(next); await fallback(next, new Set([...stack, row.name])); }
      } catch (error) { complete = false; findings.push({ ...issue('action_unreadable', 'needs_review', row.fallbackAction), source_result: sourceFailure(error) }); }
    }
  }
  for (const action of [...actions]) await fallback(action);
  for (const row of conditions) {
    if (!validName(row.propertyKey) || !PREDICATES.includes(row.predicate) || row.mandatory !== undefined && typeof row.mandatory !== 'boolean'
      || !['ANY', 'NO_VALUE'].includes(row.predicate) && typeof row.propertyValue !== 'string'
      || ['LESS_THAN', 'GREATER_THAN', 'NUMBER_EQUALS'].includes(row.predicate) && (typeof row.propertyValue !== 'string' || row.propertyValue.trim() === '' || !Number.isFinite(Number(row.propertyValue)))) findings.push(issue('condition_unsupported', 'needs_review', row.name));
  }
  if (conditions.some(row => row.mandatory === false)) findings.push(issue('explicit_optional_semantics_unverified'));
  const eventTypes = exactScope(conditions, 'eventType');
  const nodeNames = exactScope(conditions, 'tags.nodeName');
  const nodeIds = exactScope(conditions, 'tags.nodeId');
  const knownEvents = eventTypes?.every(value => CTMS_EVENTS.has(value));
  if (!eventTypes) findings.push(issue('event_scope_unsafe'));
  else if (!knownEvents) findings.push(issue('event_scope_unverified'));
  if (knownEvents && !nodeNames && !nodeIds) findings.push(issue('ctms_node_scope_unsafe'));
  if (node_names && (!nodeNames || nodeNames.some(value => !node_names.includes(value)))) findings.push(issue('requested_node_scope_unverified'));
  if (conditions.some(row => !['eventType', 'tags.nodeName', 'tags.nodeId'].includes(row.propertyKey))) findings.push(issue('additional_condition_scope_unverified'));
  const scoped = !findings.some(row => /scope|semantics|unsupported/.test(row.code));
  return { ...projection('subscription', subscription), snoozed, complete, outcome: outcome(findings), findings,
    conditions: conditions.map(row => projection('condition', row)), actions: actions.map(row => projection('action', row)),
    scope: { event_types: knownEvents ? eventTypes : [], node_names: nodeNames ?? [], node_ids: nodeIds ?? [], verified: scoped } };
}

export async function validateNativeRules(client, args = {}, { deadline = Date.now() + 30000 } = {}) {
  args = z.object(ruleInputs).strict().parse(args);
  const items = [];
  const findings = [];
  let complete = true;
  const resolve = resolver(client, deadline);
  const subscriptions = [];
  try {
    if (args.subscription_names) {
      for (const value of new Set(args.subscription_names)) {
        try {
          const row = await resolve('subscription', value);
          if (row) subscriptions.push(row);
          else findings.push({ ...issue('subscription_missing', 'blocked'), subscription: value });
        } catch (error) {
          complete = false;
          findings.push({ ...issue('subscription_unreadable'), subscription: value, source_result: sourceFailure(error) });
        }
      }
    } else {
      let expectedTotal;
      const seen = new Set();
      for (let page = 0; ; page += 1) {
        if (page >= 10) { complete = false; findings.push(issue('subscription_source_limit')); break; }
        const decoded = decodePage(await client.request('GET', `${ROOT}/subscription`, { query: { page, pageSize: PAGE_SIZE }, unwrap: false, deadline }), page);
        if (expectedTotal !== undefined && decoded.total !== expectedTotal || decoded.rows.some(row => seen.has(row.name))) { complete = false; findings.push(issue('subscription_source_changed')); break; }
        expectedTotal = decoded.total;
        decoded.rows.forEach(row => seen.add(row.name));
        subscriptions.push(...decoded.rows);
        if (subscriptions.length >= decoded.total) break;
      }
    }
  } catch (error) { complete = false; findings.push({ ...issue('subscriptions_unreadable'), source_result: sourceFailure(error) }); }
  if (!subscriptions.length && !findings.length) findings.push(issue('no_subscriptions', 'blocked'));
  for (const subscription of subscriptions) {
    const result = await inspectSubscription(subscription, resolve, args);
    if (Buffer.byteLength(JSON.stringify({ items: [...items, result], findings }, null, 2), 'utf8') > MAX_OUTPUT) { complete = false; findings.push(issue('rule_output_limit')); break; }
    items.push(result);
    complete &&= result.complete;
  }
  const allFindings = [...findings, ...items.flatMap(item => item.findings)];
  return { complete, delivery: 'needs_admin_confirmation', collection: 'needs_admin_confirmation', outcome: outcome(allFindings), findings, items };
}

function validateCondition(row) {
  if (!['ANY', 'NO_VALUE'].includes(row.predicate) && row.propertyValue === undefined) throw new IntegrationError('ANS predicate requires propertyValue');
  if (['LESS_THAN', 'GREATER_THAN', 'NUMBER_EQUALS'].includes(row.predicate) && (row.propertyValue.trim() === '' || !Number.isFinite(Number(row.propertyValue)))) throw new IntegrationError('ANS numeric predicate requires a finite numeric propertyValue');
}

async function setResource(client, kind, desired, expectedDigest, deadline) {
  const current = await named(client, kind, desired.name, deadline);
  if (current && (!expectedDigest || canonicalDigest(current) !== expectedDigest)) throw new IntegrationError('ANS update requires the fresh matching expected_digest');
  if (!current && expectedDigest !== undefined) throw new IntegrationError('ANS create requires expected_digest to be absent');
  const merged = { ...(current ?? {}), ...desired };
  if (kind === 'condition') validateCondition(merged);
  if (kind === 'subscription') {
    const report = await inspectSubscription(merged, resolver(client, deadline));
    // Disabled/snoozed is an intentional state input, not permission to bypass unsafe scope or unresolved references.
    const blocking = report.findings.filter(row => !['subscription_disabled', 'subscription_snoozed', 'event_scope_unverified'].includes(row.code));
    if (!report.complete || blocking.length) throw new IntegrationError('ANS subscription references or event/node scope are incomplete, unsafe or unverified; inspect native rules before writing');
  }
  const accepted = await client.request(current ? 'PUT' : 'POST', `${ROOT}/${kind}${current ? `/${encodeURIComponent(desired.name)}` : ''}`, {
    json: merged, expect: [200, 201, 202, 204], withStatus: true, responseType: 'none', deadline
  });
  const status = accepted.status;
  const result = { name: desired.name, operation: current ? 'update' : 'create', accepted: true, status, verified: false, delivery: 'needs_admin_confirmation' };
  try {
    const observed = await named(client, kind, desired.name, deadline);
    result.verified = observed !== null && Object.entries(merged).every(([key, value]) => canonicalDigest({ value: observed[key] }) === canonicalDigest({ value }));
    result.outcome = result.verified ? 'succeeded' : 'unverified';
    if (observed) result.configuration = projection(kind, observed);
  } catch (error) { result.outcome = 'unverified'; result.source_result = sourceFailure(error); }
  return result;
}

export function registerAnsTools(register, client) {
  const pager = createReader(client);
  for (const [tool, kind] of [['ans_list_subscriptions', 'subscription'], ['ans_list_conditions', 'condition'], ['ans_list_action_metadata', 'action']]) {
    register(tool, `List ANS ${kind} metadata`, 'Read bounded native alert configuration metadata using zero-based ANS paging. Condition values and action properties/recipients are withheld. Cursors are signed and runtime-bound; rule access does not prove notification delivery.',
      { top: top(200, 100), cursor: cursorSchema }, READ_ONLY_ANNOTATIONS,
      args => pager.page({ path: `/${kind}`, top: args.top, cursor: args.cursor, fallback: false, consistency: 'best_effort', identity: 'name', project: row => projection(kind, row), deadline: Date.now() + 30000 }));
  }
  register('ans_validate_native_rules', 'Validate native ANS rules', 'Resolve subscriptions, conditions and action/fallback references completely. Exact cTMS event and node scope is checked conservatively; unsupported combinations require review. Collection and notification delivery always need administrator confirmation.', ruleInputs, READ_ONLY_ANNOTATIONS,
    args => validateNativeRules(client, args));
  register('ans_set_condition', 'Set ANS condition', 'Create or update one condition. Exact confirmation is checked before requests. Updates require fresh canonical configuration_digest as expected_digest; creates must omit it. Metadata is preserved and values are withheld from read-back.',
    { condition: conditionInput, expected_digest: digest, confirmation: z.string() }, OVERWRITE_ANNOTATIONS, args => {
      requireConfirmation(args.confirmation, `SET ALERT CONDITION ${args.condition.name}`);
      validateCondition(args.condition);
      return setResource(client, 'condition', args.condition, args.expected_digest, Date.now() + 30000);
    });
  register('ans_set_subscription', 'Set ANS subscription', 'Create or update one deliberately scoped subscription, after resolving every condition/action/fallback. Exact confirmation precedes requests. Updates require expected_digest; creates omit it. No action properties or implicit all-events subscriptions are written.',
    { name, state: z.enum(['ENABLED', 'DISABLED']), conditions: z.array(name).min(1).max(50), actions: z.array(name).min(1).max(50), expected_digest: digest, confirmation: z.string() }, OVERWRITE_ANNOTATIONS, args => {
      requireConfirmation(args.confirmation, `SET ALERT SUBSCRIPTION ${args.name}`);
      const { expected_digest, confirmation, ...desired } = args;
      return setResource(client, 'subscription', desired, expected_digest, Date.now() + 30000);
    });
}
