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

The standalone `sap-ai-integration` companion is not a BAS-proxy child and never destination-prefixed. The implementation enumerates 114 distinct possible tool names; actual `tools/list` is authoritative because each core/optional authority is registered only when configured. Source and target environments require independent, immutable server bindings. `INTEGRATION_ENVIRONMENT` labels reports, never selects credentials or hosts.

Core CPI/APIM/DEVHUB OAuth precedence remains explicit variables → service key → unambiguous VCAP binding → private setup store. Optional cTMS, ANS, Event Mesh, AEM cloud, broker SEMP, Open Connectors and Edge accept independently typed existing credentials only. Configuration, access, activation, entitlement and common-subaccount identity are separate evidence. No startup/read probe provisions services or keys.

Collections return `{items, returned, total, complete, next_cursor, stop_reason}`; grouped artifact/partner kinds have individual pages. Resume with unchanged server/target/filters within 15 minutes. Unknown counts remain null; incomplete sources are not exhaustive, healthy or empty. Generic readers expose implemented safe metadata projectors, not arbitrary discovered entities/functions. Explicit source readers are an authoring boundary, not diagnostic passthrough.

### Cross-component lifecycle

| Tool | Behavior |
|---|---|
| `integration_connection_info` | Full core/optional/native catalog, immutable hosts/label, actual actions, primary contract sources and native handoffs. `verify:true` separates configured core access from optional evidence; 403 does not establish a missing role. |
| `integration_inspect_dependencies` | Explicit bounded targets, private fresh bundle/configuration inspection, literal dependency existence, unresolved references and bundle/configuration-aware state hashes. |
| `integration_check_release_readiness` | Exact target/version/dependency/access evidence and latest matching iFlow validation. Missing aliases, version mismatch, referenced invalid certificates or failed validation block; unreadable/dynamic/stale evidence requires review. |
| `integration_snapshot_content` | Dry-run-first target/host preview; exact approval saves immutable original ZIPs and CPI configuration privately. No caller-selected filesystem path or private content returned. |
| `integration_list_snapshots` | Signed bounded safe snapshot identities/hosts/hashes and explicit integrity findings. |
| `integration_restore_snapshot` | Verify all private files, tenant bindings and fresh expected target state hashes before writes; recheck each target. CPI active draft/configuration only; APIM imports/deploys a new revision. Stop partial, no automatic compensation or transaction/token rollback. |
| `integration_monitoring_readiness` | Actual management/native-rule evidence plus Cloud ALM/ANS setup requirements. Continuous collection and approved synthetic notification delivery remain administrator-unverified until observed. |
| `integration_transport_readiness` | All four package groups, bounded continuations/count evidence, exact versions and iFlow checks in batches of at most 20, matching verified backups and named cTMS node. Incomplete/unchecked sources block; native assembly/upload/import/target verification remain separately approved. |

### Cloud Integration

