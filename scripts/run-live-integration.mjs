// Live end-to-end scenarios (S01–S94) for the Integration Suite companion against a real CPI + APIM tenant.
// WRITES TO THE TENANT: creates a package, iFlows (deployed, one undeployed again), a user credential, a number
// range, a Partner Directory parameter, API providers, API proxies (with policies), an API product and a key value
// map, all named with the RUN suffix. There are no delete tools; remove the artifacts in the Integration Suite UI.
// Usage: CPI_SERVICE_KEY=… APIM_SERVICE_KEY=… RUN=<unique suffix> npm run test:live:integration
//        ONLY=S01,S02 limits the run to selected scenarios (later scenarios may depend on earlier ones).
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { INTEGRATION_TOOL_NAMES } from '../src/integration-tools.mjs';
import { resolveIntegrationConfig } from '../src/integration-config.mjs';
import { readStoredIntegrationKeys } from '../src/integration-credentials.mjs';

const RUN = process.env.RUN;
if (!RUN || !/^[A-Za-z0-9]{1,8}$/.test(RUN)) {
  console.error('Set RUN to a unique 1-8 character alphanumeric suffix; every run creates new tenant artifacts.');
  process.exit(1);
}
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PKG = `ZAIDEVSMOKE${RUN}`;
const IFLOW = `Z_AI_Smoke_${RUN}`;
const IFLOW_ONPREM = `Z_AI_OnPrem_${RUN}`;
const IFLOW_TIMER_OK = `Z_AI_Timer_Ok_${RUN}`;
const IFLOW_TIMER_FAIL = `Z_AI_Timer_Fail_${RUN}`;
const PROVIDER = `ZAI_SMOKE_HTTPBIN${RUN}`;
const PROVIDER_ONPREM = `ZAI_SMOKE_ONPREM${RUN}`;
const PROXY = `ZAI_Smoke${RUN}`;
const PROXY_URL = `ZAI_SmokeUrl${RUN}`;
const PROXY_ODATA = `ZAI_SmokeOData${RUN}`;
const PROXY_CPI = `ZAI_SmokeCpi${RUN}`;
const config = resolveIntegrationConfig(process.env, { stored: readStoredIntegrationKeys() });
const SECRETS = Object.values(config).filter(Boolean).map(side => side.clientSecret);
const PRODUCT = `ZAI_SmokeProduct${RUN}`;
const KVM = `ZAI_SmokeKvm${RUN}`;
const CREDENTIAL = `ZAI_SMOKE_USER_${RUN}`;
const NUMBER_RANGE = `ZAI_SMOKE_NR_${RUN}`;
const PARTNER = `ZAI_SMOKE_PARTNER_${RUN}`;
// Write-only secrets of this run: every tool output is scanned for them like the service-key secrets.
const RUN_SECRETS = { credential: `pw-${RUN}-${Date.now().toString(36)}`, kvm: `kvm-${RUN}-${Date.now().toString(36)}` };
SECRETS.push(...Object.values(RUN_SECRETS));

const runtime = createIntegrationServer({ pollIntervalMs: 3000, readBackDelayMs: 5000 });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'live-scenarios', version: '1' });
await runtime.server.connect(b);
await client.connect(a);

const ctx = {};
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content[0].text;
  for (const secret of SECRETS) if (text.includes(secret)) throw new Error(`SECRET LEAK in ${name}`);
  let json;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: response.isError === true, text, json };
}
function ok(result, label) {
  if (result.isError) throw new Error(`${label}: ${result.text}`);
  return result.json;
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
async function http(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  return { status: response.status, text: await response.text() };
}

// ---- CPI runtime calls (integration-flow plan key; test harness only, never used by the add-in)
const RUNTIME_KEY = process.env.CPI_RUNTIME_SERVICE_KEY ? (JSON.parse(process.env.CPI_RUNTIME_SERVICE_KEY).oauth ?? JSON.parse(process.env.CPI_RUNTIME_SERVICE_KEY)) : null;
if (RUNTIME_KEY?.clientsecret) SECRETS.push(RUNTIME_KEY.clientsecret);
let runtimeToken = null;
async function runtimeBearer() {
  if (!RUNTIME_KEY) throw new Error('CPI_RUNTIME_SERVICE_KEY (Process Integration Runtime integration-flow plan) is required for runtime scenarios');
  if (runtimeToken && runtimeToken.expiresAt > Date.now()) return runtimeToken.value;
  const response = await fetch(RUNTIME_KEY.tokenurl, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${RUNTIME_KEY.clientid}:${RUNTIME_KEY.clientsecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const payload = await response.json();
  runtimeToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in - 120) * 1000 };
  return runtimeToken.value;
}
// Call an endpoint until `done(result)` holds (endpoints register and redeploys switch over with a lag).
async function invoke(url, { method = 'POST', body, headers = {}, auth = true, done = result => result.status !== 404 && result.status !== 503, attempts = 36 } = {}) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${await runtimeBearer()}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body,
      signal: AbortSignal.timeout(60000)
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    result = { status: response.status, text, json };
    if (done(result)) return result;
    await sleep(5000);
  }
  return result;
}
function cleanError(result, pattern) {
  expect(result.isError, `expected an error, got ${result.text.slice(0, 200)}`);
  expect(result.text !== 'Integration Suite request failed. Check service-key roles and tenant reachability.', 'generic error text hides the cause');
  if (pattern) expect(pattern.test(result.text), `error text: ${result.text.slice(0, 300)}`);
  return result.text.replace(/\s+/g, ' ').slice(0, 160);
}
async function waitForGuid(guid) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await call('cpi_get_message_log', { message_guid: guid });
    if (!result.isError && result.json?.log?.Status && result.json.log.Status !== 'PROCESSING') return result.json;
    await sleep(5000);
  }
  throw new Error(`message ${guid} not visible after 120 s`);
}

async function scenario(id, title, body) {
  if (ONLY && !ONLY.has(id)) return;
  const started = Date.now();
  try {
    const note = await body();
    results.push({ id, title, status: 'PASS', note: note ?? '', ms: Date.now() - started });
    console.log(`PASS ${id} ${title}${note ? ` — ${note}` : ''}`);
  } catch (error) {
    results.push({ id, title, status: 'FAIL', note: error.message, ms: Date.now() - started });
    console.log(`FAIL ${id} ${title} — ${error.message}`);
  }
}

// ---- custom timer BPMN derived from the vetted template
const template = await readFile(new URL('../src/integration-templates/https-request-reply-http.iflw', import.meta.url), 'utf8');
function timerIflw() {
  let xml = template;
  xml = xml.replace(/\s*<bpmn2:participant id="Participant_1"[\s\S]*?<\/bpmn2:participant>/, '');
  xml = xml.replace(/\s*<bpmn2:messageFlow id="MessageFlow_4"[\s\S]*?<\/bpmn2:messageFlow>/, '');
  xml = xml.replace(/\s*<bpmndi:BPMNShape bpmnElement="Participant_1"[\s\S]*?<\/bpmndi:BPMNShape>/, '');
  xml = xml.replace(/\s*<bpmndi:BPMNEdge bpmnElement="MessageFlow_4"[\s\S]*?<\/bpmndi:BPMNEdge>/, '');
  xml = xml.replace(/<bpmn2:startEvent id="StartEvent_2" name="Start">[\s\S]*?<\/bpmn2:startEvent>/,
    `<bpmn2:startEvent id="StartEvent_2" name="Start Timer 1">
            <bpmn2:outgoing>SequenceFlow_3</bpmn2:outgoing>
            <bpmn2:timerEventDefinition id="TimerEventDefinition_1">
                <bpmn2:extensionElements>
                    <ifl:property><key>scheduleKey</key><value>{{Timer_Schedule}}</value></ifl:property>
                    <ifl:property><key>componentVersion</key><value>1.0</value></ifl:property>
                    <ifl:property><key>cmdVariantUri</key><value>ctype::FlowstepVariant/cname::intermediatetimer/version::1.0.0</value></ifl:property>
                    <ifl:property><key>activityType</key><value>StartTimerEvent</value></ifl:property>
                </bpmn2:extensionElements>
            </bpmn2:timerEventDefinition>
        </bpmn2:startEvent>`);
  if (xml.includes('Participant_1') || xml.includes('MessageFlow_4')) throw new Error('timer BPMN still references the HTTPS sender');
  return xml;
}
const RUN_ONCE = '<row><cell>dateType</cell><cell></cell></row><row><cell>timeType</cell><cell></cell></row><row><cell>dayValue</cell><cell></cell></row><row><cell>monthValue</cell><cell></cell></row><row><cell>yearValue</cell><cell></cell></row><row><cell>onWeekly</cell><cell></cell></row><row><cell>onMonthly</cell><cell></cell></row><row><cell>OnEveryMinute</cell><cell></cell></row><row><cell>fromInterval</cell><cell></cell></row><row><cell>toInterval</cell><cell></cell></row><row><cell>timeZone</cell><cell>( UTC 0:00 ) Greenwich Mean Time(Etc/GMT)</cell></row><row><cell>secondValue</cell><cell>0</cell></row><row><cell>minutesValue</cell><cell></cell></row><row><cell>hourValue</cell><cell></cell></row><row><cell>triggerType</cell><cell>simple</cell></row><row><cell>noOfSchedules</cell><cell>1</cell></row><row><cell>schedule1</cell><cell>fireNow=true</cell></row>';
function timerParameters(address) {
  return {
    Timer_Schedule: RUN_ONCE,
    Receiver_Address: address,
    Receiver_Query: '',
    Receiver_Method: 'GET',
    Receiver_Proxy_Type: 'default',
    Receiver_Location_ID: '',
    Receiver_Authentication: 'None',
    Receiver_Credential_Name: '',
    Receiver_Timeout: '30000'
  };
}


