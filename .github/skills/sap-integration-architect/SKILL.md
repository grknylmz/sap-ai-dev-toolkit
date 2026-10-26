---
name: sap-integration-architect
description: Architect SAP Integration Suite solutions — choose API Management, Cloud Integration, or both; design connectivity, per-hop security, error handling, monitoring, naming and versioning; assess the live CPI/APIM tenant; and produce an approved build plan with exact tool calls.
---

# SAP Integration Architect

Use this skill to design an integration on SAP Integration Suite before anything is built: which components to use, how each hop connects and authenticates, how failures surface, and the exact build plan. Build execution follows the `integration-suite-delivery` skill (or the SAP Integration Developer agent where the harness supports agents). ABAP/RAP authoring follows `rap-service-delivery`; SAP-standard and Clean Core decisions follow `sap-standard-api-analysis` and `clean-core-extensibility`.

Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.

The Integration Suite companion server is never destination-prefixed. Read its live `tools/list` once and follow each returned input schema; `cpi_*` tools appear only when CPI credentials are configured and `apim_*` tools only when APIM credentials are configured.

## 1. Requirement checklist

Consumers and providers · direction and trigger (synchronous request/reply, asynchronous, scheduled) · protocol and payload (OData V2/V4, REST, SOAP) · volume and latency · data sensitivity · authentication at every hop · error and retry expectations · environments · acceptance tests. Ask only for missing material details.

## 2. Assess before designing (read-only)

- `integration_connection_info` — which tenants are bound.
- CPI: `cpi_list_packages`, `cpi_list_iflows`, `cpi_get_iflow` (models and configuration of similar flows), `cpi_list_service_endpoints`, `cpi_get_iflow_runtime_status`, `cpi_list_message_logs` with status `FAILED`, `cpi_get_message_log`.
- APIM: `apim_list_api_providers`, `apim_get_api_provider`, `apim_list_api_proxies`, `apim_get_api_proxy`, `apim_list_virtual_hosts`.
- SAP backend: confirm on the ABAP destination server that the OData service is published (`PublishServiceBinding` belongs to RAP service delivery) and take the service path from it; check SAP-delivered APIs with `GetAPIReleaseState`.

Reuse matching providers, packages and iFlows instead of duplicating them.

## 3. Pattern decision guide

| Need | Pattern |
|---|---|
| Expose an existing OData/REST service to consumers with a managed URL, no payload change | API Management only — API provider + API proxy |
| Mapping, routing, enrichment, protocol change, multi-call orchestration, scheduled processing | Cloud Integration only — iFlow |
| External consumers need a managed API and the backend needs mediation | API Management in front of Cloud Integration — proxy targets the iFlow endpoint |

API Management targets: an API provider (Internet for S/4HANA Cloud and SAP BTP ABAP; On-Premise through the Cloud Connector virtual host, port and location ID) with a relative path such as `/sap/opu/odata4/...`, or a fixed `https://` URL. To front an iFlow, use the iFlow endpoint URL or an Internet provider on the CPI runtime host with relative path `/http/<sender path>`.

Cloud Integration: prefer the vetted `https-request-reply-http` template (HTTPS sender → Request Reply → HTTP receiver, Internet or On-Premise). Use custom BPMN only when the template cannot express the flow, starting from a model read from an existing iFlow.

## 4. Per-hop security

| Hop | How it authenticates |
|---|---|
| Client → API Management | Toolkit-created proxies carry no policies; the client `Authorization` header is forwarded unchanged. Add API-key or OAuth policies in the APIM UI when the gateway must authenticate consumers. |
| Client or APIM → Cloud Integration | OAuth token from a Process Integration Runtime `integration-flow` client with role `ESBMessaging.send`; calls without it get HTTP 401. |
| Cloud Integration → backend | Receiver authentication None, Basic, OAuth2 Client Credentials, Client Certificate or Principal Propagation; security materials are referenced by name and must already exist on the tenant. |
| API Management → backend | API providers store no credentials; use Cloud Connector principal propagation or forward the client credentials. |

