# SAP AI Dev Toolkit Tool Inventory

This inventory reflects the current SAP AI Dev Toolkit proxy behavior in `src/mcp-proxy.mjs`. The proxy exposes a curated upstream tool allowlist plus destination-scoped local workflows; it does not expose every tool registered by the SAP runtime. The live MCP `tools/list` response remains authoritative because capabilities vary by runtime mode and SAP system.

## Summary

| Status | Count | Notes |
| --- | ---: | --- |
| Upstream tools | Up to 64 | Curated from the child tool list and exposed in lowercase snake_case, unprefixed (`get_source`) on single-destination servers; a destination slug prefix (`demo-abap_get_source`) appears only when one server fronts multiple destinations. |
| Local lint tool | 1 per destination | `LintABAP` analyzes caller-supplied ABAP source in memory; it is exposed publicly as `lint_abap`. |
| Workflow tools | Up to 8 per destination | Review/apply change sets, transport evidence, Clean Core release assessment, RAP regression suites, guarded table updates, and empty-DDLS cleanup. Some require upstream capabilities. |
| Convenience mapping | Dynamic | `GetApplicationLog` maps to the upstream `SAP(action="analyze", type="application_log")` operation when the SAP router is registered. |
| Intentionally filtered tools | Dynamic | Destructive, broad-router, trace, and unsupported operations are hidden from direct calls. |
| Mode-dependent | Dynamic | Focused/expert mode and backend capabilities determine which tools are registered. |

The maximum fixture surface is 74 destination-scoped tools per destination when expert-mode capabilities and all local workflows are available, plus one workspace-scoped `LintABAPProject` tool per MCP server. Multiple selected destinations create separate MCP servers; this add-on cannot inspect VS Code's aggregate tool budget or per-chat tool binding.

## Known upstream tools

These names are known from fixtures, README, and historical upstream inventories. They are not a statement that the proxy exposes them; only the curated list in [tools.md](tools.md) is public through the proxy. Names absent from that allowlist are filtered even when the runtime registers them.

### Baseline/source inspection

- `GetSource`
- `SearchObject`
- `GrepObjects`
- `GrepPackages`
- `FindDefinition`
- `FindReferences`
- `GetContext`
- `CompareSource`
- `GetClassInfo`
- `GetPackage`
- `GetFunctionGroup`
- `GetMessages`
- `GetInactiveObjects`
- `GetAPIReleaseState`

### Data, CDS, and metadata

- `GetTable`
- `GetTableContents`
- `RunQuery`
- `GetCDSDependencies`
- `GetCDSImpactAnalysis`
- `GetCDSElementInfo`
- `GetFeatures`
- `GetSystemInfo`
- `GetInstalledComponents`

### Create, update, activate, and quality

- `WriteSource`
- `EditSource`
- `CreatePackage`
- `CreateTable`
- `SyntaxCheck`
- `Activate`
- `ActivateMultiple`
- `ActivatePackage`
- `PrettyPrint`
- `RunUnitTests`
- `RunATCCheck`

### Transport tools

- `GetTransport`
- `GetTransportInfo`
- `GetUserTransports`
- `ListTransports`
- `CreateTransport`
- `ReleaseTransport`
- `DeleteTransport`

### Additional analysis, help, and call graph tools

- `AnalyzeABAPCode`
- `AnalyzeCallGraph`
- `CodeCompletion`
- `GetAbapHelp`
- `GetCallGraph`
- `GetCalleesOf`
- `GetCallersOf`
- `GetCodeCoverage`
- `GetConnectionInfo`
- `GetObjectStructure`
- `GetTypeHierarchy`
- `GetTypeInfo`
- `GrepObject`
- `GrepPackage`
- `CallRFC`

### Debugging, dumps, breakpoints, and trace

- `DebuggerAttach`
- `DebuggerDetach`
- `DebuggerGetStack`
- `DebuggerGetVariables`
- `DebuggerListen`
- `DebuggerStep`
- `DeleteBreakpoint`
- `GetBreakpoints`
- `GetDump`
- `GetSQLTraceState`
- `GetTrace`
- `ListDumps`
- `SetBreakpoint`
- `ListSQLTraces`

### Object, source, dependency, and service operations

