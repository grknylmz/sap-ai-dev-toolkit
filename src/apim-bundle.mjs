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
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(lt|gt|quot|apos|amp));/gi, (match, hex, decimal, named) => {
    if (hex || decimal) {
      const point = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
    }
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[named.toLowerCase()];
  });
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
    element = children(xml, element).find(child => child.name.split(':').at(-1) === name);
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
  return listElement ? children(xml, listElement).filter(child => child.name.split(':').at(-1) === entryTag).map(child => textOf(xml, child)) : [];
}

/** Append a step, or update only an explicitly supplied condition on its exact assignment. */
function addStep(xml, flowTag, phase, policyName, condition) {
  const flowName = flowTag === 'preFlow' ? 'PreFlow' : 'PostFlow';
  selectedSteps(xml, flowTag === 'preFlow' ? 'pre' : 'post', phase);
  xml = ensureChild(xml, [], flowTag, `<name>${flowName}</name>`, flowTag === 'preFlow' ? ['postFlow', 'conditionalFlows'] : ['conditionalFlows']);
  xml = ensureChild(xml, [flowTag], phase, `<isRequest>${phase === 'request'}</isRequest><steps></steps>`, phase === 'request' ? ['response'] : []);
  xml = ensureChild(xml, [flowTag, phase], 'steps');
  const steps = locate(xml, [flowTag, phase, 'steps']);
  const assignments = supportedSteps(xml, steps);
  const matches = assignments.filter(step => step.policy_name === policyName);
  if (matches.length > 1) throw new IntegrationError('API proxy has ambiguous duplicate policy assignments');
  if (matches.length) {
    const existing = matches[0];
    if (condition === undefined) return { xml, added: false };
    const changed = setStepField(xml.slice(existing.element.start, existing.element.end), 'condition', condition);
    return { xml: splice(xml, existing.element.start, existing.element.end, changed), added: false };
  }
  let sequence = 0;
  for (const assignment of assignments) sequence = Math.max(sequence, assignment.sequence);
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

/** Explicit HTTPS issuers from registered VerifyJWT policies, never unregistered files or variable refs. */
export function bundleJwtIssuers(files, proxyName) {
  const layout = proxyLayout(files, proxyName);
  const rootXml = readText(files, layout.root);
  const localName = element => element.name.split(':').at(-1);
  const policyLists = children(rootXml, locate(rootXml, [])).filter(element => localName(element) === 'policies');
  if (policyLists.length > 1) throw new IntegrationError('API proxy bundle has ambiguous policy registrations');
  const policies = policyLists[0];
  const issuers = new Set();
  for (const entry of policies ? children(rootXml, policies) : []) {
    if (localName(entry) !== 'policy') continue;
    const name = textOf(rootXml, entry);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) continue;
    const path = `${layout.dir}Policy/${name}.xml`;
    if (!files.has(path)) continue;
    const xml = readText(files, path);
    const root = locate(xml, []);
    if (localName(root) !== 'VerifyJWT') continue;
    for (const issuer of children(xml, root).filter(element => localName(element) === 'Issuer')) {
      if (children(xml, issuer).length || /\bref\s*=/.test(xml.slice(issuer.start, issuer.contentStart))) continue;
      const raw = xml.slice(issuer.contentStart, issuer.contentEnd).trim();
      const value = raw.startsWith('<![CDATA[') && raw.endsWith(']]>') ? raw.slice(9, -3).trim() : textOf(xml, issuer);
      if (/[{}\s]/.test(value)) continue;
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search) issuers.add(value);
      } catch { /* Dynamic or malformed issuer text is not a trusted endpoint. */ }
    }
  }
  return [...issuers];
}

// Shared structural scanner for read-only inspection and surgical policy editing.
export { childElements, children as xmlChildren, locate as xmlLocate, textOf as xmlText, proxyLayout as apiProxyLayout };

const localName = element => element?.name?.split(':').at(-1) ?? '';
const oneChild = (xml, parent, name, required = false) => {
  const matches = children(xml, parent).filter(child => localName(child) === name);
  if (matches.length > 1 || (required && matches.length !== 1)) throw new IntegrationError(`Ambiguous API proxy policy layout: expected one ${name}`);
  if (matches[0] && matches[0].name !== name) throw new IntegrationError('Unsupported namespaced API proxy assignment layout');
  return matches[0];
};

