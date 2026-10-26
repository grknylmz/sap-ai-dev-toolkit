import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationInstance, findIntegrationInstances, integrationServiceKey } from '../src/cf-integration.mjs';

const KEY = { oauth: { url: 'https://tenant.it-cpi.example', tokenurl: 'https://auth.example/oauth/token', clientid: 'id', clientsecret: 'secret' } };

function fakeCf({ existingKey = false } = {}) {
  const calls = [];
  let keyExists = existingKey;
  const plans = {
    'plan-api': { name: 'api', offering: 'it-rt' },
    'plan-flow': { name: 'integration-flow', offering: 'it-rt' },
    'plan-apim': { name: 'apiportal-apiaccess', offering: 'apimanagement-apiportal' },
    'plan-dest': { name: 'lite', offering: 'destination' }
  };
  const execFileImpl = (_command, args, _options, callback) => {
    calls.push([...args]);
    let output = '';
    if (args[0] === 'curl' && args[1].startsWith('/v3/service_instances?')) {
      output = JSON.stringify({ resources: [
        { guid: 'g1', name: 'isuite-api', relationships: { service_plan: { data: { guid: 'plan-api' } } } },
        { guid: 'g2', name: 'isuite-runtime', relationships: { service_plan: { data: { guid: 'plan-flow' } } } },
        { guid: 'g3', name: 'apim-access', relationships: { service_plan: { data: { guid: 'plan-apim' } } } },
        { guid: 'g4', name: 'dest', relationships: { service_plan: { data: { guid: 'plan-dest' } } } },
        { guid: 'g5', name: 'user-provided', relationships: {} }
      ] });
    } else if (args[0] === 'curl' && args[1].startsWith('/v3/service_plans/')) {
      const plan = plans[decodeURIComponent(args[1].split('/')[3].split('?')[0])];
      output = JSON.stringify({ name: plan.name, included: { service_offerings: [{ name: plan.offering }] } });
    } else if (args[0] === 'service-key') {
      if (!keyExists) return callback(Object.assign(new Error('failed'), { stderr: "Service key 'sap-ai-dev-integration' not found" }));
      output = JSON.stringify({ credentials: KEY });
    } else if (args[0] === 'create-service-key') {
      keyExists = true;
    }
    callback(null, { stdout: output, stderr: '' });
  };
  return { calls, execFileImpl };
}

test('findIntegrationInstances keeps only the api and apiportal-apiaccess plans', async () => {
  const cf = fakeCf();
  const found = await findIntegrationInstances({ env: {}, spaceGuid: 'space-1', execFileImpl: cf.execFileImpl });
  assert.deepEqual(found, { CPI: [{ guid: 'g1', name: 'isuite-api' }], APIM: [{ guid: 'g3', name: 'apim-access' }] });
});

test('integrationServiceKey reuses the named key and creates it only when missing', async () => {
  const existing = fakeCf({ existingKey: true });
  const reused = await integrationServiceKey('isuite-api', { env: {}, execFileImpl: existing.execFileImpl });
  assert.equal(reused.created, false);
  assert.deepEqual(reused.credentials, KEY);
  assert.equal(existing.calls.some(args => args[0] === 'create-service-key'), false);

  const missing = fakeCf();
  const created = await integrationServiceKey('isuite-api', { env: {}, execFileImpl: missing.execFileImpl });
  assert.equal(created.created, true);
  assert.deepEqual(missing.calls.find(args => args[0] === 'create-service-key'), ['create-service-key', 'isuite-api', 'sap-ai-dev-integration', '--wait']);
});

test('createIntegrationInstance requests the plan with client credentials and the tool roles', async () => {
  const cf = fakeCf();
  await createIntegrationInstance('CPI', { env: {}, execFileImpl: cf.execFileImpl });
  await createIntegrationInstance('APIM', { env: {}, execFileImpl: cf.execFileImpl });
  const [cpi, apim] = cf.calls;
  assert.deepEqual(cpi.slice(0, 4), ['create-service', 'it-rt', 'api', 'sap-ai-dev-integration-cpi']);
  const parameters = JSON.parse(cpi[cpi.indexOf('-c') + 1]);
  assert.deepEqual(parameters['grant-types'], ['client_credentials']);
  assert.ok(parameters.roles.includes('AuthGroup_IntegrationDeveloper'));
  assert.deepEqual(apim.slice(0, 4), ['create-service', 'apimanagement-apiportal', 'apiportal-apiaccess', 'sap-ai-dev-integration-apim']);
  assert.deepEqual(JSON.parse(apim[apim.indexOf('-c') + 1]), { role: 'APIPortal.Administrator' });
});
