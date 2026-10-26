// Online check of CPI/APIM credentials: sign in, then one read-only request per tool area so a
// missing role shows up as a named area instead of a failing tool call later. Never writes.
import { createServiceClient } from './integration-http.mjs';

const CSRF_PATHS = Object.freeze({ CPI: '/api/v1/', APIM: '/apiportal/api/1.0/Management.svc/' });
const APIM_BASE = '/apiportal/api/1.0/Management.svc';

const PROBES = Object.freeze({
  CPI: [
    { area: 'Packages and iFlows', path: '/api/v1/IntegrationPackages', query: { $top: 1 }, core: true },
    { area: 'Deployed artifacts', path: '/api/v1/IntegrationRuntimeArtifacts', query: { $top: 1 } },
    { area: 'Message logs', path: '/api/v1/MessageProcessingLogs', query: { $top: 1 } },
    { area: 'Security material', path: '/api/v1/UserCredentials' },
    { area: 'Number ranges', path: '/api/v1/NumberRanges' },
    { area: 'Partner Directory', path: '/api/v1/StringParameters', query: { $top: 1 } },
    { area: 'Data stores', path: '/api/v1/DataStores' },
    { area: 'JMS queues', path: "/api/v1/JmsBrokers('Broker1')" }
  ],
  APIM: [
    { area: 'API proxies', path: `${APIM_BASE}/APIProxies`, query: { $top: 1, $select: 'name' }, core: true },
    { area: 'API providers', path: `${APIM_BASE}/APIProviders`, query: { $top: 1, $select: 'name' } },
    { area: 'API products', path: `${APIM_BASE}/APIProducts`, query: { $top: 1, $select: 'name' } },
    { area: 'Key value maps', path: `${APIM_BASE}/KeyMapEntries`, query: { $top: 1, $select: 'name' } },
    { area: 'Virtual hosts', path: `${APIM_BASE}/VirtualHosts` }
  ]
});

// Statuses accepted as answers so they can be classified instead of thrown.
const OBSERVED = [200, 204, 400, 401, 403, 404, 405, 500, 501, 502, 503, 504];

function classify(status) {
  if (status >= 200 && status < 300) return { result: 'ok', detail: 'readable' };
  if (status === 401 || status === 403) return { result: 'forbidden', detail: `HTTP ${status}: the service key lacks the role for this area` };
  if (status === 404 || status === 501) return { result: 'unavailable', detail: `HTTP ${status}: not available on this tenant or plan` };
  return { result: 'error', detail: `HTTP ${status}` };
}

/** OAuth clients for the resolved CPI/APIM config (null for an unconfigured side). */
export function createIntegrationClients(config, { env = process.env, fetchImpl } = {}) {
  const clientFor = (label, side) => (side
    ? createServiceClient({
      label,
      url: side.url,
      tokenUrl: side.tokenUrl,
      clientId: side.clientId,
      clientSecret: side.clientSecret,
      csrfPath: CSRF_PATHS[label],
      env,
      ...(fetchImpl ? { fetchImpl } : {})
    })
    : null);
  return { cpi: clientFor('CPI', config?.cpi), apim: clientFor('APIM', config?.apim) };
}

// Policies are attached by exporting the proxy bundle (Transport.svc), editing it and re-importing it.
// The export of an existing proxy proves the read half without writing; no proxy means nothing to test.
async function policyCheck(client, coreText) {
  const area = 'Policies (proxy bundle export)';
  let name;
  try {
    const parsed = JSON.parse(coreText);
    name = (parsed?.d?.results ?? parsed?.d ?? parsed?.value ?? [])[0]?.name;
  } catch {
    // Unparseable list: reported as unavailable below.
  }
  if (typeof name !== 'string' || !name) return { area, status: null, result: 'unavailable', detail: 'no API proxy exists yet to test the export with' };
  try {
    const { status, data } = await client.request('GET', '/apiportal/api/1.0/Transport.svc/APIProxies', {
      query: { name }, expect: OBSERVED, withStatus: true, responseType: 'bytes', accept: 'application/zip, application/octet-stream'
    });
    const zip = data instanceof Uint8Array && data[0] === 0x50 && data[1] === 0x4b;
    if (status >= 200 && status < 300 && !zip) return { area, status, result: 'error', detail: `HTTP ${status} but the export is not a zip bundle` };
    return { area, status, ...classify(status) };
  } catch (error) {
    return { area, status: null, result: 'error', detail: String(error?.message || 'request failed').slice(0, 300) };
  }
}

async function verifySide(label, client) {
  if (!client) return { configured: false };
  const probes = PROBES[label];
  const run = async probe => {
    try {
      const { status, data } = await client.request('GET', probe.path, { query: probe.query, expect: OBSERVED, withStatus: true, responseType: 'text', accept: 'application/json' });
      return { area: probe.area, status, ...classify(status), text: data };
    } catch (error) {
      return { area: probe.area, status: null, result: 'error', detail: String(error?.message || 'request failed').slice(0, 300) };
    }
  };
  const { text: coreText, ...core } = await run(probes[0]);
  // The core probe also fetches the token: a thrown request is a token or network failure, reported once.
  if (core.status === null) {
    return { configured: true, signed_in: false, ok: false, error: core.detail, checks: [] };
  }
  const others = probes.slice(1).map(run);
  if (label === 'APIM' && core.result === 'ok') others.push(policyCheck(client, coreText));
  const checks = [core, ...(await Promise.all(others)).map(({ text, ...check }) => check)];
  return { configured: true, signed_in: true, ok: core.result === 'ok', checks };
}

/** Verify the configured sides online; `ok` means every configured side signed in and passed its core read. */
export async function verifyIntegrationClients({ cpi, apim } = {}) {
  const [cpiResult, apimResult] = await Promise.all([verifySide('CPI', cpi), verifySide('APIM', apim)]);
  const sides = [cpiResult, apimResult].filter(side => side.configured);
  return { ok: sides.length > 0 && sides.every(side => side.ok), cpi: cpiResult, apim: apimResult };
}

/** Human-readable lines for one verified side (no secrets: only host, area names and HTTP statuses). */
export function verificationLines(label, host, side) {
  if (!side?.configured) return [];
  if (!side.signed_in) return [`✗ ${label} ${host}: sign-in failed — ${side.error}`];
  const lines = [side.ok ? `✓ ${label} ${host}: signed in` : `✗ ${label} ${host}: signed in, but ${side.checks[0]?.area ?? 'the core area'} is not readable with this key`];
  for (const check of side.checks) {
    const mark = check.result === 'ok' ? '✓' : (check.result === 'unavailable' ? '–' : '✗');
    lines.push(`    ${mark} ${check.area}${check.result === 'ok' ? '' : ` — ${check.detail}`}`);
  }
  return lines;
}
