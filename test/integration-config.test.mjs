import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTEGRATION_CONFIG_ERROR, parseIntegrationServiceKey, resolveIntegrationConfig } from '../src/integration-config.mjs';
import { readStoredIntegrationKeys, storeIntegrationKey } from '../src/integration-credentials.mjs';
import { createIntegrationClients, verifyIntegrationClients } from '../src/integration-verify.mjs';

const SECRET = 'never-print-this';

function errorOf(env) {
  try {
    resolveIntegrationConfig(env);
  } catch (error) {
    assert.equal(error.message.includes(SECRET), false, `secret leaked: ${error.message}`);
    return error.message;
  }
  assert.fail('expected resolveIntegrationConfig to throw');
}

test('resolves a nested CPI api key and a flat APIM apiportal key', () => {
  const config = resolveIntegrationConfig({
    CPI_SERVICE_KEY: JSON.stringify({ oauth: { url: 'https://tenant.it-cpi.example/', tokenurl: 'https://auth.example', clientid: 'cpi-id', clientsecret: SECRET } }),
    APIM_SERVICE_KEY: JSON.stringify({ url: 'https://apim.example', tokenUrl: 'https://auth.example/oauth/token', clientId: 'apim-id', clientSecret: SECRET })
  });
  assert.equal(config.cpi.source, 'service-key');
  assert.equal(config.cpi.url, 'https://tenant.it-cpi.example');
  assert.equal(config.cpi.tokenUrl, 'https://auth.example/oauth/token');
  assert.equal(config.cpi.clientId, 'cpi-id');
  assert.equal(config.apim.url, 'https://apim.example');
  assert.equal(config.apim.tokenUrl, 'https://auth.example/oauth/token');
  assert.equal(config.apim.clientSecret, SECRET);
});

test('explicit variables take precedence and must be complete', () => {
  assert.match(errorOf({ CPI_URL: 'https://tenant.example', CPI_CLIENT_SECRET: SECRET }), /^Explicit CPI configuration is incomplete: CPI_TOKEN_URL, CPI_CLIENT_ID$/);
  const config = resolveIntegrationConfig({
    APIM_URL: 'https://apim.example',
    APIM_TOKEN_URL: 'https://auth.example/oauth/token',
    APIM_CLIENT_ID: 'id',
    APIM_CLIENT_SECRET: SECRET,
    APIM_SERVICE_KEY: 'not json'
  });
  assert.equal(config.apim.source, 'environment');
  assert.equal(config.cpi, null);
});

test('rejects certificate keys and invalid JSON without echoing the value', () => {
  assert.match(errorOf({ CPI_SERVICE_KEY: JSON.stringify({ oauth: { url: 'https://t.example', tokenurl: 'https://a.example', clientid: 'id', certificate: SECRET, key: SECRET } }) }),
    /^CPI_SERVICE_KEY is a certificate-based key; create a ClientId\/Secret service key$/);
  assert.equal(errorOf({ APIM_SERVICE_KEY: `{"clientSecret":"${SECRET}"` }), 'APIM_SERVICE_KEY is not valid JSON');
});

test('VCAP bindings: single match resolves, duplicates need CPI_BINDING, unknown binding fails', () => {
  const instance = name => ({ name, credentials: { oauth: { url: `https://${name}.example`, tokenurl: 'https://auth.example', clientid: 'id', clientsecret: SECRET } } });
  const single = resolveIntegrationConfig({ VCAP_SERVICES: JSON.stringify({ 'it-rt': [instance('one')] }) });
  assert.equal(single.cpi.source, 'vcap-services');
  assert.equal(single.cpi.bindingName, 'one');
  const two = JSON.stringify({ 'it-rt': [instance('one'), instance('two')] });
  assert.equal(errorOf({ VCAP_SERVICES: two }), 'Multiple CPI VCAP_SERVICES bindings; set CPI_BINDING');
  assert.equal(resolveIntegrationConfig({ VCAP_SERVICES: two, CPI_BINDING: 'two' }).cpi.url, 'https://two.example');
  assert.equal(errorOf({ VCAP_SERVICES: two, CPI_BINDING: 'three' }), 'No CPI VCAP_SERVICES binding matches CPI_BINDING');
  const custom = resolveIntegrationConfig({ VCAP_SERVICES: JSON.stringify({ apim: [instance('apim')] }), APIM_VCAP_SERVICE: 'apim' });
  assert.equal(custom.apim.url, 'https://apim.example');
});

