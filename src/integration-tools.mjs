// MCP tools for SAP Integration Suite: Cloud Integration (CPI) and API Management (APIM).
// Writes cover create, update, deploy and undeploy — there are no delete tools — and every write
// checks an exact confirmation string before any network call. Secrets are write-only.
import { z } from 'zod';
import { apimToolNames, registerApimTools } from './apim-tools.mjs';
import { cpiToolNames, registerCpiTools } from './cpi-tools.mjs';
import { READ_ONLY_ANNOTATIONS, resultOf } from './integration-common.mjs';

export { INTEGRATION_MAX_OUTPUT_BYTES } from './integration-common.mjs';

export const INTEGRATION_TOOL_NAMES = Object.freeze(['integration_connection_info', ...cpiToolNames(), ...apimToolNames()]);

/** Register Integration Suite tools; cpi_* and apim_* only appear when their client is configured. */
export function registerIntegrationTools(server, { cpi, apim, summary, verify, pollIntervalMs = 2000, readBackDelayMs = 5000 } = {}) {
  const register = (name, title, description, inputSchema, annotations, handler) => {
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => resultOf(() => handler(args)));
  };

  register('integration_connection_info', 'Integration Suite connection info',
    'Return which Integration Suite services (CPI, APIM) are configured, their credential source and tenant hosts. With verify: true it also signs in and runs one read per tool area (packages, deployed artifacts, message logs, security material, number ranges, Partner Directory, data stores, JMS; API proxies, providers, products, key value maps, virtual hosts, and policy readiness via an API proxy bundle export) and reports areas whose role is missing. Never returns client ids or secrets.',
    { verify: z.boolean().default(false) },
    READ_ONLY_ANNOTATIONS,
    async ({ verify: online }) => (online && verify ? { ...summary, verification: await verify() } : summary));

  if (cpi) registerCpiTools(register, cpi, { pollIntervalMs });
  if (apim) registerApimTools(register, apim, { readBackDelayMs });
}