Never ask for, print or store secrets. Credentials belong in the MCP host environment (`CPI_SERVICE_KEY`, `APIM_SERVICE_KEY`, or `VCAP_SERVICES`).

## 5. Errors, operations and platform timing

- A receiver error fails the message and returns HTTP 500 to the caller; define how the consumer reacts.
- Operate with message processing logs: status, error text and custom header properties (payloads are never read).
- Proven on live tenants: deployments can stay `STARTING` beyond a minute (`cpi_deploy_iflow` returns `timed_out` after 50 seconds; then poll `cpi_get_iflow_runtime_status`); service endpoints and message logs appear minutes after `STARTED`; API proxy read-back lags after import. Build these waits into acceptance tests instead of treating them as failures.

## 6. Naming and versioning rules

- Package ids: letters, digits, underscore. iFlow ids: letters, digits, `.`, `_`, `-`.
- iFlow names: ASCII letters, digits, space, period, hyphen or underscore; no trailing period. Put non-ASCII text in descriptions.
- API proxy and provider names: letters, digits, `_`, `-`. Reserved provider names: `TC_*`, `DEST_CI`, `APIMGMT_PORTAL`, `ON_PREM`, `Apimgmt_rt*`, and ContentCatalog.
- Base paths and sender paths: unique, lowercase, versioned (for example `/s4/salesorder/v1`); no `//`, `..` or trailing `/`.
- API proxy descriptions are stored as HTML (`<`, `>`, `&` come back escaped).
- Every iFlow update needs `expected_version` from a fresh read and bumps the patch version; every proxy update is a new revision.

## 7. Design deliverable

1. Chosen pattern, rationale and rejected alternatives.
2. Component flow (consumer → gateway → integration → backend).
3. Per-hop table: host, port, path, route (Internet or Cloud Connector), authentication.
4. Objects to create or change: package, iFlows (template or custom), externalized parameters, security materials, value mappings, API providers (`sap-client` where needed), API proxies, gateway policies, key value maps, API products.
5. Ordered build calls with their exact confirmation strings: `cpi_create_package` (`CREATE CPI PACKAGE <id>`), `cpi_create_iflow` (`CREATE IFLOW <id>`), `cpi_update_iflow_configuration` (`CONFIGURE IFLOW <id>`), `cpi_update_iflow` (`UPDATE IFLOW <id>`), `cpi_set_user_credential` (`SET USER CREDENTIAL <name>`), `cpi_set_oauth2_client_credential` (`SET OAUTH2 CLIENT CREDENTIAL <name>`), `cpi_deploy_iflow` (`DEPLOY IFLOW <id>`), `cpi_deploy_artifact` (`DEPLOY ARTIFACT <id>`), `cpi_undeploy_artifact` (`UNDEPLOY ARTIFACT <id>`), `apim_create_api_provider` (`CREATE API PROVIDER <name>`), `apim_create_api_proxy` (`CREATE API PROXY <name>`), `apim_update_api_proxy` (`UPDATE API PROXY <name>`), `apim_create_key_value_map` (`CREATE KEY VALUE MAP <name>`), `apim_attach_api_proxy_policies` (`UPDATE API PROXY POLICIES <name>`), `apim_create_api_product` (`CREATE API PRODUCT <name>`).
6. Prerequisites outside the tools, with owners: Cloud Connector mappings, `integration-flow` clients, applications and API keys, API proxy undeploy, role assignments.
7. Acceptance tests and how they are verified: `cpi_get_iflow_runtime_status` is `STARTED`, `cpi_list_service_endpoints` returns the endpoint, `apim_get_api_proxy` returns `runtime_url` and state, and test calls appear as `COMPLETED` message logs.
8. Risks and open questions.

Present the deliverable and wait for explicit user approval before any create, update, configure, deploy or undeploy call. There are no delete tools; design-time deletion and API proxy undeploy are manual steps in the Integration Suite UI.
