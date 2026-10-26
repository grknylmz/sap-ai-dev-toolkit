// API Management API proxy bundles (zip) for Transport.svc import/export.
// Layout follows SAP's apibusinesshub-api-recipes sample bundles: every file lives under APIProxy/
// (root <Name>.xml, APIProxyEndPoint/, APITargetEndPoint/, Policy/, FileResource/). Exported bundles are
// edited as strings, touching only the elements being changed, so unknown content survives a re-import.
import { strFromU8, strToU8, zipSync } from 'fflate';
import { IntegrationError } from './integration-http.mjs';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const EMPTY_FLOWS = '<faultRules/><preFlow><name>PreFlow</name></preFlow><postFlow><name>PostFlow</name></postFlow><conditionalFlows/>';
const NS = 'http://www.sap.com/apimgmt';

export function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

function proxyXml({ name, title, description, serviceType }) {
  return `${XML_HEADER}<APIProxy><name>${xmlEscape(name)}</name><title>${xmlEscape(title)}</title>`
    + `<description>${xmlEscape(description)}</description>`
    + `<service_code>${serviceType === 'odata' ? 'ODATA' : 'REST'}</service_code>`
    + '<proxyEndPoints><proxyEndPoint><proxyEndPointName>default</proxyEndPointName></proxyEndPoint></proxyEndPoints>'
    + '<targetEndPoints><targetEndPoint>default</targetEndPoint></targetEndPoints>'
    + '<policies/><fileResources/></APIProxy>';
}

function proxyEndPointXml(basePath) {
  return `${XML_HEADER}<ProxyEndPoint default="true"><name>default</name><base_path>${xmlEscape(basePath)}</base_path>`
    + '<properties/><routeRules><routeRule><name>default</name><targetEndPointName>default</targetEndPointName>'
    + '<sequence>1</sequence><faultRules/></routeRule></routeRules>'
    + `${EMPTY_FLOWS}</ProxyEndPoint>`;
}

function targetHead(target) {
  return target.provider
    ? `<provider_id>${xmlEscape(target.provider)}</provider_id><relativePath>${xmlEscape(target.relativePath)}</relativePath>`
    : `<url>${xmlEscape(target.url)}</url><provider_id>NONE</provider_id>`;
}

function targetEndPointXml(target) {
  return `${XML_HEADER}<TargetEndPoint><name>default</name>${targetHead(target)}<isDefault>true</isDefault><properties/>${EMPTY_FLOWS}</TargetEndPoint>`;
}

/** Build a policy-free API proxy bundle targeting an API provider or a fixed https URL. */
export function buildApiProxyBundle({ name, title, description = '', basePath, serviceType, target }) {
  return zipSync({
    [`APIProxy/${name}.xml`]: strToU8(proxyXml({ name, title: title ?? name, description, serviceType })),
    'APIProxy/APIProxyEndPoint/default.xml': strToU8(proxyEndPointXml(basePath)),
    'APIProxy/APITargetEndPoint/default.xml': strToU8(targetEndPointXml(target))
  });
}

// ---------------------------------------------------------------- string XML editing

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/** Direct child elements inside [from, to): name plus outer and content offsets. */
function childElements(xml, from, to) {
  const result = [];
  const stack = [];
  const pattern = new RegExp(TOKEN.source, 'g');
  pattern.lastIndex = from;
  let match;
  while ((match = pattern.exec(xml)) && match.index < to) {
    const [text, closing, name, , selfClosing] = match;
    if (!name) continue;
    const end = match.index + text.length;
    if (closing) {
      const open = stack.pop();
      if (open?.name !== name) throw new IntegrationError(`API proxy bundle XML is malformed near </${name}>`);
      if (!stack.length) result.push({ name, start: open.start, contentStart: open.contentStart, contentEnd: match.index, end, selfClosing: false });
    } else if (selfClosing) {
      if (!stack.length) result.push({ name, start: match.index, contentStart: end, contentEnd: end, end, selfClosing: true });
    } else {
      stack.push({ name, start: match.index, contentStart: end });
    }
  }
  if (stack.length) throw new IntegrationError(`API proxy bundle XML is malformed: <${stack.at(-1).name}> is not closed`);
  return result;
}

