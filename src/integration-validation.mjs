// Private per-client latest completed validation evidence; never initiate validation from readiness.
const TTL_MS = 15 * 60 * 1000;
const stores = new WeakMap();
const identity = (id, version) => JSON.stringify([id, version]);

export function rememberValidation(client, { id, resolved_version, state_sha256, bundle_sha256, passed, matching_state = true }, now = Date.now()) {
  let entries = stores.get(client);
  if (!entries) { entries = new Map(); stores.set(client, entries); }
  for (const [key, entry] of entries) if (now - entry.completed_at_ms >= TTL_MS) entries.delete(key);
  entries.set(identity(id, resolved_version), { state_sha256, bundle_sha256, passed, matching_state,
    completed_at: new Date(now).toISOString(), completed_at_ms: now });
}

export function validationEvidence(client, { id, resolved_version, state_sha256 }, now = Date.now()) {
  const entries = stores.get(client);
  const key = identity(id, resolved_version);
  const entry = entries?.get(key);
  if (!entry) return { result: 'missing', passed: null };
  if (now - entry.completed_at_ms >= TTL_MS) {
    entries.delete(key);
    return { result: 'expired', passed: null, completed_at: entry.completed_at };
  }
  if (!entry.matching_state || entry.state_sha256 !== state_sha256) return { result: 'state_changed', passed: null, completed_at: entry.completed_at };
  return { result: entry.passed === true ? 'passed' : entry.passed === false ? 'failed' : 'unknown', passed: entry.passed,
    completed_at: entry.completed_at, expires_at: new Date(entry.completed_at_ms + TTL_MS).toISOString() };
}
