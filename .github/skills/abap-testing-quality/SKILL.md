---
name: abap-testing-quality
description: Design ABAP Unit behavior tests and validate ABAP changes with lint, editor diagnostics, syntax checks, and ATC. Use for test creation, quality reviews, and change validation.
---

# ABAP testing and quality

## Tool selection

Query the active MCP server's live `tools/list` once, then use only task-relevant, destination-prefixed tools with their returned schemas: `LintABAP` for caller-supplied source, `SyntaxCheck` for SAP syntax validation, `RunUnitTests` for ABAP Unit, and `RunATCCheck` for ATC. Unavailable tools are not passes. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.

- Treat ABAP Unit as behavior verification: assert externally observable results, boundaries, state transitions, and relevant error behavior. Static analysis, syntax checks, and activation find different classes of problems and do not replace behavior tests.
- For a behavior change, create or refine a real ABAP Unit assertion first, run it to observe the regression, then rerun after implementation. If an executable red/green cycle is unavailable, state the concrete constraint and the strongest check actually performed; never report a substitute as a passing test.
- Require runtime validation for changed contracts. Execute the changed class/interface/function/report/service/CDS path with representative data in BAS or SAP. Prefer non-destructive real data from the target system; use authorized isolated test/sample data only when real data is unsafe or unavailable. Verify expected results plus a negative, empty, or boundary scenario.
- When validating interfaces, integrations, or CDS views, prove the artifact can be consumed: instantiate/call the implementing class, invoke the API/RFC/OData/RAP action/query, or query the CDS entity with `RunQuery`/`GetTableContents` as appropriate. Inspect returned structures/messages/rows rather than only checking compilation.
- Run the live destination-prefixed `LintABAP` MCP tool on all relevant caller-supplied source files, using abapGit-style filenames and including required dependency sources. The tool analyzes only the files supplied to it; it does not read the workspace or resolve dependencies.
- Consume BAS editor LSP diagnostics when configured. `vsp lsp --stdio` is editor LSP functionality, not an MCP tool and not an entry in MCP `tools/list`.
- Use SAP `SyntaxCheck`, `RunUnitTests`, and `RunATCCheck` when exposed by the live tool listing and permitted for the task. Activate authorized SAP object changes in dependency order with `Activate` / `ActivateMultiple`. Address findings and rerun affected checks. Do not suppress findings silently or present unavailable/skipped checks as passes.
- Report ABAP Unit, runtime validation data source, activation, lint, LSP, syntax, and ATC outcomes separately, including exact reasons for checks not run.
