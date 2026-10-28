import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseIntegrationServiceKey, resolveIntegrationConfig } from '../src/integration-config.mjs';
import { integrationCredentialsPath, readStoredIntegrationKeys, storeIntegrationKey } from '../src/integration-credentials.mjs';
import { OPTIONAL_COMPONENT_KEYS, OPTIONAL_INPUTS, parseOptionalConfig, resolveOptionalConfig } from '../src/integration-optional-config.mjs';

const SECRET = 'private-optional-credential';
const CORE = { url: 'https://cpi.example', tokenUrl: 'https://auth.example/oauth/token', clientId: 'core-client', clientSecret: SECRET };
const RECORDS = {
  ctms: { url: 'https://ctms.example', tokenUrl: 'https://auth.example/oauth/token', clientId: 'ctms-client', clientSecret: SECRET },
  ans: { url: 'https://ans.example', username: 'technical-client', password: SECRET },
  event_mesh: { url: 'https://mesh.example', tokenUrl: 'https://auth.example/exact/token', clientId: 'mesh-client', clientSecret: SECRET, probeQueueName: 'namespace/queue' },
  aem: { apiToken: SECRET },
  aem_semp: { url: 'https://broker.example', msgVpnName: 'vpn', username: 'read-only', password: SECRET },
  open_connectors: { url: 'https://connectors.example/elements/api-v2', userSecret: SECRET, organizationSecret: `${SECRET}-org` },
  edge: { url: 'https://edge.example', clientId: 'local-client', clientSecret: SECRET }
};
const RAW_CTMS = { uri: 'https://ctms.example/', uaa: { url: 'https://auth.example', clientid: 'ctms-client', clientsecret: SECRET } };

function safeFailure(action) {
  assert.throws(action, error => {
    assert.doesNotMatch(error.message, /private-optional-credential|injected-secret/);
    return true;
  });
}

async function storeFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'integration-optional-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { XDG_CONFIG_HOME: home };
}

test('all seven optional records resolve independently with exact authentication fields', () => {
  assert.deepEqual(OPTIONAL_COMPONENT_KEYS, Object.keys(RECORDS));
  for (const [side, record] of Object.entries(RECORDS)) {
    const { variable, label } = OPTIONAL_INPUTS[side];
    assert.ok(label);
    const parsed = parseOptionalConfig(side, JSON.stringify(record), { source: 'environment' });
    assert.deepEqual(parsed, { ...record, source: 'environment' });
    assert.equal(Object.isFrozen(parsed), true);
    const config = resolveIntegrationConfig({ [variable]: JSON.stringify(record) });
    assert.equal(config.cpi, null);
    assert.equal(config.apim, null);
    assert.equal(config.devhub, null);
    assert.deepEqual(config[side], parsed);
    assert.deepEqual(config.optional_config_errors, []);
    for (const other of OPTIONAL_COMPONENT_KEYS.filter(key => key !== side)) assert.equal(config[other], null);
  }
  assert.equal(Object.hasOwn(parseOptionalConfig('aem', RECORDS.aem), 'url'), false);
  const { probeQueueName, ...mesh } = RECORDS.event_mesh;
  assert.equal(Object.hasOwn(parseOptionalConfig('event_mesh', mesh), 'probeQueueName'), false);
});

test('cTMS alone normalizes its raw service key and OAuth base; Event Mesh preserves exact token endpoints', () => {
  const environment = resolveIntegrationConfig({ CTMS_SERVICE_KEY: JSON.stringify(RAW_CTMS) });
  assert.deepEqual(environment.ctms, { ...RECORDS.ctms, source: 'environment' });
  assert.deepEqual(parseOptionalConfig('ctms', RAW_CTMS, { source: 'setup', allowRawCtms: true }), { ...RECORDS.ctms, source: 'setup' });
  for (const source of ['stored-key', 'configuration']) safeFailure(() => parseOptionalConfig('ctms', RAW_CTMS, { source }));
  safeFailure(() => parseOptionalConfig('ctms', RAW_CTMS, { source: 'stored-key', allowRawCtms: true }));
  for (const tokenUrl of ['https://auth.example/custom', 'https://auth.example/exact/token', 'https://auth.example/exact/token/']) {
    assert.equal(parseOptionalConfig('event_mesh', { ...RECORDS.event_mesh, tokenUrl }).tokenUrl, tokenUrl);
  }
  for (const tokenUrl of ['https://auth.example', 'https://auth.example/']) {
    assert.equal(parseOptionalConfig('ctms', { ...RECORDS.ctms, tokenUrl }).tokenUrl, 'https://auth.example/oauth/token');
  }
  assert.equal(parseOptionalConfig('ctms', RECORDS.ctms).tokenUrl, RECORDS.ctms.tokenUrl);
});

