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

The `integration-suite` companion starts `sap-ai-integration` as a separate stdio MCP server. It does not use the BAS proxy or a destination prefix. Operational tools appear only for their own configured component; optional setup accepts existing credentials and never provisions a service or retargets Cloud Foundry.

- `integration_connection_info` — always exposes the full core/optional/native component catalog, immutable tenant bindings, actual registered actions, public-contract/source/setup evidence, and distinct core/optional verification results. Missing configuration, denied access, inaccessible contracts and unknown entitlement remain separate.

Collection tools return `{items, returned, total, complete, next_cursor, stop_reason}`. Follow `next_cursor` with the same target and filters; cursors are private-runtime-bound, expire after 15 minutes, and stop working after a server restart. Default pages are 100/max 200, except MPL (20/100) and runtime artifacts (200/500). `total` is a server count or `null`, never a sampled page length. `complete` means verified traversal end, not a transactional snapshot. `output_limit`, `source_limit`, `source_changed`, `paging_unsupported` and `deadline` retain incomplete evidence; do not interpret them as empty/healthy. Package/Partner Directory cursors require one concrete artifact/parameter type.

Capability `ok` means configured core access only. Per-capability results distinguish `ok`, `unauthenticated`, `forbidden`, `unavailable`, `untested` and `error`. A 403 proves access denial, not which role is missing; 404/501 describe the endpoint, not entitlement. Entitlement stays unknown without authoritative account evidence. Generic OData readers use implemented metadata-only route projectors; `/$metadata` discovery does not authorize new raw-data roots or function imports.

Optional host/setup JSON overrides only its corresponding stored record; malformed supplied input disables that adapter with a safe configuration finding, never falls back to unrelated credentials or breaks usable core clients. Stored records contain exactly these normalized fields:

| Host input / stored key | Normalized fields | Authentication boundary |
| --- | --- | --- |
| `CTMS_SERVICE_KEY` / `ctms` | `url, tokenUrl, clientId, clientSecret` | Normalize raw `uri`/`uaa` at setup/environment only; cTMS OAuth token suffix normalization is specific to cTMS. |
| `ANS_CONFIG` / `ans` | `url, username, password` | Technical-client Basic; configuration read and separately authorized write permissions. |
| `EVENT_MESH_CONFIG` / `event_mesh` | `url, tokenUrl, clientId, clientSecret, probeQueueName?` | Management OAuth; preserve the binding's exact token endpoint. No queue probe means untested, not non-entitlement. |
| `AEM_CONFIG` / `aem` | `apiToken` | Static bearer at fixed `https://api.solace.cloud`; cloud read permission `services:view`. |
| `AEM_SEMP_CONFIG` / `aem_semp` | `url, msgVpnName, username, password` | Separate broker-local Basic, VPN-scoped read-only management user; private session reuse. |
| `OPEN_CONNECTORS_CONFIG` / `open_connectors` | `url, userSecret, organizationSecret` | Base includes `/elements/api-v2`; private User/Organization authorization, not CPI OAuth. |
| `EDGE_CONFIG` / `edge` | `url, clientId, clientSecret` | Local service-key Basic at the API virtual-host origin, preserving `/local`; not cloud OAuth. |

Use HTTPS without URL credentials/query/fragment. Loopback HTTP is fixture-only. Hidden `--setup-integration` input and the 0600 credential store accept normalized optional records; secrets never belong in tool-call setup arguments or `mcp.json`. `INTEGRATION_ENVIRONMENT` is a non-secret immutable report label (`default` otherwise), not tenant authority or a mutable global switch. Use independently configured server instances for different environments. Common-subaccount identity and activation/entitlement stay unverified without authoritative account evidence.

Cloud Integration — design time:

- `cpi_list_packages` — list Cloud Integration packages.
- `cpi_list_iflows` — list the iFlows of one package.
- `cpi_list_package_artifacts` — list a package's iFlows, value mappings, script collections, and message mappings.
- `cpi_get_iflow` — read iFlow metadata, externalized configuration, and bundle files (or one file by path).
- `cpi_get_artifact` — read a value mapping, script collection, or message mapping with its bundle files.
- `cpi_get_value_mappings` — explicit authoring read; `agency_pairs` and each pair's `values` / `default_values` use collection envelopes (`items`, `returned`, `total`, `complete`, `next_cursor`, `stop_reason`). At most 20 pairs and 500 entries per nested collection, additionally byte-bounded. Missing counts remain null; unverified traversal stops with `source_limit`, without invented continuations.
- `cpi_create_package` — create a package.
- `cpi_update_package` — change package name, short text, description, or version.
- `cpi_copy_package` — copy a Discover package into Design (new copy with suffix, or overwrite-merge keeping configuration). `accepted` / `http_status` distinguish HTTP acceptance from `copied`; an unusable accepted response returns `copied:false,outcome:"unverified"` and must not trigger an automatic repeat POST.
- `cpi_create_iflow` — create an iFlow from the vetted HTTPS → Request Reply → HTTP template or caller-supplied BPMN.
- `cpi_update_iflow` — expected-version draft replacement, merging bundled defaults < fresh configured values < explicit overrides, then reapplying surviving tenant configuration. Reports exact partial progress; `new_version` is the resulting draft-bundle version and `retained_version_created:false`.
- `cpi_update_iflow_configuration` — ordered configuration writes with updated names and safe first-failure evidence, not private values.
- `cpi_save_iflow_version` — save the approved current draft as an explicit retained version, checking current version/bundle hash and target absence before one bodyless SaveAsVersion POST. Requires `SAVE IFLOW VERSION <id> <version>`; no hidden upload or repeated POST.
- `cpi_validate_iflow` — exact selected-version validation, requiring `VALIDATE IFLOW <id> VERSION <version>`. HTTP 202 is acceptance, not business success: `Passed`, `Failed`, and unknown results remain distinct. The latest completed result replaces older evidence for 15 minutes; readiness requires matching successful content/configuration state. Save a version before validating that selected saved version.
- `integration_snapshot_content` — dry-run-first exact-target/host preview and `SNAPSHOT INTEGRATION CONTENT <SHA256>` approval; immutable original ZIP/configuration capture under the private credential directory. No source/configuration values or caller-selected filesystem paths returned.
- `integration_list_snapshots` — bounded safe inventory with integrity findings. Directories are 0700/files 0600; archives are bounded to 20 MiB compressed/member, 100 MiB actual expansion and 2,000 members; snapshot total is 100 MiB.
- `integration_restore_snapshot` — preview complete effects/current state hashes, then require every expected target state and `RESTORE INTEGRATION SNAPSHOT <SHA256>`. Rechecks all targets before any write and each before its write; CPI restores only active draft/configuration, with deployment separate. APIM import replaces draft and deploys a new revision. Stops on partial failure without automatic compensation.

