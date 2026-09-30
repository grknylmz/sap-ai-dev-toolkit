---
name: hana-cloud-validation
description: Validate HANA Cloud CAP and HDI changes locally, inspect deployment plans and diffs, and prepare a safe user-run deployment handoff. Use before deploying database artifacts or assessing a HANA change.
---

# HANA Cloud validation and deployment handoff

## Tool shortlist

Use live `tools/list` for HANA and SAP tool availability. HANA inspection is limited to `hana_connection_info`, `hana_list_objects`, `hana_describe_object`, and bounded `hana_read_rows`; SAP VSP tools use the live names their server returns. Use CAP/CDS documentation and model tools where available. Do not use ABAP `RunQuery`, ABAP Unit, or `LintABAP` as HANA validation. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-hana` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.

## Procedure

1. **Reconfirm scope and target.** Identify the CAP/HDI project root, HANA endpoint, service/binding, HDI container/schema, intended environment, and deployment identity. Use `hana_connection_info` only if its live tool is attached. Never ask for or print credentials; if no bound target is available, stop live inspection and report that.
2. **Review the exact source and build diff.** Inspect tracked/untracked files, CAP model changes, `gen/db` outputs, MTA/service wiring, grants, synonyms, migrations, and undeploy implications. Call out drops, field narrowing/type changes, external-object privileges, and generated artifacts that imply data loss or authorization changes.
3. **Run local-only validation.** Inspect the project scripts and CAP version, then run the supported compile/build/tests. For a CAP HANA project, `cds build --for hana` builds deployable HDI artifacts locally; it does not prove deployment or runtime behavior. Ensure test configuration cannot redirect validation to the live HANA instance. Never run a production HANA deployment as a test.
4. **Inspect the target read-only.** If connected, use the bounded catalog tools to confirm only the relevant object names and columns, then use a minimal `hana_read_rows` call when data evidence is necessary. Never pass free-form SQL, exceed the tool’s 200-row cap, select a different schema, or attempt a write to “check” permissions.
5. **Prepare the user-run deployment plan.** Present exact project-root command(s) already defined by the project, target/environment, source/build diff, HDI deployer identity required by the pipeline, ordering/dependencies, expected generated objects, data migration or removal risks, rollback strategy, and post-deployment read-only checks. Ask the user to review/approve before proceeding with any deployment-related action; the MCP server has no deploy path and this agent does not execute deployment.
6. **Report evidence and gaps.** Separate local compile/test/build results, live read-only inspection, and user-run deployment evidence. State skipped tests, absent credentials/tools, target uncertainty, truncation, and remaining risks. Never claim HANA activation/deployment or runtime validation unless the user has supplied evidence that it occurred.

## Safety boundaries

- HANA tools are metadata and bounded read-only inspection only. There is no arbitrary SQL, write, deployment, undeploy, migration execution, grant, or credential-management tool.
- `HANA_RO_*`/VCAP credentials must represent a dedicated read-only identity. The user’s deployment identity stays out of the MCP host environment.
- A chat confirmation, `readOnlyHint`, successful build, or prompt instruction is not an authorization gate for database changes.
- Deployment, destructive schema changes, grants, and removals remain explicit user-run operations with independent review and authorization.
