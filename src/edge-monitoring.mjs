// Read-only Edge local API discovery and shared, payload-free MPL diagnosis.
import { READ_ONLY_ANNOTATIONS } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';
import { createCollectionPager } from './integration-collections.mjs';
import { getMessageLog, listMessageLogs, messageGuid, mplListInputs } from './cpi-monitoring.mjs';
import { childElements, xmlChildren, xmlAttributes } from './apim-bundle.mjs';

const ROOT = '/local/api/eic/v1';
const MPL_ROOT = '/local/api/v1';
const SOURCES = [
  'https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ISuite_Edge_Integration_Cell/local-odata-api-access-fe61332.md',
  'https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ISuite_Edge_Integration_Cell/operations-cockpit-api-da1abc0.md'
];
const ROUTES = [
  '/Components', '/Components/<component ID>/Pods', '/Components/<component ID>/Pods/<pod name>/Events',
  '/Components/<component ID>/Pods/<pod name>/Metrics', '/Components/<component ID>/RuntimeParameters',
  '/Jobs', '/Jobs/<jobId>/Schedule'
];
const localName = element => element.name.split(':').at(-1);
const identifier = value => typeof value === 'string' && value.length <= 200 && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value);

function operationalBoundary() {
  return {
    published_routes: ROUTES.map(path => `${ROOT}${path}`),
    operational_field_contract: 'not_established',
    discovery_scope: 'Entity presence is discovery only, not an administrative or field-level operational contract.',
    native_handoff: {
      prerequisites: ['Exact Edge cell/runtime, component/pod/job identities and authorized native cockpit access'],
      steps: ['Open the Edge Integration Cell Operations Cockpit', 'Select Component Monitor or Job Management and the exact component/pod/job', 'Inspect native status, event logs, metrics or schedule; correlate supported local MPL identities separately'],
      safety_warning: 'No component status guesses, restart, Kubernetes, job-control, message-store or payload access is provided.',
      post_action_verification: ['Refresh native diagnostics and read bounded local MPL metadata for the exact message/time window']
    },
    source_links: [...SOURCES]
  };
}

function metadataInventory(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new IntegrationError('Edge local metadata is not a supported OData metadata document');
  try {
    const roots = childElements(xml, 0, xml.length);
    if (roots.length !== 1 || localName(roots[0]) !== 'Edmx') throw new Error('root');
    const services = xmlChildren(xml, roots[0]).filter(element => localName(element) === 'DataServices');
    if (services.length !== 1) throw new Error('services');
    const schemas = [];
    const entity_sets = [];
    let complete = true;
    const accept = (array, value) => {
      array.push(value);
      if (Buffer.byteLength(JSON.stringify({ schemas, entity_sets }, null, 2)) > 80 * 1024) { array.pop(); complete = false; }
    };
    for (const schema of xmlChildren(xml, services[0]).filter(element => localName(element) === 'Schema')) {
      const namespace = xmlAttributes(xml, schema).Namespace;
      if (!identifier(namespace)) { complete = false; continue; }
      accept(schemas, namespace);
      for (const container of xmlChildren(xml, schema).filter(element => localName(element) === 'EntityContainer')) {
        for (const set of xmlChildren(xml, container).filter(element => localName(element) === 'EntitySet')) {
          const attrs = xmlAttributes(xml, set);
          if (!identifier(attrs.Name) || !identifier(attrs.EntityType)) { complete = false; continue; }
          accept(entity_sets, { name: attrs.Name, entity_type: attrs.EntityType });
        }
      }
    }
    if (!schemas.length) throw new Error('schemas');
    return { schemas, entity_sets, complete, stop_reason: complete ? 'end' : 'source_limit' };
  } catch {
    // Never copy an unexpected XML tag, annotation, property or schema body into diagnostics.
    throw new IntegrationError('Edge local metadata is not a supported OData metadata document');
  }
}

async function localRead(operation) {
  try { return await operation(); }
  catch (error) {
    if (!Number.isInteger(error?.status) || error.status < 400) throw error;
    const detail = error.status === 401 ? 'A local 401 may indicate a missing /local prefix or authentication failure.'
      : error.status === 403 ? 'Access is denied; an unsupported local endpoint can also return 403.'
        : 'The requested local read could not be completed.';
    throw new IntegrationError(`Edge local API read failed (HTTP ${error.status}). ${detail} Activation and entitlement remain unknown; no health or no-traffic conclusion is established.`, { status: error.status });
  }
}

/** Construction performs no network or client access, including null-client name discovery. */
export function registerEdgeMonitoringTools(register, client) {
  const read = (path, options) => client.request('GET', `${MPL_ROOT}${path}`, options);
  const pager = createCollectionPager(client, { root: MPL_ROOT, request: (_method, path, options) => read(path, options) });

  register('edge_get_api_metadata', 'Discover Edge local API metadata',
    'Read /local/api/eic/v1/$metadata as bounded schema/entity-set identities only. Published component/pod/job routes are discovery, not safe field-level status contracts. Use the native Operations Cockpit for those diagnostics; no raw XML, source, payloads, actions or arbitrary reads.',
    {}, READ_ONLY_ANNOTATIONS, () => localRead(async () => {
      const xml = await client.request('GET', `${ROOT}/$metadata`, { responseType: 'text', accept: 'application/xml, text/xml' });
      return { result: 'ok', service_root: ROOT, ...metadataInventory(xml), ...operationalBoundary() };
    }));

  register('edge_list_message_logs', 'List Edge local message logs',
    'Read bounded local MPL metadata in the shared fixed UTC [from,to) LogStart window of at most 31 days. Supply both timestamps or neither (frozen last 24 hours). Signed continuations retain that window; traversal is best effort. /local and configured local Basic authority are preserved. Access denial establishes neither no traffic nor non-entitlement.',
    mplListInputs, READ_ONLY_ANNOTATIONS, args => localRead(() => listMessageLogs(pager, args)));

  register('edge_get_message_log', 'Get Edge local message log',
    'Read one local MPL identity, bounded redacted error text and credential-filtered custom header properties using the same diagnostic contract as CPI. No payloads, attachments, cloud statistics or JMS access. A local 401 may indicate missing /local; unsupported endpoints can return 403, not proof of non-entitlement.',
    { message_guid: messageGuid }, READ_ONLY_ANNOTATIONS, ({ message_guid }) => localRead(() => getMessageLog(read, pager, message_guid)));
}
