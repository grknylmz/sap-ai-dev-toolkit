import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteHanaIdentifier, resolveHanaReadOnlyConfig } from '../src/hana-config.mjs';
import { hanaConnectionOptions, HanaDatabase } from '../src/hana-database.mjs';

const explicitEnv = {
  HANA_RO_HOST: 'hana.example.test',
  HANA_RO_PORT: '443',
  HANA_RO_USER: 'INSPECTOR',
  HANA_RO_PASSWORD: 'do-not-print-this',
  HANA_RO_SCHEMA: 'HDI_CONTAINER_SCHEMA'
};

function vcapBinding(name, user = 'INSPECTOR') {
  return {
    name,
    binding_name: name,
    credentials: {
      host: 'hana.example.test',
      port: 443,
      user,
      password: 'vcap-secret-not-for-output',
      schema: 'HDI_CONTAINER_SCHEMA',
      hdi_user: 'HDI_DEPLOYER',
      hdi_password: 'never-use-this'
    }
  };
}

test('resolves explicit read-only configuration and never disables TLS verification', () => {
  const config = resolveHanaReadOnlyConfig(explicitEnv);
  assert.equal(config.source, 'environment');
  assert.equal(config.user, 'INSPECTOR');
  assert.equal(config.password, 'do-not-print-this');
  assert.equal(config.schema, 'HDI_CONTAINER_SCHEMA');
  assert.equal(Object.isFrozen(config), true);
  const options = hanaConnectionOptions(config);
  assert.equal(options.encrypt, true);
  assert.equal(options.sslValidateCertificate, true);
  assert.equal(options.currentSchema, 'HDI_CONTAINER_SCHEMA');
  assert.equal(options.pwd, 'do-not-print-this');
});

test('rejects incomplete explicit credentials instead of falling back to VCAP', () => {
  assert.throws(() => resolveHanaReadOnlyConfig({
    ...explicitEnv,
    HANA_RO_PASSWORD: '',
    VCAP_SERVICES: JSON.stringify({ hana: [vcapBinding('fallback')] })
  }), /Explicit HANA read-only configuration is incomplete/);
});

test('resolves one selected HANA VCAP binding without using HDI deployment credentials', () => {
  const config = resolveHanaReadOnlyConfig({
    VCAP_SERVICES: JSON.stringify({ hana: [vcapBinding('inspection-binding')] }),
    HANA_RO_BINDING: 'inspection-binding'
  });
  assert.equal(config.source, 'vcap-services');
  assert.equal(config.bindingName, 'inspection-binding');
  assert.equal(config.serviceName, 'hana');
  assert.equal(config.user, 'INSPECTOR');
  assert.equal(config.schema, 'HDI_CONTAINER_SCHEMA');
  assert.equal(config.password, 'vcap-secret-not-for-output');
});

test('fails closed when VCAP contains multiple HANA bindings', () => {
  const env = {
    VCAP_SERVICES: JSON.stringify({ hana: [vcapBinding('first'), vcapBinding('second')] })
  };
  assert.throws(() => resolveHanaReadOnlyConfig(env), /Multiple HANA VCAP bindings/);
  assert.equal(resolveHanaReadOnlyConfig({ ...env, HANA_RO_BINDING: 'second' }).bindingName, 'second');
});

test('rejects an HDI-deployer-only binding and does not disclose its credentials', () => {
  const deployerOnly = {
    name: 'deployer-only',
    credentials: {
      host: 'hana.example.test',
      port: 443,
      schema: 'HDI_CONTAINER_SCHEMA',
      hdi_user: 'HDI_DEPLOYER',
      hdi_password: 'never-use-this'
    }
  };
  assert.throws(() => resolveHanaReadOnlyConfig({
    VCAP_SERVICES: JSON.stringify({ hana: [deployerOnly] })
  }), error => {
    assert.match(error.message, /separate read-only binding/);
    assert.doesNotMatch(error.message, /never-use-this/);
    return true;
  });
});

test('rejects a VCAP binding that aliases its read-only and deployment usernames', () => {
  const binding = vcapBinding('aliased-binding', 'HDI_DEPLOYER');
  assert.throws(() => resolveHanaReadOnlyConfig({
    VCAP_SERVICES: JSON.stringify({ hana: [binding] })
  }), /aliases its read-only and HDI deployment users/);
});

test('rejects bad host, port, missing schema, and missing VCAP configuration', () => {
  assert.throws(() => resolveHanaReadOnlyConfig({ ...explicitEnv, HANA_RO_HOST: 'https://hana.example.test' }), /hostname/);
  assert.throws(() => resolveHanaReadOnlyConfig({ ...explicitEnv, HANA_RO_PORT: '70000' }), /between 1 and 65535/);
  assert.throws(() => resolveHanaReadOnlyConfig({ ...explicitEnv, HANA_RO_SCHEMA: '' }), /incomplete/);
  assert.throws(() => resolveHanaReadOnlyConfig({}), /Set HANA_RO_\*/);
});

test('quotes identifiers by doubling embedded quotes and rejects control characters', () => {
  assert.equal(quoteHanaIdentifier('A"B'), '"A""B"');
  assert.throws(() => quoteHanaIdentifier('bad\nname'), /identifier is invalid/);
});

test('serializes database calls, passes bind values, and redacts native driver errors', async () => {
  const calls = [];
  let disconnects = 0;
  const connection = {
    connect(options, callback) {
      calls.push({ type: 'connect', options });
      callback(null);
    },
    exec(sql, params, options, callback) {
      calls.push({ type: 'exec', sql, params, options });
      if (sql === 'FAIL') callback(Object.assign(new Error('password=do-not-print-this'), { code: 'HY000' }));
      else callback(null, [{ OK: true }]);
    },
    disconnect(callback) {
      disconnects += 1;
      callback(null);
    }
  };
  const db = new HanaDatabase(connection, resolveHanaReadOnlyConfig(explicitEnv));
  await db.connect();
  assert.deepEqual(await db.query('SELECT ? FROM DUMMY', ['value']), [{ OK: true }]);
  await assert.rejects(db.query('FAIL'), error => {
    assert.equal(error.name, 'HanaDatabaseError');
    assert.match(error.message, /HANA error HY000/);
    assert.doesNotMatch(error.message, /do-not-print-this/);
    return true;
  });
  assert.equal(calls[0].options.sslValidateCertificate, true);
  assert.equal(calls[1].params[0], 'value');
  assert.deepEqual(calls[1].options, {});
  await db.close();
  await db.close();
  assert.equal(disconnects, 1);
});

test('times out a hung read, requests cancellation, and retires its connection', async () => {
  let cancels = 0;
  let disconnects = 0;
  const connection = {
    connect(_options, callback) { callback(null); },
    exec() {},
    cancel() { cancels += 1; },
    disconnect(callback) { disconnects += 1; callback(null); }
  };
  const db = new HanaDatabase(connection, resolveHanaReadOnlyConfig(explicitEnv), { queryTimeoutMs: 5 });
  await db.connect();
  await assert.rejects(db.query('SELECT HANG FROM DUMMY'), error => {
    assert.equal(error.name, 'HanaQueryTimeoutError');
    assert.match(error.message, /time limit/);
    assert.doesNotMatch(error.message, /do-not-print-this/);
    return true;
  });
  assert.equal(cancels, 1);
  assert.equal(disconnects, 1);
  assert.equal(db.unusable, true);
  await assert.rejects(db.query('SELECT 1 FROM DUMMY'), /not available/);
});