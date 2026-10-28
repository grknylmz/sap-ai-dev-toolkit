// Private immutable content backups. Archives and configuration values never enter tool results.
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, chmod, lstat, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { integrationCredentialsPath } from './integration-credentials.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, OVERWRITE_ANNOTATIONS, requireConfirmation } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';
import { readCpiContent, writeCpiConfigurations, CPI_BASE, cpiArtifactPath } from './cpi-content.mjs';
import { readApiProxy, exportApiProxyArchive, importApiProxyBundle } from './apim-content.mjs';
import { bundleDigest, readBundle, strFromU8, parseProperties } from './iflow-bundle.mjs';
import { apiProxyLayout, xmlLocate, xmlChildren, xmlText } from './apim-bundle.mjs';
import { canonicalJson, canonicalDigest, stateDigest } from './integration-state.mjs';

const MAX_ARCHIVE = 20 * 1024 * 1024;
const MAX_SNAPSHOT = 100 * 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;
const SOURCE_RECORDS = 1000;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/);
const proxyId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const version = z.string().max(100).regex(/^(?:active|\d+\.\d+\.\d+)$/);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cpi_iflow'), id, version: version.default('active') }).strict(),
  z.object({ kind: z.literal('apim_proxy'), id: proxyId }).strict()
]);
const snapshotSchema = z.object({ targets: z.array(targetSchema).min(1).max(20), dry_run: z.boolean().default(true), confirmation: z.string().max(200).optional() }).strict();
const restoreSchema = z.object({ snapshot_id: z.string().regex(UUID), expected_current_digests: z.record(z.string().regex(DIGEST)).optional(), dry_run: z.boolean().default(true), confirmation: z.string().max(200).optional() }).strict();
const listSchema = z.object({ top: z.number().int().min(1).max(200).default(100), cursor: cursorSchema }).strict();
const configSchema = z.array(z.object({ ParameterKey: z.string().max(1000), ParameterValue: z.string(), DataType: z.string().max(1000) }).strict()).max(2000);
const utf8Order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const targetKey = target => `${target.kind}:${target.id}`;
const invalid = () => { throw new IntegrationError('Snapshot record is invalid, incomplete, or has failed integrity verification'); };
function parse(schema, args) {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new IntegrationError('Invalid integration release input; check target kinds, selectors, booleans and digest fields');
  return parsed.data;
}
function selectedTargets(targets) {
  const sorted = [...targets].sort((a, b) => utf8Order(targetKey(a), targetKey(b)));
  if (new Set(sorted.map(targetKey)).size !== sorted.length) throw new IntegrationError('Snapshot targets must have unique kind and identity');
  return sorted;
}
function originsFor(targets, clients) {
  const result = {};
  for (const target of targets) {
    const side = target.kind === 'cpi_iflow' ? 'cpi' : 'apim';
    if (!clients[side] || typeof clients[side].request !== 'function') throw new IntegrationError(`The ${side.toUpperCase()} side is not configured`);
    let url;
    try { url = new URL(clients[side].origin); } catch { throw new IntegrationError('Release client has no pinned tenant origin'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.length > 253 || !['https:', 'http:'].includes(url.protocol)) throw new IntegrationError('Release client has an invalid tenant origin');
    result[side] = url.origin;
  }
  return result;
}
const hostsFor = origins => Object.fromEntries(Object.entries(origins).map(([side, origin]) => [side, new URL(origin).host]));
function configurationIdentity(configurations) {
  const parsed = parse(configSchema, configurations);
  if (new Set(parsed.map(row => row.ParameterKey)).size !== parsed.length) invalid();
  return parsed.sort((a, b) => utf8Order(a.ParameterKey, b.ParameterKey));
}
function safeFailure(error) {
  const status = Number(error?.status);
  return { result: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : [404, 501].includes(status) ? 'unavailable' : 'error',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
}
function namesSummary(names, prefix = 'changed_parameter') {
  const sorted = [...new Set(names)].sort(utf8Order);
  return { [`${prefix}_names`]: sorted.slice(0, 20).map(name => name.slice(0, 100)), [`${prefix}_count`]: sorted.length,
    [`${prefix}_names_truncated`]: sorted.length > 20 || sorted.some(name => name.length > 100) };
}
function parameterDefaults(files) {
  const bytes = files.get('src/main/resources/parameters.prop');
  return bytes ? parseProperties(strFromU8(bytes)) : {};
}
function changedParameters(saved, current) {
  const configured = content => new Map(content.configurations.map(row => [row.ParameterKey, [row.ParameterValue, row.DataType]]));
  const defaults = content => new Map(Object.entries(content.parameter_defaults));
  const before = configured(current), after = configured(saved);
  const beforeDefaults = defaults(current), afterDefaults = defaults(saved);
  return [...new Set([...before.keys(), ...after.keys(), ...beforeDefaults.keys(), ...afterDefaults.keys()])]
    .filter(name => canonicalJson(before.get(name)) !== canonicalJson(after.get(name)) || beforeDefaults.get(name) !== afterDefaults.get(name));
}
async function regularFile(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes || (stat.mode & 0o077)) invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || !opened.isFile()) invalid();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) invalid();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) invalid();
    return bytes;
  } finally { await handle.close(); }
}
async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  if (create) await chmod(path, 0o700);
  else if (stat.mode & 0o077) invalid();
}
async function exclusiveFile(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function publicTarget(target) {
  return { kind: target.kind, id: target.id, ...(target.kind === 'cpi_iflow' ? { selector: target.selector, resolved_version: target.resolved_version } : {}),
    archive_bytes: target.archive_bytes, archive_sha256: target.archive_sha256, bundle_sha256: target.bundle_sha256, state_sha256: target.state_sha256,
    ...(target.kind === 'cpi_iflow' ? { configuration_bytes: target.configuration_bytes, configuration_sha256: target.configuration_sha256 } : {}) };
}
function publicSnapshot(manifest) {
  return { snapshot_id: manifest.snapshot_id, created_at: manifest.created_at, environment: manifest.environment, hosts: hostsFor(manifest.origins),
    snapshot_sha256: canonicalDigest(manifest), total_bytes: manifest.total_bytes, targets: manifest.targets.map(publicTarget) };
}
function assertArchiveIdentity(files, target) {
  if (target.kind === 'cpi_iflow') {
    const manifest = files.get('META-INF/MANIFEST.MF');
    if (!manifest) invalid();
    const lines = strFromU8(manifest).replace(/\r\n/g, '\n').replace(/\n /g, '').split('\n');
    const identities = lines.filter(line => line.startsWith('Bundle-SymbolicName:')).map(line => line.slice('Bundle-SymbolicName:'.length).trim().split(';')[0].trim());
    if (identities.length !== 1 || identities[0] !== target.id) invalid();
  } else {
    const { root } = apiProxyLayout(files, target.id);
    const roots = [...files.keys()].filter(path => /(?:^|\/)APIProxy\/[^/]+\.xml$/.test(path));
    if (roots.length !== 1 || root !== roots[0]) invalid();
    const xml = strFromU8(files.get(root));
    const element = xmlLocate(xml, []);
    const names = xmlChildren(xml, element).filter(child => child.name.split(':').at(-1) === 'name');
    if (element.name.split(':').at(-1) !== 'APIProxy' || names.length !== 1 || xmlText(xml, names[0]) !== target.id) invalid();
  }
}
async function readTargetRaw(target, clients) {
  if (target.kind === 'cpi_iflow') {
    const content = await readCpiContent(clients.cpi, target.id, target.version ?? 'active');
    assertArchiveIdentity(content.files, target);
    if (typeof content.artifact.Name !== 'string' || content.artifact.Name.length > 1000 || typeof content.resolved_version !== 'string' || content.resolved_version.length > 100 || !/^\d+\.\d+\.\d+$/.test(content.resolved_version) || target.version && target.version !== 'active' && content.resolved_version !== target.version) throw new IntegrationError('CPI snapshot identity or selected version changed');
    const { files, ...original } = content;
    return { ...original, parameter_defaults: parameterDefaults(files), configurations: configurationIdentity(content.configurations), name: content.artifact.Name };
  }
  const artifact = await readApiProxy(clients.apim, target.id);
  if (!artifact || artifact.name !== target.id) throw new IntegrationError('API proxy identity is unavailable');
  const bytes = await exportApiProxyArchive(clients.apim, target.id);
  if (bytes === null) throw new IntegrationError('API proxy export is unavailable');
  const files = readBundle(bytes);
  assertArchiveIdentity(files, target);
  const bundle_sha256 = bundleDigest(files);
  return { bytes, parameter_defaults: {}, configurations: [], name: target.id, bundle_sha256, state_sha256: stateDigest(bundle_sha256) };
}
async function readTarget(target, clients) {
  try { return await readTargetRaw(target, clients); }
  catch (error) {
    const status = safeFailure(error).status;
    throw new IntegrationError(`Integration content could not be read completely${status ? ` (HTTP ${status})` : ''}; private diagnostic details withheld`);
  }
}
async function loadSnapshotRaw(root, snapshotId) {
  await privateDirectory(dirname(root));
  await privateDirectory(root);
  const directory = join(root, snapshotId);
  await privateDirectory(directory);
  const manifestBytes = await regularFile(join(directory, 'manifest.json'), MAX_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { invalid(); }
  if (!manifest || manifest.schema_version !== 1 || manifest.snapshot_id !== snapshotId || !UUID.test(manifest.snapshot_id) || typeof manifest.environment !== 'string' || manifest.environment.length > 100 || typeof manifest.created_at !== 'string' || !Number.isFinite(Date.parse(manifest.created_at)) || !Array.isArray(manifest.targets) || !manifest.targets.length || manifest.targets.length > 20 || !manifest.origins || typeof manifest.origins !== 'object') invalid();
  const { manifest_sha256, ...manifestContent } = manifest;
  if (!DIGEST.test(manifest_sha256) || manifest_sha256 !== canonicalDigest(manifestContent)) invalid();
  const identities = manifest.targets.map(target => {
    if (target.kind === 'cpi_iflow' && typeof target.selector === 'string') return { kind: target.kind, id: target.id, version: target.selector };
    if (target.kind === 'apim_proxy' && target.selector === undefined && target.resolved_version === undefined) return { kind: target.kind, id: target.id };
    invalid();
  });
  const parsed = selectedTargets(parse(z.array(targetSchema).min(1).max(20), identities));
  if (canonicalJson(parsed) !== canonicalJson(identities)) invalid();
  const requiredSides = [...new Set(parsed.map(target => target.kind === 'cpi_iflow' ? 'cpi' : 'apim'))].sort();
  if (canonicalJson(Object.keys(manifest.origins).sort()) !== canonicalJson(requiredSides)) invalid();
  for (const origin of Object.values(manifest.origins)) {
    let url;
    try { url = new URL(origin); } catch { invalid(); }
    if (origin !== url.origin || !['https:', 'http:'].includes(url.protocol)) invalid();
  }
  const allowedFiles = ['manifest.json'];
  const contents = [];
  let total = 0;
  for (let index = 0; index < manifest.targets.length; index++) {
    const target = manifest.targets[index];
    const stem = String(index).padStart(4, '0');
    if (target.archive_file !== `${stem}.zip` || typeof target.name !== 'string' || target.name.length > 1000 || !DIGEST.test(target.archive_sha256) || !DIGEST.test(target.bundle_sha256) || !DIGEST.test(target.state_sha256) || !Number.isSafeInteger(target.archive_bytes) || target.archive_bytes < 1 || target.archive_bytes > MAX_ARCHIVE) invalid();
    allowedFiles.push(target.archive_file);
    const bytes = await regularFile(join(directory, target.archive_file), MAX_ARCHIVE);
    total += bytes.byteLength;
    if (bytes.byteLength !== target.archive_bytes || sha256(bytes) !== target.archive_sha256 || total > MAX_SNAPSHOT) invalid();
    const files = readBundle(bytes);
    assertArchiveIdentity(files, target);
    if (bundleDigest(files) !== target.bundle_sha256) invalid();
    let configurations = [];
    if (target.kind === 'cpi_iflow') {
      if (typeof target.resolved_version !== 'string' || target.resolved_version.length > 100 || !/^\d+\.\d+\.\d+$/.test(target.resolved_version) || target.selector !== 'active' && target.selector !== target.resolved_version || target.configuration_file !== `${stem}-config.json` || !DIGEST.test(target.configuration_sha256) || !Number.isSafeInteger(target.configuration_bytes) || target.configuration_bytes < 2 || target.configuration_bytes > MAX_SNAPSHOT - total) invalid();
      allowedFiles.push(target.configuration_file);
      const configurationBytes = await regularFile(join(directory, target.configuration_file), MAX_SNAPSHOT - total);
      total += configurationBytes.byteLength;
      if (configurationBytes.byteLength !== target.configuration_bytes || sha256(configurationBytes) !== target.configuration_sha256) invalid();
      try { configurations = configurationIdentity(JSON.parse(configurationBytes.toString('utf8'))); } catch { invalid(); }
      if (canonicalDigest(configurations) !== target.configuration_digest) invalid();
    } else if (target.name !== target.id || ['configuration_file', 'configuration_bytes', 'configuration_sha256', 'configuration_digest'].some(key => target[key] !== undefined)) invalid();
    if (stateDigest(target.bundle_sha256, configurations) !== target.state_sha256) invalid();
    contents.push({ bytes, configurations, parameter_defaults: target.kind === 'cpi_iflow' ? parameterDefaults(files) : {} });
  }
  if (total !== manifest.total_bytes || total + manifestBytes.byteLength > MAX_SNAPSHOT || canonicalJson((await readdir(directory)).sort()) !== canonicalJson(allowedFiles.sort())) invalid();
  return { manifest, contents, digest: canonicalDigest(manifest) };
}
async function loadSnapshot(root, snapshotId) {
  try { return await loadSnapshotRaw(root, snapshotId); }
  catch { invalid(); }
}

/** Reuse full private archive/configuration verification; expose only matching state identities. */
export async function snapshotEvidenceForTargets(clients, targets, { env = process.env, deadline = Date.now() + 30000 } = {}) {
  const root = join(dirname(integrationCredentialsPath(env)), 'releases');
  const result = { result: 'ok', complete: true, inspected_records: 0, items: [], findings: [] };
  let entries;
  try {
    await privateDirectory(dirname(root));
    await privateDirectory(root);
    entries = (await readdir(root)).filter(name => !name.startsWith('.pending-')).sort(utf8Order);
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    return { ...result, result: 'error', complete: false, findings: [{ reason: 'private_snapshot_store_unreadable' }] };
  }
  for (const name of entries.slice(0, 100)) {
    if (Date.now() >= deadline) { result.complete = false; result.stop_reason = 'deadline'; break; }
    result.inspected_records++;
    if (!UUID.test(name)) { result.findings.push({ reason: 'unrecognized_store_record' }); continue; }
    try {
      const { manifest } = await loadSnapshot(root, name);
      const matches = manifest.targets.filter(saved => targets.some(target => {
        const side = saved.kind === 'cpi_iflow' ? 'cpi' : 'apim';
        return target.kind === saved.kind && target.id === saved.id && target.state_sha256 === saved.state_sha256 &&
          manifest.origins[side] === clients[side]?.origin;
      }));
      if (matches.length) result.items.push({ snapshot_id: manifest.snapshot_id, created_at: manifest.created_at,
        snapshot_sha256: canonicalDigest(manifest), targets: matches.map(target => ({ kind: target.kind, id: target.id, state_sha256: target.state_sha256 })) });
    } catch { result.findings.push({ snapshot_id: name, reason: 'invalid_snapshot_record' }); }
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 24 * 1024) {
      result.items.pop(); result.complete = false; result.stop_reason = 'output_limit'; break;
    }
    if (result.items.length >= 20) { result.complete = false; result.stop_reason = 'source_limit'; break; }
  }
  if (entries.length > result.inspected_records && !result.stop_reason) { result.complete = false; result.stop_reason = 'source_limit'; }
  return result;
}

export function registerIntegrationReleaseTools(register, { cpi, apim, summary = {}, env = process.env, readBackDelayMs = 5000 } = {}) {
  const clients = { cpi, apim };
  const root = join(dirname(integrationCredentialsPath(env)), 'releases');
  const environment = typeof summary.environment === 'string' && summary.environment.length <= 100 ? summary.environment : 'default';
  const localClient = { origin: 'https://integration-snapshot.invalid', request: async () => listingSource() };
  const pager = createCollectionPager(localClient, { root: '/releases' });
  async function listingSource() {
    try { await privateDirectory(dirname(root)); await privateDirectory(root); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = (await readdir(root)).filter(name => !name.startsWith('.pending-')).sort(utf8Order);
    const items = [];
    for (const name of entries.slice(0, SOURCE_RECORDS)) {
      if (!UUID.test(name)) { items.push({ valid: false, finding: 'unrecognized_store_record' }); continue; }
      try { items.push({ valid: true, ...publicSnapshot((await loadSnapshot(root, name)).manifest) }); }
      catch { items.push({ snapshot_id: name, valid: false, finding: 'invalid_snapshot_record' }); }
    }
    // A sentinel preserves explicit source truncation without pretending to traverse unbounded storage.
    if (entries.length > SOURCE_RECORDS) items.push({ valid: false, finding: 'store_source_limit', source_complete: false });
    return items;
  }
  register('integration_snapshot_content', 'Snapshot integration content',
    'Preview explicit tenant-bound content identities, then privately save immutable original ZIPs and exact CPI configuration. Execution requires the preview confirmation; no deployment occurs.', snapshotSchema, CREATE_ANNOTATIONS,
    async input => {
      const args = parse(snapshotSchema, input);
      const targets = selectedTargets(args.targets);
      const origins = originsFor(targets, clients);
      const required_confirmation = `SNAPSHOT INTEGRATION CONTENT ${canonicalDigest({ targets, origins })}`;
      if (args.dry_run) return { dry_run: true, environment, hosts: hostsFor(origins), targets, required_confirmation };
      requireConfirmation(args.confirmation, required_confirmation);
      const snapshotId = randomUUID();
      const manifest = { schema_version: 1, snapshot_id: snapshotId, created_at: new Date().toISOString(), environment, origins, targets: [], total_bytes: 0 };
      const contents = [];
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        const content = await readTarget(target, clients);
        if (content.bytes.byteLength > MAX_ARCHIVE) throw new IntegrationError('Snapshot archive exceeds the 20 MiB compressed limit');
        const stem = String(index).padStart(4, '0');
        const record = { kind: target.kind, id: target.id, name: content.name, archive_file: `${stem}.zip`, archive_bytes: content.bytes.byteLength,
          archive_sha256: sha256(content.bytes), bundle_sha256: content.bundle_sha256, state_sha256: content.state_sha256 };
        const members = [[record.archive_file, content.bytes]];
        if (target.kind === 'cpi_iflow') {
          const configBytes = Buffer.from(canonicalJson(content.configurations));
          Object.assign(record, { selector: target.version, resolved_version: content.resolved_version, configuration_file: `${stem}-config.json`,
            configuration_bytes: configBytes.byteLength, configuration_sha256: sha256(configBytes), configuration_digest: canonicalDigest(content.configurations) });
          members.push([record.configuration_file, configBytes]);
        }
        manifest.targets.push(record);
        for (const member of members) { manifest.total_bytes += member[1].byteLength; contents.push(member); }
        if (manifest.total_bytes > MAX_SNAPSHOT) throw new IntegrationError('Snapshot exceeds the 100 MiB total limit');
      }
      manifest.manifest_sha256 = canonicalDigest(manifest);
      const manifestBytes = Buffer.from(canonicalJson(manifest));
      if (manifestBytes.byteLength > MAX_MANIFEST || manifest.total_bytes + manifestBytes.byteLength > MAX_SNAPSHOT) throw new IntegrationError('Snapshot exceeds the manifest or 100 MiB total limit');
      await privateDirectory(dirname(root), true);
      await privateDirectory(root, true);
      const staging = join(root, `.pending-${snapshotId}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        for (const [filename, bytes] of contents) await exclusiveFile(join(staging, filename), bytes);
        await exclusiveFile(join(staging, 'manifest.json'), manifestBytes);
        await rename(staging, join(root, snapshotId));
      } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
      return { saved: true, ...publicSnapshot(manifest) };
    });
  register('integration_list_snapshots', 'List private integration snapshots',
    'List safe snapshot identities and integrity findings with runtime-signed bounded continuation. Archives, source and configured values remain private.', listSchema, READ_ONLY_ANNOTATIONS,
    async input => {
      const args = parse(listSchema, input);
      const result = await pager.page({ path: '/snapshots', mode: 'local', top: args.top, cursor: args.cursor, scope: canonicalDigest({ root, environment, origins: { cpi: cpi?.origin ?? null, apim: apim?.origin ?? null } }) });
      if (result.items.some(item => item.source_complete === false)) return { ...result, complete: false, stop_reason: 'source_limit' };
      return result;
    });
  register('integration_restore_snapshot', 'Restore integration snapshot',
    'Preview configuration-aware current digests and all effects. Execution requires exact target digests and tenant-bound confirmation. CPI replaces only the active draft; APIM import deploys a new revision. Stops on partial failure, with no atomicity, compensation or transaction rollback.', restoreSchema, OVERWRITE_ANNOTATIONS,
    async input => {
      const args = parse(restoreSchema, input);
      const saved = await loadSnapshot(root, args.snapshot_id);
      const { manifest } = saved;
      const targets = manifest.targets;
      const origins = originsFor(targets, clients);
      if (canonicalJson(origins) !== canonicalJson(manifest.origins)) throw new IntegrationError('Snapshot restore is restricted to the same bound tenant origins');
      const expected = args.expected_current_digests;
      if (!args.dry_run && (!expected || canonicalJson(Object.keys(expected).sort()) !== canonicalJson(targets.map(targetKey).sort()))) throw new IntegrationError('Execution requires exactly one expected_current_digests entry for every snapshot target');
      const confirmationFor = digests => `RESTORE INTEGRATION SNAPSHOT ${canonicalDigest({ snapshot_sha256: saved.digest, expected_current_digests: digests, origins })}`;
      if (!args.dry_run) requireConfirmation(args.confirmation, confirmationFor(expected));
      const current = [];
      // Entire preflight completes before the first mutation, then each target is checked again immediately before writing.
      for (const target of targets) {
        const { bytes, ...evidence } = await readTarget({ kind: target.kind, id: target.id }, clients);
        current.push(evidence);
      }
      const currentDigests = Object.fromEntries(targets.map((target, index) => [targetKey(target), current[index].state_sha256]));
      const previews = targets.map((target, index) => ({ ...publicTarget(target), current_state_sha256: current[index].state_sha256,
        ...namesSummary(changedParameters(saved.contents[index], current[index])),
        effects: target.kind === 'cpi_iflow' ? { active_draft_replacement: true, retained_source_version_unchanged: true, deployment: false } : { draft_replacement: true, imports_new_revision: true, deployment: true } }));
      const base = { snapshot_id: args.snapshot_id, snapshot_sha256: saved.digest, environment, hosts: hostsFor(origins), atomic: false, compensation: false,
        does_not_reverse: ['processed_messages', 'datastores', 'security_material', 'issued_tokens', 'receiver_transactions'] };
      if (args.dry_run) return { ...base, dry_run: true, targets: previews, expected_current_digests: currentDigests, required_confirmation: confirmationFor(currentDigests) };
      if (canonicalJson(currentDigests) !== canonicalJson(expected)) return { ...base, outcome: 'blocked', reason: 'current_state_mismatch', targets: previews, progress: [] };
      const progress = [];
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        const content = saved.contents[index];
        const item = { kind: target.kind, id: target.id, accepted: false, content_verified: false, configuration_verified: false, outcome: 'failed' };
        try {
          const fresh = await readTarget({ kind: target.kind, id: target.id }, clients);
          if (fresh.state_sha256 !== expected[targetKey(target)]) { item.reason = 'current_state_mismatch'; item.outcome = 'blocked'; progress.push(item); break; }
          if (target.kind === 'cpi_iflow') {
            await cpi.request('PUT', `${CPI_BASE}${cpiArtifactPath(target.id)}`, { json: { Name: target.name, ArtifactContent: Buffer.from(content.bytes).toString('base64') }, expect: [200, 202, 204], responseType: 'none', accept: '*/*' });
            item.accepted = true;
            item.draft_replaced = true;
            item.deployment = false;
            const configuration = await writeCpiConfigurations(cpi, target.id, content.configurations);
            Object.assign(item, namesSummary(configuration.updated ?? [], 'updated_parameter'));
            if (configuration.failed) {
              item.outcome = 'partial'; item.reason = 'configuration_restore_failed'; item.failure = safeFailure(configuration.failed);
              item.failed_parameter_name = typeof configuration.failed.key === 'string' ? configuration.failed.key.slice(0, 100) : null;
              progress.push(item); break;
            }
          } else {
            const imported = await importApiProxyBundle(apim, target.id, content.bytes, { readBackDelayMs });
            item.accepted = imported.accepted === true;
            item.deployment = true;
            item.imports_new_revision = true;
            item.runtime_verified = imported.runtime_verified === true;
            if (!item.accepted) { item.reason = 'import_not_accepted'; progress.push(item); break; }
          }
          try {
            const restored = await readTarget({ kind: target.kind, id: target.id }, clients);
            item.content_verified = restored.bundle_sha256 === target.bundle_sha256 && restored.name === target.name;
            item.configuration_verified = stateDigest(target.bundle_sha256, restored.configurations) === target.state_sha256;
            item.observed_state_sha256 = restored.state_sha256;
            item.outcome = item.content_verified && item.configuration_verified ? 'restored' : 'unverified';
            if (item.outcome === 'unverified') item.reason = 'restored_state_mismatch_or_extra_configuration';
          } catch (error) { item.outcome = 'unverified'; item.reason = 'read_back_failed'; item.failure = safeFailure(error); }
        } catch (error) {
          // Import helpers preserve acceptance when post-import verification fails; never retry a mutation here.
          item.accepted ||= error?.accepted === true;
          item.outcome = item.accepted ? 'partial' : 'failed'; item.failure = safeFailure(error);
        }
        progress.push(item);
        if (item.outcome !== 'restored') break;
      }
      return { ...base, outcome: progress.length === targets.length && progress.every(item => item.outcome === 'restored') ? 'restored' : progress.some(item => item.accepted) ? 'partial' : 'blocked', progress,
        remaining_targets: targets.slice(progress.length).map(target => ({ kind: target.kind, id: target.id })) };
    });
}