test('requires https except on loopback hosts', () => {
  const key = url => JSON.stringify({ oauth: { url, tokenurl: `${url}/oauth/token`, clientid: 'id', clientsecret: SECRET } });
  assert.match(errorOf({ CPI_SERVICE_KEY: key('http://example.com') }), /^CPI_URL must use https$/);
  assert.match(errorOf({ CPI_SERVICE_KEY: key('https://user:pw@example.com') }), /^CPI_URL must not contain credentials/);
  assert.equal(resolveIntegrationConfig({ CPI_SERVICE_KEY: key('http://127.0.0.1:4321') }).cpi.url, 'http://127.0.0.1:4321');
});

test('fails with setup guidance when nothing is configured', () => {
  assert.match(errorOf({}), /^Configure CPI \(CPI_SERVICE_KEY or CPI_URL\/CPI_TOKEN_URL\/CPI_CLIENT_ID\/CPI_CLIENT_SECRET\), APIM/);
  assert.match(errorOf({ VCAP_SERVICES: JSON.stringify({ other: [] }) }), /^Configure CPI/);
});

const devhubKey = (host = 'devhub.example') => ({ url: `https://${host}`, tokenUrl: 'https://auth.example/oauth/token', clientId: 'devhub-id', clientSecret: SECRET });

test('DEVHUB-only config and all three sides accept the documented flat service key', () => {
  const env = { DEVHUB_SERVICE_KEY: JSON.stringify(devhubKey()) };
  const only = resolveIntegrationConfig(env);
  assert.equal(only.cpi, null);
  assert.equal(only.apim, null);
  assert.equal(only.devhub.url, 'https://devhub.example');
  assert.equal(only.devhub.source, 'service-key');
  const all = resolveIntegrationConfig({ ...env, CPI_SERVICE_KEY: JSON.stringify(devhubKey('cpi.example')), APIM_SERVICE_KEY: JSON.stringify(devhubKey('apim.example')) });
  assert.ok(all.cpi && all.apim && all.devhub);
});

test('DEVHUB uses explicit, service key, VCAP, then stored precedence and binding selectors', () => {
  const stored = { devhub: devhubKey('stored.example') };
  const bindings = { 'apimanagement-devportal': [{ name: 'hub', credentials: devhubKey('binding.example') }] };
  const vcap = { VCAP_SERVICES: JSON.stringify(bindings) };
  assert.equal(resolveIntegrationConfig({}, { stored }).devhub.source, 'stored-key');
  assert.equal(resolveIntegrationConfig(vcap, { stored }).devhub.bindingName, 'hub');
  const service = { ...vcap, DEVHUB_SERVICE_KEY: JSON.stringify(devhubKey('key.example')) };
  assert.equal(resolveIntegrationConfig(service, { stored }).devhub.url, 'https://key.example');
  const explicit = { ...service, DEVHUB_URL: 'https://explicit.example', DEVHUB_TOKEN_URL: 'https://auth.example', DEVHUB_CLIENT_ID: 'explicit-id', DEVHUB_CLIENT_SECRET: SECRET };
  assert.equal(resolveIntegrationConfig(explicit, { stored }).devhub.source, 'environment');
  assert.equal(resolveIntegrationConfig(explicit, { stored }).devhub.url, 'https://explicit.example');
  assert.match(errorOf({ DEVHUB_URL: 'https://hub.example', DEVHUB_CLIENT_SECRET: SECRET }), /^Explicit DEVHUB configuration is incomplete/);
  const duplicate = { VCAP_SERVICES: JSON.stringify({ 'apimanagement-devportal': [...bindings['apimanagement-devportal'], { name: 'second', credentials: devhubKey('second.example') }] }) };
  assert.match(errorOf(duplicate), /^Multiple DEVHUB/);
  assert.equal(resolveIntegrationConfig({ ...duplicate, DEVHUB_BINDING: 'second' }).devhub.url, 'https://second.example');
  assert.match(errorOf({ ...vcap, DEVHUB_BINDING: 'absent' }), /^No DEVHUB/);
  assert.match(errorOf({ DEVHUB_SERVICE_KEY: SECRET }), INTEGRATION_CONFIG_ERROR);
});

