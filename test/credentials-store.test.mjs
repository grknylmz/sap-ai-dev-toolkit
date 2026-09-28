import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { createBasDestinationRelay } from '../src/bas-destination-relay.mjs';
import { readCredentials, removeDestinationCredentials, resolveCredentialsPath, storeDestinationCredentials } from '../src/credentials-store.mjs';
import { canPromptForCredentials, credentialKeyForDestination, credentialModeForDestination } from '../src/credential-overrides.mjs';

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// SAP-like backend that requires Basic auth AND token+cookie pairing —
// the semantics that only work when the relay connects directly.
function authedBackend({ expectedUser = 'DEVELOPER', expectedPassword = 'secret123' } = {}) {
  const state = { sessionCounter: 0, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, headers: { ...req.headers } });
    const authorization = String(req.headers.authorization || '');
    const basic = authorization.replace(/^Basic /i, '');
    const [user, password] = Buffer.from(basic, 'base64').toString().split(':');
    if (user !== expectedUser || password !== expectedPassword) {
      res.writeHead(401, { 'www-authenticate': 'Basic' });
      res.end('credentials required');
      return;
    }
    if (req.method === 'GET' && req.headers['x-csrf-token'] === 'Fetch') {
      state.sessionCounter += 1;
      res.writeHead(200, {
        'x-csrf-token': `token-${state.sessionCounter}`,
        'set-cookie': [`sap-session-${state.sessionCounter}=s${state.sessionCounter}; path=/`]
      });
      res.end('<ok/>');
      return;
    }
    if (UNSAFE_METHODS.includes(req.method)) {
      const match = String(req.headers['x-csrf-token'] || '').match(/^token-(\d+)$/);
      const valid = match && String(req.headers.cookie || '').includes(`sap-session-${match[1]}=`);
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

function relayFetch(relayUrl, path, options = {}) {
  const target = new URL(path, relayUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method: options.method || 'GET', headers: options.headers || {} }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('credentials file resolves next to the MCP config and stores entries with 0600', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-creds-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const mcpConfig = join(directory, 'mcp.json');
  const path = await resolveCredentialsPath({ HOME: '/nonexistent' }, mcpConfig);
  assert.equal(path, join(directory, 'sap-ai-dev-toolkit-credentials.json'));

  await storeDestinationCredentials(path, 'S4H', { host: 'https://backend.example:44300', user: 'DEVELOPER', password: 'secret123' });
  const stored = await readCredentials(path);
  assert.equal(stored.destinations.S4H.user, 'DEVELOPER');
  assert.equal(stored.destinations.S4H.host, 'https://backend.example:44300');
  const permissions = (await stat(path)).mode & 0o777;
  assert.equal(permissions, 0o600, 'credentials file must be owner-only');

  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(Object.hasOwn(raw.destinations, 'S4H'));

  const { removed } = await removeDestinationCredentials(path, ['S4H']);
  assert.deepEqual(removed, ['S4H']);
  assert.equal((await readCredentials(path)).destinations.S4H, undefined);
});

test('credentials file with malformed entries keeps only complete records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-creds-bad-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'sap-ai-dev-toolkit-credentials.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    destinations: {
      GOOD: { host: 'https://good.example', user: 'u', password: 'p', updatedAt: '2026-01-01T00:00:00.000Z' },
      NO_PASSWORD: { host: 'https://bad.example', user: 'u' },
      NOT_OBJECT: 'nope'
    }
  }));
  const stored = await readCredentials(path);
  assert.deepEqual(Object.keys(stored.destinations), ['GOOD']);
});

