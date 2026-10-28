// Builds Cloud Integration iFlow bundles (zip) for the CPI OData API.
// Pure: no network. Manifest import headers follow FlashPipe's tenant-verified
// test artifact (Apache-2.0, see NOTICE).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';
import { IntegrationError } from './integration-http.mjs';

export const IFLOW_TEMPLATES = Object.freeze(['https-request-reply-http']);

/** Content identity independent of ZIP ordering, compression and timestamps. */
export function bundleDigest(files) {
  const hash = createHash('sha256');
  const entries = [...files].map(([path, bytes]) => [Buffer.from(path, 'utf8'), bytes]);
  entries.sort(([a], [b]) => Buffer.compare(a, b));
  const length = Buffer.allocUnsafe(4);
  for (const [path, bytes] of entries) {
    for (const value of [path, bytes]) {
      if (value.byteLength > 0xffffffff) throw new IntegrationError('Bundle member exceeds digest length limit');
      length.writeUInt32BE(value.byteLength);
      hash.update(length);
      hash.update(value);
    }
  }
  return hash.digest('hex');
}

const IMPORT_PACKAGE = "com.sap.esb.application.services.cxf.interceptor,com.sap.esb.security,com.sap.it.op.agent.api,com.sap.it.op.agent.collector.camel,com.sap.it.op.agent.collector.cxf,com.sap.it.op.agent.mpl,javax.jms,javax.jws,javax.wsdl,javax.xml.bind.annotation,javax.xml.namespace,javax.xml.ws,org.apache.camel;version=\"2.8\",org.apache.camel.builder;version=\"2.8\",org.apache.camel.builder.xml;version=\"2.8\",org.apache.camel.component.cxf,org.apache.camel.model;version=\"2.8\",org.apache.camel.processor;version=\"2.8\",org.apache.camel.processor.aggregate;version=\"2.8\",org.apache.camel.spring.spi;version=\"2.8\",org.apache.commons.logging,org.apache.cxf.binding,org.apache.cxf.binding.soap,org.apache.cxf.binding.soap.spring,org.apache.cxf.bus,org.apache.cxf.bus.resource,org.apache.cxf.bus.spring,org.apache.cxf.buslifecycle,org.apache.cxf.catalog,org.apache.cxf.configuration.jsse;version=\"2.5\",org.apache.cxf.configuration.spring,org.apache.cxf.endpoint,org.apache.cxf.headers,org.apache.cxf.interceptor,org.apache.cxf.management.counters;version=\"2.5\",org.apache.cxf.message,org.apache.cxf.phase,org.apache.cxf.resource,org.apache.cxf.service.factory,org.apache.cxf.service.model,org.apache.cxf.transport,org.apache.cxf.transport.common.gzip,org.apache.cxf.transport.http,org.apache.cxf.transport.http.policy,org.apache.cxf.workqueue,org.apache.cxf.ws.rm.persistence,org.apache.cxf.wsdl11,org.osgi.framework;version=\"1.6.0\",org.slf4j;version=\"1.6\",org.springframework.beans.factory.config;version=\"3.0\",com.sap.esb.camel.security.cms,org.apache.camel.spi,com.sap.esb.webservice.audit.log,com.sap.esb.camel.endpoint.configurator.api,com.sap.esb.camel.jdbc.idempotency.reorg,javax.sql,org.apache.camel.processor.idempotent.jdbc,org.osgi.service.blueprint;version=\"[1.0.0,2.0.0)\"";
const IMPORT_SERVICE = "com.sap.esb.webservice.audit.log.AuditLogger,com.sap.esb.security.KeyManagerFactory;multiple:=false,com.sap.esb.security.TrustManagerFactory;multiple:=false,javax.sql.DataSource;multiple:=false;filter=\"(dataSourceName=default)\",org.apache.cxf.ws.rm.persistence.RMStore;multiple:=false,com.sap.esb.camel.security.cms.SignatureSplitter;multiple:=false";