test('storing a DEVHUB key preserves both other sides and keeps user-only permissions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'integration-devhub-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: home };
  for (const side of ['CPI', 'APIM', 'DEVHUB']) await storeIntegrationKey(side, parseIntegrationServiceKey(side, devhubKey(`${side.toLowerCase()}.example`)), env);
  const path = await storeIntegrationKey('DEVHUB', parseIntegrationServiceKey('DEVHUB', devhubKey('replacement.example')), env);
  const stored = readStoredIntegrationKeys(env);
  assert.equal(stored.cpi.oauth.url, 'https://cpi.example');
  assert.equal(stored.apim.oauth.url, 'https://apim.example');
  assert.equal(stored.devhub.oauth.url, 'https://replacement.example');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('DEVHUB online verification uses the documented read and never returns its developer payload', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'private-token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify([{ userId: 'private-developer', emailId: 'private@example.com' }]), { status: 200 });
  };
  const clients = createIntegrationClients({ devhub: parseIntegrationServiceKey('DEVHUB', devhubKey()) }, { env: {}, fetchImpl });
  const report = await verifyIntegrationClients(clients);
  assert.equal(report.ok, true);
  assert.equal(report.cpi.configured, false);
  assert.equal(report.apim.configured, false);
  assert.equal(report.devhub.ok, true);
  assert.deepEqual(requests.at(-1), { url: 'https://devhub.example/api/1.0/registrations?type=registered', method: 'GET' });
  assert.doesNotMatch(JSON.stringify(report), /private-developer|private@example\.com|private-token|never-print-this/);
  const denied = await verifyIntegrationClients({ devhub: { request: async () => ({ status: 403, data: '' }) } });
  assert.equal(denied.ok, false);
  assert.equal(denied.devhub.checks[0].result, 'forbidden');
});

test('final authentication denial is not a successful sign-in and capability evidence does not infer entitlement', async () => {
  for (const [status, result, signedIn] of [[401, 'unauthenticated', false], [403, 'forbidden', true], [404, 'unavailable', true], [501, 'unavailable', true], [500, 'error', true]]) {
    const report = await verifyIntegrationClients({ devhub: { request: async () => ({ status, data: 'private-token never-print-this' }) } });
    assert.equal(report.ok, false);
    assert.equal(report.ok_scope, 'configured_core_access');
    assert.equal(report.devhub.signed_in, signedIn);
    assert.equal(report.devhub.checks[0].result, result);
    assert.equal(report.devhub.entitlement, 'unknown');
    assert.deepEqual(report.devhub.checks[0].source, {
      method: 'GET', path: '/api/1.0/registrations', status, result
    });
    assert.doesNotMatch(JSON.stringify(report), /lacks the role|not available on this tenant or plan|private-token|never-print-this/);
  }
});

test('empty core collections pass core access while object-dependent probes remain untested', async () => {
  const requests = [];
  const client = {
    request: async (method, path, options) => {
      requests.push({ method, path, options });
      return { status: 200, data: path.endsWith('/$count') ? '0' : '{"d":{"results":[]}}' };
    }
  };
  const report = await verifyIntegrationClients({ cpi: client, apim: client });
  assert.equal(report.ok, true);
  const cpi = Object.fromEntries(report.cpi.checks.map(check => [check.area, check]));
  assert.equal(cpi['MPL counts'].result, 'ok');
  assert.equal(cpi['MPL runs'].result, 'untested');
  assert.equal(cpi['Keystore validity'].result, 'untested');
  for (const area of ['Queue metadata', 'Variables', 'OAuth credential metadata']) assert.equal(cpi[area].result, 'ok');
  assert.equal(report.apim.checks.find(check => check.area === 'Policies (proxy bundle export)').result, 'untested');
  assert.equal(report.apim.checks.find(check => check.area === 'API analytics').result, 'ok');
  assert.equal(requests.some(request => request.path.includes('Transport.svc') || request.path.endsWith('/Runs')), false);
  assert.equal(requests.every(request => request.method === 'GET' && Number.isFinite(request.options.deadline)), true);
});