async function deployAndWait(iflowId) {
  const deployed = ok(await call('cpi_deploy_iflow', { iflow_id: iflowId, wait_seconds: 50, confirmation: `DEPLOY IFLOW ${iflowId}` }), `deploy ${iflowId}`);
  let status = { Status: deployed.runtime_status, Version: deployed.runtime_version, error_information: deployed.error_information };
  for (let attempt = 0; attempt < 36 && (deployed.timed_out || status.Status === 'STARTING' || !status.Status); attempt += 1) {
    await sleep(5000);
    status = ok(await call('cpi_get_iflow_runtime_status', { iflow_id: iflowId }), 'status');
    if (status.Status && status.Status !== 'STARTING') break;
  }
  return { deployed, runtime: status };
}

// ============================================================ shared
await scenario('S01', 'connection info reports both sides without secrets', async () => {
  const info = ok(await call('integration_connection_info'), 'info');
  expect(info.cpi.configured && info.apim.configured, 'both sides must be configured');
  return `${info.cpi.host} / ${info.apim.host}`;
});

await scenario('S02', `tools/list exposes ${INTEGRATION_TOOL_NAMES.length} tools with write annotations`, async () => {
  const { tools } = await client.listTools();
  expect(tools.length === INTEGRATION_TOOL_NAMES.length, `expected ${INTEGRATION_TOOL_NAMES.length} tools, got ${tools.length}`);
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  expect(byName.cpi_update_iflow.annotations.destructiveHint === true, 'update must be destructive');
  expect(byName.cpi_undeploy_artifact.annotations.destructiveHint === true, 'undeploy must be destructive');
  expect(byName.cpi_list_packages.annotations.readOnlyHint === true, 'list must be read-only');
  expect(!tools.some(tool => /delete/i.test(tool.name)), 'no delete tools');
});

// ============================================================ CPI packages
await scenario('S03', 'cpi_create_package with wrong confirmation is refused', async () => {
  const result = await call('cpi_create_package', { package_id: PKG, name: 'AI smoke', short_text: 'AI smoke', confirmation: `CREATE CPI PACKAGE WRONG` });
  expect(result.isError && result.text === `confirmation must equal CREATE CPI PACKAGE ${PKG}`, result.text);
  const packages = ok(await call('cpi_list_packages', { top: 200 }), 'list');
  expect(!packages.some(entry => entry.Id === PKG), 'package must not exist');
});

await scenario('S04', 'cpi_create_package creates the smoke package', async () => {
  const created = ok(await call('cpi_create_package', { package_id: PKG, name: `AI smoke ${RUN}`, short_text: 'Created by sap-ai-integration live scenarios', description: 'Safe to delete', confirmation: `CREATE CPI PACKAGE ${PKG}` }), 'create');
  expect(created.created === true, 'created flag');
});

await scenario('S05', 'cpi_create_package on an existing id surfaces the tenant error', async () => {
  const result = await call('cpi_create_package', { package_id: PKG, name: 'dup', short_text: 'dup', confirmation: `CREATE CPI PACKAGE ${PKG}` });
  expect(result.isError && /^CPI POST \/api\/v1\/IntegrationPackages failed \(HTTP \d+\)/.test(result.text), result.text);
  return result.text.slice(0, 140);
});

await scenario('S06', 'cpi_list_packages shows the package', async () => {
  const packages = ok(await call('cpi_list_packages', { top: 200 }), 'list');
  const entry = packages.find(item => item.Id === PKG);
  expect(entry, 'package missing');
  expect(entry.ShortText === 'Created by sap-ai-integration live scenarios', `short text ${entry.ShortText}`);
});

// ============================================================ CPI template iFlow
await scenario('S07', 'cpi_create_iflow from the template (internet, None, httpbin)', async () => {
  const created = ok(await call('cpi_create_iflow', {
    package_id: PKG, iflow_id: IFLOW, name: `AI Smoke ${RUN}`, description: 'HTTPS -> httpbin',
    template: 'https-request-reply-http',
    template_parameters: { sender_path: `/ai/smoke${RUN}`, receiver_address: 'https://httpbin.org/anything', receiver_proxy_type: 'internet', receiver_authentication: 'None' },
    confirmation: `CREATE IFLOW ${IFLOW}`
  }), 'create');
  expect(created.version === '1.0.0', 'version');
});

await scenario('S08', 'cpi_create_iflow refuses a duplicate id before posting', async () => {
  const result = await call('cpi_create_iflow', {
    package_id: PKG, iflow_id: IFLOW, name: 'dup', template: 'https-request-reply-http',
    template_parameters: { sender_path: '/dup', receiver_address: 'https://httpbin.org/anything', receiver_proxy_type: 'internet', receiver_authentication: 'None' },
    confirmation: `CREATE IFLOW ${IFLOW}`
  });
  expect(result.isError && result.text === `iFlow ${IFLOW} already exists; use cpi_update_iflow`, result.text);
});

await scenario('S09', 'cpi_list_iflows lists the iFlow at 1.0.0', async () => {
  const iflows = ok(await call('cpi_list_iflows', { package_id: PKG }), 'list');
  const entry = iflows.find(item => item.Id === IFLOW);
  expect(entry && entry.Version === '1.0.0', JSON.stringify(iflows));
});

await scenario('S10', 'cpi_get_iflow returns configurations and bundle files', async () => {
  const iflow = ok(await call('cpi_get_iflow', { iflow_id: IFLOW }), 'get');
  const config = Object.fromEntries(iflow.configurations.map(entry => [entry.ParameterKey, entry.ParameterValue]));
  expect(config.Receiver_Address === 'https://httpbin.org/anything', `Receiver_Address=${config.Receiver_Address}`);
  expect(config.Sender_Path === `/ai/smoke${RUN}`, `Sender_Path=${config.Sender_Path}`);
  const iflw = iflow.files.find(file => file.path.endsWith('.iflw'));
  expect(iflw && iflw.text.includes('{{Receiver_Address}}'), 'iflw text');
  return `${iflow.configurations.length} parameters, ${iflow.files.length} files`;
});

await scenario('S11', 'cpi_get_iflow file_path returns one file; unknown path errors', async () => {
  const single = ok(await call('cpi_get_iflow', { iflow_id: IFLOW, file_path: 'src/main/resources/parameters.prop' }), 'file');
  expect(/Receiver_Method=GET/.test(single.file.text), 'parameters.prop text');
  const missing = await call('cpi_get_iflow', { iflow_id: IFLOW, file_path: 'nope.txt' });
  expect(missing.isError && missing.text === 'file_path not found in the iFlow bundle', missing.text);
});

await scenario('S12', 'cpi_update_iflow_configuration changes an externalized value', async () => {
  const result = ok(await call('cpi_update_iflow_configuration', {
    iflow_id: IFLOW,
    parameters: [{ key: 'Receiver_Address', value: 'https://httpbin.org/anything/configured' }],
    confirmation: `CONFIGURE IFLOW ${IFLOW}`
  }), 'configure');
  expect(result.failed === null && result.updated[0] === 'Receiver_Address', JSON.stringify(result));
  const iflow = ok(await call('cpi_get_iflow', { iflow_id: IFLOW }), 'get');
  const value = iflow.configurations.find(entry => entry.ParameterKey === 'Receiver_Address')?.ParameterValue;
  expect(value === 'https://httpbin.org/anything/configured', `read back ${value}`);
});

await scenario('S13', 'cpi_update_iflow_configuration reports an unknown key as failed', async () => {
  const result = ok(await call('cpi_update_iflow_configuration', {
    iflow_id: IFLOW,
    parameters: [{ key: 'Receiver_Method', value: 'GET' }, { key: 'No_Such_Key', value: 'x' }],
    confirmation: `CONFIGURE IFLOW ${IFLOW}`
  }), 'configure');
  expect(result.updated.length === 1 && result.failed?.key === 'No_Such_Key', JSON.stringify(result));
  return result.failed.error.slice(0, 120);
});

await scenario('S14', 'cpi_update_iflow rejects a stale expected_version', async () => {
  const result = await call('cpi_update_iflow', {
    iflow_id: IFLOW, expected_version: '0.9.9',
    files: [{ path: 'src/main/resources/script/noop.groovy', content: 'x' }],
    confirmation: `UPDATE IFLOW ${IFLOW}`
  });
  expect(result.isError && /is at version 1\.0\.0, not 0\.9\.9/.test(result.text), result.text);
});

await scenario('S15', 'cpi_update_iflow adds a script and parameter and bumps to 1.0.1', async () => {
  const updated = ok(await call('cpi_update_iflow', {
    iflow_id: IFLOW, expected_version: '1.0.0',
    files: [{ path: 'src/main/resources/script/noop.groovy', content: 'import com.sap.gateway.ip.core.customdev.util.Message\ndef Message processData(Message message) { return message }\n' }],
    parameters: { Smoke_Marker: `run-${RUN}` },
    confirmation: `UPDATE IFLOW ${IFLOW}`
  }), 'update');
  expect(updated.new_version === '1.0.1', JSON.stringify(updated));
  const iflow = ok(await call('cpi_get_iflow', { iflow_id: IFLOW }), 'get');
  expect(iflow.artifact.Version === '1.0.1', `version ${iflow.artifact.Version}`);
  expect(iflow.files.some(file => file.path === 'src/main/resources/script/noop.groovy'), 'script present');
  const marker = iflow.configurations.find(entry => entry.ParameterKey === 'Smoke_Marker');
  expect(marker?.ParameterValue === `run-${RUN}`, `marker ${JSON.stringify(marker)}`);
  const address = iflow.configurations.find(entry => entry.ParameterKey === 'Receiver_Address')?.ParameterValue;
  return `Receiver_Address after update: ${address}`;
});