Snapshot restoration does not reverse processed messages, datastores, security material, issued tokens or receiver transactions. Retained CPI rollback is exact-version deployment. APIM retained Revert → Deploy and standalone Undeploy remain native actions, not ZIP-import aliases.
- `cpi_upsert_value_mappings` — add or change value-mapping pairs.
- `cpi_update_script_collection` — add or replace scripts in a script collection.

Cloud Integration — deployment and monitoring:

- `cpi_deploy_iflow` / `cpi_deploy_artifact` — deploy selected `active` or retained `x.y.z`, preserving build/task and runtime evidence separately. Outcomes are `pending`, `succeeded`, `failed` or `unverified`; old `STARTED` cannot prove the new deployment, and same-version redeploy needs fresh deployment identity. `wait_seconds:0` initiates once without post-polling.
- `cpi_get_deployment_task` — continue observing an accepted task without another deploy POST, retaining the original same-runtime baseline. Unknown build states, license failure and absent freshness proof remain explicit.
- `cpi_undeploy_artifact` — undeploy any runtime artifact and wait until it is gone.
- `cpi_list_runtime_artifacts` — list deployed artifacts, optionally by status.
- `cpi_get_iflow_runtime_status` — read deployed runtime status, including error text when the iFlow failed to start.
- `cpi_list_service_endpoints` — list deployed endpoint URLs, optionally for one iFlow.
- `cpi_list_message_logs` — bounded `[from,to)` UTC `LogStart` listing, preserving milliseconds and processing records without `LogEnd`. Supply both timestamps or neither (a frozen last-24-hour window); maximum 31 days. Correlation/application/custom-header filters are exact. Mutable lists report best-effort consistency and detect observed count/ID drift.
- `cpi_get_message_statistics` — explicit-window tenant counts and eight status counts, unclassified remainder, source failures and completeness; never derives totals from sampled lists. Zero traffic is not a health sign-off.
- `cpi_get_message_log` — allowlisted message/error metadata; no payload attachments.
- `cpi_list_message_log_runs` — bounded run identity/state metadata.
- `cpi_get_message_log_steps` — latest or explicitly selected member run, with bounded errors and paged steps. Missing message and no runs are distinct; continue the cursor to inspect steps beyond 200.
- `cpi_trace_message` — exact nonempty propagated correlation only; without one, returns the seed rather than guessing a business identifier or APIM relationship.
- `cpi_list_jms_queues` / `cpi_get_jms_queue` — safe queue metadata only; no message consumption. Positive depth alone is informational; missing/unrecognized flags stay unknown.
- `cpi_get_jms_broker_status` — separate capacity/limit, warning/critical and inactive-queue observations with independent source failures.
- `cpi_list_data_stores` / `cpi_list_data_store_entries` — query-free local metadata pages; `integration_flow: ""` addresses global stores. Store-reported backlog/overdue totals remain distinct from fetched entries; unresolved MessageIds do not establish MPL links.
- `cpi_list_variables` — bounded metadata with exact iFlow/visibility filtering; no values.

Cloud Integration — security material and tenant configuration:

