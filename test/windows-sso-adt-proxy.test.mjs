import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createWindowsSsoAdtProxy } from '../src/windows-sso-adt-proxy.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestViaProxy(proxyUrl, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, method, path, headers }, response => resolve(response));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function responseText(response) {
  let body = '';
  response.setEncoding('utf8');
  for await (const chunk of response) body += chunk;
  return body;
}

test('Windows SSO proxy forwards decompressed responses and separate session cookies', async t => {
  const compressed = gzipSync('ADT response');
  const target = createServer((_req, res) => {
    res.writeHead(200, {
      'content-encoding': 'gzip', 'content-length': compressed.length,
      'set-cookie': ['SAP_SESSION=one; Path=/', 'sap-usercontext=sap-client=100; Path=/']
    });
    res.end(compressed);
  });
  await listen(target);
  t.after(() => close(target));
  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());
  const response = await requestViaProxy(proxy.url);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.headers['content-length'], undefined);
  assert.deepEqual(response.headers['set-cookie'], ['SAP_SESSION=one; Path=/', 'sap-usercontext=sap-client=100; Path=/']);
  assert.equal(await responseText(response), 'ADT response');
});

test('Windows SSO ADT proxy close is idempotent and tears down listener', async () => {
  const target = createServer((_request, response) => response.end('ok'));
  await listen(target);
  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(await response.text(), 'ok');
  await proxy.close();
  await proxy.close();
  await close(target);
});

test('Windows SSO ADT proxy requires Windows unless explicitly allowed for tests', async () => {
  if (process.platform === 'win32') return;
  await assert.rejects(() => createWindowsSsoAdtProxy({
    destinationUrl: 'https://sap.example.com'
  }), /only supported on Windows/);
});

test('Windows SSO ADT proxy rejects invalid targets before listening', async () => {
  await assert.rejects(() => createWindowsSsoAdtProxy({
    destinationUrl: 'ftp://sap.example.com',
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  }), /must be an HTTP\(S\) URL/);
  await assert.rejects(() => createWindowsSsoAdtProxy({
    destinationUrl: 'https://user:secret@sap.example.com',
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  }), /without embedded user information/);
});

test('Windows SSO ADT proxy forwards body and strips unsafe caller headers', async t => {
  let captured;
  const target = createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) body += chunk;
    captured = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      custom: request.headers['x-custom'],
      body
    };
    response.writeHead(201, { 'content-type': 'text/plain', connection: 'close' });
    response.end('created');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());

  const response = await requestViaProxy(proxy.url, {
    method: 'POST',
    path: '/sap/bc/adt/object',
    headers: { authorization: 'Bearer should-not-forward', connection: 'close', 'x-custom': 'kept' },
    body: 'payload'
  });
  assert.equal(response.statusCode, 201);
  assert.equal(await responseText(response), 'created');
  assert.deepEqual(captured, {
    method: 'POST',
    url: '/sap/bc/adt/object',
    authorization: undefined,
    custom: 'kept',
    body: 'payload'
  });
});

test('Windows SSO ADT proxy passes non-Negotiate 401 responses through without helper', async t => {
  let helperCalled = false;
  const target = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="SAP"', 'content-type': 'text/plain' });
    response.end('basic required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: () => { helperCalled = true; throw new Error('helper must not run'); }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Basic realm="SAP"');
  assert.equal(await response.text(), 'basic required');
  assert.equal(helperCalled, false);
});

