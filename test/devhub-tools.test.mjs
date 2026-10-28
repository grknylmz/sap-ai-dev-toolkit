import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { redactPrivateValues, runApiProxyGet } from '../src/apim-runtime.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const DATA = '/odata/1.0/data.svc';
const KEY = 'private-consumer-key-123';
const SECRET = 'private-consumer-secret-456';
const createArgs = {
  application_id: 'Consumer', developer_id: 'developer', title: 'Consumer', products: ['Product'],
  confirmation: 'CREATE CONSUMER APPLICATION Consumer'
};

async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/sap-ai-dev-toolkit-test', DEVHUB_SERVICE_KEY: tenant.serviceKey() } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'developer-hub-behavior', version: '1' });
  await runtime.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return client;
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content[0].text;
  assert.equal(text.includes(KEY) || text.includes(SECRET), false, 'application credentials leaked');
  return { error: response.isError === true, text, data: response.isError ? null : JSON.parse(text) };
}

test('onboarding approval permits subscribed application creation without returning its generated credentials', async t => {
  let registered = false;
  let approved = false;
  let app = null;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/api/1.0/registrations' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      registered = body.userId === 'developer' && body.rolesAccess[0].role === 'API_ApplicationDeveloper';
      return { status: registered ? 201 : 400, json: {} };
    }
    if (request.path === '/api/1.0/registrations/developer' && request.method === 'PUT') {
      const role = JSON.parse(request.body).rolesAccess[0];
      approved = registered && role.status === 'registered' && role.role === 'API_ApplicationDeveloper';
      return { status: approved ? 204 : 400 };
    }
    if (request.path === `${DATA}/APIMgmt.APIProducts('Product')`) return { status: 200, json: { d: { name: 'Product' } } };
    if (request.path === `${DATA}/APIMgmt.Applications` && request.method === 'GET') {
      return { status: 200, json: { d: { results: app ? [{ id: app.id }] : [] } } };
    }
    if (request.path === `${DATA}/APIMgmt.Applications` && request.method === 'POST') {
      const body = JSON.parse(request.body);
      if (!approved || body.developer_id !== 'developer') return { status: 403 };
      const product = body.ToSubscriptions[0].ToAPIProduct[0].__metadata.uri;
      if (product !== "APIMgmt.APIProducts('Product')") return { status: 400 };
      app = { ...body, app_key: KEY, app_secret: SECRET, ToSubscriptions: { results: [{ id: 'sub1', product_id: 'Product', status: 'approved', isSubscribed: true }] } };
      return { status: 201, json: { d: app } };
    }
    if (request.path === `${DATA}/APIMgmt.Applications('Consumer')`) return { status: 200, json: { d: app } };
    return { status: 404 };
  });
  const client = await connect(t, tenant);
  const beforeApproval = await call(client, 'devhub_create_application', createArgs);
  assert.equal(beforeApproval.error, true);
  assert.match(beforeApproval.text, /HTTP 403/);
  const onboarded = await call(client, 'devhub_create_developer', {
    user_id: 'developer', first_name: 'API', last_name: 'Owner', email: 'api-owner@example.com', reason: 'API consumer', confirmation: 'CREATE DEVELOPER developer'
  });
  assert.equal(onboarded.data.approval_required, true);
  const accepted = await call(client, 'devhub_approve_developer', { user_id: 'developer', reason: 'Approved API consumer', confirmation: 'APPROVE DEVELOPER developer' });
  assert.equal(accepted.data.approved, true);
  const created = await call(client, 'devhub_create_application', createArgs);
  assert.equal(created.data.created, true);
  assert.equal(created.data.application.has_consumer_key, true);
  assert.equal(created.data.application.ToSubscriptions[0].product_id, 'Product');
  const duplicate = await call(client, 'devhub_create_application', createArgs);
  assert.equal(duplicate.error, true);
  assert.match(duplicate.text, /already exists/);
  const read = await call(client, 'devhub_get_application', { application_id: 'Consumer' });
  assert.equal(read.data.has_consumer_key, true);
  assert.equal(read.data.ToSubscriptions[0].status, 'approved');
  assert.equal('app_key' in read.data || 'app_secret' in read.data, false);
});

