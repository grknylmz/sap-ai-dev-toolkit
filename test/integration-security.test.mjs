import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationServer } from '../src/integration-server.mjs';
import { evaluateCertificate, readCertificateHealth } from '../src/cpi-security.mjs';
import { startFakeTenant } from './fake-integration-tenant.mjs';

const evaluated_at = '2026-10-28T00:00:00.000Z';
const entry = { Alias: 'cert', Type: 'Certificate', KeyType: 'RSA', Subject: 'PRIVATE SUBJECT', ValidNotBefore: '2026-10-01T00:00:00Z', ValidNotAfter: '2026-12-01T00:00:00Z' };
test('certificate validity preserves exact boundaries and unknown dates', () => {
  const evaluate = value => evaluateCertificate({ ...entry, ...value }, { evaluated_at });
  assert.equal(evaluate({}).validity, 'valid');
  assert.equal(evaluate({ ValidNotAfter: evaluated_at }).validity, 'expiring');
  assert.equal(evaluate({ ValidNotBefore: evaluated_at }).validity, 'valid');
  assert.equal(evaluate({ ValidNotAfter: '2026-10-27T23:59:59.999Z' }).validity, 'expired');
  assert.equal(evaluate({ ValidNotBefore: '2026-10-28T00:00:00.001Z' }).validity, 'not_yet_valid');
  assert.equal(evaluate({ ValidNotAfter: '2026-11-27T00:00:00Z' }).validity, 'expiring');
  for (const value of [null, '', 'invalid']) assert.equal(evaluate({ ValidNotAfter: value }).validity, 'unknown');
  assert.equal(evaluate({ ValidNotBefore: '2027-01-01' }).validity, 'unknown');
  assert.equal(evaluate({}).Subject, undefined);
});
test('certificate paging freezes evaluation and rejects changed or forged cursors before reads', async () => {
  let reads = 0;
  const client = { origin: 'https://tenant.example', request: async () => { reads++; return { d: { results: [entry, { ...entry, Alias: 'second' }] } }; } };
  const first = await readCertificateHealth(client, { top: 1, evaluated_at });
  assert.equal(first.complete, false);
  const second = await readCertificateHealth(client, { top: 1, cursor: first.next_cursor });
  assert.equal(second.evaluated_at, evaluated_at);
  assert.equal(second.items[0].Alias, 'second');
  assert.equal(second.complete, true);
  const before = reads;
  for (const args of [{ warning_days: 31 }, { keystore: 'KeyRenewal' }, { cursor: first.next_cursor + 'x' }]) {
    await assert.rejects(readCertificateHealth(client, { cursor: first.next_cursor, ...args }));
  }
  assert.equal(reads, before);
});
async function connect(t, tenant) {
  const runtime = createIntegrationServer({ env: { XDG_CONFIG_HOME: '/nonexistent/security-test', CPI_SERVICE_KEY: tenant.serviceKey() } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'security-test', version: '1' });
  await runtime.server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await runtime.close(); });
  return client;
}
test('malformed certificate is rejected without network', async t => {
  const tenant = await startFakeTenant(t, () => ({ status: 500 }));
  const client = await connect(t, tenant);
  const response = await client.callTool({ name: 'cpi_upload_certificate', arguments: { alias: 'test', certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', confirmation: 'UPLOAD CERTIFICATE test' } });
  assert.equal(response.isError, true);
  assert.equal(tenant.apiRequests().length, 0);
});
for (const exists of [false, true]) test(`upload HTTP 400 uses fresh alias evidence: ${exists}`, async t => {
  const tenant = await startFakeTenant(t, request => request.method === 'PUT'
    ? { status: 400, json: { error: { message: { value: 'Unsupported certificate algorithm' } } } }
    : { status: 200, json: { d: { results: exists ? [{ Alias: 'test' }] : [] } } });
  const client = await connect(t, tenant);
  const response = await client.callTool({ name: 'cpi_upload_certificate', arguments: { alias: 'test', certificate: readFileSync(new URL('./fixtures/certificate.pem', import.meta.url), 'utf8'), confirmation: 'UPLOAD CERTIFICATE test' } });
  assert.equal(response.isError, true);
  const text = response.content[0].text;
  if (exists) assert.match(text, /already exists/);
  else { assert.match(text, /Unsupported certificate algorithm/); assert.doesNotMatch(text, /already exists/); }
  assert.equal(tenant.apiRequests().filter(request => request.method === 'PUT').length, 1);
  assert.equal(tenant.apiRequests().some(request => request.path.endsWith('/KeystoreEntries')), true);
});