const IFLOW_DIR = 'src/main/resources/scenarioflows/integrationflow';
const PARAMETERS_PROP = 'src/main/resources/parameters.prop';
const PARAMETERS_PROPDEF = 'src/main/resources/parameters.propdef';
const MANIFEST_PATH = 'META-INF/MANIFEST.MF';
const MANIFEST_LINE_BYTES = 70;
const MAX_IFLW_BYTES = 256 * 1024;
const MAX_SCRIPT_BYTES = 128 * 1024;
const MAX_SCRIPTS = 10;
const MAX_PARAMETERS = 50;
const SCRIPT_NAME = /^[A-Za-z0-9_.-]{1,80}\.(groovy|gsh|js)$/;
const PARAMETER_KEY = /^[A-Za-z0-9_. -]{1,100}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const templateCache = new Map();

function templateText(template) {
  if (!IFLOW_TEMPLATES.includes(template)) throw new IntegrationError(`Unknown iFlow template ${template}`);
  if (!templateCache.has(template)) {
    templateCache.set(template, readFileSync(new URL(`./integration-templates/${template}.iflw`, import.meta.url), 'utf8'));
  }
  return templateCache.get(template);
}

function utf8Chunks(text, limit) {
  // Split on UTF-8 byte boundaries without breaking a multi-byte character.
  const chunks = [];
  let current = '';
  let size = 0;
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8');
    if (size + width > limit && current) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += width;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

/** Serialize ordered [name, value] headers with JAR line wrapping and CRLF endings. */
export function manifestText(headers) {
  const lines = [];
  for (const [name, value] of headers) {
    const [first, ...rest] = utf8Chunks(`${name}: ${value}`, MANIFEST_LINE_BYTES);
    lines.push(first);
    if (rest.length) {
      const tail = rest.join('');
      for (const chunk of utf8Chunks(tail, MANIFEST_LINE_BYTES - 1)) lines.push(` ${chunk}`);
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

function parseManifest(text) {
  const unwrapped = text.replace(/\r\n/g, '\n').replace(/\n /g, '');
  return unwrapped.split('\n').filter(Boolean).map(line => {
    const index = line.indexOf(': ');
    return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 2)];
  });
}

/** Replace Bundle-Version in a (possibly wrapped) manifest and re-wrap it. */
export function replaceManifestVersion(text, newVersion) {
  const headers = parseManifest(text);
  const entry = headers.find(([name]) => name === 'Bundle-Version');
  if (entry) entry[1] = newVersion;
  else headers.push(['Bundle-Version', newVersion]);
  return manifestText(headers);
}

export function bumpPatchVersion(version) {
  const match = VERSION.exec(String(version));
  if (!match) throw new IntegrationError(`iFlow version ${version} is not x.y.z; update it in the Integration Suite UI first`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

// Java .properties are read as ISO-8859-1 by CPI (verified live: raw UTF-8 'ü' came back as 'Ã¼'),
// so everything outside printable ASCII is written as \uXXXX UTF-16 code units, as Properties.store does.
function escapeProperty(text, isKey) {
  const value = String(text);
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const code = value.charCodeAt(index);
    if (char === '\\' || char === ':' || char === '=' || char === '#' || char === '!') escaped += `\\${char}`;
    else if (char === ' ' && (isKey || index === 0)) escaped += '\\ ';
    else if (char === '\n') escaped += '\\n';
    else if (char === '\r') escaped += '\\r';
    else if (char === '\t') escaped += '\\t';
    else if (code < 0x20 || code > 0x7e) escaped += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else escaped += char;
  }
  return escaped;
}

function unescapeProperty(text) {
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (_, hex, char) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    return ({ n: '\n', r: '\r', t: '\t', f: '\f' })[char] ?? char;
  });
}

/** Serialize a parameter map in Java properties format. */
export function propertiesText(parameters) {
  return Object.entries(parameters).map(([key, value]) => `${escapeProperty(key, true)}=${escapeProperty(value, false)}\n`).join('');
}

/** Parse a Java properties file (key=value lines, comments, escaped separators). */
export function parseProperties(text) {
  const result = {};
  const logical = text.replace(/\r\n/g, '\n').replace(/\\\n[ \t]*/g, '');
  for (const rawLine of logical.split('\n')) {
    const line = rawLine.replace(/^[ \t]+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let index = 0;
    while (index < line.length) {
      const char = line[index];
      if (char === '\\') { index += 2; continue; }
      if (char === '=' || char === ':' || char === ' ' || char === '\t') break;
      index += 1;
    }
    const key = unescapeProperty(line.slice(0, index));
    const value = line.slice(index).replace(/^[ \t]*[=:]?[ \t]*/, '');
    result[key] = unescapeProperty(value);
  }
  return result;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function propdefEntry(key) {
  return `<parameter><key/><name>${xmlEscape(key)}</name><type>xsd:string</type><isRequired>false</isRequired><constraint/><description/><additionalMetadata/></parameter>`;
}

export function propdefText(keys) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters>${keys.map(propdefEntry).join('')}<param_references/></parameters>`;
}

/** Append propdef entries for keys not yet declared; keeps existing content intact. */
export function mergePropdef(text, keys) {
  const declared = new Set([...String(text).matchAll(/<name>([\s\S]*?)<\/name>/g)].map(match => match[1]
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')));
  const missing = keys.filter(key => !declared.has(key));
  if (!missing.length) return text;
  if (!text || !text.includes('<parameters')) return propdefText(keys);
  const entries = missing.map(propdefEntry).join('');
  if (text.includes('<param_references')) return text.replace('<param_references', `${entries}<param_references`);
  if (/<parameters\s*\/>/.test(text)) return text.replace(/<parameters\s*\/>/, `<parameters>${entries}</parameters>`);
  return text.replace('</parameters>', `${entries}</parameters>`);
}

export function validateParameters(parameters) {
  const entries = Object.entries(parameters || {});
  if (entries.length > MAX_PARAMETERS) throw new IntegrationError(`At most ${MAX_PARAMETERS} parameters are supported`);
  for (const [key, value] of entries) {
    if (!PARAMETER_KEY.test(key)) throw new IntegrationError(`Parameter key ${JSON.stringify(key).slice(0, 120)} must match ${PARAMETER_KEY.source}`);
    if (typeof value !== 'string') throw new IntegrationError(`Parameter ${key} must be a string`);
  }
  return entries;
}

function validateScripts(scripts) {
  if (scripts.length > MAX_SCRIPTS) throw new IntegrationError(`At most ${MAX_SCRIPTS} scripts are supported`);
  const seen = new Set();
  for (const script of scripts) {
    if (!SCRIPT_NAME.test(script?.name || '')) throw new IntegrationError(`Script name must match ${SCRIPT_NAME.source}`);
    if (seen.has(script.name)) throw new IntegrationError(`Duplicate script ${script.name}`);
    seen.add(script.name);
    if (typeof script.content !== 'string' || Buffer.byteLength(script.content, 'utf8') > MAX_SCRIPT_BYTES) {
      throw new IntegrationError(`Script ${script.name} must be text up to ${MAX_SCRIPT_BYTES / 1024} KiB`);
    }
  }
}

function templateParameterMap(parameters) {
  if (!parameters || typeof parameters !== 'object') throw new IntegrationError('template_parameters are required for template iFlows');
  return {
    Sender_Path: parameters.sender_path,
    Receiver_Address: parameters.receiver_address,
    Receiver_Query: parameters.receiver_query ?? '',
    Receiver_Method: parameters.receiver_method,
    Receiver_Proxy_Type: parameters.receiver_proxy_type === 'on_premise' ? 'sapcc' : 'default',
    Receiver_Location_ID: parameters.receiver_location_id ?? '',
    Receiver_Authentication: parameters.receiver_authentication,
    Receiver_Credential_Name: parameters.receiver_credential_name ?? '',
    Receiver_Timeout: String(parameters.receiver_timeout_ms)
  };
}

/** Build an iFlow bundle zip from a vetted template or caller-supplied BPMN. */
export function buildIflowBundle({
  id,
  name,
  description = '',
  version = '1.0.0',
  template,
  templateParameters,
  iflwXml,
  scripts = [],
  parameters = {}
}) {
  let iflw;
  let merged;
  if (template && template !== 'custom') {
    iflw = templateText(template);
    merged = { ...templateParameterMap(templateParameters), ...parameters };
  } else {
    if (typeof iflwXml !== 'string' || !iflwXml.includes('<bpmn2:definitions') || Buffer.byteLength(iflwXml, 'utf8') > MAX_IFLW_BYTES) {
      throw new IntegrationError('iflw_xml must be a BPMN2 iFlow model (bpmn2:definitions) up to 256 KiB');
    }
    iflw = iflwXml;
    merged = { ...parameters };
  }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null) throw new IntegrationError(`Parameter ${key} is required`);
    merged[key] = String(value);
  }
  const parameterEntries = validateParameters(merged);
  validateScripts(scripts);

  const files = {
    [MANIFEST_PATH]: strToU8(manifestText([
      ['Manifest-Version', '1.0'],
      ['SAP-RuntimeProfile', 'iflmap'],
      ['Bundle-SymbolicName', `${id}; singleton:=true`],
      ['Bundle-Name', name],
      ['Bundle-Version', version],
      ['Bundle-ManifestVersion', '2'],
      ['Origin-Bundle-SymbolicName', id],
      ['SAP-NodeType', 'IFLMAP'],
      ['Import-Package', IMPORT_PACKAGE],
      ['Origin-Bundle-Name', name],
      ['SAP-BundleType', 'IntegrationFlow'],
      ['Import-Service', IMPORT_SERVICE]
    ])),
    'metainfo.prop': strToU8(`description=${String(description).replace(/[\r\n]+/g, ' ')}\n`),
    [`${IFLOW_DIR}/${id}.iflw`]: strToU8(iflw)
  };
  for (const script of scripts) files[`src/main/resources/script/${script.name}`] = strToU8(script.content);
  if (parameterEntries.length) {
    files[PARAMETERS_PROP] = strToU8(propertiesText(merged));
    files[PARAMETERS_PROPDEF] = strToU8(propdefText(parameterEntries.map(([key]) => key)));
  }
  return writeBundle(Object.entries(files));
}

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_MEMBER_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_MEMBERS = 2000;
// Limit each inflate call, not just its accumulated output. A small compressed
// chunk bounds fflate's temporary output even when the declared size is false.
const INFLATE_CHUNK_BYTES = 1024;
const ZIP_CHUNK_BYTES = 64 * 1024;
const EMPTY_BYTES = new Uint8Array(0);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function archiveError(message) {
  return new IntegrationError(`iFlow bundle zip: ${message}`);
}

function validateMemberPath(path, seen) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')
    || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || Buffer.byteLength(path, 'utf8') > 65535 || strFromU8(strToU8(path)) !== path) {
    throw archiveError('unsafe member path');
  }
  const segments = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) throw archiveError('unsafe member path');
  if (seen.has(path)) throw archiveError('duplicate member path');
  seen.add(path);
  if (seen.size > MAX_MEMBERS) throw archiveError(`more than ${MAX_MEMBERS} members`);
}

function validatePathRelationships(paths) {
  for (const path of paths) {
    if (path.endsWith('/') && paths.has(path.slice(0, -1))) throw archiveError('conflicting member paths');
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
      if (paths.has(path.slice(0, slash))) throw archiveError('file used as a member directory');
    }
  }
}

function checkExtraFields(bytes, start, length) {
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) throw archiveError('malformed extra field');
    const kind = bytes[start] | (bytes[start + 1] << 8);
    const size = bytes[start + 2] | (bytes[start + 3] << 8);
    start += 4 + size;
    if (start > end) throw archiveError('truncated extra field');
    // Neither ZIP64 nor an alternate Unicode filename is needed for bounded
    // content bundles. Reject rather than letting another importer choose a
    // different size, offset or path than the one checked here.
    if (kind === 1 || kind === 0x7075) throw archiveError('unsupported ZIP64 or alternate filename metadata');
  }
}

/** Check archive structure without trusting its expanded-size declarations. */
function inspectArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw archiveError('missing or truncated end record');
  const count = u16(end + 10);
  const centralSize = u32(end + 12);
  const centralOffset = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count
    || count > MAX_MEMBERS || centralOffset + centralSize !== end) {
    throw archiveError('invalid, split or oversized central directory');
  }
  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw archiveError('malformed central directory');
    const flags = u16(offset + 8);
    const compression = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressedSize = u32(offset + 20);
    const originalSize = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const localOffset = u32(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || u16(offset + 34) || (flags & ~0x080e) || ![0, 8].includes(compression)
      || (compression === 0 && (flags & 6)) || compressedSize > MAX_ARCHIVE_BYTES
      || (compression === 8 && compressedSize < 2)
      || originalSize > MAX_MEMBER_BYTES || localOffset >= centralOffset) {
      throw archiveError('unsupported or oversized member');
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = flags & 0x0800 ? utf8Decoder.decode(nameBytes) : strFromU8(nameBytes, true);
    validateMemberPath(name, names);
    checkExtraFields(bytes, offset + 46 + nameLength, extraLength);
    entries.push({ name, nameBytes, flags, compression, crc, compressedSize, originalSize, localOffset });
    offset = next;
  }
  if (offset !== end) throw archiveError('central directory length mismatch');
  validatePathRelationships(names);
  entries.sort((a, b) => a.localOffset - b.localOffset);
  offset = 0;
  for (const entry of entries) {
    const { localOffset, nameBytes, flags, compression, crc, compressedSize, originalSize } = entry;
    if (localOffset !== offset || offset + 30 > centralOffset || u32(offset) !== 0x04034b50) {
      throw archiveError('missing, overlapping or unindexed local member');
    }
    const nameLength = u16(offset + 26);
    const extraLength = u16(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    if (dataOffset + compressedSize > centralOffset || flags !== u16(offset + 6)
      || compression !== u16(offset + 8) || nameLength !== nameBytes.length) {
      throw archiveError('local and central member mismatch');
    }
    for (let index = 0; index < nameLength; index += 1) {
      if (bytes[offset + 30 + index] !== nameBytes[index]) throw archiveError('local and central path mismatch');
    }
    checkExtraFields(bytes, offset + 30 + nameLength, extraLength);
    for (const [field, expected] of [[14, crc], [18, compressedSize], [22, originalSize]]) {
      const actual = u32(offset + field);
      if (actual !== expected && (!(flags & 8) || actual !== 0)) throw archiveError('local member size or checksum mismatch');
    }
    entry.dataOffset = dataOffset;
    offset = dataOffset + compressedSize;
    if (flags & 8) {
      // A signed or unsigned classic data descriptor must agree with the
      // central record. Try both when a CRC happens to equal the signature.
      const descriptor = [offset, offset + 4].find(start =>
        (start === offset || (offset + 4 <= centralOffset && u32(offset) === 0x08074b50))
        && start + 12 <= centralOffset && u32(start) === crc
        && u32(start + 4) === compressedSize && u32(start + 8) === originalSize);
      if (descriptor === undefined) throw archiveError('missing or invalid data descriptor');
      offset = descriptor + 12;
    }
  }
  if (offset !== centralOffset) throw archiveError('unindexed or truncated member data');
  return { entries, centralOffset };
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[index] = value;
}

function joinChunks(chunks, size) {
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Unzip a bounded, structurally checked bundle into path → exact bytes. */
export function readBundle(bytes) {
  if (!(bytes instanceof Uint8Array)) throw archiveError('archive must be bytes');
  if (bytes.length > MAX_ARCHIVE_BYTES) throw archiveError('compressed archive exceeds 20 MiB');
  let activeStream;
  try {
    const { entries } = inspectArchive(bytes);
    const files = new Map();
    let total = 0;
    let discovered = 0;
    let completed = 0;
    const unzip = new Unzip(file => {
      if (activeStream) throw archiveError('incomplete preceding member');
      activeStream = file;
      const entry = entries[discovered++];
      if (!entry || file.name !== entry.name) throw archiveError('unexpected streamed member');
      const chunks = [];
      let size = 0;
      let crc = 0xffffffff;
      file.ondata = (error, chunk, final) => {
        if (error) throw error instanceof IntegrationError ? error : archiveError('invalid or truncated compressed member');
        size += chunk.length;
        total += chunk.length;
        if (size > MAX_MEMBER_BYTES || total > MAX_EXPANDED_BYTES) throw archiveError('actual expanded byte limit exceeded');
        if (size > entry.originalSize) throw archiveError('actual member size exceeds declared size');
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        if (chunk.length) chunks.push(chunk);
        if (final) {
          if (size !== entry.originalSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
            throw archiveError('member size or checksum mismatch');
          }
          if (entry.name.endsWith('/') && size) throw archiveError('nonempty directory member');
          files.set(entry.name, joinChunks(chunks, size));
          chunks.length = 0;
          activeStream = undefined;
          completed += 1;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const pushRange = (start, end) => {
      for (let offset = start; offset < end; offset += INFLATE_CHUNK_BYTES) {
        unzip.push(bytes.subarray(offset, Math.min(end, offset + INFLATE_CHUNK_BYTES)), false);
      }
    };
    for (const entry of entries) {
      if (entry.flags & 8) {
        // Supply the already verified descriptor sizes to the streaming
        // decoder. This prevents signature-like binary data from being
        // mistaken for a descriptor, without copying the member payload.
        const header = new Uint8Array(bytes.subarray(entry.localOffset, entry.localOffset + 30));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        view.setUint16(6, entry.flags & ~8, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.compressedSize, true);
        view.setUint32(22, entry.originalSize, true);
        unzip.push(header, false);
        pushRange(entry.localOffset + 30, entry.dataOffset + entry.compressedSize);
      } else {
        pushRange(entry.localOffset, entry.dataOffset + entry.compressedSize);
      }
    }
    // The central directory was checked above, not streamed as local records:
    // arbitrary ZIP comments must never be scanned for apparent file headers.
    // One sentinel byte also lets fflate discover a final zero-length member.
    unzip.push(Uint8Array.of(0), true);
    if (discovered !== entries.length || completed !== entries.length) throw archiveError('incomplete member streams');
    return files;
  } catch (error) {
    activeStream?.terminate();
    if (error instanceof IntegrationError) throw error;
    throw archiveError('not a readable zip archive');
  }
}

/** Write only archives accepted by the same path, count and byte budgets. */
export function writeBundle(files) {
  const entries = [];
  const names = new Set();
  let expandedSize = 0;
  for (const [name, bytes] of files) {
    validateMemberPath(name, names);
    if (!(bytes instanceof Uint8Array)) throw archiveError('member content must be bytes');
    if (bytes.length > MAX_MEMBER_BYTES || (name.endsWith('/') && bytes.length)) throw archiveError('invalid member size');
    expandedSize += bytes.length;
    if (expandedSize > MAX_EXPANDED_BYTES) throw archiveError('actual expanded byte limit exceeded');
    entries.push([name, bytes]);
  }
  validatePathRelationships(names);
  const chunks = [];
  let size = 0;
  const zip = new Zip((error, chunk) => {
    if (error) throw error instanceof IntegrationError ? error : archiveError('unable to write archive');
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) throw archiveError('compressed archive exceeds 20 MiB');
    if (chunk.length) chunks.push(chunk);
  });
  try {
    for (const [name, bytes] of entries) {
      const file = new ZipDeflate(name);
      // Zip retains member metadata until its central directory is written.
      // Do not retain every finished compressor and its working buffers too.
      const member = { filename: name, compression: file.compression, flag: file.flag };
      file.ondata = (error, chunk, final) => {
        member.size = file.size;
        member.crc = file.crc;
        member.ondata(error, chunk, final);
      };
      zip.add(member);
      for (let offset = 0; offset < bytes.length; offset += ZIP_CHUNK_BYTES) {
        file.push(bytes.subarray(offset, Math.min(bytes.length, offset + ZIP_CHUNK_BYTES)), false);
      }
      file.push(EMPTY_BYTES, true);
    }
    zip.end();
    return joinChunks(chunks, size);
  } catch (error) {
    zip.terminate();
    if (error instanceof IntegrationError) throw error;
    throw archiveError('unable to write archive');
  }
}

export { strFromU8, strToU8, MANIFEST_PATH, PARAMETERS_PROP, PARAMETERS_PROPDEF };