function supportedSteps(xml, container) {
  const elements = children(xml, container);
  if (elements.some(element => element.name !== 'step')) throw new IntegrationError('Unsupported API proxy steps layout');
  const result = elements.map(element => {
    const policy = oneChild(xml, element, 'policy_name', true);
    const condition = oneChild(xml, element, 'condition');
    const sequence = oneChild(xml, element, 'sequence', true);
    if (children(xml, element).some(child => !['policy_name', 'condition', 'sequence'].includes(child.name))
      || [policy, condition, sequence].filter(Boolean).some(child => children(xml, child).length)) {
      throw new IntegrationError('Unsupported API proxy step fields');
    }
    const policy_name = textOf(xml, policy);
    const order = textOf(xml, sequence);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(policy_name) || !/^[1-9]\d*$/.test(order) || !Number.isSafeInteger(Number(order))) {
      throw new IntegrationError('Unsupported API proxy step identity or sequence');
    }
    return { element, policy_name, condition: condition ? textOf(xml, condition) : '', sequence: Number(order) };
  });
  if (new Set(result.map(item => item.policy_name)).size !== result.length
    || new Set(result.map(item => item.sequence)).size !== result.length) {
    throw new IntegrationError('API proxy has ambiguous duplicate policy assignments or sequences');
  }
  if (result.some((item, index) => index && item.sequence <= result[index - 1].sequence)) {
    throw new IntegrationError('API proxy step XML order disagrees with sequence order');
  }
  return result;
}

function setStepField(xml, name, value) {
  const root = locate(xml, []);
  const field = oneChild(xml, root, name);
  if (field) return field.selfClosing ? expand(xml, field, xmlEscape(value))
    : splice(xml, field.contentStart, field.contentEnd, xmlEscape(value));
  return splice(xml, root.contentEnd, root.contentEnd, `<${name}>${xmlEscape(value)}</${name}>`);
}

function policyEditLayout(files, proxyName, endpoint, endpointName) {
  const layout = proxyLayout(files, proxyName);
  const rootXml = readText(files, layout.root);
  const roots = [...files.keys()].filter(path => path.startsWith(layout.dir) && path.endsWith('.xml') && !path.slice(layout.dir.length).includes('/'));
  if (roots.length !== 1 || locate(rootXml, []).name !== 'APIProxy'
    || textOf(rootXml, oneChild(rootXml, locate(rootXml, []), 'name', true)) !== proxyName) {
    throw new IntegrationError('Ambiguous API proxy root identity');
  }
  const folder = `${layout.dir}${endpoint === 'proxy' ? 'APIProxyEndPoint' : 'APITargetEndPoint'}/`;
  const matches = [];
  for (const path of files.keys()) {
    if (!path.startsWith(folder) || !path.endsWith('.xml')) continue;
    const xml = readText(files, path);
    const root = locate(xml, []);
    if (root.name !== (endpoint === 'proxy' ? 'ProxyEndPoint' : 'TargetEndPoint')) throw new IntegrationError('Unsupported API proxy endpoint layout');
    if (textOf(xml, oneChild(xml, root, 'name', true)) === endpointName) matches.push({ path, xml });
  }
  if (matches.length !== 1) throw new IntegrationError('Expected one exact named API proxy endpoint');
  return { ...layout, rootXml, ...matches[0] };
}

function selectedSteps(xml, flow, phase, create = false) {
  const flowTag = flow === 'pre' ? 'preFlow' : 'postFlow';
  const root = locate(xml, []);
  const flowElement = oneChild(xml, root, flowTag);
  const phaseElement = flowElement && oneChild(xml, flowElement, phase);
  const steps = phaseElement && oneChild(xml, phaseElement, 'steps');
  if (!create) return { xml, steps, assignments: steps ? supportedSteps(xml, steps) : [] };
  xml = ensureChild(xml, [], flowTag, `<name>${flow === 'pre' ? 'PreFlow' : 'PostFlow'}</name>`, flow === 'pre' ? ['postFlow', 'conditionalFlows'] : ['conditionalFlows']);
  xml = ensureChild(xml, [flowTag], phase, `<isRequest>${phase === 'request'}</isRequest><steps/>`, phase === 'request' ? ['response'] : []);
  xml = ensureChild(xml, [flowTag, phase], 'steps');
  return selectedSteps(xml, flow, phase);
}

