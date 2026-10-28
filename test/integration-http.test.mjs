import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceClient, createStaticServiceClient } from '../src/integration-http.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const tokenReply = () => new Response(JSON.stringify({ access_token: 'private-token', expires_in: 3600 }));
const clientWith = fetchImpl => createServiceClient({
  label: 'CPI', url: 'https://tenant.example', tokenUrl: 'https://auth.example/oauth/token',
  clientId: 'private-id', clientSecret: 'private-secret', env: {}, fetchImpl
});
const isDeadline = error => error.code === 'INTEGRATION_DEADLINE' && error.stop_reason === 'deadline';

// These intentionally uncooperative transports exercise the race as well as the
// real fetch AbortSignal: neither token acquisition nor body reads may hang.
for (const phase of ['token request', 'token response read', 'HTTP request', 'response read', 'CSRF request']) {
  test(`absolute deadline bounds ${phase}`, async () => {
    const requests = [];
    let streamCancelled = false;
    const stalledBody = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { streamCancelled = true; }
    }));
    const client = clientWith(async (url, options) => {
      requests.push({ url: String(url), options });
      const token = String(url).includes('/oauth/token');
      if (token) {
        if (phase === 'token request') return new Promise(() => {});
        return phase === 'token response read' ? stalledBody() : tokenReply();
      }
      if (phase === 'CSRF request') {
        if (options.headers['x-csrf-token'] === 'Fetch') return new Promise(() => {});
        return new Response('', { status: 403, headers: { 'x-csrf-token': 'Required' } });
      }
      if (phase === 'HTTP request') return new Promise(() => {});
      return stalledBody();
    });
    const started = Date.now();
    await assert.rejects(client.request('GET', '/api/v1/Test', { deadline: started + 60 }), isDeadline);
    assert.ok(Date.now() - started < 1500, 'deadline must not wait for the per-attempt timeout');
    if (phase.endsWith('read')) assert.equal(streamCancelled, true);
    const stalled = requests.at(-1).options.signal;
    if (!phase.endsWith('read')) assert.equal(stalled.aborted, true);
  });
}

test('expired or invalid deadline makes no token or management request; origin is immutable and non-secret', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return tokenReply(); });
  assert.equal(client.origin, 'https://tenant.example');
  assert.throws(() => { client.origin = 'https://foreign.example'; }, TypeError);
  await assert.rejects(client.request('GET', '/api/v1/Test', { deadline: Date.now() - 1 }), isDeadline);
  await assert.rejects(client.request('GET', '/api/v1/Test', { deadline: NaN }), /absolute finite timestamp/);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(client), /private-/);
});