| Tool | Behavior |
|---|---|
| `cpi_list_packages` / `cpi_list_iflows` | Bounded package/iFlow metadata inventories. |
| `cpi_list_package_artifacts` | Four independently bounded artifact groups; a cursor requires one concrete type. Unverified navigation is explicitly incomplete. |
| `cpi_get_iflow` / `cpi_get_artifact` | Explicit authoring reads of metadata/configuration/bundle files; text files capped at 48 KiB, selected file 90 KiB. Not a payload-reading diagnostic API. |
| `cpi_get_value_mappings` | Explicit authoring values/defaults in nested collection envelopes; at most 20 agency pairs and 500 entries per nested collection, additionally byte-bounded. Unknown counts/traversal remain explicit, never exhaustive samples. |
| `cpi_create_package` / `cpi_update_package` / `cpi_copy_package` | Approved creation/metadata merge or Discover copy/overwrite-merge, with object-specific confirmations. Copy HTTP acceptance is distinct from a returned copied identity; an unverified reply is not replayed. |
| `cpi_create_iflow` | Approved vetted HTTPS → Request Reply → HTTP template or custom BPMN creation. |
| `cpi_update_iflow` | Fresh expected-version draft patch, defaults < configured values < explicit overrides, surviving configuration reapplied. Partial progress explicit; a patch bump does not create a retained version. |
| `cpi_update_iflow_configuration` | Ordered approved parameter writes with safe changed-name/first-failure evidence, no value output. |
| `cpi_upsert_value_mappings` / `cpi_update_script_collection` | Approved updates to existing shared artifacts; deployment remains separate. Native source creation/retained history handoffs are documented. |
| `cpi_save_iflow_version` | Explicit retained SaveAsVersion with current-version/bundle guard, target absence and exact read-back; validate the selected saved version next. |
| `cpi_validate_iflow` | Approved bodyless selected-version validation. HTTP acceptance is not Passed; failed/unknown/latest state-bound evidence supersedes old success. |
| `cpi_deploy_iflow` / `cpi_deploy_artifact` | Approved active/named deployment with separate acceptance/build/task/runtime fields. Old STARTED or unchanged same-version identity cannot prove success. |
| `cpi_get_deployment_task` | Continue original accepted task observation, retaining the runtime baseline; never sends another deploy POST. |
| `cpi_undeploy_artifact` | Exact approved runtime removal with bounded named-absence verification; not design-time deletion. |
| `cpi_list_runtime_artifacts` / `cpi_get_iflow_runtime_status` / `cpi_list_service_endpoints` | Bounded runtime state/version/error/endpoint evidence, not proof that a new deployment or business request succeeded. |
| `cpi_list_message_logs` | Fixed UTC `[from,to)` LogStart window, maximum 31 days; exact iFlow/status/correlation/application/custom-header filtering, frozen default window and best-effort cursor evidence. |
| `cpi_get_message_statistics` | Exact server total/eight status counts, unclassified remainder, partial/inconsistent sources; zero traffic is not a health certification. |
| `cpi_get_message_log` | Named safe MPL metadata, bounded redacted error information and credential-filtered headers; no payloads/attachments. |
| `cpi_list_message_log_runs` / `cpi_get_message_log_steps` | Bounded member-run metadata and latest/explicit run selection frozen across paged steps, including beyond step 200. Missing message differs from no runs. |
| `cpi_trace_message` | Exact propagated nonempty correlation only; no inferred business/APIM cross-product trace or body. |
| `cpi_list_jms_queues` / `cpi_get_jms_queue` | Queue metadata only; numeric/boolean flags preserve unknowns. Positive depth alone is not unhealthy; no consumption/control/retry. |
| `cpi_get_jms_broker_status` | Independent capacity/limit, warning/critical and inactive-queue observations with partial source evidence. |
| `cpi_list_data_stores` / `cpi_list_data_store_entries` / `cpi_list_variables` | Query-free bounded metadata; global scope `integration_flow:""` allowed. Backlog/overdue totals differ from fetched rows; no payloads/variable values or invented MPL links. |
| `cpi_list_security_material` | Safe user/OAuth/certificate identity and deployment metadata; credentials withheld. |
| `cpi_set_user_credential` / `cpi_set_oauth2_client_credential` | Exact approved credential writes; values write-only. OAuth updates preserve omitted optional metadata and withhold upstream failure bodies. |
| `cpi_upload_certificate` | Locally parse PEM X.509 before approved PUT; computed fingerprint differs from authoritative tenant read-back/trust evidence. |
| `cpi_get_certificate_health` | Bounded validity-only assessment at a frozen evaluation time; no subject personal data or trust/connectivity inference. |
| `cpi_get_operational_summary` | Bounded on-demand runtime/message/JMS/store/certificate signals with partial sources. No traffic/ordinary processing/backlog does not become healthy/degraded by inference. |
| `cpi_list_number_ranges` / `cpi_set_number_range` | Read metadata or explicitly approve a named range change. |
| `cpi_list_partner_parameters` / `cpi_set_partner_parameter` | Bounded string/binary metadata reads and separately approved named writes; do not edit TPM-generated data to simulate agreement management. |
| `cpi_odata_get` | Safe implemented metadata roots/navigation/counts or `/$metadata` discovery only; no arbitrary functions, source, trace, payload or secret routes. |

