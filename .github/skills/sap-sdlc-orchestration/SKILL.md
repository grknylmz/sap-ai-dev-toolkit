---
name: sap-sdlc-orchestration
description: Orchestrate the SAP delivery lifecycle from requirement analysis through design, delegated implementation, validation, transport preparation, release readiness, and operational handover.
---

# SAP SDLC orchestration

## Tool shortlist

Query the active MCP server's live `tools/list` once; use task-relevant, destination-prefixed tools with their returned schemas. Investigate system and repository context with `GetSystemInfo`, `GetFeatures`, `GetConnectionInfo`, `GetInstalledComponents`, `SearchObject`, `GrepObjects`, `GrepPackages`, `GetSource`, `GetContext`, `FindDefinition`, `FindReferences`, `CompareSource`, and dependency tools (`ListDependencies`, CDS dependency/impact tools). Validate with `LintABAP`, `SyntaxCheck`, `RunUnitTests`, `RunATCCheck`, runtime queries, `GetApplicationLog`, and RAP regression-suite tools when exposed. Use transport tools for readiness planning only; never claim transport release/deletion support because transport release is unavailable through this addon. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.

1. Convert the requirement into an SDLC plan: discovery, fit-gap/API recommendation, architecture, implementation packages, test strategy, validation gates, activation/publication gates, transport readiness, deployment notes, rollback, and operations handover.
2. Require a planning phase before implementation for every work package. Each package starts with a presented plan of objects, tests, and validation steps; no SAP state-changing package proceeds before the user approves it. Every implementation package includes a local quality gate: sources are authored locally as abapGit-style workspace files (`object.type.extension`) and must pass `LintABAP` plus LSP checks before they are sent to the SAP system.
3. Automate what the active MCP tools safely allow. Read and analyze the system, propose standard APIs and extension points, generate implementation briefs, request or delegate coding work, run checks, collect evidence, and iterate until acceptance criteria are met or a blocker is proven.
4. Keep state-changing gates explicit. Do not edit source, activate, publish, create transports, create test data, or execute mutating scenarios unless the user authorized that phase and the target destination/package/transport context is known.
5. Enforce quality gates: unit or executable behavior tests, syntax, lint, ATC where available, runtime validation, security/authorization review, Clean Core/released API check, transport dependency check, and documented skipped checks with reasons.
6. Finish with an SDLC status report: requirement decision, selected APIs/extension pattern, implementation packages and owners/agents, validation evidence, deployment/transport readiness, risks, open items, and the next safe action.
