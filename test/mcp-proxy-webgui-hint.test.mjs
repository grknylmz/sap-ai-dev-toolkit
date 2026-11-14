import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBGUI_HINT, withWebguiHint } from '../src/mcp-proxy.mjs';

const error = text => ({ isError: true, content: [{ type: 'text', text }] });
const hinted = result => result.content.some(item => item.text === WEBGUI_HINT);

test('appends the WebGUI hint to ADT capability-gap errors only', () => {
  for (const text of [
    'no endpoint for this object type',
    'operation not supported on this system',
    'Object type SM37 is unsupported',
    'HTTP 501 Not Implemented'
  ]) assert.equal(hinted(withWebguiHint(error(text))), true, text);

  for (const text of [
    'HTTP 404 on /sap/bc/adt/oo/classes/zcl_missing: Not Found',
    'HTTP 403 Forbidden on /sap/bc/adt/runtime/dumps',
    'syntax error in line 12',
    'HTTP 500 Internal Server Error'
  ]) assert.equal(hinted(withWebguiHint(error(text))), false, text);

  const ok = { content: [{ type: 'text', text: 'not supported' }] };
  assert.equal(withWebguiHint(ok), ok);
  const once = withWebguiHint(error('not supported'));
  assert.equal(withWebguiHint(once).content.filter(item => item.text === WEBGUI_HINT).length, 1);
});