- `CloneObject`
- `CreateAndActivateProgram`
- `CreateClassWithTests`
- `CreateObject`
- `CreateTestInclude`
- `DeleteObject`
- `ExecuteABAP`
- `GetClass`
- `GetClassComponents`
- `GetClassInclude`
- `GetFunction`
- `GetInclude`
- `GetInterface`
- `GetProgram`
- `GetStructure`
- `GetTransaction`
- `LockObject`
- `MoveObject`
- `RecoverFailedCreate`
- `RenameObject`
- `SaveToFile`
- `UnlockObject`
- `UpdateClassInclude`
- `UpdateSource`
- `WriteClass`
- `WriteProgram`
- `ListDependencies`
- `PublishServiceBinding`
- `UnpublishServiceBinding`

### UI5 ABAP repository

- `UI5ListApps`
- `UI5GetApp`
- `UI5GetFileContent`
- `UI5UploadFile`
- `UI5DeleteFile`
- `UI5CreateApp`
- `UI5DeleteApp`

### General SAP router

- `SAP`

## Enabled add-on/local tools

- `LintABAP` — local add-on tool; lints caller-supplied ABAP source without contacting SAP.
- `GetApplicationLog` — add-on convenience tool mapped to the upstream `SAP` operation with `action="analyze"` and `type="application_log"`.

These logical names are exposed through MCP in lowercase snake_case (`lint_abap`, `get_application_log`) because BAS/VS Code chat tool references bind only lowercase identifiers.

## Destination workflow tools

- `PrepareABAPChangeSet` — stage full-source `WriteSource` changes and return review diffs and source fingerprints.
- `ApplyABAPChangeSet` — re-read staged objects before writing and report conflicts or partial application.
- `CheckTransportReadiness` — collect selected transport, dependency, inactive-object, ABAP Unit, and ATC evidence.
- `PlanABAPCloudMigration` — batch-check API release state for supplied ADT object URIs and prioritize recognized unreleased APIs.
- `GenerateRAPRegressionSuite` — read service metadata and emit reusable GET-only smoke cases for entity sets.
- `RunRAPRegressionSuite` — execute saved cases with status, content-type, and JSON-path assertions over the connected destination.
- `UpdateTable` — compare the current DDL with the reviewed source, then update and activate one Z/Y table using VSP's locked source-hash check.
- `DeleteEmptyDDLS` — delete only a blank Z/Y DDLS source after exact confirmation; generic `DeleteObject` remains hidden.

## Notes

- Runtime tool names are unprefixed lowercase snake_case (`run_query`) on the normal single-destination server; a `<destination-slug>_` prefix appears only on multi-destination servers. `tools/call` accepts the exact name returned by `tools/list`.
- The proxy starts the SAP runtime with `--enable-transports`; generated MCP entries set `SAP_ALLOW_TRANSPORTABLE_EDITS=true`.
- The curated upstream tool surface and enabled transport mode are the same for every destination; SAP authorization remains authoritative.
- `SAP_AI_DEV_TOOLKIT_REQUEST_TIMEOUT_MS` (default 600000) bounds each forwarded call; stalled requests fail without killing the child.
- Transport release/deletion, UI5 repository writes (the ADT filestore is read-only), and the general-purpose `SAP` router are intentionally hidden from direct proxy calls. `GetApplicationLog` is the bounded convenience mapping for the SAP application-log route.

## Separate optional HANA Cloud inspector

The HANA inspector is a standalone companion MCP process launched as `sap-ai-hana`; it is not a child of the SAP runtime and is not destination-prefixed. It uses a read-only identity selected from `HANA_RO_*` variables or one unambiguous `VCAP_SERVICES` binding. Its host/schema target is fixed by process configuration; tool arguments cannot change it.

| Tool | Behavior |
| --- | --- |
| `hana_connection_info` | Report selected endpoint, service/binding name, configured and current schema, database user, and TLS validation state. Does not return credentials. |
| `hana_list_objects` | List tables and/or views in the configured schema, capped at 200 objects. |
| `hana_describe_object` | Return columns for a table or view verified in the configured schema. |
| `hana_read_rows` | Read selected catalog-verified columns with bound filter values and a hard 200-row maximum; credential-like columns are blocked. No free-form SQL. |