test('object capability probes use a discovered identity and withhold metadata values', async () => {
  const requests = [];
  const client = {
    request: async (method, path, options) => {
      requests.push({ method, path, options });
      if (path.endsWith('/$count')) return { status: 200, data: '205' };
      if (path.endsWith('/MessageProcessingLogs')) return { status: 200, data: JSON.stringify({ value: [{ MessageGuid: 'message-1', private: SECRET }] }) };
      if (path.endsWith('/KeystoreEntries')) return {
        status: 200, data: JSON.stringify({ d: { results: [{ ValidNotBefore: '/Date(1)/', ValidNotAfter: '/Date(2)/', SubjectDN: SECRET }] } })
      };
      return { status: 200, data: JSON.stringify({ d: { results: [] } }) };
    }
  };
  const report = await verifyIntegrationClients({ cpi: client });
  assert.equal(report.ok, true);
  assert.equal(report.cpi.checks.find(check => check.area === 'MPL runs').result, 'ok');
  assert.equal(report.cpi.checks.find(check => check.area === 'Keystore validity').result, 'ok');
  assert.ok(requests.some(request => request.path === "/api/v1/MessageProcessingLogs('message-1')/Runs"));
  assert.ok(requests.some(request => request.path === '/api/v1/Queues' && request.options.query === undefined));
  assert.doesNotMatch(JSON.stringify(report), /never-print-this|SubjectDN|ValidNotAfter/);
});

test('invalid count and deadline evidence are partial capability failures, not failed core access', async () => {
  const deadline = Date.now() - 1;
  const client = {
    request: async (method, path) => {
      if (path.endsWith('/$count')) return { status: 200, data: '12 junk' };
      if (path.endsWith('/Variables')) throw Object.assign(new Error(SECRET), {
        status: 503, code: 'INTEGRATION_DEADLINE', stop_reason: 'deadline', deadline
      });
      return { status: 200, data: '{"d":{"results":[]}}' };
    }
  };
  const report = await verifyIntegrationClients({ cpi: client });
  assert.equal(report.ok, true);
  const count = report.cpi.checks.find(check => check.area === 'MPL counts');
  assert.equal(count.result, 'error');
  const variables = report.cpi.checks.find(check => check.area === 'Variables');
  assert.equal(variables.result, 'error');
  assert.equal(variables.stop_reason, 'deadline');
  assert.equal(variables.source.status, 503);
  assert.equal(variables.source.deadline, deadline);
  assert.doesNotMatch(JSON.stringify(report), /never-print-this/);
});

test('final HTTP 401 after real OAuth recovery remains unauthenticated', async () => {
  let tokens = 0;
  let reads = 0;
  const clients = createIntegrationClients({ devhub: parseIntegrationServiceKey('DEVHUB', devhubKey()) }, {
    env: {},
    fetchImpl: async url => {
      if (String(url).includes('/oauth/token')) {
        tokens += 1;
        return new Response(JSON.stringify({ access_token: `private-${tokens}`, expires_in: 3600 }));
      }
      reads += 1;
      return new Response('private-token', { status: 401 });
    }
  });
  const report = await verifyIntegrationClients(clients);
  assert.equal(report.ok, false);
  assert.equal(report.devhub.signed_in, false);
  assert.equal(report.devhub.result, 'unauthenticated');
  assert.equal(tokens, 2);
  assert.equal(reads, 2);
  assert.doesNotMatch(JSON.stringify(report), /private-/);
});
