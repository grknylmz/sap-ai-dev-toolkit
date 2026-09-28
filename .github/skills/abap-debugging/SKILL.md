---
name: abap-debugging
description: Diagnose ABAP runtime failures using SAP dumps, application logs, traces, call context, and debugger facilities. Use when investigating ABAP defects or production-like incidents.
---

# ABAP debugging

## Tool shortlist

Query the active MCP server's live `tools/list` once; use the destination-prefixed tool and schema for the target. Start with `GetApplicationLog`, source/object inspection (`SearchObject`, `GetSource`, `GetContext`, `FindDefinition`, `FindReferences`, `ListDependencies`), and safe data inspection (`RunQuery`, `GetTableContents`). For an authorized debugger session, use `SetBreakpoint`, `DebuggerAttach`, inspect with `DebuggerGetStack` / `DebuggerGetVariables`, step with `DebuggerStep`, and finish with `DebuggerDetach`. Avoid attaching to another user's session. Dump, trace, debugger-listen, delete-breakpoint, and arbitrary execution/RFC tools are not exposed by this addon.

1. Reproduce the reported failure when safe and within the requested target. Establish the observed input, outcome, and execution context before changing code.
2. Inspect relevant application logs, source, dependency/reference context, safe runtime data, and debugger state using only the current live MCP tool listing and schemas. Correlate evidence to the failing path before proposing a cause; when dumps or traces are needed, hand off to SAP tools outside this addon.
3. Keep debugger sessions and execution bounded. Do not change business data or attach to, interrupt, or alter another user's session. Prefer read-only diagnostics unless a change is specifically authorized.
4. Verify a fix against the reproduced failure when possible and distinguish reproduced behavior from diagnostic inference. When a code fix is made, add or update ABAP Unit coverage for the defect, run the regression, activate authorized object changes in dependency order, and perform a bounded runtime reproduction using the same or representative safe data before declaring the defect fixed.
