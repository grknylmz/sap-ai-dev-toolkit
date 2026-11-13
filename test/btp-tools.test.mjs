import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { IntegrationError } from '../src/integration-http.mjs';
import { BTP_TOOL_NAMES, registerBtpTools } from '../src/btp-tools.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const SA = '11111111-2222-3333-4444-555555555555';
const OTHER_SA = '99999999-2222-3333-4444-555555555555';
const INSTANCE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const isWindows = process.platform === 'win32';

const OFFERINGS = [{ id: 'o-dest', name: 'destination' }, { id: 'o-conn', name: 'connectivity' }, { id: 'o-hana', name: 'hana-cloud' }];
const PLANS = [
  { id: 'p-lite', name: 'lite', service_offering_id: 'o-dest' },
  { id: 'p-api', name: 'api_access', service_offering_id: 'o-conn' },
  { id: 'p-hana', name: 'hana', service_offering_id: 'o-hana' }
];

/** Default catalog for the default environment; others empty unless `extra` answers first. */
const catalogResponder = extra => async (command, flags) => {
  const answer = await extra?.(command, flags);
  if (answer !== undefined) return answer;
  if (command === 'list services/offering') return flags.environment ? [] : OFFERINGS;
  if (command === 'list services/plan') return flags.environment ? [] : PLANS;
  return undefined;
};

/** Fake MCP server + btp CLI; `responder(command, flags)` returns a payload, throws, or undefined (null). */
function fixture(responder = () => undefined, { now = NOW } = {}) {
  const registered = [];
  const server = { registerTool: (name, definition, handler) => {
    const schema = typeof definition.inputSchema?.parse === 'function' ? definition.inputSchema : z.object(definition.inputSchema);
    registered.push({ name, ...definition, handler: async args => handler(schema.parse(args ?? {})) });
  } };
  const calls = [];
  const answer = async (words, flags = {}) => {
    calls.push({ command: words.join(' '), flags });
    const reply = await responder(words.join(' '), flags);
    return reply === undefined ? null : reply;
  };
  const cli = {
    json: answer,
    text: async (words, flags) => {
      const reply = await answer(words, flags);
      return typeof reply === 'string' ? reply : JSON.stringify(reply ?? {});
    }
  };
  const summary = { cli: 'btp', cli_source: 'PATH', config_file: 'btp CLI default', acting_user: 'the user signed in to the btp CLI (btp login --sso)' };
  const names = registerBtpTools(server, { cli, summary, verify: async () => ({ cli_version: '2.116.3' }), env: {}, now: () => now });
  return { names, calls, byName: Object.fromEntries(registered.map(entry => [entry.name, entry])) };
}

const parse = result => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const textOf = result => result.content.map(part => part.text).join('\n');

test('registered tool names match BTP_TOOL_NAMES', () => {
  const f = fixture();
  assert.deepEqual(f.names, [...BTP_TOOL_NAMES]);
  assert.deepEqual(Object.keys(f.byName), [...BTP_TOOL_NAMES]);
});

test('wrong confirmation on creates returns isError and makes zero CLI calls', async () => {
  const f = fixture(catalogResponder());
  const instance = await f.byName.btp_create_service_instance.handler({ subaccount: SA, offering: 'hana-cloud', plan: 'hana', name: 'db', confirmation: 'yes' });
  assert.equal(instance.isError, true);
  assert.match(textOf(instance), /confirmation must equal CREATE BTP SERVICE INSTANCE db/);
  const key = await f.byName.btp_create_service_key.handler({ subaccount: SA, instance_id: INSTANCE_ID, name: 'k1', confirmation: 'yes' });
  assert.equal(key.isError, true);
  assert.match(textOf(key), /confirmation must equal CREATE BTP SERVICE KEY k1/);
  assert.equal(f.calls.length, 0);
});

