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
