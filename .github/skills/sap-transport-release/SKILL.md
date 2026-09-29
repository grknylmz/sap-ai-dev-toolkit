---
name: sap-transport-release
description: Prepare ABAP changes for SAP transport and verify request contents, dependencies, tests, and activation. Use for transport preparation or release-related requests.
---

# SAP transport preparation

## Tool shortlist

Query the active MCP server's live `tools/list` once; use task-relevant tools with their returned schemas. Identify candidates with `GetUserTransports` or `ListTransports`; inspect a request with `GetTransport` / `GetTransportInfo`; use `CheckTransportReadiness` to collect transport, dependency, inactive-object, ABAP Unit, and ATC evidence when available. Activate with `Activate` / `ActivateMultiple` only when requested. `CreateTransport` is state-changing and requires explicit authorization. Release and deletion are not available through this addon. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.

1. Use `CheckTransportReadiness` with exactly one `GetTransport` check for the requested ID plus applicable `GetTransportInfo`, `ListDependencies`, `GetInactiveObjects`, `RunUnitTests`, and `RunATCCheck` checks — the only check tools that tool accepts. Review each returned evidence item; a completed call can still contain findings. Verify the destination, package, complete object set, dependencies, and an eligible modifiable request before preparing changes.
2. Create a transport only when the user specifically authorized its creation. Before transport handoff, ensure changed objects have been activated in dependency order when activation is authorized, ABAP Unit tests have been run or blockers documented, runtime validation evidence exists for changed public contracts, and ATC/syntax checks have been run where available. Do not treat request contents, syntax, ATC, or activation as substitutes for behavior and runtime validation evidence. Report actual request contents and validation state.
3. This addon does not expose transport release or deletion tools. Do not invent or claim release/deletion support. When release is requested, report that release is unavailable through this addon and hand off the release action to an authorized SAP transport workflow.