test('create instance refuses a plan absent from every catalog', async () => {
  const f = fixture(catalogResponder());
  const result = await f.byName.btp_create_service_instance.handler({ subaccount: SA, offering: 'hana-cloud', plan: 'missing', name: 'db', confirmation: 'CREATE BTP SERVICE INSTANCE db' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^No instance was created: hana-cloud\/missing is not in the Service Manager catalog/);
  assert.deepEqual(f.calls.filter(call => call.command === 'list services/plan').map(call => call.flags.environment), [undefined, 'cloudfoundry', 'kubernetes']);
  assert.equal(f.calls.some(call => call.command === 'create services/instance'), false);
});

test('create instance passes parameters through a private temp file and reads the instance back', async () => {
  let parametersFile;
  const parameters = { data: { systempassword: 'Secret-Pass-1' } };
  const f = fixture(catalogResponder((command, flags) => {
    if (command === 'list accounts/entitlement') return { assignedServices: [] };
    if (command === 'create services/instance') {
      parametersFile = flags.parameters;
      assert.equal(readFileSync(parametersFile, 'utf8'), JSON.stringify(parameters));
      if (!isWindows) assert.equal(statSync(parametersFile).mode & 0o777, 0o600);
      return { id: INSTANCE_ID };
    }
    if (command === 'get services/instance') {
      assert.equal(flags.id, INSTANCE_ID);
      return { id: INSTANCE_ID, name: 'db', service_plan_id: 'p-hana', context: '{"platform":"service-manager"}', last_operation: { type: 'create', state: 'in progress' } };
    }
    return undefined;
  }));
  const result = parse(await f.byName.btp_create_service_instance.handler({
    subaccount: SA, offering: 'hana-cloud', plan: 'hana', name: 'db', parameters, confirmation: 'CREATE BTP SERVICE INSTANCE db'
  }));
  assert.equal(result.created, true);
  assert.equal(result.instance.offering, 'hana-cloud');
  assert.equal(result.instance.plan, 'hana');
  assert.equal(result.instance.platform, 'service-manager');
  assert.equal(result.instance.last_operation.state, 'in progress');
  assert.equal(existsSync(parametersFile), false);
  for (const call of f.calls) {
    for (const value of Object.values(call.flags)) assert.equal(String(value).includes('Secret-Pass-1'), false);
  }
});

test('a failing read-back after create still reports created', async () => {
  const f = fixture(catalogResponder(command => {
    if (command === 'list accounts/entitlement') return { assignedServices: [] };
    if (command === 'create services/instance') return '';
    if (command === 'get services/instance') throw new IntegrationError('btp CLI "get services/instance" failed: not found');
    return undefined;
  }));
  const result = parse(await f.byName.btp_create_service_instance.handler({ subaccount: SA, offering: 'hana-cloud', plan: 'hana', name: 'db', confirmation: 'CREATE BTP SERVICE INSTANCE db' }));
  assert.equal(result.created, true);
  assert.equal(result.instance, null);
  assert.match(result.read_back_error, /not found/);
  assert.equal(f.calls.find(call => call.command === 'get services/instance').flags.name, 'db');
});

test('a create timeout reports an unknown outcome instead of an error', async () => {
  const f = fixture(catalogResponder(command => {
    if (command === 'list accounts/entitlement') return { assignedServices: [] };
    if (command === 'create services/binding') throw new IntegrationError('timed out', { code: 'BTP_CLI_TIMEOUT' });
    return undefined;
  }));
  const result = parse(await f.byName.btp_create_service_key.handler({ subaccount: SA, instance_name: 'db', name: 'k1', confirmation: 'CREATE BTP SERVICE KEY k1' }));
  assert.equal(result.created, 'unknown');
  assert.match(result.note, /k1 before retrying/);
  const create = f.calls.find(call => call.command === 'create services/binding');
  assert.equal(create.flags['instance-name'], 'db');
  assert.equal(create.flags.binding, 'k1');
});

const entitlement = assignment => ({
  assignedServices: [{
    name: 'hana-cloud',
    iconBase64: 'AAAA',
    servicePlans: [{ name: 'hana', category: 'SERVICE', assignmentInfo: [{ entityId: OTHER_SA, amount: 9 }, { entityId: SA, amount: 2, entityState: 'OK', ...assignment }] }]
  }]
});

const quotaFixture = assignment => fixture(catalogResponder(command => {
  if (command === 'list accounts/entitlement') return entitlement(assignment);
  if (command === 'list services/instance') return [
    { id: 'i1', name: 'db1', service_plan_id: 'p-hana' },
    { id: 'i2', name: 'db2', service_plan_id: 'p-hana' },
    { id: 'i3', name: 'dest', service_plan_id: 'p-lite' }
  ];
  return undefined;
}));

test('check quota counts instances of the plan against the assigned amount', async () => {
  const insufficient = parse(await quotaFixture({}).byName.btp_check_quota.handler({ subaccount: SA, service: 'hana-cloud', plan: 'hana' }));
  assert.equal(insufficient.verdict, 'insufficient_quota');
  assert.equal(insufficient.usage.instances, 2);
  assert.equal(insufficient.remaining, 0);
  assert.equal(insufficient.entitlement.assigned_amount, 2);

  const unlimited = parse(await quotaFixture({ unlimitedAmountAssigned: true }).byName.btp_check_quota.handler({ subaccount: SA, service: 'hana-cloud', plan: 'hana' }));
  assert.equal(unlimited.verdict, 'available');

  const processing = parse(await quotaFixture({ entityState: 'PROCESSING', stateMessage: 'assigning' }).byName.btp_check_quota.handler({ subaccount: SA, service: 'hana-cloud', plan: 'hana' }));
  assert.equal(processing.verdict, 'assignment_not_ready');
  assert.match(processing.reasons[0], /PROCESSING: assigning/);
});

test('list instances resolves Cloud Foundry-only plans without loading the Kyma catalog', async () => {
  const f = fixture(catalogResponder((command, flags) => {
    if (command === 'list services/instance') return [{ id: 'i1', name: 'xsuaa-app', service_plan_id: 'p-cf', context: { platform: 'cloudfoundry', organization_name: 'org', space_name: 'dev' } }];
    if (flags.environment === 'cloudfoundry' && command === 'list services/offering') return [{ id: 'o-xsuaa', name: 'xsuaa' }];
    if (flags.environment === 'cloudfoundry' && command === 'list services/plan') return [{ id: 'p-cf', name: 'application', service_offering_id: 'o-xsuaa' }];
    return undefined;
  }));
  const result = parse(await f.byName.btp_list_service_instances.handler({ subaccount: SA }));
  assert.deepEqual(pickRow(result.instances[0]), { offering: 'xsuaa', plan: 'application', space: 'dev', org: 'org' });
  assert.equal(f.calls.some(call => call.flags.environment === 'kubernetes'), false);
});

const pickRow = row => ({ offering: row.offering, plan: row.plan, space: row.space, org: row.org });

const KEY_CREDENTIALS = {
  clientid: 'sb-client!t1',
  clientsecret: 'never-emit-this-client-secret',
  url: 'https://auth.example',
  key: '-----BEGIN PRIVATE KEY-----never-emit-this-key',
  uri: 'postgres://u:never-emit-this-pw@host:5432/db'
};

test('service keys: list never returns credentials, get redacts secrets but keeps identifiers', async () => {
  const binding = { id: KEY_ID, name: 'k1', service_instance_id: INSTANCE_ID, ready: true, credentials: KEY_CREDENTIALS };
  const f = fixture(command => {
    if (command === 'list services/binding') return [binding];
    if (command === 'list services/instance') return [{ id: INSTANCE_ID, name: 'db' }];
    if (command === 'get services/binding') return binding;
    return undefined;
  });
  const listed = await f.byName.btp_list_service_keys.handler({ subaccount: SA });
  assert.equal(textOf(listed).includes('credentials'), false);
  assert.equal(parse(listed).service_keys[0].instance_name, 'db');

  const got = await f.byName.btp_get_service_key.handler({ subaccount: SA, name: 'k1' });
  const { credentials } = parse(got);
  assert.equal(credentials.clientsecret, '[redacted]');
  assert.equal(credentials.key, '[redacted]');
  assert.equal(credentials.uri, 'postgres://[redacted]@host:5432/db');
  assert.equal(credentials.url, 'https://auth.example');
  assert.equal(credentials.clientid, 'sb-client!t1');
  assert.equal(textOf(got).includes('never-emit-this'), false);
});

test('get destination redacts Password, clientSecret and jco.client.passwd', async () => {
  const f = fixture(command => (command === 'get connectivity/destination' ? {
    systemMetadata: { creation_time: 't1', modification_time: 't2', etag: 'x' },
    destinationConfiguration: { Name: 'S4', URL: 'https://s4.example', Password: 'pw-1', clientSecret: 'cs-1', 'jco.client.passwd': 'jco-1', User: 'ALICE' }
  } : undefined));
  const result = await f.byName.btp_get_destination.handler({ subaccount: SA, name: 'S4' });
  const { destination, system_metadata: metadata } = parse(result);
  assert.equal(destination.URL, 'https://s4.example');
  assert.equal(destination.Password, '[redacted]');
  assert.equal(destination.clientSecret, '[redacted]');
  assert.equal(destination['jco.client.passwd'], '[redacted]');
  assert.deepEqual(metadata, { creation_time: 't1', modification_time: 't2' });
  for (const secret of ['pw-1', 'cs-1', 'jco-1']) assert.equal(textOf(result).includes(secret), false);
});

test('entitlements: global account scope omits assignments and icons; subaccount scope keeps only its own rows', async () => {
  const payload = {
    entitledServices: [{ name: 'hana-cloud', iconBase64: 'ICON', servicePlans: [{ name: 'hana', category: 'SERVICE', amount: 10, remainingAmount: 4, unlimited: false, dataCenters: [{ region: 'eu10' }] }] }],
    ...entitlement({})
  };
  const global = fixture(command => (command === 'list accounts/entitlement' ? payload : undefined));
  const ga = await global.byName.btp_list_entitlements.handler({});
  assert.equal(textOf(ga).includes('ICON') || textOf(ga).includes('iconBase64') || textOf(ga).includes('dataCenters'), false);
  const gaResult = parse(ga);
  assert.deepEqual(gaResult.scope, { type: 'global-account', id: null });
  assert.match(gaResult.assignments_omitted, /pass service/);
  assert.equal(gaResult.entitled[0].remaining, 4);
  assert.deepEqual(global.calls[0].flags, {});

  const sub = fixture(command => (command === 'list accounts/entitlement' ? payload : undefined));
  const subResult = parse(await sub.byName.btp_list_entitlements.handler({ subaccount: SA }));
  assert.equal(subResult.assigned.length, 1);
  assert.equal(subResult.assigned[0].amount, 2);
  assert.equal(subResult.entitled, undefined);

  const both = await sub.byName.btp_list_entitlements.handler({ subaccount: SA, directory: OTHER_SA }).catch(error => error);
  assert.match(String(both.message ?? textOf(both)), /provide at most one of subaccount, directory/);
});

/** Subaccount with a Connectivity api_access instance whose key points at the fake tenant. */
async function connectivityFixture(t, destination) {
  const tenant = await startFakeTenant(t, request => (request.path === '/api/v1/scc'
    ? { status: 200, json: [{ attributes: { location_id: 'LOC1', connected_by: 'admin', connected_since: '1767225600000', agent_version: '2.18.0', exposed_systems: JSON.stringify([{ protocol: 'HTTPS', host: 's4h-virtual:44300', status: 'reachable', type: 'abapSys' }]) } }] }
    : undefined));
  const credentials = {
    clientid: 'sb-conn',
    clientsecret: 'never-emit-this-connectivity-secret',
    token_service_url: tenant.url,
    connectivity_service: { url: tenant.url, scc_info_path: '/api/v1/scc' }
  };
  const f = fixture(catalogResponder(command => {
    if (command === 'get connectivity/destination') return { destinationConfiguration: destination };
    if (command === 'list security/trust') return [{ originKey: 'sap.custom', status: 'Active' }, { originKey: 'sap.default', status: 'inactive' }];
    if (command === 'list services/instance') return [{ id: INSTANCE_ID, name: 'conn', service_plan_id: 'p-api' }];
    if (command === 'list services/binding') return [{ id: KEY_ID, name: 'conn-key', service_instance_id: INSTANCE_ID, ready: true }];
    if (command === 'get services/binding') return { id: KEY_ID, name: 'conn-key', service_instance_id: INSTANCE_ID, credentials };
    return undefined;
  }));
  return { f, tenant };
}

test('check destination verifies a principal-propagation OnPremise destination against the Connectivity API', async t => {
  const destination = { Name: 'S4', Type: 'HTTP', URL: 'http://s4h-virtual:44300', Authentication: 'PrincipalPropagation', ProxyType: 'OnPremise', CloudConnectorLocationId: 'LOC1' };
  const { f, tenant } = await connectivityFixture(t, destination);
  const result = await f.byName.btp_check_destination.handler({ subaccount: SA, name: 'S4' });
  const body = parse(result);
  const status = Object.fromEntries(body.checks.map(check => [check.id, check.status]));
  assert.equal(status.proxy_type, 'pass');
  assert.equal(status.cloud_connector, 'pass');
  assert.equal(status.exposed_system, 'pass');
  assert.equal(status.identity_provider_trust, 'pass');
  assert.equal(status.cloud_connector_principal_propagation, 'unknown');
  assert.match(body.checks.find(check => check.id === 'identity_provider_trust').detail, /sap\.custom/);
  assert.equal(textOf(result).includes('never-emit-this'), false);
  assert.equal(tenant.apiRequests()[0].headers.authorization, 'Bearer token-1');
  assert.equal(f.calls.find(call => call.command === 'list services/binding').flags['fields-filter'], `service_instance_id eq '${INSTANCE_ID}'`);

  const internet = await connectivityFixture(t, { ...destination, ProxyType: 'Internet' });
  const internetBody = parse(await internet.f.byName.btp_check_destination.handler({ subaccount: SA, name: 'S4' }));
  assert.equal(internetBody.checks.find(check => check.id === 'proxy_type').status, 'fail');
});

test('list cloud connectors without an api_access instance explains how to create one', async () => {
  const f = fixture(catalogResponder(command => (command === 'list services/instance' ? [] : undefined)));
  const result = await f.byName.btp_list_cloud_connectors.handler({ subaccount: SA });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No Connectivity service instance with plan api_access/);
});

test('get trust computes days left from a seconds-based expiry', async () => {
  const expirySeconds = (NOW + 10.5 * 86_400_000) / 1000;
  const f = fixture(command => {
    if (command === 'list security/trust') return [{ originKey: 'sap.default', status: 'Active', name: 'SAP ID', extra: 'dropped' }];
    if (command === 'get connectivity/destination-trust') return { Name: 'trust', active: true, expirationTimestamp: expirySeconds, x509PublicKeyBase64: 'CERT' };
    return undefined;
  });
  const body = parse(await f.byName.btp_get_trust.handler({ subaccount: SA }));
  assert.equal(body.destination_trust.days_left, 10);
  assert.equal(body.destination_trust.expires_at, new Date(expirySeconds * 1000).toISOString());
  assert.equal(body.destination_trust.certificate_base64, undefined);
  assert.equal(body.identity_providers[0].extra, undefined);
  assert.equal(f.calls.find(call => call.command === 'get connectivity/destination-trust').flags.active, true);
});
