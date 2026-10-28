// Open Connectors platform metadata and the one documented instance enabled-state action.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createStaticServiceClient, IntegrationError } from './integration-http.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { READ_ONLY_ANNOTATIONS, OVERWRITE_ANNOTATIONS, requireConfirmation, top } from './integration-common.mjs';

const ROOT = '/elements/api-v2';
const SCOPE = 'open_connectors.instances.v1';
const TTL = 15 * 60 * 1000;
const SOURCE_LIMIT = 2 * 1024 * 1024;
const credentials = new WeakMap();
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).refine(value => value !== 'enabled')]);
const text = z.string().max(512).regex(/^[^\x00-\x1f\x7f]*$/);
const field = value => text.safeParse(value).success;
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && /^[\x21-\x7e]+$/.test(value) && !value.includes(',');
const invalid = message => { throw new IntegrationError(`Open Connectors ${message}`); };

/** Config has already passed the host optional-config parser; keep credentials out of client properties. */
export function createOpenConnectorsClient({ url, userSecret, organizationSecret }, { env, fetchImpl } = {}) {
  if (!secret(userSecret) || !secret(organizationSecret)) invalid('authorization configuration is invalid');
  const base = new URL(url);
  if (!base.pathname.endsWith(ROOT) || base.username || base.password || base.search || base.hash) invalid('service root is invalid');
  const authorization = `User ${userSecret}, Organization ${organizationSecret}`;
  const options = { label: 'Open Connectors', url, env, fetchImpl };
  const client = createStaticServiceClient({ ...options, authorization: () => authorization });
  credentials.set(client, Object.freeze({ root: base.pathname, action: (token, method) => createStaticServiceClient({ ...options, authorization: request => {
    if (request.method !== method || request.path !== `${base.pathname}/instances/enabled`) invalid('enabled-state authorization scope is invalid');
    return `${authorization}, Element ${token}`;
  } }) }));
  return client;
}

