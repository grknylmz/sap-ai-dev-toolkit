// Read-only access evidence. Core access, optional capabilities and entitlement
// evidence are separate: an endpoint response cannot establish a subscription.
import { createServiceClient, odataKey } from './integration-http.mjs';
import { createOptionalClients, verifyOptionalClients } from './integration-optional-tools.mjs';

const CSRF_PATHS = Object.freeze({ CPI: '/api/v1/', APIM: '/apiportal/api/1.0/Management.svc/', DEVHUB: '/odata/1.0/data.svc/' });
const APIM_BASE = '/apiportal/api/1.0/Management.svc';
const VERIFY_TIMEOUT_MS = 30_000;

const PROBES = Object.freeze({
  CPI: [
    { area: 'Packages and iFlows', path: '/api/v1/IntegrationPackages', query: { $top: 1 }, core: true },
    { area: 'Deployed artifacts', path: '/api/v1/IntegrationRuntimeArtifacts', query: { $top: 1 } },
    { area: 'Message logs', path: '/api/v1/MessageProcessingLogs', query: { $top: 1, $select: 'MessageGuid' } },
    { area: 'MPL counts', path: '/api/v1/MessageProcessingLogs/$count', count: true },
    { area: 'Security material', path: '/api/v1/UserCredentials' },
    { area: 'OAuth credential metadata', path: '/api/v1/OAuth2ClientCredentials' },
    { area: 'Keystore validity', path: '/api/v1/KeystoreEntries', query: { keystoreName: 'system' }, validity: true },
    { area: 'Number ranges', path: '/api/v1/NumberRanges' },
    { area: 'Partner Directory', path: '/api/v1/StringParameters', query: { $top: 1 } },
    { area: 'Data stores', path: '/api/v1/DataStores' },
    { area: 'JMS queues', path: "/api/v1/JmsBrokers('Broker1')" },
    { area: 'Queue metadata', path: '/api/v1/Queues' },
    { area: 'Variables', path: '/api/v1/Variables' }
  ],
  APIM: [
    { area: 'API proxies', path: `${APIM_BASE}/APIProxies`, query: { $top: 1, $select: 'name' }, core: true },
    { area: 'API providers', path: `${APIM_BASE}/APIProviders`, query: { $top: 1, $select: 'name' } },
    { area: 'API products', path: `${APIM_BASE}/APIProducts`, query: { $top: 1, $select: 'name' } },
    { area: 'Key value maps', path: `${APIM_BASE}/KeyMapEntries`, query: { $top: 1, $select: 'name' } },
    { area: 'Virtual hosts', path: `${APIM_BASE}/VirtualHosts` },
    { area: 'API analytics', path: '/api/1.0/AnalyticsService/ResultsUTC', query: { $top: 1, $select: 'CreatedTime,CallCount' } }
  ],
  DEVHUB: [
    { area: 'Registered developers', path: '/api/1.0/registrations', query: { type: 'registered' }, core: true }
  ]
});

// Statuses accepted as answers so they can be classified without exposing bodies.
const OBSERVED = [200, 204, 400, 401, 403, 404, 405, 429, 500, 501, 502, 503, 504];

function classify(status) {
  if (status >= 200 && status < 300) return { result: 'ok', detail: 'readable' };
  if (status === 401) return { result: 'unauthenticated', detail: 'HTTP 401: authentication was not accepted after recovery' };
  if (status === 403) return { result: 'forbidden', detail: 'HTTP 403: access denied; the cause or missing permission is not established' };
  if (status === 404 || status === 501) return { result: 'unavailable', detail: `HTTP ${status}: endpoint unavailable; activation and entitlement remain unknown` };
  return { result: 'error', detail: `HTTP ${status}` };
}

function rows(text) {
  try {
    const parsed = JSON.parse(text);
    const collection = parsed?.d?.results ?? parsed?.value ?? parsed?.d ?? parsed;
    return Array.isArray(collection) ? collection : [];
  } catch {
    return [];
  }
}