test('Windows SSO ADT proxy self-heals Basic challenges with configured fallback credentials', async t => {
  const requests = [];
  const target = createServer((request, response) => {
    requests.push(request.headers.authorization);
    if (request.headers.authorization !== `Basic ${Buffer.from('sap-user:sap-password').toString('base64')}`) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="SAP"', 'content-type': 'text/plain' });
      response.end('basic required');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end('<adt/>');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AUTH_FALLBACK_MODE: 'basic',
      SAP_USER: 'sap-user',
      SAP_PASSWORD: 'sap-password'
    }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<adt/>');
  assert.deepEqual(requests, [undefined, `Basic ${Buffer.from('sap-user:sap-password').toString('base64')}`]);
});

test('Windows SSO ADT proxy self-heals failed Negotiate helpers with Basic fallback credentials', async t => {
  const requests = [];
  const target = createServer((request, response) => {
    requests.push(request.headers.authorization);
    if (!request.headers.authorization) {
      response.writeHead(401, { 'www-authenticate': 'Negotiate, Basic realm="SAP"' });
      response.end('auth required');
      return;
    }
    response.writeHead(request.headers.authorization.startsWith('Basic ') ? 200 : 401, { 'content-type': 'text/plain' });
    response.end(request.headers.authorization.startsWith('Basic ') ? 'ok' : 'rejected');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper',
      SAP_AUTH_FALLBACK_MODE: 'basic',
      SAP_USER: 'sap-user',
      SAP_PASSWORD: 'sap-password'
    },
    execFileImpl: (_command, _args, _options, callback) => ({
      stdin: { end() { setImmediate(() => callback(new Error('smartcard pin required'), '', 'pin required')); } }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(requests, [undefined, `Basic ${Buffer.from('sap-user:sap-password').toString('base64')}`]);
});

test('Windows SSO ADT proxy rejects invalid helper output', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Negotiate' });
    response.end('auth required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: (_command, _args, _options, callback) => ({
      stdin: { end() { setImmediate(() => callback(null, 'not a valid token!\n', '')); } }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /invalid Negotiate token/);
});

test('Windows SSO ADT proxy rejects empty helper output', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Negotiate' });
    response.end('auth required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: (_command, _args, _options, callback) => ({
      stdin: { end() { setImmediate(() => callback(null, '\n', '')); } }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /invalid Negotiate token/);
});

test('Windows SSO ADT proxy retries Negotiate challenges with helper token', async t => {
  const requests = [];
  const target = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (!request.headers.authorization) {
      response.writeHead(401, { 'www-authenticate': 'Negotiate', 'set-cookie': 'SAP_SESSION=first' });
      response.end('auth required');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/xml', 'set-cookie': 'SAP_SESSION=ok' });
    response.end('<adt/>');
  });
  await listen(target);
  t.after(() => close(target));

  let helperPayload;
  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: (command, args, options, callback) => ({
      stdin: {
        end(data) {
          helperPayload = JSON.parse(data);
          setImmediate(() => callback(null, 'helper-token\n', ''));
        }
      }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery?sap-client=100`, { headers: { cookie: 'SAP_SESSION=caller' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<adt/>');
  assert.deepEqual(requests, [
    { url: '/sap/bc/adt/discovery?sap-client=100', authorization: undefined, cookie: 'SAP_SESSION=caller' },
    { url: '/sap/bc/adt/discovery?sap-client=100', authorization: 'Negotiate helper-token', cookie: 'SAP_SESSION=first' }
  ]);
  assert.equal(helperPayload.mechanism, 'Negotiate');
  assert.match(helperPayload.url, /\/sap\/bc\/adt\/discovery\?sap-client=100$/);
});

test('Windows SSO ADT proxy surfaces helper execution failures', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Negotiate' });
    response.end('auth required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: (_command, _args, _options, callback) => ({
      stdin: { end() { setImmediate(() => callback(new Error('helper denied'), '', '')); } }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 502);
  const message = await response.text();
  assert.match(message, /Windows SSO helper failed/);
  assert.match(message, /smart-card-backed Windows logon/);
  assert.match(message, /cannot prompt for or accept manually pasted bearer\/SAML tokens/);
  assert.doesNotMatch(message, /helper denied/);
});

test('Windows SSO ADT proxy handles comma-separated Negotiate challenges with inbound token', async t => {
  let helperPayload;
  const target = createServer((request, response) => {
    if (!request.headers.authorization) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="SAP", Negotiate inbound-token, Bearer realm="ignored"' });
      response.end('auth required');
      return;
    }
    response.writeHead(200);
    response.end('ok');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: (_command, _args, _options, callback) => ({
      stdin: { end(data) { helperPayload = JSON.parse(data); setImmediate(() => callback(null, 'outbound-token\n', '')); } }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.match(helperPayload.challenge, /Negotiate inbound-token/);
});

test('Windows SSO ADT proxy rewrites same-origin absolute redirects back through loopback proxy', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(302, { location: '/sap/bc/adt/login?next=discovery' });
    response.end();
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${proxy.url}/sap/bc/adt/login?next=discovery`);
});

test('Windows SSO ADT proxy rewrites same-origin absolute target redirects back through loopback proxy', async t => {
  let targetOrigin;
  const target = createServer((_request, response) => {
    response.writeHead(302, { location: `${targetOrigin}/sap/bc/adt/absolute?x=1#fragment` });
    response.end();
  });
  await listen(target);
  targetOrigin = `http://127.0.0.1:${target.address().port}`;
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: targetOrigin,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${proxy.url}/sap/bc/adt/absolute?x=1#fragment`);
});

test('Windows SSO ADT proxy redirect rewriting ignores untrusted Host headers', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(302, { location: '/sap/bc/adt/login' });
    response.end();
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());

  const proxyUrl = new URL(proxy.url);
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: proxyUrl.hostname, port: proxyUrl.port, method: 'GET', path: '/sap/bc/adt/discovery', headers: { host: 'evil.example' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, `${proxy.url}/sap/bc/adt/login`);
});

test('Windows SSO ADT proxy leaves cross-origin redirect locations unchanged', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(302, { location: 'https://login.example.com/sso' });
    response.end();
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://login.example.com/sso');
});

test('Windows SSO ADT proxy rejects cross-origin forward-form requests', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(200);
    response.end('should not be reached');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  t.after(() => proxy.close());

  const response = await requestViaProxy(proxy.url, { path: 'http://evil.example/sap/bc/adt/discovery' });
  assert.equal(response.statusCode, 502);
  assert.match(await responseText(response), /Cross-origin Windows SSO proxy request rejected/);
});

