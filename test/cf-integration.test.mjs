import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationInstance, findIntegrationInstances, integrationServiceKey } from '../src/cf-integration.mjs';

const KEY = { oauth: { url: 'https://tenant.it-cpi.example', tokenurl: 'https://auth.example/oauth/token', clientid: 'id', clientsecret: 'secret' } };

function fakeCf({ existingKey = false, visible = true, ambiguous = false } = {}) {
  const calls = [];
  let keyExists = existingKey;
  const plans = {
    'plan-api': { name: 'api', offering: 'it-rt' },
    'plan-flow': { name: 'integration-flow', offering: 'it-rt' },
    'plan-apim': { name: 'apiportal-apiaccess', offering: 'apimanagement-apiportal' },
    'plan-devhub': { name: 'devportal-apiaccess', offering: 'apimanagement-devportal' },
    'plan-dest': { name: 'lite', offering: 'destination' }
  };
  const execFileImpl = (_command, args, _options, callback) => {
    calls.push([...args]);
    let output = '';
    if (args[0] === 'version') output = 'cf version 8.18.0';
    else if (args[0] === 'target') output = 'org: Integration Org\nspace: CIDev';
    else if (args[0] === 'space') output = 'space-1';
    else if (args[0] === 'curl' && args[1].startsWith('/v3/service_plans?')) {
      const query = new URL(args[1], 'https://cf.example').searchParams;
      const scoped = query.has('space_guids');
      const selected = Object.entries(plans).filter(([, plan]) => plan.name === query.get('names'));
      const rows = scoped && !visible ? [] : selected.flatMap(([guid, plan]) => {
        const row = { guid, name: plan.name, relationships: { service_offering: { data: { guid: `offering-${guid}` } } } };
        return scoped && ambiguous ? [row, { ...row, guid: `${guid}-duplicate` }] : [row];
      });
      output = JSON.stringify({
        resources: rows,
        included: { service_offerings: selected.map(([guid, plan]) => ({
          guid: `offering-${guid}`, name: plan.offering, relationships: { service_broker: { data: { guid: `broker-${guid}` } } }
        })) }
      });
    } else if (args[0] === 'curl' && args[1].endsWith('/visibility')) {
      output = JSON.stringify({ type: 'organization', organizations: [{ guid: 'qas-org', name: 'QAS Org' }] });
    } else if (args[0] === 'curl' && args[1].startsWith('/v3/service_brokers/')) {
      output = JSON.stringify({ errors: [{ title: 'CF-ResourceNotFound', detail: 'Broker-admin details are not accessible' }] });
    } else if (args[0] === 'curl' && args[1].startsWith('/v3/service_offerings/')) {
      const guid = args[1].split('/').at(-1).split('?')[0].replace('offering-', 'broker-');
      output = JSON.stringify({ included: { service_brokers: [{ guid, name: guid }] } });
    } else if (args[0] === 'create-service') {
      const expected = `broker-${Object.keys(plans).find(guid => plans[guid].offering === args[1] && plans[guid].name === args[2])}`;
      if (args[args.indexOf('-b') + 1] !== expected) return callback(Object.assign(new Error('ambiguous or wrong broker'), { stderr: 'Wrong broker selected' }));
    } else if (args[0] === 'curl' && args[1].startsWith('/v3/service_instances?')) {
      output = JSON.stringify({ resources: [
        { guid: 'g1', name: 'isuite-api', relationships: { service_plan: { data: { guid: 'plan-api' } } } },
        { guid: 'g2', name: 'isuite-runtime', relationships: { service_plan: { data: { guid: 'plan-flow' } } } },
        { guid: 'g3', name: 'apim-access', relationships: { service_plan: { data: { guid: 'plan-apim' } } } },
        { guid: 'g4', name: 'dest', relationships: { service_plan: { data: { guid: 'plan-dest' } } } },
        { guid: 'g6', name: 'devhub-access', relationships: { service_plan: { data: { guid: 'plan-devhub' } } } },
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

test('findIntegrationInstances matches CPI, APIM and Developer Hub access plans', async () => {
  const cf = fakeCf();
  const found = await findIntegrationInstances({ env: {}, spaceGuid: 'space-1', execFileImpl: cf.execFileImpl });
  assert.deepEqual(found, { CPI: [{ guid: 'g1', name: 'isuite-api' }], APIM: [{ guid: 'g3', name: 'apim-access' }], DEVHUB: [{ guid: 'g6', name: 'devhub-access' }] });
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

test('provisioning selects the broker visible to the targeted space rather than an unscoped catalog match', async () => {
  const cf = fakeCf();
  for (const side of ['CPI', 'APIM', 'DEVHUB']) await createIntegrationInstance(side, { env: {}, execFileImpl: cf.execFileImpl });
  const writes = cf.calls.filter(args => args[0] === 'create-service');
  assert.deepEqual(writes.map(args => args[args.indexOf('-b') + 1]), ['broker-plan-api', 'broker-plan-apim', 'broker-plan-devhub']);
});

test('an entitlement visible only to another organization cannot create an instance in the current target', async () => {
  const cf = fakeCf({ visible: false });
  await assert.rejects(createIntegrationInstance('DEVHUB', { env: {}, execFileImpl: cf.execFileImpl }), /Integration Org.*CIDev.*QAS Org/);
  assert.equal(cf.calls.some(args => args[0] === 'create-service' || args[0] === 'create-service-key'), false);
});

test('ambiguous visible plans are refused before any service creation', async () => {
  const cf = fakeCf({ ambiguous: true });
  await assert.rejects(createIntegrationInstance('DEVHUB', { env: {}, execFileImpl: cf.execFileImpl }), /broker selection is ambiguous/);
  assert.equal(cf.calls.some(args => args[0] === 'create-service'), false);
});