- `cpi_list_security_material` — list user credentials, OAuth2 client credentials, or keystore entries with secret fields redacted.
- `cpi_set_user_credential` — create or update a user credential; the password is write-only.
- `cpi_set_oauth2_client_credential` — create or update an OAuth2 client credential; the client secret is write-only. Omitted optional metadata is preserved on update; upstream failure bodies are withheld, including escaped reflected secrets.
- `cpi_upload_certificate` — locally parse a PEM X.509 certificate and report its computed SHA-256 fingerprint before the approved PUT. Tenant fingerprint/read-back verification remains distinct; an unrelated HTTP 400 is not translated into an alias collision.
- `cpi_get_certificate_health` — bounded validity-only assessment (`valid`, `expiring`, `expired`, `not_yet_valid`, `unknown`), frozen evaluation time and explicit warning interval. No subject personal data, trust-chain or connectivity claim.
- `cpi_get_operational_summary` — bounded on-demand runtime/message/JMS/store/certificate snapshot. Health is `no_issues_observed`, `degraded` or `unknown` within observed management signals only. Ordinary positive queue depth/processing is informational; zero traffic or inaccessible required sources is unknown unless an observed issue establishes degradation.
- `integration_inspect_dependencies` — explicit-target private bundle/configuration inspection, literal alias/provider/KVM/certificate existence, unresolved dynamic/shared/custom dependencies, and configuration-aware digests. Values/source stay private.
- `integration_check_release_readiness` — exact target/version/dependency/deployment-access evidence and latest state-matching iFlow validation. Missing required dependencies, version mismatch, referenced invalid certificates or latest failed validation block; missing/stale/unknown validation and unreadable/dynamic evidence require review. Unrelated expired inventory certificates do not block a release.
- `cpi_list_number_ranges` — list number ranges.
- `cpi_set_number_range` — create or update a number range.
- `cpi_list_partner_parameters` — list Partner Directory string parameters and binary parameter metadata.
- `cpi_set_partner_parameter` — create or update a Partner Directory string or binary parameter.
- `cpi_odata_get` — allowlisted operational metadata and service discovery only; discovered roots without safe projectors are not authorized for raw data access.

API Management:

- `apim_list_api_providers` — list API providers without credential fields.
- `apim_get_api_provider` — read one API provider with credential properties removed.
- `apim_create_api_provider` — create an Internet or On-Premise (Cloud Connector) API provider without credentials.
- `apim_update_api_provider` — change host, port, type, location, path prefix, or sap-client of a credential-free provider.
- `apim_list_api_proxies` — list API proxies.
- `apim_get_api_proxy` — read one API proxy with endpoints, virtual hosts, and the computed runtime URL.
- `apim_export_api_proxy` — export an API proxy bundle and return its files (policies, endpoints, scripts).
- `apim_get_api_proxy_status` — safe observed state/version/deployment metadata and sanitized runtime URL; management state does not establish runtime health.
- `apim_inspect_api_proxy_security` — private structural bundle inspection: registrations, endpoint/flow/phase attachments, condition presence, literal dependency aliases and unresolved/custom behavior. No source returned; static evidence does not prove effective authentication, rate limiting or certificate trust.
- `apim_get_analytics` — separate public AnalyticsService V4 server aggregates over explicit UTC `[from,to)` (at most 31 days): calls/errors, policy/target errors, weighted response-time means and source watermark. Derived aliases do not collide with entity fields. `source_records` counts analytics input records, not API calls; authoritative zero records distinguish empty null sums (`no_data`) from partial metrics. Analytics lag and unverified instantaneous health remain explicit.
- `apim_get_analytics_series` / `apim_get_api_error_breakdown` — bounded server-grouped pages (at most 200 rows; at most 1,000 requested time buckets). Group counts are not total API calls. No raw request URLs, developer details, p95 or p99 are fabricated.

Inspection/release preconditions use deterministic SHA-256 identities. `bundle_sha256` binds UTF-8-sorted member paths and bytes with unsigned 32-bit big-endian length prefixes, independent of ZIP timestamps/compression/order. `state_sha256` additionally binds fresh CPI configured parameter values/types; reports expose names and hashes, never those private values.
- `apim_list_virtual_hosts` — list virtual hosts.
- `apim_get_api_documentation` — inspect registered OpenAPI metadata, security schemes and a paginated operation inventory (100 operations per page); select one `path`/`method` pair for structural parameter, content-type and response details. Operation parameters override matching path parameters; OpenAPI 2 `consumes` is inherited unless overridden.
- `apim_update_api_documentation` — replace registered English documentation with self-contained OpenAPI 2.0/3.0/3.1 JSON (maximum 1 MiB), pinned to the proxy's public HTTPS runtime URL. Requires `UPDATE API DOCUMENTATION <name>`; preserves routing, authentication and other bundle resources, redeploys, and compares decoded readback with the submitted definition.

Documentation readback permits only the observed portal metadata synchronization and semantically equivalent description whitespace/HTML entities, reported through `read_back_normalized`; paths, schemas, security, examples and runtime destinations are not ignored.

