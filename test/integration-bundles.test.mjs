import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { buildApiProxyBundle } from '../src/apim-bundle.mjs';
import {
  buildIflowBundle,
  bumpPatchVersion,
  mergePropdef,
  parseProperties,
  propertiesText,
  readBundle,
  replaceManifestVersion
} from '../src/iflow-bundle.mjs';

const templateParameters = {
  sender_path: '/orders',
  receiver_address: 'http://s4h-virtual:443/sap/opu/odata4/x',
  receiver_method: 'GET',
  receiver_proxy_type: 'on_premise',
  receiver_location_id: 'LOC1',
  receiver_authentication: 'Basic',
  receiver_credential_name: 'S4H_USER',
  receiver_timeout_ms: 60000
};

function text(files, path) {
  return strFromU8(files.get(path));
}

test('template iFlow bundle has exactly the expected files, a JAR-wrapped manifest, and mapped parameters', () => {
  const files = readBundle(buildIflowBundle({ id: 'Z_Orders_Flow', name: 'Orders Flow', template: 'https-request-reply-http', templateParameters }));
  assert.deepEqual([...files.keys()].sort(), [
    'META-INF/MANIFEST.MF',
    'metainfo.prop',
    'src/main/resources/parameters.prop',
    'src/main/resources/parameters.propdef',
    'src/main/resources/scenarioflows/integrationflow/Z_Orders_Flow.iflw'
  ]);
  const manifest = text(files, 'META-INF/MANIFEST.MF');
  assert.ok(manifest.endsWith('\r\n'));
  for (const line of manifest.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 72, `manifest line too long: ${line}`);
  const unwrapped = manifest.replace(/\r\n /g, '');
  assert.match(unwrapped, /^Bundle-SymbolicName: Z_Orders_Flow; singleton:=true\r$/m);
  assert.match(unwrapped, /^Import-Service: com\.sap\.esb\.webservice\.audit\.log\.AuditLogger,.*SignatureSplitter;multiple:=false\r$/m);

  const parameters = parseProperties(text(files, 'src/main/resources/parameters.prop'));
  assert.equal(parameters.Receiver_Proxy_Type, 'sapcc');
  assert.equal(parameters.Receiver_Address, templateParameters.receiver_address);
  assert.equal(parameters.Receiver_Timeout, '60000');
  assert.equal(parameters.Receiver_Query, '');
  const iflw = text(files, 'src/main/resources/scenarioflows/integrationflow/Z_Orders_Flow.iflw');
  for (const key of Object.keys(parameters)) {
    assert.ok(iflw.includes(`{{${key}}}`), `template must reference {{${key}}}`);
    assert.ok(text(files, 'src/main/resources/parameters.propdef').includes(`<name>${key}</name>`));
  }
});

test('custom iFlow mode validates BPMN and script names', () => {
  assert.throws(() => buildIflowBundle({ id: 'Z', name: 'Z', template: 'custom', iflwXml: '<xml/>' }), /iflw_xml must be a BPMN2 iFlow model/);
  assert.throws(() => buildIflowBundle({ id: 'Z', name: 'Z', template: 'custom', iflwXml: '<bpmn2:definitions/>', scripts: [{ name: '../x.groovy', content: '' }] }), /Script name must match/);
  const files = readBundle(buildIflowBundle({ id: 'Z', name: 'Z', template: 'custom', iflwXml: '<bpmn2:definitions/>', scripts: [{ name: 'a.groovy', content: 'x' }] }));
  assert.equal(text(files, 'src/main/resources/script/a.groovy'), 'x');
  assert.equal(files.has('src/main/resources/parameters.prop'), false);
});

test('version bump and manifest rewrite keep the manifest wrapped', () => {
  assert.equal(bumpPatchVersion('1.0.9'), '1.0.10');
  assert.throws(() => bumpPatchVersion('1.0'), /iFlow version 1\.0 is not x\.y\.z/);
  const original = strFromU8(readBundle(buildIflowBundle({ id: 'Z_A', name: 'A', template: 'custom', iflwXml: '<bpmn2:definitions/>', version: '1.0.9' })).get('META-INF/MANIFEST.MF'));
  const rewritten = replaceManifestVersion(original, bumpPatchVersion('1.0.9'));
  assert.match(rewritten.replace(/\r\n /g, ''), /^Bundle-Version: 1\.0\.10\r$/m);
  assert.equal(rewritten.replace(/Bundle-Version: [^\r]+/, ''), original.replace(/Bundle-Version: [^\r]+/, ''));
});

test('properties escape non-ASCII as \\uXXXX (CPI reads ISO-8859-1) and parse it back', () => {
  const values = { Greeting: 'Grüße ü — 😀', Plain: 'x' };
  const text = propertiesText(values);
  assert.match(text, /^[\x20-\x7e\n]*$/, 'written properties must be pure printable ASCII');
  assert.match(text, /Greeting=Gr\\u00FC\\u00DFe \\u00FC \\u2014 \\uD83D\\uDE00/);
  assert.deepEqual(parseProperties(text), values);
  assert.deepEqual(parseProperties('Key=caf\\u00e9\n'), { Key: 'café' }, 'CPI-written lower-case escapes decode');
});

test('properties round-trip escaped separators and propdef merge only appends new keys', () => {
  const values = { 'Key With Space': ' leading=value:with\\slash', Plain: 'x' };
  assert.deepEqual(parseProperties(`#comment\n${propertiesText(values)}`), values);
  const merged = mergePropdef('<parameters><parameter><name>Plain</name></parameter><param_references/></parameters>', ['Plain', 'New']);
  assert.equal((merged.match(/<name>Plain<\/name>/g) || []).length, 1);
  assert.match(merged, /<name>New<\/name>.*<param_references\/>/);
});

test('API proxy bundle targets a provider OData path and escapes text', () => {
  const files = unzipSync(buildApiProxyBundle({
    name: 'ZOrders',
    title: 'Orders & <Items>',
    basePath: '/s4/orders',
    serviceType: 'odata',
    target: { provider: 'S4H', relativePath: '/sap/opu/odata4/sap/zorders/srvd/sap/zorders/0001/' }
  }));
  assert.deepEqual(Object.keys(files).sort(), ['APIProxy/APIProxyEndPoint/default.xml', 'APIProxy/APITargetEndPoint/default.xml', 'APIProxy/ZOrders.xml']);
  const target = strFromU8(files['APIProxy/APITargetEndPoint/default.xml']);
  assert.match(target, /<provider_id>S4H<\/provider_id><relativePath>\/sap\/opu\/odata4\/sap\/zorders\/srvd\/sap\/zorders\/0001\/<\/relativePath>/);
  const proxy = strFromU8(files['APIProxy/ZOrders.xml']);
  assert.match(proxy, /<service_code>ODATA<\/service_code>/);
  assert.match(proxy, /<title>Orders &amp; &lt;Items&gt;<\/title>/);
  assert.match(strFromU8(files['APIProxy/APIProxyEndPoint/default.xml']), /<base_path>\/s4\/orders<\/base_path>/);
  const urlTarget = strFromU8(unzipSync(buildApiProxyBundle({ name: 'P', basePath: '/p', serviceType: 'rest', target: { url: 'https://api.example/x' } }))['APIProxy/APITargetEndPoint/default.xml']);
  assert.match(urlTarget, /<url>https:\/\/api\.example\/x<\/url><provider_id>NONE<\/provider_id>/);
});