The process exposes no DDL, DML, arbitrary SQL, procedure-call, deployment, undeploy, grant, or service-key management tools. The separate HANA identity should also be granted only the reads required for the intended HDI container.

## Separate optional Integration Suite server

The Integration Suite companion is a standalone MCP process launched as `sap-ai-integration`; it is not a child of the SAP runtime and is not destination-prefixed. CPI and APIM OAuth clients come from `CPI_*`/`APIM_*` variables, `CPI_SERVICE_KEY`/`APIM_SERVICE_KEY`, one unambiguous `VCAP_SERVICES` binding per side, or (lowest precedence) a key pasted, verified online and saved user-only by `sap-ai-dev --setup-integration` in `~/.config/sap-ai-dev-toolkit/integration-suite.json`. Requests are pinned to the configured tenant origins. `cpi_*` tools are registered only when CPI is configured, `apim_*` tools only when APIM is configured. `sap-ai-integration --check` runs the same online verification from a terminal.

| Tool | Behavior |
| --- | --- |
| `integration_connection_info` | Report configured sides, credential source, binding, and tenant/token hosts. `verify: true` signs in and runs one read-only request per tool area, classifying each as ok, forbidden (missing role) or unavailable. Never returns client ids or secrets. |
| `cpi_list_packages` | List packages (max 200). |
| `cpi_list_iflows` | List iFlows of a package. |
| `cpi_get_iflow` | Artifact metadata, configurations, and bundle files (text capped 48 KiB each, or one file up to 90 KiB). |
| `cpi_get_iflow_runtime_status` | Runtime status; error text when `ERROR`. |
| `cpi_list_service_endpoints` | Deployed endpoint URLs, optionally for one iFlow. |
| `cpi_list_message_logs` | Message processing logs filtered by iFlow, status, time window, `correlation_id`, `application_message_id`, or `custom_header` (max 100). |
| `cpi_get_message_log` | One log with error text and custom header properties; attachments are not read. |
| `cpi_get_message_log_steps` | Steps of the latest run (sorted by start, max 200) with step errors. |
| `cpi_list_package_artifacts` | iFlows, value mappings, script collections, and message mappings of one package. |
| `cpi_get_artifact` | Value mapping, script collection, or message mapping metadata plus bundle files (same caps as `cpi_get_iflow`). |
| `cpi_get_value_mappings` | Agency pairs with values and defaults (max 500 values per pair). |
| `cpi_list_runtime_artifacts` | Deployed artifacts, optionally by status. |
| `cpi_get_jms_broker_status` | JMS broker capacity and non-OK queues. |
| `cpi_list_data_stores` / `cpi_list_data_store_entries` / `cpi_list_variables` | Data store, entry, and variable metadata; payloads are not read. |
| `cpi_list_security_material` | User credentials, OAuth2 client credentials, or keystore entries; secret fields redacted. |
| `cpi_list_number_ranges` | Number ranges. |
| `cpi_list_partner_parameters` | Partner Directory string parameters and binary parameter metadata. |
| `cpi_odata_get` | Read-only GET for other `/api/v1` entity sets or `/$metadata`; `$value`, `$batch`, and `$links` rejected; secrets and artifact content redacted. |
| `cpi_create_package` | Create a package. Confirmation `CREATE CPI PACKAGE <package_id>`. |
| `cpi_create_iflow` | Create an iFlow from the `https-request-reply-http` template or custom BPMN. Confirmation `CREATE IFLOW <iflow_id>`. |
| `cpi_update_iflow` | Replace/add files and parameters with an `expected_version` check and patch bump; never deletes files. Confirmation `UPDATE IFLOW <iflow_id>`. |
| `cpi_update_iflow_configuration` | Set externalized parameters sequentially. Confirmation `CONFIGURE IFLOW <iflow_id>`. |
| `cpi_deploy_iflow` | Deploy and wait up to 50 s (below common MCP client timeouts) for build/runtime status; `timed_out` means poll `cpi_get_iflow_runtime_status`. Confirmation `DEPLOY IFLOW <iflow_id>`. |
| `cpi_deploy_artifact` | Deploy a value mapping, script collection, or message mapping and wait up to 50 s for runtime status. Confirmation `DEPLOY ARTIFACT <artifact_id>`. |
| `cpi_undeploy_artifact` | Undeploy a runtime artifact and wait up to 50 s until it is gone. Confirmation `UNDEPLOY ARTIFACT <artifact_id>`. |
| `cpi_update_package` | Merge name, short text, description, or version into a package. Confirmation `UPDATE CPI PACKAGE <package_id>`. |
| `cpi_copy_package` | Copy a Discover package (`CREATE_COPY` with suffix or `OVERWRITE_MERGE`). Confirmation `COPY CPI PACKAGE <package_id>`. |
| `cpi_upsert_value_mappings` | Upsert value pairs sequentially, stopping at the first failure; deploy afterwards. Confirmation `UPDATE VALUE MAPPING <artifact_id>`. |
| `cpi_update_script_collection` | Add/replace scripts in the collection bundle. Confirmation `UPDATE SCRIPT COLLECTION <artifact_id>`. |
| `cpi_set_user_credential` | Create or update a user credential; password write-only. Confirmation `SET USER CREDENTIAL <name>`. |
| `cpi_set_oauth2_client_credential` | Create or update an OAuth2 client credential; secret write-only. Confirmation `SET OAUTH2 CLIENT CREDENTIAL <name>`. |
| `cpi_upload_certificate` | Add (or with `update` replace) a PEM certificate in the system keystore. Confirmation `UPLOAD CERTIFICATE <alias>`. |
| `cpi_set_number_range` | Create or update a number range. Confirmation `SET NUMBER RANGE <name>`. |
| `cpi_set_partner_parameter` | Create or update a Partner Directory string or binary parameter. Confirmation `SET PARTNER PARAMETER <pid>/<id>`. |
| `apim_list_api_providers` | List providers without credential fields. |
| `apim_get_api_provider` | One provider with credential properties removed. |
| `apim_list_api_proxies` | List proxies. |
| `apim_get_api_proxy` | One proxy with endpoints, virtual hosts, deployment info, and computed `runtime_url`. |
| `apim_list_virtual_hosts` | List virtual hosts. |
| `apim_export_api_proxy` | Export the proxy bundle and return its files (or one file). |
| `apim_list_api_products` / `apim_get_api_product` | Products; one product with its proxy names. |
| `apim_list_key_value_maps` / `apim_get_key_value_map` | Key value maps; encrypted values redacted. |
| `apim_odata_get` | Read-only GET for other Management.svc entity sets (applications, developers, certificate store references) or `/$metadata`; same guards as `cpi_odata_get`. |
| `apim_create_api_provider` | Create an Internet or On-Premise provider; no credentials sent; reserved names rejected. Confirmation `CREATE API PROVIDER <name>`. |
| `apim_update_api_provider` | Merge connection changes into a credential-free provider (credentialed providers are refused). Confirmation `UPDATE API PROVIDER <name>`. |
| `apim_create_api_proxy` | Import (and deploy) a policy-free proxy for a provider or https URL target. Confirmation `CREATE API PROXY <name>`. |
| `apim_update_api_proxy` | Export, patch base path/target/title/description in place, and re-import; policies, steps, and scripts are preserved. Confirmation `UPDATE API PROXY <name>`. |
| `apim_attach_api_proxy_policies` | Add or replace up to 10 policies from templates or custom XML and their flow steps, then re-import. Confirmation `UPDATE API PROXY POLICIES <name>`. |
| `apim_create_api_product` | Create (and by default publish) a product over existing proxies with optional quota. Confirmation `CREATE API PRODUCT <name>`. |
| `apim_update_api_product` | Merge title, description, scope, quota, or publish state. Confirmation `UPDATE API PRODUCT <name>`. |
| `apim_create_key_value_map` | Create a map (encrypted by default); values write-only. Confirmation `CREATE KEY VALUE MAP <name>`. |
| `apim_set_key_value_map_entries` | Update existing entries and add new ones, stopping at the first failure; values write-only. Confirmation `UPDATE KEY VALUE MAP <name>`. |

Confirmations are checked before any network call. The process exposes no delete tools. Secrets are write-only and never returned; message payloads, attachments, and data-store payloads are never read.
