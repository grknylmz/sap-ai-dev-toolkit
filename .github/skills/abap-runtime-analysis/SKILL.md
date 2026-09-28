---
name: abap-runtime-analysis
description: Analyze ABAP runtime incidents, debugger state, and performance symptoms using application logs, source/reference inspection, safe data reads, and authorized debugger sessions; runtime call relationships must be derived from source inspection (FindReferences/GetContext) because no call-graph tool is exposed, and dump/trace evidence must come from SAP tooling outside this addon. Use for diagnosing failures before or after ABAP/RAP code changes.
---

# ABAP runtime analysis

## MCP tool shortlist

Query the active MCP server's live `tools/list` once and use exact destination-prefixed names and schemas. Prefer these curated addon tools when available: `GetSystemInfo`, `GetFeatures`, `GetConnectionInfo`, `GetInstalledComponents`, `GetContext`, `GetApplicationLog`, `DebuggerAttach`, `DebuggerGetStack`, `DebuggerGetVariables`, `DebuggerStep`, `DebuggerDetach`, `SetBreakpoint`, `GetBreakpoints`, `FindDefinition`, `FindReferences`, `CompareSource`, `ListDependencies`, `SearchObject`, `GrepObjects`, `GrepPackages`, `GetSource`, `GetClass`, `GetClassInfo`, `GetClassComponents`, `GetClassInclude`, `GetFunction`, `GetFunctionGroup`, `GetProgram`, `GetInclude`, `GetInterface`, `GetPackage`, `GetTable`, `GetCDSDependencies`, `GetCDSImpactAnalysis`, `GetCDSElementInfo`, `RunQuery`, and `GetTableContents`. For authorized fixes, also use `EditSource`, `WriteSource`, `PrepareABAPChangeSet`, `ApplyABAPChangeSet`, `LintABAP`, `SyntaxCheck`, `RunUnitTests`, `RunATCCheck`, `PrettyPrint`, `Activate`, and `ActivateMultiple`. Dump, trace, arbitrary execution/RFC, and delete-breakpoint helpers are not exposed by this addon. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.

1. Establish incident boundaries: symptom, expected result, object/service, destination, user/session, input, time window, frequency, and whether reproduction/debugging is authorized.
2. Gather read-only evidence first. Correlate logs, source/reference context, dependencies, debugger state, and data conditions by timestamp and object path. Do not start with source edits.
3. For debugger sessions, set breakpoints sparingly — breakpoints registered with `SetBreakpoint` cannot be deleted through this surface because `DeleteBreakpoint` is not exposed — and attach only to the authorized session. Inspect stack and variables, step minimally, then detach; `DebuggerDetach` releases the session. Never attach to another user's unrelated session.
4. For performance symptoms, separate database access, ABAP logic, remote calls, locking, and payload/serialization cost using available source/data evidence and measured reproduction evidence. If dumps or traces are required, hand them off to SAP tooling outside this addon.
5. Convert evidence into a falsifiable root-cause chain. Clearly label facts, assumptions, and unverified hypotheses.
6. If a fix is authorized, create a regression test where feasible, implement the smallest change, validate with lint/syntax/unit/ATC/LSP checks, activate only when authorized, and rerun the reproduction or strongest available runtime check.
