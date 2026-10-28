// Public documentation is contract evidence, not proof of activation, entitlement or access.
const DOC = 'https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/';
const handoff = (prerequisites, steps, safety, verification) => ({ prerequisites, steps, safety, post_action_verification: verification });
const CATALOG = {
  cpi: {
    name: 'Cloud Integration', public_contract: 'established', prefix: 'cpi_',
    authentication: 'OAuth client credentials for the CPI API; permissions depend on each operation',
    setup_requirements: ['Existing CPI API service key via CPI_SERVICE_KEY or hidden setup input; API credential is distinct from runtime sender credentials'],
    source_links: [DOC + 'ci/Development/message-processing-logs-827a2d7.md', DOC + 'ci/Development/backup-and-restore-your-integration-artifacts-bd280ef.md'],
    native_handoff: [
      handoff(['Exact artifact ID/version, dependency and backup review'], ['Design → package → Edit → Artifacts → Add → appropriate Value Mapping/Script Collection/Message Mapping Create or Upload', 'Use the design-workspace archive format; Save as Version / Version History and restore in the native editor'], 'Individual ZIP, mass-download ZIP and MTAR are different formats. Source creation is not deployment.', ['Read resulting artifact ID/version; separately approve deployment and verify runtime identity']),
      handoff(['Exact queue and approved message identities'], ['Monitor → Manage Stores → Message Queues → inspect queue and Where-Used/access type/state', 'Actions → Usage → Start/Stop; retry only separately approved messages in an active non-exclusive queue'], 'Whole-queue Retry affects all messages and needs distinct approval; duplicate receiver effects remain possible.', ['Refresh queue metadata and correlate MPL; never consume message bodies for inspection']),
      handoff(['Exact MPL/design identity, backup/dependency/lock/configure-only review'], ['Use the native monitoring action for supported cancellation; use native design deletion confirmation for the exact artifact'], 'No guessed cancellation/status write; do not promise processing stops, unlock another user or substitute queue deletion.', ['Verify named design absence or the observed processing state separately'])
    ]
  },
  apim: {
    name: 'API Management', public_contract: 'established', prefix: 'apim_',
    authentication: 'API Management API-access OAuth client credentials; analytics, management and runtime authority are distinct',
    setup_requirements: ['Existing APIM_SERVICE_KEY or hidden setup input; inspect operation-specific API roles'],
    source_links: [DOC + 'apim/API-Management/APIM-Initial-Setup/accessing-api-management-apis-programmatically-24a2c37.md', 'https://api.sap.com/api/APIPortal_Analytics_CF/overview', DOC + 'apim/API-Management/api-revisions-58097ac.md'],
    native_handoff: [handoff(['Exact proxy/retained revision; preserve current draft and review product associations'], ['API details → Revisions → select retained revision → Revert', 'Inspect the resulting new revision → Deploy; standalone Undeploy uses its native action'], 'Saved-bundle import is a new imported revision, not native Revert. Deletion is not undeployment.', ['Read named proxy state/version and static policy evidence; perform separately approved consumer smoke reads'])]
  },
  devhub: {
    name: 'Developer Hub', public_contract: 'established', prefix: 'devhub_',
    authentication: 'Developer Hub API-access OAuth service key; consumer API keys are separate private runtime credentials',
    setup_requirements: ['Existing DEVHUB_SERVICE_KEY or hidden setup input; registered application/developer identities for consumer operations'],
    source_links: [DOC + 'apim/API-Management/create-or-update-or-read-an-application-using-subscription-key-e2645b5.md'],
    native_handoff: [handoff(['Exact consumer application/developer, owner approval and coordinated private credential delivery'], ['My Workspace → Subscriptions → Regenerate Key; coordinate client cutover', 'Admin Center → Manage Users → Registered Users → Revoke User with reason for portal access removal'], 'Regeneration changes key and secret and invalidates the old key. Portal revoke, unpublish and application deletion do not prove issued OAuth-token revocation.', ['Inspect application/subscription metadata; separately approve bounded runtime smoke reads'])]
  },
  ctms: {
    name: 'Cloud Transport Management', public_contract: 'established', prefix: 'ctms_',
    authentication: 'OAuth client credentials from CTMS_SERVICE_KEY uri and uaa fields',
    setup_requirements: ['Existing cTMS service key; Content Agent assembly and source/target destinations/routes require administrator confirmation', 'Node access does not prove upload/import readiness or entitlement'],
    source_links: ['https://github.com/SAP/jenkins-library/blob/master/src/com/sap/piper/integration/TransportManagementService.groovy', 'https://github.com/SAP-docs/btp-cloud-transport-management/blob/main/docs/70-integrations/extended-integration-scenarios-7e966f7.md', 'https://github.com/SAP-docs/btp-cloud-transport-management/blob/main/docs/80-ans-integration/migrating-to-sap-alert-notification-service-as-a-trusted-internal-service-0914d2c.md'],
    contract_boundaries: [{ operation: 'Transport upload/import/history/log automation', public_contract: 'documented_reference_inaccessible', detail: 'Detailed TMS_v2 archive/result schemas require SAP-ID access; no speculative upload, import, reset, forward or delete tools' }],
    native_handoff: [handoff(['Named source content/versions, target node/route, Content Agent and source/target destinations, independent target-bound server'], ['Authorized owner assembles CPI/APIM content with Content Agent into its supported transport format', 'Select source/export node and target route; submit the named request', 'Authorized operator imports the explicitly approved request set and tracks action/request logs'], 'Separate assembly/upload/import approvals. A ZIP or toolkit snapshot is not an MTAR. Error can mean partial import; resetting to Repeatable is not rollback. Use trusted internal ANS integration, not obsolete ALERT_NOTIFICATION_SERVICE destination (removal scheduled Q4 2026).', ['On target-bound server inspect exact content/versions/runtime/endpoints and separately approved consumer smoke reads'])]
  },
  ans: {
    name: 'Alert Notification service', public_contract: 'established', prefix: 'ans_',
    authentication: 'Technical-client Basic authentication; CONFIGURATION_READ for inspection, separately authorized CONFIGURATION_WRITE for rules',
    setup_requirements: ['Existing ANS_CONFIG {url,username,password}; configure delivery actions natively', 'Rule inspection never proves notification delivery'],
    source_links: ['https://github.com/SAP/alert-notification-node-client/blob/main/src/configuration-api/configuration-client.ts', 'https://github.com/SAP/alert-notification-node-client/blob/main/src/configuration-api/models.ts', 'https://github.com/SAP/alert-notification-node-client/blob/main/src/utils/common.ts'],
    native_handoff: [handoff(['Existing service and technical client, exact subscription/condition/action identities'], ['Configure action recipients/credentials in native ANS', 'Inspect scoped event conditions, enabled subscriptions/actions and native delivery status'], 'No arbitrary action-property writer or implicit all-events subscription. CPI failures are not automatically ANS events.', ['Verify references and intentional scope; require approved synthetic notification delivery evidence'])]
  },
  event_mesh: {
    name: 'Standalone Event Mesh (default plan)', public_contract: 'established', prefix: 'event_mesh_',
    authentication: 'Management-binding OAuth client credentials; exact token endpoint is preserved',
    setup_requirements: ['Existing EVENT_MESH_CONFIG {url,tokenUrl,clientId,clientSecret,probeQueueName?}', 'Set an existing fully qualified probeQueueName to test management access; otherwise no token/API probe is made'],
    source_links: ['https://help.sap.com/docs/event-mesh/event-mesh/use-rest-apis-to-manage-queues-and-queue-subscriptions'],
    native_handoff: [handoff(['Existing standalone default-plan service, namespace and queue identity'], ['Use native Event Mesh management to inspect namespace, queues and subscriptions'], 'Standalone default-plan APIs do not establish Suite-embedded Event Mesh parity; no message consumption or replay.', ['Read exact named queue management metadata when credentials and identity are supplied'])]
  },
  aem: {
    name: 'Advanced Event Mesh cloud management', public_contract: 'established', prefix: 'aem_',
    authentication: 'Static cloud API bearer token with minimum services:view; fixed US origin https://api.solace.cloud',
    setup_requirements: ['Existing AEM_CONFIG {apiToken}; use GA Mission Control API only', 'Cloud API token is not a broker-local SEMP credential'],
    source_links: ['https://help.pubsub.em.services.cloud.sap/Cloud/cloud-rest-api-lp.htm', 'https://api.solace.dev/cloud/openapi/mission-control.json'],
    native_handoff: [handoff(['Exact broker service/operation identity, appropriate cloud role'], ['Inspect broker service and operation in the native cloud console'], 'No Beta availability endpoint, alternate region fallback or broker credential output.', ['Read GA broker service metadata and observed operation state'])]
  },
  aem_semp: {
    name: 'Advanced Event Mesh broker-local SEMP', public_contract: 'established', prefix: null,
    authentication: 'Broker-local Basic with VPN-scoped read-only management user; private session-cookie reuse',
    setup_requirements: ['Existing AEM_SEMP_CONFIG {url,msgVpnName,username,password}; Basic must be enabled', 'HTTP 529 means no session slot, not empty queues; do not substitute a cloud API token'],
    source_links: ['https://help.pubsub.em.services.cloud.sap/Admin/SEMP/SEMP-Security.htm'],
    native_handoff: [handoff(['Exact broker origin and VPN, VPN-scoped read-only management access'], ['Inspect queue monitor state in the native broker console'], 'No SEMP proxy, message-body read or control/replay action.', ['Read configured VPN queue monitor metadata; authenticate only to the configured broker'])]
  },
  open_connectors: {
    name: 'Open Connectors', public_contract: 'established', prefix: 'open_connectors_',
    authentication: 'User <secret>, Organization <secret>; private Element token only for exact instance enabled-state action',
    setup_requirements: ['Existing OPEN_CONNECTORS_CONFIG {url,userSecret,organizationSecret}; URL includes /elements/api-v2'],
    source_links: ['https://help.openconnectors.ext.hana.ondemand.com/home/organization-secret-and-user-secret', 'https://help.openconnectors.ext.hana.ondemand.com/home/disabling-and-enabling-instances', 'https://help.openconnectors.ext.hana.ondemand.com/home/standardized-pagination'],
    native_handoff: [handoff(['Exact instance/provider identity, administrator access for provider authorization'], ['Inspect the instance enabled state in the native console', 'Perform provider-specific OAuth/re-authentication in the native workflow'], 'Disable is DELETE /instances/enabled, not instance deletion. Acceptance does not establish provider health or effective state.', ['Read safe instance identity; inspect enabled state/provider authorization natively'])]
  },
  edge: {
    name: 'Edge Integration Cell local APIs', public_contract: 'established', prefix: 'edge_',
    authentication: 'Local Basic service-key clientId/clientSecret against the API virtual-host origin; preserve /local routes',
    setup_requirements: ['Existing EDGE_CONFIG {url,clientId,clientSecret}; local API network reachability', 'A local 401 can mean missing /local; unsupported local endpoints can return 403; neither proves non-entitlement'],
    source_links: [DOC + 'ISuite_Edge_Integration_Cell/local-odata-api-access-fe61332.md', DOC + 'ISuite_Edge_Integration_Cell/operations-cockpit-api-da1abc0.md'],
    contract_boundaries: [{ operation: 'Component/pod/job field-level operational schemas', public_contract: 'not_established', detail: 'Published route inventory does not establish safe status-field projections; no raw-object passthrough or restart/Kubernetes tools' }],
    native_handoff: [handoff(['Exact cell/runtime/message identities and native cockpit access'], ['Use Operations Cockpit to inspect component/pod/job diagnostics', 'Use local metadata/MPL APIs for supported read-only diagnosis'], 'No cloud OAuth substitution, Kubernetes administration or component restart.', ['Read local OData metadata and bounded message/run evidence where supported'])]
  },
  cloud_alm: {
    name: 'SAP Cloud ALM continuous monitoring', public_contract: 'established',
    authentication: 'Administrator-run Cloud ALM integration; dedicated CPI API credential, not a developer-credential grant',
    setup_requirements: ['Dedicated CPI API credential and Landscape Management endpoint', 'Configure Integration & Exception Monitoring collection/categories and Health Monitoring', 'MonitoringDataRead, MonitoringArtifactsDeploy and HealthCheckMonitoringDataRead are separate setup requirements', 'Require collection and approved synthetic notification delivery evidence before continuous monitoring is verified'],
    source_links: ['https://support.sap.com/en/alm/sap-cloud-alm/operations/expert-portal/integration-monitoring/calm-cpi.html'],
    native_handoff: [handoff(['Cloud ALM administrator and dedicated integration credential'], ['Configure Landscape Management endpoint', 'Enable Integration & Exception Monitoring collection/categories and Health Monitoring', 'Configure native event thresholds and notifications'], 'CPI API access alone is not continuous collection/delivery; no scheduler or telemetry daemon is installed. APIM anomaly readiness is distinct from analytics polling.', ['Observe collection and approved synthetic notification delivery; otherwise needs_admin_confirmation'])]
  },
  suite_event_mesh: {
    name: 'Suite-embedded Event Mesh', public_contract: 'not_established',
    authentication: 'Native Suite activation/role requirements; standalone Event Mesh credentials are not evidence of access',
    setup_requirements: ['Separate Suite capability activation and limits must be inspected by an administrator'],
    source_links: ['https://help.sap.com/docs/integration-suite'],
    native_handoff: [handoff(['Suite administrator and exact embedded capability/tenant'], ['Configure/Monitor → Event Mesh; inspect activation and configured limits'], 'No assumption of parity with standalone default-plan APIs.', ['Confirm embedded capability activation/limits in its native surface'])]
  },
  tpm: {
    name: 'Trading Partner Management', public_contract: 'established',
    authentication: 'Native TPM roles; B2bInterchangeRead for metadata, B2bInterchangeOperate for separately approved operations',
    setup_requirements: ['Exact agreement/version and Default or Full activation mode; inspect generated runtime dependencies'],
    source_links: [DOC + 'ISuite_Trading_Partner_Management/activating-a-trading-partner-agreement-baed0e3.md', DOC + 'ISuite_Trading_Partner_Management/monitor-interchanges-42c1199.md'],
    native_handoff: [handoff(
      ['Exact agreement/version, explicit Default versus Full approval, business-document identity and B2bInterchangeRead'],
      ['Design → B2B Scenarios → Agreements → open exact agreement → Activate → choose Default or Full → confirm',
        'Default activates agreement/channels, not inactive security configurations, identifier groups or custom rules; Full activates all referenced objects',
        'Inspect Failed activation details and Partner Directory Data → Copy PID / View Data; use Monitor → Interchanges for document state'],
      'Company-side AS2 inbound decryption requires manual activation. Never edit generated Partner Directory parameters to simulate agreement management. Payload read is separate; retry/restart/cancel require distinct approval and B2bInterchangeOperate.',
      ['Inspect activation/interchange results and separately verify resulting CPI runtime artifacts'])]
  },
  integration_advisor: {
    name: 'Integration Advisor', public_contract: 'not_established',
    authentication: 'Native Integration Advisor role/access; no established external MIG/MAG administration adapter',
    setup_requirements: ['Exact MIG/MAG identity/version and supported runtime artifact format'],
    source_links: [DOC + 'ISuite_Integration_Advisor/exporting-runtime-artifacts-5ab4cfe.md', DOC + 'ISuite_Integration_Advisor/consuming-integration-advisor-artifacts-in-integration-flows-a33a6c6.md'],
    native_handoff: [handoff(
      ['Named MIG/MAG and selected version, native validation/simulation and intended runtime format'],
      ['Open MIG/MAG → select exact version → review validation/simulation', 'Additional Options → Export → SAP Cloud Integration Runtime Artifacts', 'Inspect generated XSD/XSL/scripts/examples and import supported CPI content separately'],
      'Generated runtime ZIP is not a transport MTAR or editable MIG/MAG source. Editing generated CPI output does not modify its source guideline. Do not mix old and newly exported namespace-dependent artifact files.',
      ['Inspect source validation/export and resulting CPI artifact identity/version; separately authorize deployment'])]
  },
  integration_assessment: {
    name: 'Integration Assessment', public_contract: 'documented_reference_inaccessible',
    authentication: 'Existing Integration Assessment APIs/default credential; url is token-server URL, entities/management are resource origins',
    setup_requirements: ['Existing Assessment API service key and access to User Actions → API Reference; exact resource schemas must be established before automation'],
    source_links: [DOC + 'ISuite_Integration_Assessment/integration-assessment-apis-47847b5.md', DOC + 'ISuite_Integration_Assessment/creating-service-instance-and-service-key-to-enable-api-calling-749897f.md'],
    native_handoff: [handoff(['Assessment administrator and existing APIs/default credential'], ['User Actions → API Reference → inspect the exact resource/schema', 'Use native assessment workflow for the selected identity'], 'Do not parse this key as CPI or guess an /applications endpoint.', ['Record exact accessible API contract and selected assessment outcome before proposing an adapter'])]
  },
  migration_assessment: {
    name: 'Migration Assessment and tooling', public_contract: 'not_established',
    authentication: 'Native assessment/tooling access; no guessed external API or reused PO credentials',
    setup_requirements: ['Exact extraction/evaluation request and approved source-system access'],
    source_links: [DOC + 'ISuite_Migration_Assessment/create-a-data-extraction-request-ce0ad0e.md', DOC + 'ISuite_Migration_Assessment/create-a-scenario-evaluation-request-435ec61.md'],
    native_handoff: [handoff(['Selected source/request, native migration authorization'], ['Request → Data Extraction → inspect Log', 'Request → Scenario Evaluation → inspect dashboard → export/generate report', 'Run conversion in native migration tooling; inspect generated CPI content separately'], 'Assessment is not conversion/deployment; no PO-credential reuse or guessed migration API.', ['Inspect extraction/evaluation outcome and generated CPI artifact identities/content'])]
  },
  integration_cell_api_mcp: {
    name: 'New Integration Cell API/MCP artifacts', public_contract: 'not_established',
    authentication: 'Native Suite design/deploy/monitor roles; distinct from classic APIM and MCP invocation access',
    setup_requirements: ['Exact new artifact kind/identity/version and its native supported workflow'],
    source_links: [
      DOC + 'ISuite_Integrations_APIs/create-an-api-artifact-using-a-target-url-or-an-openapi-specification-914f57e.md',
      DOC + 'ISuite_Integrations_APIs/create-an-mcp-server-from-an-api-artifact-9f18140.md',
      DOC + 'ISuite_Integrations_APIs/deploy-an-api-artifact-b70e7ec.md',
      DOC + 'ISuite_Integrations_APIs/deploy-an-mcp-server-017ba42.md',
      DOC + 'ISuite_Integrations_APIs/monitor-apis-and-mcp-servers-399b6c6.md'
    ],
    native_handoff: [handoff(
      ['PI_Integration_Developer, activated API Management and provisioned Integration Cell, exact package/artifact/version and approved runtime/virtual host',
        'API-derived MCP requires a deployed OData/REST API with OAuth and OpenAPI 3.0.0–3.0.3'],
      ['Design → Integrations and APIs → package → Edit → Artifacts → Add → API → Integration Cell → URL or Specification; review and save configuration',
        'For MCP: Artifacts → Add → MCP Server → API → select deployed source API → select intentional tools → Add; review authentication/authorization policies',
        'Approve exact artifact deployment separately → Deploy → confirm runtime profile and virtual host',
        'Monitor → Integrations and APIs → Runtime: Integration Cell → Manage Integration Content / Monitor Message Processing; inspect deployed endpoints and logs'],
      'No external administration contract is established. Classic APIM proxy tools and CPI metadata discovery are not this artifact lifecycle. Runtime profile is fixed at creation; deployed endpoint can differ from design-time virtual host. MCP invocation access does not authorize administration.',
      ['Verify exact deployed artifact version, chosen runtime/virtual host and processing outcome natively; separately authorize any consumer invocation'])]
  }
};

