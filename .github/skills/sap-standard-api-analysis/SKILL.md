---
name: sap-standard-api-analysis
description: Assess requirements against SAP standard capabilities, released APIs, standard CDS/RAP/OData interfaces, and existing implementation options before custom development.
---

# SAP standard and API analysis

## Tool shortlist

Query the active MCP server's live `tools/list` once; use task-relevant, destination-prefixed tools with their returned schemas. Inspect target capabilities with `GetSystemInfo`, `GetFeatures`, `GetConnectionInfo`, and `GetInstalledComponents`. Search candidates with `SearchObject`, `GrepObjects`, `GrepPackages`, `GetSource`, `GetContext`, `FindDefinition`, `FindReferences`, `ListDependencies`, `GetCDSDependencies`, `GetCDSImpactAnalysis`, and `GetCDSElementInfo`. Verify released API status with `GetAPIReleaseState` or batch with `PlanABAPCloudMigration` when exposed. Use `RunQuery` or `GetTableContents` only for safe read-only evidence. Never claim transport release/deletion support; transport release is unavailable through this addon. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.

1. Translate the requirement into business capabilities, integration contracts, data entities, and observable acceptance criteria before choosing implementation objects.
2. Prefer SAP standard configuration, standard processes, communication scenarios, released OData/RFC/BAPI APIs, released CDS views/entities, RAP BOs, business events, BADIs, and documented extension points. Record all inspected candidates and whether each is standard, released, deprecated, unavailable, or unverified.
3. Use `GetAPIReleaseState` for every candidate dependency when available. If release state cannot be checked with live tools, label it as unverified and do not treat it as Clean Core evidence.
4. Compare options by fit, implementation effort, upgrade risk, data consistency, authorization model, operational impact, testability, and fallback/rollback path.
5. Finish with a recommendation, alternatives rejected, exact MCP evidence gathered, open questions, and any checks not run. Do not present source text, static checks, or assumptions as runtime validation evidence.