test('Developer Hub writes require their own exact confirmations before any network access', async t => {
  const tenant = await startFakeTenant(t);
  const client = await connect(t, tenant);
  const operations = [
    ['devhub_create_developer', { user_id: 'developer', first_name: 'A', last_name: 'B', email: 'a@example.com', reason: 'Test' }],
    ['devhub_approve_developer', { user_id: 'developer', reason: 'Test' }],
    ['devhub_create_application', createArgs],
    ['devhub_subscribe_application', { application_id: 'Consumer', product: 'Product' }]
  ];
  for (const [name, args] of operations) {
    const result = await call(client, name, { ...args, confirmation: 'UNAPPROVED' });
    assert.equal(result.error, true);
    assert.match(result.text, /confirmation must equal/);
  }
  assert.deepEqual(tenant.requests, []);
});

test('unavailable products cannot create applications and private error bodies are withheld', async t => {
  let applicationWrites = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.method === 'POST') applicationWrites++;
    if (request.path === `${DATA}/APIMgmt.Applications`) return { status: 200, json: { d: { results: [] } } };
    if (request.path.includes('APIMgmt.APIProducts')) return { status: 404 };
    return { status: 400, json: { error: { message: { value: `diagnostic accidentally contains ${KEY} and ${SECRET}` } } } };
  });
  const client = await connect(t, tenant);
  const missing = await call(client, 'devhub_create_application', createArgs);
  assert.equal(missing.error, true);
  assert.match(missing.text, /product Product is not available/);
  assert.equal(applicationWrites, 0);
  const failedRead = await call(client, 'devhub_get_application', { application_id: 'Consumer' });
  assert.equal(failedRead.error, true);
  assert.match(failedRead.text, /HTTP 400.*withheld/);
});

