// Existing optional-service credentials only: no provisioning, SDK or tenant writes.
import { createServiceClient, createStaticServiceClient } from './integration-http.mjs';
import { registerAnsTools } from './integration-alerts.mjs';
import { registerCtmsTools } from './integration-transport.mjs';
import { registerMessagingTools, registerEventMeshTools, registerAemTools, registerAemSempTools } from './integration-messaging.mjs';
import { createOpenConnectorsClient, registerOpenConnectorsTools } from './open-connectors-tools.mjs';
import { registerEdgeMonitoringTools } from './edge-monitoring.mjs';

export const OPTIONAL_CLIENT_KEYS = Object.freeze(['ctms', 'ans', 'event_mesh', 'aem', 'aem_semp', 'open_connectors', 'edge']);
const PROBES = new WeakMap();
const SCOPES = new WeakMap();
const OBSERVED = [200, 204, 400, 401, 403, 404, 405, 429, 500, 501, 502, 503, 504, 529];
const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

function classify(status) {
  if (status >= 200 && status < 300) return { result: 'ok', detail: 'Read-only API access verified; activation and entitlement remain unknown' };
  if (status === 401) return { result: 'unauthenticated', detail: 'HTTP 401: authentication was not accepted' };
  if (status === 403) return { result: 'forbidden', detail: 'HTTP 403: access denied; permission, activation and entitlement causes are not established' };
  if (status === 404 || status === 501) return { result: 'unavailable', detail: `HTTP ${status}: endpoint unavailable; activation and entitlement remain unknown` };
  if (status === 529) return { result: 'error', detail: 'HTTP 529: no SEMP session slot available; this is not an empty queue collection' };
  return { result: 'error', detail: `HTTP ${status}` };
}

