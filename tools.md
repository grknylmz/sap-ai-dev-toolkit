# Curated SAP tools exposed through the BAS proxy

The proxy no longer advertises every tool provided by the SAP runtime. To keep the developer-lifecycle MCP surface manageable, each generated one-destination server exposes a curated set of upstream tools plus local workflow tools (up to 75 tools: 74 destination-scoped tools plus one workspace-scoped project-lint tool).

The names below are the logical tool names. Publicly they are exposed in lowercase snake_case without a prefix (`get_table_contents`, `run_query`) because each generated MCP server is scoped to one destination; only when a single server fronts multiple destinations does each name gain its destination slug (`demo-abap_get_table_contents`) to stay unambiguous. BAS/VS Code chat tool references bind only lowercase identifiers, so mixed-case names never reach the model.

Hidden upstream tools are not directly callable through the proxy. Local workflow tools may still call hidden or non-advertised operations internally when they are required for a bounded workflow.

## Public upstream tools

- `Activate`
- `ActivateMultiple`
- `CompareSource`
- `CreateObject`
- `CreatePackage`
- `CreateTable`
- `CreateTransport`
- `DebuggerAttach`
- `DebuggerDetach`
- `DebuggerGetStack`
- `DebuggerGetVariables`
- `DebuggerStep`
- `EditSource`
- `FindDefinition`
- `FindReferences`
- `GetAPIReleaseState`
- `GetBreakpoints`
- `GetCDSDependencies`
- `GetCDSElementInfo`
- `GetCDSImpactAnalysis`
- `GetClass`
- `GetClassComponents`
- `GetClassInclude`
- `GetClassInfo`
- `GetConnectionInfo`
- `GetContext`
- `GetFeatures`
- `GetFunction`
- `GetFunctionGroup`
- `GetInactiveObjects`
- `GetInclude`
- `GetInstalledComponents`
- `GetInterface`
- `GetMessages`
- `GetPackage`
- `GetProgram`
- `GetSource`
- `GetStructure`
- `GetSystemInfo`
- `GetTable`
- `GetTableContents`
- `GetTransport`
- `GetTransportInfo`
- `GetTypeInfo`
- `GetUserTransports`
- `GrepObjects`
- `GrepPackages`
- `ListDependencies`
- `ListTransports`
- `LockObject`
- `PrettyPrint`
- `PublishServiceBinding`
- `RunATCCheck`
- `RunQuery`
- `RunUnitTests`
- `SearchObject`
- `SetBreakpoint`
- `SyntaxCheck`
- `UI5GetApp`
- `UI5GetFileContent`
- `UI5ListApps`
- `UnlockObject`
- `UnpublishServiceBinding`
- `WriteSource`

`CreatePackage` creates a local package or a transportable package with an explicit transport; it changes SAP state and requires explicit approval. `CreateTable` creates a transparent DDIC table, writes its generated DDL source, and activates it. Client-dependent tables already get the implicit `CLIENT` key; supplied `CLIENT` or `MANDT` fields map to that same key and are not emitted twice. `GetStructure`, `GetTypeInfo`, and `GetMessages` are read-only metadata lookups. The upstream VSP package and transport mutation checks still apply. The pinned backend does not create structures, table types, or authorization objects.

## Hidden from direct proxy calls

Broad/destructive surfaces such as generic object deletion, SQL trace, arbitrary SAP router calls, transport release/delete, RFC execution, debugger listen/delete-breakpoint helpers, and one-off generator/update helpers are intentionally not advertised by the BAS proxy. The local `DeleteEmptyDDLS` workflow is a narrow exception: it verifies the source is blank and requires exact confirmation before deleting a Z/Y DDLS shell. UI5 repository writes are hidden too: the ADT filestore only reads UI5 apps, so deploy them with SAP Fiori tools instead.

## Local and destination-scoped workflow tools

The proxy adds local tools to the MCP surface. Some are workspace-wide; others are added to each destination when their required upstream capabilities are available. Like the upstream tools above, they are exposed publicly in lowercase snake_case (`lint_abap`, `lint_abap_project`, `get_application_log`, and so on):

