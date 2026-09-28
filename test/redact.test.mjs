import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticText, redactText } from '../src/redact.mjs';

test('redacts Basic and Bearer credentials completely', () => {
  assert.equal(redactText('authorization: Basic dXNlcjpwYXNz'), 'authorization=[redacted]');
  assert.equal(redactText('Authorization: Bearer eyJhbGci.abc.def'), 'Authorization=[redacted]');
  assert.equal(redactText('proxy-authorization: Basic Zm9vOmJhcg=='), 'proxy-authorization=[redacted]');
});

test('redacts every cookie pair, not just the first', () => {
  assert.equal(redactText('cookie: SAP_SESSIONID=abc; sap-usercontext=sap-client=001'), 'cookie=[redacted]');
});

test('redacts named secret values and csrf tokens', () => {
  assert.equal(redactText('password: hunter2'), 'password=[redacted]');
  assert.equal(redactText('x-csrf-token: abc123xyz'), 'x-csrf-token=[redacted]');
  assert.equal(redactText('failed because secret=vale'), 'failed because secret=[redacted]');
});

test('redacts userinfo embedded in URLs', () => {
  assert.equal(redactText('fetch failed https://user:secret@host.example/path'), 'fetch failed https://[redacted]@host.example/path');
});

test('leaves ordinary diagnostics untouched', () => {
  const message = 'CSRF token validation failed for /sap/bc/adt/discovery (HTTP 403)';
  assert.equal(redactText(message), message);
  assert.equal(redactText('GetSystemInfo returned successfully'), 'GetSystemInfo returned successfully');
});

test('diagnosticText redacts, collapses whitespace, and clamps length', () => {
  const result = diagnosticText(new Error('x-csrf-token: deadbeef expired\nsecond   line'), 40);
  assert.equal(result, 'x-csrf-token=[redacted] expired second l');
});

test('handles nullish and non-string input', () => {
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(null), '');
  assert.equal(diagnosticText(null), 'unknown error');
  assert.equal(diagnosticText(undefined), 'unknown error');
});
