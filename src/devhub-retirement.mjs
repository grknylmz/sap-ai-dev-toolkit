// Consumer retirement never cascades to products, proxies, developers or runtime credentials.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IntegrationError } from './integration-http.mjs';
import { entity, key, OVERWRITE_ANNOTATIONS, READ_ONLY_ANNOTATIONS, requireConfirmation, sleep, top } from './integration-common.mjs';
import { createCollectionPager, cursorSchema, decodeCollection } from './integration-collections.mjs';
import { canonicalDigest } from './integration-state.mjs';
import { redactPrivateValues } from './apim-runtime.mjs';

const DATA = '/odata/1.0/data.svc';
const PREVIEW_TTL = 15 * 60 * 1000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RELATIONSHIPS = 2000;
const applicationId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const productName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const confirmation = z.string().min(1).max(512).optional();
const idValue = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value) ? value : null;
const subscribed = value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
const statusValue = value => typeof value === 'string' && /^[A-Za-z0-9 _-]{1,64}$/.test(value) ? value : null;
const applicationPath = id => `/APIMgmt.Applications(${key(id)})`;
const subscriptionPath = id => `/APIMgmt.Subscriptions(${key(id)})`;
const identityFor = (row, navigation) => navigation === 'ToSubscriptions' ? idValue(row?.id) : idValue(row?.product_id ?? row?.name ?? row?.id);
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const failure = error => ({ result: 'error', ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
const credentialEffects = Object.freeze({ api_key_invalidation: 'unverified', issued_oauth_token_revocation: 'unverified' });

function privateValues(value, values = []) {
  if (!value || typeof value !== 'object') return values;
  for (const [name, entry] of Object.entries(value)) {
    if (/^(?:app_key|app_secret|consumer_?key|consumer_?secret|access_token|refresh_token|password)$/i.test(name) && typeof entry === 'string' && entry) values.push(entry);
    else if (entry && typeof entry === 'object') privateValues(entry, values);
  }
  return values;
}

function subscriptionSummary(value, application) {
  return {
    subscription_id: idValue(value?.id), application_id: idValue(value?.app_id) ?? application,
    product_id: idValue(value?.product_id), rate_plan_id: idValue(value?.ratePlan_id),
    is_subscribed: subscribed(value?.isSubscribed), approval_status: statusValue(value?.status),
    ...(value?.status_code !== undefined ? { approval_status_code: statusValue(String(value.status_code)) } : {})
  };
}

function relationPage(value) {
  try {
    const decoded = decodeCollection(value);
    if (!value || value.__deferred) return null;
    const source = value.d ?? value;
    const count = source.__count ?? source['@odata.count'] ?? source['@count'];
    if (count !== undefined && decoded.total === null) return null;
    if (decoded.items.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return null;
    return decoded;
  } catch { return null; }
}

function referenceEvidence(value, path = '', references = []) {
  if (!value || typeof value !== 'object') return references;
  for (const [name, entry] of Object.entries(value)) {
    if (name === '__metadata' && typeof entry?.uri === 'string') references.push([path, entry.uri]);
    else if (entry && typeof entry === 'object') referenceEvidence(entry, `${path}/${name}`, references);
  }
  return references;
}

/** Register with a null client for tool-name enumeration; all client access stays in handlers. */
export function registerDevhubRetirementTools(register, client, { readBackDelayMs = 5000 } = {}) {
  const previews = new Map();
  const request = (method, path, options) => client.request(method, `${DATA}${path}`, options);
  const origin = () => {
    if (!client || typeof client.origin !== 'string') throw new IntegrationError('Developer Hub has no pinned origin');
    return new URL(client.origin).origin;
  };

  async function namedApplication(id, expanded = true) {
    const response = await request('GET', applicationPath(id), {
      ...(expanded ? { query: { $expand: 'ToAPIProductsDetails,ToSubscriptions/ToAPIProduct,ToSubscriptions/ToRatePlan' } } : {}),
      expect: [200, 404], withStatus: true, unwrap: false
    });
    if (response.status === 404) return null;
    const value = response.data?.d ?? response.data;
    if (!value || value.id !== id) throw new IntegrationError('Cannot establish the requested consumer application identity');
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_SOURCE_BYTES) throw new IntegrationError('Consumer application relationships exceed the safe source limit');
    return value;
  }

  // Follow only a supplied same-navigation continuation, never invent another endpoint/query shape.
  async function inventoryRelationship(application, navigation) {
    let raw = application[navigation];
    const rows = [];
    const seen = new Set();
    const links = new Set();
    let expected = null;
    let bytes = 0;
    const path = `${applicationPath(application.id)}/${navigation}`;
    for (let page = 0; page < 256; page += 1) {
      const decoded = relationPage(raw);
      if (!decoded) return { rows, complete: false, stop_reason: 'unknown_relationship_shape' };
      bytes += Buffer.byteLength(JSON.stringify(raw));
      if (bytes > MAX_SOURCE_BYTES || rows.length + decoded.items.length > MAX_RELATIONSHIPS) return { rows, complete: false, stop_reason: 'source_limit' };
      if (decoded.total !== null) {
        if (expected !== null && expected !== decoded.total) return { rows, complete: false, stop_reason: 'source_changed' };
        expected = decoded.total;
      }
      for (const row of decoded.items) {
        const id = identityFor(row, navigation);
        if (!id || seen.has(id) || navigation === 'ToSubscriptions' && (!idValue(row.product_id) || row.app_id !== undefined && row.app_id !== application.id)) {
          return { rows, complete: false, stop_reason: 'ambiguous_relationship' };
        }
        seen.add(id);
        rows.push(row);
      }
      if (!decoded.next) return { rows, complete: expected === null || expected === rows.length, stop_reason: expected !== null && expected !== rows.length ? 'source_limit' : 'end' };
      let next;
      try { next = new URL(decoded.next, `${origin()}${DATA}${path}`); } catch { return { rows, complete: false, stop_reason: 'invalid_continuation' }; }
      if (next.origin !== origin() || next.username || next.password || next.hash || decodeURIComponent(next.pathname) !== decodeURIComponent(`${DATA}${path}`)
        || [...next.searchParams.keys()].some(name => !['$skip', '$skiptoken', '$top', '$inlinecount', '$count', '$format', '$expand', '$orderby'].includes(name) || next.searchParams.getAll(name).length !== 1)
        || links.has(next.href)) return { rows, complete: false, stop_reason: 'invalid_continuation' };
      links.add(next.href);
      try { raw = await request('GET', path, { query: Object.fromEntries(next.searchParams), unwrap: false }); }
      catch (error) { return { rows, complete: false, stop_reason: 'source_error', source_result: failure(error) }; }
    }
    return { rows, complete: false, stop_reason: 'source_limit' };
  }

  async function inspect(id) {
    const application = await namedApplication(id);
    if (!application) return null;
    const subscriptions = await inventoryRelationship(application, 'ToSubscriptions');
    const legacy = await inventoryRelationship(application, 'ToAPIProductsDetails');
    const owner = { developer_id: application.developer_id ?? null, reg_id: application.reg_id ?? null };
    const ownerKnown = Object.values(owner).some(value => typeof value === 'string' && value.length > 0);
    const statesKnown = subscriptions.rows.every(row => subscribed(row.isSubscribed) !== null);
    const complete = ownerKnown && subscriptions.complete && legacy.complete && statesKnown;
    const sortRows = (rows, navigation) => [...rows].sort((a, b) => compare(identityFor(a, navigation), identityFor(b, navigation)))
      .map(row => ({ value: entity(row), relationship_references: referenceEvidence(row) }));
    return {
      application, subscriptions, legacy, complete, owner,
      evidence: { owner, subscriptions: sortRows(subscriptions.rows, 'ToSubscriptions'), legacy_product_links: sortRows(legacy.rows, 'ToAPIProductsDetails') },
      private_values: privateValues(application).concat(privateValues(subscriptions.rows), privateValues(legacy.rows)),
      findings: [
        ...(!ownerKnown ? ['owner_unknown'] : []), ...(!statesKnown ? ['subscription_state_unknown'] : []),
        ...(!subscriptions.complete ? [`subscriptions_${subscriptions.stop_reason}`] : []),
        ...(!legacy.complete ? [`legacy_products_${legacy.stop_reason}`] : [])
      ]
    };
  }

  function subscriptionPage(application) {
    const page = relationPage(application.ToSubscriptions);
    if (!page) throw new IntegrationError('Consumer subscription relationships are incomplete or unsupported');
    const secrets = privateValues(application);
    return {
      results: page.items.map(row => redactPrivateValues(subscriptionSummary(row, application.id), secrets)),
      ...(page.total === null ? {} : { __count: String(page.total) }), ...(page.next ? { __next: page.next } : {})
    };
  }

  // A local page re-reads exactly the documented expanded application; signed cursors detect drift.
  const collections = createCollectionPager(client, {
    root: DATA,
    request: async (_method, path) => {
      const match = /^\/APIMgmt\.Applications\('([A-Za-z0-9_-]+)'\)\/ToSubscriptions$/.exec(decodeURIComponent(path));
      if (!match) throw new IntegrationError('Invalid consumer subscription listing');
      const application = await namedApplication(match[1]);
      if (!application) throw new IntegrationError('Consumer application does not exist');
      return subscriptionPage(application);
    }
  });

  function reference(value, collection, expectedId, { nullable = false, scalar } = {}) {
    const page = value === null ? { items: [], total: null, next: null } : Array.isArray(value) || value?.results || value?.value ? relationPage(value)
      : value && typeof value === 'object' && !value.__deferred ? { items: [value], total: null, next: null } : null;
    if (nullable && (!page && value === undefined && (scalar === null || scalar === '') || page && page.items.length === 0 && !page.next && (page.total === null || page.total === 0) && (scalar === undefined || scalar === null || scalar === ''))) return null;
    if (!page || page.next || page.items.length !== 1 || page.total !== null && page.total !== 1) throw new IntegrationError('Subscription relationship references are incomplete or ambiguous; unsubscribe refused');
    const uri = page.items[0]?.__metadata?.uri;
    if (typeof uri !== 'string' || /[\x00-\x20\x7f\\]/.test(uri)) throw new IntegrationError('Subscription relationship has no authoritative reference; unsubscribe refused');
    let url;
    try { url = new URL(uri, `${origin()}${DATA}/`); } catch { throw new IntegrationError('Invalid subscription relationship reference'); }
    if (url.origin !== origin() || url.username || url.password || url.search || url.hash) throw new IntegrationError('Subscription relationship leaves the pinned service');
    const match = /^\/odata\/1\.0\/data\.svc\/APIMgmt\.(APIProducts|Applications|RatePlans)\('((?:[^']|'')*)'\)$/.exec(decodeURIComponent(url.pathname));
    const id = match?.[2]?.replaceAll("''", "'");
    if (match?.[1] !== collection || !idValue(id) || expectedId !== undefined && id !== expectedId || scalar && id !== scalar) throw new IntegrationError('Subscription relationship identity does not match its scalar IDs');
    return [{ __metadata: { uri } }];
  }

  async function namedSubscription(id, application, product) {
    const response = await request('GET', subscriptionPath(id), {
      query: { $expand: 'ToAPIProduct,ToApplication,ToRatePlan' }, expect: [200, 404], withStatus: true, unwrap: false
    });
    if (response.status === 404) throw new IntegrationError('The selected subscription no longer exists');
    const value = response.data?.d ?? response.data;
    if (value?.id !== id || value.app_id !== application || value.product_id !== product || typeof value.developer_id !== 'string' || !value.developer_id || subscribed(value.isSubscribed) === null) {
      throw new IntegrationError('Cannot establish the exact subscription and owner identities; unsubscribe refused');
    }
    const body = { id, app_id: value.app_id, product_id: value.product_id, developer_id: value.developer_id, isSubscribed: false };
    for (const field of ['reg_id', 'ratePlan_id']) if (value[field] !== undefined) body[field] = value[field];
    body.ToAPIProduct = reference(value.ToAPIProduct, 'APIProducts', product);
    body.ToApplication = reference(value.ToApplication, 'Applications', application);
    const ratePlan = reference(value.ToRatePlan, 'RatePlans', undefined, { nullable: true, scalar: value.ratePlan_id });
    if (ratePlan) body.ToRatePlan = ratePlan;
    return { value, body };
  }

  register('devhub_list_subscriptions', 'List consumer application subscriptions',
    'List bounded subscription/application/product/rate-plan identities and subscribed/approval state from the expanded consumer application. No credentials or developer personal details are returned; incomplete relationships remain explicit.',
    z.object({ application_id: applicationId, top: top(), cursor: cursorSchema }).strict(), READ_ONLY_ANNOTATIONS,
    async ({ application_id, cursor, ...args }) => {
      const scope = 'devhub_subscriptions';
      if (cursor && collections.cursorContext(cursor, { scope })?.application_id !== application_id) throw new IntegrationError('Subscription cursor belongs to a different application');
      const application = await namedApplication(application_id);
      if (!application) throw new IntegrationError('Consumer application does not exist');
      const legacy = relationPage(application.ToAPIProductsDetails);
      const subscriptions = relationPage(application.ToSubscriptions);
      const page = await collections.page({
        ...args, cursor, path: `${applicationPath(application_id)}/ToSubscriptions`, mode: 'local',
        raw: subscriptionPage(application), scope, context: { application_id }
      });
      const legacyComplete = Boolean(legacy && !legacy.next && (legacy.total === null || legacy.total === legacy.items.length));
      const model = !legacyComplete ? 'unknown' : legacy.items.length
        ? subscriptions?.items.length ? 'mixed' : 'legacy' : 'subscription';
      return {
        ...page, model, legacy_product_link_count: legacy?.total ?? (legacyComplete ? legacy.items.length : null),
        legacy_relationships_complete: legacyComplete, complete: page.complete && legacyComplete,
        ...(!legacyComplete && page.stop_reason === 'end' ? { stop_reason: 'source_limit' } : {})
      };
    });

  register('devhub_unsubscribe_application', 'Unsubscribe application from a product',
    'Preview by default. Execute one documented batch PUT for the exact existing subscription, preserving its actual relationship references; legacy or ambiguous models are refused. Requires UNSUBSCRIBE APPLICATION <application_id> FROM <product> before requests. Fresh isSubscribed:false read-back is required; this does not prove API-key invalidation or OAuth-token revocation.',
    z.object({ application_id: applicationId, product: productName, dry_run: z.boolean().default(true), confirmation }).strict(), OVERWRITE_ANNOTATIONS,
    async ({ application_id, product, dry_run = true, confirmation: approved }) => {
      const required = `UNSUBSCRIBE APPLICATION ${application_id} FROM ${product}`;
      if (!dry_run) requireConfirmation(approved, required);
      const inventory = await inspect(application_id);
      if (!inventory) throw new IntegrationError('Consumer application does not exist');
      if (!inventory.complete) throw new IntegrationError('Cannot establish complete consumer relationships and owner; unsubscribe refused');
      if (inventory.legacy.rows.length) throw new IntegrationError('Legacy product links are present; mixing subscription models is refused');
      const matches = inventory.subscriptions.rows.filter(row => row.product_id === product);
      if (matches.length !== 1) throw new IntegrationError('Expected exactly one existing subscription for the selected product; unsubscribe refused');
      const subscription = await namedSubscription(matches[0].id, application_id, product);
      if (inventory.owner.developer_id && inventory.owner.developer_id !== subscription.value.developer_id) throw new IntegrationError('Subscription owner differs from the application owner; unsubscribe refused');
      const secrets = inventory.private_values.concat(privateValues(subscription.value));
      const base = { application_id, product, subscription_id: subscription.value.id, ...credentialEffects };
      if (dry_run) return redactPrivateValues({ ...base, dry_run: true, complete: true, is_subscribed: subscribed(subscription.value.isSubscribed), required_confirmation: required,
        impact: 'Set only the selected existing subscription to isSubscribed:false; retain the application and every other subscription.' }, secrets);
      if (subscribed(subscription.value.isSubscribed) === false) return redactPrivateValues({ ...base, accepted: false, already_unsubscribed: true, unsubscribed: true, read_back_verified: true }, secrets);
      const intendedDigest = canonicalDigest({ body: subscription.body, relationship_references: referenceEvidence(subscription.body) });
      const batch = `batch_${randomUUID()}`;
      const changeset = `changeset_${randomUUID()}`;
      const payload = [
        `--${batch}`, `Content-Type: multipart/mixed; boundary=${changeset}`, '', `--${changeset}`,
        'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '',
        `PUT APIMgmt.Subscriptions(${key(subscription.value.id)}) HTTP/1.1`, 'Content-Type: application/json', 'Accept: application/json', '',
        JSON.stringify(subscription.body), `--${changeset}--`, `--${batch}--`, ''
      ].join('\r\n');
      let response;
      try { response = await request('POST', '/$batch', { body: payload, contentType: `multipart/mixed; boundary=${batch}`, accept: 'multipart/mixed', responseType: 'text', expect: [200, 202], withStatus: true }); }
      catch (error) { return redactPrivateValues({ ...base, accepted: Number.isInteger(error?.status) ? false : null, unsubscribed: false, read_back_verified: false, outcome: 'unverified', source_result: failure(error) }, secrets); }
      const statuses = [...String(response.data).matchAll(/(?:^|\r?\n)HTTP\/1\.[01] (\d{3})(?:[ \r\n])/g)].map(match => Number(match[1]));
      const result = { ...base, batch_accepted: true, http_status: response.status, member_statuses: statuses.slice(0, 20), member_count: statuses.length,
        member_statuses_truncated: statuses.length > 20, accepted: statuses.length === 1 ? statuses[0] >= 200 && statuses[0] < 300 : null,
        unsubscribed: false, read_back_verified: false, outcome: 'unverified' };
      if (result.accepted !== true) return redactPrivateValues({ ...result, ...(result.accepted === false ? { outcome: 'failed' } : {}) }, secrets);
      const inner = String(response.data).slice(String(response.data).search(/HTTP\/1\.[01] /));
      const headerEnd = /\r?\n\r?\n/.exec(inner);
      if (!headerEnd) return redactPrivateValues(result, secrets);
      const embeddedBody = inner.slice(headerEnd.index + headerEnd[0].length).split(/\r?\n--/)[0].trim();
      if (embeddedBody) {
        let decoded;
        try { decoded = JSON.parse(embeddedBody); } catch { return redactPrivateValues(result, secrets); }
        if (decoded?.error) return redactPrivateValues({ ...result, accepted: false, outcome: 'failed' }, secrets);
        if (!decoded || typeof decoded !== 'object' || !(decoded.d || decoded.id)) return redactPrivateValues(result, secrets);
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt) await sleep(readBackDelayMs);
        try {
          const observed = await namedSubscription(subscription.value.id, application_id, product);
          secrets.push(...privateValues(observed.value));
          if (subscribed(observed.value.isSubscribed) === false && canonicalDigest({ body: observed.body, relationship_references: referenceEvidence(observed.body) }) === intendedDigest) {
            return redactPrivateValues({ ...result, unsubscribed: true, read_back_verified: true, outcome: 'succeeded' }, secrets);
          }
        } catch (error) { return redactPrivateValues({ ...result, source_result: failure(error) }, secrets); }
      }
      return redactPrivateValues(result, secrets);
    });

  register('devhub_delete_application', 'Delete consumer application',
    'Preview by default; cache the complete owner/subscription/legacy-link approval for 15 minutes. Active subscriptions or any legacy product links require separately approved allow_active_subscriptions:true. Execute requires DELETE CONSUMER APPLICATION <SHA256> matching that cached preview before requests, then fresh equal relationships. DELETE once and verify named absence; API-key invalidation and issued OAuth-token revocation remain unverified.',
    z.object({ application_id: applicationId, dry_run: z.boolean().default(true), allow_active_subscriptions: z.boolean().default(false), confirmation }).strict(), OVERWRITE_ANNOTATIONS,
    async ({ application_id, dry_run = true, allow_active_subscriptions = false, confirmation: approved }) => {
      for (const [digest, preview] of previews) if (Date.now() >= preview.expires) previews.delete(digest);
      let cached;
      if (!dry_run) {
        const match = /^DELETE CONSUMER APPLICATION ([a-f0-9]{64})$/.exec(approved ?? '');
        cached = match ? previews.get(match[1]) : null;
        if (!cached || cached.application_id !== application_id || cached.allow_active_subscriptions !== allow_active_subscriptions) {
          throw new IntegrationError('A matching unexpired deletion preview confirmation is required; request a new dry run before any network access');
        }
        requireConfirmation(approved, cached.required_confirmation);
        // Claim once before yielding to network I/O; concurrent executions cannot reuse this approval.
        previews.delete(match[1]);
      }
      const inventory = await inspect(application_id);
      if (!inventory) return { application_id, dry_run, accepted: false, already_absent: true, deleted: false, deletion_verified: true, ...credentialEffects };
      const binding = { origin: origin(), application_id, allow_active_subscriptions, ...inventory.evidence };
      const digest = canonicalDigest(binding);
      const required = `DELETE CONSUMER APPLICATION ${digest}`;
      const active = inventory.subscriptions.rows.filter(row => subscribed(row.isSubscribed) === true).length;
      const dependencyBlocked = !allow_active_subscriptions && (active > 0 || inventory.legacy.rows.length > 0);
      const blocked = !inventory.complete || dependencyBlocked;
      if (dry_run) {
        if (!blocked) {
          if (previews.size >= 128 && !previews.has(digest)) previews.delete(previews.keys().next().value);
          previews.set(digest, { application_id, allow_active_subscriptions, binding, required_confirmation: required, expires: Date.now() + PREVIEW_TTL });
        }
        return redactPrivateValues({
          application_id, host: new URL(origin()).host, dry_run: true, complete: inventory.complete, blocked, allow_active_subscriptions,
          owner: { identity_sha256: canonicalDigest(inventory.owner) },
          subscriptions: { count: inventory.subscriptions.rows.length, active_count: active, complete: inventory.subscriptions.complete,
            items: inventory.subscriptions.rows.slice(0, 100).map(row => subscriptionSummary(row, application_id)), summaries_truncated: inventory.subscriptions.rows.length > 100 },
          legacy_product_links: { count: inventory.legacy.rows.length, complete: inventory.legacy.complete,
            product_ids: inventory.legacy.rows.slice(0, 100).map(row => identityFor(row, 'ToAPIProductsDetails')), summaries_truncated: inventory.legacy.rows.length > 100 },
          findings: [...inventory.findings, ...(dependencyBlocked ? ['active_subscriptions_or_legacy_product_links_require_explicit_permission'] : [])],
          ...(blocked ? {} : { required_confirmation: required, approval_expires_at: new Date(Date.now() + PREVIEW_TTL).toISOString() }),
          impact: 'Delete only this consumer application and its application associations. No product/proxy/developer deletion; credential and token revocation are not verified.', ...credentialEffects
        }, inventory.private_values);
      }
      if (!inventory.complete || blocked || Date.now() >= cached.expires || canonicalDigest(cached.binding) !== digest) throw new IntegrationError('Consumer owner or relationships changed, became incomplete, or approval expired; deletion refused. Request a new dry run.');
      const base = { application_id, ...credentialEffects };
      const clean = value => redactPrivateValues(value, inventory.private_values);
      let response;
      try { response = await request('DELETE', applicationPath(application_id), { expect: [...Array.from({ length: 100 }, (_, index) => 200 + index), 404], responseType: 'none', withStatus: true }); }
      catch (error) { return clean({ ...base, accepted: Number.isInteger(error?.status) ? false : null, deleted: false, deletion_verified: false, outcome: 'unverified', source_result: failure(error) }); }
      const accepted = response.status >= 200 && response.status < 300;
      const result = { ...base, accepted, http_status: response.status, deleted: false, deletion_verified: false, outcome: 'unverified' };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt) await sleep(readBackDelayMs);
        try {
          if (!await namedApplication(application_id, false)) return clean({ ...result, deleted: accepted, already_absent: !accepted, deletion_verified: true, outcome: 'succeeded' });
        } catch (error) { return clean({ ...result, source_result: failure(error) }); }
      }
      return clean({ ...result, pending: true });
    });
}
