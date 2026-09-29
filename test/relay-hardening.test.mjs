import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { createBasDestinationRelay } from '../src/bas-destination-relay.mjs';

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

async function withBackend(handler, test) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const relay = createBasDestinationRelay(
    { name: 'TEST', url, authentication: 'BasicAuthentication' },
    { env: { HTTP_PROXY: '' }, log: message => logs.push(message) }
  );
  const relayUrl = await relay.ready;
  try {
    return await test({ requests, relay, relayUrl, logs, url });
  } finally {
    await relay.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('multi-value set-cookie headers survive the relay', async () => {
  await withBackend((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/xml',
      'set-cookie': ['sap-session-1=s1; path=/', 'sap-usercontext=sap-client=100; path=/']
    });
    response.end('<ok/>');
  }, async ({ relayUrl }) => {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/discovery');
    assert.equal(response.status, 200);
    const setCookie = response.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie), `set-cookie must stay multi-valued, got: ${JSON.stringify(setCookie)}`);
    assert.equal(setCookie.length, 2, `both cookies must reach the client, got: ${JSON.stringify(setCookie)}`);
    assert.match(setCookie[0], /sap-session-1=s1/);
    assert.match(setCookie[1], /sap-usercontext=sap-client=100/);
  });
});


test('relay error responses are redacted', async () => {
  // A destination whose backend vanishes mid-flight: the relay's 502 body
  // must not leak credential material from transport error messages.
  const server = http.createServer(() => { server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const relay = createBasDestinationRelay(
    { name: 'TEST', url, authentication: 'BasicAuthentication' },
    { env: { HTTP_PROXY: '' }, log: () => {} }
  );
  const relayUrl = await relay.ready;
  try {
    const response = await relayFetch(relayUrl, '/sap/bc/adt/discovery');
    assert.ok(response.status >= 500);
    assert.doesNotMatch(response.body, /stored-pass|password\s*[:=][^\s]/i);
  } finally {
    await relay.close();
  }
});
