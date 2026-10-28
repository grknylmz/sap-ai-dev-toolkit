#!/usr/bin/env node
// Separate from run-live-integration: fixed metadata tools, GET-only management transport.
import { fetch as undiciFetch } from 'undici';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { resolveIntegrationConfig } from '../src/integration-config.mjs';
import { readStoredIntegrationKeys } from '../src/integration-credentials.mjs';

function options(argv) {
  const result = { window_minutes: 60, top: 3, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--json') result.json = true;
    else if (option === '--window-minutes' || option === '--top') {
      const value = Number(argv[++i]);
      const maximum = option === '--top' ? 5 : 31 * 24 * 60;
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${option} must be an integer from 1 to ${maximum}`);
      result[option === '--top' ? 'top' : 'window_minutes'] = value;
    } else throw new Error(`Unsupported argument ${option}`);
  }
  return result;
}
const pick = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
const page = (value, itemFields) => ({ ...pick(value, ['returned', 'total', 'complete', 'stop_reason', 'consistency', 'source_result', 'source_results', 'outcome', 'window']),
  resumable: typeof value.next_cursor === 'string', items: (value.items ?? []).map(item => pick(item, itemFields)) });
const sourceFailure = value => {
  if (!value || typeof value !== 'object') return false;
  if (['unauthenticated', 'forbidden', 'unavailable', 'error'].includes(value.result)) return true;
  return Object.values(value).some(entry => entry && typeof entry === 'object' && sourceFailure(entry));
};

async function main() {
  const args = options(process.argv.slice(2));
  const now = Date.now();
  const window = { from: new Date(now - args.window_minutes * 60000).toISOString(), to: new Date(now).toISOString() };
  const env = process.env;
  const config = resolveIntegrationConfig(env, { stored: readStoredIntegrationKeys(env) });
  const sides = Object.entries(config).filter(([, side]) => side && typeof side === 'object' && typeof side.url === 'string');
  const tokenUrls = new Set(sides.map(([, side]) => side.tokenUrl).filter(Boolean));
  const origins = new Set(sides.map(([, side]) => new URL(side.url).origin));
  // AEM uses one fixed public cloud origin; no caller-supplied origin is accepted.
  if (config.aem) origins.add('https://api.solace.cloud');
  const requests = { management_gets: 0, token_posts: 0 };
  const guardedFetch = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'POST' && tokenUrls.has(target.href)) requests.token_posts += 1;
    else if (method === 'GET' && origins.has(target.origin)) requests.management_gets += 1;
    else throw new Error('Read-only checker rejected a non-GET management request or unbound origin');
    if (target.username || target.password || target.hash) throw new Error('Read-only checker rejected an unsafe request URL');
    if (init.redirect && init.redirect !== 'manual') throw new Error('Read-only checker rejected redirect following');
    return undiciFetch(input, { ...init, redirect: 'manual' });
  };
  const runtime = createIntegrationServer({ env, fetchImpl: guardedFetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'read-only-integration-check', version: '1.0.0' });
  const report = { mode: 'read_only', environment: runtime.connectionSummary.environment ?? 'default', window,
    meaning: 'Exit 0 means requested configured core reads/schema checks executed, not a healthy landscape.', checks: [], optional_live_verification: {}, requests };
  let coreFailed = false;
  try {
    await runtime.server.connect(b); await client.connect(a);
    const names = new Set((await client.listTools()).tools.map(tool => tool.name));
    const call = async (name, input = {}, { core = true, project = value => value, validate = value => value && typeof value === 'object' } = {}) => {
      if (!names.has(name)) {
        report.checks.push({ tool: name, result: 'skipped', reason: 'not_configured_or_not_registered' });
        return null;
      }
      try {
        const response = await client.callTool({ name, arguments: input });
        if (response.isError) {
          const status = /\bHTTP (\d{3})\b/.exec(response.content?.[0]?.text ?? '')?.[1];
          report.checks.push({ tool: name, result: 'failed', ...(status ? { http_status: Number(status) } : {}), error: 'Tool read failed; response body withheld.' });
          if (core) coreFailed = true;
          return null;
        }
        const value = JSON.parse(response.content[0].text);
        if (!validate(value)) throw new Error('contract_error');
        const failed = sourceFailure(value);
        report.checks.push({ tool: name, result: failed ? 'partial_or_failed_source' : 'executed', evidence: project(value) });
        if (core && (failed || value.outcome === 'partial' && value.metrics_complete === false)) coreFailed = true;
        return value;
      } catch {
        report.checks.push({ tool: name, result: 'failed', error: 'Read or contract failure; response body withheld.' });
        if (core) coreFailed = true;
        return null;
      }
    };
    const isPage = value => Array.isArray(value.items) && Number.isInteger(value.returned) && value.returned === value.items.length
      && (value.total === null || Number.isFinite(value.total) && value.total >= 0) && typeof value.complete === 'boolean'
      && (value.next_cursor === null || typeof value.next_cursor === 'string') && typeof value.stop_reason === 'string';
    const connection = await call('integration_connection_info', { verify: true }, { core: false, validate: value => value.verification && typeof value.verification.ok === 'boolean' });
    if (!connection || ['cpi', 'apim', 'devhub'].some(side => config[side] && sourceFailure(connection.verification[side]))) coreFailed = true;
    if (config.cpi) {
      const logs = await call('cpi_list_message_logs', { ...window, top: args.top }, { validate: isPage,
        project: value => page(value, ['MessageGuid', 'CorrelationId', 'ApplicationMessageId', 'Status', 'LogStart', 'LogEnd', 'IntegrationArtifact']) });
      await call('cpi_get_message_statistics', window, { validate: value => value.count_by_status && typeof value.complete === 'boolean' });
      const guid = logs?.items?.[0]?.MessageGuid;
      if (guid) {
        await call('cpi_list_message_log_runs', { message_guid: guid, top: args.top }, { validate: isPage, project: value => page(value, ['Id', 'RunStart', 'RunStop', 'OverallState']) });
        await call('cpi_get_message_log_steps', { message_guid: guid, top: args.top }, { validate: isPage,
          project: value => ({ ...page(value, ['StepId', 'ModelStepId', 'Activity', 'Status', 'StepStart', 'StepStop']), run: pick(value.run, ['Id', 'RunStart', 'RunStop', 'OverallState']) }) });
      } else report.checks.push({ tool: 'cpi_get_message_log_steps', result: 'untested', reason: 'No message fixture in the fixed window.' });
      await call('cpi_list_runtime_artifacts', { top: args.top }, { validate: isPage, project: value => page(value, ['Id', 'Version', 'Status', 'Type', 'DeployedOn']) });
      await call('cpi_get_jms_broker_status');
      await call('cpi_list_jms_queues', { top: args.top }, { validate: isPage, project: value => page(value, ['Name', 'State', 'Active', 'NumbOfMsgs', 'Size', 'FillGrade']) });
      const stores = await call('cpi_list_data_stores', { overdue_only: true, top: args.top }, { validate: isPage,
        project: value => page(value, ['DataStoreName', 'IntegrationFlow', 'Type', 'Visibility', 'NumberOfMessages', 'NumberOfOverdueMessages']) });
      const store = stores?.items?.[0];
      if (store) await call('cpi_list_data_store_entries', { data_store: store.DataStoreName, integration_flow: store.IntegrationFlow, type: store.Type ?? '', top: args.top },
        { validate: isPage, project: value => ({ ...page(value, ['Id', 'Status', 'MessageId', 'DueAt', 'CreatedAt', 'RetainUntil']), store: value.store }) });
      await call('cpi_get_certificate_health', { top: args.top }, { validate: isPage,
        project: value => ({ ...page(value, ['Alias', 'Type', 'KeyType', 'ValidNotBefore', 'ValidNotAfter', 'days_remaining', 'validity']), evaluated_at: value.evaluated_at }) });
      await call('cpi_get_operational_summary', window);
    }
    if (config.apim) {
      await call('apim_get_analytics', window, { validate: value => typeof value.complete === 'boolean' && typeof value.outcome === 'string' });
      await call('apim_get_analytics_series', { ...window, granularity: 'hour', top: args.top }, { validate: isPage });
      await call('apim_get_api_error_breakdown', { ...window, top: args.top }, { validate: isPage });
    }
    // Fixed optional read catalog. Missing credentials are unverified, not a failed entitlement check.
    const optionalReads = [
      ['ans', 'ans_list_subscriptions'], ['ans', 'ans_list_conditions'], ['ans', 'ans_list_action_metadata'],
      ['ctms', 'ctms_list_nodes'], ['aem', 'aem_list_brokers'], ['aem_semp', 'aem_list_queues'],
      ['open_connectors', 'open_connectors_list_instances'], ['edge', 'edge_list_message_logs']
    ];
    for (const [side, name] of optionalReads) {
      if (!config[side] || !names.has(name)) { report.optional_live_verification[side] = 'live_unverified'; continue; }
      const value = await call(name, { ...(side === 'edge' ? window : {}), top: args.top }, { core: false, validate: isPage });
      report.optional_live_verification[side] = value && !sourceFailure(value) ? 'read_exercised' : 'live_unverified';
    }
    if (config.edge) await call('edge_get_api_metadata', {}, { core: false });
    if (config.event_mesh?.probeQueueName) {
      const value = await call('event_mesh_get_queue', { name: config.event_mesh.probeQueueName }, { core: false });
      report.optional_live_verification.event_mesh = value && !sourceFailure(value) ? 'read_exercised' : 'live_unverified';
    } else report.optional_live_verification.event_mesh = 'live_unverified';
    report.core_reads_executed = !coreFailed;
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Read-only Integration Suite check: ${report.core_reads_executed ? 'core reads executed' : 'core read/contract failures'}`);
      console.log(`Window ${window.from} to ${window.to}; ${requests.management_gets} management GETs, ${requests.token_posts} token POSTs.`);
      for (const check of report.checks) console.log(`${check.tool}: ${check.result}`);
      console.log('This is not a health sign-off; inspect degraded/unknown signals and optional live_unverified entries with --json.');
    }
  } finally { await client.close().catch(() => {}); await runtime.close(); }
  if (coreFailed) process.exitCode = 1;
}
main().catch(() => {
  console.error('Read-only Integration Suite check could not initialize or complete. Credential values and response bodies are withheld; check host configuration and service access.');
  process.exitCode = 1;
});
