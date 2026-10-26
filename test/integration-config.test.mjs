import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntegrationConfig } from '../src/integration-config.mjs';

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
  assert.match(errorOf({}), /^Configure CPI \(CPI_SERVICE_KEY or CPI_URL\/CPI_TOKEN_URL\/CPI_CLIENT_ID\/CPI_CLIENT_SECRET\) and\/or APIM/);
  assert.match(errorOf({ VCAP_SERVICES: JSON.stringify({ other: [] }) }), /^Configure CPI/);
});