- `apim_create_api_proxy` — import (and thereby deploy) an API proxy for a provider or https URL target, optionally including up to 10 policies before its first deployment.
- `apim_update_api_proxy` — change base path, target, title, or description; existing policies and steps are kept.
- `apim_attach_api_proxy_policies` — add/replace policy documents and append missing assignments. A supplied changed condition updates that exact supported assignment; omission preserves it. It does not move/remove/reorder existing steps.
- `apim_edit_policy_steps` — complete desired order for one named endpoint/pre-or-post/request-or-response phase, guarded by fresh `expected_bundle_sha256` and `EDIT API PROXY POLICY STEPS <name>`. Omitted conditions survive. Explicit unreferenced-policy removal inventories conditional/fault/unknown references first; ambiguity blocks import. Preserves shared scripts/resources and verifies intended assignments privately after import.
- `apim_list_api_products` — list API products.
- `apim_get_api_product` — read one API product with its proxies.
- `apim_create_api_product` — create (and by default publish) an API product over existing proxies with an optional quota. `publish: false` explicitly creates native `DRAFT` state rather than omitting its required status.
- `apim_update_api_product` — change product title, description, scope, quota, or publish state using a multipart OData batch; proxy membership remains unchanged. Embedded HTTP and OData errors are checked before reporting success.
- `apim_delete_api_product` — delete one named product, including a published product, only when no applications reference it; never removes its proxies or consumers. Requires `DELETE API PRODUCT <name>` and verifies absence.
- `apim_delete_api_proxy` — delete one named proxy after proving there are no product associations. Deployed proxies additionally require `allow_deployed: true`; confirms both definition and deployment-record absence. Requires `DELETE API PROXY <name>`.
- `apim_cleanup_api_objects` — preview or execute explicit product/proxy lists, at most 100 each and 200 total. Defaults to `dry_run: true`; execution needs `dry_run: false` and the exact `DELETE APIM OBJECTS <SHA256>` confirmation returned for those lists and `allow_deployed`. Preflights every target, removes selected products before selected proxies, rechecks dependencies, stops on the first failed/unverified deletion, and returns per-object partial progress. Never expands prefixes/wildcards or deletes applications, providers, KVMs or credentials.
- `apim_list_key_value_maps` — list key value maps.
- `apim_get_key_value_map` — read map metadata and entry names; all values are write-only, including unencrypted maps.
- `apim_create_key_value_map` — create a key value map; refuses to overwrite an existing map's credentials. Values are write-only; use `apim_set_key_value_map_entries` for an explicit update.
- `apim_set_key_value_map_entries` — add or change key value map entries; values are write-only.
- `apim_odata_get` — allowlisted metadata projections and service discovery, never arbitrary entity/function/payload/source reads.

For one public capability API with multiple fixed SAP backends, `src/apim-bundle.mjs` exports the low-level `buildRoutedApiProxyBundle(config)` builder. It produces a complete secured ZIP for an explicitly approved Transport.svc import; it is not an additional MCP tool. Configuration supplies the public `name`/`basePath`/`serviceType`, `backendPath`, trusted `issuer`/`jwksUrl`/`scopePrefix`, explicit `environment`, and `systems` entries containing fixed `id`/`provider`/`kvm` names. `vimVersion` preserves the ingestion query parameter when required. No password, client secret, bearer token, or KVM value belongs in this configuration.

The proxy verifies RS256 signatures, issuer, token time claims, and the client-credentials grant before a JavaScript selector authorizes exactly one system scope together with its matching resource audience. Missing, unsupported, or ambiguous selection faults before routing. The mandatory selector performs the audience check: VerifyJWT's comma-separated Audience check required all configured audiences in this tenant and rejected correctly narrowed single-system tokens. Do not bypass the selector/fault pair or replace it with unverified JWT decoding.

Each named target has its own fixed provider and private KVM-backed Basic authentication steps. There is no unconditional backend fallback, request-selected URL, or cross-environment failover. Configuration rejects duplicate system authorities and backend policy-name collisions; configure one SAP client per system family. Encrypted maps are read only, without `Put` or `InitialEntries`.

Credential KVM lookups use `index="1"` so BasicAuthentication receives scalar username/password values, not the unindexed `java.util.List`. Both variables remain private; no KVM values are changed.

After JWT verification and authorized route selection, BasicAuthentication uses `AssignTo createNew="true"` to replace the incoming bearer header with the selected backend's private Basic header. `createNew="false"` leaves an existing Authorization header untouched and would forward the consumer bearer token to SAP instead.

The first encoding policy constrains backend negotiation to `gzip, deflate`; browser clients may advertise Brotli, which these SAP hops do not support. The management and OAuth clients use the same supported encoding negotiation.

With `environment: 'production'`, the builder rejects any configuration other than a single S4P target; non-production rejects S4P. Promote the same public API contract with reviewed environment-specific issuer, provider, KVM and scope configuration, rather than transporting D/T/Q provider references into production. The builder does not create providers, credentials, Cloud Connector tunnels or XSUAA authorities.

The generic create/update/policy-attachment tools still resolve the default target endpoint; they do not author this multi-target topology or attach policies independently to non-default targets. Use the routed builder for a complete reviewed bundle, and preserve all named-target attachments when making later changes. Approved native proxy deletion can permanently remove deployed proxies; standalone undeploy without deletion is not exposed. Product unpublishing is not runtime shutdown.

Live Isuite_Non-Prod validation on 2026-10-27 deployed 25 shared capability proxies and passed 100 missing-token, tampered-signature, unauthorized-client and ambiguous-scope rejection checks. All 72 metadata and 66 bounded data requests returned HTTP 503 because no matching default-location Cloud Connector tunnel was connected to subaccount `7c0ef4b7-aad3-444b-8152-4f3759b50e9f`. This is not successful SAP data-access or backend-password verification.

Deletion smoke on the same tenant created two isolated secured proxy/product pairs, then exercised individual deletion and bulk cleanup through the MCP addon. Both published products and deployed proxies were removed; definition/deployment absence was verified, and both disposable runtime URLs changed from the deliberate `418` rejection to `404`. A product-linked proxy was refused before deletion. No business proxies or shared credentials were deleted by that smoke.

