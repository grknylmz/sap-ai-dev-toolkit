// Bounded collection traversal. Cursors are private to a client runtime and never authorize arbitrary URLs.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IntegrationError } from './integration-http.mjs';

const OUTPUT_BYTES = 96 * 1024 - 1024;
const SOURCE_BYTES = 2 * 1024 * 1024;
const TTL = 15 * 60 * 1000;
const MAX_CONTINUATIONS = 256;
const runtimes = new WeakMap();
export const cursorSchema = z.string().min(1).max(16384).optional();
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;

/** Preserve OData count/continuation plumbing before projecting individual rows. */
export function decodeCollection(raw) {
  const source = raw?.d ?? raw;
  const items = Array.isArray(source) ? source : source?.results ?? source?.value;
  if (!Array.isArray(items)) throw new IntegrationError('Expected a collection response');
  const count = source?.__count ?? source?.['@odata.count'] ?? source?.['@count'] ?? raw?.['@odata.count'] ?? raw?.['@count'];
  const total = (typeof count === 'number' || typeof count === 'string' && /^\d+$/.test(count)) && Number.isSafeInteger(Number(count)) && Number(count) >= 0 ? Number(count) : null;
  const next = source?.__next ?? source?.['@odata.nextLink'] ?? source?.['@nextLink'] ?? source?.['odata.nextLink'] ?? raw?.['@odata.nextLink'] ?? raw?.['@nextLink'] ?? null;
  if (next !== null && typeof next !== 'string') throw new IntegrationError('Invalid collection continuation');
  return { items, total, next };
}

