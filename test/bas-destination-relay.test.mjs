import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { createBasDestinationRelay } from '../src/bas-destination-relay.mjs';

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Simulates SAP ADT semantics: a CSRF token is only valid when the unsafe
// request carries BOTH the token and the session cookies that were set
// together with it. This reproduces the 403 "CSRF token validation failed"
// seen on the BAS .dest proxy path before the relay paired sessions.
function sapLikeBackend({ neverAcceptUnsafe = false, rotateOnFetch = false } = {}) {
  const state = { sessionCounter: 0, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    if (req.method === 'GET' && req.headers['x-csrf-token'] === 'Fetch') {
      state.sessionCounter += 1;
      res.writeHead(200, {
        'x-csrf-token': `token-${state.sessionCounter}`,
        'set-cookie': [`sap-session-${state.sessionCounter}=s${state.sessionCounter}; path=/`, 'sap-usercontext=sap-client=100; path=/']
      });
      res.end('<ok/>');
      return;
    }
    if (UNSAFE_METHODS.includes(req.method)) {
      if (neverAcceptUnsafe) {
        res.writeHead(403, { 'x-csrf-token': 'Required' });
        res.end('CSRF token validation failed');
        return;
      }
      const token = req.headers['x-csrf-token'];
      const cookie = String(req.headers.cookie || '');
      const match = String(token || '').match(/^token-(\d+)$/);
      // Without rotation any still-live token+cookie pair is accepted; with
      // rotation only the newest issued session remains valid, matching SAP
      // server-side session invalidation.
      const valid = match && cookie.includes(`sap-session-${match[1]}=`) && (!rotateOnFetch || Number(match[1]) === state.sessionCounter);
      if (!valid) {
        res.writeHead(403, { 'x-csrf-token': 'Required' });
        res.end('CSRF token validation failed');
        return;
      }
      res.writeHead(201);
      res.end('<created/>');
      return;
    }
    res.writeHead(200);
    res.end('<read/>');
  });
  return { state, server };
}

async function startServer(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function relayFetch(relayUrl, path, options = {}) {
  const target = new URL(path, relayUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method: options.method || 'GET', headers: options.headers || {} }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function withBackend(options, handler) {
  const { state, server } = sapLikeBackend(options || {});
  const backendPort = await startServer(server);
  const logs = [];
  const relay = createBasDestinationRelay(
    { name: 'TEST', url: `http://127.0.0.1:${backendPort}`, authentication: 'BasicAuthentication' },
    {
      env: { HTTP_PROXY: '' },
      fetchImpl: options?.fetchImpl || ((url, init) => globalThis.fetch(url, init)),
      log: message => logs.push(message)
    }
  );
  const relayUrl = await relay.ready;
  try {
    return await handler({ state, relay, relayUrl, logs });
  } finally {
    await relay.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('pairs CSRF token with its session cookies so unsafe requests succeed', async () => {
  await withBackend(null, async ({ relayUrl, state }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', headers: { accept: 'application/xml' }, body: '<x/>' });
    assert.equal(response.status, 201, `expected 201, got ${response.status}: ${response.body}`);
    const post = state.requests.find(request => request.method === 'POST');
    assert.match(post.headers['x-csrf-token'], /^token-\d+$/);
    assert.match(String(post.headers.cookie), /sap-session-\d+=/);
  });
});

test('reuses the cached CSRF session for subsequent unsafe requests', async () => {
  await withBackend(null, async ({ relay, relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<y/>' });
    const fetches = state.requests.filter(request => request.headers['x-csrf-token'] === 'Fetch');
    assert.equal(fetches.length, 1, 'second POST must reuse the cached session');
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 2);
    assert.equal(relay.stats.csrfFetches, 1);
    assert.equal(relay.stats.csrfRetries, 0);
  });
});

test('self-heals when SAP rotates the session: refetches token and cookies', async () => {
  await withBackend({ rotateOnFetch: true }, async ({ relay, relayUrl, state }) => {
    // A first POST establishes session token-1. SAP then invalidates it
    // server-side (simulated by the rotation rule below).
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    state.sessionCounter += 1;
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<y/>' });
    assert.equal(response.status, 201, `rotated session must heal via refetch, got ${response.status}`);
    assert.ok(relay.stats.csrfRetries >= 1, 'a retry must have been counted');
    const fetches = state.requests.filter(request => request.headers['x-csrf-token'] === 'Fetch');
    assert.ok(fetches.length >= 2, 'a fresh token fetch must have occurred');
  });
});

test('stops retrying after bounded attempts and surfaces the failure', async () => {
  await withBackend({ neverAcceptUnsafe: true }, async ({ relay, relayUrl, state }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(response.status, 403);
    const attempts = state.requests.filter(request => UNSAFE_METHODS.includes(request.method));
    assert.equal(attempts.length, 1 + 3, 'one initial try plus three bounded retries');
    assert.equal(relay.stats.csrfRetries, 3);
  });
});

test('GET requests pass through without CSRF handling', async () => {
  await withBackend(null, async ({ relayUrl, state, relay }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/discovery', { headers: { accept: 'application/xml' } });
    assert.equal(response.status, 200);
    assert.equal(state.requests.filter(request => request.headers['x-csrf-token']).length, 0);
    assert.equal(relay.stats.csrfFetches, 0);
  });
});

test('drops POST body headers from the token-fetch GET', async () => {
  await withBackend(null, async ({ relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', {
      method: 'POST',
      headers: { accept: 'application/xml', 'content-type': 'application/xml', 'content-length': '5' },
      body: '<xy/>'
    });
    const fetchRequest = state.requests.find(request => request.headers['x-csrf-token'] === 'Fetch');
    assert.equal(fetchRequest.headers['content-type'], undefined, 'content-type must not leak into token GET');
    assert.equal(fetchRequest.headers['content-length'], undefined, 'content-length must not leak into token GET');
  });
});

test('falls back to a proxy tunnel when the absolute-form request is refused', async () => {
  const fetchCalls = [];
  const fetchImpl = (url, options = {}) => {
    fetchCalls.push({ url: String(url), tunneled: Boolean(options.dispatcher && options.dispatcher.proxyTunnel !== false && options.dispatcher.constructor?.name === 'ProxyAgent' && options.dispatcher.__tunnelMarker !== false) });
    // First call (absolute-form through proxy) is refused by the proxy itself.
    if (fetchCalls.length === 1) return Promise.resolve(new Response('<gateway/>', { status: 502 }));
    return Promise.resolve(new Response('<ok/>', { status: 200, headers: { 'x-csrf-token': 'tok' } }));
  };
  const { state, server } = sapLikeBackend();
  void state;
  const backendPort = await startServer(server);
  const relay = createBasDestinationRelay(
    { name: 'TEST', url: `http://127.0.0.1:${backendPort}`, authentication: 'BasicAuthentication' },
    { env: { HTTP_PROXY: 'http://127.0.0.1:1' }, fetchImpl, log: () => {} }
  );
  const relayUrl = await relay.ready;
  try {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/discovery');
    assert.equal(response.status, 200);
    assert.equal(relay.stats.tunnelFallbacks, 1, 'exactly one tunnel fallback must occur');
    assert.equal(fetchCalls.length, 2, 'absolute-form attempt then one tunnel retry');
  } finally {
    await relay.close();
    await new Promise(resolve => server.close(resolve));
  }
});