After a read-only preview found the exact legacy set dependency-free, explicit user approval authorized deletion of its 75 products and 75 proxies (`S4D100_`, `S4T300_`, `S4Q300_` capability names). All 150 deletions were verified. Post-cleanup inventory contained no legacy definitions; all 75 retired runtime URLs returned `404`. The 25 shared `S4_` APIs, all other unselected proxies, three API providers and three encrypted KVMs were preserved unchanged. Shared routes still rejected unauthenticated requests with `401`; cleanup does not establish SAP backend data access or resolve the earlier Cloud Connector issue.

A subsequent user-approved cleanup removed all six remaining `ZAI` smoke API proxies from run `LVR0WX5Z`. Definition/deployment absence and `404` responses from all six retired URLs were verified. At that point, the APIM inventory contained exactly the 25 shared business proxies and no API products or smoke APIs. All six provider definitions, all four KVMs and the shared API configurations were preserved; all shared routes continued rejecting missing bearer tokens with `401`.

Validation on 2026-10-28 corrected the approved D/T/Q providers and `ISuite_QA` location, scalar KVM reads, backend Authorization replacement, and encoding negotiation without changing credential values. The locally installed `0.9.9919` server exposed 70 tools and returned Business Partner metadata and a bounded entity read with HTTP 200 in all three systems through the same public API. All 100 authentication/scope rejection scenarios and all 25 trusted Hub-origin preflights passed. The broader matrix passed 52 of 72 metadata contracts and 47 of 69 bounded entity-read contracts; these are not an all-API readiness certification.

Initial native bundle readback found 24 metadata/source-derived OpenAPI definitions with 1,432 operations and 548 schemas. A subsequent approved documentation-only correction removed six metadata-prohibited writes and 18 unconfirmed currency/unit/value-help helper writes from GLAccountValueHelp and SiteMaintain, leaving 1,408 documented operations; helper reads, business operations, schemas and security were preserved. `S4_VIMIngestionStatus` lacks an authoritative available contract. Other observed backend restrictions include missing T Gateway services, Q V4 resource-exposure denials, four Q V2 services returning empty HTTP 200 HTML bodies, unsupported Article collection GET, and two Journal Entry read timeouts. These are external prerequisites, not authorization to modify SAP or SCC.

Developer Hub lists `S4_NonProd_APIs` and all 25 proxy records; declared endpoint/resource navigation resolves all 25 registered Swagger documents. A documentation-only correction added the missing required `info.version: "1"` to the existing `S4_VIMIngestionStatus` reference, using its current APIM public version; APIM readback and the actual Hub document both verified version `1`. Its operation list remains empty, not a fabricated contract.

Product publication still returned native HTTP 400, `An error occurred while reading the response`, after that correction; APIM readback at `2026-10-28T12:24:38Z` remained `DRAFT/isPublished=false`. The user observed the same error in the UI under request ID `08140d3a-253b-4f3a-9d45-ed1fa1428dc6`. All 25 proxy deployments and deployment links were intact, and there were only 25 registered resources, not more than 100. Catalog presence is not proof of completed publication. Publisher traces require SAP support; signed-in Hub reference rendering and Try Out remain unverified. No SAP backend, connector or business-data changes were made.

