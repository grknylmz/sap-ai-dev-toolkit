import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEngineeringTools } from '../src/engineering-tools.mjs';

const SOURCE = "REPORT zdemo.\nWRITE 'hello'.";

function textResult(text) {
  return { result: { content: [{ type: 'text', text }], isError: false } };
}

// A fake entry whose child answers tools/call requests from a plain map;
// calls are recorded so tests can assert what actually reached the child.
function fakeEntry({ tools = ['GetSource', 'WriteSource', 'GetTransport', 'GetAPIReleaseState'], respond } = {}) {
  const calls = [];
  const entry = {
    destination: { name: 'alpha', url: 'http://127.0.0.1:1', client: '001' },
    child: {
      request: async (method, params) => {
        if (method !== 'tools/call') return { result: {} };
        calls.push({ name: params.name, arguments: params.arguments });
        return respond ? respond(params.name, params.arguments) : textResult('ok');
      }
    }
  };
  const upstreamTools = tools.map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  const built = createEngineeringTools(entry, upstreamTools, { env: {}, log: () => {} });
  const handlers = new Map(built.map(tool => [tool.definition.name, tool.handler]));
  return { entry, calls, handlers };
}

const change = (objectName = 'ZDEMO', current = SOURCE, replacement = `${SOURCE}\n" changed\n`) => ({
  object_type: 'PROG',
  object_name: objectName,
  source_arguments: { object_type: 'PROG', name: objectName },
  current_source: current,
  replacement_source: replacement,
  write_tool: 'WriteSource',
  write_arguments: { object_type: 'PROG', name: objectName, source: replacement }
});

const prepare = async (handlers, changes, title = 'test change set') =>
  JSON.parse((await handlers.get('PrepareABAPChangeSet')({ title, changes })).content[0].text);

const apply = async (handlers, changeSetId) =>
  JSON.parse((await handlers.get('ApplyABAPChangeSet')({ change_set_id: changeSetId })).content[0].text);

test('PrepareABAPChangeSet stages diffs and fingerprints without contacting SAP', async () => {
  const { calls, handlers } = fakeEntry();
  const result = await prepare(handlers, [change()]);
  assert.equal(result.status, 'staged');
  assert.equal(result.changes.length, 1);
  assert.match(result.changes[0].diff, /\+" changed/);
  assert.match(result.changes[0].expected_sha256, /^[0-9a-f]{64}$/);
  assert.equal(calls.length, 0, 'preparing must not call the destination');
});

test('PrepareABAPChangeSet rejects duplicate objects, oversize sources, and identity mismatches', async () => {
  const { handlers } = fakeEntry();
  const duplicate = await handlers.get('PrepareABAPChangeSet')({ title: 't', changes: [change('ZA'), change('ZA')] });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /duplicate object PROG ZA/);

  const big = 'x'.repeat(128 * 1024 + 1);
  const oversize = await handlers.get('PrepareABAPChangeSet')({ title: 't', changes: [change('ZBIG', big, `${big}!`)] });
  assert.equal(oversize.isError, true);
  assert.match(oversize.content[0].text, /exceeds 131072 bytes/);

  const manyLines = Array.from({ length: 1001 }, (_, index) => `line ${index}`).join('\n');
  const tooManyLines = await handlers.get('PrepareABAPChangeSet')({ title: 't', changes: [change('ZLINES', manyLines, `${manyLines}!`)] });
  assert.equal(tooManyLines.isError, true);
  assert.match(tooManyLines.content[0].text, /1,000-line/);

  const mismatched = change('ZA');
  mismatched.source_arguments.name = 'ZOTHER';
  const identity = await handlers.get('PrepareABAPChangeSet')({ title: 't', changes: [mismatched] });
  assert.equal(identity.isError, true);
  assert.match(identity.content[0].text, /must identify the same object/);

  const missing = change('ZMISS');
  delete missing.write_arguments.source;
  const uncontained = await handlers.get('PrepareABAPChangeSet')({ title: 't', changes: [missing] });
  assert.equal(uncontained.isError, true);
  assert.match(uncontained.content[0].text, /must contain the exact replacement_source/);
});