/** Private full reference inventory, including conditional/fault and unknown assignment locations. */
function policyReferences(files, layout) {
  const references = new Set();
  let unknown = false;
  for (const [path] of files) {
    if (!path.startsWith(layout.dir) || !path.endsWith('.xml')) continue;
    const xml = readText(files, path);
    const roots = childElements(xml, 0, xml.length);
    if (roots.length !== 1) throw new IntegrationError('Ambiguous API proxy XML document');
    const walk = (element, parent) => {
      const tag = localName(element);
      const fields = children(xml, element);
      const attributes = xmlAttributes(xml, element);
      if ((tag === 'steps' || tag === 'Steps') && fields.some(child => !['step', 'Step'].includes(localName(child)))) unknown = true;
      if (/step/i.test(tag) && !['step', 'Step', 'steps', 'Steps'].includes(tag)) unknown = true;
      if (tag === 'step' || tag === 'Step') {
        const identities = fields.filter(child => ['policy_name', 'Name'].includes(localName(child)));
        if (identities.length !== 1 || fields.some(child => !['policy_name', 'Name', 'condition', 'Condition', 'sequence'].includes(localName(child)))
          || Object.keys(attributes).some(name => name !== 'name')) unknown = true;
        if (identities.length === 1 && !children(xml, identities[0]).length) {
          const name = textOf(xml, identities[0]);
          if (/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) references.add(name);
          else unknown = true;
        } else unknown = true;
      }
      if (['policy_name', 'policyName', 'PolicyName', 'policyRef', 'PolicyRef', 'policy_ref'].includes(tag)) {
        const name = textOf(xml, element);
        if (fields.length || Object.keys(attributes).length || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) unknown = true;
        else references.add(name);
      }
      if ((tag === 'policy' || tag === 'Policy') && !(path === layout.root && localName(parent ?? {}) === 'policies')) unknown = true;
      if (/policy/i.test(tag) && !['policy', 'Policy', 'policy_name', 'policyName', 'PolicyName', 'policyRef', 'PolicyRef', 'policy_ref'].includes(tag)) unknown = true;
      if (Object.keys(attributes).some(name => /policy/i.test(name))) unknown = true;
      for (const child of fields) walk(child, element);
    };
    walk(roots[0]);
  }
  return { references, unknown };
}

