import assert from 'node:assert/strict';
import test from 'node:test';
import * as bundles from '../src/apim-bundle.mjs';

const now = 1_800_000_000;
const policy = { issuer: 'https://tenant.authentication.eu20.hana.ondemand.com/oauth/token', scopePrefix: 'sap-api!t1', systems: ['S4D100', 'S4T300', 'S4Q300'] };
const claimsFor = system => ({ iss: policy.issuer, grant_type: 'client_credentials', exp: now + 1800, scope: [`${policy.scopePrefix}.${system}.Access`, 'uaa.resource'], aud: [`${policy.scopePrefix}.${system}`, 'dedicated-client'] });
const select = claims => bundles.selectAuthorizedBackend(claims, policy, now);

for (const system of policy.systems) {
  test(`authorizes only the signed ${system} scope and matching resource audience`, () => {
    assert.equal(select(claimsFor(system)), system);
  });
}

test('rejects a token with authority for multiple backend systems', () => {
  const claims = claimsFor('S4D100');
  claims.scope.push(`${policy.scopePrefix}.S4T300.Access`);
  claims.aud.push(`${policy.scopePrefix}.S4T300`);
  assert.equal(select(claims), null);
});

test('rejects an unauthorized system even alongside an allowed system', () => {
  const claims = claimsFor('S4D100');
  claims.scope.push(`${policy.scopePrefix}.S4P100.Access`);
  assert.equal(select(claims), null);
});

test('a client audience alone does not authorize a backend', () => {
  assert.equal(select({ ...claimsFor('S4D100'), aud: ['dedicated-client'] }), null);
});

test('does not treat substring scope matches as authorization', () => {
  assert.equal(select({ ...claimsFor('S4D100'), scope: [`${policy.scopePrefix}.S4D100.AccessExtra`] }), null);
  assert.equal(select({ ...claimsFor('S4D100'), scope: [`other.${policy.scopePrefix}.S4D100.Access`] }), null);
});

test('rejects missing scopes and scalar scopes rather than guessing a backend', () => {
  assert.equal(select({ ...claimsFor('S4D100'), scope: [] }), null);
  assert.equal(select({ ...claimsFor('S4D100'), scope: `${policy.scopePrefix}.S4D100.Access` }), null);
});

test('rejects expired, undated, future-dated, interactive and foreign-issuer tokens', () => {
  for (const change of [{ exp: now }, { exp: undefined }, { nbf: now + 1 }, { grant_type: 'password' }, { iss: 'https://other.example/oauth/token' }]) {
    assert.equal(select({ ...claimsFor('S4D100'), ...change }), null);
  }
});

test('production authorization recognizes only its configured production system', () => {
  const production = { ...policy, systems: ['S4P100'] };
  assert.equal(bundles.selectAuthorizedBackend(claimsFor('S4P100'), production, now), 'S4P100');
  assert.equal(bundles.selectAuthorizedBackend(claimsFor('S4D100'), production, now), null);
  const mixed = claimsFor('S4P100');
  mixed.scope.push(`${policy.scopePrefix}.S4D100.Access`);
  assert.equal(bundles.selectAuthorizedBackend(mixed, production, now), null);
});

const config = {
  name: 'S4_BusinessPartner', basePath: '/s4/business-partner/v1', serviceType: 'odata',
  backendPath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
  issuer: policy.issuer, jwksUrl: 'https://tenant.authentication.eu20.hana.ondemand.com/token_keys',
  scopePrefix: policy.scopePrefix, environment: 'production',
  systems: [{ id: 'S4D100', provider: 'S4D_100', kvm: 'S4D100Backend' }]
};

test('refuses a production deployment containing a non-production backend', () => {
  assert.throws(() => bundles.buildRoutedApiProxyBundle(config), /production.*S4P/i);
});

test('refuses ambiguous duplicate route authorities before deployment', () => {
  assert.throws(() => bundles.buildRoutedApiProxyBundle({ ...config, environment: 'non-production', systems: [config.systems[0], config.systems[0]] }), /duplicate/i);
});

test('refuses routes that would share a backend credential-policy name', () => {
  assert.throws(() => bundles.buildRoutedApiProxyBundle({
    ...config, environment: 'non-production',
    systems: [config.systems[0], { id: 'S4D200', provider: 'S4D_200', kvm: 'S4D200Backend' }]
  }), /duplicate.*backend/i);
});

test('refuses a JWKS endpoint outside the configured trusted issuer origin', () => {
  assert.throws(() => bundles.buildRoutedApiProxyBundle({ ...config, environment: 'non-production', jwksUrl: 'https://untrusted.example/token_keys' }), /JWKS.*origin/i);
});
