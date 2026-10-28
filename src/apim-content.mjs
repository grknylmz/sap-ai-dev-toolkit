// Private APIM content reads shared by authoring, inspection and release evidence.
import { entity, key, list, sleep, withoutSecrets } from './integration-common.mjs';
import { bundleDocumentation } from './apim-bundle.mjs';
import { bundleDigest, readBundle, strFromU8 } from './iflow-bundle.mjs';
import { isDeepStrictEqual } from 'node:util';
import { IntegrationError } from './integration-http.mjs';

export const APIM_BASE = '/apiportal/api/1.0/Management.svc';
export const APIM_TRANSPORT = '/apiportal/api/1.0/Transport.svc/APIProxies';

/** Resolve the published URL or the configured virtual host/base path. Callers enforce their surface's URL policy. */
export function apiProxyRuntimeUrl(proxy, defaultHost) {
  const candidates = [proxy?.publishUrl, ...list(proxy?.deploymentInfo).map(entry => entry?.publishUrl), proxy?.deploymentInfo?.publishUrl];
  const published = candidates.find(value => typeof value === 'string' && /^https?:\/\/\S+$/.test(value));
  if (published) return published;
  const endpoint = list(proxy?.proxyEndPoints)[0];
  const host = list(endpoint?.virtualhosts)[0] ?? defaultHost;
  if (!endpoint || !host?.virtual_host) return null;
  const port = Number(host.virtual_port);
  const portText = !port || port === 443 || port === 80 ? '' : `:${port}`;
  const path = endpoint.base_path ?? '';
  return `${host.isSSL ? 'https' : 'http'}://${host.virtual_host}${portText}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function readApiProxy(client, name, { deadline } = {}) {
  const { status, data } = await client.request('GET', `${APIM_BASE}/APIProxies(${key(name)})`, {
    query: { $expand: 'proxyEndPoints,targetEndPoints,proxyEndPoints/virtualhosts,deploymentInfo' },
    expect: [200, 404], withStatus: true, deadline
  });
  if (status === 404) return null;
  let defaultHost = null;
  if (!list(list(data?.proxyEndPoints)[0]?.virtualhosts).length) {
    defaultHost = list(await client.request('GET', `${APIM_BASE}/VirtualHosts`, {
      query: { $filter: 'isDefault eq true' }, deadline
    }))[0] ?? null;
  }
  return { ...withoutSecrets(entity(data)), runtime_url: apiProxyRuntimeUrl(data, defaultHost) };
}

export async function exportApiProxyArchive(client, name, { deadline } = {}) {
  const { status, data } = await client.request('GET', APIM_TRANSPORT, {
    query: { name }, accept: 'application/zip, application/octet-stream', responseType: 'bytes',
    expect: [200, 404], withStatus: true, deadline
  });
  return status === 404 ? null : data;
}

export async function exportApiProxyBundle(client, name, options) {
  const bytes = await exportApiProxyArchive(client, name, options);
  if (bytes === null) return null;
  try { return readBundle(bytes); }
  catch { throw new IntegrationError(`API proxy ${name} export is not a readable zip archive`); }
}

// Only the observed portal documentation transformations are allowed. Unknown resources,
// policies, endpoint XML and binary files must remain byte-for-byte equal.
function normalizeDocumentationText(document) {
  const opaque = new Set(['example', 'examples', 'default', 'enum', 'const']);
  const entities = { lt: '<', gt: '>', amp: '&' };
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (name === 'description' && typeof child === 'string') value[name] = child.replace(/&(lt|gt|amp);/g, (_, entity) => entities[entity]).replace(/\s+/g, ' ').trim();
      else if (!opaque.has(name) && !name.startsWith('x-')) visit(child);
    }
  };
  visit(document);
  return document;
}

function contentMatches(expected, actual, name, proxy) {
  if (expected.size !== actual.size) return { verified: false, normalized: false };
  let documentation = null;
  let normalized = false;
  for (const [path, bytes] of expected) {
    const observed = actual.get(path);
    if (!observed) return { verified: false, normalized: false };
    if (Buffer.from(bytes).equals(Buffer.from(observed))) continue;
    // Resolve the registration with the existing structural scanner, not a suffix guess.
    try {
      documentation ??= bundleDocumentation(expected, name);
      if (path !== documentation.path || bundleDocumentation(actual, name).path !== path) return { verified: false, normalized: false };
      const submitted = JSON.parse(strFromU8(bytes));
      const received = JSON.parse(strFromU8(observed));
      if (isDeepStrictEqual(submitted, received)) continue;
      const runtime = new URL(proxy.runtime_url);
      const endpoint = `${runtime.protocol}//${runtime.hostname}:${runtime.port || '443'}${runtime.pathname}`;
      if (typeof proxy.title === 'string') submitted.info.title = proxy.title;
      if (typeof proxy.description === 'string') submitted.info.description = proxy.description;
      submitted.info['x-targetEndpoint'] = endpoint;
      if (submitted.openapi) submitted.servers = [{ url: endpoint }];
      if (!isDeepStrictEqual(normalizeDocumentationText(received), normalizeDocumentationText(submitted))) return { verified: false, normalized: false };
      normalized = true;
    } catch {
      return { verified: false, normalized: false };
    }
  }
  return { verified: true, normalized };
}

