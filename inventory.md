# SAP AI Dev Toolkit Tool Inventory

This inventory reflects the current SAP AI Dev Toolkit proxy behavior in `src/mcp-proxy.mjs`. The proxy exposes a curated VSP allowlist plus destination-scoped local workflows; it does not expose every tool registered by VSP. The live MCP `tools/list` response remains authoritative because capabilities vary by VSP mode and SAP system.

## Summary

| Status | Count | Notes |
| --- | ---: | --- |
| VSP tools | Up to 51 | Curated from the child VSP tool list and exposed with a destination prefix, for example `<destination>__GetSource`. |
| Local lint tool | 1 per destination | `LintABAP` analyzes caller-supplied ABAP source in memory. |
| Workflow tools | Up to 6 per destination | Review/apply change sets, transport evidence, Clean Core release assessment, and read-only RAP regression suites. Some are exposed only when their upstream VSP tools are registered. |
| Convenience mapping | Dynamic | `GetApplicationLog` maps to VSP `SAP(action="analyze", type="application_log")` when the SAP router is registered. |
| Intentionally filtered VSP tools | Dynamic | Destructive, broad-router, trace, and unsupported VSP operations are hidden from direct calls. |
| Mode-dependent | Dynamic | Focused/expert mode and backend capabilities determine what VSP registers. |

The maximum fixture surface is 59 tools per destination when expert-mode capabilities and all local workflows are available. Multiple selected destinations create separate MCP servers; this add-on cannot inspect VS Code's aggregate tool budget or per-chat tool binding.

## Known upstream VSP tools

These names are known from fixtures, README, and historical upstream VSP inventories. They are not a statement that the proxy exposes them; only the curated list in [tools.md](tools.md) is public through the proxy. Names absent from that allowlist are filtered even when VSP registers them.

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

### General VSP router

- `SAP`

## Enabled add-on/local tools

- `LintABAP` — local add-on tool; lints caller-supplied ABAP source without contacting SAP.
- `GetApplicationLog` — add-on convenience tool mapped to VSP `SAP` with `action="analyze"` and `type="application_log"`.

## Destination workflow tools

- `PrepareABAPChangeSet` — stage full-source `WriteSource` changes and return review diffs and source fingerprints.
- `ApplyABAPChangeSet` — re-read staged objects before writing and report conflicts or partial application.
- `CheckTransportReadiness` — collect selected transport, dependency, inactive-object, ABAP Unit, and ATC evidence.
- `PlanABAPCloudMigration` — batch-check API release state for supplied ADT object URIs and prioritize recognized unreleased APIs.
- `GenerateRAPRegressionSuite` — read service metadata and emit reusable GET-only smoke cases for entity sets.
- `RunRAPRegressionSuite` — execute saved cases with status, content-type, and JSON-path assertions over the connected destination.

## Notes

- Runtime tool names are namespaced by destination slug, for example `demo-abap__RunQuery`; `tools/call` accepts the exact name returned by `tools/list`.
- The proxy starts VSP with `--enable-transports`; generated MCP entries set `SAP_ALLOW_TRANSPORTABLE_EDITS=true`.
- Transport release/deletion and the general-purpose `SAP` router are intentionally hidden from direct proxy calls. `GetApplicationLog` is the bounded convenience mapping for the SAP application-log route.

## Separate optional HANA Cloud inspector

The HANA inspector is a standalone companion MCP process launched as `sap-ai-hana`; it is not a VSP child and is not destination-prefixed. It uses a read-only identity selected from `HANA_RO_*` variables or one unambiguous `VCAP_SERVICES` binding. Its host/schema target is fixed by process configuration; tool arguments cannot change it.

| Tool | Behavior |
| --- | --- |
| `hana_connection_info` | Report selected endpoint, service/binding name, configured and current schema, database user, and TLS validation state. Does not return credentials. |
| `hana_list_objects` | List tables and/or views in the configured schema, capped at 200 objects. |
| `hana_describe_object` | Return columns for a table or view verified in the configured schema. |
| `hana_read_rows` | Read selected catalog-verified columns with bound filter values and a hard 200-row maximum; credential-like columns are blocked. No free-form SQL. |

The process exposes no DDL, DML, arbitrary SQL, procedure-call, deployment, undeploy, grant, or service-key management tools. The separate HANA identity should also be granted only the reads required for the intended HDI container.