export function createCollectionPager(client, { root, request } = {}) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('?') || root.includes('#') || root.includes('..') || root.endsWith('/')) throw new IntegrationError('Invalid collection service root');
  // Name enumeration constructs registrars with no client; defer client access until a real request.
  function runtime() {
    if (!client || typeof client.request !== 'function') throw new IntegrationError('Collection client is not configured');
    let state = runtimes.get(client);
    if (!state) { state = { key: randomBytes(32), id: randomBytes(16).toString('hex') }; runtimes.set(client, state); }
    return state;
  }
  const send = (path, options) => request ? request('GET', path, options) : client.request('GET', `${root}${path}`, options);
  const failCursor = () => { throw new IntegrationError('Invalid or expired collection cursor; restart the listing'); };
  function encode(value, state) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', state.key).update(payload).digest('base64url')}`;
  }
  function decode(cursor, binding, state) {
    if (typeof cursor !== 'string' || cursor.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) return failCursor();
    const [payload, signature] = cursor.split('.');
    const expected = createHmac('sha256', state.key).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return failCursor();
    let value;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return failCursor(); }
    if (value.v !== 1 || value.runtime !== state.id || value.root !== root || binding !== undefined && value.binding !== binding || !Number.isFinite(value.expires) || Date.now() >= value.expires || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Array.isArray(value.links) || value.links.length > MAX_CONTINUATIONS) return failCursor();
    return value;
  }
  function relativeLink(link, path, query) {
    const origin = client.origin;
    if (typeof origin !== 'string') throw new IntegrationError('Collection client has no pinned origin');
    const current = new URL(`${root}${path}`, origin);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) current.searchParams.set(key, String(value));
    let target;
    try { target = new URL(link, current); } catch { throw new IntegrationError('Invalid collection continuation URL'); }
    if (target.origin !== origin || target.username || target.password || target.hash || !target.pathname.startsWith(`${root}/`) || decodeURIComponent(target.pathname).split('/').some(part => part === '..' || part === '.')) throw new IntegrationError('Collection continuation leaves the pinned service root');
    if (target.pathname !== new URL(`${root}${path}`, origin).pathname) throw new IntegrationError('Collection continuation changes collection');
    for (const key of target.searchParams.keys()) {
      if (target.searchParams.getAll(key).length !== 1) throw new IntegrationError('Ambiguous collection continuation query');
      if (key === '$skip' || key === '$top') {
        const value = target.searchParams.get(key);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || key === '$top' && (Number(value) < 1 || Number(value) > 501)) throw new IntegrationError('Unbounded collection continuation query');
      }
    }
    // Continuations may change paging only, never filters, projections or ordering.
    const paging = new Set(['$skip', '$skiptoken', '$top', '$inlinecount', '$count']);
    for (const key of new Set([...current.searchParams.keys(), ...target.searchParams.keys()])) {
      if (!paging.has(key) && current.searchParams.get(key) !== target.searchParams.get(key)) throw new IntegrationError('Collection continuation changes query identity');
    }
    return { path: target.pathname.slice(root.length), query: Object.fromEntries(target.searchParams) };
  }

  async function page({ path, query = {}, top = 100, cursor, project = value => value, mode = 'odata', orderBy, identity, consistency, raw, filter, sort, sourceComplete = true, endOfSource, fallback = true, deadline, scope, context, maxBytes = OUTPUT_BYTES, ...options }) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path) || path.split('/').some(part => part === '..' || part === '.')) throw new IntegrationError('Collection path must be relative to its service root');
    if (!Number.isInteger(top) || top < 1 || top > 500 || !['odata', 'local'].includes(mode) || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > OUTPUT_BYTES) throw new IntegrationError('Invalid collection page options');
    const state = runtime();
    const binding = digest(canonical({ root, path, query, orderBy, mode, scope, context, identity: typeof identity === 'function' ? String(identity) : identity, consistency, sourceComplete, endOfSource: endOfSource && String(endOfSource), filter: filter && String(filter), sort: sort && String(sort) }));
    const initialSkip = Number(query.$skip ?? 0);
    if (!Number.isSafeInteger(initialSkip) || initialSkip < 0) throw new IntegrationError('Invalid collection offset');
    let resume = cursor ? decode(cursor, binding, state) : { v: 1, runtime: state.id, root, binding, scope, context, expires: Date.now() + TTL, offset: 0, links: [], skip: initialSkip };
    if (resume.next) relativeLink(resume.next, path, { ...query, ...(orderBy ? { $orderby: orderBy } : {}) });
    if (deadline !== undefined && Date.now() >= deadline) return result([], null, false, null, 'deadline');
    const baseQuery = { ...query, ...(orderBy ? { $orderby: orderBy } : {}) };
    let requestPath = path;
    const localQuery = Object.fromEntries(Object.entries(query).filter(([key]) => !['$top', '$skip', '$orderby', '$inlinecount', '$count'].includes(key)));
    let requestQuery = mode === 'local' || resume.local ? localQuery : { ...baseQuery, $top: top + 1, ...(resume.skip ? { $skip: resume.skip } : {}) };
    if (resume.next) ({ path: requestPath, query: requestQuery } = relativeLink(resume.next, path, baseQuery));
    if (resume.fetchQuery) requestQuery = resume.fetchQuery;
    const currentFingerprint = digest(canonical({ path: requestPath, query: Object.fromEntries(Object.entries(requestQuery).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])) }));
    if (!cursor) resume.links = [currentFingerprint];
    let local = mode === 'local' || resume.local;
    let response;
    try {
      response = raw === undefined || cursor ? await send(requestPath, { ...options, query: requestQuery, unwrap: false, deadline }) : raw;
    } catch (error) {
      if (error.code === 'INTEGRATION_DEADLINE') return result([], null, false, null, 'deadline', { source_result: { result: 'error', stop_reason: 'deadline' } });
      if (/safe size limit/.test(error.message)) return result([], null, false, null, 'source_limit', { source_result: { result: 'error', stop_reason: 'source_limit' } });
      if (!local && fallback && (error.status === 400 || error.status === 501 || /HTTP (400|501)\b/.test(error.message))) {
        try {
          response = await send(path, { ...options, query: localQuery, unwrap: false, deadline });
          local = true;
          requestPath = path;
          requestQuery = localQuery;
          delete resume.next;
        }
        catch (failure) {
          if (/safe size limit/.test(failure.message)) return result([], null, false, null, 'source_limit', { source_result: { result: 'error', stop_reason: 'source_limit' } });
          if (failure.code === 'INTEGRATION_DEADLINE') return result([], null, false, null, 'deadline', { source_result: { result: 'error', stop_reason: 'deadline' } });
          if (failure.status === 400 || failure.status === 501 || /HTTP (400|501)\b/.test(failure.message)) return result([], null, false, null, 'paging_unsupported', { source_result: { result: 'error', status: failure.status ?? Number(/HTTP (\d+)/.exec(failure.message)?.[1]) } });
          throw failure;
        }
      } else throw error;
    }
    if (local && !resume.local) resume.offset += resume.skip;
    if (bytes(response) > SOURCE_BYTES) return result([], null, false, null, 'source_limit');
    const decoded = decodeCollection(response);
    let rows = decoded.items;
    const sourceDigest = local || resume.offset ? digest(rows) : null;
    if (resume.sourceDigest && resume.sourceDigest !== sourceDigest) return result([], decoded.total, false, null, 'source_changed');
    const sourceEnded = endOfSource?.(response) === true;
    if (filter) rows = rows.filter(filter);
    if (sort) rows = [...rows].sort(sort);
    let nextLink = null;
    if (decoded.next && !local) {
      const validated = relativeLink(decoded.next, path, baseQuery);
      nextLink = `${root}${validated.path}?${new URLSearchParams(validated.query)}`;
      const fingerprint = digest(canonical({ path: validated.path, query: validated.query }));
      if (resume.links.includes(fingerprint) || fingerprint === currentFingerprint) throw new IntegrationError('Repeated collection continuation; restart the listing');
    }
    const offset = resume.offset;
    const selected = rows.slice(offset, offset + top);
    const projected = selected.map(project);
    let changed = false;
    let ids;
    if (consistency === 'best_effort') {
      const identify = typeof identity === 'function' ? identity : row => row[identity ?? 'MessageGuid'];
      ids = selected.map(identify).filter(value => value !== undefined && value !== null).map(String);
      changed = new Set(ids).size !== ids.length || ids.some(id => resume.priorIds?.includes(id)) || resume.total !== undefined && resume.total !== null && decoded.total !== null && resume.total !== decoded.total;
    }
    let accepted = projected.length;
    let envelope;
    // Include the actual signed continuation in the byte budget. Never split a row or lose its resume position.
    do {
      const consumed = offset + accepted;
      const buffered = consumed < rows.length;
      const exhausted = !buffered && !nextLink && (local || (decoded.total !== null
        ? (resume.skip + consumed) >= decoded.total
        : sourceEnded || rows.length === 0));
      const limited = !sourceComplete || local && (decoded.next !== null || decoded.total !== null && decoded.total > decoded.items.length);
      let next = null;
      let reason = changed ? 'source_changed' : accepted < projected.length ? 'output_limit' : limited && !buffered ? 'source_limit' : exhausted ? 'end' : 'more';
      if (!rows.length && decoded.total !== null && decoded.total > (resume.skip ?? 0)) reason = 'source_changed';
      if (!changed && reason !== 'source_changed' && accepted > 0 && (buffered || nextLink || !exhausted && !limited)) {
        const nextState = { ...resume, total: decoded.total, priorIds: ids?.slice(0, accepted), local };
        if (buffered && (local || nextLink)) {
          nextState.offset = consumed;
          nextState.sourceDigest = digest(decoded.items);
          nextState.fetchQuery = requestQuery;
        } else {
          nextState.offset = 0;
          delete nextState.sourceDigest;
          delete nextState.fetchQuery;
          nextState.skip = (resume.skip ?? 0) + consumed;
          nextState.next = nextLink;
        }
        if (!buffered && nextLink) {
          const validated = relativeLink(nextLink, path, baseQuery);
          nextState.links = [...resume.links, digest(canonical(validated))];
        }
        if (nextState.links.length >= MAX_CONTINUATIONS) reason = 'source_limit';
        else {
          const encoded = encode(nextState, state);
          if (encoded.length > 16384) reason = 'source_limit';
          else next = encoded;
        }
      }
      envelope = result(projected.slice(0, accepted), decoded.total, reason === 'end', next, reason, consistency ? { consistency } : {});
      if (Buffer.byteLength(JSON.stringify(envelope, null, 2)) <= maxBytes) return envelope;
      accepted -= 1;
    } while (accepted >= 0);
    return result([], decoded.total, false, null, 'output_limit', consistency ? { consistency } : {});
  }
  function cursorContext(cursor, { scope } = {}) {
    if (!cursor) return undefined;
    const value = decode(cursor, undefined, runtime());
    if (value.scope !== scope) failCursor();
    return value.context;
  }
  function validateCursor(cursor, options) {
    cursorContext(cursor, options);
  }
  return Object.freeze({ page, validateCursor, cursorContext });
}

function result(items, total, complete, next_cursor, stop_reason, extra = {}) {
  return { items, returned: items.length, total, complete, next_cursor, stop_reason, ...extra };
}
