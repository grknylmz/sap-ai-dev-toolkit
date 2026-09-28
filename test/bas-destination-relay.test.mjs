import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { createBasDestinationRelay } from '../src/bas-destination-relay.mjs';

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Simulates SAP ADT semantics: a CSRF token is only valid when the unsafe
// request carries BOTH the token and the session cookies that were set
// together with it. This reproduces the 403 "CSRF token validation failed"
// seen on the BAS .dest proxy path before the relay paired sessions.
function sapLikeBackend({
  neverAcceptUnsafe = false,
  rotateOnFetch = false,
  genericForbidden = false,
  partialRefreshCookies = false,
  omitCookies = false,
  setCookieOnSafeGet = false,
  secureSessionCookie = false
} = {}) {
  const state = { sessionCounter: 0, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    if (req.method === 'GET' && req.headers['x-csrf-token'] === 'Fetch') {
      state.sessionCounter += 1;
      const headers = { 'x-csrf-token': `token-${state.sessionCounter}` };
      if (!omitCookies) {
        headers['set-cookie'] = [`sap-session-${state.sessionCounter}=s${state.sessionCounter}; path=/`];
        if (!partialRefreshCookies || state.sessionCounter === 1) {
          headers['set-cookie'].push('sap-usercontext=sap-client=100; path=/');
        }
        if (partialRefreshCookies) {
          headers['set-cookie'].push(state.sessionCounter === 1
            ? 'sap-stale=delete-me; path=/'
            : 'sap-stale=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/');
        }
        if (secureSessionCookie) headers['set-cookie'].push('sap-secure=secure-value; Secure; Path=/');
      }
      res.writeHead(200, headers);
      res.end('<ok/>');
      return;
    }
    if (req.method === 'GET' && req.url === '/sap/bc/adt/discovery' && setCookieOnSafeGet) {
      res.writeHead(200, { 'set-cookie': 'bas-read-session=kept; path=/sap/bc/adt' });
      res.end('<read/>');
      return;
    }
    if (UNSAFE_METHODS.includes(req.method)) {
      if (genericForbidden) {
        res.writeHead(403);
        res.end('User is not authorized to change this object');
        return;
      }
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
      const valid = match
        && cookie.includes(`sap-session-${match[1]}=`)
        && (!rotateOnFetch || Number(match[1]) === state.sessionCounter)
        && (!partialRefreshCookies || cookie.includes('sap-usercontext=sap-client=100'))
        && (!partialRefreshCookies || Number(match[1]) === 1 || !cookie.includes('sap-stale='));
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
      env: { HTTP_PROXY: '', ...(options?.env || {}) },
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

test('coalesces concurrent CSRF token fetches for the same ADT endpoint', async () => {
  await withBackend(null, async ({ relayUrl, state }) => {
    const responses = await Promise.all([
      relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' }),
      relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<y/>' })
    ]);
    assert.deepEqual(responses.map(response => response.status), [201, 201]);
    assert.equal(state.requests.filter(request => request.headers['x-csrf-token'] === 'Fetch').length, 1);
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 2);
  });
});

test('seeds the relay cookie jar from the incoming MCP request cookie', async () => {
  await withBackend(null, async ({ relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', {
      method: 'POST',
      headers: { cookie: 'sap-initial-session=from-vsp' },
      body: '<x/>'
    });
    const tokenFetch = state.requests.find(request => request.headers['x-csrf-token'] === 'Fetch');
    assert.match(String(tokenFetch.headers.cookie), /sap-initial-session=from-vsp/);
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

test('merges partial session-cookie updates and applies cookie deletion on refresh', async () => {
  await withBackend({ rotateOnFetch: true, partialRefreshCookies: true }, async ({ relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    state.sessionCounter += 1;
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<y/>' });
    assert.equal(response.status, 201, `partial cookie refresh must heal, got ${response.status}`);
    const posts = state.requests.filter(request => request.method === 'POST');
    assert.match(String(posts[2].headers.cookie), /sap-usercontext=sap-client=100/);
    assert.doesNotMatch(String(posts[2].headers.cookie), /sap-stale=/);
  });
});

test('retains cookies received on a safe GET for later CSRF requests', async () => {
  await withBackend({ setCookieOnSafeGet: true }, async ({ relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/discovery');
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(response.status, 201);
    const tokenFetch = state.requests.find(request => request.headers['x-csrf-token'] === 'Fetch');
    assert.match(String(tokenFetch.headers.cookie), /bas-read-session=kept/);
  });
});

test('does not retry generic authorization failures as CSRF errors', async () => {
  await withBackend({ genericForbidden: true }, async ({ relayUrl, relay, state }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(response.status, 403);
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(relay.stats.csrfRetries, 0);
  });
});

test('does not repeat a CSRF failure when SAP returns a token without session cookies', async () => {
  await withBackend({ omitCookies: true }, async ({ relayUrl, relay, state }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(response.status, 503, `unsafe calls must fail closed without a paired session, got ${response.status}`);
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 0);
    assert.equal(relay.stats.csrfRetries, 0);
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

test('honors the configured bounded CSRF retry count', async () => {
  await withBackend({ neverAcceptUnsafe: true, env: { SAP_AI_DEV_TOOLKIT_MAX_CSRF_RETRIES: '1' } }, async ({ relayUrl, relay, state }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(response.status, 403);
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 1 + 1);
    assert.equal(relay.stats.csrfRetries, 1);
  });
});

test('uses the default for invalid retry settings and caps excessive retry counts', async () => {
  await withBackend({ neverAcceptUnsafe: true, env: { SAP_AI_DEV_TOOLKIT_MAX_CSRF_RETRIES: '1.5' } }, async ({ relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 4, 'invalid values use the default of three retries');
  });
  await withBackend({ neverAcceptUnsafe: true, env: { SAP_AI_DEV_TOOLKIT_MAX_CSRF_RETRIES: '100' } }, async ({ relayUrl, state }) => {
    await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
    assert.equal(state.requests.filter(request => request.method === 'POST').length, 11, 'retry counts are capped at ten');
  });
});

test('prefers the documented branded proxy setting including an explicit direct-connection override', async t => {
  let dispatchedWithProxy = false;
  const relay = createBasDestinationRelay(
    { name: 'TEST', url: 'http://test.dest', authentication: 'BasicAuthentication' },
    {
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SAP_AI_DEV_TOOLKIT_HTTP_PROXY: '' },
      fetchImpl: async (_url, options = {}) => {
        dispatchedWithProxy = Boolean(options.dispatcher);
        return new Response('<ok/>', { status: 200, headers: { 'x-csrf-token': 'token', 'set-cookie': 'sap-session=s; path=/' } });
      }
    }
  );
  t.after(() => relay.close());
  await relay.ready;
  const probe = await relay.probeCsrfSession();
  assert.equal(probe.sessionUsable, true);
  assert.equal(dispatchedWithProxy, false, 'an explicit empty branded proxy setting means direct traffic');
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

test('keeps OnPremise Basic auth on a BAS proxy tunnel and verifies the CSRF session', async t => {
  const { state, server } = sapLikeBackend({ secureSessionCookie: true });
  const backendPort = await startServer(server);
  const connectTargets = [];
  const proxy = http.createServer();
  proxy.on('connect', (request, clientSocket, head) => {
    connectTargets.push(request.url);
    const upstream = net.connect(backendPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
  });
  const proxyPort = await startServer(proxy);
  const logs = [];
  const relay = createBasDestinationRelay({
    name: 'CC-SYSTEM',
    url: 'http://cc-system.dest',
    authentication: 'BasicAuthentication',
    credentials: { user: 'DEVELOPER', password: 'secret123', mode: 'bas-tunnel' }
  }, {
    env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    log: message => logs.push(message)
  });
  const relayUrl = await relay.ready;
  t.after(async () => {
    await relay.close();
    proxy.closeAllConnections?.();
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });

  const probe = await relay.probeCsrfSession();
  assert.deepEqual(probe, { httpStatus: 200, tokenReceived: true, cookieCount: 3, sessionUsable: true });
  const response = await relayFetch(relayUrl, '/sap/bc/adt/oo/classes', { method: 'POST', body: '<x/>' });
  assert.equal(response.status, 201, `expected a paired CSRF session, got ${response.status}: ${response.body}`);
  const post = state.requests.find(request => request.method === 'POST');
  assert.match(post.headers.authorization, /^Basic /);
  assert.match(String(post.headers.cookie), /sap-session-\d+=/);
  assert.match(String(post.headers.cookie), /sap-secure=secure-value/, 'Secure SAP cookies must be sent through the HTTPS-backed BAS .dest route');
  assert.ok(connectTargets.length >= 2);
  assert.ok(connectTargets.every(target => target === 'cc-system.dest:80'));
  assert.equal(relay.stats.direct, false);
  assert.equal(relay.stats.proxyTunnel, true);
  assert.ok(logs.some(message => message.includes('BAS proxy tunnel')));
});
