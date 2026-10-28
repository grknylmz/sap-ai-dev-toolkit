// Private original archive/configuration reads. Never return this object directly from a tool.
import { entity, key, pick } from './integration-common.mjs';
import { createCollectionPager, decodeCollection } from './integration-collections.mjs';
import { bundleDigest, readBundle, parseProperties, strFromU8 } from './iflow-bundle.mjs';
import { stateDigest } from './integration-state.mjs';
import { IntegrationError } from './integration-http.mjs';

export const CPI_BASE = '/api/v1';
export const CPI_PACKAGE_ARTIFACT_SETS = Object.freeze({
  iflows: 'IntegrationDesigntimeArtifacts',
  value_mappings: 'ValueMappingDesigntimeArtifacts',
  script_collections: 'ScriptCollectionDesigntimeArtifacts',
  message_mappings: 'MessageMappingDesigntimeArtifacts'
});
export const cpiArtifactPath = (id, version = 'active') => `/IntegrationDesigntimeArtifacts(Id=${key(id)},Version=${key(version)})`;

export async function readCpiContent(client, id, version = 'active', { deadline } = {}) {
  const path = cpiArtifactPath(id, version);
  const artifact = entity(await client.request('GET', `${CPI_BASE}${path}`, { deadline }));
  if (!artifact || artifact.Id !== id || typeof artifact.Version !== 'string') throw new IntegrationError('CPI artifact identity/version is unavailable');
  delete artifact.ArtifactContent;
  const bytes = await client.request('GET', `${CPI_BASE}${path}/$value`, {
    responseType: 'bytes', accept: 'application/zip, application/octet-stream', deadline
  });
  const files = readBundle(bytes);
  const configurations = await readCpiConfigurations(client, id, version, { deadline });
  const names = new Set(configurations.map(entry => entry.ParameterKey));
  const defaults = files.get('src/main/resources/parameters.prop');
  for (const name of Object.keys(defaults ? parseProperties(strFromU8(defaults)) : {})) names.add(name);
  const bundle_sha256 = bundleDigest(files);
  return { artifact, bytes, files, configurations, bundle_sha256, state_sha256: stateDigest(bundle_sha256, configurations),
    parameter_names: [...names].sort(), selector: version, resolved_version: artifact.Version };
}

export async function readCpiConfigurations(client, id, version = 'active', { deadline } = {}) {
  try {
    const path = cpiArtifactPath(id, version);
    const pager = createCollectionPager(client, { root: CPI_BASE });
    const raw = await client.request('GET', `${CPI_BASE}${path}/Configurations`, { unwrap: false, deadline });
    const mode = decodeCollection(raw).next ? 'odata' : 'local';
    const configurations = [];
    const names = new Set();
    let cursor;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await pager.page({ path: `${path}/Configurations`, top: 200, cursor, deadline,
        raw, mode, project: entry => pick(entry, ['ParameterKey', 'ParameterValue', 'DataType']) });
      for (const entry of page.items) {
        if (typeof entry.ParameterKey !== 'string' || typeof entry.ParameterValue !== 'string' || typeof entry.DataType !== 'string' || names.has(entry.ParameterKey)) {
          throw new IntegrationError('CPI configuration response is incomplete or ambiguous');
        }
        names.add(entry.ParameterKey);
        configurations.push(entry);
      }
      if (page.complete) return configurations;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    throw new IntegrationError('CPI configurations could not be read completely within the source limit');
  } catch (error) {
    // Configurations are private; a failed tenant response can echo their values.
    const evidence = cpiReleaseFailure(error);
    throw new IntegrationError(`CPI configuration read is incomplete or failed${evidence.status ? ` (HTTP ${evidence.status})` : ''}; values withheld`,
      { ...evidence, ...(error?.code === 'INTEGRATION_DEADLINE' ? { code: error.code } : {}) });
  }
}

/** Operational failures intentionally omit arbitrary tenant text, which can echo configuration/source. */
export function cpiReleaseFailure(error) {
  const status = Number(error?.status);
  return { result: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : [404, 501].includes(status) ? 'unavailable' : 'error',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(error?.code === 'INTEGRATION_DEADLINE' ? { stop_reason: 'deadline' } : {}) };
}

export async function writeCpiConfigurations(client, id, configurations, { deadline } = {}) {
  // Reserve space for both exact progress and the enclosing mutation outcome before any write.
  if (Buffer.byteLength(JSON.stringify(configurations.map(entry => entry.ParameterKey))) > 24000) {
    throw new IntegrationError('CPI configuration parameter names exceed the safe progress-report limit');
  }
  const updated = [];
  for (const parameter of configurations) {
    try {
      await client.request('PUT', `${CPI_BASE}${cpiArtifactPath(id)}/$links/Configurations(${key(parameter.ParameterKey)})`, {
        json: { ParameterValue: parameter.ParameterValue, DataType: parameter.DataType }, expect: [200, 202, 204], responseType: 'none', deadline
      });
      updated.push(parameter.ParameterKey);
    } catch (error) {
      return { updated, failed: { key: parameter.ParameterKey, ...cpiReleaseFailure(error) } };
    }
  }
  return { updated, failed: null };
}