test('optional environment always wins, including malformed and empty values without stored fallback', () => {
  for (const [side, record] of Object.entries(RECORDS)) {
    const { variable } = OPTIONAL_INPUTS[side];
    const stored = { [side]: record };
    assert.equal(resolveOptionalConfig({}, stored)[side].source, 'stored-key');
    assert.equal(resolveOptionalConfig({ [variable]: JSON.stringify(record) }, stored)[side].source, 'environment');
    for (const invalid of ['', SECRET, '{', 'null', '[]', '{}', null, 42]) {
      const resolved = resolveOptionalConfig({ [variable]: invalid }, stored);
      assert.equal(resolved[side], null);
      assert.equal(resolved.optional_config_errors.length, 1);
      assert.deepEqual(Object.keys(resolved.optional_config_errors[0]), ['component', 'source', 'variable', 'message']);
      assert.equal(resolved.optional_config_errors[0].component, side);
      assert.equal(resolved.optional_config_errors[0].source, 'environment');
      assert.doesNotMatch(JSON.stringify(resolved.optional_config_errors), /private-optional-credential/);
    }
  }
});

test('malformed stored optional records disable only their side without changing core resolution', () => {
  const stored = { cpi: CORE, ...Object.fromEntries(OPTIONAL_COMPONENT_KEYS.map(side => [side, { injected: SECRET }])) };
  const config = resolveIntegrationConfig({}, { stored });
  assert.equal(config.cpi.url, CORE.url);
  assert.equal(config.cpi.source, 'stored-key');
  assert.equal(config.optional_config_errors.length, 7);
  assert.doesNotMatch(JSON.stringify(config.optional_config_errors), /private-optional-credential/);
  assert.deepEqual(stored.ctms, { injected: SECRET });
  for (const side of OPTIONAL_COMPONENT_KEYS) assert.equal(config[side], null);
  const fromEnvironment = resolveIntegrationConfig({ CPI_SERVICE_KEY: JSON.stringify({ ...CORE, url: 'https://environment.example' }), ANS_CONFIG: SECRET }, { stored });
  assert.equal(fromEnvironment.cpi.url, 'https://environment.example');
  assert.equal(fromEnvironment.cpi.source, 'service-key');
  assert.equal(fromEnvironment.ans, null);
});

test('stored optional credentials must be normalized objects, never raw keys, JSON strings or metadata', () => {
  for (const [side, record] of Object.entries(RECORDS)) {
    for (const invalid of [JSON.stringify(record), { ...record, source: 'stored-key' }, { ...record, injected: SECRET }, null, false, []]) {
      const config = resolveOptionalConfig({}, { [side]: invalid });
      assert.equal(config[side], null);
      assert.equal(config.optional_config_errors[0].source, 'stored-key');
      assert.doesNotMatch(JSON.stringify(config.optional_config_errors), /private-optional-credential/);
    }
    for (const field of Object.keys(record).filter(field => field !== 'probeQueueName')) {
      const { [field]: omitted, ...missing } = record;
      safeFailure(() => parseOptionalConfig(side, missing));
      safeFailure(() => parseOptionalConfig(side, { ...record, [field]: '' }));
      safeFailure(() => parseOptionalConfig(side, { ...record, [field]: 42 }));
      safeFailure(() => parseOptionalConfig(side, { ...record, [field]: `${SECRET}\r\ninjected-secret` }));
    }
  }
  assert.equal(resolveOptionalConfig({}, { ctms: RAW_CTMS }).ctms, null);
  safeFailure(() => parseOptionalConfig('aem', { ...RECORDS.aem, url: 'https://injected.example' }));
});

test('optional URL rules reject unsafe schemes, credentials, query and fragment without leaking input', () => {
  for (const [side, record] of Object.entries(RECORDS)) {
    for (const field of ['url', 'tokenUrl'].filter(key => Object.hasOwn(record, key))) {
      for (const url of [
        `http://injected-secret.example`,
        `ftp://injected-secret.example`,
        `https://user:${SECRET}@service.example`,
        `https://service.example?token=${SECRET}`,
        `https://service.example#${SECRET}`,
        'https://service.example?',
        'https://service.example#',
        SECRET
      ]) safeFailure(() => parseOptionalConfig(side, { ...record, [field]: url }));
    }
  }
  assert.equal(parseOptionalConfig('ans', { ...RECORDS.ans, url: 'http://127.0.0.1:1234' }).url, 'http://127.0.0.1:1234');
  assert.equal(parseOptionalConfig('ans', { ...RECORDS.ans, url: 'http://[::1]:1234' }).url, 'http://[::1]:1234');
  safeFailure(() => parseOptionalConfig('open_connectors', { ...RECORDS.open_connectors, url: 'https://connectors.example' }));
  safeFailure(() => parseOptionalConfig('edge', { ...RECORDS.edge, url: 'https://edge.example/local' }));
  assert.equal(parseOptionalConfig('edge', { ...RECORDS.edge, url: 'https://edge.example/' }).url, 'https://edge.example');
});

