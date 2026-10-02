import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { createTlsServerNameAdtProxy, discoverCertificateDnsNames } from '../src/tls-adt-proxy.mjs';

const exec = promisify(execFile);

async function createCertificate(directory, dnsName = 'sap.example.test') {
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const config = join(directory, 'openssl.cnf');
  await writeFile(config, `
[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt=no
[req_distinguished_name]
CN=${dnsName}
[v3_req]
subjectAltName=@alt_names
[alt_names]
DNS.1=${dnsName}
`.trim());
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config]);
  return { key: await readFile(key), cert: await readFile(cert), certPath: cert };
}

async function withHttpsBackend(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'sap-ai-tls-proxy-'));
  const material = await createCertificate(directory);
  const observed = { serverNames: [], requests: [] };
  const server = https.createServer({
    key: material.key,
    cert: material.cert,
    SNICallback: (serverName, callback) => {
      observed.serverNames.push(serverName);
      callback(null, tls.createSecureContext({ key: material.key, cert: material.cert }));
    }
  }, (request, response) => {
    observed.requests.push({ method: request.method, url: request.url, host: request.headers.host });
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { url: `https://127.0.0.1:${server.address().port}`, caFile: material.certPath, observed };
}

function get(url, path = '/sap/bc/adt/core/discovery?sap-client=001') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, method: 'GET', path, headers: { host: parsed.host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('TLS ADT proxy discovers certificate DNS names without requiring user-entered URLs or names', async t => {
  const backend = await withHttpsBackend(t, (_request, response) => response.end('<ok/>'));
  const names = await discoverCertificateDnsNames(backend.url);
  assert.deepEqual(names, ['sap.example.test']);
});

test('TLS ADT proxy connects to an IP while verifying the configured certificate DNS name', async t => {
  const backend = await withHttpsBackend(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end('<ok/>');
  });
  const proxy = await createTlsServerNameAdtProxy({ destinationUrl: backend.url, tlsServerName: 'sap.example.test', caFile: backend.caFile });
  t.after(() => proxy.close());

  const result = await get(proxy.url);
  assert.equal(result.status, 200);
  assert.equal(result.body, '<ok/>');
  assert.deepEqual(backend.observed.requests, [{ method: 'GET', url: '/sap/bc/adt/core/discovery?sap-client=001', host: new URL(backend.url).host }]);
  assert.deepEqual(backend.observed.serverNames, ['sap.example.test']);
});

test('TLS ADT proxy tries configured certificate DNS fallback names one by one', async t => {
  const backend = await withHttpsBackend(t, (_request, response) => response.end('ok'));
  const proxy = await createTlsServerNameAdtProxy({ destinationUrl: backend.url, tlsServerNames: ['wrong.example.test', 'sap.example.test'], caFile: backend.caFile });
  t.after(() => proxy.close());

  const result = await get(proxy.url);
  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');
  assert.deepEqual(backend.observed.serverNames, ['wrong.example.test', 'sap.example.test']);
});

test('TLS ADT proxy keeps verification enabled and reports a mismatch instead of falling back insecurely', async t => {
  const backend = await withHttpsBackend(t, (_request, response) => {
    response.end('must not be reached');
  });
  const proxy = await createTlsServerNameAdtProxy({ destinationUrl: backend.url, tlsServerName: 'wrong.example.test', caFile: backend.caFile });
  t.after(() => proxy.close());

  const result = await get(proxy.url);
  assert.equal(result.status, 502);
  assert.match(result.body, /certificate|Hostname|valid for/i);
  assert.deepEqual(backend.observed.requests, []);
});

test('TLS ADT proxy rejects cross-origin forward-form requests and rewrites same-origin redirects', async t => {
  const backend = await withHttpsBackend(t, (_request, response) => {
    response.writeHead(302, { location: `${backend.url}/sap/public/ping` });
    response.end();
  });
  const proxy = await createTlsServerNameAdtProxy({ destinationUrl: backend.url, tlsServerName: 'sap.example.test', caFile: backend.caFile });
  t.after(() => proxy.close());

  const rejected = await get(proxy.url, 'http://evil.example/sap/bc/adt/discovery');
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /cross-origin request rejected/);

  const redirected = await get(proxy.url, '/sap/bc/adt/discovery');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.location, `${proxy.url}/sap/public/ping`);
});

test('TLS ADT proxy validates configuration before listening', async () => {
  await assert.rejects(() => createTlsServerNameAdtProxy({ destinationUrl: 'http://127.0.0.1:50000', tlsServerName: 'sap.example.test' }), /requires an https/);
  await assert.rejects(() => createTlsServerNameAdtProxy({ destinationUrl: 'https://127.0.0.1:50000', tlsServerName: '' }), /requires a DNS name/);
});
