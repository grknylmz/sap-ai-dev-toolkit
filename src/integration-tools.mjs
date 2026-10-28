// MCP tools for SAP Integration Suite: Cloud Integration (CPI) and API Management (APIM).
// Writes cover create, update, deploy, undeploy and guarded APIM deletion; every write
// checks an exact confirmation string before any network call. Secrets are write-only.
import { z } from 'zod';
import { apimToolNames, registerApimTools } from './apim-tools.mjs';
import { cpiToolNames, registerCpiTools } from './cpi-tools.mjs';
import { devhubToolNames, registerDevhubTools } from './devhub-tools.mjs';
import { READ_ONLY_ANNOTATIONS, resultOf } from './integration-common.mjs';
import { registerIntegrationAnalysisTools, registerMonitoringReadinessTools } from './integration-analysis.mjs';
import { registerIntegrationReleaseTools } from './integration-release-store.mjs';
import { registerApimRuntimeTools } from './apim-runtime.mjs';
import { capabilityCatalog } from './integration-capabilities.mjs';
import { optionalToolNames, registerOptionalIntegrationTools } from './integration-optional-tools.mjs';
import { registerIntegrationTransportTools } from './integration-transport.mjs';

export { INTEGRATION_MAX_OUTPUT_BYTES } from './integration-common.mjs';

const analysisNames = [];
registerIntegrationAnalysisTools(name => analysisNames.push(name), {});
const releaseNames = [];
registerIntegrationReleaseTools(name => releaseNames.push(name), {});
const runtimeNames = [];
registerApimRuntimeTools(name => runtimeNames.push(name), {});
const monitoringNames = [];
registerMonitoringReadinessTools(name => monitoringNames.push(name), {});
const transportNames = [];
registerIntegrationTransportTools(name => transportNames.push(name), {});
export const INTEGRATION_TOOL_NAMES = Object.freeze(['integration_connection_info', ...cpiToolNames(), ...apimToolNames(), ...devhubToolNames(), ...analysisNames, ...releaseNames, ...runtimeNames, ...monitoringNames, ...transportNames, ...optionalToolNames()]);

/** Register only the integration sides whose credentials are configured. */
export function registerIntegrationTools(server, { cpi, apim, devhub, ans, ctms, event_mesh, aem, aem_semp, open_connectors, edge, summary, verify, env, fetchImpl, execFileImpl, pollIntervalMs = 2000, readBackDelayMs = 5000 } = {}) {
  const registeredNames = [];
  const register = (name, title, description, inputSchema, annotations, handler) => {
    registeredNames.push(name);
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(async () => {
      const value = await handler(args);
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...value, environment: summary?.environment ?? 'default' } : value;
    }));
  };

  register('integration_connection_info', 'Integration Suite connection info',
    'Report the full component catalog, immutable tenant bindings/environment label, configured core access and separate optional capability evidence. Verification is read-only. Endpoint access does not establish activation, entitlement, common-subaccount identity or continuous monitoring. No credentials returned.',
    { verify: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ verify: online }) => {
      const verification = online && verify ? await verify() : undefined;
      return { ...summary, common_subaccount: 'unverified',
        capabilities: capabilityCatalog({ summary, verification, toolNames: registeredNames, optional_config_errors: summary?.optional_config_errors }),
        ...(verification ? { verification } : {}) };
    });

  if (cpi) registerCpiTools(register, cpi, { pollIntervalMs, summary });
  if (cpi || apim) registerIntegrationAnalysisTools(register, { cpi, apim, summary });
  if (cpi || apim) registerIntegrationReleaseTools(register, { cpi, apim, summary, env, readBackDelayMs });
  if (apim) registerApimTools(register, apim, { readBackDelayMs });
  if (apim) registerApimRuntimeTools(register, { apim, devhub, env, fetchImpl, execFileImpl });
  if (devhub) registerDevhubTools(register, devhub, { readBackDelayMs });
  registerOptionalIntegrationTools(register, { ans, ctms, event_mesh, aem, aem_semp, open_connectors, edge });
  if (cpi || apim || ctms) registerIntegrationTransportTools(register, { cpi, apim, ctms, summary }, { env });
  if ([cpi, apim, devhub, ans].some(Boolean) || Object.values(summary ?? {}).some(side => side?.configured)) {
    registerMonitoringReadinessTools(register, { cpi, apim, ans, summary, verify });
  }
}