Subsequent user-authorized product replacement verified zero APIM application associations and zero Hub application/subscription rows, then deleted only the APIM product. Hub retained the managed product. Both published recreation and an explicit native draft request with `status_code: "DRAFT"` were rejected because the product already exists in Developer Hub; the mounted draft-create tool separately returned a null-status HTTP 500. At `2026-10-28T13:24:54Z`, the APIM product was absent, the orphan Hub product still referenced all 25 APIs, and every APIM proxy remained `DEPLOYED/hasChanges=false`. The original metadata and membership are saved in `.tmp/product-replacement-snapshot.json`. [SAP KBA 3313270](https://userapps.support.sap.com/sap/support/knowledge/en/3313270) describes the matching orphan-publication condition; its full resolution requires authenticated SAP for Me access. Direct Hub deletion was not attempted because the metadata declares cascade semantics whose impact was not established.

The user-authorized clean replacement `S4_NonProd_API_Catalog` is the active consumer product. Native creation returned HTTP 201; APIM readback at `2026-10-28T14:55:55Z` confirmed `PUBLISHED/isPublished=true`, and both APIM and Developer Hub contained the exact original 25-API membership. All 25 actual Hub references were read and validated; the 24 full definitions matched the manifest's 1,408 operations and 548 schemas and declared the expected OAuth client-credentials configuration. VIM status remains an empty reference pending its authoritative contract. API URLs, proxy policies and credentials were unchanged. The original `S4_NonProd_APIs` Hub cache residue is not the active product and still requires SAP-owned cleanup under KBA 3313270; the supplied resolution identifies development-team residue cleanup and, if necessary, a managed cache restart. Signed-in browser rendering and Try Out remain unverified. Evidence: `.tmp/publication-success-evidence.json`.

The delivery scope is APIM exposure and Developer Hub readiness only: proxy/product configuration and publication, accurate references, OAuth usage instructions and non-mutating usage checks. ABAP changes, SAP service registration/publication, transports, SCC administration and business-write testing are out of scope. No such changes or business writes were executed.

For Developer Hub consumption, choose **ACTIVE — S/4HANA Non-Production APIs** (`S4_NonProd_API_Catalog`), open its API Reference and authorize with either OAuth2 client credentials or a privately obtained bearer token—not both at once. Select exactly one granted scope: `sap-api-access-lm3cx1ja!t20691.S4D100.Access`, `sap-api-access-lm3cx1ja!t20691.S4T300.Access`, or `sap-api-access-lm3cx1ja!t20691.S4Q300.Access`. The token selects the system; the API URL stays unchanged. A Developer Hub API key or subscription does not grant these external XSUAA scopes and does not replace the bearer token. Use `GET /$metadata` and a bounded documented entity GET for Try Out; do not execute mutation operations during readiness verification. Never put backend Basic credentials, client secrets or tokens in documentation or chat.

Developer Hub — consumer onboarding and subscriptions:

- `devhub_list_developers` — list registered application developers and role/status metadata.
- `devhub_create_developer` — submit application-developer onboarding using the admin service key; approval is separate.
- `devhub_approve_developer` — approve an onboarded application developer.
- `devhub_list_applications` — list consumer application metadata without keys or secrets.
- `devhub_get_application` — read application metadata, subscriptions, and consumer-key availability; credentials are not returned.
- `devhub_create_application` — create an application on behalf of a developer with product subscriptions and SAP-generated consumer credentials.
- `devhub_subscribe_application` — add a product subscription to a subscription-based application without bypassing governance.
- `apim_test_api` — GET-only metadata or bounded entity inspection with exactly one private authentication source: `application_id` requires DEVHUB; `oauth: { service_instance, service_key, scope }` works with APIM alone. Fresh VerifyJWT issuer pinning precedes token acquisition. No arbitrary URLs, redirects, keys, tokens or business row values returned.
- `devhub_list_subscriptions` — bounded safe application/product/rate-plan IDs and subscription/approval status; incomplete/legacy relationships are explicit.
- `devhub_unsubscribe_application` — dry-run-first exact subscription retirement, approved by `UNSUBSCRIBE APPLICATION <application_id> FROM <product>`. One documented batch member preserves actual relationship references; each embedded HTTP result and fresh `isSubscribed:false` read-back are checked.
- `devhub_delete_application` — preview owner/dependency evidence and approve `DELETE CONSUMER APPLICATION <SHA256>`. A private 15-minute preview binds owner, subscriptions, legacy product links, tenant and `allow_active_subscriptions`. Both relationship sets are revalidated before one DELETE; incomplete/ambiguous evidence blocks even with permission. Named absence is distinct from runtime-key invalidation and issued OAuth-token revocation.

Native consumer recovery remains separate: My Workspace → Subscriptions → Regenerate Key changes key and secret and invalidates the old key; coordinate private cutover. Admin Center → Manage Users → Registered Users → Revoke User removes portal access only. Product unpublish/deprecation is not credential revocation. No APIM cleanup operation cascades into consumer retirement.

Credentials come from host environment or the user-only setup store, never `mcp.json`. Every write requires exact approval before network access; a preview hash is not user approval. Deletion is limited to explicit dependency-checked APIM products/proxies and separately approved named consumer applications. CPI design-time deletion, entitlement/platform administration, external-governance callbacks, consumer-key rotation and standalone proxy undeploy remain native. Passwords, client secrets, KVM values, consumer keys and application secrets stay private.

### Native continuous monitoring and alert rules

- `ans_list_subscriptions`, `ans_list_conditions`, `ans_list_action_metadata` — documented zero-based native paging with safe operational projections; condition values, action properties/recipients and credentials stay private. Condition/subscription rows carry canonical `configuration_digest`.
- `ans_validate_native_rules` — fully resolves conditions, actions and fallback references. Disabled/snoozed subscriptions, missing/disabled actions, unsupported predicates and broad/unknown event/node scope remain findings. Same-property OR, different-property AND and explicit mandatory conditions are not flattened into an invented match.
- `ans_set_condition` / `ans_set_subscription` — exact `SET ALERT CONDITION <name>` / `SET ALERT SUBSCRIPTION <name>` approval before requests; fresh `expected_digest` required for update and absent for create. Preserve omitted existing metadata, resolve references before writing, verify intended read-back. No action-property writer, bulk import or implicit all-events subscription.
- `integration_monitoring_readiness` — combines actual accessible management/rule evidence with native setup requirements. API reads and valid rules never prove continuous collection or notification delivery.

Cloud ALM remains administrator-run: dedicated CPI API credential → Landscape Management endpoint → Integration & Exception Monitoring collection/categories and Health Monitoring → native thresholds/notifications. `MonitoringDataRead`, `MonitoringArtifactsDeploy` and `HealthCheckMonitoringDataRead` are separate setup requirements, not grants to the developer identity. Collection and approved synthetic notification delivery must be observed; otherwise they remain `needs_admin_confirmation`.

cTMS uses the trusted internal ANS integration in each subaccount, intentionally scoped to `TmsImportStarted`, `TmsImportFinished`, `TmsTransportRequestAdded`, `TmsNodeImportJobDeactivated`, `TmsStorageQuotaUsage` and exact `tags.nodeName`/`tags.nodeId`. Do not create the obsolete `ALERT_NOTIFICATION_SERVICE` destination (scheduled removal Q4 2026). APIM anomaly-event readiness is distinct from analytics polling. CPI failures are not automatically ANS events. The stdio server adds no daemon, scheduler or telemetry backend.

Contracts: [SAP ANS models](https://github.com/SAP/alert-notification-node-client/blob/main/src/configuration-api/models.ts), [configuration routes](https://github.com/SAP/alert-notification-node-client/blob/main/src/configuration-api/configuration-client.ts), [Cloud ALM CPI monitoring](https://support.sap.com/en/alm/sap-cloud-alm/operations/expert-portal/integration-monitoring/calm-cpi.html), [trusted cTMS/ANS cutover](https://github.com/SAP-docs/btp-cloud-transport-management/blob/main/docs/80-ans-integration/migrating-to-sap-alert-notification-service-as-a-trusted-internal-service-0914d2c.md).

### Native transport readiness

`ctms_list_nodes` reads the public `GET {uri}/v2/nodes` contract with bounded local paging. Only `id`/`name` are established by the public implementation; upload/import eligibility stays unknown. [Public node client](https://github.com/SAP/jenkins-library/blob/master/src/com/sap/piper/integration/TransportManagementService.groovy), [node identity lookup](https://github.com/SAP/jenkins-library/blob/master/vars/tmsUpload.groovy).

`integration_transport_readiness({source_package_ids?,apim_proxy_names?,target_node_name})` requires explicit source content. It traverses all four package artifact groups with bounded validated continuations and explicit-count evidence, checks exact observed versions in batches of at most 20 iFlows, inspects APIM dependencies, and verifies matching private source snapshots. Countless/capped navigation, failed groups, unchecked members, non-iFlow members requiring native review, stale validation/configuration and missing matching backups block. No first-page or first-20 readiness claim.

The result is only `blocked` or `needs_admin_confirmation`: source hosts, exact versions, source-bound backup identities and node visibility are not target readiness. An authorized owner must verify Content Agent assembly format, export node, destinations and route; name the request set; approve assembly/upload/import separately; track native request/action logs; then use an independently target-bound server for exact version/runtime verification. ZIPs and toolkit snapshots are not MTARs. Native import `Error` may mean partial application; resetting to `Repeatable` is not rollback. Detailed upload/import/history schemas remain SAP-ID-gated, so no speculative automation is exposed.

### Narrow optional component adapters

| Authority | Tools and verified boundary |
|---|---|
| Standalone Event Mesh default plan | `event_mesh_get_queue({name})`: encode the full queue identity, including slashes, as one management path parameter. Safe configuration/property metadata only; no message consumption, backlog health or Suite-embedded parity. |
| AEM cloud | `aem_list_brokers`, `aem_get_broker({service_id})`, `aem_get_broker_operation({service_id,operation_id})`: fixed US GA Mission Control API, one-based bounded pages, documented expansions and observed state/error IDs only. No Beta endpoint, region fallback, broker credentials or inferred operation success. |
| Broker-local AEM SEMP | `aem_list_queues`: configured broker/VPN only, exact queue-monitor continuations, private scoped session reuse. Numeric/boolean metadata; unknown total remains null. HTTP 529 means no session slot, not no queues; Basic access failures require native setup, never a cloud-token fallback. |
| Open Connectors | `open_connectors_list_instances`, `open_connectors_get_instance({instance_id})`: identity and element id/key/name only; private pagination tokens, no configuration/provider data. |
| Open Connectors enabled-state action | `open_connectors_set_instance_enabled({instance_id,enabled,confirmation})`: exact `ENABLE OPEN CONNECTOR INSTANCE <id>` or `DISABLE OPEN CONNECTOR INSTANCE <id>` before requests; fresh private Element token for bodyless PUT/DELETE `/instances/enabled` only. DELETE disables, not deletes. HTTP acceptance does not prove effective state or provider health; provider OAuth/re-auth stays native. |
| Edge local APIs | `edge_get_api_metadata`, `edge_list_message_logs`, `edge_get_message_log`: local Basic authority; preserve `/local/api/eic/v1` discovery and `/local/api/v1` MPL roots. Shared CPI UTC/cursor/redacted-diagnostic contracts, no payloads. Schema/entity presence is discovery, not a component/pod/job field contract. Missing `/local` can yield 401; unsupported local routes can yield 403, not proof of non-entitlement. |

Contracts: [AEM GA OpenAPI](https://api.solace.dev/cloud/openapi/mission-control.json), [SEMP security/session management](https://help.pubsub.em.services.cloud.sap/Admin/SEMP/SEMP-Security.htm), [Open Connectors enabled-state action](https://help.openconnectors.ext.hana.ondemand.com/home/disabling-and-enabling-instances), [pagination](https://help.openconnectors.ext.hana.ondemand.com/home/standardized-pagination), [Edge local API access](https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ISuite_Edge_Integration_Cell/local-odata-api-access-fe61332.md).

### Native lifecycle handoffs

`integration_connection_info.capabilities` always includes these boundaries, prerequisites, primary source links, concrete steps, safety warnings and post-action verification. `native_access: unverified` is not hidden automation or an entitlement decision. Require an authorized native owner and exact identities before native writes.

| Surface | Native action and required verification |
|---|---|
| Capability activation/permissions | Administrator inspects Suite capability activation, BTP entitlement and operation-specific roles. Tool access/403/404 alone does not establish their cause; never grant roles or provision services through a metadata check. |
| Shared CPI artifact creation and version history | Design → package → Edit → Artifacts → Add → correct Value Mapping/Script Collection/Message Mapping Create/Upload; save/restore the selected version. Verify identity/version and approve deployment separately. Design-workspace ZIP, mass-download ZIP and MTAR are not interchangeable. |
| CPI queue controls/retry | Monitor → Manage Stores → Message Queues → inspect exact queue, Where-Used, access type/state → Actions → Usage → Start/Stop. Approve exact-message retry separately for an active non-exclusive queue; whole-queue Retry affects all messages and can duplicate receiver effects. Refresh metadata and correlate MPL. |
| CPI cancellation/design deletion | Review exact message/artifact, backup, dependencies, configuration-only restrictions and locks; use supported native confirmation. Never unlock another user, guess a status write, promise processing stops or substitute queue deletion. Verify named design absence/observed processing state. |
| APIM native revision/standalone undeploy | Preserve current draft and product associations → API details → Revisions → select retained revision → Revert → inspect new revision → Deploy; use native Undeploy separately. Toolkit saved-bundle import creates a new imported revision, not native Revert. Verify content/runtime and separately approve consumer reads. |
| Consumer rotation/portal revoke | Owner coordinates private key/secret delivery and client cutover → My Workspace → Subscriptions → Regenerate Key. Portal removal: Admin Center → Manage Users → Registered Users → Revoke User with reason. Rotation invalidates the old key; portal revoke, unpublish and application deletion do not prove issued OAuth-token revocation. |
| cTMS promotion | Follow the native transport-readiness procedure above: Content Agent, named source/export node/route/request set, distinct assembly/upload/import approvals, action logs and independent target-bound verification. Partial import is not rollback. |
| Cloud ALM / ANS delivery | Follow native continuous-monitoring setup above. Rule validity/API reads do not prove collection or delivery; require observed collection and approved synthetic notification evidence. |
| Suite-embedded Event Mesh | Suite administrator inspects Configure/Monitor → Event Mesh activation and configured limits. Standalone default-plan credentials/APIs do not establish parity or embedded access. |
| TPM | Design → B2B Scenarios → Agreements → exact version → Activate → explicitly approve Default or Full. Default does not activate inactive security/identifier/custom-rule references; Full activates all references. Inspect activation failure/Partner Directory Data and Monitor → Interchanges. `B2bInterchangeRead` excludes payload access; operational retry/restart/cancel needs separate approval and `B2bInterchangeOperate`. Never edit generated Partner Directory data to simulate agreement management. |
| Integration Advisor | Select MIG/MAG and exact version → validate/simulate → Additional Options → Export → SAP Cloud Integration Runtime Artifacts. Inspect/import generated CPI content separately; editing it does not edit the originating guideline. Do not mix old/new namespace-dependent exported files. |
| Integration Assessment | Existing APIs/default service key → User Actions → API Reference → establish exact resource/schema. `url` is the token-server URL; `entities` and `management` are resource origins. Do not parse as CPI or guess `/applications`. Record the selected native assessment outcome. |
| Migration Assessment/tooling | Request → Data Extraction → inspect Log; Request → Scenario Evaluation → inspect dashboard → export/generate report. Conversion occurs in native tooling; inspect generated CPI identities/content separately. Assessment is not conversion or deployment; no PO-credential reuse. |
| New Integration Cell API/MCP artifacts | Design → Integrations and APIs → package → Edit → Artifacts → Add → API / MCP Server; review exact runtime/version, source and security. API-derived MCP requires deployed OAuth OData/REST and OpenAPI 3.0.0–3.0.3. Separately approve Deploy and runtime/virtual host; Monitor → Integrations and APIs → Integration Cell → Manage Integration Content / Monitor Message Processing. Classic APIM tools and MCP invocation access are not administration of these artifacts. |
| Edge component/pod/job operations | Authorized native Operations Cockpit → Component Monitor / Job Management → exact component/pod/job diagnostics. Published routes/metadata do not establish safe field schemas. No restart, job control, Kubernetes or shell bridge; correlate supported local MPL separately. |

Primary procedures for new artifacts: [API design](https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ISuite_Integrations_APIs/create-an-api-artifact-using-a-target-url-or-an-openapi-specification-914f57e.md), [API-derived MCP](https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ISuite_Integrations_APIs/create-an-mcp-server-from-an-api-artifact-9f18140.md), [native monitoring](https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ISuite_Integrations_APIs/monitor-apis-and-mcp-servers-399b6c6.md).

### Operator verification and approval gates

The existing Integration Architect/Developer agents and skills cover discover → reuse → dependencies → approved author/configure → retained save → selected-version validation → private snapshot/readiness → separately approved deploy/native promotion → independent target verification → bounded observation/native alert readiness → diagnosis → separately approved recovery/retirement. No extra operator persona is installed.

Use `node scripts/check-live-integration.mjs --window-minutes 60 --top 3 --json` for connected read-only verification. It permits management GETs and exact configured token POSTs only, projects diagnostic metadata and reports absent optional adapters as `live_unverified`. It never validates/saves/imports/deploys/configures, probes consumer APIs, consumes/retries messages, deletes, or asserts native collection/delivery/promotion success. Exit 0 is read/schema execution evidence, not landscape health. `npm run test:live:integration` is the distinct mutating fixture runner and needs separate explicit approval.