await scenario('S16', 'cpi_deploy_iflow deploys the template iFlow to STARTED', async () => {
  const { deployed, runtime } = await deployAndWait(IFLOW);
  expect(runtime.Status === 'STARTED', JSON.stringify({ deployed, runtime }));
  return `build ${deployed.build_status}, timed_out=${deployed.timed_out}, runtime ${runtime.Status}`;
});

await scenario('S17', 'cpi_get_iflow_runtime_status reports STARTED at 1.0.1', async () => {
  const status = ok(await call('cpi_get_iflow_runtime_status', { iflow_id: IFLOW }), 'status');
  expect(status.deployed && status.Status === 'STARTED' && status.Version === '1.0.1', JSON.stringify(status));
});

await scenario('S18', 'cpi_list_service_endpoints returns the iFlow URL', async () => {
  let endpoints = [];
  for (let attempt = 0; attempt < 36 && !endpoints.length; attempt += 1) {
    endpoints = ok(await call('cpi_list_service_endpoints', { iflow_id: IFLOW }), 'endpoints');
    if (!endpoints.length) await sleep(5000);
  }
  const url = endpoints.flatMap(entry => entry.urls).find(value => value.endsWith(`/http/ai/smoke${RUN}`));
  expect(url, JSON.stringify(endpoints));
  ctx.cpiEndpoint = url;
  const unauthenticated = await http(url, { method: 'POST', body: 'x' });
  expect(unauthenticated.status === 401, `unauthenticated call returned ${unauthenticated.status}`);
  return `${url} (401 without credentials)`;
});

await scenario('S19', 'on-premise + Basic template iFlow deploys with sapcc proxy settings', async () => {
  ok(await call('cpi_create_iflow', {
    package_id: PKG, iflow_id: IFLOW_ONPREM, name: `AI OnPrem ${RUN}`, template: 'https-request-reply-http',
    template_parameters: {
      sender_path: `/ai/onprem${RUN}`, receiver_address: 'http://s4h-virtual:44300/sap/opu/odata4/sap/zsmoke/srvd/sap/zsmoke/0001/',
      receiver_query: 'sap-client=100', receiver_method: 'GET', receiver_proxy_type: 'on_premise', receiver_location_id: 'SMOKE',
      receiver_authentication: 'Basic', receiver_credential_name: 'ZAI_SMOKE_USER', receiver_timeout_ms: 30000
    },
    confirmation: `CREATE IFLOW ${IFLOW_ONPREM}`
  }), 'create');
  const { deployed, runtime } = await deployAndWait(IFLOW_ONPREM);
  expect(runtime.Status === 'STARTED' || (runtime.Status === 'ERROR' && runtime.error_information), JSON.stringify({ deployed, runtime }));
  const prop = ok(await call('cpi_get_iflow', { iflow_id: IFLOW_ONPREM, file_path: 'src/main/resources/parameters.prop' }), 'file').file.text;
  expect(/Receiver_Proxy_Type=sapcc/.test(prop) && /Receiver_Credential_Name=ZAI_SMOKE_USER/.test(prop), prop);
  return `build ${deployed.build_status}, runtime ${runtime.Status}`;
});

await scenario('S20', 'custom BPMN (timer start) iFlow is created with caller parameters', async () => {
  const xml = timerIflw();
  ok(await call('cpi_create_iflow', { package_id: PKG, iflow_id: IFLOW_TIMER_OK, name: `AI Timer Ok ${RUN}`, template: 'custom', iflw_xml: xml, parameters: timerParameters('https://httpbin.org/anything/timer-ok'), confirmation: `CREATE IFLOW ${IFLOW_TIMER_OK}` }), 'create ok');
  ok(await call('cpi_create_iflow', { package_id: PKG, iflow_id: IFLOW_TIMER_FAIL, name: `AI Timer Fail ${RUN}`, template: 'custom', iflw_xml: xml, parameters: timerParameters('https://httpbin.org/status/500'), confirmation: `CREATE IFLOW ${IFLOW_TIMER_FAIL}` }), 'create fail');
  const iflows = ok(await call('cpi_list_iflows', { package_id: PKG }), 'list');
  expect([IFLOW_TIMER_OK, IFLOW_TIMER_FAIL].every(id => iflows.some(entry => entry.Id === id)), 'both listed');
});

await scenario('S21', 'timer iFlows deploy and start', async () => {
  for (const id of [IFLOW_TIMER_OK, IFLOW_TIMER_FAIL]) {
    const { deployed, runtime } = await deployAndWait(id);
    expect(runtime.Status === 'STARTED', `${id}: ${JSON.stringify({ deployed, runtime })}`);
  }
  ctx.timerDeployedAt = new Date(Date.now() - 5 * 60_000).toISOString();
});

async function waitForLog(iflowId, status) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = ok(await call('cpi_list_message_logs', { iflow_id: iflowId, status, top: 5 }), 'logs');
    if (result.logs.length) return result;
    await sleep(5000);
  }
  throw new Error(`no ${status} log for ${iflowId} after 120 s`);
}

await scenario('S22', 'cpi_list_message_logs finds the COMPLETED timer run', async () => {
  const result = await waitForLog(IFLOW_TIMER_OK, 'COMPLETED');
  const [log] = result.logs;
  expect(log.Status === 'COMPLETED' && /^\d{4}-\d\d-\d\dT/.test(log.LogStart), JSON.stringify(log));
  ctx.okGuid = log.MessageGuid;
  return `${log.MessageGuid} ${log.LogStart}`;
});

await scenario('S23', 'cpi_list_message_logs + cpi_get_message_log return the FAILED run with error text', async () => {
  const result = await waitForLog(IFLOW_TIMER_FAIL, 'FAILED');
  const detail = ok(await call('cpi_get_message_log', { message_guid: result.logs[0].MessageGuid }), 'detail');
  expect(detail.log.Status === 'FAILED', JSON.stringify(detail.log));
  expect(detail.error_information && /500/.test(detail.error_information), `error text: ${detail.error_information}`);
  return detail.error_information.replace(/\s+/g, ' ').slice(0, 140);
});

await scenario('S24', 'cpi_get_message_log for a COMPLETED run has no error text', async () => {
  expect(ctx.okGuid, 'needs S22');
  const detail = ok(await call('cpi_get_message_log', { message_guid: ctx.okGuid }), 'detail');
  expect(detail.log.Status === 'COMPLETED' && detail.error_information === null, JSON.stringify(detail).slice(0, 300));
  expect(Array.isArray(detail.custom_header_properties), 'custom headers array');
});

await scenario('S25', 'cpi_list_message_logs time window filters (from/to)', async () => {
  const future = ok(await call('cpi_list_message_logs', { iflow_id: IFLOW_TIMER_OK, from: '2099-01-01T00:00:00Z' }), 'future');
  expect(future.logs.length === 0, 'future window must be empty');
  const past = ok(await call('cpi_list_message_logs', { iflow_id: IFLOW_TIMER_OK, from: '2020-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z' }), 'past');
  expect(past.logs.length >= 1, 'wide window must include the run');
  return `total=${past.total}`;
});

// ============================================================ APIM providers
await scenario('S26', 'apim_create_api_provider refuses reserved names without a request', async () => {
  const result = await call('apim_create_api_provider', { name: 'TC_SMOKE', type: 'internet', host: 'httpbin.org', port: 443, confirmation: 'CREATE API PROVIDER TC_SMOKE' });
  expect(result.isError && result.text === 'API provider name TC_SMOKE is reserved by API Management', result.text);
});

await scenario('S27', 'apim_create_api_provider creates an Internet provider', async () => {
  const created = ok(await call('apim_create_api_provider', { name: PROVIDER, title: 'httpbin (AI smoke)', description: 'Safe to delete', type: 'internet', host: 'httpbin.org', port: 443, confirmation: `CREATE API PROVIDER ${PROVIDER}` }), 'create');
  expect(created.created === true, JSON.stringify(created));
  return created.provider ? `read back ${created.provider.destType}` : 'read back delayed';
});

await scenario('S28', 'apim_get_api_provider returns sanitized provider fields', async () => {
  const provider = ok(await call('apim_get_api_provider', { name: PROVIDER }), 'get');
  expect(provider.host === 'httpbin.org' && Number(provider.port) === 443 && provider.useSSL === true, JSON.stringify(provider).slice(0, 300));
  expect(!/"(?:password|clientSecret|userName|clientId)"/.test(JSON.stringify(provider)), 'credential keys present');
  return `destType=${provider.destType} isOnPremise=${provider.isOnPremise}`;
});

await scenario('S29', 'apim_create_api_provider creates an On-Premise provider with sap-client', async () => {
  const created = ok(await call('apim_create_api_provider', { name: PROVIDER_ONPREM, type: 'on_premise', host: 's4h-virtual', port: 44300, location_id: 'SMOKE', sap_client: '100', path_prefix: '/sap/opu', confirmation: `CREATE API PROVIDER ${PROVIDER_ONPREM}` }), 'create');
  const provider = created.provider ?? ok(await call('apim_get_api_provider', { name: PROVIDER_ONPREM }), 'get');
  expect(provider.isOnPremise === true, JSON.stringify(provider).slice(0, 400));
  expect(provider.cloudConnectorLocation === 'SMOKE', `location ${provider.cloudConnectorLocation}`);
  let props = provider.additionalProperties ?? [];
  for (let attempt = 0; attempt < 6 && !props.length; attempt += 1) {
    await sleep(5000);
    props = ok(await call('apim_get_api_provider', { name: PROVIDER_ONPREM }), 'get').additionalProperties ?? [];
  }
  expect(props.some(entry => entry.name === 'sap-client' && entry.value === '100'), `additionalProperties ${JSON.stringify(props)}`);
  return `destType=${provider.destType} useSSL=${provider.useSSL} pathPrefix=${provider.pathPrefix}`;
});

