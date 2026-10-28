// Private configuration-aware identities; callers expose hashes, never configuration values.
import { createHash } from 'node:crypto';
import { entity } from './integration-common.mjs';

const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export function canonicalJson(value) {
  const encode = value => {
    if (Array.isArray(value)) return `[${value.map(entry => encode(entry) ?? 'null').join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort(compareUtf8).flatMap(key => {
        const encoded = encode(value[key]);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return encode(entity(value));
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function stateDigest(bundle_sha256, configurations = []) {
  const tuples = configurations.map(configuration => Array.isArray(configuration)
    ? [configuration[0], configuration[1], configuration[2]]
    : [configuration.ParameterKey, configuration.ParameterValue, configuration.DataType]);
  tuples.sort((a, b) => compareUtf8(a[0], b[0]));
  return canonicalDigest({ bundle_sha256, configurations: tuples });
}