function source(probe, status, result, extra = {}) {
  return { method: 'GET', path: probe.path, status, result, ...extra };
}

function failed(probe, error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const tokenFailure = String(error?.phase ?? '').startsWith('token');
  const classification = error?.stop_reason === 'deadline'
    ? { result: 'error', detail: 'Verification deadline exceeded', stop_reason: 'deadline' }
    : status === null ? { result: 'error', detail: 'Request failed without an HTTP response' }
      : status >= 200 && status < 300 ? { result: 'error', detail: `HTTP ${status}: response processing failed` } : classify(status);
  // Token HTTP errors are useful setup evidence, but raw response/error bodies are not.
  if (tokenFailure && status !== null && error?.stop_reason !== 'deadline') classification.detail = `Token request failed (HTTP ${status})`;
  return {
    area: probe.area, status, ...classification,
    source: source(probe, status, classification.result, {
      ...(tokenFailure ? { phase: 'token' } : {}),
      ...(error?.stop_reason === 'deadline' ? { stop_reason: 'deadline', deadline: error.deadline } : {})
    })
  };
}

/** Core and optional clients are pinned to this runtime's resolved configuration. */
export function createIntegrationClients(config, { env = process.env, fetchImpl } = {}) {
  const clientFor = (label, side) => (side
    ? createServiceClient({
      label, url: side.url, tokenUrl: side.tokenUrl, clientId: side.clientId, clientSecret: side.clientSecret,
      csrfPath: CSRF_PATHS[label], exposeErrorDetails: label !== 'DEVHUB', env,
      ...(fetchImpl ? { fetchImpl } : {})
    })
    : null);
  return { cpi: clientFor('CPI', config?.cpi), apim: clientFor('APIM', config?.apim), devhub: clientFor('DEVHUB', config?.devhub), ...createOptionalClients(config, { env, fetchImpl }) };
}

async function runProbe(client, probe, deadline) {
  try {
    const { status, data } = await client.request('GET', probe.path, {
      query: probe.query, expect: OBSERVED, withStatus: true,
      responseType: 'text', accept: probe.count ? 'text/plain' : 'application/json', deadline
    });
    let classification = classify(status);
    if (classification.result === 'ok' && probe.count && !/^\d+$/.test(String(data).trim())) {
      classification = { result: 'error', detail: 'Count endpoint returned invalid count text' };
    } else if (classification.result === 'ok' && probe.count && !Number.isSafeInteger(Number(data))) {
      classification = { result: 'error', detail: 'Count endpoint returned a count outside the safe integer range' };
    }
    if (classification.result === 'ok' && probe.validity) {
      const entries = rows(data);
      if (!entries.some(entry => entry?.ValidNotBefore !== undefined && entry?.ValidNotAfter !== undefined)) {
        classification = { result: 'untested', detail: 'No certificate with validity fields exists to test validity metadata' };
      }
    }
    return { area: probe.area, status, ...classification, source: source(probe, status, classification.result), text: data };
  } catch (error) {
    return failed(probe, error);
  }
}

async function policyCheck(client, coreText, deadline) {
  const probe = { area: 'Policies (proxy bundle export)', path: '/apiportal/api/1.0/Transport.svc/APIProxies' };
  const name = rows(coreText)[0]?.name;
  if (typeof name !== 'string' || !name) return {
    area: probe.area, status: null, result: 'untested', detail: 'No API proxy exists to test bundle export',
    source: source(probe, null, 'untested')
  };
  try {
    const { status, data } = await client.request('GET', probe.path, {
      query: { name }, expect: OBSERVED, withStatus: true, responseType: 'bytes',
      accept: 'application/zip, application/octet-stream', deadline
    });
    const zip = data instanceof Uint8Array && data[0] === 0x50 && data[1] === 0x4b;
    const classification = status >= 200 && status < 300 && !zip
      ? { result: 'error', detail: `HTTP ${status} but the export is not a zip bundle` } : classify(status);
    return { area: probe.area, status, ...classification, source: source(probe, status, classification.result) };
  } catch (error) {
    return failed(probe, error);
  }
}

