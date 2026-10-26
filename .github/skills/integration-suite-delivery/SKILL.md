---
name: integration-suite-delivery
description: Build and operate SAP Integration Suite scenarios — Cloud Integration iFlows, value mappings, script collections, security material, Partner Directory and monitoring, and API Management providers, proxies, policies, products and key value maps.
---

# Integration Suite delivery

Use this skill when a scenario spans SAP Cloud Integration (CPI) and/or SAP API Management (APIM), including exposing an ABAP RAP OData service through an API proxy. The Integration Suite tools come from the separate `integration-suite` companion MCP server; ABAP tools come from the destination server. Query each server's live `tools/list` and follow every returned input schema exactly.

Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.

The Integration Suite companion is never destination-prefixed; its tools are already snake_case.

## Tool shortlist

- Connection: `integration_connection_info`.
- CPI design-time read: `cpi_list_packages`, `cpi_list_iflows`, `cpi_list_package_artifacts`, `cpi_get_iflow`, `cpi_get_artifact`, `cpi_get_value_mappings`.
- CPI design-time write: `cpi_create_package`, `cpi_update_package`, `cpi_copy_package`, `cpi_create_iflow`, `cpi_update_iflow`, `cpi_update_iflow_configuration`, `cpi_upsert_value_mappings`, `cpi_update_script_collection`.
- CPI deployment: `cpi_deploy_iflow`, `cpi_deploy_artifact`, `cpi_undeploy_artifact`, `cpi_list_runtime_artifacts`, `cpi_get_iflow_runtime_status`, `cpi_list_service_endpoints`.
- CPI monitoring: `cpi_list_message_logs`, `cpi_get_message_log`, `cpi_get_message_log_steps`, `cpi_get_jms_broker_status`, `cpi_list_data_stores`, `cpi_list_data_store_entries`, `cpi_list_variables`.
- CPI security material and tenant configuration: `cpi_list_security_material`, `cpi_set_user_credential`, `cpi_set_oauth2_client_credential`, `cpi_upload_certificate`, `cpi_list_number_ranges`, `cpi_set_number_range`, `cpi_list_partner_parameters`, `cpi_set_partner_parameter`.
- APIM providers and proxies: `apim_list_api_providers`, `apim_get_api_provider`, `apim_create_api_provider`, `apim_update_api_provider`, `apim_list_api_proxies`, `apim_get_api_proxy`, `apim_export_api_proxy`, `apim_list_virtual_hosts`, `apim_create_api_proxy`, `apim_update_api_proxy`, `apim_attach_api_proxy_policies`.
- APIM products and key value maps: `apim_list_api_products`, `apim_get_api_product`, `apim_create_api_product`, `apim_update_api_product`, `apim_list_key_value_maps`, `apim_get_key_value_map`, `apim_create_key_value_map`, `apim_set_key_value_map_entries`.
- Anything else (access policies, JMS queues, applications, developers, certificate store references): the read-only `cpi_odata_get` / `apim_odata_get`; start with path `/$metadata` to see the entity sets.

`cpi_*` tools appear only when CPI credentials are configured and `apim_*` tools only when APIM credentials are configured. Start every session with `integration_connection_info` and `verify: true` to see which side is available, which tenant hosts are bound, and which tool areas the service key lacks a role for. When a side is missing, cannot sign in, or lacks roles, ask the user to run `sap-ai-dev --setup-integration` in a terminal: it takes the key from the logged-in Cloud Foundry space (and can create a dedicated instance with the needed roles) or from a pasted key, checks it online, and stores it user-only. Never ask for a key in the chat.

## Exposing an SAP OData service through API Management

1. **Confirm the ABAP service is published.** On the ABAP destination server, confirm the service binding exists and is published with `PublishServiceBinding`. Creating or changing the RAP service itself belongs to the `rap-service-delivery` skill; do not author ABAP here.
2. **Derive the service path.** OData V4: `/sap/opu/odata4/<service group path>/<binding>/<version>/`; OData V2: `/sap/opu/odata/sap/<SERVICE_NAME>/`. Use the path the published binding reports; do not guess it.
3. **Find or create the API provider.** Call `apim_list_api_providers` and reuse a provider whose host, port, and type already match. Otherwise plan `apim_create_api_provider`:
   - on-premise S/4HANA or ECC through the Cloud Connector: `type: on_premise` with the Cloud Connector virtual host, virtual port, optional `location_id`, and optional `sap_client`;
   - S/4HANA Cloud or SAP BTP ABAP environment: `type: internet` with the public host and port 443.
   No credentials are stored on the provider. Backend authentication is configured in the Cloud Connector (for example principal propagation) or sent by the API client.
4. **Create the API proxy.** Plan `apim_create_api_proxy` with `service_type: odata`, a unique `base_path`, and a provider target whose `relative_path` is the service path from step 2. The import deploys the proxy.
5. **Secure and throttle it.** Plan one `apim_attach_api_proxy_policies` call (see below) instead of hand-editing the proxy in the UI.
6. **Package it for consumers.** Plan `apim_create_api_product` over the proxy (published by default, optional quota) when API keys or the developer portal are needed.
7. **Report the runtime URL.** Call `apim_get_api_proxy` and report `runtime_url` and `state`. When the read-back is still delayed, call it again shortly instead of re-creating the proxy.

## API Management policies, products and key value maps