/** Surgical complete-order edit for one exact assignment; never regenerate endpoints or shared resources. */
export function editPolicySteps(files, proxyName, { endpoint, endpoint_name, flow, phase, steps, remove_unreferenced = [] }) {
  const layout = policyEditLayout(files, proxyName, endpoint, endpoint_name);
  const policyList = oneChild(layout.rootXml, locate(layout.rootXml, []), 'policies');
  const registrations = policyList ? children(layout.rootXml, policyList) : [];
  if (registrations.some(element => element.name !== 'policy' || children(layout.rootXml, element).length)) throw new IntegrationError('Unsupported API proxy policy registrations');
  const registered = registrations.map(element => textOf(layout.rootXml, element));
  if (new Set(registered).size !== registered.length) throw new IntegrationError('Ambiguous API proxy policy registrations');
  if (new Set(steps.map(step => step.policy_name)).size !== steps.length || new Set(remove_unreferenced).size !== remove_unreferenced.length) {
    throw new IntegrationError('Duplicate requested policy identities');
  }
  for (const step of steps) {
    if (!registered.includes(step.policy_name) || !files.has(`${layout.dir}Policy/${step.policy_name}.xml`)) {
      throw new IntegrationError('Every desired policy must have one existing registration and policy document');
    }
  }
  const selected = selectedSteps(layout.xml, flow, phase, true);
  let xml = selected.xml;
  const desired = steps.map((step, index) => {
    const existing = selected.assignments.find(item => item.policy_name === step.policy_name);
    let body = existing ? xml.slice(existing.element.start, existing.element.end)
      : `<step><policy_name>${xmlEscape(step.policy_name)}</policy_name><condition></condition><sequence>1</sequence></step>`;
    if (step.condition !== undefined) body = setStepField(body, 'condition', step.condition);
    return setStepField(body, 'sequence', index + 1);
  });
  if (selected.steps.selfClosing) xml = expand(xml, selected.steps, desired.join(''));
  else {
    const changes = selected.assignments.map((assignment, index) => ({ start: assignment.element.start, end: assignment.element.end, text: desired[index] ?? '' }));
    if (desired.length > changes.length) changes.push({ start: selected.steps.contentEnd, end: selected.steps.contentEnd, text: desired.slice(changes.length).join('') });
    for (const change of changes.sort((a, b) => b.start - a.start)) xml = splice(xml, change.start, change.end, change.text);
  }
  // Work on a private candidate until every deletion precondition passes.
  const candidate = new Map(files);
  writeText(candidate, layout.path, xml);
  const inventory = policyReferences(candidate, layout);
  for (const name of remove_unreferenced) {
    if (!registered.includes(name) || !candidate.has(`${layout.dir}Policy/${name}.xml`)) throw new IntegrationError('Policy removal requires an existing registration and document');
    if (inventory.unknown || inventory.references.has(name)) throw new IntegrationError('Policy removal blocked by retained or unknown policy references');
  }
  let rootXml = layout.rootXml;
  for (const entry of registrations.filter(element => remove_unreferenced.includes(textOf(layout.rootXml, element))).sort((a, b) => b.start - a.start)) {
    rootXml = splice(rootXml, entry.start, entry.end, '');
  }
  if (remove_unreferenced.length) writeText(candidate, layout.root, rootXml);
  for (const name of remove_unreferenced) candidate.delete(`${layout.dir}Policy/${name}.xml`);
  const assignments = selectedSteps(xml, flow, phase).assignments;
  for (const [path, bytes] of candidate) files.set(path, bytes);
  for (const name of remove_unreferenced) files.delete(`${layout.dir}Policy/${name}.xml`);
  return {
    endpoint, endpoint_name, flow, phase,
    steps: assignments.map(item => ({ policy_name: item.policy_name, sequence: item.sequence, condition_present: Boolean(item.condition.trim()) })),
    removed_policies: remove_unreferenced
  };
}

export function xmlAttributes(xml, element) {
  const attributes = {};
  const opening = xml.slice(element.start, element.contentStart);
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of opening.matchAll(pattern)) attributes[match[1].split(':').at(-1)] = xmlUnescape(match[2] ?? match[3]);
  return attributes;
}

