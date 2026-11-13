// Shared schemas and helpers for the SAP Build Process Automation tool modules.
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { IntegrationError, odataKey } from './integration-http.mjs';

export const WORKFLOW = '/public/workflow/rest/v1';
export const INBOX = '/public/workflow/odata/v1/tcm';
export const RULES = '/public/rule/runtime/rest/v2/rule-services';
export const UNIFIED = '/public/unified/v1';
export const IRPA_RUNTIME = '/public/irpa/runtime/v1';
export const IRPA_MONITORING = '/public/irpa/monitoring/v1';
export const VISIBILITY = '/public/visibility/runtime';
export const EVENTS = '/internal/be/v1/events';
export const CONTEXT_MAX_BYTES = 48 * 1024;

// Workflow ids are UUID v1; a plain shape check avoids strict variant rejection.
export const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected a BPA id (UUID)');
export const identifier = (label = 'identifier') => z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/, `expected a ${label}`);
export const payload = z.record(z.string(), z.unknown());
export const environmentId = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'expected an environment id').optional()
  .describe('Environment id (Control Tower > Environments); defaults to PROCESS_AUTOMATION_ENVIRONMENT_ID when configured.');
export const timestamp = z.string().max(40).regex(/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?)?$/, 'expected an ISO 8601 date or timestamp');
export const top = (max, fallback) => z.number().int().min(1).max(max).default(fallback);
export const skip = z.number().int().min(0).default(0);
export const outputFile = z.string().min(1).max(1024).refine(isAbsolute, 'must be an absolute path')
  .describe('Absolute path of a new local file (must not exist); written with mode 0600.');

export const rows = value => (Array.isArray(value) ? value : []);
export const enc = encodeURIComponent;
/** OData string literal ('x', quotes doubled) for keys and function-import parameters. */
export const odataString = odataKey;

export function capContext(value, field = 'context') {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null));
  if (bytes <= CONTEXT_MAX_BYTES) return { [field]: value };
  return {
    [`${field}_truncated`]: true,
    [`${field}_bytes`]: bytes,
    [`${field}_keys`]: value && typeof value === 'object' ? Object.keys(value) : []
  };
}

/** Header carrying the environment API key; `required` APIs fail before any tenant call without one. */
export function apiKeyHeaders(access, name, { required = false } = {}) {
  if (access?.apiKey) return { [name]: access.apiKey };
  if (required) {
    throw new IntegrationError('This SAP Build Process Automation API needs an environment API key (Control Tower > Environments > API Keys); set PROCESS_AUTOMATION_API_KEY or rerun sap-ai-dev --setup-process-automation.');
  }
  return {};
}

export function environmentQuery(access, given) {
  const value = given ?? access?.environmentId ?? undefined;
  return value ? { environmentId: value } : {};
}

/** Write downloaded bytes to a new user-only file; never overwrites. */
export async function writeExportFile(path, data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data ?? new Uint8Array(0));
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new IntegrationError(`output file ${path} already exists; choose a new path`);
    if (error?.code === 'ENOENT') throw new IntegrationError(`output directory for ${path} does not exist`);
    throw new IntegrationError(`output file ${path} could not be written (${error?.code || 'error'})`);
  }
  return { output_file: path, bytes: bytes.byteLength };
}