async function runsCheck(client, messageCheck, deadline) {
  const probe = { area: 'MPL runs', path: '/api/v1/MessageProcessingLogs' };
  if (messageCheck.result !== 'ok') return {
    area: probe.area, status: null, result: 'untested', detail: 'Message-log identity lookup did not succeed',
    source: source(probe, null, 'untested', { prerequisite_result: messageCheck.result })
  };
  const guid = rows(messageCheck.text)[0]?.MessageGuid;
  if (typeof guid !== 'string' || !guid) return {
    area: probe.area, status: null, result: 'untested', detail: 'No message exists to test run metadata',
    source: source(probe, null, 'untested')
  };
  return runProbe(client, { ...probe, path: `/api/v1/MessageProcessingLogs(${encodeURIComponent(odataKey(guid))})/Runs` }, deadline);
}

async function verifySide(label, client, deadline) {
  if (!client) return { configured: false, entitlement: 'unknown' };
  const probes = PROBES[label];
  const core = await runProbe(client, probes[0], deadline);
  const { text: coreText, ...coreCheck } = core;
  const signedIn = core.status !== null && core.result !== 'unauthenticated' && core.source.phase !== 'token';
  if (!signedIn) {
    return {
      configured: true, signed_in: false, ok: false, result: core.result, entitlement: 'unknown',
      error: core.source.phase === 'token' && core.status !== null ? `${label} token request failed (HTTP ${core.status})` : core.detail,
      checks: [coreCheck]
    };
  }
  const results = await Promise.all(probes.slice(1).map(probe => runProbe(client, probe, deadline)));
  if (label === 'APIM' && core.result === 'ok') results.push(await policyCheck(client, coreText, deadline));
  if (label === 'CPI') results.push(await runsCheck(client, results.find(check => check.area === 'Message logs'), deadline));
  const checks = [coreCheck, ...results.map(({ text, ...check }) => check)];
  return { configured: true, signed_in: true, ok: core.result === 'ok', result: core.result, entitlement: 'unknown', checks };
}

/** `ok` means every configured core service passed its core read, not whole-lifecycle readiness. */
export async function verifyIntegrationClients(clients = {}) {
  const { cpi, apim, devhub } = clients;
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  const [cpiResult, apimResult, devhubResult, optional] = await Promise.all([
    verifySide('CPI', cpi, deadline), verifySide('APIM', apim, deadline), verifySide('DEVHUB', devhub, deadline),
    verifyOptionalClients(clients, { deadline })
  ]);
  const sides = [cpiResult, apimResult, devhubResult].filter(side => side.configured);
  return {
    ok: sides.length > 0 && sides.every(side => side.ok),
    ok_scope: 'configured_core_access', entitlement: 'unknown',
    cpi: cpiResult, apim: apimResult, devhub: devhubResult, ...optional
  };
}

/** Human-readable access lines; no response bodies, object values or personal details. */
export function verificationLines(label, host, side) {
  if (!side?.configured) return [];
  if (!side.signed_in) return [`✗ ${label} ${host}: sign-in not verified — ${side.error}`];
  const lines = [side.ok ? `✓ ${label} ${host}: core access verified` : `✗ ${label} ${host}: ${side.checks[0]?.area ?? 'the core area'} is not readable with this key`];
  for (const check of side.checks) {
    const mark = check.result === 'ok' ? '✓' : (['unavailable', 'untested'].includes(check.result) ? '–' : '✗');
    lines.push(`    ${mark} ${check.area}${check.result === 'ok' ? '' : ` — ${check.detail}`}`);
  }
  return lines;
}