- `LintABAP` — local in-memory ABAP linting.
- `LintABAPProject` — scan serialized ABAP objects in the configured workspace root (SAP_AI_DEV_TOOLKIT_WORKSPACE_ROOT, defaulting to the MCP server working directory) using the project abaplint config and available local dependency folders. This is static analysis only; it does not contact SAP or activate objects.
- `GetApplicationLog` — bounded convenience mapping to the upstream SAP application-log route when available.
- `UpdateTable` — update and activate an existing Z/Y DDIC table from replacement DDL after comparing expected_source with `GetTable`; the write uses VSP's hash check under lock and requires `UPDATE TABLE <TABLE_NAME>` confirmation.
- `DeleteEmptyDDLS` — delete only a blank Z/Y DDLS source after an emptiness check and exact `DELETE EMPTY DDLS <OBJECT_NAME>` confirmation. It calls the hidden generic delete operation internally.
- `PrepareABAPChangeSet` and `ApplyABAPChangeSet` — review full-source diffs and recheck source before explicit writes.
- `CheckTransportReadiness` — collect a whitelisted bundle of transport, dependency, inactive-object, ABAP Unit, and ATC results.
- `PlanABAPCloudMigration` — batch SAP API release-state checks and prioritize recognized unreleased results.
- `GenerateRAPRegressionSuite` and `RunRAPRegressionSuite` — create and run reusable OData GET-only checks under the selected service root.

`sap-ai-dev --doctor` checks destination probing, runtime startup, the `get_system_info` probe, and MCP tool listing. `sap-ai-dev --demo` runs the sample tools and OData fixtures without contacting SAP; demo writes and transport creation remain in memory until that process exits.


### Request timeouts

Calls forwarded to the runtime process time out after `SAP_AI_DEV_TOOLKIT_REQUEST_TIMEOUT_MS` (default 600000 ms; `0` disables). A stalled request fails with a timeout error; the process keeps running so unrelated in-flight requests are unaffected.

## Separate optional HANA Cloud inspector

The optional `hana-cloud-inspector` companion starts `sap-ai-hana` as a separate stdio MCP server. It does not use the BAS proxy, destination prefix, or ABAP SQL `RunQuery`. When selected and configured with a dedicated read-only identity, it exposes:

- `hana_connection_info` — verify the configured endpoint, service/binding, current user, schema, and TLS state without returning credentials.
- `hana_list_objects` — list tables/views in the bound HDI schema, with a 200-object maximum.
- `hana_describe_object` — inspect columns for a catalog-verified object in that schema.
- `hana_read_rows` — perform parameterized reads of selected columns, capped at 200 rows; credential-like columns are blocked and arbitrary SQL is not accepted.

Connection secrets are read from the MCP host environment via explicit `HANA_RO_*` variables or a selected `VCAP_SERVICES` binding and are not written to `mcp.json`. TLS certificate verification is mandatory. No HANA write, DDL/DML, deploy/undeploy, grants, or service-key tools are exposed; deployment remains a user-run project workflow.

## Separate optional Integration Suite server

The optional `integration-suite` companion starts `sap-ai-integration` as a separate stdio MCP server for SAP Cloud Integration (CPI) and API Management (APIM). It does not use the BAS proxy or a destination prefix. Tools for a side appear only when that side is configured:

- `integration_connection_info` — show which of CPI/APIM are configured, the credential source, and tenant hosts; with `verify: true` it signs in and reports per tool area whether the service key has the needed role. Never returns client ids or secrets.

Cloud Integration — design time:

- `cpi_list_packages` — list Cloud Integration packages.
- `cpi_list_iflows` — list the iFlows of one package.
- `cpi_list_package_artifacts` — list a package's iFlows, value mappings, script collections, and message mappings.
- `cpi_get_iflow` — read iFlow metadata, externalized configuration, and bundle files (or one file by path).
- `cpi_get_artifact` — read a value mapping, script collection, or message mapping with its bundle files.
- `cpi_get_value_mappings` — read value-mapping agency pairs with their value and default pairs.
- `cpi_create_package` — create a package.
- `cpi_update_package` — change package name, short text, description, or version.
- `cpi_copy_package` — copy a Discover package into Design (new copy with suffix, or overwrite-merge keeping configuration).
- `cpi_create_iflow` — create an iFlow from the vetted HTTPS → Request Reply → HTTP template or caller-supplied BPMN.
- `cpi_update_iflow` — replace/add bundle files and parameters with an expected-version check and patch-version bump.
- `cpi_update_iflow_configuration` — set externalized configuration parameters.
- `cpi_upsert_value_mappings` — add or change value-mapping pairs.
- `cpi_update_script_collection` — add or replace scripts in a script collection.

Cloud Integration — deployment and monitoring:

- `cpi_deploy_iflow` — deploy the active iFlow version and wait for build and runtime status.
- `cpi_deploy_artifact` — deploy a value mapping, script collection, or message mapping and wait for runtime status.
- `cpi_undeploy_artifact` — undeploy any runtime artifact and wait until it is gone.
- `cpi_list_runtime_artifacts` — list deployed artifacts, optionally by status.
- `cpi_get_iflow_runtime_status` — read deployed runtime status, including error text when the iFlow failed to start.
- `cpi_list_service_endpoints` — list deployed endpoint URLs, optionally for one iFlow.
- `cpi_list_message_logs` — list message processing logs by iFlow, status, time window, correlation id, application message id, or custom header.
- `cpi_get_message_log` — read one message log with error text and custom header properties; payload attachments are never read.
- `cpi_get_message_log_steps` — read the processing steps of a message's latest run with step errors.
- `cpi_get_jms_broker_status` — read JMS broker capacity and queues that are not healthy.
- `cpi_list_data_stores` — list data stores with message and overdue counts.
- `cpi_list_data_store_entries` — list entry metadata of one data store; payloads are never read.
- `cpi_list_variables` — list global and iFlow variables (metadata only).

Cloud Integration — security material and tenant configuration:

- `cpi_list_security_material` — list user credentials, OAuth2 client credentials, or keystore entries with secret fields redacted.
- `cpi_set_user_credential` — create or update a user credential; the password is write-only.
- `cpi_set_oauth2_client_credential` — create or update an OAuth2 client credential; the client secret is write-only.
- `cpi_upload_certificate` — add or replace a public certificate in the tenant keystore.
- `cpi_list_number_ranges` — list number ranges.
- `cpi_set_number_range` — create or update a number range.
- `cpi_list_partner_parameters` — list Partner Directory string parameters and binary parameter metadata.
- `cpi_set_partner_parameter` — create or update a Partner Directory string or binary parameter.
- `cpi_odata_get` — guarded read-only GET for other CPI entity sets (for example access policies or JMS queues) and the service metadata.

API Management:

- `apim_list_api_providers` — list API providers without credential fields.
- `apim_get_api_provider` — read one API provider with credential properties removed.
- `apim_create_api_provider` — create an Internet or On-Premise (Cloud Connector) API provider without credentials.
- `apim_update_api_provider` — change host, port, type, location, path prefix, or sap-client of a credential-free provider.
- `apim_list_api_proxies` — list API proxies.
- `apim_get_api_proxy` — read one API proxy with endpoints, virtual hosts, and the computed runtime URL.
- `apim_export_api_proxy` — export an API proxy bundle and return its files (policies, endpoints, scripts).
- `apim_list_virtual_hosts` — list virtual hosts.
- `apim_create_api_proxy` — import (and thereby deploy) a policy-free API proxy for a provider or https URL target.
- `apim_update_api_proxy` — change base path, target, title, or description; existing policies and steps are kept.
- `apim_attach_api_proxy_policies` — add or replace policies (API key, quota, spike arrest, CORS, headers, OAuth, IP allow list, response cache, Basic auth from a key value map, raise fault, JavaScript, custom XML) and their flow steps, then redeploy.
- `apim_list_api_products` — list API products.
- `apim_get_api_product` — read one API product with its proxies.
- `apim_create_api_product` — create (and by default publish) an API product over existing proxies with an optional quota.
- `apim_update_api_product` — change product title, description, scope, quota, or publish state.
- `apim_list_key_value_maps` — list key value maps.
- `apim_get_key_value_map` — read one key value map; encrypted values are redacted.
- `apim_create_key_value_map` — create a key value map; values are write-only.
- `apim_set_key_value_map_entries` — add or change key value map entries; values are write-only.
- `apim_odata_get` — guarded read-only GET for other Management.svc entity sets (for example applications, developers, certificate store references) and the service metadata.

Credentials come from CPI/APIM OAuth client service keys in the MCP host environment (`CPI_SERVICE_KEY`/`APIM_SERVICE_KEY`, explicit `CPI_*`/`APIM_*` variables, or `VCAP_SERVICES`) and are never written to `mcp.json`. Every write requires an exact confirmation string (for example `CREATE IFLOW <iflow_id>` or `UNDEPLOY ARTIFACT <artifact_id>`) and is checked before any network call. Scope is create, update, deploy, and undeploy: there are no delete tools, and deletions stay manual in the Integration Suite UI. Secrets (passwords, client secrets, key value map values) are write-only: tools accept them as input and never return them. Message payloads, attachments, and data-store payloads are never read.