const children = (xml, parent) => childElements(xml, parent.contentStart, parent.contentEnd);
const textOf = (xml, element) => xmlUnescape(xml.slice(element.contentStart, element.contentEnd).trim());
const splice = (xml, start, end, insert) => `${xml.slice(0, start)}${insert}${xml.slice(end)}`;

/** Element at a path of child names below the document root ([] = root), or undefined. */
function locate(xml, path) {
  let element = childElements(xml, 0, xml.length)[0];
  if (!element) throw new IntegrationError('API proxy bundle XML has no root element');
  for (const name of path) {
    element = children(xml, element).find(child => child.name === name);
    if (!element) return undefined;
  }
  return element;
}

/** Turn <x .../> into <x ...>inner</x>, keeping attributes. */
function expand(xml, element, inner) {
  const openTag = xml.slice(element.start, element.end).replace(/\s*\/>$/, '>');
  return splice(xml, element.start, element.end, `${openTag}${inner}</${element.name}>`);
}

/** Make sure parentPath/name exists as an open element; new elements go before the first `before` sibling. */
function ensureChild(xml, parentPath, name, inner = '', before = []) {
  let parent = locate(xml, parentPath);
  if (parent.selfClosing) {
    xml = expand(xml, parent, '');
    parent = locate(xml, parentPath);
  }
  const siblings = children(xml, parent);
  const existing = siblings.find(child => child.name === name);
  if (existing) return existing.selfClosing ? expand(xml, existing, inner) : xml;
  const anchor = siblings.find(child => before.includes(child.name));
  const at = anchor ? anchor.start : parent.contentEnd;
  return splice(xml, at, at, `<${name}>${inner}</${name}>`);
}

/** Replace a root child's text, or insert it after the first present `after` sibling (else first). */
function setRootText(xml, name, value, after = []) {
  const root = locate(xml, []);
  const element = `<${name}>${xmlEscape(value)}</${name}>`;
  const siblings = children(xml, root);
  const existing = siblings.find(child => child.name === name);
  if (existing) return splice(xml, existing.start, existing.end, element);
  const anchor = after.map(candidate => siblings.find(child => child.name === candidate)).find(Boolean);
  const at = anchor ? anchor.end : root.contentStart;
  return splice(xml, at, at, element);
}

/** Add or replace <entryTag type="T">name</entryTag> inside the root <listTag>. */
function registerRootEntry(xml, listTag, entryTag, type, name, before = []) {
  xml = ensureChild(xml, [], listTag, '', before);
  const listElement = locate(xml, [listTag]);
  const entry = `<${entryTag} type="${xmlEscape(type)}">${xmlEscape(name)}</${entryTag}>`;
  const same = children(xml, listElement).find(child => child.name === entryTag && textOf(xml, child) === name);
  return same ? splice(xml, same.start, same.end, entry) : splice(xml, listElement.contentEnd, listElement.contentEnd, entry);
}

function rootEntryNames(xml, listTag, entryTag) {
  const listElement = locate(xml, [listTag]);
  return listElement ? children(xml, listElement).filter(child => child.name === entryTag).map(child => textOf(xml, child)) : [];
}

/** Append a policy step to an endpoint flow (created when missing); an existing step for the policy is kept. */
function addStep(xml, flowTag, phase, policyName, condition) {
  const flowName = flowTag === 'preFlow' ? 'PreFlow' : 'PostFlow';
  xml = ensureChild(xml, [], flowTag, `<name>${flowName}</name>`, flowTag === 'preFlow' ? ['postFlow', 'conditionalFlows'] : ['conditionalFlows']);
  xml = ensureChild(xml, [flowTag], phase, `<isRequest>${phase === 'request'}</isRequest><steps></steps>`, phase === 'request' ? ['response'] : []);
  xml = ensureChild(xml, [flowTag, phase], 'steps');
  const steps = locate(xml, [flowTag, phase, 'steps']);
  let sequence = 0;
  for (const step of children(xml, steps).filter(child => child.name === 'step')) {
    const fields = children(xml, step);
    const field = name => fields.find(child => child.name === name);
    if (field('policy_name') && textOf(xml, field('policy_name')) === policyName) return { xml, added: false };
    const value = Number(field('sequence') ? textOf(xml, field('sequence')) : NaN);
    if (Number.isFinite(value)) sequence = Math.max(sequence, value);
  }
  const step = `<step><policy_name>${xmlEscape(policyName)}</policy_name><condition>${xmlEscape(condition ?? '')}</condition><sequence>${sequence + 1}</sequence></step>`;
  return { xml: splice(xml, steps.contentEnd, steps.contentEnd, step), added: true };
}