await scenario('S30', 'apim_list_api_providers lists both providers', async () => {
  const providers = ok(await call('apim_list_api_providers', { top: 200 }), 'list');
  expect([PROVIDER, PROVIDER_ONPREM].every(name => providers.some(entry => entry.name === name)), JSON.stringify(providers.map(entry => entry.name)));
});

// ============================================================ APIM proxies
await scenario('S31', 'apim_create_api_proxy fails for a missing provider before importing', async () => {
  const result = await call('apim_create_api_proxy', { name: `${PROXY}x`, base_path: `/ai/missing${RUN}`, service_type: 'rest', target: { provider: 'ZAI_NO_SUCH_PROVIDER', relative_path: '/x' }, confirmation: `CREATE API PROXY ${PROXY}x` });
  expect(result.isError && result.text === 'API provider ZAI_NO_SUCH_PROVIDER does not exist; create it with apim_create_api_provider', result.text);
  const proxies = ok(await call('apim_list_api_proxies', { top: 200 }), 'list');
  expect(!proxies.some(entry => entry.name === `${PROXY}x`), 'proxy must not exist');
});

await scenario('S32', 'apim_create_api_proxy (REST, provider target) is reachable at runtime_url', async () => {
  const created = ok(await call('apim_create_api_proxy', { name: PROXY, title: 'AI smoke', base_path: `/ai/smoke${RUN}`, service_type: 'rest', target: { provider: PROVIDER, relative_path: '/anything' }, confirmation: `CREATE API PROXY ${PROXY}` }), 'create');
  expect(created.runtime_url, JSON.stringify(created));
  ctx.proxyUrl = created.runtime_url;
  let response;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    response = await http(`${created.runtime_url}/ping?x=1`);
    if (response.status === 200) break;
    await sleep(5000);
  }
  expect(response.status === 200, `HTTP ${response.status}: ${response.text.slice(0, 200)}`);
  const echoed = JSON.parse(response.text);
  expect(/\/anything\/ping/.test(echoed.url), `upstream url ${echoed.url}`);
  return `${created.runtime_url} -> ${echoed.url}`;
});

await scenario('S33', 'apim_create_api_proxy refuses a duplicate name', async () => {
  const result = await call('apim_create_api_proxy', { name: PROXY, base_path: `/ai/dup${RUN}`, service_type: 'rest', target: { provider: PROVIDER, relative_path: '/anything' }, confirmation: `CREATE API PROXY ${PROXY}` });
  expect(result.isError && result.text === `API proxy ${PROXY} already exists; use apim_update_api_proxy`, result.text);
});

await scenario('S34', 'apim_update_api_proxy re-imports with a new target path', async () => {
  const updated = ok(await call('apim_update_api_proxy', { name: PROXY, title: 'AI smoke v2', base_path: `/ai/smoke${RUN}`, service_type: 'rest', target: { provider: PROVIDER, relative_path: '/anything/v2' }, confirmation: `UPDATE API PROXY ${PROXY}` }), 'update');
  expect(updated.updated === true, JSON.stringify(updated));
  let echoed;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await http(`${ctx.proxyUrl}/ping`);
    if (response.status === 200) {
      echoed = JSON.parse(response.text);
      if (/\/anything\/v2\/ping/.test(echoed.url)) break;
    }
    await sleep(5000);
  }
  expect(echoed && /\/anything\/v2\/ping/.test(echoed.url), `upstream ${echoed?.url}`);
  return echoed.url;
});

await scenario('S35', 'apim_update_api_proxy refuses a proxy that does not exist', async () => {
  const result = await call('apim_update_api_proxy', { name: 'ZAI_No_Such_Proxy', base_path: '/ai/none', service_type: 'rest', target: { url: 'https://httpbin.org/get' }, confirmation: 'UPDATE API PROXY ZAI_No_Such_Proxy' });
  expect(result.isError && result.text === 'API proxy ZAI_No_Such_Proxy does not exist; use apim_create_api_proxy', result.text);
});

await scenario('S36', 'apim_create_api_proxy with a fixed https URL target', async () => {
  const created = ok(await call('apim_create_api_proxy', { name: PROXY_URL, base_path: `/ai/url${RUN}`, service_type: 'rest', target: { url: 'https://httpbin.org/anything/url-target' }, confirmation: `CREATE API PROXY ${PROXY_URL}` }), 'create');
  let response;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    response = await http(created.runtime_url);
    if (response.status === 200) break;
    await sleep(5000);
  }
  expect(response.status === 200 && /url-target/.test(JSON.parse(response.text).url), `HTTP ${response.status}`);
  return created.runtime_url;
});

await scenario('S37', 'OData proxy needs an SAP service path (validated before any call)', async () => {
  const result = await call('apim_create_api_proxy', { name: PROXY_ODATA, base_path: `/ai/odata${RUN}`, service_type: 'odata', target: { provider: PROVIDER_ONPREM, relative_path: '/api/orders' }, confirmation: `CREATE API PROXY ${PROXY_ODATA}` });
  expect(result.isError && /\/sap\/opu\/odata/.test(result.text), result.text);
});

await scenario('S38', 'apim_create_api_proxy (OData, on-premise provider) imports and reads back', async () => {
  const created = ok(await call('apim_create_api_proxy', { name: PROXY_ODATA, title: 'S/4 OData smoke', base_path: `/ai/odata${RUN}`, service_type: 'odata', target: { provider: PROVIDER_ONPREM, relative_path: '/sap/opu/odata4/sap/zsmoke/srvd/sap/zsmoke/0001/' }, confirmation: `CREATE API PROXY ${PROXY_ODATA}` }), 'create');
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY_ODATA }), 'get');
  const target = proxy.targetEndPoints?.[0];
  expect(proxy.service_code === 'ODATA', `service_code ${proxy.service_code}`);
  expect(target?.provider_id === PROVIDER_ONPREM, JSON.stringify(target).slice(0, 300));
  return `${created.runtime_url} state=${proxy.state}`;
});

await scenario('S39', 'APIM in front of CPI: proxy to the iFlow endpoint reaches CPI', async () => {
  expect(ctx.cpiEndpoint, 'needs S18');
  const created = ok(await call('apim_create_api_proxy', { name: PROXY_CPI, base_path: `/ai/cpi${RUN}`, service_type: 'rest', target: { url: ctx.cpiEndpoint }, confirmation: `CREATE API PROXY ${PROXY_CPI}` }), 'create');
  let response;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    response = await http(created.runtime_url, { method: 'POST', body: 'x' });
    if (response.status === 401) break;
    await sleep(5000);
  }
  expect(response.status === 401, `expected CPI 401 through APIM, got ${response.status}: ${response.text.slice(0, 200)}`);
  return `${created.runtime_url} -> CPI (401 without CPI credentials, as expected)`;
});

await scenario('S40', 'apim_list_api_proxies shows all smoke proxies deployed', async () => {
  const proxies = ok(await call('apim_list_api_proxies', { top: 200 }), 'list');
  const mine = proxies.filter(entry => [PROXY, PROXY_URL, PROXY_ODATA, PROXY_CPI].includes(entry.name));
  expect(mine.length === 4, JSON.stringify(mine));
  return mine.map(entry => `${entry.name}:${entry.state}`).join(', ');
});

// ============================================================ complex end-to-end scenarios (S41–S80)
const IFLOW_POST = `Z_AI_Post_${RUN}`;
const IFLOW_CRED = `Z_AI_Cred_${RUN}`;
const IFLOW_BROKEN = `Z_AI_Broken_${RUN}`;
const PROVIDER_CPI = `ZAI_CPI_RT${RUN}`;
const PROXY_CPI_PROVIDER = `ZAI_SmokeCpiProv${RUN}`;
const PROXY_XML = `ZAI_SmokeXml${RUN}`;
const PROXY_DASH = `ZAI-Smoke-Dash-${RUN}`;
const ASCII_NAME = `Cafe Gruesse Flow ${RUN}`;
const UNICODE_DESCRIPTION = 'Grüße aus Köln & <tags> "quoted" — ünïcödé';
const SPECIAL_VALUE = ' lead=a:b\\c #x! ü';
const LARGE_SCRIPT = `// large script for truncation checks\n${'def line = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"\n'.repeat(900)}`;