function collection(value, kind) {
  if (kind === 'nodes') return Array.isArray(value?.nodes);
  if (kind === 'ans') return Array.isArray(value?.results) && value?.metadata && typeof value.metadata === 'object';
  if (kind === 'aem' || kind === 'semp') return Array.isArray(value?.data);
  if (kind === 'instances') return Array.isArray(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function source(probe, status, result, phase) {
  // Probe paths are fixed routes or encoded queue identities; never query URLs or response bodies.
  return { method: 'GET', path: probe.path, status, result, ...(phase ? { phase } : {}) };
}

async function readProbe(client, probe, deadline) {
  try {
    const { status, data } = await client.request('GET', probe.path, {
      query: probe.query, expect: OBSERVED, withStatus: true, responseType: 'text',
      accept: probe.kind === 'metadata' ? 'application/xml, text/xml' : 'application/json', deadline
    });
    let classification = classify(status);
    if (classification.result === 'ok') {
      if (probe.kind === 'metadata') {
        if (!/<(?:[\w.-]+:)?Edmx\b/i.test(String(data))) classification = { result: 'error', detail: 'Local metadata response is not an OData metadata document' };
      } else {
        let value;
        try { value = JSON.parse(data); } catch { /* Classify without including the body. */ }
        if (!collection(value, probe.kind)) classification = { result: 'error', detail: 'Response does not match the documented API collection or named-resource contract' };
      }
    }
    return { area: probe.area, status, ...classification, source: source(probe, status, classification.result) };
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : null;
    const phase = String(error?.phase ?? '').startsWith('token') ? 'token' : undefined;
    const classification = error?.stop_reason === 'deadline'
      ? { result: 'error', detail: 'Verification deadline exceeded', stop_reason: 'deadline' }
      : status === null ? { result: 'error', detail: 'Request failed without an HTTP response' }
        : status >= 200 && status < 300 ? { result: 'error', detail: 'Response processing failed' } : classify(status);
    if (phase && status !== null) classification.detail = `Token request failed (HTTP ${status}); response body withheld`;
    return { area: probe.area, status, ...classification, source: source(probe, status, classification.result, phase) };
  }
}

/** Private auth closures and probe state never enter summaries or MCP output. */
export function createOptionalClients(config, { env = process.env, fetchImpl } = {}) {
  const clients = {};
  const options = { env, ...(fetchImpl ? { fetchImpl } : {}) };
  const oauth = (label, side) => createServiceClient({ label, url: side.url, tokenUrl: side.tokenUrl, clientId: side.clientId, clientSecret: side.clientSecret, exposeErrorDetails: false, ...options });
  const fixed = (label, side, authorization, extra = {}) => createStaticServiceClient({ label, url: side.url, authorization, ...options, ...extra });
  for (const key of OPTIONAL_CLIENT_KEYS) {
    const side = config?.[key];
    if (!side) { clients[key] = null; continue; }
    let client;
    let probes;
    if (key === 'ctms') {
      client = oauth('cTMS', side);
      probes = [{ area: 'Transport nodes', path: '/v2/nodes', kind: 'nodes' }];
    } else if (key === 'ans') {
      client = fixed('ANS', side, () => basic(side.username, side.password));
      probes = ['subscription', 'condition', 'action'].map(name => ({ area: `Alert ${name} metadata`, path: `/cf/configuration/v1/${name}`, query: { page: 0, pageSize: 1 }, kind: 'ans' }));
    } else if (key === 'event_mesh') {
      client = oauth('Event Mesh', side);
      probes = side.probeQueueName ? [{ area: 'Named queue management', path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(side.probeQueueName)}`, kind: 'queue' }] : [];
    } else if (key === 'aem') {
      client = fixed('Advanced Event Mesh', { url: 'https://api.solace.cloud' }, () => `Bearer ${side.apiToken}`);
      probes = [{ area: 'GA event broker services', path: '/api/v2/missionControl/eventBrokerServices', query: { pageNumber: 1, pageSize: 1, expand: 'allowedActions' }, kind: 'aem' }];
    } else if (key === 'aem_semp') {
      client = fixed('AEM SEMP', side, () => basic(side.username, side.password), { reuseCookies: true });
      SCOPES.set(client, Object.freeze({ sempVpnName: side.msgVpnName }));
      probes = [{ area: 'VPN queue metadata', path: `/SEMP/v2/monitor/msgVpns/${encodeURIComponent(side.msgVpnName)}/queues`, query: { count: 1 }, kind: 'semp' }];
    } else if (key === 'open_connectors') {
      client = createOpenConnectorsClient(side, options);
      probes = [{ area: 'Connector instance identities', path: '/instances', query: { pageSize: 1 }, kind: 'instances' }];
    } else if (key === 'edge') {
      client = fixed('Edge Integration Cell', side, () => basic(side.clientId, side.clientSecret));
      probes = [{ area: 'Local OData metadata', path: '/local/api/eic/v1/$metadata', kind: 'metadata' }];
    }
    clients[key] = client;
    PROBES.set(client, probes);
  }
  return Object.freeze(clients);
}

/** Optional evidence is separate from configured core access and never proves entitlement. */
export async function verifyOptionalClients(clients = {}, { deadline = Date.now() + 30_000 } = {}) {
  const entries = await Promise.all(OPTIONAL_CLIENT_KEYS.map(async key => {
    const client = clients[key];
    if (!client) return [key, { configured: false, signed_in: false, ok: false, result: 'untested', activation: 'unknown', entitlement: 'unknown', checks: [] }];
    const probes = PROBES.get(client);
    if (!probes?.length) return [key, {
      configured: true, signed_in: false, ok: false, result: 'untested', activation: 'unknown', entitlement: 'unknown',
      detail: key === 'event_mesh' ? 'Set probeQueueName to an existing queue to test management access; no token or API request was made' : 'No private probe definition exists for this client', checks: []
    }];
    const checks = await Promise.all(probes.map(probe => readProbe(client, probe, deadline)));
    const firstFailure = checks.find(check => check.result !== 'ok');
    const result = firstFailure?.result ?? 'ok';
    const signedIn = checks.some(check => check.status !== null && check.result !== 'unauthenticated' && check.source.phase !== 'token');
    return [key, {
      configured: true, signed_in: signedIn, ok: result === 'ok', result, activation: 'unknown', entitlement: 'unknown',
      ...(firstFailure ? { error: firstFailure.detail } : {}), checks
    }];
  }));
  const reports = Object.fromEntries(entries);
  const configured = Object.entries(reports).filter(([, side]) => side.configured);
  return {
    ...reports,
    optional_completeness: {
      scope: 'configured_optional_access', configured: configured.map(([key]) => key),
      complete: configured.every(([, side]) => side.result === 'ok'),
      result: configured.length === 0 ? 'not_configured' : configured.every(([, side]) => side.result === 'ok') ? 'ok' : 'partial',
      unverified: configured.filter(([, side]) => side.result !== 'ok').map(([key]) => key)
    }
  };
}

/** Optional authority is separate per client; configuration does not enable other adapters. */
export function registerOptionalIntegrationTools(register, { ans, ctms, event_mesh, aem, aem_semp, open_connectors, edge } = {}) {
  if (ans) registerAnsTools(register, ans);
  if (ctms) registerCtmsTools(register, ctms);
  registerMessagingTools(register, { event_mesh, aem, aem_semp }, SCOPES.get(aem_semp));
  if (open_connectors) registerOpenConnectorsTools(register, open_connectors);
  if (edge) registerEdgeMonitoringTools(register, edge);
}

export function optionalToolNames() {
  const names = [];
  registerAnsTools(name => names.push(name), null);
  registerCtmsTools(name => names.push(name), null);
  for (const registrar of [registerEventMeshTools, registerAemTools, registerAemSempTools, registerOpenConnectorsTools, registerEdgeMonitoringTools]) registrar(name => names.push(name), null);
  return names;
}