/** Locate only the unambiguous, registered SAP SWAGGER_JSON English documentation layout. */
export function bundleDocumentation(files, proxyName) {
  const { root, dir } = proxyLayout(files, proxyName);
  const xml = readText(files, root);
  const rootElement = locate(xml, []);
  if (rootElement.name.split(':').at(-1) !== 'APIProxy') throw new IntegrationError('Unsupported API documentation layout: root is not APIProxy');
  const rootFiles = [...files.keys()].filter(path => path.startsWith(dir) && path.endsWith('.xml') && !path.slice(dir.length).includes('/'));
  if (rootFiles.length !== 1) throw new IntegrationError('Unsupported API documentation layout: ambiguous root XML');
  const one = (source, parent, name) => {
    const matches = children(source, parent).filter(element => element.name.split(':').at(-1) === name);
    if (matches.length !== 1) throw new IntegrationError(`Unsupported API documentation layout: expected one ${name}`);
    return matches[0];
  };
  if (textOf(xml, one(xml, rootElement, 'name')) !== proxyName) throw new IntegrationError('API documentation proxy name does not match bundle');
  const endpointList = one(xml, rootElement, 'proxyEndPoints');
  const endpoints = children(xml, endpointList).filter(element => element.name.split(':').at(-1) === 'proxyEndPoint');
  if (endpoints.length !== 1 || textOf(xml, one(xml, endpoints[0], 'apiResourceName')) !== 'SWAGGER_JSON') {
    throw new IntegrationError('Unsupported API documentation layout: expected a single SWAGGER_JSON endpoint registration');
  }
  const endpointName = textOf(xml, one(xml, endpoints[0], 'proxyEndPointName'));
  const resourcePath = `${dir}APIResource/SWAGGER_JSON.xml`;
  const documentationPath = `${dir}Documentation/SWAGGER_JSON_en.html`;
  if (!files.has(resourcePath) || !files.has(documentationPath)) throw new IntegrationError('Unsupported API documentation layout: registered resource or document is missing');
  const resource = readText(files, resourcePath);
  const resourceRoot = locate(resource, []);
  if (resourceRoot.name.split(':').at(-1) !== 'APIResource') throw new IntegrationError('Unsupported API documentation layout: resource is not APIResource');
  if (textOf(resource, one(resource, resourceRoot, 'name')) !== 'SWAGGER_JSON') throw new IntegrationError('API documentation resource name does not match registration');
  if (textOf(resource, one(resource, resourceRoot, 'resource_path')) !== 'SWAGGER_JSON'
    || !endpointName || textOf(resource, one(resource, resourceRoot, 'proxyEndPointName')) !== endpointName) {
    throw new IntegrationError('API documentation resource path or endpoint does not match registration');
  }
  const docs = one(resource, resourceRoot, 'documentations');
  const english = children(resource, docs).filter(element => element.name.split(':').at(-1) === 'documentation');
  if (english.length !== 1) throw new IntegrationError('Unsupported API documentation layout: expected one documentation');
  const entry = english[0];
  const opening = resource.slice(entry.start, entry.contentStart);
  const attribute = name => {
    const values = [...opening.matchAll(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, 'g'))];
    return values.length === 1 ? xmlUnescape(values[0][1] ?? values[0][2]) : undefined;
  };
  if (attribute('locale') !== 'en' || attribute('mimeType') !== 'json' || children(resource, entry).length || textOf(resource, entry) !== 'SWAGGER_JSON') {
    throw new IntegrationError('Unsupported API documentation layout: expected SWAGGER_JSON locale=en mimeType=json');
  }
  return { path: documentationPath, text: readText(files, documentationPath) };
}

/** Replace documentation bytes only; routing, provider and security resources remain untouched. */
export function patchBundleDocumentation(files, proxyName, text) {
  const { path } = bundleDocumentation(files, proxyName);
  writeText(files, path, text);
  return { path };
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
      const get = (variable, entry) => `<Get assignTo="${xmlEscape(variable)}" index="1"><Key><Parameter>${xmlEscape(entry)}</Parameter></Key></Get>`;
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
            + '<AssignTo createNew="true">request.header.Authorization</AssignTo></BasicAuthentication>',
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

/**
 * Select a backend from already verified JWT claims. Kept ES5-compatible because
 * this same function is embedded in the gateway's JavaScript policy.
 */
export function selectAuthorizedBackend(claims, policy, now) {
  if (!claims || claims.iss !== policy.issuer || claims.grant_type !== 'client_credentials'
    || typeof claims.exp !== 'number' || !isFinite(claims.exp) || claims.exp <= now
    || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now))
    || !Array.isArray(claims.scope)) return null;
  var prefix = policy.scopePrefix + '.';
  var selected = null;
  for (var i = 0; i < claims.scope.length; i += 1) {
    var scope = claims.scope[i];
    if (typeof scope !== 'string') return null;
    if (scope.indexOf(prefix + 'S4') !== 0 || scope.slice(-7) !== '.Access') continue;
    var system = scope.slice(prefix.length, -7);
    if (policy.systems.indexOf(system) === -1 || (selected !== null && selected !== system)) return null;
    selected = system;
  }
  var audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return selected !== null && audiences.indexOf(prefix + selected) !== -1 ? selected : null;
}

/**
 * Build one fully secured capability proxy with fixed provider-backed targets.
 * Environment configuration changes at promotion; public names/paths do not.
 * No credentials or caller-supplied target identifiers belong in this config.
 */