await scenario('S41', 'runtime call to the template iFlow passes body and query to the receiver', async () => {
  expect(ctx.cpiEndpoint, 'needs S18');
  const result = await invoke(`${ctx.cpiEndpoint}?probe=${RUN}`, { body: JSON.stringify({ run: RUN, kind: 'direct' }) });
  expect(result.status === 200, `HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  expect(/\/anything\/configured/.test(result.json.url), `receiver url ${result.json.url}`);
  expect(result.json.args.probe === RUN, `query ${JSON.stringify(result.json.args)}`);
  expect(JSON.parse(result.json.data).kind === 'direct', `body ${result.json.data}`);
  ctx.directGuid = result.json.headers['Sap-Messageprocessinglogid'];
  expect(ctx.directGuid, 'no MPL id header forwarded');
  return `MPL ${ctx.directGuid}`;
});

await scenario('S42', 'cpi_get_message_log finds the runtime call by its MPL id', async () => {
  const detail = await waitForGuid(ctx.directGuid);
  expect(detail.log.Status === 'COMPLETED' && detail.log.MessageGuid === ctx.directGuid, JSON.stringify(detail.log).slice(0, 300));
  expect(detail.error_information === null, 'completed run must have no error');
  return `${detail.log.IntegrationFlowName} ${detail.log.LogStart} → ${detail.log.LogEnd}`;
});

await scenario('S43', 'APIM proxy in front of CPI forwards the caller bearer token end to end', async () => {
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY_CPI }), 'get');
  const result = await invoke(proxy.runtime_url, { body: JSON.stringify({ via: 'apim-url-target', run: RUN }) });
  expect(result.status === 200, `HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  expect(JSON.parse(result.json.data).via === 'apim-url-target', result.json.data);
  ctx.apimGuid = result.json.headers['Sap-Messageprocessinglogid'];
  return `${proxy.runtime_url} → CPI → httpbin`;
});

await scenario('S44', 'APIM provider on the CPI runtime host + proxy reaches the iFlow', async () => {
  const host = new URL(ctx.cpiEndpoint).host;
  ok(await call('apim_create_api_provider', { name: PROVIDER_CPI, title: 'CPI runtime', type: 'internet', host, port: 443, confirmation: `CREATE API PROVIDER ${PROVIDER_CPI}` }), 'provider');
  const created = ok(await call('apim_create_api_proxy', { name: PROXY_CPI_PROVIDER, base_path: `/ai/cpiprov${RUN}`, service_type: 'rest', target: { provider: PROVIDER_CPI, relative_path: `/http/ai/smoke${RUN}` }, confirmation: `CREATE API PROXY ${PROXY_CPI_PROVIDER}` }), 'proxy');
  const result = await invoke(created.runtime_url, { body: JSON.stringify({ via: 'apim-provider' }), done: response => response.status === 200 });
  expect(result.status === 200 && JSON.parse(result.json.data).via === 'apim-provider', `HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  return created.runtime_url;
});

await scenario('S45', 'the APIM-routed call is visible as a COMPLETED CPI message log', async () => {
  expect(ctx.apimGuid, 'needs S43');
  const detail = await waitForGuid(ctx.apimGuid);
  expect(detail.log.Status === 'COMPLETED', JSON.stringify(detail.log).slice(0, 300));
});

await scenario('S46', 'iFlow with Unicode description, POST receiver and static query deploys', async () => {
  ok(await call('cpi_create_iflow', {
    package_id: PKG, iflow_id: IFLOW_POST, name: ASCII_NAME, description: UNICODE_DESCRIPTION,
    template: 'https-request-reply-http',
    template_parameters: { sender_path: `/ai/post${RUN}`, receiver_address: 'https://httpbin.org/anything/post', receiver_query: 'static=1&mode=test', receiver_method: 'POST', receiver_proxy_type: 'internet', receiver_authentication: 'None', receiver_timeout_ms: 20000 },
    confirmation: `CREATE IFLOW ${IFLOW_POST}`
  }), 'create');
  const listed = ok(await call('cpi_list_iflows', { package_id: PKG }), 'list').find(entry => entry.Id === IFLOW_POST);
  expect(listed?.Name === ASCII_NAME, `name read back ${listed?.Name}`);
  expect(listed?.Description === UNICODE_DESCRIPTION, `description read back ${listed?.Description}`);
  const { runtime } = await deployAndWait(IFLOW_POST);
  expect(runtime.Status === 'STARTED', JSON.stringify(runtime));
  const endpoints = ok(await call('cpi_list_service_endpoints', { iflow_id: IFLOW_POST }), 'endpoints');
  ctx.postEndpoint = endpoints.flatMap(entry => entry.urls)[0] ?? ctx.cpiEndpoint.replace(`/http/ai/smoke${RUN}`, `/http/ai/post${RUN}`);
  return `description "${listed.Description}"`;
});

await scenario('S47', 'POST receiver gets method, static query and body', async () => {
  const result = await invoke(ctx.postEndpoint, { body: JSON.stringify({ order: 42 }), done: response => response.status === 200 });
  expect(result.status === 200, `HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  expect(result.json.method === 'POST', `method ${result.json.method}`);
  expect(result.json.args.static === '1' && result.json.args.mode === 'test', JSON.stringify(result.json.args));
  expect(JSON.parse(result.json.data).order === 42, result.json.data);
});

await scenario('S48', 'configuration change (method + query) takes effect after redeploy', async () => {
  ok(await call('cpi_update_iflow_configuration', { iflow_id: IFLOW_POST, parameters: [{ key: 'Receiver_Method', value: 'PUT' }, { key: 'Receiver_Query', value: 'static=2' }], confirmation: `CONFIGURE IFLOW ${IFLOW_POST}` }), 'configure');
  const { runtime } = await deployAndWait(IFLOW_POST);
  expect(runtime.Status === 'STARTED', JSON.stringify(runtime));
  const result = await invoke(ctx.postEndpoint, { body: '{}', done: response => response.status === 200 && response.json?.method === 'PUT' });
  expect(result.json?.method === 'PUT' && result.json.args.static === '2', `method ${result.json?.method} args ${JSON.stringify(result.json?.args)}`);
});

await scenario('S49', 'special-character parameter survives the bundle round trip; config edits are preserved', async () => {
  const updated = ok(await call('cpi_update_iflow', {
    iflow_id: IFLOW_POST, expected_version: '1.0.0',
    files: [{ path: 'src/main/resources/script/marker.groovy', content: '// marker\n' }],
    parameters: { 'Special Key': SPECIAL_VALUE },
    confirmation: `UPDATE IFLOW ${IFLOW_POST}`
  }), 'update');
  expect(updated.new_version === '1.0.1', JSON.stringify(updated));
  const config = Object.fromEntries(ok(await call('cpi_get_iflow', { iflow_id: IFLOW_POST }), 'get').configurations.map(entry => [entry.ParameterKey, entry.ParameterValue]));
  expect(config['Special Key'] === SPECIAL_VALUE, `read back ${JSON.stringify(config['Special Key'])}`);
  expect(config.Receiver_Method === 'PUT' && config.Receiver_Query === 'static=2', `config edits lost: ${config.Receiver_Method} ${config.Receiver_Query}`);
});

await scenario('S50', 'large script (57 KiB): truncated in the listing, complete via file_path', async () => {
  ok(await call('cpi_update_iflow', { iflow_id: IFLOW_POST, expected_version: '1.0.1', files: [{ path: 'src/main/resources/script/large.groovy', content: LARGE_SCRIPT }], confirmation: `UPDATE IFLOW ${IFLOW_POST}` }), 'update');
  const listing = ok(await call('cpi_get_iflow', { iflow_id: IFLOW_POST }), 'get');
  const entry = listing.files.find(file => file.path === 'src/main/resources/script/large.groovy');
  expect(entry?.truncated === true && entry.bytes === LARGE_SCRIPT.length, JSON.stringify({ truncated: entry?.truncated, bytes: entry?.bytes }));
  const single = ok(await call('cpi_get_iflow', { iflow_id: IFLOW_POST, file_path: 'src/main/resources/script/large.groovy' }), 'file');
  expect(single.file.text === LARGE_SCRIPT && !single.file.truncated, `file_path length ${single.file.text?.length}`);
  return `${LARGE_SCRIPT.length} bytes`;
});

await scenario('S51', 'rename through cpi_update_iflow keeps version chain consistent', async () => {
  const renamed = ok(await call('cpi_update_iflow', { iflow_id: IFLOW_POST, expected_version: '1.0.2', name: `${ASCII_NAME} v2`, files: [{ path: 'src/main/resources/script/marker.groovy', content: '// marker v2\n' }], confirmation: `UPDATE IFLOW ${IFLOW_POST}` }), 'update');
  expect(renamed.new_version === '1.0.3', JSON.stringify(renamed));
  const listed = ok(await call('cpi_list_iflows', { package_id: PKG }), 'list').find(entry => entry.Id === IFLOW_POST);
  expect(listed.Name === `${ASCII_NAME} v2` && listed.Version === '1.0.3', JSON.stringify(listed));
});

await scenario('S52', 'redeploy after three bundle updates runs 1.0.3 with preserved config', async () => {
  const { runtime } = await deployAndWait(IFLOW_POST);
  expect(runtime.Status === 'STARTED' && runtime.Version === '1.0.3', JSON.stringify(runtime));
  const result = await invoke(ctx.postEndpoint, { body: '{"after":"updates"}', done: response => response.status === 200 });
  expect(result.json?.method === 'PUT' && result.json.args.static === '2', `method ${result.json?.method}`);
});

await scenario('S53', 'message log filters: COMPLETED for the POST iFlow, top=1, past window empty', async () => {
  // Message logs are indexed asynchronously; the call made in S52 can take a while to appear.
  let completed;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    completed = ok(await call('cpi_list_message_logs', { iflow_id: IFLOW_POST, status: 'COMPLETED', top: 50 }), 'completed');
    if (completed.logs.length >= 3) break;
    await sleep(5000);
  }
  expect(completed.logs.length >= 3 && completed.logs.every(log => log.Status === 'COMPLETED'), `${completed.logs.length} logs`);
  const one = ok(await call('cpi_list_message_logs', { iflow_id: IFLOW_POST, top: 1 }), 'top1');
  expect(one.returned === 1 && one.total >= completed.logs.length, JSON.stringify({ returned: one.returned, total: one.total }));
  const past = ok(await call('cpi_list_message_logs', { iflow_id: IFLOW_POST, to: '2020-01-01T00:00:00Z' }), 'past');
  expect(past.logs.length === 0, 'past window must be empty');
  const ordered = completed.logs.map(log => log.LogEnd);
  expect(ordered.every((value, index) => index === 0 || ordered[index - 1] >= value), 'logs must be newest first');
  return `total=${one.total}`;
});

await scenario('S54', 'receiver HTTP 503 → caller error and FAILED log with the receiver status', async () => {
  ok(await call('cpi_update_iflow_configuration', { iflow_id: IFLOW, parameters: [{ key: 'Receiver_Address', value: 'https://httpbin.org/status/503' }], confirmation: `CONFIGURE IFLOW ${IFLOW}` }), 'configure');
  const { runtime } = await deployAndWait(IFLOW);
  expect(runtime.Status === 'STARTED', JSON.stringify(runtime));
  const result = await invoke(ctx.cpiEndpoint, { body: '{}', done: response => response.status >= 500 && response.status !== 503 });
  expect(result.status === 500, `caller got HTTP ${result.status}`);
  const failed = await waitForLog(IFLOW, 'FAILED');
  const detail = ok(await call('cpi_get_message_log', { message_guid: failed.logs[0].MessageGuid }), 'detail');
  expect(/503/.test(detail.error_information || ''), `error ${detail.error_information}`);
  return detail.error_information.replace(/\s+/g, ' ').slice(0, 120);
});

await scenario('S55', 'missing security material → FAILED log names the credential', async () => {
  ok(await call('cpi_create_iflow', {
    package_id: PKG, iflow_id: IFLOW_CRED, name: `AI Cred ${RUN}`, template: 'https-request-reply-http',
    template_parameters: { sender_path: `/ai/cred${RUN}`, receiver_address: 'https://httpbin.org/basic-auth/u/p', receiver_proxy_type: 'internet', receiver_authentication: 'Basic', receiver_credential_name: 'ZAI_MISSING_CRED' },
    confirmation: `CREATE IFLOW ${IFLOW_CRED}`
  }), 'create');
  const { runtime } = await deployAndWait(IFLOW_CRED);
  if (runtime.Status === 'ERROR') {
    expect(/ZAI_MISSING_CRED|credential/i.test(runtime.error_information || ''), `runtime error ${runtime.error_information}`);
    return `runtime ERROR: ${runtime.error_information.slice(0, 120)}`;
  }
  const endpoint = ctx.cpiEndpoint.replace(`/http/ai/smoke${RUN}`, `/http/ai/cred${RUN}`);
  const result = await invoke(endpoint, { body: '{}', done: response => response.status !== 404 && response.status !== 503 });
  expect(result.status >= 500, `caller got HTTP ${result.status}`);
  const failed = await waitForLog(IFLOW_CRED, 'FAILED');
  const detail = ok(await call('cpi_get_message_log', { message_guid: failed.logs[0].MessageGuid }), 'detail');
  expect(/ZAI_MISSING_CRED|credential/i.test(detail.error_information || ''), `error ${detail.error_information}`);
  return detail.error_information.replace(/\s+/g, ' ').slice(0, 120);
});

await scenario('S56', 'broken custom BPMN (dangling sequence flow) → deploy reports build FAIL with the exact cause', async () => {
  const broken = template.replace(/<bpmn2:endEvent id="EndEvent_2"[\s\S]*?<\/bpmn2:endEvent>/, '');
  expect(broken !== template, 'broken BPMN unchanged');
  const parameters = { ...timerParameters('https://httpbin.org/anything'), Sender_Path: `/ai/broken${RUN}` };
  delete parameters.Timer_Schedule;
  ok(await call('cpi_create_iflow', { package_id: PKG, iflow_id: IFLOW_BROKEN, name: `AI Broken ${RUN}`, template: 'custom', iflw_xml: broken, parameters, confirmation: `CREATE IFLOW ${IFLOW_BROKEN}` }), 'create');
  const deployed = ok(await call('cpi_deploy_iflow', { iflow_id: IFLOW_BROKEN, wait_seconds: 50, confirmation: `DEPLOY IFLOW ${IFLOW_BROKEN}` }), 'deploy');
  expect(deployed.build_status === 'FAIL' && deployed.runtime_status === 'ERROR', JSON.stringify(deployed).slice(0, 400));
  expect(/does not have an outgoing sequence flow/.test(deployed.error_information || ''), `error ${deployed.error_information}`);
  expect(!deployed.error_information.trim().startsWith('{'), 'error information must be readable text, not raw JSON');
  return deployed.error_information.split('\n').at(-1);
});

await scenario('S57', 'cpi_get_iflow_runtime_status on the broken iFlow is consistent with the deploy result', async () => {
  const status = ok(await call('cpi_get_iflow_runtime_status', { iflow_id: IFLOW_BROKEN }), 'status');
  if (status.deployed) {
    expect(status.Status !== 'STARTED', `broken iFlow STARTED: ${JSON.stringify(status)}`);
    if (status.Status === 'ERROR') expect(status.error_information, 'ERROR without error_information');
  }
  return status.deployed ? `${status.Status}` : 'not deployed';
});

await scenario('S58', 'APIM proxy passes method, query and body through (PATCH)', async () => {
  const result = await invoke(`${ctx.proxyUrl}/items/7?filter=a%20b&n=2`, { method: 'PATCH', auth: false, body: '{"patch":true}', done: response => response.status === 200 });
  expect(result.json.method === 'PATCH', `method ${result.json.method}`);
  expect(result.json.args.filter === 'a b' && result.json.args.n === '2', JSON.stringify(result.json.args));
  expect(JSON.parse(result.json.data).patch === true && /\/items\/7/.test(result.json.url), result.json.url);
});

await scenario('S59', 'APIM proxy forwards the client Authorization header to the backend', async () => {
  const result = await invoke(`${ctx.proxyUrl}/auth`, { method: 'GET', auth: false, headers: { authorization: 'Bearer backend-token-123' }, done: response => response.status === 200 });
  expect(result.json.headers.Authorization === 'Bearer backend-token-123', `headers ${JSON.stringify(result.json.headers).slice(0, 300)}`);
});

await scenario('S60', 'apim_update_api_proxy switches a provider target to a fixed URL', async () => {
  ok(await call('apim_update_api_proxy', { name: PROXY, base_path: `/ai/smoke${RUN}`, service_type: 'rest', target: { url: 'https://httpbin.org/anything/switched' }, confirmation: `UPDATE API PROXY ${PROXY}` }), 'update');
  const result = await invoke(`${ctx.proxyUrl}/x`, { method: 'GET', auth: false, done: response => response.status === 200 && /switched/.test(response.json?.url || '') });
  expect(/\/anything\/switched\/x/.test(result.json?.url || ''), `upstream ${result.json?.url}`);
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY }), 'get');
  expect(/switched/.test(JSON.stringify(proxy.targetEndPoints)), JSON.stringify(proxy.targetEndPoints).slice(0, 300));
});