### API Management and Developer Hub

| Tool | Behavior |
|---|---|
| `apim_list_api_providers` / `apim_get_api_provider` | Provider connection metadata with credential properties removed. |
| `apim_create_api_provider` / `apim_update_api_provider` | Approved connection creation/change without backend credentials; credentialed updates and reserved names are refused. |
| `apim_list_api_proxies` / `apim_get_api_proxy` / `apim_list_virtual_hosts` | Bounded metadata and computed runtime URL, preserving base-path separators and virtual-host ports. |
| `apim_export_api_proxy` | Explicit authoring export of bundle files or one selected member. |
| `apim_get_api_proxy_status` / `apim_inspect_api_proxy_security` | Safe observed state and private structural policy/attachment/condition/reference inspection; management/static evidence is not effective security or runtime health. |
| `apim_create_api_proxy` / `apim_update_api_proxy` | Approved import/deploy, optionally secure the first revision; preserve unrelated resources and verify all intended content privately. Acceptance/content read-back/runtime identity remain separate. |
| `apim_attach_api_proxy_policies` | Approved document replacement/missing assignment append, preserving omitted conditions; no implicit reorder/remove. |
| `apim_edit_policy_steps` | Fresh bundle-digest-guarded complete order/conditions for one named endpoint/phase; inventory all references before explicit unreferenced-policy removal. |
| `apim_get_api_documentation` / `apim_update_api_documentation` | Paginated OpenAPI structure or approved HTTPS-runtime-pinned documentation replacement/deploy/read-back, with only established portal normalization. |
| `apim_get_analytics` / `apim_get_analytics_series` / `apim_get_api_error_breakdown` | Separate GA AnalyticsService aggregates/groups, weighted means and watermark for explicit UTC windows. Distinct derived aliases and source-record counts preserve valid empty null sums as no_data; input/group counts are not API calls. No fabricated percentiles/current health. |
| `apim_list_api_products` / `apim_get_api_product` / `apim_create_api_product` / `apim_update_api_product` | Product metadata and approved creation/update; creation fixes proxy membership and publication does not grant OAuth authority. |
| `apim_list_key_value_maps` / `apim_get_key_value_map` / `apim_create_key_value_map` / `apim_set_key_value_map_entries` | Map metadata/entry names and approved writes; values always withheld regardless of encryption representation. |
| `apim_delete_api_product` / `apim_delete_api_proxy` / `apim_cleanup_api_objects` | Dependency-checked named removal or explicit-list dry-run-first cleanup. Deployed proxy removal needs permission; stop failed/unverified, never cascade into consumers/providers/KVMs/credentials. |
| `apim_odata_get` | Implemented safe metadata projections/discovery, not arbitrary APIM administration or payload/source passthrough. |
| `apim_test_api` | GET-only metadata/bounded entity probe, exactly one private API-key source (DEVHUB additionally required) or issuer-pinned named OAuth source (APIM alone). No redirects, arbitrary URLs, credentials or business row values. |
| `devhub_list_developers` / `devhub_create_developer` / `devhub_approve_developer` | Registered developer metadata and separately approved onboarding/approval using Developer Hub authority. |
| `devhub_list_applications` / `devhub_get_application` / `devhub_create_application` / `devhub_subscribe_application` | Safe application/subscription/key-availability metadata and approved consumer provisioning, without bypassing external governance. |
| `devhub_list_subscriptions` | Bounded safe application/product/rate-plan IDs and subscription/approval evidence; legacy/incomplete relations explicit. |
| `devhub_unsubscribe_application` | Exact approved dry-run-first subscription retirement, embedded batch status and fresh false subscription read-back; preserve actual relationship references. |
| `devhub_delete_application` | Private short-lived single-use preview binds owner, both relationship inventories, tenant and active-subscription permission. Revalidate before one DELETE and named absence; no issued-token revocation claim. |

