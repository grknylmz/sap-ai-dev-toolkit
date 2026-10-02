import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function filteredHeaders(headers) {
  const result = { ...headers };
  for (const name of Object.keys(result)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) delete result[name];
  }
  return result;
}

function requestHeaders(headers, backend) {
  return { ...filteredHeaders(headers), host: backend.host };
}

function parseSubjectAltName(value) {
  return String(value || '')
    .split(/,\s*/)
    .map(item => item.match(/^DNS:(.+)$/i)?.[1]?.trim())
    .filter(Boolean);
}

export async function discoverCertificateDnsNames(destinationUrl) {
  const backend = new URL(destinationUrl);
  if (backend.protocol !== 'https:') return [];
  const socket = tls.connect({
    host: backend.hostname,
    port: Number(backend.port || 443),
    ...(isIP(backend.hostname) ? {} : { servername: backend.hostname }),
    rejectUnauthorized: false
  });
  try {
    await once(socket, 'secureConnect');
    const certificate = socket.getPeerCertificate();
    return [...new Set(parseSubjectAltName(certificate?.subjectaltname))];
  } finally {
    socket.destroy();
  }
}

function responseHeaders(headers, backend, clientReq) {
  const result = filteredHeaders(headers);
  const location = result.location;
  if (typeof location === 'string') {
    try {
      const parsed = new URL(location, backend);
      if (parsed.origin === backend.origin) {
        result.location = `http://${clientReq.headers.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {}
  }
  return result;
}

/**
 * Starts a loopback HTTP reverse proxy for ADT HTTPS endpoints whose network
 * address and certificate identity differ. The proxy dials the configured
 * backend URL but verifies TLS with tlsServerName; CA validation stays enabled.
 */
export async function createTlsServerNameAdtProxy({ destinationUrl, tlsServerName, tlsServerNames, caFile } = {}) {
  const backend = new URL(destinationUrl);
  if (backend.protocol !== 'https:') throw new Error('TLS server-name override requires an https:// SAP URL.');
  const serverNames = [...new Set([...(Array.isArray(tlsServerNames) ? tlsServerNames : []), ...String(tlsServerName || '').split(',')].map(value => String(value || '').trim()).filter(Boolean))];
  if (!serverNames.length) throw new Error('TLS server-name override requires a DNS name.');

  const ca = caFile ? await readFile(caFile) : undefined;
  const server = http.createServer((clientReq, clientRes) => {
    let target;
    try {
      target = new URL(clientReq.url || '/', backend);
      if (target.origin !== backend.origin) throw new Error('cross-origin request rejected');
    } catch (error) {
      clientRes.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      clientRes.end(`ADT TLS proxy rejected request: ${error.message}`);
      return;
    }
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', () => {
      const body = Buffer.concat(chunks);
      const tryServerName = index => {
        const request = https.request({
          protocol: 'https:',
          hostname: backend.hostname,
          port: backend.port || 443,
          method: clientReq.method,
          path: `${target.pathname}${target.search}`,
          headers: requestHeaders(clientReq.headers, backend),
          servername: serverNames[index],
          rejectUnauthorized: true,
          ...(ca ? { ca } : {})
        }, backendRes => {
          clientRes.writeHead(backendRes.statusCode || 502, backendRes.statusMessage, responseHeaders(backendRes.headers, backend, clientReq));
          backendRes.pipe(clientRes);
        });
        request.on('error', error => {
          if (index + 1 < serverNames.length && /certificate|hostname|altname|x509/i.test(error.message)) return tryServerName(index + 1);
          if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          clientRes.end(`ADT TLS proxy failed: ${error.message}`);
        });
        request.end(body);
      };
      tryServerName(0);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}