await scenario('S61', 'apim_update_api_proxy moves a proxy to a new base path', async () => {
  const moved = ok(await call('apim_update_api_proxy', { name: PROXY_URL, base_path: `/ai/urlmoved${RUN}`, service_type: 'rest', target: { url: 'https://httpbin.org/anything/url-target' }, confirmation: `UPDATE API PROXY ${PROXY_URL}` }), 'update');
  expect(moved.runtime_url.endsWith(`/ai/urlmoved${RUN}`), moved.runtime_url);
  const result = await invoke(moved.runtime_url, { method: 'GET', auth: false, done: response => response.status === 200 });
  expect(result.status === 200 && /url-target/.test(result.json.url), `HTTP ${result.status}`);
  return moved.runtime_url;
});

await scenario('S62', 'apim_get_api_proxy runtime_url uses the default virtual host and base path', async () => {
  const hosts = ok(await call('apim_list_virtual_hosts'), 'hosts');
  const host = hosts.find(entry => entry.isDefault);
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY_CPI_PROVIDER }), 'get');
  expect(proxy.runtime_url === `https://${host.virtual_host}/ai/cpiprov${RUN}`, `${proxy.runtime_url} vs ${host.virtual_host}`);
});

await scenario('S63', 'apim_list_api_proxies honours top', async () => {
  const one = ok(await call('apim_list_api_proxies', { top: 1 }), 'list');
  expect(one.length === 1, `${one.length} proxies`);
});

await scenario('S64', 'XML-special title/description are escaped in the bundle and read back exactly', async () => {
  const title = `R&D <Smoke> "q" 'a' ${RUN}`;
  ok(await call('apim_create_api_proxy', { name: PROXY_XML, title, description: 'a < b && c > d', base_path: `/ai/xml${RUN}`, service_type: 'rest', target: { url: 'https://httpbin.org/anything/xml' }, confirmation: `CREATE API PROXY ${PROXY_XML}` }), 'create');
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY_XML }), 'get');
  expect(proxy.title === title, `title ${proxy.title}`);
  // APIM stores descriptions as HTML and escapes markup characters (documented on the tool input).
  expect(proxy.description === 'a &lt; b &amp;&amp; c &gt; d', `description ${proxy.description}`);
});

await scenario('S65', 'proxy names with hyphens work end to end', async () => {
  const created = ok(await call('apim_create_api_proxy', { name: PROXY_DASH, base_path: `/ai/dash${RUN}`, service_type: 'rest', target: { url: 'https://httpbin.org/anything/dash' }, confirmation: `CREATE API PROXY ${PROXY_DASH}` }), 'create');
  const result = await invoke(created.runtime_url, { method: 'GET', auth: false, done: response => response.status === 200 });
  expect(result.status === 200 && /dash/.test(result.json.url), `HTTP ${result.status}`);
});

await scenario('S66', 'duplicate API provider surfaces the APIM error text', async () => {
  const result = await call('apim_create_api_provider', { name: PROVIDER, type: 'internet', host: 'httpbin.org', port: 443, confirmation: `CREATE API PROVIDER ${PROVIDER}` });
  return cleanError(result, /^APIM POST \/apiportal\/api\/1\.0\/Management\.svc\/APIProviders failed \(HTTP \d+\)/);
});

await scenario('S67', 'API provider input validation rejects bad combinations', async () => {
  const cases = [
    { name: 'ZAIBAD1', type: 'internet', host: 'httpbin.org', port: 443, location_id: 'X' },
    { name: 'ZAIBAD2', type: 'internet', host: 'bad host', port: 443 },
    { name: 'ZAIBAD3', type: 'internet', host: 'httpbin.org', port: 0 },
    { name: 'ZAIBAD4', type: 'on_premise', host: 's4h', port: 443, sap_client: '1000' },
    { name: '9starts-with-digit', type: 'internet', host: 'httpbin.org', port: 443 }
  ];
  for (const args of cases) {
    const result = await call('apim_create_api_provider', { ...args, confirmation: `CREATE API PROVIDER ${args.name}` });
    expect(result.isError, `accepted ${JSON.stringify(args)}`);
  }
  const providers = ok(await call('apim_list_api_providers', { top: 200 }), 'list');
  expect(!providers.some(entry => /^ZAIBAD/.test(entry.name)), 'invalid provider was created');
});

