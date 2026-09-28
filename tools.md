# Curated VSP tools exposed through the BAS proxy

The proxy no longer advertises every VSP tool. To keep the developer-lifecycle MCP surface manageable, each generated one-destination server exposes a cherry-picked set of VSP tools plus local workflow tools (currently 59 tools when all curated VSP capabilities are registered).

Hidden upstream VSP tools are not directly callable through the proxy. Local workflow tools may still call hidden or non-advertised upstream operations internally when they are required for a bounded workflow.

## Public VSP tools

- `Activate`
- `ActivateMultiple`
- `CompareSource`
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
- `GetPackage`
- `GetProgram`
- `GetSource`
- `GetSystemInfo`
- `GetTable`
- `GetTableContents`
- `GetTransport`
- `GetTransportInfo`
- `GetUserTransports`
- `GrepObjects`
- `GrepPackages`
- `ListDependencies`
- `ListTransports`
- `PrettyPrint`
- `RunATCCheck`
- `RunQuery`
- `RunUnitTests`
- `SearchObject`
- `SetBreakpoint`
- `SyntaxCheck`
- `WriteSource`

## Hidden from direct proxy calls

Broad/destructive surfaces such as object deletion, SQL trace, arbitrary SAP router calls, transport release/delete, RFC execution, debugger listen/delete-breakpoint helpers, and one-off generator/update helpers are intentionally not advertised by the BAS proxy.

## Destination-scoped workflow tools

The proxy adds local multi-step tools to each destination when their required VSP capabilities are available:

- `LintABAP` — local in-memory ABAP linting.
- `GetApplicationLog` — bounded convenience mapping to the upstream SAP application-log route when available.
- `PrepareABAPChangeSet` and `ApplyABAPChangeSet` — review full-source diffs and recheck source before explicit writes.
- `CheckTransportReadiness` — collect a whitelisted bundle of transport, dependency, inactive-object, ABAP Unit, and ATC results.
- `PlanABAPCloudMigration` — batch SAP API release-state checks and prioritize recognized unreleased results.
- `GenerateRAPRegressionSuite` and `RunRAPRegressionSuite` — create and run reusable OData GET-only checks under the selected service root.

`sap-ai-dev-toolkit --doctor` checks destination probing, VSP startup, `GetSystemInfo`, and MCP tool listing. `sap-ai-dev-toolkit --demo` runs the sample tools and OData fixtures without contacting SAP; demo writes and transport creation remain in memory until that process exits.

## Separate optional HANA Cloud inspector

The optional `hana-cloud-inspector` companion starts `sap-ai-hana` as a separate stdio MCP server. It does not use the VSP proxy, BAS destination prefix, or ABAP SQL `RunQuery`. When selected and configured with a dedicated read-only identity, it exposes:

- `hana_connection_info` — verify the configured endpoint, service/binding, current user, schema, and TLS state without returning credentials.
- `hana_list_objects` — list tables/views in the bound HDI schema, with a 200-object maximum.
- `hana_describe_object` — inspect columns for a catalog-verified object in that schema.
- `hana_read_rows` — perform parameterized reads of selected columns, capped at 200 rows; credential-like columns are blocked and arbitrary SQL is not accepted.

Connection secrets are read from the MCP host environment via explicit `HANA_RO_*` variables or a selected `VCAP_SERVICES` binding and are not written to `mcp.json`. TLS certificate verification is mandatory. No HANA write, DDL/DML, deploy/undeploy, grants, or service-key tools are exposed; deployment remains a user-run project workflow.