- `apim_attach_api_proxy_policies` exports the proxy, writes each policy, registers it, adds its flow step, and re-imports (which redeploys). Templates: `verify_api_key`, `quota`, `spike_arrest`, `cors` (response), `assign_headers`, `oauth_verify_access_token`, `ip_allow`, `response_cache`, `basic_auth_from_kvm`, `raise_fault`, `javascript`, and `custom` (raw policy XML with the `http://www.sap.com/apimgmt` namespace). Re-attaching the same policy name replaces its XML and keeps a single step; step order follows the order in the call.
- Typical API-key setup: `verify_api_key` (proxy, pre, request) then `quota` or `spike_arrest`, then `apim_create_api_product` so consumers can subscribe.
- Technical backend user: store the user and password in an encrypted map with `apim_create_key_value_map` (or `apim_set_key_value_map_entries`), then attach `basic_auth_from_kvm` (target endpoint, preFlow request by default).
- Read the current policy set with `apim_export_api_proxy` before changing it. `apim_update_api_proxy` changes base path, target, title and description and keeps every policy, step and script.
- Product proxy membership is set at creation; `apim_update_api_product` changes title, description, scope, quota and publish state only.
- Not covered by tools: API proxy undeploy, applications/subscriptions and API key issuance (read them with `apim_odata_get`), analytics. Say so and route those to the API Management UI or developer portal.

## iFlow procedure

1. `cpi_list_packages`; plan `cpi_create_package` only when no suitable package exists. To start from SAP standard content, plan `cpi_copy_package` (`CREATE_COPY` with a suffix, or `OVERWRITE_MERGE` to refresh while keeping configuration).
2. Plan `cpi_create_iflow`. Prefer the `https-request-reply-http` template (HTTPS sender → Request Reply → HTTP receiver, internet or on-premise via Cloud Connector). Use `template: custom` with caller-supplied BPMN only when the template cannot express the flow, and read an existing similar iFlow with `cpi_get_iflow` first to copy proven adapter versions.
3. Adjust externalized values with `cpi_update_iflow_configuration`; change bundle files with `cpi_update_iflow`, passing the `expected_version` you just read.
4. `cpi_deploy_iflow`, then confirm with `cpi_get_iflow_runtime_status` (expect `STARTED`). The deploy call waits at most 50 seconds; when it returns `timed_out: true`, poll `cpi_get_iflow_runtime_status` instead of deploying again. `cpi_list_service_endpoints` can stay empty for a few minutes after `STARTED`; retry it rather than treating it as a failure.
5. Receiver credentials must exist before deployment: check with `cpi_list_security_material`; create them with `cpi_set_user_credential` or `cpi_set_oauth2_client_credential`, and trust a backend certificate with `cpi_upload_certificate`. Cloud Connector setup stays outside the toolkit.
6. Value mappings: `cpi_get_value_mappings`, `cpi_upsert_value_mappings`, then `cpi_deploy_artifact`. Script collections: `cpi_update_script_collection`, then `cpi_deploy_artifact`. Message mappings are deployed with `cpi_deploy_artifact` and read with `cpi_get_artifact`.
7. Retire a runtime artifact with `cpi_undeploy_artifact`; design-time deletion stays manual.
8. iFlow names must start with a letter or underscore and use only ASCII letters, digits, space, period, hyphen or underscore (no trailing period); put non-ASCII text in the description instead. API proxy descriptions are stored as HTML, so `<`, `>` and `&` come back escaped.

## Troubleshooting

- `cpi_get_iflow_runtime_status` shows deployment errors (for example a missing credential name or an invalid adapter value); `cpi_list_runtime_artifacts` with `status: ERROR` finds every failed deployment.
- `cpi_list_message_logs` with `status: FAILED` and the iFlow id narrows failing messages; filter by `correlation_id`, `application_message_id` or `custom_header` to follow one business document. `cpi_get_message_log` returns the error text and custom header properties, and `cpi_get_message_log_steps` shows which step failed. Payloads and attachments are intentionally not read.
- `cpi_get_jms_broker_status`, `cpi_list_data_stores` and `cpi_list_variables` explain stuck or overdue asynchronous processing.
- For APIM, re-read with `apim_get_api_proxy`, `apim_export_api_proxy` and `apim_get_api_provider`; check virtual hosts with `apim_list_virtual_hosts`.

## Safety

- Present the plan (target tenant hosts, every object to create/update/deploy/undeploy, and the exact confirmation strings) before any write, and wait for explicit user approval.
- Pass the exact confirmation string from the approved plan, for example `CREATE IFLOW <iflow_id>`, `DEPLOY IFLOW <iflow_id>`, `UNDEPLOY ARTIFACT <artifact_id>`, `CREATE API PROXY <name>` or `UPDATE API PROXY POLICIES <name>`. Never invent or reuse a confirmation for an object the user did not approve.
- There are no delete tools. Design-time deletion is a manual step in the Integration Suite UI; say so instead of working around it.
- Secrets are write-only. Passwords, client secrets and key value map values go straight into the tool input that stores them; never repeat them in chat, plans, files or reports, and never ask for service keys. CPI/APIM client credentials are configured in the MCP host environment (`CPI_SERVICE_KEY`, `APIM_SERVICE_KEY`, or `VCAP_SERVICES`).
- Report what was created, deployed, and verified, including tool results that were delayed or not verified.