export function buildRoutedApiProxyBundle(config) {
  const { name, title, description = 'OAuth client credentials; backend selected by one authorized system scope.',
    basePath, serviceType, backendPath, issuer, jwksUrl, scopePrefix, environment, systems, vimVersion = false } = config;
  if (!['production', 'non-production'].includes(environment)) throw new IntegrationError('An explicit deployment environment is required');
  if (!Array.isArray(systems) || !systems.length) throw new IntegrationError('At least one fixed backend system is required');
  if (new Set(systems.map(system => system.id)).size !== systems.length) throw new IntegrationError('Duplicate system route authorities are not allowed');
  if (systems.some(system => !/^S4[DTQP](?:\d{3})?$/.test(system.id) || !system.provider || !system.kvm)) {
    throw new IntegrationError('Every route requires a fixed S4 system, API provider and encrypted KVM name');
  }
  if (new Set(systems.map(system => system.id.charAt(2))).size !== systems.length) {
    throw new IntegrationError('Duplicate backend credential-policy names are not allowed; configure one client per system');
  }
  if (environment === 'production' && (systems.length !== 1 || !/^S4P(?:\d{3})?$/.test(systems[0].id))) {
    throw new IntegrationError('A production deployment must contain only one S4P backend');
  }
  if (environment === 'non-production' && systems.some(system => /^S4P/.test(system.id))) {
    throw new IntegrationError('A non-production deployment cannot contain an S4P backend');
  }
  const issuerUrl = new URL(issuer);
  const keysUrl = new URL(jwksUrl);
  if (issuerUrl.protocol !== 'https:' || keysUrl.protocol !== 'https:' || keysUrl.origin !== issuerUrl.origin
    || issuerUrl.username || issuerUrl.password || keysUrl.username || keysUrl.password
    || issuerUrl.search || issuerUrl.hash || keysUrl.search || keysUrl.hash) {
    throw new IntegrationError('JWKS must use the trusted HTTPS issuer origin without embedded credentials or query parameters');
  }
  if (!scopePrefix) throw new IntegrationError('The trusted application scope prefix is required');
  const files = new Map();
  const rootPath = `APIProxy/${name}.xml`;
  const proxyPath = 'APIProxy/APIProxyEndPoint/default.xml';
  const endpointName = index => index === 0 ? 'default' : systems[index].id;
  let root = proxyXml({ name, title: title ?? name, description, serviceType });
  const targets = locate(root, ['targetEndPoints']);
  root = splice(root, targets.contentStart, targets.contentEnd,
    systems.map((system, index) => `<targetEndPoint>${xmlEscape(endpointName(index))}</targetEndPoint>`).join(''));
  writeText(files, rootPath, root);
  let proxy = proxyEndPointXml(basePath);
  const routes = locate(proxy, ['routeRules']);
  proxy = splice(proxy, routes.contentStart, routes.contentEnd, systems.map((system, index) =>
    `<routeRule><name>route${xmlEscape(system.id)}</name><conditions>${xmlEscape(`private.backendSystem = "${system.id}"`)}</conditions>`
    + `<targetEndPointName>${xmlEscape(endpointName(index))}</targetEndPointName><sequence>${index + 1}</sequence><faultRules/></routeRule>`).join(''));
  writeText(files, proxyPath, proxy);
  const policy = { issuer, scopePrefix, systems: systems.map(system => system.id) };
  const script = `${selectAuthorizedBackend.toString()}\n`
    + 'var backend = null;\n'
    + 'if (String(context.getVariable("jwt.VerifyClientCredentialsJWT.valid")) === "true") {\n'
    + `  backend = selectAuthorizedBackend(JSON.parse(String(context.getVariable("jwt.VerifyClientCredentialsJWT.payload-json"))), ${JSON.stringify(policy)}, new Date().getTime() / 1000);\n`
    + '}\ncontext.setVariable("private.backendSystem", backend === null ? "" : backend);\n'
    + 'context.setVariable("private.backendAuthorized", backend === null ? "false" : "true");\n';
  // Scope and its corresponding audience are checked together by the selector.
  // VerifyJWT's multi-value Audience requires all values, not any one system.
  const custom = (policyName, type, xml, condition) => ({
    name: policyName, template: 'custom', endpoint: 'proxy', flow: 'pre', phase: 'request', condition, params: { type, xml }
  });
  attachPolicies(files, name, [
    { name: 'NormalizeBackendEncoding', template: 'assign_headers', params: { message: 'request', set: { 'Accept-Encoding': 'gzip, deflate' } } },
    custom('ExtractOAuthBearer', 'ExtractVariable',
      `${policyOpen('ExtractVariables')}<Source>request</Source><Header name="Authorization"><Pattern ignoreCase="true">Bearer {access_token}</Pattern></Header>`
      + '<VariablePrefix>private.oauth</VariablePrefix><IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables></ExtractVariables>'),
    custom('FetchOAuthJwks', 'ServiceCallout',
      `${policyOpen('ServiceCallout')}<Request clearPayload="true" variable="oauthJwksRequest"><Remove><Headers>`
      + '<Header name="Authorization"/><Header name="Cookie"/><Header name="apikey"/></Headers></Remove>'
      + '<Set><Headers><Header name="Accept">application/json</Header></Headers><Verb>GET</Verb></Set>'
      + '<IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables></Request><Response>oauthJwksResponse</Response><Timeout>10000</Timeout>'
      + `<HTTPTargetConnection><URL>${xmlEscape(jwksUrl)}</URL></HTTPTargetConnection></ServiceCallout>`,
      '(private.oauth.access_token != null) and (private.oauth.access_token != "")'),
    custom('VerifyClientCredentialsJWT', 'VerifyJWT',
      `${policyOpen('VerifyJWT')}<Algorithm>RS256</Algorithm><Source>private.oauth.access_token</Source><IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>`
      + `<PublicKey><JWKS ref="oauthJwksResponse.content"/></PublicKey><Issuer>${xmlEscape(issuer)}</Issuer>`
      + '<AdditionalClaims><Claim name="grant_type" type="string">client_credentials</Claim></AdditionalClaims></VerifyJWT>'),
    { name: 'SelectAuthorizedBackend', template: 'javascript', params: { file: 'select-authorized-backend', script } },
    { name: 'RejectUnauthorizedBackend', template: 'raise_fault', condition: 'private.backendAuthorized != "true"',
      params: { status_code: 403, reason_phrase: 'Forbidden', content_type: 'application/json',
        payload: '{"error":"Exactly one authorized system scope and its matching audience are required."}' } }
  ]);
  root = readText(files, rootPath);
  for (const [index, system] of systems.entries()) {
    const targetName = endpointName(index);
    let target = targetEndPointXml({ provider: system.provider, relativePath: backendPath });
    target = setRootText(target, 'name', targetName);
    target = setRootText(target, 'isDefault', index === 0 ? 'true' : 'false');
    const specs = [{ name: `SAPBackend${system.id.slice(2, 3)}`, template: 'basic_auth_from_kvm',
      params: { kvm: system.kvm, user_key: 'username', password_key: 'password' } }];
    if (vimVersion) specs.push({ name: 'VIMVersion', template: 'custom', endpoint: 'target', params: { type: 'AssignMessage',
      xml: `${policyOpen('AssignMessage')}<Set><QueryParams><QueryParam name="version">1</QueryParam></QueryParams></Set>`
        + '<IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables><AssignTo createNew="false" type="request"/></AssignMessage>' } });
    for (const document of specs.flatMap(policyDocuments)) {
      root = registerRootEntry(root, 'policies', 'policy', document.type, document.name, ['fileResources']);
      writeText(files, `APIProxy/Policy/${document.name}.xml`, `${XML_HEADER}\n${document.xml}`);
      for (const step of document.steps) target = addStep(target, step.flow, step.phase, document.name, step.condition).xml;
    }
    writeText(files, `APIProxy/APITargetEndPoint/${targetName}.xml`, target);
  }
  writeText(files, rootPath, root);
  return zipSync(Object.fromEntries(files));
}