test('credential overrides use route-aware modes and distinct CF destination keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bas-creds-modes-'));
  const path = join(directory, 'sap-ai-dev-toolkit-credentials.json');
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const basDestination = { name: 'shared-name', source: 'bas', proxyType: 'Internet', authentication: 'BasicAuthentication', backendUrl: 'https://internet.example' };
  const basOnPremise = { name: 'shared-name', source: 'bas', proxyType: 'OnPremise', authentication: 'BasicAuthentication' };
  const cfOnPremise = { name: 'shared-name', serverName: 'cf:space-one:instance-one:shared-name', source: 'cloud-foundry', proxyType: 'OnPremise', authentication: 'BasicAuthentication' };
  const principalPropagation = { ...cfOnPremise, authentication: 'PrincipalPropagation' };

  assert.equal(canPromptForCredentials(basDestination), true);
  assert.equal(credentialModeForDestination(basDestination), 'direct');
  assert.equal(credentialModeForDestination(basOnPremise), 'bas-tunnel');
  assert.equal(credentialModeForDestination(cfOnPremise), 'cf-connectivity');
  assert.equal(canPromptForCredentials(principalPropagation), false);
  assert.equal(credentialModeForDestination({ ...cfOnPremise, proxyType: 'Internet' }), null);
  assert.equal(canPromptForCredentials({ ...basDestination, backendUrl: null }), false);
  assert.notEqual(credentialKeyForDestination(basOnPremise), credentialKeyForDestination(cfOnPremise));

  const cfKey = credentialKeyForDestination(cfOnPremise);
  await storeDestinationCredentials(path, cfKey, { user: 'OVERRIDE', password: 'secret', mode: 'cf-connectivity' });
  const stored = await readCredentials(path);
  assert.equal(stored.destinations[cfKey].mode, 'cf-connectivity');
  assert.equal(stored.destinations[cfKey].host, undefined);
  await assert.rejects(
    () => storeDestinationCredentials(path, 'INVALID', { user: 'U', password: 'P', mode: 'bypass-cloud-connector' }),
    /route mode is unsupported/
  );
});

test('relay direct connect sends Basic auth and CSRF pairing succeeds', async t => {
  const { state, server } = authedBackend();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const backendUrl = `http://127.0.0.1:${server.address().port}`;
  const relay = createBasDestinationRelay(
    {
      name: 'S4H',
      url: 'http://S4H.dest',
      authentication: 'BasicAuthentication',
      credentials: { host: backendUrl, user: 'DEVELOPER', password: 'secret123' }
    },
    { env: { HTTP_PROXY: '' }, log: () => {} }
  );
  const relayUrl = await relay.ready;
  t.after(async () => { await relay.close(); await new Promise(resolve => server.close(resolve)); });
  try {
    const read = await relayFetch(relayUrl, '/sap/bc/adt/discovery');
    assert.equal(read.status, 200, 'authenticated read must succeed');
    const write = await relayFetch(relayUrl, '/sap/bc/adt/datapreview/freestyle', { method: 'POST', body: '<q/>' });
    assert.equal(write.status, 201, `CSRF-protected write must succeed, got ${write.status}: ${write.body}`);
    const post = state.requests.find(request => request.method === 'POST');
    assert.match(post.headers.authorization, /^Basic /);
    assert.match(String(post.headers.cookie), /sap-session-\d+=/);
    assert.equal(relay.stats.direct, true);
  } finally {
    void relayUrl;
  }
});

test('relay direct connect with wrong credentials surfaces 401 without retries', async t => {
  const { state, server } = authedBackend();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const backendUrl = `http://127.0.0.1:${server.address().port}`;
  const relay = createBasDestinationRelay(
    {
      name: 'S4H',
      url: 'http://S4H.dest',
      authentication: 'BasicAuthentication',
      credentials: { host: backendUrl, user: 'DEVELOPER', password: 'wrong' }
    },
    { env: { HTTP_PROXY: '' }, log: () => {} }
  );
  const relayUrl = await relay.ready;
  t.after(async () => { await relay.close(); await new Promise(resolve => server.close(resolve)); });
  const write = await relayFetch(relayUrl, '/sap/bc/adt/datapreview/freestyle', { method: 'POST', body: '<q/>' });
  assert.equal(write.status, 401);
  assert.equal(relay.stats.csrfRetries, 0, '401 without a session must not trigger CSRF retries');
  void state;
});
