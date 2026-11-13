import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDatasphereConfig, parseDatasphereCredentials } from '../src/datasphere-config.mjs';
import { datasphereCredentialsPath, readStoredDatasphereCredentials, storeDatasphereCredentials, updateStoredRefreshToken } from '../src/datasphere-credentials.mjs';

const base = {
  url: 'https://tenant.eu10.hcs.cloud.sap',
  tokenUrl: 'https://tenant.authentication.eu10.hana.ondemand.com/oauth/token',
  clientId: 'sb-client!t1',
  clientSecret: 'secret-1'
};

test('environment beats the stored record', () => {
  const config = resolveDatasphereConfig({
    ...envWith(base),
    DATASPHERE_SQL_HOST: 'sql.example',
    DATASPHERE_SQL_USER: 'SQLUSER',
    DATASPHERE_SQL_PASSWORD: 'sql-secret'
  }, { stored: { auth: 'technical', url: 'https://other.example', tokenurl: 'https://other.example/oauth/token', clientid: 'a', clientsecret: 'b' } });
  assert.equal(config.source, 'environment');
  assert.equal(config.url, 'https://tenant.eu10.hcs.cloud.sap');
  assert.equal(config.sql.user, 'SQLUSER');
});

function envWith(values) {
  return {
    DATASPHERE_URL: values.url,
    DATASPHERE_TOKEN_URL: values.tokenUrl,
    DATASPHERE_CLIENT_ID: values.clientId,
    DATASPHERE_CLIENT_SECRET: values.clientSecret
  };
}

test('partial base environment names the missing keys', () => {
  assert.throws(() => resolveDatasphereConfig({ DATASPHERE_URL: 'https://x.example' }), /Explicit DATASPHERE configuration is incomplete: DATASPHERE_TOKEN_URL/);
});

test('interactive auth without refresh token fails with setup guidance', () => {
  assert.throws(
    () => resolveDatasphereConfig({ ...envWith(base), DATASPHERE_AUTH: 'interactive', DATASPHERE_AUTHORIZATION_URL: 'https://tenant.example/oauth/authorize' }),
    /DATASPHERE_REFRESH_TOKEN is required for interactive sign-in; run sap-ai-dev --setup-datasphere/
  );
});

test('tenant URLs with paths and hash routes collapse to the origin', () => {
  const config = parseDatasphereCredentials({ ...base, url: 'https://tenant.eu10.hcs.cloud.sap/#/stories' }, 'environment');
  assert.equal(config.url, 'https://tenant.eu10.hcs.cloud.sap');
});

test('non-loopback http tenant URLs are rejected', () => {
  assert.throws(() => parseDatasphereCredentials({ ...base, url: 'http://tenant.example' }, 'environment'), /DATASPHERE_URL must use https/);
});

test('token URLs gain the /oauth/token suffix', () => {
  const config = parseDatasphereCredentials({ ...base, tokenUrl: 'https://tenant.authentication.eu10.hana.ondemand.com' }, 'environment');
  assert.equal(config.tokenUrl, 'https://tenant.authentication.eu10.hana.ondemand.com/oauth/token');
});

test('partial SQL environment names the missing keys', () => {
  assert.throws(() => resolveDatasphereConfig({ ...envWith(base), DATASPHERE_SQL_HOST: 'sql.example' }), /Explicit DATASPHERE_SQL configuration is incomplete: DATASPHERE_SQL_USER, DATASPHERE_SQL_PASSWORD/);
});

test('SQL port defaults to 443 and schema to the user; other validation applies', () => {
  const config = resolveDatasphereConfig({ ...envWith(base), DATASPHERE_SQL_HOST: 'sql.example', DATASPHERE_SQL_USER: 'U1', DATASPHERE_SQL_PASSWORD: 'p' });
  assert.deepEqual({ ...config.sql }, { host: 'sql.example', port: 443, user: 'U1', password: 'p', schema: 'U1' });
  assert.throws(
    () => resolveDatasphereConfig({ ...envWith(base), DATASPHERE_SQL_HOST: 'sql.example', DATASPHERE_SQL_USER: 'U1', DATASPHERE_SQL_PASSWORD: 'p', DATASPHERE_SQL_PORT: 'https://x' }),
    /DATASPHERE_SQL_PORT must be an integer between 1 and 65535/
  );
  assert.throws(
    () => resolveDatasphereConfig({ ...envWith(base), DATASPHERE_SQL_HOST: 'https://sql.example', DATASPHERE_SQL_USER: 'U1', DATASPHERE_SQL_PASSWORD: 'p' }),
    /DATASPHERE_SQL_HOST must be a host name, not a URL/
  );
});

test('no configuration at all yields the setup guidance message', () => {
  assert.throws(() => resolveDatasphereConfig({}), /Configure Datasphere \(DATASPHERE_URL\/DATASPHERE_TOKEN_URL\/DATASPHERE_CLIENT_ID\/DATASPHERE_CLIENT_SECRET\)/);
});

test('stored record is used when the environment has no base keys', () => {
  const config = resolveDatasphereConfig({}, {
    stored: { auth: 'interactive', url: 'https://tenant.example', tokenurl: 'https://auth.example/oauth/token', clientid: 'c', clientsecret: 's', authorizationurl: 'https://auth.example/oauth/authorize', refreshtoken: 'r1' }
  });
  assert.equal(config.source, 'stored-key');
  assert.equal(config.auth, 'interactive');
  assert.equal(config.refreshToken, 'r1');
});

test('credential store round-trips and refresh-token updates preserve neighbors', async t => {
  const home = await mkdtemp(join(tmpdir(), 'datasphere-creds-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: undefined };
  assert.equal(await readStoredDatasphereCredentials(env), undefined);
  const path = await storeDatasphereCredentials({ auth: 'interactive', url: 'https://t.example', tokenurl: 'https://a.example/oauth/token', clientid: 'c', clientsecret: 's', authorizationurl: 'https://a.example/oauth/authorize', refreshtoken: 'r1' }, env);
  assert.equal(path, datasphereCredentialsPath(env));
  const stored = await readStoredDatasphereCredentials(env);
  assert.equal(stored.refreshtoken, 'r1');
  await updateStoredRefreshToken('r2', env);
  assert.equal((await readStoredDatasphereCredentials(env)).refreshtoken, 'r2');

  await writeFile(datasphereCredentialsPath(env), 'not json', 'utf8');
  await assert.rejects(async () => readStoredDatasphereCredentials(env), /are not valid JSON; rerun sap-ai-dev --setup-datasphere/);
});

test('a stored record with SQL is normalized through parseDatasphereCredentials', () => {
  const config = resolveDatasphereConfig({}, {
    stored: { auth: 'technical', url: 'https://tenant.example', tokenurl: 'https://auth.example/oauth/token', clientid: 'c', clientsecret: 's', sql: { host: 'sql.example', user: 'U1', password: 'p', port: 443, schema: 'MY_SCHEMA' } }
  });
  assert.deepEqual({ ...config.sql }, { host: 'sql.example', port: 443, user: 'U1', password: 'p', schema: 'MY_SCHEMA' });
});