test('pending subscriptions are reported, not duplicated or silently approved', async t => {
  let subscriptionWrites = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${DATA}/APIMgmt.Applications('Consumer')`) return {
      status: 200, json: { d: { id: 'Consumer', app_key: KEY, app_secret: SECRET, ToSubscriptions: { results: [{ id: 'sub1', product_id: 'Product', status: 'pending', isSubscribed: false }] } } }
    };
    if (request.path === `${DATA}/APIMgmt.Subscriptions` && request.method === 'POST') {
      subscriptionWrites++;
      return { status: 201 };
    }
    return { status: 404 };
  });
  const client = await connect(t, tenant);
  const result = await call(client, 'devhub_subscribe_application', {
    application_id: 'Consumer', product: 'Product', confirmation: 'SUBSCRIBE APPLICATION Consumer TO Product'
  });
  assert.equal(result.error, true);
  assert.match(result.text, /already has a subscription/);
  assert.equal(subscriptionWrites, 0);
  const read = await call(client, 'devhub_get_application', { application_id: 'Consumer' });
  assert.equal(read.data.ToSubscriptions[0].status, 'pending');
});

const deployedApim = (runtime = 'https://runtime.example/s4/product/v1') => ({
  request: async () => ({ state: 'DEPLOYED', publishUrl: runtime, proxyEndPoints: [{ virtualhosts: [{ virtual_host: 'runtime.example' }] }] })
});

test('private-key API reads cannot escape the proxy path or follow redirects', async () => {
  let calls = 0;
  const options = { apim: deployedApim(), consumerKey: KEY, proxyName: 'Product', env: {}, fetchImpl: async () => { calls++; return new Response(KEY, { status: 302, headers: { location: 'https://attacker.example' } }); } };
  for (const path of ['//attacker.example', '/../outside', '/%2foutside', '/Products?apikey=x', '/Products/Secret']) {
    await assert.rejects(runApiProxyGet({ ...options, path }), /read path/);
  }
  await assert.rejects(runApiProxyGet({ ...options, path: '/Products', query: { $top: 11 } }), /between 1 and 10/);
  assert.equal(calls, 0);
  await assert.rejects(runApiProxyGet({ ...options, path: '/$metadata' }), error => {
    assert.match(error.message, /HTTP 302/);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('API smoke summaries hide response values and reflected keys and reject unbounded collections', async () => {
  const options = { apim: deployedApim(), consumerKey: KEY, proxyName: 'Product', env: {}, path: '/Products' };
  const summary = await runApiProxyGet({ ...options, fetchImpl: async () => new Response(JSON.stringify({ d: { results: [{ Product: 'private-business-value', [KEY]: 'echo' }] } }), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(summary.returned, 1);
  assert.deepEqual(summary.fields, ['Product', '[redacted]']);
  assert.equal(JSON.stringify(summary).includes('private-business-value') || JSON.stringify(summary).includes(KEY), false);
  await assert.rejects(runApiProxyGet({ ...options, fetchImpl: async () => new Response(JSON.stringify({ value: [{ Product: '1' }, { Product: '2' }] })) }), /did not honor/);
  await assert.rejects(runApiProxyGet({ ...options, consumerKey: '' }), /exactly one private/);
  await assert.rejects(runApiProxyGet({ ...options, apim: deployedApim('http://attacker.example') }), /HTTPS/);
});

test('private-value redaction cannot corrupt JSON syntax or scalar literals', () => {
  const value = {
    status: 200, approved: true, optional: null,
    '200': 'reflected 200', nested: [200, true, null, 'literal " credential']
  };
  assert.deepEqual(redactPrivateValues(value, ['200', 'true', 'null', '"']), {
    status: '[redacted]', approved: '[redacted]', optional: '[redacted]',
    '[redacted]': 'reflected [redacted]', nested: ['[redacted]', '[redacted]', '[redacted]', 'literal [redacted] credential']
  });
  assert.equal(value.status, 200, 'redaction must not mutate the response');
});

test('numeric consumer keys can be used privately without corrupting API summaries', async () => {
  const summary = await runApiProxyGet({
    apim: deployedApim(), consumerKey: '200', proxyName: 'Product', env: {}, path: '/Products',
    fetchImpl: async () => new Response(JSON.stringify({ value: [{ Product: 'private-value', 200: 'reflected-key' }] }))
  });
  assert.equal(summary.status, '[redacted]');
  assert.deepEqual(summary.fields, ['[redacted]', 'Product']);
  assert.equal(JSON.stringify(summary).includes('200'), false);
});

test('application and subscription summaries redact reflected credentials without corrupting scalars', async t => {
  const privateKey = '201';
  const privateSecret = 'true';
  const tenant = await startFakeTenant(t, request => {
    if (request.path === `${DATA}/APIMgmt.Applications('Consumer')`) return {
      status: 200, json: { d: { id: 'Consumer', version: 201, app_key: privateKey, app_secret: privateSecret, ToSubscriptions: { results: [] } } }
    };
    if (request.path === `${DATA}/APIMgmt.Subscriptions` && request.method === 'POST') return {
      status: 201, json: { d: { id: 'sub1', description: `reflected ${privateKey} ${privateSecret}`, status_code: 201, approved: true } }
    };
    return { status: 404 };
  });
  const client = await connect(t, tenant);
  const read = await call(client, 'devhub_get_application', { application_id: 'Consumer' });
  assert.equal(read.error, false);
  assert.equal(read.data.version, '[redacted]');
  assert.equal(read.data.has_consumer_key, '[redacted]');
  const subscribed = await call(client, 'devhub_subscribe_application', {
    application_id: 'Consumer', product: 'Product', confirmation: 'SUBSCRIBE APPLICATION Consumer TO Product'
  });
  assert.equal(subscribed.error, false);
  assert.equal(subscribed.data.subscription.description, 'reflected [redacted] [redacted]');
  assert.equal(subscribed.data.subscription.status_code, '[redacted]');
  assert.equal(subscribed.data.subscription.approved, '[redacted]');
});

test('developer registrations are locally paged and expose roles without personal details', async t => {
  const personal = ['person@example.test', 'PrivateFirstName', 'PrivateLastName', 'PrivateCountry', 'PrivateReason'];
  const developers = Array.from({ length: 205 }, (_, index) => ({
    id: `registration-${index}`, userId: personal[0], firstName: personal[1], lastName: personal[2],
    emailId: personal[0], country: personal[3], password: SECRET,
    rolesAccess: [{ role: 'API_ApplicationDeveloper', status: 'registered', requestReason: personal[4], accessToken: KEY }]
  }));
  const tenant = await startFakeTenant(t, request => {
    if (request.path !== '/api/1.0/registrations') return { status: 404 };
    assert.deepEqual([...request.query], [['type', 'registered']]);
    return { status: 200, json: developers };
  });
  const client = await connect(t, tenant);
  const first = await call(client, 'devhub_list_developers');
  assert.equal(first.error, false, first.text);
  assert.equal(first.data.returned, 100);
  assert.equal(first.data.total, null);
  assert.equal(first.data.complete, false);
  assert.deepEqual(first.data.items[0], {
    id: 'registration-0', roles: [{ role: 'API_ApplicationDeveloper', status: 'registered' }]
  });
  const last = await call(client, 'devhub_list_developers', { cursor: first.data.next_cursor, top: 200 });
  assert.equal(last.error, false, last.text);
  assert.equal(last.data.returned, 105);
  assert.equal(last.data.complete, true);
  assert.equal(last.data.next_cursor, null);
  assert.deepEqual([...first.data.items, ...last.data.items].map(item => item.id), developers.map(item => item.id));
  for (const detail of personal) assert.equal((first.text + last.text).includes(detail), false, `${detail} leaked`);
});

test('application listings resume counted pages and omit credentials and developer personal details', async t => {
  const personal = ['owner@example.test', 'private callback detail', 'private application description'];
  const apps = Array.from({ length: 25 }, (_, index) => ({
    id: `Consumer${String(index).padStart(2, '0')}`, title: 'Consumer', version: '1', status: 'approved',
    developer_id: personal[0], callbackurl: `https://example.test/?private=${personal[1]}`, description: personal[2],
    app_key: KEY, app_secret: SECRET, ToSubscriptions: [{ developer_email: personal[0], app_secret: SECRET }]
  }));
  const tenant = await startFakeTenant(t, request => {
    if (request.path !== `${DATA}/APIMgmt.Applications`) return { status: 404 };
    const skip = Number(request.query.get('$skip') ?? 0);
    const size = Math.min(Number(request.query.get('$top') ?? 100), 3);
    return { status: 200, json: { d: { __count: '25', results: apps.slice(skip, skip + size) } } };
  });
  const client = await connect(t, tenant);
  const ids = [];
  let cursor;
  do {
    const result = await call(client, 'devhub_list_applications', { top: 3, ...(cursor ? { cursor } : {}) });
    assert.equal(result.error, false, result.text);
    const page = result.data;
    assert.equal(page.total, 25);
    assert.equal(page.returned, page.items.length);
    assert.equal(page.complete, page.next_cursor === null);
    assert.equal(page.stop_reason, page.complete ? 'end' : 'more');
    for (const detail of personal) assert.equal(result.text.includes(detail), false, `${detail} leaked`);
    for (const item of page.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'status', 'title', 'version']);
    ids.push(...page.items.map(item => item.id));
    cursor = page.next_cursor;
    assert.ok(ids.length <= 25, 'listing must make forward progress without duplicates');
  } while (cursor);
  assert.deepEqual(ids, apps.map(app => app.id));
});

test('invalid collection cursors and out-of-range top are rejected before network access', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 500 }));
  const client = await connect(t, tenant);
  const before = tenant.apiRequests().length;
  for (const name of ['devhub_list_developers', 'devhub_list_applications']) {
    assert.equal((await call(client, name, { cursor: 'forged-cursor', top: 3 })).error, true);
    assert.equal((await call(client, name, { top: 201 })).error, true);
    assert.equal((await call(client, name, { top: '3' })).error, true);
  }
  assert.equal(tenant.apiRequests().length, before);
});