await scenario('S68', 'API proxy input validation rejects unsafe paths and targets', async () => {
  const base = { name: 'ZAI_Bad', service_type: 'rest', confirmation: 'CREATE API PROXY ZAI_Bad' };
  const cases = [
    { ...base, base_path: '/a//b', target: { url: 'https://httpbin.org/get' } },
    { ...base, base_path: '/a/', target: { url: 'https://httpbin.org/get' } },
    { ...base, base_path: '/a/../b', target: { url: 'https://httpbin.org/get' } },
    { ...base, base_path: '/ok', target: { url: 'http://httpbin.org/get' } },
    { ...base, base_path: '/ok', target: { provider: PROVIDER, relative_path: '/x?y=1' } },
    { ...base, base_path: '/ok', target: { provider: PROVIDER, relative_path: '/x', url: 'https://a.b' } }
  ];
  for (const args of cases) expect((await call('apim_create_api_proxy', args)).isError, `accepted ${JSON.stringify(args)}`);
});

await scenario('S69', 'iFlow input validation rejects bad ids, paths, timeouts and enum values', async () => {
  const base = { package_id: PKG, name: 'bad', template: 'https-request-reply-http' };
  const parameters = { sender_path: '/ok', receiver_address: 'https://httpbin.org/anything', receiver_proxy_type: 'internet', receiver_authentication: 'None' };
  const cases = [
    { ...base, iflow_id: '1bad', template_parameters: parameters },
    { ...base, iflow_id: 'Z_bad', template_parameters: { ...parameters, sender_path: 'noslash' } },
    { ...base, iflow_id: 'Z_bad', template_parameters: { ...parameters, receiver_timeout_ms: 10 } },
    { ...base, iflow_id: 'Z_bad', template_parameters: { ...parameters, receiver_authentication: 'Kerberos' } },
    { ...base, iflow_id: 'Z_bad', template_parameters: { ...parameters, receiver_address: 'ftp://x' } },
    { ...base, iflow_id: 'Z_bad', template: 'custom' },
    { ...base, iflow_id: 'Z_bad', name: 'Café Flow', template_parameters: parameters },
    { ...base, iflow_id: 'Z_bad', name: 'Trailing.', template_parameters: parameters }
  ];
  for (const args of cases) expect((await call('cpi_create_iflow', { ...args, confirmation: `CREATE IFLOW ${args.iflow_id}` })).isError, `accepted ${JSON.stringify(args)}`);
});

await scenario('S70', 'cpi_create_iflow into a missing package surfaces the CPI error', async () => {
  const result = await call('cpi_create_iflow', { package_id: 'ZAI_NO_SUCH_PKG', iflow_id: `Z_AI_Orphan_${RUN}`, name: 'orphan', template: 'https-request-reply-http', template_parameters: { sender_path: `/ai/orphan${RUN}`, receiver_address: 'https://httpbin.org/anything', receiver_proxy_type: 'internet', receiver_authentication: 'None' }, confirmation: `CREATE IFLOW Z_AI_Orphan_${RUN}` });
  return cleanError(result, /^CPI POST \/api\/v1\/IntegrationDesigntimeArtifacts failed \(HTTP \d+\)/);
});

await scenario('S71', 'reads of missing objects return clean, specific errors', async () => {
  const notes = [];
  notes.push(cleanError(await call('cpi_get_iflow', { iflow_id: 'Z_AI_No_Such_Flow' }), /^CPI GET /));
  notes.push(cleanError(await call('cpi_list_iflows', { package_id: 'ZAI_NO_SUCH_PKG' }), /^CPI GET /));
  notes.push(cleanError(await call('apim_get_api_proxy', { name: 'ZAI_No_Such_Proxy' }), /does not exist/));
  return notes[0];
});

await scenario('S72', 'message log lookups: malformed GUID rejected, unknown GUID is a clean error', async () => {
  expect((await call('cpi_get_message_log', { message_guid: 'bad guid!' })).isError, 'malformed GUID accepted');
  return cleanError(await call('cpi_get_message_log', { message_guid: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), /^CPI GET /);
});

await scenario('S73', 'deploy and configure of a missing iFlow fail cleanly', async () => {
  cleanError(await call('cpi_deploy_iflow', { iflow_id: 'Z_AI_No_Such_Flow', wait_seconds: 5, confirmation: 'DEPLOY IFLOW Z_AI_No_Such_Flow' }), /^CPI /);
  const configured = ok(await call('cpi_update_iflow_configuration', { iflow_id: 'Z_AI_No_Such_Flow', parameters: [{ key: 'A', value: 'b' }], confirmation: 'CONFIGURE IFLOW Z_AI_No_Such_Flow' }), 'configure');
  expect(configured.updated.length === 0 && /^CPI PUT/.test(configured.failed?.error || ''), JSON.stringify(configured));
});

await scenario('S74', 'update with a missing iFlow fails without writing', async () => {
  return cleanError(await call('cpi_update_iflow', { iflow_id: 'Z_AI_No_Such_Flow', expected_version: '1.0.0', files: [{ path: 'src/main/resources/script/a.groovy', content: 'x' }], confirmation: 'UPDATE IFLOW Z_AI_No_Such_Flow' }), /^CPI GET /);
});

await scenario('S75', 'parallel mixed CPI/APIM reads succeed (shared token caches)', async () => {
  const calls = await Promise.all([
    call('cpi_list_packages', { top: 50 }),
    call('cpi_list_iflows', { package_id: PKG }),
    call('cpi_list_message_logs', { top: 5 }),
    call('apim_list_api_proxies', { top: 50 }),
    call('apim_list_api_providers', { top: 50 }),
    call('apim_list_virtual_hosts'),
    call('cpi_get_iflow_runtime_status', { iflow_id: IFLOW_POST }),
    call('apim_get_api_proxy', { name: PROXY_CPI })
  ]);
  const failures = calls.filter(result => result.isError).map(result => result.text);
  expect(!failures.length, failures.join(' | '));
  return `${calls.length} concurrent calls`;
});

await scenario('S76', 'CPI-runtime API provider read back has no secrets and Internet type', async () => {
  const provider = ok(await call('apim_get_api_provider', { name: PROVIDER_CPI }), 'get');
  expect(provider.isOnPremise === false && provider.destType === 'Internet', JSON.stringify(provider).slice(0, 300));
  expect(!/"(?:password|clientSecret|userName|clientId)"/.test(JSON.stringify(provider)), 'credential keys present');
});

await scenario('S77', 'service endpoints without a filter include every HTTPS iFlow of this run', async () => {
  const endpoints = ok(await call('cpi_list_service_endpoints'), 'endpoints');
  const urls = endpoints.flatMap(entry => entry.urls);
  for (const suffix of [`/http/ai/smoke${RUN}`, `/http/ai/post${RUN}`]) expect(urls.some(url => url.endsWith(suffix)), `missing ${suffix}`);
  return `${endpoints.length} endpoints`;
});

await scenario('S78', 'restore the template iFlow (config + redeploy) and verify recovery', async () => {
  ok(await call('cpi_update_iflow_configuration', { iflow_id: IFLOW, parameters: [{ key: 'Receiver_Address', value: 'https://httpbin.org/anything/restored' }], confirmation: `CONFIGURE IFLOW ${IFLOW}` }), 'configure');
  const { runtime } = await deployAndWait(IFLOW);
  expect(runtime.Status === 'STARTED', JSON.stringify(runtime));
  const result = await invoke(ctx.cpiEndpoint, { body: '{}', done: response => response.status === 200 && /restored/.test(response.json?.url || '') });
  expect(result.status === 200 && /restored/.test(result.json.url), `HTTP ${result.status} ${result.json?.url}`);
});

await scenario('S79', 'full chain after recovery: client → APIM (provider) → CPI → backend', async () => {
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY_CPI_PROVIDER }), 'get');
  const result = await invoke(proxy.runtime_url, { body: '{"final":true}', done: response => response.status === 200 && /restored/.test(response.json?.url || '') });
  expect(result.status === 200 && JSON.parse(result.json.data).final === true, `HTTP ${result.status}`);
  const detail = await waitForGuid(result.json.headers['Sap-Messageprocessinglogid']);
  expect(detail.log.Status === 'COMPLETED', detail.log.Status);
});

// ============================================================ extended coverage (runs after the original chain)
await scenario('S81', 'odata_get readers list entity sets from both $metadata documents', async () => {
  const cpiMeta = ok(await call('cpi_odata_get', { path: '/$metadata' }), 'cpi metadata');
  const apimMeta = ok(await call('apim_odata_get', { path: '/$metadata' }), 'apim metadata');
  expect(cpiMeta.entity_sets.some(set => set.name === 'IntegrationRuntimeArtifacts'), 'CPI metadata misses IntegrationRuntimeArtifacts');
  expect(apimMeta.entity_sets.some(set => set.name === 'APIProxies'), 'APIM metadata misses APIProxies');
  const apimSets = new Set(apimMeta.entity_sets.map(set => set.name));
  return `CPI ${cpiMeta.entity_sets.length} sets; APIM ${apimSets.size} sets (KeyMapEntryValues ${apimSets.has('KeyMapEntryValues')}, Applications ${apimSets.has('Applications')})`;
});

