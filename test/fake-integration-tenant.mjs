import { createServer } from 'node:http';

/**
 * Loopback fake for a CPI/APIM tenant: serves /oauth/token and delegates every
 * other request to `handler`. Every request (token included) is recorded.
 */
export async function startFakeTenant(t, handler = () => ({ status: 404 })) {
  const requests = [];
  let tokenCount = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { method: request.method, path: url.pathname, query: url.searchParams, rawQuery: url.search, headers: request.headers, body };
      requests.push(record);
      let reply;
      if (url.pathname === '/oauth/token') {
        tokenCount += 1;
        reply = { status: 200, json: { access_token: `token-${tokenCount}`, expires_in: 3600 } };
      } else {
        reply = await handler(record, requests) ?? { status: 404 };
      }
      const headers = { ...(reply.headers || {}) };
      let payload = reply.body ?? '';
      if (reply.json !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(reply.json);
      }
      response.writeHead(reply.status, headers);
      response.end(payload);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    requests,
    apiRequests: () => requests.filter(request => request.path !== '/oauth/token'),
    tokenRequests: () => requests.filter(request => request.path === '/oauth/token'),
    serviceKey: (secret = 'test-secret') => JSON.stringify({ oauth: { url, tokenurl: `${url}/oauth/token`, clientid: 'client', clientsecret: secret } })
  };
}