test('ApplyABAPChangeSet re-reads sources and applies only unchanged objects', async () => {
  const { calls, handlers } = fakeEntry({
    respond: name => (name === 'GetSource' ? textResult(SOURCE) : textResult('written'))
  });
  const staged = await prepare(handlers, [change()]);
  const result = await apply(handlers, staged.change_set_id);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.applied, [{ object_type: 'PROG', object_name: 'ZDEMO', status: 'applied' }]);
  assert.equal(calls.filter(call => call.name === 'GetSource').length, 1);
  assert.equal(calls.filter(call => call.name === 'WriteSource').length, 1);
  const reapply = await handlers.get('ApplyABAPChangeSet')({ change_set_id: staged.change_set_id });
  assert.equal(reapply.isError, true);
  assert.match(reapply.content[0].text, /already been applied/);
});

test('ApplyABAPChangeSet reports a conflict when the source changed since review', async () => {
  const { calls, handlers } = fakeEntry({
    respond: name => (name === 'GetSource' ? textResult(`${SOURCE}\n" someone else edited this\n`) : textResult('written'))
  });
  const staged = await prepare(handlers, [change()]);
  const result = await apply(handlers, staged.change_set_id);
  assert.equal(result.status, 'conflict');
  assert.equal(result.applied.length, 0);
  assert.equal(calls.filter(call => call.name === 'WriteSource').length, 0, 'a conflicted change must not be written');
});

test('ApplyABAPChangeSet reports partial application when a later change fails', async () => {
  const callsSoFar = { getSource: 0 };
  const { handlers } = fakeEntry({
    respond: name => {
      if (name !== 'GetSource') return textResult('written');
      callsSoFar.getSource += 1;
      if (callsSoFar.getSource === 2) throw new Error('GetSource failed for second object');
      return textResult(SOURCE);
    }
  });
  const staged = await prepare(handlers, [change('ZFIRST'), change('ZSECOND', `${SOURCE}\n" two\n`, `${SOURCE}\n" two!\n" edited\n`)]);
  const result = await apply(handlers, staged.change_set_id);
  assert.equal(result.status, 'partially-applied');
  assert.deepEqual(result.applied.map(entry => entry.object_name), ['ZFIRST']);
  assert.equal(result.remaining, 1);
});

test('CheckTransportReadiness requires exactly one matching GetTransport check', async () => {
  const { handlers } = fakeEntry({ tools: ['GetSource', 'WriteSource', 'GetTransport', 'RunATCCheck', 'ListDependencies'] });
  const missing = await handlers.get('CheckTransportReadiness')({ transport_id: 'T1', checks: [{ tool: 'ListDependencies', arguments: {} }] });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /exactly one GetTransport/);

  const mismatch = await handlers.get('CheckTransportReadiness')({ transport_id: 'T1', checks: [{ tool: 'GetTransport', arguments: { transport: 'T2' } }] });
  assert.equal(mismatch.isError, true);

  const unsupported = await handlers.get('CheckTransportReadiness')({ transport_id: 'T1', checks: [{ tool: 'GetTransport', arguments: { transport: 'T1' } }, { tool: 'ReleaseTransport', arguments: {} }] });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0].text, /supported read\/check tool/);
});

test('CheckTransportReadiness collects evidence and counts failures honestly', async () => {
  const { handlers } = fakeEntry({
    tools: ['GetSource', 'WriteSource', 'GetTransport', 'RunATCCheck'],
    respond: name => (name === 'RunATCCheck' ? Promise.reject(new Error('ATC unavailable; password=oops')) : textResult('{"findings":[]}'))
  });
  const result = JSON.parse((await handlers.get('CheckTransportReadiness')({
    transport_id: 'T1',
    checks: [
      { tool: 'GetTransport', arguments: { transport: 'T1' } },
      { tool: 'RunATCCheck', arguments: {} }
    ]
  })).content[0].text);
  assert.equal(result.status, 'evidence-incomplete');
  assert.equal(result.checks_completed, 1);
  assert.equal(result.checks_failed, 1);
  assert.match(result.checks[1].error, /ATC unavailable/);
  assert.doesNotMatch(result.checks[1].error, /oops/, 'failure detail must be redacted');
});

test('PlanABAPCloudMigration classifies release evidence and orders not-released first', async () => {
  const { handlers } = fakeEntry({
    respond: (_name, args) => textResult(JSON.stringify({ object_uri: args.object_uri, isReleased: args.object_uri.includes('released') }))
  });
  const result = JSON.parse((await handlers.get('PlanABAPCloudMigration')({
    objects: [
      { name: 'ZRELEASED', object_uri: '/sap/bc/adt/oo/classes/zreleased' },
      { name: 'ZSECRET', object_uri: '/sap/bc/adt/oo/classes/zsecret' },
      { name: 'ZBAD', object_uri: 'not-an-adt-uri' }
    ]
  })).content[0].text);
  assert.equal(result.assessed, 3);
  assert.equal(result.failures, 1);
  assert.deepEqual(result.migration_review_order.map(entry => entry.release_state), ['not-released', 'released']);
  assert.equal(result.results.find(entry => entry.name === 'ZBAD').status, 'invalid');
});

