import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QUERY_TIMEOUT_MS = 15_000;

function hanaFailure(operation, error) {
  const code = typeof error?.code === 'string' || typeof error?.code === 'number'
    ? String(error.code).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
    : '';
  const failure = new Error(`${operation} failed${code ? ` (HANA error ${code})` : ''}; verify the selected read-only binding, schema, and privileges.`);
  failure.name = 'HanaDatabaseError';
  return failure;
}

function callbackPromise(invoke, operation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(hanaFailure(operation, error));
      else resolve(result);
    };
    try {
      invoke(done);
    } catch (error) {
      done(error);
    }
  });
}

function executeWithTimeout(connection, sql, values, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      const error = new Error(`HANA read exceeded the ${timeoutMs / 1000} second time limit; the connection was retired. Narrow the request and retry.`);
      error.name = 'HanaQueryTimeoutError';
      reject(error);
    }, timeoutMs);
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(hanaFailure('HANA read', error));
      else resolve(result);
    };
    try {
      connection.exec(sql, values, {}, done);
    } catch (error) {
      done(error);
    }
  });
}

export function hanaConnectionOptions(config) {
  return {
    host: config.host,
    port: config.port,
    uid: config.user,
    pwd: config.password,
    currentSchema: config.schema,
    encrypt: true,
    sslValidateCertificate: true,
    connectTimeout: 10_000,
    ...(config.trustStore ? { sslTrustStore: config.trustStore } : {})
  };
}

export class HanaDatabase {
  constructor(connection, config, { queryTimeoutMs = QUERY_TIMEOUT_MS } = {}) {
    this.connection = connection;
    this.config = config;
    this.queryTimeoutMs = queryTimeoutMs;
    this.connected = false;
    this.closed = false;
    this.unusable = false;
    this.queue = Promise.resolve();
  }

  async connect() {
    if (this.closed) throw new Error('HANA connection is closed.');
    if (this.connected) return this;
    await callbackPromise(
      callback => this.connection.connect(hanaConnectionOptions(this.config), callback),
      'HANA connection'
    );
    this.connected = true;
    return this;
  }

  async query(sql, values = []) {
    if (!this.connected || this.closed || this.unusable) throw new Error('HANA connection is not available.');
    if (typeof sql !== 'string' || !sql.trim() || !Array.isArray(values)) {
      throw new Error('Invalid internal HANA query request.');
    }
    const result = this.queue.then(() => executeWithTimeout(
      this.connection,
      sql,
      values,
      this.queryTimeoutMs,
      () => {
        this.unusable = true;
        try { this.connection.cancel?.(); } catch {}
      }
    ));
    this.queue = result.then(() => undefined, () => undefined);
    try {
      return await result;
    } catch (error) {
      if (this.unusable) await this.close();
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => {});
    if (!this.connected) return;
    this.connected = false;
    await callbackPromise(callback => this.connection.disconnect(callback), 'HANA disconnect').catch(() => {});
  }
}

export async function connectReadOnlyHana(config, { driver } = {}) {
  let selectedDriver = driver;
  if (!selectedDriver) {
    try {
      selectedDriver = require('@sap/hana-client');
    } catch {
      throw new Error('The SAP HANA Node.js driver could not be loaded for this platform.');
    }
  }
  if (typeof selectedDriver?.createConnection !== 'function') {
    throw new Error('The configured SAP HANA Node.js driver is unavailable.');
  }

  const connection = selectedDriver.createConnection();
  const database = new HanaDatabase(connection, config);
  try {
    await database.connect();
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}