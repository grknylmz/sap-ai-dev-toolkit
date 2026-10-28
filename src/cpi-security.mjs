// Certificate validity metadata only: no trust-chain or connectivity assessment.
import { z } from 'zod';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { READ_ONLY_ANNOTATIONS, top } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';

const KEYSTORES = ['system', 'backup_admin_system', 'KeyRenewal'];
function date(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const millis = match ? Number(match[1]) : Date.parse(value);
  return Number.isFinite(millis) && !Number.isNaN(new Date(millis).getTime()) ? new Date(millis).toISOString() : null;
}
export function evaluateCertificate(entry, { warning_days = 30, evaluated_at = new Date().toISOString() } = {}) {
  const before = date(entry.ValidNotBefore), after = date(entry.ValidNotAfter);
  const now = Date.parse(evaluated_at);
  if (!Number.isInteger(warning_days) || warning_days < 1 || warning_days > 365 || !Number.isFinite(now)) throw new IntegrationError('Invalid certificate evaluation options');
  let validity = 'unknown';
  if (before && after && Date.parse(before) <= Date.parse(after)) {
    if (now > Date.parse(after)) validity = 'expired';
    else if (now < Date.parse(before)) validity = 'not_yet_valid';
    else validity = Date.parse(after) - now <= warning_days * 86400000 ? 'expiring' : 'valid';
  }
  return {
    ...Object.fromEntries(['Alias', 'Type', 'KeyType'].filter(key => typeof entry[key] === 'string').map(key => [key, entry[key]])),
    ValidNotBefore: before, ValidNotAfter: after, evaluated_at: new Date(now).toISOString(),
    days_remaining: validity === 'unknown' ? null : (Date.parse(after) - now) / 86400000,
    validity
  };
}
export async function readCertificateHealth(client, { keystore = 'system', warning_days = 30, top = 100, cursor, deadline, evaluated_at } = {}) {
  if (!KEYSTORES.includes(keystore) || !Number.isInteger(warning_days) || warning_days < 1 || warning_days > 365 || !Number.isInteger(top) || top < 1 || top > 200) throw new IntegrationError('Invalid certificate health options');
  const pager = createCollectionPager(client, { root: '/api/v1' });
  const scope = 'certificate_health';
  const context = cursor ? pager.cursorContext(cursor, { scope }) : { evaluated_at: evaluated_at ?? new Date().toISOString() };
  if (evaluated_at && evaluated_at !== context.evaluated_at) throw new IntegrationError('Certificate evaluation time does not match cursor');
  // Validate evaluation inputs even for an empty inventory.
  evaluateCertificate({}, { warning_days, evaluated_at: context.evaluated_at });
  const page = await pager.page({ path: '/KeystoreEntries', query: { keystoreName: keystore }, mode: 'local', top, cursor, deadline, scope,
    context: { ...context, warning_days }, project: entry => evaluateCertificate(entry, { warning_days, evaluated_at: context.evaluated_at }) });
  return { ...page, keystore, warning_days, evaluated_at: context.evaluated_at, assessment: 'certificate_validity_only' };
}
export function registerCpiSecurityTools(register, client) {
  register('cpi_get_certificate_health', 'Get CPI certificate health',
    'Inspect certificate validity metadata only; does not verify trust chains or connectivity.',
    { keystore: z.enum(KEYSTORES).default('system'), warning_days: z.number().int().min(1).max(365).default(30), top: top(200, 100), cursor: cursorSchema },
    READ_ONLY_ANNOTATIONS, args => readCertificateHealth(client, args));
}