### Separately credentialed optional components

| Tools | Boundary |
|---|---|
| `ctms_list_nodes` | Public `/v2/nodes`, safe id/name local pages; upload/import eligibility remains unknown. No speculative gated upload/import/history adapter. |
| `ans_list_subscriptions` / `ans_list_conditions` / `ans_list_action_metadata` | Native zero-based pages, safe metadata and canonical condition/subscription digests; private condition values/action properties/recipients withheld. |
| `ans_validate_native_rules` | Full referenced-condition/action/fallback resolution and intentional event/node scope; delivery remains unverified. |
| `ans_set_condition` / `ans_set_subscription` | Exact approved condition/subscription writes, fresh update digest or create absence, preserved omitted metadata and intended read-back. No arbitrary action-property writer/all-events subscription. |
| `event_mesh_get_queue` | Exact encoded standalone default-plan named queue management metadata, no consumption/backlog health or Suite-embedded parity. |
| `aem_list_brokers` / `aem_get_broker` / `aem_get_broker_operation` | Fixed US GA cloud metadata, one-based paging/documented expansions/observed states, no broker credentials/Beta/region fallback. |
| `aem_list_queues` | Independent broker-local Basic/session, configured VPN monitor metadata and exact continuations. Unknown counts stay null; 529 means no session slots. |
| `open_connectors_list_instances` / `open_connectors_get_instance` | Instance/element identity only; private pagination tokens, no configuration/provider data. |
| `open_connectors_set_instance_enabled` | Fresh private scoped Element token for approved bodyless PUT/DELETE `/instances/enabled`; disable is not delete, acceptance is not effective state/provider health. |
| `edge_get_api_metadata` / `edge_list_message_logs` / `edge_get_message_log` | Local Basic and preserved `/local` roots; safe discovery/shared MPL evidence. No raw schemas, component-status guesses, restart, shell/Kubernetes or payload access. |

