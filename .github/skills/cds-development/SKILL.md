---
name: cds-development
description: Implement, change, or analyze ABAP CDS data definitions and their dependencies or consumers. Use for DDLS and CDS modeling tasks.
---

# CDS development

## Tool shortlist

Query the active MCP server's live `tools/list` once; use task-relevant, destination-prefixed tools with their returned schemas. Read DDLS with `GetSource`; use `GetCDSDependencies` for upstream dependencies, `GetCDSImpactAnalysis` for consumers, and `GetCDSElementInfo` for element metadata. Trace references with `FindReferences`; edit via `EditSource` / `WriteSource`. Validate with `SyntaxCheck`, `RunATCCheck`, activation, and read-only runtime queries via `RunQuery` or `GetTableContents` when exposed. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.

1. Inspect the target DDLS source, its existing data definitions, package conventions, dependencies, and consumers before editing.
2. Use live `GetCDSDependencies`, `GetCDSImpactAnalysis`, and `GetCDSElementInfo` tools when exposed to understand upstream sources, downstream impact, and element metadata. Use their current destination-prefixed names and schemas.
3. Implement only the requested CDS behavior. Validate the changed definition, affected dependencies, and relevant consumers with operations actually exposed by the system; report unavailable analysis or validation capabilities rather than inferring results.
4. CDS changes require executable validation, not only syntax. Do not treat syntax, ATC, or activation as substitutes for behavior evidence. After activation, query or otherwise consume the changed view/entity with representative filters and projections using `RunQuery` or `GetTableContents` when available. Prefer safe real rows from the target system; if no suitable data exists, use authorized isolated sample data or document the lack of executable data. Verify returned fields, computed expressions, casts, currencies/units, parameters, associations exposed to consumers, key semantics, annotations relevant to consumers, authorization-relevant behavior when testable, and empty-result behavior.
5. For CDS logic that is consumed by ABAP classes, RAP behavior, or services, add or update an automated test around the consumer or a focused ABAP Unit test that selects from the CDS artifact with controlled input. Use test doubles or isolated fixture data when available/authorized. If the MCP server only allows live read-only queries, record the exact validation query, input data source, row count, and observed result as the CDS runtime test evidence. Activate authorized CDS changes in dependency order and treat activation failure as a blocker.