/** Import once; acceptance, complete content read-back and runtime evidence are separate facts. */
export async function importApiProxyBundle(client, name, bytes, { readBackDelayMs = 5000, deadline = Date.now() + 20_000 } = {}) {
  const intended = readBundle(bytes); // Reject malformed/unsafe archives before the mutation.
  const intendedDigest = bundleDigest(intended);
  const { status } = await client.request('POST', APIM_TRANSPORT, {
    body: Buffer.from(bytes).toString('base64'), contentType: 'application/octet-stream',
    accept: 'application/zip', responseType: 'none', expect: [200, 201], withStatus: true, deadline
  });
  const result = {
    name, accepted: true, imported: true, http_status: status, outcome: 'unverified',
    content_verified: false, read_back_verified: false, read_back_normalized: false,
    runtime_verified: false, runtime_url: null, state: null,
    intended_bundle_sha256: intendedDigest, observed_bundle_sha256: null,
    effects: { draft_created_or_replaced: true, new_revision_imported: true, deployment_requested: true },
    read_back_attempts: 0, stop_reason: 'source_limit',
    note: 'Import accepted; runtime freshness/revision identity is unverified. Do not repeat the import blindly.'
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) {
      if (Date.now() + readBackDelayMs >= deadline) { result.stop_reason = 'deadline'; break; }
      await sleep(readBackDelayMs);
    }
    if (Date.now() >= deadline) { result.stop_reason = 'deadline'; break; }
    result.read_back_attempts += 1;
    let proxy = null;
    try {
      proxy = await readApiProxy(client, name, { deadline });
      result.state = typeof proxy?.state === 'string' ? proxy.state.slice(0, 100) : null;
      if (proxy?.runtime_url) {
        const url = new URL(proxy.runtime_url);
        if (!url.username && !url.password && ['https:', 'http:'].includes(url.protocol)) {
          url.search = ''; url.hash = '';
          if (url.href.length <= 2048) result.runtime_url = url.href;
        }
      }
    } catch {
      result.runtime_read_back_error = 'Proxy metadata read-back failed; response withheld.';
    }
    try {
      const observed = await exportApiProxyBundle(client, name, { deadline });
      if (!observed) { result.content_read_back_error = 'Imported content is not yet available.'; continue; }
      result.observed_bundle_sha256 = bundleDigest(observed);
      const comparison = contentMatches(intended, observed, name, proxy);
      result.content_verified = result.read_back_verified = comparison.verified;
      result.read_back_normalized = comparison.normalized;
      if (comparison.verified) {
        delete result.content_read_back_error;
        result.stop_reason = 'end';
        break;
      }
      result.content_read_back_error = 'Imported content read-back differs; do not repeat the import blindly.';
    } catch {
      result.content_read_back_error = 'Content read-back failed; response withheld. Do not repeat the import blindly.';
    }
  }
  return result;
}