await scenario('S82', 'cpi_list_runtime_artifacts and cpi_list_package_artifacts show this run', async () => {
  const runtime = ok(await call('cpi_list_runtime_artifacts', { top: 200 }), 'runtime');
  const artifacts = runtime.artifacts ?? runtime;
  expect(JSON.stringify(artifacts).includes(IFLOW), `${IFLOW} not deployed in runtime list`);
  const contents = ok(await call('cpi_list_package_artifacts', { package_id: PKG }), 'package');
  expect(JSON.stringify(contents).includes(IFLOW), 'package contents miss the iFlow');
});

await scenario('S83', 'cpi_get_message_log_steps returns the steps of a runtime call', async () => {
  expect(ctx.directGuid, 'needs S41');
  const steps = ok(await call('cpi_get_message_log_steps', { message_guid: ctx.directGuid }), 'steps');
  expect(JSON.stringify(steps).length > 50, JSON.stringify(steps));
  return JSON.stringify(steps).slice(0, 160);
});

await scenario('S84', 'monitoring reads: JMS broker, data stores, variables', async () => {
  const notes = [];
  for (const name of ['cpi_get_jms_broker_status', 'cpi_list_data_stores', 'cpi_list_variables']) {
    const result = await call(name);
    if (result.isError) cleanError(result);
    notes.push(`${name}: ${result.isError ? result.text.slice(0, 80) : 'ok'}`);
  }
  return notes.join('; ');
});

await scenario('S85', 'cpi_set_user_credential creates then updates; password never returned', async () => {
  const created = ok(await call('cpi_set_user_credential', { name: CREDENTIAL, user: 'smoke', password: RUN_SECRETS.credential, description: 'AI smoke', confirmation: `SET USER CREDENTIAL ${CREDENTIAL}` }), 'create');
  expect(created.created === true, JSON.stringify(created));
  const updated = ok(await call('cpi_set_user_credential', { name: CREDENTIAL, user: 'smoke2', password: RUN_SECRETS.credential, confirmation: `SET USER CREDENTIAL ${CREDENTIAL}` }), 'update');
  expect(updated.updated === true, JSON.stringify(updated));
  let listed;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    listed = ok(await call('cpi_list_security_material', { kind: 'user_credentials' }), 'list');
    if (JSON.stringify(listed).includes(CREDENTIAL)) break;
    await sleep(5000);
  }
  expect(JSON.stringify(listed).includes(CREDENTIAL), 'credential not listed');
});

await scenario('S86', 'cpi_set_number_range creates a range and reads it back', async () => {
  ok(await call('cpi_set_number_range', { name: NUMBER_RANGE, description: 'AI smoke', min_value: '1', max_value: '9999', rotate: true, field_length: 4, confirmation: `SET NUMBER RANGE ${NUMBER_RANGE}` }), 'set');
  const ranges = ok(await call('cpi_list_number_ranges'), 'list');
  expect(JSON.stringify(ranges).includes(NUMBER_RANGE), 'range not listed');
});

await scenario('S87', 'cpi_set_partner_parameter creates and updates a string parameter', async () => {
  ok(await call('cpi_set_partner_parameter', { pid: PARTNER, id: 'ReceiverAddress', type: 'string', value: 'https://a.example', confirmation: `SET PARTNER PARAMETER ${PARTNER}/ReceiverAddress` }), 'create');
  ok(await call('cpi_set_partner_parameter', { pid: PARTNER, id: 'ReceiverAddress', type: 'string', value: 'https://b.example', confirmation: `SET PARTNER PARAMETER ${PARTNER}/ReceiverAddress` }), 'update');
  const listed = ok(await call('cpi_list_partner_parameters', { pid: PARTNER }), 'list');
  expect(JSON.stringify(listed).includes('https://b.example'), JSON.stringify(listed).slice(0, 300));
});

await scenario('S88', 'apim_create_key_value_map (encrypted) and set entries; values never returned', async () => {
  ok(await call('apim_create_key_value_map', { name: KVM, entries: [{ name: 'user', value: 'smoke' }, { name: 'password', value: RUN_SECRETS.kvm }], confirmation: `CREATE KEY VALUE MAP ${KVM}` }), 'create');
  const updated = ok(await call('apim_set_key_value_map_entries', { name: KVM, entries: [{ name: 'password', value: RUN_SECRETS.kvm }, { name: 'extra', value: 'x' }], confirmation: `UPDATE KEY VALUE MAP ${KVM}` }), 'set');
  expect(!updated.failed, JSON.stringify(updated));
  const map = ok(await call('apim_get_key_value_map', { name: KVM }), 'get');
  expect(map.entries.length === 3 && map.entries.every(entry => entry.value === '[redacted]'), JSON.stringify(map));
});

await scenario('S89', 'apim_attach_api_proxy_policies: header + spike arrest reach the backend', async () => {
  const attached = ok(await call('apim_attach_api_proxy_policies', {
    name: PROXY,
    policies: [
      { name: 'smokeSpike', template: 'spike_arrest', params: { rate: '100ps' } },
      { name: 'smokeHeader', template: 'assign_headers', endpoint: 'target', params: { message: 'request', set: { 'X-AI-Smoke': RUN } } }
    ],
    confirmation: `UPDATE API PROXY POLICIES ${PROXY}`
  }), 'attach');
  const url = attached.runtime_url ?? ok(await call('apim_get_api_proxy', { name: PROXY }), 'get').runtime_url;
  let echoed;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await http(`${url}/policy`);
    if (response.status === 200) {
      echoed = JSON.parse(response.text);
      if (echoed.headers?.['X-Ai-Smoke'] === RUN) break;
    }
    await sleep(5000);
  }
  expect(echoed?.headers?.['X-Ai-Smoke'] === RUN, `backend headers ${JSON.stringify(echoed?.headers)}`);
});

await scenario('S90', 'apim_export_api_proxy shows the attached policies; update keeps them', async () => {
  const exported = ok(await call('apim_export_api_proxy', { name: PROXY }), 'export');
  const paths = exported.files.map(file => file.path);
  expect(paths.some(path => /Policy\/smokeSpike\.xml$/.test(path)), paths.join(','));
  const proxy = ok(await call('apim_get_api_proxy', { name: PROXY }), 'get');
  const basePath = proxy.proxyEndPoints?.[0]?.base_path ?? `/ai/smoke${RUN}`;
  const updated = ok(await call('apim_update_api_proxy', { name: PROXY, base_path: basePath, service_type: 'rest', target: { provider: PROVIDER, relative_path: '/anything/v3' }, confirmation: `UPDATE API PROXY ${PROXY}` }), 'update');
  expect(updated.preserved_policies?.includes('smokeSpike'), JSON.stringify(updated));
});

await scenario('S91', 'verify_api_key policy rejects calls without a key', async () => {
  const attached = ok(await call('apim_attach_api_proxy_policies', { name: PROXY, policies: [{ name: 'smokeVerifyKey', template: 'verify_api_key', params: {} }], confirmation: `UPDATE API PROXY POLICIES ${PROXY}` }), 'attach');
  const url = attached.runtime_url ?? ok(await call('apim_get_api_proxy', { name: PROXY }), 'get').runtime_url;
  let status;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    status = (await http(`${url}/nokey`)).status;
    if (status === 401) break;
    await sleep(5000);
  }
  expect(status === 401, `expected 401 without apikey, got ${status}`);
});

await scenario('S92', 'apim_create_api_product over the proxy, read back, and update quota', async () => {
  const created = ok(await call('apim_create_api_product', { name: PRODUCT, title: 'AI smoke product', proxies: [PROXY], quota: { count: 100, interval: 1, time_unit: 'minute' }, confirmation: `CREATE API PRODUCT ${PRODUCT}` }), 'create');
  expect(created.created === true, JSON.stringify(created));
  const product = ok(await call('apim_get_api_product', { name: PRODUCT }), 'get');
  expect(product.api_proxies.includes(PROXY), JSON.stringify(product));
  const updated = ok(await call('apim_update_api_product', { name: PRODUCT, quota: null, confirmation: `UPDATE API PRODUCT ${PRODUCT}` }), 'update');
  expect(updated.updated === true, JSON.stringify(updated));
});

await scenario('S93', 'cpi_undeploy_artifact removes the failing timer iFlow from the runtime', async () => {
  const result = ok(await call('cpi_undeploy_artifact', { artifact_id: IFLOW_TIMER_FAIL, wait_seconds: 50, confirmation: `UNDEPLOY ARTIFACT ${IFLOW_TIMER_FAIL}` }), 'undeploy');
  let status = ok(await call('cpi_get_iflow_runtime_status', { iflow_id: IFLOW_TIMER_FAIL }), 'status');
  for (let attempt = 0; attempt < 12 && status.deployed; attempt += 1) {
    await sleep(5000);
    status = ok(await call('cpi_get_iflow_runtime_status', { iflow_id: IFLOW_TIMER_FAIL }), 'status');
  }
  expect(status.deployed === false, `still deployed: ${JSON.stringify(result)}`);
});

await scenario('S94', 'integration_connection_info verify: both sides sign in and every area is classified', async () => {
  const { verification } = ok(await call('integration_connection_info', { verify: true }), 'verify');
  expect(verification.ok, JSON.stringify(verification).slice(0, 400));
  const summary = side => side.checks.map(check => `${check.area}=${check.result}`).join(', ');
  return `CPI: ${summary(verification.cpi)} | APIM: ${summary(verification.apim)}`;
});

await scenario('S80', `after all writes: ${INTEGRATION_TOOL_NAMES.length} tools, both sides configured, no secrets emitted`, async () => {
  expect((await client.listTools()).tools.length === INTEGRATION_TOOL_NAMES.length, 'tool count changed');
  const info = ok(await call('integration_connection_info'), 'info');
  expect(info.cpi.configured && info.apim.configured, 'side lost');
  return `${results.filter(result => result.status === 'PASS').length} passed so far; every tool output scanned for ${SECRETS.length} secrets`;
});

await client.close();
await runtime.close();
const failed = results.filter(result => result.status === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