test('Windows SSO ADT proxy requires explicit helper for Negotiate challenges', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Negotiate' });
    response.end('auth required');
  });
  await listen(target);
  t.after(() => close(target));

  const env = { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' };
  if (process.platform === 'win32') {
    // On Windows a default PowerShell SSPI helper always exists, so the
    // no-helper branch is unreachable. Point the helper at a missing binary
    // to verify the same contract: a Negotiate challenge without a usable
    // helper fails safely with actionable guidance.
    env.SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER = 'C:\\definitely-not-a-real-helper.exe';
  }
  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, process.platform === 'win32'
    ? /Windows SSO helper failed/
    : /requires an SSPI\/Negotiate helper/);
});

test('Windows SSO ADT proxy close is idempotent', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(200);
    response.end('ok');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true' }
  });
  await proxy.close();
  await proxy.close();
});

test('Windows SSO ADT proxy default helper allows native credential UI when enabled', async t => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));

  const requests = [];
  const target = createServer((request, response) => {
    requests.push(request.headers.authorization);
    if (!request.headers.authorization) {
      response.writeHead(401, { 'www-authenticate': 'Negotiate' });
      response.end('auth required');
      return;
    }
    response.writeHead(200);
    response.end('ok');
  });
  await listen(target);
  t.after(() => close(target));

  let observedArgs;
  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SystemRoot: 'C:\\Windows',
      SAP_AI_DEV_TOOLKIT_WINDOWS_CREDENTIAL_UI: 'true'
    },
    execFileImpl: (_command, args, _options, callback) => {
      observedArgs = args;
      return { stdin: { end() { setImmediate(() => callback(null, 'helper-token\n', '')); } } };
    }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 200);
  assert.equal(observedArgs.includes('-NonInteractive'), false);
  assert.deepEqual(requests, [undefined, 'Negotiate helper-token']);
});

test('Windows SSO ADT proxy default helper remains non-interactive unless credential UI is enabled', async t => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));

  const target = createServer((request, response) => {
    if (!request.headers.authorization) {
      response.writeHead(401, { 'www-authenticate': 'Negotiate' });
      response.end('auth required');
      return;
    }
    response.writeHead(200);
    response.end('ok');
  });
  await listen(target);
  t.after(() => close(target));

  let observedArgs;
  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: { SystemRoot: 'C:\\Windows' },
    execFileImpl: (_command, args, _options, callback) => {
      observedArgs = args;
      return { stdin: { end() { setImmediate(() => callback(null, 'helper-token\n', '')); } } };
    }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 200);
  assert.equal(observedArgs.includes('-NonInteractive'), true);
});

test('Windows SSO ADT proxy does not use Basic fallback without both username and password', async t => {
  const requests = [];
  const target = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(401, { 'www-authenticate': 'Basic realm="SAP"', 'content-type': 'text/plain' });
    response.end('basic required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AUTH_FALLBACK_MODE: 'basic',
      SAP_USER: 'sap-user'
    }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 401);
  assert.deepEqual(requests, [undefined]);
});

test('Windows SSO ADT proxy Basic fallback also accepts branded mode and username/password aliases', async t => {
  const requests = [];
  const expected = `Basic ${Buffer.from('alias-user:alias-pass').toString('base64')}`;
  const target = createServer((request, response) => {
    requests.push(request.headers.authorization);
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="SAP"' });
      response.end('basic required');
      return;
    }
    response.writeHead(200);
    response.end('ok');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_AUTH_FALLBACK_MODE: 'basic',
      SAP_USERNAME: 'alias-user',
      SAP_PASS: 'alias-pass'
    }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [undefined, expected]);
});

test('Windows SSO ADT proxy ignores fallback credentials when fallback mode is disabled', async t => {
  const requests = [];
  const target = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(401, { 'www-authenticate': 'Basic realm="SAP"' });
    response.end('basic required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_USER: 'sap-user',
      SAP_PASSWORD: 'sap-password'
    }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 401);
  assert.deepEqual(requests, [undefined]);
});

test('Windows SSO ADT proxy rejects NTLM fallback tokens', async t => {
  const target = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Negotiate' });
    response.end('auth required');
  });
  await listen(target);
  t.after(() => close(target));

  const proxy = await createWindowsSsoAdtProxy({
    destinationUrl: `http://127.0.0.1:${target.address().port}`,
    env: {
      SAP_AI_DEV_TOOLKIT_ALLOW_SSO_PROXY_ON_NON_WINDOWS: 'true',
      SAP_AI_DEV_TOOLKIT_NEGOTIATE_HELPER: '/trusted/helper'
    },
    execFileImpl: (_command, _args, _options, callback) => ({
      stdin: { end() { setImmediate(() => callback(null, `${Buffer.from('NTLMSSP\0fake').toString('base64')}\n`, '')); } }
    })
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/sap/bc/adt/discovery`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /NTLM token/);
});
