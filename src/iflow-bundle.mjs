// Builds Cloud Integration iFlow bundles (zip) for the CPI OData API.
// Pure: no network. Manifest import headers follow FlashPipe's tenant-verified
// test artifact (Apache-2.0, see NOTICE).
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { IntegrationError } from './integration-http.mjs';

export const IFLOW_TEMPLATES = Object.freeze(['https-request-reply-http']);

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
  return zipSync(files);
}

/** Unzip a bundle into path → bytes. */
export function readBundle(bytes) {
  try {
    return new Map(Object.entries(unzipSync(bytes)));
  } catch {
    throw new IntegrationError('iFlow bundle is not a readable zip archive');
  }
}

export function writeBundle(files) {
  return zipSync(Object.fromEntries(files));
}

export { strFromU8, strToU8, MANIFEST_PATH, PARAMETERS_PROP, PARAMETERS_PROPDEF };