// ---- RAP regression suites ----

async function withODataService(entityCount, handler) {
  const metadata = `<?xml version="1.0"?><edmx:Edmx><edmx:DataServices><Schema><EntityContainer>${Array.from({ length: entityCount }, (_, index) => `<EntitySet Name="Set${index}"/>`).join('')}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('$metadata')) {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(metadata);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: [{ ID: '1' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await handler(url);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('GenerateRAPRegressionSuite caps the suite at 30 cases and notes omissions', async () => {
  await withODataService(35, async url => {
    const { handlers } = fakeEntry({ tools: [] });
    const entry = { destination: { name: 'alpha', url, client: '001' }, child: { request: async () => ({ result: {} }) } };
    const built = createEngineeringTools(entry, [], { env: {}, log: () => {} });
    const generate = built.find(tool => tool.definition.name === 'GenerateRAPRegressionSuite').handler;
    const result = JSON.parse((await generate({ service_root: '/sap/opu/odata/srv/' })).content[0].text);
    assert.equal(result.entity_set_count, 35);
    assert.equal(result.suite.cases.length, 30, 'generated suite must satisfy the runner cap');
    assert.match(result.note, /6 entity sets were omitted/);
  });
});

test('GenerateRAPRegressionSuite round-trips through RunRAPRegressionSuite against a loopback service', async () => {
  await withODataService(2, async url => {
    const entry = { destination: { name: 'alpha', url, client: '001' }, child: { request: async () => ({ result: {} }) } };
    const built = createEngineeringTools(entry, [], { env: {}, log: () => {} });
    const generate = built.find(tool => tool.definition.name === 'GenerateRAPRegressionSuite').handler;
    const run = built.find(tool => tool.definition.name === 'RunRAPRegressionSuite').handler;
    const generated = JSON.parse((await generate({ service_root: '/sap/opu/odata/srv/' })).content[0].text);
    // Add an assertion to the first entity-set case and force one wrong expectation.
    generated.suite.cases[1].assertions = [{ json_path: 'value', operator: 'array' }];
    generated.suite.cases[2].expected_status = 500;
    const result = JSON.parse((await run({ suite: generated.suite })).content[0].text);
    assert.equal(result.passed, 2);
    assert.equal(result.failed, 1);
    const metadata = result.results.find(entry => entry.name === 'OData metadata');
    assert.equal(metadata.status, 'passed');
    const wrong = result.results.find(entry => entry.http_status !== undefined && entry.name.startsWith('Read Set') && entry.status === 'failed');
    assert.ok(wrong, 'the forced wrong expectation must fail');
  });
});

test('RAP suite tools reject service roots outside /sap/opu/odata and dot segments', async () => {
  const entry = { destination: { name: 'alpha', url: 'http://127.0.0.1:9', client: '001' }, child: { request: async () => ({ result: {} }) } };
  const built = createEngineeringTools(entry, [], { env: {}, log: () => {} });
  const generate = built.find(tool => tool.definition.name === 'GenerateRAPRegressionSuite').handler;
  const offRoot = await generate({ service_root: '/other/root/' });
  assert.equal(offRoot.isError, true);
  assert.match(offRoot.content[0].text, /\/sap\/opu\/odata/);
  const dotSegments = await generate({ service_root: '/sap/opu/odata/srv/../../evil/' });
  assert.equal(dotSegments.isError, true);
  assert.match(dotSegments.content[0].text, /must be a query-free/);
});

test('RAP suite generation over a .dest host without a proxy fails closed', async () => {
  const entry = { destination: { name: 'alpha', url: 'http://alpha.dest', client: '001' }, child: { request: async () => ({ result: {} }) } };
  const built = createEngineeringTools(entry, [], { env: {}, log: () => {} });
  const generate = built.find(tool => tool.definition.name === 'GenerateRAPRegressionSuite').handler;
  const result = await generate({ service_root: '/sap/opu/odata/srv/' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No HTTP proxy is configured for the \.dest destination|fetch failed/);
});