Confirmations are checked before network access but do not replace user approval. [Native lifecycle handoffs](tools.md#native-lifecycle-handoffs) cover Cloud ALM/ANS delivery, cTMS promotion, shared artifact creation/history, CPI queue controls/cancellation/design deletion, native APIM revisions/undeploy, consumer rotation/portal revoke, Suite Event Mesh, TPM, Advisor, Assessment/Migration and new Integration Cell API/MCP artifacts.

Read-only connected verification: `node scripts/check-live-integration.mjs --window-minutes 60 --top 3 --json`. Its GET-only management guard is separate from the mutating `test:live:integration` runner. Missing optional credentials remain `live_unverified`; successful reads are not health, continuous delivery or native promotion proof.


## Separate optional SAP Datasphere server

The standalone `sap-ai-datasphere` companion is not a BAS-proxy child and never destination-prefixed. It exposes 34 distinct possible tool names; actual `tools/list` is authoritative because the two SQL tools register only when a Datasphere database user is configured (`DATASPHERE_SQL_*`). Writes require exact confirmation strings; CLI/REST results are secret-redacted.

Authentication is one Datasphere OAuth client, either **technical** (client credentials) or **interactive** (authorization code + refresh token, stored user-only in `~/.config/sap-ai-dev-toolkit/datasphere.json`). Technical clients may run only `configuration certificates`, `marketplace`, `objects`, `spaces connections` and `tasks` CLI commands; every other command needs interactive auth and is flagged per command by `datasphere_list_commands` (`usable_with_current_auth`).

| Group | Tools | Behavior |
|---|---|---|
| Connection | `datasphere_connection_info` | Tenant/token host, auth mode, credential source, CLI package version, SQL summary, admin availability; optional read-only verification. |
| Consumption | `datasphere_list_spaces`, `datasphere_list_assets`, `datasphere_get_asset_metadata`, `datasphere_query_relational`, `datasphere_query_analytical`, `datasphere_reconcile` | Consumption catalog/relational/analytical reads; parameters become `(Name='value')/Set` segments; reconciliation compares row counts or measure totals with tolerances. |
| Objects | `datasphere_list_objects`, `datasphere_read_object`, `datasphere_create_object`, `datasphere_update_object`, `datasphere_delete_object`, `datasphere_export_package` | CSN lifecycle through the pinned `@sap/datasphere-cli` child runner; updates guarded by `expected_changed_on`; create/update return a read-back. |
| Connections & tasks | `datasphere_list_connections`, `datasphere_validate_connection`, `datasphere_list_task_logs`, `datasphere_get_task_log`, `datasphere_run_task_chain`, `datasphere_retry_task_chain`, `datasphere_cancel_task_chain`, `datasphere_replication_flow` | Connections via CLI; task chains and logs via the Tasks REST API; replication flow actions incl. per-object pause/resume/restart. |
| Data Marketplace | `datasphere_list_data_providers`, `datasphere_list_data_products`, `datasphere_read_data_product`, `datasphere_create_data_product`, `datasphere_set_data_product_status`, `datasphere_install_data_product` | Provider/product discovery, Draft creation from a definition, lifecycle status changes, installation into a space. |
| CSN | `datasphere_build_local_table_csn` | Pure field-list → local-table CSN conversion (BW `/BIC/` stripping, DDIC type mapping, duplicate detection). No tenant call. |
| Generic CLI | `datasphere_list_commands`, `datasphere_describe_command`, `datasphere_run_read_command`, `datasphere_run_command` | Tenant-discovery-driven catalog of every CLI command with exact `--help`; read-only or confirmed execution with managed-option rejection and automatic `--force` for `x-user-to-confirm` operations. |
| Open SQL | `datasphere_sql_query`, `datasphere_sql_execute` | Single-SELECT reads wrapped with `LIMIT` on the configured database user's schema; confirmation-gated single-statement executes (incl. `"DWC_GLOBAL"` data-lake procedures). Grants of the database user are the boundary. |

## Separate optional SAP Build Process Automation server

The standalone `sap-ai-process-automation` companion is not a BAS-proxy child and never destination-prefixed. It exposes 51 tools covering all eight SAP Build Process Automation APIs of the Business Accelerator Hub package (81 operations) plus business events. Authentication is a `process-automation-service` service key, either **technical** (client credentials) or **interactive** (authorization code + refresh token with the same client, stored user-only in `~/.config/sap-ai-dev-toolkit/process-automation.json`). Optional `PROCESS_AUTOMATION_API_KEY` / `PROCESS_AUTOMATION_ENVIRONMENT_ID` (or the optional setup prompts) supply an environment API key and default environment. Writes require exact confirmation strings; results are secret-redacted; asynchronous operations return a `job_id`; exports write to a new local file (0600, never overwritten).

| Group | Tools | Behavior |
|---|---|---|
| Connection | `bpa_connection_info` | API/UAA host, auth mode, credential source, task attribution, API key configured, default environment; optional read-only verification. |
| Workflow definitions | `bpa_list_process_definitions`, `bpa_get_process_definition`, `bpa_delete_process_definition`, `bpa_list_task_definitions`, `bpa_delete_form` | Deployed definitions with model, sample start context and versions; task definitions. Classic definition undeploy (async) `DELETE BPA DEFINITION <definition_id>`; classic form undeploy `DELETE BPA FORM <form_id>`. |
| Instances | `bpa_list_instances`, `bpa_get_instance`, `bpa_find_stuck_instances`, `bpa_trace_process`, `bpa_start_instance`, `bpa_change_instance_status`, `bpa_update_instance_context`, `bpa_update_instance_roles`, `bpa_delete_instances`, `bpa_send_message` | Filtered lists (repeated status = OR); context (capped at 48 KiB or one fragment), outputs, logs, errors, attributes, roles; stuck instances; tracing by id, business key or text. Writes: `START BPA PROCESS <definition_id>`, `<ACTION> BPA INSTANCE <instance_id>` (CANCEL/SUSPEND/RESUME/RETRY, status checked first), `MERGE BPA CONTEXT <instance_id>` / `REPLACE BPA CONTEXT <instance_id>`, `UPDATE BPA ROLES <instance_id>`, `DELETE BPA INSTANCES <count>` (async), `SEND BPA MESSAGE <message_definition_id>` (classic workflows). |
| User tasks | `bpa_list_tasks`, `bpa_get_task`, `bpa_complete_task`, `bpa_update_tasks`, `bpa_update_task_context` | The task queue behind My Inbox / Fiori Task Center; one task with context and attributes. `COMPLETE BPA TASK <task_id>` (open tasks only), `UPDATE BPA TASKS <count>` (async), `UPDATE BPA TASK CONTEXT <task_id>`. |
| Administration / jobs | `bpa_export_workflow_data`, `bpa_purge_workflow_data`, `bpa_get_job` | ZIP export to a new local file; irreversible tenant purge (async) `PURGE ALL BPA WORKFLOW DATA`; async job status. |
| Inbox | `bpa_inbox_list_tasks`, `bpa_inbox_get_task`, `bpa_inbox_list_task_definitions`, `bpa_inbox_task_action`, `bpa_inbox_list_substitution_rules`, `bpa_inbox_create_substitution_rule`, `bpa_inbox_change_substitution_rule` | User-centric TCM OData (`ProcessAutomationParticipant`; technical auth shows the technical client's inbox). `<ACTION> BPA INBOX TASK <instance_id>` (CLAIM/RELEASE/FORWARD), `CREATE BPA SUBSTITUTION FOR <user>`, `<ACTION> BPA SUBSTITUTION <rule_id>` (ENABLE/DISABLE/DELETE). |
| Decisions | `bpa_invoke_decision`, `bpa_test_decision` | Rule-service evaluation and subset-match test cases; no side effects. |
| API triggers (Unified) | `bpa_list_api_triggers`, `bpa_get_api_trigger`, `bpa_execute_api_trigger` | Process API triggers per environment (optional `api-key`); start a process or resume a "Wait for an API Call" step via `execution_id`; `EXECUTE BPA TRIGGER <trigger_uid>`. |
| Automations | `bpa_list_automation_triggers`, `bpa_get_automation_trigger`, `bpa_list_automation_jobs`, `bpa_start_automation`, `bpa_export_automation_data` | Automation Execution/Monitoring with a required environment API key (`TRIGGER_READ`, `TRIGGER_EXECUTE`, `BAM_DOWNLOAD`, `JOB_DATA_DOWNLOAD`); `START BPA AUTOMATION <trigger_uid>`; BAM/archived-job CSV inline or to a new local file. |
| Visibility scenarios | `bpa_list_visibility_scenarios`, `bpa_get_visibility_scenario`, `bpa_process_visibility_scenario`, `bpa_clear_visibility_data`, `bpa_list_visibility_events`, `bpa_push_visibility_events` | Scenario definitions, executions, acquired events and acquisition errors (`PVAdmin`); `PROCESS BPA VISIBILITY <scenario_id>`, `CLEAR BPA VISIBILITY DATA <scenario_id>`; `PUSH BPA VISIBILITY EVENTS <count>` (`PVEventSender`). |
| Visibility workspace | `bpa_list_visibility_workspace_scenarios`, `bpa_list_visibility_instances`, `bpa_get_visibility_instance` | Workspace scenarios, scenario instances with OData options, one instance with phases, paths and steps (`PVOperator`/`PVRestrictedOperator`). |
| Business events | `bpa_send_business_event` | CloudEvents to `/internal/be/v1/events` for event-triggered processes; `SEND BPA EVENT <type>`. |

## Separate optional SAP BTP platform administration server

The standalone `sap-ai-btp` companion is not a BAS-proxy child and never destination-prefixed. It exposes 15 tools over the user's installed SAP BTP CLI and their own `btp login --sso` session; the toolkit stores no credentials (only the CLI location in `~/.config/sap-ai-dev-toolkit/btp.json`, written by `sap-ai-dev --setup-btp`; `BTP_CLI` / `BTP_CLIENTCONFIG` win). Writes are limited to two confirmation-gated creates; results are secret-redacted and service-key credentials are always redacted.

| Group | Tools | Behavior |
|---|---|---|
| Connection | `btp_connection_info` | CLI path and source, config file, acting user; optional `btp --version` and global-account check. |
| Accounts and entitlements | `btp_get_account_hierarchy`, `btp_list_entitlements`, `btp_check_quota` | Directories and subaccounts; entitlements at global-account, directory or subaccount scope; quota verdict `available` / `not_entitled` / `insufficient_quota` / `assignment_not_ready`. |
| Instances and keys | `btp_list_service_instances`, `btp_get_service_instance`, `btp_list_service_keys`, `btp_get_service_key`, `btp_create_service_instance`, `btp_create_service_key` | Service Manager instances with offering/plan names, last operation and keys; redacted parameters and credentials. `CREATE BTP SERVICE INSTANCE <name>` (after a quota check), `CREATE BTP SERVICE KEY <name>`; parameters via a private temporary file. |
| Destinations, trust, Cloud Connectors | `btp_list_destinations`, `btp_get_destination`, `btp_get_trust`, `btp_list_cloud_connectors`, `btp_check_destination` | Destinations without secrets; IdP and destination trust with certificate expiry; Cloud Connectors and exposed systems via a Connectivity `api_access` key; pass/warn/fail/unknown destination and principal-propagation checks. |

## Separate optional SAP Cloud ALM server

The standalone `sap-ai-cloud-alm` companion is not a BAS-proxy child and never destination-prefixed. It exposes 11 tools over the SAP Cloud ALM API (Landscape, Analytics, Raw Data Outbound Logs, Features, Event Situations). Authentication is a service key of a "SAP Cloud ALM API" instance (plan `standard`, client-secret binding) with client credentials only, from `CLOUD_ALM_SERVICE_KEY` / `CLOUD_ALM_URL` + `CLOUD_ALM_TOKEN_URL` + `CLOUD_ALM_CLIENT_ID` + `CLOUD_ALM_CLIENT_SECRET` or stored user-only in `~/.config/sap-ai-dev-toolkit/cloud-alm.json` by `sap-ai-dev --setup-cloud-alm`. All tools are read-only except the confirmation-gated alert close; results are secret-redacted.

| Group | Tools | Behavior |
|---|---|---|
| Connection | `calm_connection_info` | API/token host, auth, credential source; optional read-only Landscape and Analytics verification. |
| Landscape | `calm_list_landscape`, `calm_get_landscape_health` | Landscape objects with LMS id, tenant role, service type, system number and logical systems; exceptions (EXM), critical/warning Health Monitoring metrics and EVENTS alerts for at most 30 services grouped by role tier, each source failing independently. |
| Records and triage | `calm_list_monitoring_records`, `calm_triage_incident` | Raw OTLP records for `im`, `exm.im`, `exm.jam`, `iep`, `jam.run`, `bsm` (60-minute windows, `bsm` up to 31 days, `next_offset` paging); per-service triage with alert counts, events, errors, messages and `cpi_list_message_logs` / `get_application_log` handoff arguments. |
| Analytics | `calm_list_analytics_providers`, `calm_describe_analytics_provider`, `calm_query_analytics` | Authorized providers, provider fields and attribute values, one query summed/maxed per dimension combination or raw. |
| Features | `calm_list_features`, `calm_get_feature` | Feature lifecycle status with transport ids; one feature by UUID or display id, or the features linked to a transport id. No per-system import status. |
| Event situations | `calm_close_event_situation` | Close an alert by id or external id (mapped tickets closed unless `notify_ticketing: false`); `CLOSE CALM EVENT SITUATION <event_situation_id>` or `CLOSE CALM EVENT SITUATION BY EXTERNAL ID <external_id>`. |

## Separate optional SAP Integration Suite, advanced event mesh server

The standalone `sap-ai-aem` companion (native Rust executable behind a Node shim) is not a BAS-proxy child and never destination-prefixed. It exposes 29 tools over the advanced event mesh Cloud API (Mission Control, Event Portal) and broker SEMP v2, with a Cloud API token from `AEM_API_TOKEN` / `AEM_CONFIG` and/or explicit `AEM_SEMP_*` / `AEM_SEMP_CONFIG` broker credentials, or stored user-only in `~/.config/sap-ai-dev-toolkit/aem.json` by `sap-ai-dev --setup-aem`. Every write is confirmation-gated; results are secret-redacted.

| Group | Tools | Behavior |
|---|---|---|
| Connection | `aem_connection_info` | Cloud API and SEMP hosts, VPN and credential sources; optional online verification. |
| Mission Control | `aem_list_services`, `aem_get_service`, `aem_list_service_classes`, `aem_list_datacenters`, `aem_list_broker_versions`, `aem_create_service`, `aem_update_service`, `aem_resize_message_spool`, `aem_get_upgrade_status`, `aem_upgrade_service`, `aem_delete_service`, `aem_list_operations`, `aem_get_operation` | Broker service lifecycle with asynchronous operations polled to SUCCEEDED/FAILED; locked services cannot be deleted; no service-class change in the public API. |
| SEMP v2 | `aem_semp_list_objects`, `aem_semp_get_object`, `aem_semp_create_object`, `aem_semp_update_object`, `aem_semp_delete_object`, `aem_semp_monitor`, `aem_semp_action` | Config CRUD for queues, subscriptions, topic endpoints, client usernames, client/ACL profiles and exceptions, REST delivery points, bridges and replay logs; monitor reads; actions. `service_id` resolves SEMP credentials from the Cloud API. |
| Event Portal | `aem_portal_list`, `aem_portal_get`, `aem_portal_create`, `aem_portal_update`, `aem_portal_delete`, `aem_portal_set_version_state`, `aem_portal_associate_messaging_services`, `aem_portal_export_asyncapi` | Application domains, applications, events, schemas and their versions; version states; messaging-service association; AsyncAPI export. |

## Separate optional SAP GUI for HTML (WebGUI) server

The standalone `sap-ai-webgui` companion (native Rust executable behind a Node shim) is not a BAS-proxy child and never destination-prefixed. It drives SAP GUI for HTML read-only in the user's Chrome (relay extension) or a managed headless browser, with settings from `~/.config/sap-ai-dev-toolkit/webgui.json` (`sap-ai-dev --setup-webgui`) or the host environment.

| Group | Tools | Behavior |
|---|---|---|
| Connection | `webgui_connection_info`, `webgui_open`, `webgui_close` | Settings and relay pairing state; open or reuse a session (logon form, Logon Status Check without cancelling other logons); `/nex` logoff and browser/tab release. |
| Screens | `webgui_screen`, `webgui_start_transaction`, `webgui_set_fields`, `webgui_press`, `webgui_table`, `webgui_screenshot` | Compact screen model keyed by SAP GUI Scripting ids; guarded navigation, field input, buttons, function keys and OK codes; ABAP list paging; PNG screenshots. |
| Recipes | `webgui_list_recipes`, `webgui_run_recipe` | SM37 jobs, ST22 dumps, SU53 authorization check, SU01D user, SE16N table, AL11 directories, SM12 locks, each step screen-guarded. |
