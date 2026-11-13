// SAP Build Process Automation REST client, shared by the MCP server and the
// setup verification. Technical mode: XSUAA client credentials with CSRF and SAP
// error details. Interactive mode: the signed-in user's bearer token through a
// static-authorization client (error bodies withheld; messages keep HTTP status).
import { createDatasphereTokenProvider } from './datasphere-auth.mjs';
import { createServiceClient, createStaticServiceClient } from './integration-http.mjs';
import { PROCESS_AUTOMATION_OAUTH } from './process-automation-config.mjs';

export function createProcessAutomationRestClient(config, { env = process.env, fetchImpl, accessToken, persistRefreshToken } = {}) {
  if (config.auth === 'technical') {
    return createServiceClient({
      label: 'PROCESS_AUTOMATION',
      url: config.url,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      csrfPath: '/public/workflow/rest/v1/workflow-definitions',
      env,
      ...(fetchImpl ? { fetchImpl } : {})
    });
  }
  const provider = createDatasphereTokenProvider({
    config,
    env,
    profile: PROCESS_AUTOMATION_OAUTH,
    ...(persistRefreshToken ? { persistRefreshToken } : {}),
    ...(fetchImpl ? { fetchImpl } : {})
  });
  return createStaticServiceClient({
    label: 'PROCESS_AUTOMATION',
    url: config.url,
    authorization: async () => `Bearer ${accessToken ?? (await provider.token()).accessToken}`,
    env,
    ...(fetchImpl ? { fetchImpl } : {})
  });
}