test('configuration environment is immutable reporting metadata and absent-all keeps setup guidance', () => {
  const env = { ANS_CONFIG: JSON.stringify(RECORDS.ans), INTEGRATION_ENVIRONMENT: '  QA  ' };
  const config = resolveIntegrationConfig(env);
  env.INTEGRATION_ENVIRONMENT = 'production';
  assert.equal(config.environment, 'QA');
  assert.equal(config.ans.url, RECORDS.ans.url);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.optional_config_errors), true);
  assert.equal(resolveIntegrationConfig({ AEM_CONFIG: JSON.stringify(RECORDS.aem) }).environment, 'default');
  assert.throws(() => resolveIntegrationConfig({ INTEGRATION_ENVIRONMENT: 'report-only' }), /^Error: Configure CPI/);
  const malformedOnly = resolveIntegrationConfig({ ANS_CONFIG: SECRET });
  assert.equal(malformedOnly.ans, null);
  assert.equal(malformedOnly.optional_config_errors.length, 1);
});

test('optional storage projects exact fields, merges all sides and retains 0600/0700 permissions', async t => {
  const env = await storeFixture(t);
  await storeIntegrationKey('CPI', parseIntegrationServiceKey('CPI', CORE), env);
  for (const [side, record] of Object.entries(RECORDS)) {
    await storeIntegrationKey(side.toUpperCase(), parseOptionalConfig(side, record, { source: 'setup' }), env);
  }
  const path = integrationCredentialsPath(env);
  const stored = readStoredIntegrationKeys(env);
  assert.deepEqual(stored.cpi, { oauth: { url: CORE.url, tokenurl: CORE.tokenUrl, clientid: CORE.clientId, clientsecret: CORE.clientSecret } });
  for (const [side, record] of Object.entries(RECORDS)) assert.deepEqual(stored[side], record);
  assert.equal((await readFile(path, 'utf8')).includes('"source"'), false);
  const replacement = { ...RECORDS.ans, username: 'replacement' };
  await storeIntegrationKey('ans', parseOptionalConfig('ans', replacement), env);
  assert.deepEqual(readStoredIntegrationKeys(env), { ...stored, ans: replacement });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  }
});

test('one malformed optional stored record cannot replace or erase core or other sides on save', async t => {
  const env = await storeFixture(t);
  const path = await storeIntegrationKey('CPI', parseIntegrationServiceKey('CPI', CORE), env);
  const core = readStoredIntegrationKeys(env).cpi;
  const malformed = { rawCredential: SECRET };
  await writeFile(path, JSON.stringify({ cpi: core, ans: malformed, aem: RECORDS.aem, event_mesh: null }), { mode: 0o600 });
  const original = await readFile(path, 'utf8');
  await assert.rejects(storeIntegrationKey('ctms', RAW_CTMS, env));
  assert.equal(await readFile(path, 'utf8'), original);
  await storeIntegrationKey('EDGE', parseOptionalConfig('edge', RECORDS.edge), env);
  let stored = readStoredIntegrationKeys(env);
  assert.deepEqual(stored, { cpi: core, ans: malformed, aem: RECORDS.aem, event_mesh: null, edge: RECORDS.edge });
  assert.equal(resolveIntegrationConfig({}, { stored }).cpi.url, CORE.url);
  assert.equal(resolveIntegrationConfig({}, { stored }).optional_config_errors.length, 2);
  await storeIntegrationKey('APIM', parseIntegrationServiceKey('APIM', { ...CORE, url: 'https://apim.example' }), env);
  stored = readStoredIntegrationKeys(env);
  assert.deepEqual(stored.ans, malformed);
  assert.deepEqual(stored.aem, RECORDS.aem);
  assert.equal(stored.event_mesh, null);
});

test('optional setup never overwrites unreadable JSON store, and unknown records do not become configured sides', async t => {
  const env = await storeFixture(t);
  const path = await storeIntegrationKey('CPI', parseIntegrationServiceKey('CPI', CORE), env);
  await writeFile(path, `{bad-json-${SECRET}`);
  await assert.rejects(storeIntegrationKey('ANS', parseOptionalConfig('ans', RECORDS.ans), env), /Stored Integration Suite credentials/);
  assert.equal(await readFile(path, 'utf8'), `{bad-json-${SECRET}`);
  await writeFile(path, JSON.stringify({ aem: RECORDS.aem, unrelated: { password: SECRET } }));
  assert.deepEqual(readStoredIntegrationKeys(env), { aem: RECORDS.aem });
});

test('ambiguous connector authorization disables only that optional side before client construction', () => {
  for (const userSecret of ['injected-secret, Element foreign', 'injected-secret with-space', 'injected-secret-é', 'x'.repeat(16385)]) {
    const config = resolveIntegrationConfig({
      CPI_URL: CORE.url, CPI_TOKEN_URL: CORE.tokenUrl, CPI_CLIENT_ID: CORE.clientId, CPI_CLIENT_SECRET: CORE.clientSecret,
      OPEN_CONNECTORS_CONFIG: JSON.stringify({ ...RECORDS.open_connectors, userSecret })
    });
    assert.equal(config.cpi.url, CORE.url);
    assert.equal(config.open_connectors, null);
    assert.deepEqual(config.optional_config_errors.map(error => error.component), ['open_connectors']);
    assert.doesNotMatch(JSON.stringify(config.optional_config_errors), /injected-secret|foreign/);
  }
});
