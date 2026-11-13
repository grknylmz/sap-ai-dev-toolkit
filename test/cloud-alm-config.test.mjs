import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudAlmServiceKey, resolveCloudAlmConfig } from '../src/cloud-alm-config.mjs';

const UAA = { url: 'https://calm.authentication.eu10.hana.ondemand.com', clientid: 'sb-calm!b1', clientsecret: 'calm-secret' };

test('wrapped service key resolves the API URL with scheme and the token URL', () => {
  const config = resolveCloudAlmConfig({
    CLOUD_ALM_SERVICE_KEY: JSON.stringify({ credentials: { endpoints: { Api: 'eu10.alm.cloud.sap/api' }, uaa: UAA } })
  });
  assert.equal(config.url, 'https://eu10.alm.cloud.sap/api');
  assert.equal(config.tokenUrl, `${UAA.url}/oauth/token`);
  assert.equal(config.source, 'service-key');
  assert.equal(parseCloudAlmServiceKey({ endpoints: { api: 'https://t.eu10.alm.cloud.sap/api' }, uaa: UAA }).url, 'https://t.eu10.alm.cloud.sap/api');
});

test('certificate-only binding is rejected with the binding-secret guidance', () => {
  assert.throws(
    () => parseCloudAlmServiceKey({ endpoints: { Api: 'https://eu10.alm.cloud.sap/api' }, uaa: { url: UAA.url, clientid: 'sb', certificate: '-----BEGIN', key: '-----BEGIN' } }),
    /certificate \(x509\) binding; create a binding with client secret credentials \(credential type binding-secret\)/
  );
});

test('a key without endpoints.Api names the Cloud ALM API service', () => {
  assert.throws(() => parseCloudAlmServiceKey({ uaa: UAA }), /has no endpoints\.Api; use a service key of the "SAP Cloud ALM API" instance/);
});

test('explicit variables beat the service key, which beats the stored record', () => {
  const key = JSON.stringify({ endpoints: { Api: 'https://key.alm.cloud.sap/api' }, uaa: UAA });
  const stored = { url: 'https://stored.alm.cloud.sap/api', tokenurl: UAA.url, clientid: 'stored', clientsecret: 'stored-secret' };
  const explicit = {
    CLOUD_ALM_URL: 'https://env.alm.cloud.sap/api',
    CLOUD_ALM_TOKEN_URL: UAA.url,
    CLOUD_ALM_CLIENT_ID: 'env',
    CLOUD_ALM_CLIENT_SECRET: 'env-secret'
  };
  const fromEnv = resolveCloudAlmConfig({ ...explicit, CLOUD_ALM_SERVICE_KEY: key }, { stored });
  assert.equal(fromEnv.source, 'environment');
  assert.equal(fromEnv.url, 'https://env.alm.cloud.sap/api');
  const fromKey = resolveCloudAlmConfig({ CLOUD_ALM_SERVICE_KEY: key }, { stored });
  assert.equal(fromKey.source, 'service-key');
  assert.equal(fromKey.url, 'https://key.alm.cloud.sap/api');
  const fromStore = resolveCloudAlmConfig({}, { stored });
  assert.equal(fromStore.source, 'stored-key');
  assert.equal(fromStore.clientId, 'stored');
});

test('a partial explicit group names the missing variables', () => {
  assert.throws(
    () => resolveCloudAlmConfig({ CLOUD_ALM_URL: 'https://env.alm.cloud.sap/api', CLOUD_ALM_CLIENT_ID: 'env' }),
    /Explicit CLOUD_ALM configuration is incomplete: CLOUD_ALM_TOKEN_URL, CLOUD_ALM_CLIENT_SECRET/
  );
});

test('nothing configured points at the setup command', () => {
  assert.throws(() => resolveCloudAlmConfig({}), /Configure SAP Cloud ALM .*sap-ai-dev --setup-cloud-alm/);
});
