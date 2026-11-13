import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProcessAutomationServiceKey,
  resolveProcessAutomationConfig
} from '../src/process-automation-config.mjs';

const UAA = 'https://acme.authentication.us10.hana.ondemand.com';
const API = 'spa-api-gateway-bpi-us-prod.cfapps.us10.hana.ondemand.com';
const key = (overrides = {}) => ({
  endpoints: { api: API },
  uaa: { url: UAA, clientid: 'sb-bpa!b1', clientsecret: 'key-secret' },
  ...overrides
});
const explicitEnv = {
  PROCESS_AUTOMATION_URL: 'https://explicit.example',
  PROCESS_AUTOMATION_TOKEN_URL: 'https://explicit-auth.example',
  PROCESS_AUTOMATION_CLIENT_ID: 'sb-explicit',
  PROCESS_AUTOMATION_CLIENT_SECRET: 'explicit-secret'
};
const stored = { auth: 'technical', url: 'https://stored.example', tokenurl: 'https://stored-auth.example', clientid: 'sb-stored', clientsecret: 'stored-secret' };

test('wrapped service key with scheme-less endpoints.api resolves https url and /oauth/token', () => {
  const config = resolveProcessAutomationConfig({ PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify({ credentials: key() }) });
  assert.equal(config.source, 'service-key');
  assert.equal(config.auth, 'technical');
  assert.equal(config.url, `https://${API}`);
  assert.equal(config.tokenUrl, `${UAA}/oauth/token`);
  assert.equal(config.clientId, 'sb-bpa!b1');
  assert.equal(config.authorizationUrl, null);
  assert.equal(config.refreshToken, null);
  assert.ok(Object.isFrozen(config));
});

test('certificate-only uaa is rejected with the certificate message', () => {
  assert.throws(
    () => parseProcessAutomationServiceKey(key({ uaa: { url: UAA, clientid: 'sb-bpa!b1', certificate: '-----BEGIN CERTIFICATE-----', key: 'k' } })),
    /PROCESS_AUTOMATION_SERVICE_KEY is a certificate-based key; create a service key with client secret credentials/
  );
});

test('missing endpoints.api is rejected', () => {
  assert.throws(
    () => parseProcessAutomationServiceKey(JSON.stringify({ uaa: key().uaa })),
    /PROCESS_AUTOMATION_SERVICE_KEY has no endpoints\.api/
  );
});

test('explicit variables beat the service key, which beats the stored record', () => {
  const serviceKey = JSON.stringify(key());
  const explicit = resolveProcessAutomationConfig({ ...explicitEnv, PROCESS_AUTOMATION_SERVICE_KEY: serviceKey }, { stored });
  assert.equal(explicit.source, 'environment');
  assert.equal(explicit.url, 'https://explicit.example');
  assert.equal(explicit.tokenUrl, 'https://explicit-auth.example/oauth/token');

  const fromKey = resolveProcessAutomationConfig({ PROCESS_AUTOMATION_SERVICE_KEY: serviceKey }, { stored });
  assert.equal(fromKey.source, 'service-key');
  assert.equal(fromKey.clientId, 'sb-bpa!b1');

  const fromStore = resolveProcessAutomationConfig({}, { stored });
  assert.equal(fromStore.source, 'stored-key');
  assert.equal(fromStore.url, 'https://stored.example');
  assert.equal(fromStore.tokenUrl, 'https://stored-auth.example/oauth/token');
});

test('API key and environment come from the store unless the environment overrides them; malformed values fail', () => {
  const withAccess = { ...stored, apikey: 'stored-key', environmentid: 'stored-env' };
  const fromStore = resolveProcessAutomationConfig({}, { stored: withAccess });
  assert.equal(fromStore.apiKey, 'stored-key');
  assert.equal(fromStore.environmentId, 'stored-env');
  const overridden = resolveProcessAutomationConfig({ PROCESS_AUTOMATION_API_KEY: 'env-key', PROCESS_AUTOMATION_ENVIRONMENT_ID: 'env-env' }, { stored: withAccess });
  assert.equal(overridden.apiKey, 'env-key');
  assert.equal(overridden.environmentId, 'env-env');
  const none = resolveProcessAutomationConfig({ PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify(key()) });
  assert.equal(none.apiKey, null);
  assert.equal(none.environmentId, null);
  assert.throws(() => resolveProcessAutomationConfig({ PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify(key()), PROCESS_AUTOMATION_API_KEY: 'two words' }), /PROCESS_AUTOMATION_API_KEY must be a single printable token/);
  assert.throws(() => resolveProcessAutomationConfig({ PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify(key()), PROCESS_AUTOMATION_ENVIRONMENT_ID: 'bad/env' }), /PROCESS_AUTOMATION_ENVIRONMENT_ID must be/);
});

test('partial explicit group names the missing variables', () => {
  assert.throws(
    () => resolveProcessAutomationConfig({ PROCESS_AUTOMATION_URL: 'https://explicit.example', PROCESS_AUTOMATION_CLIENT_ID: 'sb-explicit' }),
    /Explicit PROCESS_AUTOMATION configuration is incomplete: PROCESS_AUTOMATION_TOKEN_URL, PROCESS_AUTOMATION_CLIENT_SECRET/
  );
});

test('interactive auth requires a refresh token', () => {
  assert.throws(
    () => resolveProcessAutomationConfig({ PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify(key()), PROCESS_AUTOMATION_AUTH: 'interactive' }),
    /PROCESS_AUTOMATION_REFRESH_TOKEN is required for interactive sign-in; run sap-ai-dev --setup-process-automation/
  );
});

test('interactive authorizationUrl is the uaa origin /oauth/authorize', () => {
  const config = resolveProcessAutomationConfig({
    PROCESS_AUTOMATION_SERVICE_KEY: JSON.stringify(key()),
    PROCESS_AUTOMATION_AUTH: 'interactive',
    PROCESS_AUTOMATION_REFRESH_TOKEN: 'refresh-1'
  });
  assert.equal(config.auth, 'interactive');
  assert.equal(config.authorizationUrl, `${UAA}/oauth/authorize`);
  assert.equal(config.refreshToken, 'refresh-1');
});

test('nothing configured asks to configure SAP Build Process Automation', () => {
  assert.throws(() => resolveProcessAutomationConfig({}), /^Error: Configure SAP Build Process Automation \(PROCESS_AUTOMATION_SERVICE_KEY/);
});