// ---------------------------------------------------------------- exported bundle layout

function endpointFile(files, folder, kind) {
  const candidates = [...files.keys()].filter(path => path.startsWith(folder) && path.endsWith('.xml') && !path.slice(folder.length).includes('/'));
  const chosen = candidates.find(path => path === `${folder}default.xml`) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!chosen) {
    throw new IntegrationError(candidates.length
      ? `API proxy has several ${kind} endpoints and none is named default`
      : `API proxy bundle has no ${kind} endpoint`);
  }
  return chosen;
}

function proxyLayout(files, proxyName) {
  const anyPath = [...files.keys()].find(path => /(?:^|\/)APIProxy\//.test(path));
  if (!anyPath) throw new IntegrationError('API proxy bundle has no APIProxy/ folder');
  const dir = anyPath.slice(0, anyPath.indexOf('APIProxy/') + 'APIProxy/'.length);
  const rootCandidates = [...files.keys()].filter(path => path.startsWith(dir) && path.endsWith('.xml') && !path.slice(dir.length).includes('/'));
  const root = rootCandidates.find(path => path === `${dir}${proxyName}.xml`) ?? (rootCandidates.length === 1 ? rootCandidates[0] : undefined);
  if (!root) throw new IntegrationError('API proxy bundle has no root APIProxy XML file');
  return {
    dir,
    root,
    proxy: () => endpointFile(files, `${dir}APIProxyEndPoint/`, 'proxy'),
    target: () => endpointFile(files, `${dir}APITargetEndPoint/`, 'target')
  };
}

const readText = (files, path) => strFromU8(files.get(path));
const writeText = (files, path, text) => files.set(path, strToU8(text));

/** Names of the policies registered in the root APIProxy XML. */
export function bundlePolicyNames(files, proxyName) {
  return rootEntryNames(readText(files, proxyLayout(files, proxyName).root), 'policies', 'policy');
}

/**
 * Patch an exported bundle in place (Map path → bytes): root title/description/service_code when given,
 * proxy endpoint base_path, and the target head (url/provider_id/relativePath). Policies, steps,
 * file resources and every other element are kept.
 */
export function patchProxyBundle(files, proxyName, { title, description, serviceType, basePath, target }) {
  const layout = proxyLayout(files, proxyName);
  let root = readText(files, layout.root);
  if (title !== undefined) root = setRootText(root, 'title', title, ['name']);
  if (description !== undefined) root = setRootText(root, 'description', description, ['title', 'name']);
  if (serviceType) root = setRootText(root, 'service_code', serviceType === 'odata' ? 'ODATA' : 'REST', ['description', 'title', 'name']);
  writeText(files, layout.root, root);

  const proxyPath = layout.proxy();
  writeText(files, proxyPath, setRootText(readText(files, proxyPath), 'base_path', basePath, ['name']));

  const targetPath = layout.target();
  let targetXml = readText(files, targetPath);
  for (let head; (head = children(targetXml, locate(targetXml, [])).find(child => ['url', 'provider_id', 'relativePath'].includes(child.name)));) {
    targetXml = splice(targetXml, head.start, head.end, '');
  }
  const targetRoot = locate(targetXml, []);
  const nameElement = children(targetXml, targetRoot).find(child => child.name === 'name');
  const at = nameElement ? nameElement.end : targetRoot.contentStart;
  writeText(files, targetPath, splice(targetXml, at, at, targetHead(target)));
  return { preservedPolicies: rootEntryNames(root, 'policies', 'policy') };
}

// ---------------------------------------------------------------- policy templates

const policyOpen = (element, async = 'false', extra = '') => `<${element} async="${async}" continueOnError="false" enabled="true"${extra} xmlns="${NS}">`;
const headers = entries => `<Headers>${entries.map(([name, value]) => (value === undefined
  ? `<Header name="${xmlEscape(name)}"/>`
  : `<Header name="${xmlEscape(name)}">${xmlEscape(value)}</Header>`)).join('')}</Headers>`;

/**
 * Expand one requested policy into policy documents ({name, type, xml, steps, fileResource?}).
 * Step placement defaults: proxy endpoint, preFlow, request phase; templates override where fixed.
 */
export function policyDocuments(spec) {
  const { name, template, params = {}, condition } = spec;
  const place = (defaults = {}) => ({
    endpoint: spec.endpoint ?? defaults.endpoint ?? 'proxy',
    flow: spec.flow === 'post' || (!spec.flow && defaults.flow === 'post') ? 'postFlow' : 'preFlow',
    phase: spec.phase ?? defaults.phase ?? 'request',
    condition
  });
  const single = (type, xml, steps = [place()]) => [{ name, type, xml, steps }];
  switch (template) {
    case 'verify_api_key':
      return single('VerifyAPIKey', `${policyOpen('VerifyAPIKey', 'true')}<APIKey ref="${xmlEscape(params.key_ref)}"/></VerifyAPIKey>`);
    case 'quota':
      return single('Quota', `${policyOpen('Quota')}<Allow count="${params.count}"/><Interval>${params.interval}</Interval>`
        + `<Distributed>true</Distributed><Synchronous>true</Synchronous><TimeUnit>${xmlEscape(params.time_unit)}</TimeUnit></Quota>`);
    case 'spike_arrest':
      return single('SpikeArrest', `${policyOpen('SpikeArrest', 'true')}<Rate>${xmlEscape(params.rate)}</Rate></SpikeArrest>`);
    case 'cors': {
      const entries = [
        ['Access-Control-Allow-Origin', params.allow_origin],
        ['Access-Control-Allow-Methods', params.allow_methods],
        ['Access-Control-Allow-Headers', params.allow_headers]
      ];
      if (params.expose_headers !== undefined) entries.push(['Access-Control-Expose-Headers', params.expose_headers]);
      if (params.max_age !== undefined) entries.push(['Access-Control-Max-Age', String(params.max_age)]);
      return single('AssignMessage', `${policyOpen('AssignMessage')}<Add>${headers(entries)}</Add>`
        + '<IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables><AssignTo createNew="false" type="response">response</AssignTo></AssignMessage>',
      [place({ phase: 'response' })]);
    }
    case 'assign_headers': {
      const remove = params.remove?.length ? `<Remove>${headers(params.remove.map(header => [header]))}</Remove>` : '';
      const set = Object.keys(params.set ?? {}).length ? `<Set>${headers(Object.entries(params.set))}</Set>` : '';
      return single('AssignMessage', `${policyOpen('AssignMessage')}${remove}${set}<IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>`
        + `<AssignTo createNew="false" transport="http" type="${params.message}"/></AssignMessage>`,
      [place({ phase: params.message })]);
    }
    case 'oauth_verify_access_token':
      return single('OAuthV2', `${policyOpen('OAuthV2')}<ExternalAuthorization>false</ExternalAuthorization><Operation>VerifyAccessToken</Operation>`
        + '<GenerateResponse enabled="true"/><SupportedGrantTypes/><Tokens/></OAuthV2>');
    case 'ip_allow': {
      const rules = params.addresses.map(address => {
        const [ip, mask = '32'] = address.split('/');
        return `<MatchRule action="ALLOW"><SourceAddress mask="${mask}">${ip}</SourceAddress></MatchRule>`;
      }).join('');
      return single('AccessControl', `${policyOpen('AccessControl', 'true')}<IPRules noRuleMatchAction="DENY">${rules}</IPRules></AccessControl>`);
    }
    case 'response_cache': {
      const fragments = (params.key_fragments?.length ? params.key_fragments : ['request.uri'])
        .map(ref => `<KeyFragment ref="${xmlEscape(ref)}"></KeyFragment>`).join('');
      // ResponseCache runs twice under one name: lookup on the request, populate on the response.
      return single('ResponseCache', `${policyOpen('ResponseCache')}<CacheKey>${fragments}</CacheKey>`
        + `<ExpirySettings><TimeoutInSec>${params.timeout_seconds}</TimeoutInSec></ExpirySettings></ResponseCache>`, [
        { endpoint: 'proxy', flow: 'preFlow', phase: 'request', condition },
        { endpoint: 'proxy', flow: 'postFlow', phase: 'response', condition }
      ]);
    }
    case 'basic_auth_from_kvm': {
      const steps = [place({ endpoint: 'target' })];
      const user = `private.${name}.user`;
      const password = `private.${name}.password`;
      const get = (variable, entry) => `<Get assignTo="${xmlEscape(variable)}"><Key><Parameter>${xmlEscape(entry)}</Parameter></Key></Get>`;
      return [
        {
          name: `${name}_kvm`,
          type: 'KeyValueMapOperations',
          xml: `<KeyValueMapOperations xmlns="${NS}" mapIdentifier="${xmlEscape(params.kvm)}" async="true" continueOnError="false" enabled="true">`
            + `${get(user, params.user_key)}${get(password, params.password_key)}<Scope>environment</Scope></KeyValueMapOperations>`,
          steps
        },
        {
          name,
          type: 'BasicAuth',
          xml: `${policyOpen('BasicAuthentication', 'true')}<Operation>Encode</Operation><IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>`
            + `<User ref="${xmlEscape(user)}"></User><Password ref="${xmlEscape(password)}"></Password>`
            + '<AssignTo createNew="false">request.header.Authorization</AssignTo></BasicAuthentication>',
          steps
        }
      ];
    }
    case 'raise_fault': {
      const payload = params.payload === undefined ? ''
        : `<Payload contentType="${xmlEscape(params.content_type ?? 'application/json')}" variablePrefix="@" variableSuffix="#">${xmlEscape(params.payload)}</Payload>`;
      return single('RaiseFault', `${policyOpen('RaiseFault', 'true')}<FaultResponse><Set>${payload}<StatusCode>${params.status_code}</StatusCode>`
        + `<ReasonPhrase>${xmlEscape(params.reason_phrase)}</ReasonPhrase></Set></FaultResponse><IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables></RaiseFault>`);
    }
    case 'javascript': {
      const [document] = single('Javascript', `${policyOpen('Javascript', 'false', ' timeLimit="2000"')}<ResourceURL>jsc://${params.file}.js</ResourceURL></Javascript>`);
      return [{ ...document, fileResource: { name: params.file, type: 'js', content: params.script } }];
    }
    case 'custom':
      return single(params.type, params.xml);
    default:
      throw new IntegrationError(`Unknown policy template ${template}`);
  }
}

/**
 * Attach policies to an exported bundle in place: write Policy/<name>.xml (and FileResource/<file>.js),
 * register them in the root XML, and add flow steps. Re-attaching a name replaces its XML and keeps its step.
 */
export function attachPolicies(files, proxyName, specs) {
  const documents = specs.flatMap(policyDocuments);
  const seen = new Set();
  for (const name of [...documents.map(document => document.name), ...documents.filter(document => document.fileResource).map(document => `${document.fileResource.name}.js`)]) {
    if (seen.has(name)) throw new IntegrationError(`Policy or script name ${name} is used twice in one request`);
    seen.add(name);
  }
  const layout = proxyLayout(files, proxyName);
  let root = readText(files, layout.root);
  const endpoints = {};
  const endpointXml = endpoint => {
    if (!endpoints[endpoint]) {
      const path = layout[endpoint]();
      endpoints[endpoint] = { path, xml: readText(files, path) };
    }
    return endpoints[endpoint];
  };
  let stepsAdded = 0;
  for (const document of documents) {
    const body = document.xml.trimStart().startsWith('<?xml') ? document.xml : `${XML_HEADER}\n${document.xml}`;
    writeText(files, `${layout.dir}Policy/${document.name}.xml`, body);
    root = registerRootEntry(root, 'policies', 'policy', document.type, document.name, ['fileResources']);
    if (document.fileResource) {
      writeText(files, `${layout.dir}FileResource/${document.fileResource.name}.js`, document.fileResource.content);
      root = registerRootEntry(root, 'fileResources', 'fileResource', document.fileResource.type, document.fileResource.name);
    }
    for (const step of document.steps) {
      const target = endpointXml(step.endpoint);
      const { xml, added } = addStep(target.xml, step.flow, step.phase, document.name, step.condition);
      target.xml = xml;
      if (added) stepsAdded += 1;
    }
  }
  writeText(files, layout.root, root);
  for (const { path, xml } of Object.values(endpoints)) writeText(files, path, xml);
  return { policies: documents.map(document => document.name), stepsAdded };
}