test('retry delay consumes the absolute deadline and retains the last source status', async () => {
  let calls = 0;
  const client = clientWith(async url => {
    if (String(url).includes('/oauth/token')) return tokenReply();
    calls += 1;
    return new Response('withheld', { status: 503 });
  });
  await assert.rejects(client.request('GET', '/api/v1/Test', { deadline: Date.now() + 60 }), error => {
    assert.equal(isDeadline(error), true);
    assert.equal(error.phase, 'retry delay');
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(calls, 1);
});

test('token recovery cannot reset the original deadline', async () => {
  let tokenCalls = 0;
  let reads = 0;
  const client = clientWith(async url => {
    if (String(url).includes('/oauth/token')) {
      tokenCalls += 1;
      return tokenCalls === 1 ? tokenReply() : new Promise(() => {});
    }
    reads += 1;
    return new Response('', { status: 401 });
  });
  await assert.rejects(client.request('GET', '/api/v1/Test', { deadline: Date.now() + 60 }), isDeadline);
  assert.equal(reads, 1);
  assert.equal(tokenCalls, 2);
});

test('a stalled error-body read retains HTTP evidence and does not swallow the deadline', async () => {
  const client = clientWith(async url => {
    if (String(url).includes('/oauth/token')) return tokenReply();
    return new Response(new ReadableStream({ start() {} }), { status: 503 });
  });
  await assert.rejects(client.request('POST', '/api/v1/Test', { deadline: Date.now() + 60 }), error => {
    assert.equal(isDeadline(error), true);
    assert.equal(error.status, 503);
    assert.equal(error.phase, 'response read');
    return true;
  });
});

test('real transport preserves GET/PUT retries and does not add mutation retries', async t => {
  const counts = new Map();
  const tenant = await startFakeTenant(t, request => {
    const attempt = (counts.get(request.method) ?? 0) + 1;
    counts.set(request.method, attempt);
    return attempt < 3 ? { status: 503, body: 'temporary' } : { status: 200, json: { done: true } };
  });
  const client = createServiceClient({
    label: 'CPI', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`,
    clientId: 'client', clientSecret: 'private-secret', env: {}, retryDelayMs: 1
  });
  for (const method of ['GET', 'PUT']) {
    assert.deepEqual(await client.request(method, '/test', { deadline: Date.now() + 5000 }), { done: true });
    assert.equal(counts.get(method), 3);
  }
  for (const method of ['POST', 'DELETE', 'PATCH']) {
    await assert.rejects(client.request(method, '/test', { deadline: Date.now() + 5000 }), /HTTP 503/);
    assert.equal(counts.get(method), 1);
  }
});

test('real transport preserves one authentication and CSRF recovery within the deadline', async t => {
  let attempts = 0;
  const tenant = await startFakeTenant(t, request => {
    if (request.headers['x-csrf-token'] === 'Fetch') return {
      status: 200, headers: { 'x-csrf-token': 'csrf-private', 'set-cookie': 'session=private; HttpOnly' }
    };
    attempts += 1;
    if (attempts === 1) return { status: 401 };
    if (attempts === 2) return { status: 403, headers: { 'x-csrf-token': 'Required' } };
    assert.equal(request.headers['x-csrf-token'], 'csrf-private');
    assert.equal(request.headers.cookie, 'session=private');
    return { status: 200, json: { done: true } };
  });
  const client = createServiceClient({
    label: 'CPI', url: tenant.url, tokenUrl: `${tenant.url}/oauth/token`,
    clientId: 'client', clientSecret: 'private-secret', csrfPath: '/api/v1/', env: {}
  });
  assert.deepEqual(await client.request('POST', '/test', { deadline: Date.now() + 5000 }), { done: true });
  assert.equal(attempts, 3);
  assert.equal(tenant.tokenRequests().length, 2);
});

test('accepted mutation responses retain HTTP evidence when body reading or parsing fails without resending', async () => {
  for (const oversized of [false, true]) {
    let mutations = 0;
    const client = clientWith(async url => {
      if (String(url).includes('/oauth/token')) return tokenReply();
      mutations += 1;
      return new Response('not-json', { status: 201, headers: oversized ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {} });
    });
    await assert.rejects(client.request('POST', '/accepted', { expect: [201] }), error => {
      assert.equal(error.status, 201);
      assert.equal(typeof error.phase, 'string');
      return true;
    });
    assert.equal(mutations, 1);
  }
});

test('bodyless acceptance cancels an unneeded stalled mutation body without losing HTTP status', async () => {
  let cancelled = false;
  let mutations = 0;
  const client = clientWith(async url => {
    if (String(url).includes('/oauth/token')) return tokenReply();
    mutations += 1;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 202 });
  });
  const outcome = await client.request('POST', '/accepted', { expect: [202], responseType: 'none', withStatus: true, deadline: Date.now() + 200 });
  assert.equal(outcome.status, 202);
  assert.equal(cancelled, true);
  assert.equal(mutations, 1);
});

test('static Basic, Bearer, and custom private authorization use the real pinned transport', async t => {
  const tenant = await startFakeTenant(t, request => ({
    status: 200, json: { path: request.path }
  }));
  for (const [authorization, expected] of [
    [() => `Basic ${Buffer.from('private-user:private-password').toString('base64')}`, `Basic ${Buffer.from('private-user:private-password').toString('base64')}`],
    [() => 'Bearer private-api-token', 'Bearer private-api-token'],
    [({ method, path }) => `User private-user, Organization private-org, Action ${method}:${path}`, 'User private-user, Organization private-org, Action GET:/elements/api-v2/instances']
  ]) {
    const client = createStaticServiceClient({ label: 'optional', url: `${tenant.url}/elements/api-v2`, authorization, env: {} });
    assert.deepEqual(await client.request('GET', '/instances'), { path: '/elements/api-v2/instances' });
    assert.equal(tenant.apiRequests().at(-1).headers.authorization, expected);
    assert.equal(client.origin, tenant.url);
    assert.throws(() => { client.origin = 'https://foreign.example'; }, TypeError);
    assert.doesNotMatch(JSON.stringify(client), /private-/);
  }
  assert.equal(tenant.tokenRequests().length, 0);
});

test('static authorization is private and failed closures cannot leak their input or errors', async () => {
  let requests = 0;
  assert.throws(() => createStaticServiceClient({ authorization: 'Bearer private-token' }), /private function/);
  for (const authorization of [
    () => { throw new Error('private-user private-password'); },
    () => 'Bearer private-token\r\nx-secret: private-value',
    () => null
  ]) {
    const client = createStaticServiceClient({
      label: 'ANS', url: 'https://optional.example', authorization, env: {},
      fetchImpl: async () => { requests += 1; return new Response('{}'); }
    });
    await assert.rejects(client.request('GET', '/test'), error => {
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private-user|private-password|private-token|private-value/);
      return /authorization/.test(error.message);
    });
  }
  assert.equal(requests, 0);
});

test('static origin escapes and undocumented response headers fail before authorization or network access', async () => {
  let authorizations = 0;
  let requests = 0;
  const client = createStaticServiceClient({
    label: 'ANS', url: 'https://optional.example', env: {},
    authorization: () => { authorizations += 1; return 'Basic private'; },
    fetchImpl: async () => { requests += 1; return new Response('{}'); }
  });
  await assert.rejects(client.request('GET', '@foreign.example/test'), /escaped/);
  for (const responseHeaders of [['set-cookie'], ['authorization'], ['x-arbitrary'], true, 'nextpage']) {
    await assert.rejects(client.request('GET', '/test', { responseHeaders }), /documented pagination/);
  }
  await assert.rejects(client.request('GET', '/test', { deadline: Date.now() - 1 }), isDeadline);
  await assert.rejects(client.request('GET', '/test', { deadline: NaN }), /absolute finite timestamp/);
  assert.equal(authorizations, 0);
  assert.equal(requests, 0);
});

test('static redirects are never followed, and error bodies are always withheld', async t => {
  const foreign = await startFakeTenant(t, () => ({ status: 200, json: { unexpected: true } }));
  const tenant = await startFakeTenant(t, request => request.path === '/redirect'
    ? { status: 302, headers: { location: `${foreign.url}/stolen` }, body: 'private-token' }
    : { status: 400, json: { password: 'private-password', token: 'private-token', error: { message: 'private-user' } } });
  const client = createStaticServiceClient({
    label: 'ANS', url: tenant.url, authorization: () => 'Basic private-credentials', env: {}, exposeErrorDetails: true
  });
  for (const path of ['/redirect', '/error']) {
    await assert.rejects(client.request('GET', path), error => {
      assert.match(error.message, /response body withheld/);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-/);
      return error.status === (path === '/redirect' ? 302 : 400);
    });
  }
  assert.equal(foreign.requests.length, 0);
  assert.equal(tenant.tokenRequests().length, 0);
});

test('static broker cookies stay private, host-pinned, path-scoped, and can expire', async t => {
  const tenant = await startFakeTenant(t, request => {
    if (request.path === '/SEMP/v2/login') return {
      status: 200, json: { done: true },
      headers: { 'set-cookie': ['session=private-session; Path=/SEMP; HttpOnly', 'other=private-other; Path=/other'] }
    };
    if (request.path === '/SEMP/v2/logout') return {
      status: 200, json: { done: true }, headers: { 'set-cookie': 'session=; Path=/SEMP; Max-Age=0' }
    };
    return { status: 200, json: { done: true }, headers: { 'elements-next-page-token': 'page-2', nextPage: 'page-3', 'set-cookie': 'unrelated=private; Path=/not-this-path' } };
  });
  const client = createStaticServiceClient({
    label: 'SEMP', url: tenant.url, authorization: () => 'Basic private', reuseCookies: true, env: {}
  });
  await client.request('GET', '/SEMP/v2/login');
  const result = await client.request('GET', '/SEMP/v2/monitor', { withStatus: true, responseHeaders: ['elements-next-page-token', 'nextPage'] });
  assert.equal(tenant.apiRequests().at(-1).headers.cookie, 'session=private-session');
  assert.deepEqual(result, { status: 200, data: { done: true }, responseHeaders: { 'elements-next-page-token': 'page-2', nextpage: 'page-3' } });
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(client), /private|cookie/i);
  await client.request('GET', '/elsewhere');
  assert.equal(tenant.apiRequests().at(-1).headers.cookie, undefined);
  await client.request('GET', '/SEMP/v2/logout');
  await client.request('GET', '/SEMP/v2/monitor');
  assert.equal(tenant.apiRequests().at(-1).headers.cookie, undefined);
  const withoutCookies = createStaticServiceClient({ label: 'ANS', url: tenant.url, authorization: () => 'Basic private', env: {} });
  await withoutCookies.request('GET', '/SEMP/v2/login');
  await withoutCookies.request('GET', '/SEMP/v2/monitor');
  assert.equal(tenant.apiRequests().at(-1).headers.cookie, undefined);
});

test('real static transport shares response caps, deadlines, and accepted bodyless status evidence', async t => {
  const tenant = await startFakeTenant(t, async request => {
    if (request.path === '/slow') {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { status: 200, json: {} };
    }
    if (request.path === '/large-text') return { status: 201, body: 'x'.repeat(2 * 1024 * 1024 + 1) };
    if (request.path === '/large-bytes') return { status: 200, body: 'x', headers: { 'content-length': String(20 * 1024 * 1024 + 1) } };
    return { status: 202, body: 'not-json-private-body' };
  });
  const client = createStaticServiceClient({ label: 'ANS', url: tenant.url, authorization: () => 'Basic private', env: {} });
  await assert.rejects(client.request('GET', '/slow', { deadline: Date.now() + 60 }), isDeadline);
  for (const [path, responseType, expect] of [['/large-text', 'text', [201]], ['/large-bytes', 'bytes', [200]]]) {
    await assert.rejects(client.request('POST', path, { responseType, expect }), error => {
      assert.match(error.message, /safe size limit/);
      assert.equal(error.status, expect[0]);
      assert.equal(error.phase, 'response read');
      return true;
    });
  }
  assert.deepEqual(await client.request('POST', '/accepted', { expect: [202], responseType: 'none', withStatus: true }), { status: 202, data: null });
  assert.equal(tenant.apiRequests().filter(request => request.path === '/large-text').length, 1);
  assert.equal(tenant.apiRequests().filter(request => request.path === '/accepted').length, 1);
});

test('static transport retains GET/PUT retries but never adds mutation or OAuth/CSRF recovery', async t => {
  const attempts = new Map();
  const tenant = await startFakeTenant(t, request => {
    const key = `${request.method}:${request.path}`;
    attempts.set(key, (attempts.get(key) || 0) + 1);
    if (request.path === '/auth') return { status: 401 };
    if (request.path === '/csrf') return { status: 403, headers: { 'x-csrf-token': 'Required' } };
    return { status: 503 };
  });
  const client = createStaticServiceClient({
    label: 'ANS', url: tenant.url, authorization: () => 'Basic private', env: {}, retryDelayMs: 1
  });
  for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'PATCH']) {
    await assert.rejects(client.request(method, '/retry'), /HTTP 503/);
    assert.equal(attempts.get(`${method}:/retry`), ['GET', 'PUT'].includes(method) ? 3 : 1);
  }
  for (const path of ['/auth', '/csrf']) {
    await assert.rejects(client.request('POST', path), /response body withheld/);
    assert.equal(attempts.get(`POST:${path}`), 1);
  }
  assert.equal(tenant.tokenRequests().length, 0);
  assert.equal(tenant.apiRequests().some(request => request.headers['x-csrf-token'] === 'Fetch'), false);
});

test('a delayed backoff timer does not turn a recoverable response into a timeout', async t => {
  const originalTimer = globalThis.setTimeout;
  const delay = 5;
  let stalled = false;
  let attempts = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === delay && !stalled) {
      stalled = true;
      const end = performance.now() + 20;
      while (performance.now() < end) {}
    }
    return originalTimer(callback, milliseconds, ...args);
  });
  const client = createStaticServiceClient({
    label: 'ANS', url: 'https://retry.example', authorization: () => 'Basic private', env: {}, retryDelayMs: delay,
    fetchImpl: async () => ++attempts === 1 ? new Response('', { status: 503 }) : Response.json({ recovered: true })
  });
  const response = await client.request('GET', '/retry', { withStatus: true });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

for (const phase of ['authorization', 'HTTP request', 'response read']) {
  test(`static absolute deadline also bounds uncooperative ${phase}`, async () => {
    let cancelled = false;
    const client = createStaticServiceClient({
      label: 'ANS', url: 'https://optional.example', env: {},
      authorization: phase === 'authorization' ? () => new Promise(() => {}) : () => 'Basic private',
      fetchImpl: async () => phase === 'HTTP request' ? new Promise(() => {}) : new Response(new ReadableStream({
        cancel() { cancelled = true; }
      }), { status: 201 })
    });
    await assert.rejects(client.request('POST', '/test', { expect: [201], deadline: Date.now() + 60 }), error => {
      assert.equal(isDeadline(error), true);
      assert.equal(error.phase, phase);
      if (phase === 'response read') assert.equal(error.status, 201);
      return true;
    });
    if (phase === 'response read') assert.equal(cancelled, true);
  });
}

test('static bodyless acceptance and withheld errors discard stalled bodies without reading them', async () => {
  for (const status of [202, 400]) {
    let cancelled = false;
    let requests = 0;
    const client = createStaticServiceClient({
      label: 'ANS', url: 'https://optional.example', authorization: () => 'Basic private', env: {},
      fetchImpl: async () => {
        requests += 1;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
      }
    });
    if (status === 202) {
      assert.deepEqual(await client.request('POST', '/accepted', {
        expect: [202], responseType: 'none', withStatus: true, deadline: Date.now() + 200
      }), { status: 202, data: null });
    } else {
      await assert.rejects(client.request('POST', '/rejected', { deadline: Date.now() + 200 }), /HTTP 400.*body withheld/);
    }
    assert.equal(cancelled, true);
    assert.equal(requests, 1);
  }
});
