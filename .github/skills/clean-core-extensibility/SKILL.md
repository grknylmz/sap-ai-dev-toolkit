---
name: clean-core-extensibility
description: Design SAP extensions using Clean Core principles, released extension points, side-by-side patterns, and explicit risk classification for non-standard alternatives.
---

# Clean Core extensibility

## Tool shortlist

Query the active MCP server's live `tools/list` once; use task-relevant, destination-prefixed tools with their returned schemas. Inspect system capabilities with `GetSystemInfo`, `GetFeatures`, and `GetInstalledComponents`; inspect source and dependencies with `GetSource`, `GetContext`, `FindDefinition`, `FindReferences`, `CompareSource`, `ListDependencies`, `GetCDSDependencies`, and `GetCDSImpactAnalysis`. Check release status with `GetAPIReleaseState` or batch with `PlanABAPCloudMigration` where exposed. Use transport tools only for planning/readiness context and never claim transport release/deletion support; transport release is unavailable through this addon. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.

1. Classify the requirement as configuration, in-app/key-user extensibility, developer extensibility, side-by-side extension, integration, analytics, UI extension, or unavoidable core change.
2. Prefer the cleanest pattern in this order: SAP standard configuration, released in-app extensibility, released developer extensibility, released APIs/events, side-by-side SAP BTP extension, then carefully isolated custom ABAP only if no compliant option exists.
3. Reject or explicitly flag high-risk approaches: modifications to SAP standard, unreleased APIs/objects, direct updates to application tables, implicit enhancements, copied standard logic, tight coupling to internal tables/classes, and changes that cannot be validated after upgrade.
4. Design side-by-side solutions with clear data ownership, API contracts, authentication/authorization, eventing or polling strategy, error handling, observability, resilience, and lifecycle/deployment boundaries.
5. Report a Clean Core compliance decision: compliant, conditionally compliant with mitigations, or non-compliant/risk accepted. Include exact evidence, required validations, and checks not run; do not treat lint, syntax, or activation as substitutes for behavior or upgrade-safety evidence.