function project(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !id.safeParse(row.id).success
    || row.name !== undefined && !field(row.name)) invalid('instance metadata has an invalid identity or schema');
  const result = { id: row.id, ...(row.name !== undefined ? { name: row.name } : {}) };
  if (row.element !== undefined && row.element !== null) {
    const value = row.element;
    if (typeof value !== 'object' || Array.isArray(value) || value.id !== undefined && !id.safeParse(value.id).success
      || ['key', 'name'].some(key => value[key] !== undefined && !field(value[key]))) invalid('element metadata has an invalid schema');
    result.element = Object.fromEntries(['id', 'key', 'name'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  }
  return result;
}

async function named(client, instanceId, deadline) {
  const row = await client.request('GET', `/instances/${encodeURIComponent(instanceId)}`, { unwrap: false, deadline });
  const safe = project(row);
  if (String(safe.id) !== String(instanceId)) invalid('named instance identity does not match the request');
  return { row, safe };
}

function checked(schema, handler) {
  const input = z.object(schema).strict();
  return args => {
    const parsed = input.safeParse(args);
    if (!parsed.success) invalid('tool input is invalid');
    return handler(parsed.data);
  };
}

export function registerOpenConnectorsTools(register, client) {
  const root = credentials.get(client)?.root ?? ROOT;
  const guard = createCollectionPager(client, { root });
  // Raw server tokens never enter a signed (but readable) cursor. Only random private lookup IDs do.
  const listings = new Map();
  async function instances({ top: size, cursor }) {
    const now = Date.now();
    for (const [key, value] of listings) if (value.expires <= now) listings.delete(key);
    const context = cursor ? guard.cursorContext(cursor, { scope: SCOPE }) : randomUUID();
    let listing = listings.get(context);
    if (cursor && !listing) invalid('collection cursor is expired; restart the listing');
    if (!listing) {
      if (listings.size >= 16) listings.delete(listings.keys().next().value);
      listing = { expires: now + TTL, pages: new Map([['first', { token: null, prior: [] }]]), bytes: 0 };
      listings.set(context, listing);
    }
    let observed;
    const pager = createCollectionPager(client, { root, request: async (method, path, options) => {
      if (method !== 'GET' || path !== '/instances' || Object.keys(options.query).some(key => !['$top', '$skiptoken', '$skip'].includes(key))) invalid('collection request scope is invalid');
      const key = options.query.$skiptoken ?? 'first';
      const page = listing.pages.get(key);
      if (!page || options.query.$skip) invalid('collection continuation is invalid');
      if (!page.rows) {
        if (page.end) page.rows = [];
        else {
          const source = await client.request('GET', '/instances', { query: { pageSize: 200, ...(page.token === null ? {} : { nextPage: page.token }) }, unwrap: false, responseHeaders: ['elements-next-page-token', 'nextpage'], deadline: options.deadline });
          if (!Array.isArray(source.data) || source.data.length > 200) invalid('instance collection has an invalid schema or exceeds its page bound');
          const rows = source.data.map(project);
          if (new Set(rows.map(row => String(row.id))).size !== rows.length) invalid('instance collection contains duplicate identities');
          const bytes = Buffer.byteLength(JSON.stringify(rows));
          if (listing.bytes + bytes > SOURCE_LIMIT) invalid('instance collection exceeds the safe size limit');
          const tokens = [source.responseHeaders['elements-next-page-token'], source.responseHeaders.nextpage].filter(value => value !== undefined && value !== '');
          if (tokens.some(value => typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) || new Set(tokens).size > 1) invalid('pagination metadata is invalid');
          const token = tokens[0] ?? null;
          if (token !== null && (token === page.token || page.prior.includes(token))) invalid('pagination metadata repeats a continuation');
          if (token !== null && rows.length === 0) invalid('pagination metadata continues an empty page');
          if (listing.pages.size >= 256) invalid('instance collection exceeds the safe size limit');
          page.rows = rows;
          page.terminal = token === null;
          listing.bytes += bytes;
          // A private end marker lets the shared pager prove exhaustion without inventing a count.
          if (rows.length) {
            page.next = randomUUID();
            listing.pages.set(page.next, { token, prior: token === null ? [] : [...page.prior, token], end: token === null });
          }
        }
      }
      observed = page;
      return { d: { results: page.rows, ...(page.next ? { __next: `${root}/instances?$skiptoken=${page.next}` } : {}) } };
    } });
    const result = await pager.page({ path: '/instances', top: size, cursor, scope: SCOPE, context, fallback: false, deadline: now + 30000 });
    // Absence of the documented token establishes the end; counts remain unknown, never page length.
    if (observed?.terminal && result.stop_reason === 'more' && result.items.length
      && String(result.items.at(-1).id) === String(observed.rows.at(-1)?.id)) return { ...result, complete: true, next_cursor: null, stop_reason: 'end' };
    return result;
  }
  const listInput = { top: top(200, 100), cursor: cursorSchema };
  register('open_connectors_list_instances', 'List Open Connectors instances',
    'Read bounded instance identities and element metadata only. Tokens, configuration and provider data are withheld. Opaque runtime-bound cursors resume documented nextPage pagination; source totals remain unknown.',
    listInput, READ_ONLY_ANNOTATIONS, checked(listInput, instances));
  const getInput = { instance_id: id };
  register('open_connectors_get_instance', 'Get Open Connectors instance metadata',
    'Read one exact instance identity and element id/key/name using platform User/Organization authorization. No token, configuration, provider data or provider-health assertion is returned.',
    getInput, READ_ONLY_ANNOTATIONS, checked(getInput, async ({ instance_id }) => (await named(client, instance_id, Date.now() + 30000)).safe));
  const actionInput = { instance_id: id, enabled: z.boolean(), confirmation: z.string().max(256) };
  register('open_connectors_set_instance_enabled', 'Set Open Connectors instance enabled state',
    'Require exactly ENABLE OPEN CONNECTOR INSTANCE <id> or DISABLE OPEN CONNECTOR INSTANCE <id> before any request. Privately read a fresh instance token, then bodyless PUT (enable) or DELETE (disable) /instances/enabled. DELETE disables, never deletes the instance. HTTP acceptance does not verify effective state or provider health; provider OAuth/re-authentication remains native.',
    actionInput, OVERWRITE_ANNOTATIONS, checked(actionInput, async ({ instance_id, enabled, confirmation }) => {
      requireConfirmation(confirmation, `${enabled ? 'ENABLE' : 'DISABLE'} OPEN CONNECTOR INSTANCE ${instance_id}`);
      const state = credentials.get(client);
      if (!state) invalid('enabled-state credentials are not configured');
      const deadline = Date.now() + 30000;
      const { row } = await named(client, instance_id, deadline);
      if (!secret(row.token)) invalid('named instance has no usable private token');
      const method = enabled ? 'PUT' : 'DELETE';
      const action = state.action(row.token, method);
      const response = await action.request(method, '/instances/enabled', { expect: Array.from({ length: 100 }, (_, index) => 200 + index), responseType: 'none', withStatus: true, deadline });
      return { instance_id, requested_enabled: enabled, accepted: true, http_status: response.status,
        effective_state: 'unverified', provider_health: 'unverified' };
    }));
}