const RESULT = new Set(['ok', 'unauthenticated', 'forbidden', 'unavailable', 'untested', 'error']);
const SOURCES = new Set(['environment', 'service-key', 'stored-key', 'vcap-services']);

/** Always return the full catalog. Only registered tools can become supported actions. */
export function capabilityCatalog({ summary = {}, verification, toolNames = [], optional_config_errors = [] } = {}) {
  const registered = [...new Set(Array.isArray(toolNames) ? toolNames.filter(name => typeof name === 'string' && /^[a-z][a-z0-9_]+$/.test(name)) : [])];
  const catalog = {};
  for (const [key, definition] of Object.entries(CATALOG)) {
    const { prefix, ...metadata } = definition;
    const configured = summary[key]?.configured === true || verification?.[key]?.configured === true;
    const report = verification?.[key];
    const access = RESULT.has(report?.result) ? report.result : 'untested';
    const actions = registered.filter(name => key === 'aem_semp' ? name === 'aem_list_queues' : key === 'aem' ? name.startsWith('aem_') && name !== 'aem_list_queues' : prefix && name.startsWith(prefix));
    const invalid = optional_config_errors.some(error => error?.component === key);
    catalog[key] = {
      ...structuredClone(metadata),
      configured,
      configuration: invalid ? 'invalid' : configured ? 'configured' : 'absent',
      ...(SOURCES.has(summary[key]?.source) ? { configuration_source: summary[key].source } : {}),
      access, activation: 'unknown', entitlement: 'unknown', common_subaccount: 'unverified',
      supported_actions: actions,
      native_access: 'unverified'
    };
  }
  return catalog;
}
