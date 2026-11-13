// Pure CSN builder for Datasphere local tables from BW/Data Dictionary field
// lists (shape from the CLI guide "Create Objects" example). No I/O.
import { IntegrationError } from './integration-http.mjs';

const STRING_TYPES = new Set(['CHAR', 'NUMC', 'CUKY', 'UNIT', 'LANG', 'CLNT', 'ACCP', 'SSTRING']);
const DECIMAL_TYPES = new Set(['DEC', 'CURR', 'QUAN']);
const INTEGER_TYPES = new Set(['INT1', 'INT2', 'INT4']);

function columnName(name) {
  return String(name)
    .replace(/^\/(?:BIC|BI0)\//, '')
    .replace(/[^A-Za-z0-9_]/g, '_');
}

function positiveLength(field) {
  const length = Number(field.length);
  if (!Number.isInteger(length) || length < 1) {
    throw new IntegrationError(`${field.name} needs length`);
  }
  return length;
}

function elementType(field) {
  const type = String(field.ddic_type || '').toUpperCase();
  if (STRING_TYPES.has(type)) return { type: 'cds.String', length: positiveLength(field) };
  if (type === 'STRING') return { type: 'cds.LargeString' };
  if (type === 'DATS') return { type: 'cds.Date' };
  if (type === 'TIMS') return { type: 'cds.Time' };
  if (DECIMAL_TYPES.has(type)) {
    const decimals = Number(field.decimals);
    return { type: 'cds.Decimal', precision: positiveLength(field), scale: Number.isInteger(decimals) && decimals >= 0 ? decimals : 0 };
  }
  if (INTEGER_TYPES.has(type)) return { type: 'cds.Integer' };
  if (type === 'INT8') return { type: 'cds.Integer64' };
  if (type === 'FLTP') return { type: 'cds.Double' };
  if (type === 'RAW') return { type: 'cds.Binary', length: positiveLength(field) };
  throw new IntegrationError(`Unsupported DDIC type ${field.ddic_type} for ${field.name}`);
}

/**
 * Build a Datasphere local-table CSN definition:
 * buildLocalTableCsn({ technicalName, businessName, fields }) where each field is
 * { name, label?, ddic_type, length?, decimals?, key? }.
 */
export function buildLocalTableCsn({ technicalName, businessName, fields }) {
  if (!technicalName || typeof technicalName !== 'string') throw new IntegrationError('technical_name is required');
  const elements = {};
  const byColumn = new Map();
  for (const field of Array.isArray(fields) ? fields : []) {
    const column = columnName(field.name);
    const previous = byColumn.get(column);
    if (previous) {
      throw new IntegrationError(`Columns ${previous} and ${field.name} both map to ${column}`);
    }
    byColumn.set(column, field.name);
    elements[column] = {
      '@EndUserText.label': String(field.label ?? field.name),
      ...elementType(field),
      ...(field.key ? { key: true, notNull: true } : {})
    };
  }
  return {
    definitions: {
      [technicalName]: {
        kind: 'entity',
        '@EndUserText.label': String(businessName ?? technicalName),
        '@ObjectModel.modelingPattern': { '#': 'DATA_STRUCTURE' },
        '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
        elements
      }
    }
  };
}
