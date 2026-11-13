import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { authorizationCodeLogin, createDatasphereTokenProvider, createInteractiveTokenProvider, requestDatasphereToken } from '../src/datasphere-auth.mjs';

/** Fake Datasphere token endpoint: records form/headers and replies with scripted payloads. */
async function fakeTokenServer(t, { status = 200, payload } = {}) {
  const requests = [];
  let count = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      count += 1;
      const body = Buffer.concat(chunks).toString('utf8');
      const form = Object.fromEntries(new URLSearchParams(body));
      requests.push({ headers: request.headers, form });
      const reply = typeof payload === 'function' ? payload(count, form) : payload;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply ?? { access_token: `at-${count}`, refresh_token: count === 1 ? undefined : `rt-${count}`, expires_in: 3600 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('sb- clients send x-sap-sac-custom-auth and no client_id in the form', async t => {
  const token = await fakeTokenServer(t);
  await requestDatasphereToken({ tokenUrl: `${token.url}/oauth/token`, clientId: 'sb-xyz!t1', clientSecret: 'sec', form: { grant_type: 'client_credentials' }, env: {} });
  const seen = token.requests[0];
  assert.equal(seen.headers['x-sap-sac-custom-auth'], 'true');
  assert.equal(seen.form.client_id, undefined);
  assert.equal(seen.form.response_type, 'token');
  assert.equal(seen.form.grant_type, 'client_credentials');
  assert.match(seen.headers.authorization, /^Basic /);
});

test('non-sb- clients send client_id in the form and no custom auth header', async t => {
  const token = await fakeTokenServer(t);
  await requestDatasphereToken({ tokenUrl: `${token.url}/oauth/token`, clientId: 'plain-client', clientSecret: 'sec', form: { grant_type: 'client_credentials' }, env: {} });
  const seen = token.requests[0];
  assert.equal(seen.headers['x-sap-sac-custom-auth'], undefined);
  assert.equal(seen.form.client_id, 'plain-client');
});

test('technical token provider uses SAP custom authentication and shares cached tokens', async t => {
  const token = await fakeTokenServer(t);
  const provider = createDatasphereTokenProvider({
    config: { auth: 'technical', tokenUrl: `${token.url}/oauth/token`, clientId: 'sb-test', clientSecret: 'sec' },
    env: {}
  });
  const [first, second] = await Promise.all([provider.token(), provider.token()]);
  assert.equal(first, second);
  assert.equal(await provider.token(), first);
  assert.equal(token.requests.length, 1);
  assert.equal(token.requests[0].headers['x-sap-sac-custom-auth'], 'true');
  assert.deepEqual(token.requests[0].form, { grant_type: 'client_credentials', response_type: 'token' });
});

test('token requests reject redirects without forwarding credentials or codes', async t => {
  const destination = await fakeTokenServer(t);
  const redirect = createServer((_request, response) => {
    response.writeHead(307, { location: `${destination.url}/oauth/token` });
    response.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => redirect.close(resolve)));
  await assert.rejects(requestDatasphereToken({
    tokenUrl: `http://127.0.0.1:${redirect.address().port}/oauth/token`,
    clientId: 'sb-test', clientSecret: 'sec', form: { grant_type: 'authorization_code', code: 'private-code' }, env: {}
  }), /HTTP 307/);
  assert.equal(destination.requests.length, 0);
});

test('token responses are size-capped and the deadline covers a stalled response body', async () => {
  const options = { tokenUrl: 'https://auth.example/oauth/token', clientId: 'c', clientSecret: 's', form: { grant_type: 'client_credentials' }, env: {} };
  await assert.rejects(requestDatasphereToken({ ...options, fetchImpl: async () => new Response('x'.repeat(64 * 1024 + 1)) }), /response exceeded the safe size limit/);
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(requestDatasphereToken({ ...options, timeoutMs: 20, fetchImpl: async () => new Response(stream) }), /timeout/);
  assert.equal(cancelled, true);
});

test('interactive provider refreshes only below the 15 minute margin and single-flights concurrent callers', async t => {
  let now = 1_000_000;
  const token = await fakeTokenServer(t);
  const persisted = [];
  const provider = createInteractiveTokenProvider({
    config: { auth: 'interactive', tokenUrl: `${token.url}/oauth/token`, clientId: 'c', clientSecret: 's', refreshToken: 'r0', env: {} },
    persistRefreshToken: async value => persisted.push(value),
    now: () => now
  });
  const [first, second] = await Promise.all([provider.token(), provider.token()]);
  assert.equal(first.accessToken, 'at-1');
  assert.equal(first, second);
  assert.equal(token.requests.length, 1, 'concurrent callers share one refresh');

  now += 10 * 60 * 1000; // still >15 min before expiry
  await provider.token();
  assert.equal(token.requests.length, 1, 'cached token is reused');

  now += 50 * 60 * 1000; // now past the margin
  const rotated = await provider.token();
  assert.equal(rotated.refreshToken, 'rt-2');
  assert.deepEqual(persisted, ['rt-2'], 'rotated refresh token reaches persistRefreshToken');
  assert.equal(token.requests.length, 2);
  assert.equal(token.requests[1].form.refresh_token, 'r0');
});

test('refresh failure maps to the session-expired message without echoing the response body', async t => {
  const token = await fakeTokenServer(t, { status: 400, payload: { error: 'invalid_grant', error_description: 'super-secret-leak' } });
  const provider = createInteractiveTokenProvider({
    config: { auth: 'interactive', tokenUrl: `${token.url}/oauth/token`, clientId: 'c', clientSecret: 's', refreshToken: 'r0', env: {} },
    now: () => 1
  });
  await assert.rejects(() => provider.token(), error => {
    assert.equal(error.name, 'IntegrationError');
    assert.match(error.message, /interactive session expired or was revoked; rerun sap-ai-dev --setup-datasphere/);
    assert.doesNotMatch(error.message, /super-secret-leak/);
    return true;
  });
});

test('authorizationCodeLogin paste mode extracts the code from a full URL and from bare text', async t => {
  const token = await fakeTokenServer(t);
  const config = { auth: 'interactive', tokenUrl: `${token.url}/oauth/token`, clientId: 'plain-client', clientSecret: 'sec', authorizationUrl: 'https://auth.example/oauth/authorize', env: {} };
  let authorize;
  const fromUrl = await authorizationCodeLogin({
    config, mode: 'paste', openUrl: url => { authorize = new URL(url); },
    promptPaste: async () => `http://localhost:8080/?code=abc-123&state=${authorize.searchParams.get('state')}`, env: {}
  });
  assert.equal(fromUrl.accessToken, 'at-1');
  assert.equal(token.requests.at(-1).form.code, 'abc-123');
  assert.equal(token.requests.at(-1).form.grant_type, 'authorization_code');

  const bare = await authorizationCodeLogin({ config, mode: 'paste', promptPaste: async () => '  plain-code-9 ', env: {} });
  assert.equal(bare.accessToken, 'at-2');
  assert.equal(token.requests.at(-1).form.code, 'plain-code-9');
});


test('paste mode rejects mismatched callback state and missing codes without exchanging a token', async t => {
  const token = await fakeTokenServer(t);
  const config = { tokenUrl: `${token.url}/oauth/token`, clientId: 'c', clientSecret: 's', authorizationUrl: 'https://auth.example/oauth/authorize' };
  await assert.rejects(authorizationCodeLogin({
    config, mode: 'paste', promptPaste: async () => 'http://localhost:8080/?code=untrusted&state=wrong', env: {}
  }), /state did not match/);
  let state;
  await assert.rejects(authorizationCodeLogin({
    config, mode: 'paste', openUrl: url => { state = new URL(url).searchParams.get('state'); },
    promptPaste: async () => `http://localhost:8080/?state=${state}`, env: {}
  }), /No authorization code/);
  assert.equal(token.requests.length, 0);
});

test('browser mode ignores unrelated callbacks and exchanges only the code with the matching state', async t => {
  const token = await fakeTokenServer(t);
  const config = { auth: 'interactive', tokenUrl: `${token.url}/oauth/token`, clientId: 'plain-client', clientSecret: 'sec', authorizationUrl: 'https://auth.example/oauth/authorize', env: {} };

  // Reserve an ephemeral port, then hand it to the login server.
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const opened = [];
  let callbacks;
  const responses = [];
  const pending = authorizationCodeLogin({
    config,
    mode: 'browser',
    port,
    openUrl: url => {
      opened.push(url);
      callbacks = (async () => {
        const state = new URL(url).searchParams.get('state');
        for (const path of ['/favicon.ico', '/?code=untrusted', '/?code=untrusted&state=wrong', `/?state=${state}`]) {
          const response = await fetch(`http://localhost:${port}${path}`);
          responses.push({ status: response.status, body: await response.text() });
        }
        assert.equal(token.requests.length, 0, 'unrelated callbacks cannot start a token exchange');
        const response = await fetch(`http://localhost:${port}/?code=abc-browser&state=${state}`);
        responses.push({ status: response.status, body: await response.text() });
      })();
      return callbacks;
    },
    env: {}
  });
  const session = await pending;
  await callbacks;
  assert.deepEqual(responses.map(response => response.status), [404, 400, 400, 400, 200]);
  assert.match(responses.at(-1).body, /Authorization received/);
  assert.equal(session.accessToken, 'at-1');
  assert.equal(token.requests.at(-1).form.code, 'abc-browser');
  assert.equal(opened.length, 1);
  const authorize = new URL(opened[0]);
  assert.equal(authorize.searchParams.get('client_id'), 'plain-client');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.match(authorize.searchParams.get('state'), /^[a-f0-9]{64}$/);
});

test('browser authorization errors fail immediately without exposing callback details', async t => {
  const token = await fakeTokenServer(t);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, 'localhost', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let callback;
  const pending = authorizationCodeLogin({
    config: { tokenUrl: `${token.url}/oauth/token`, clientId: 'c', clientSecret: 's', authorizationUrl: 'https://auth.example/oauth/authorize' },
    mode: 'browser', port, env: {},
    openUrl: url => {
      callback = fetch(`http://localhost:${port}/?error=access_denied&error_description=private-detail&state=${new URL(url).searchParams.get('state')}`);
      return callback;
    }
  });
  await assert.rejects(pending, error => {
    assert.match(error.message, /sign-in was denied or failed/);
    assert.doesNotMatch(error.message, /private-detail/);
    return true;
  });
  const response = await callback;
  assert.equal(response.status, 400);
  assert.equal(token.requests.length, 0);
});
