// SAP Cloud ALM API REST client, shared by the MCP server, the tools and the
// setup verification: XSUAA client credentials with token retry, on-demand CSRF
// and SAP error details.
import { list } from './integration-common.mjs';
import { createServiceClient } from './integration-http.mjs';

export const CLOUD_ALM_PATHS = Object.freeze({
  analytics: '/calm-analytics/v1/analytics',
  logs: '/calm-logs/v1/logs',
  landscape: '/calm-landscape/v1/landscapeObjects',
  features: '/calm-features/v1',
  eventSituations: '/calm-event-situations/v1/event-situations'
});

export function createCloudAlmRestClient(config, { env = process.env, fetchImpl } = {}) {
  return createServiceClient({
    label: 'CLOUD_ALM',
    url: config.url,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    csrfPath: `${CLOUD_ALM_PATHS.analytics}/providers`,
    env,
    ...(fetchImpl ? { fetchImpl } : {})
  });
}

/** Read-only reachability check of the Landscape and Analytics APIs; never throws. */
export async function verifyCloudAlmAccess(rest) {
  const report = {};
  try {
    const objects = list(await rest.request('GET', CLOUD_ALM_PATHS.landscape, { query: { limit: 1 } }));
    report.landscape_api = `ok (${objects.length} object(s) on first page)`;
  } catch (error) {
    report.landscape_api = `failed: ${error?.message || 'Landscape API request failed'}`;
  }
  try {
    const providers = list(await rest.request('GET', `${CLOUD_ALM_PATHS.analytics}/providers`));
    report.analytics_api = `ok (${providers.length} authorized providers)`;
  } catch (error) {
    report.analytics_api = `failed: ${error?.message || 'Analytics API request failed'}`;
  }
  return report;
}
