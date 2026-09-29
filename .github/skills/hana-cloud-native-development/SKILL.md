---
name: hana-cloud-native-development
description: Develop SAP HANA Cloud CAP and HDI database components locally, including CDS models, HANA build outputs, synonyms, and grants. Use when creating or changing HANA-native project artifacts.
---

# HANA Cloud native development

## Tool shortlist

Inspect the active workspace and its CAP/HDI tooling first. Query `tools/list` for live MCP availability and use the exact live names for any SAP VSP tools. Use the CDS/CAP MCP model and documentation tools when available; otherwise inspect the project's local `.cds`, package, MTA, and HDI files and mark missing context. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-hana` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.

## Procedure

1. Identify the application root in the current workspace and establish whether it is a CAP application, an HDI-only module, or an existing MTA project. Read its scripts, `cds` configuration, `db/`, `srv/`, `.hdiconfig`, `.hdinamespace`, synonyms, grants, MTA descriptor, and established naming conventions before proposing edits.
2. For CAP-owned database models, prefer CDS in `db/` as the source of truth and add or modify `srv/` only when the requested application behavior needs a CAP service. Consult available CDS MCP docs/model tools before CAP model/API changes. Do not duplicate generated `.hdbtable`/`.hdbview` definitions as hand-authored HDI files.
3. For HDI-native objects not represented by the existing CAP model, add only the required design-time artifacts and follow existing HDI namespace/build conventions. Treat `.hdbsynonym`, `.hdbgrants`, external-object access, and user/role changes as security-sensitive; require the minimal named object and privilege set and present them for review. Never generate broad schema grants or a deployer credential into source/config.
4. If MTA packaging or deployment metadata is required, extend the existing project structure and module/service references instead of creating a second deployment topology. Do not scaffold sample entities, CSV data, or unrelated CAP services unless explicitly requested.
5. Before file changes, present a concise local plan containing the exact paths and design choice. Keep edits within the confirmed application root. Generate only requested or technically required components; do not write business application artifacts into this toolkit's repository.
6. Validate source locally with the project’s available CAP/CDS tooling. `cds build --for hana` can generate the deployable HDI artifacts from a CAP model; inspect existing scripts and target CAP version before using it. Review generated `gen/db` output and do not mistake a generated artifact for the maintained source model.
7. Report changed model/source files, generated artifacts, dependencies, local checks, and any deployment/permission effects. HANA deployment is not part of this skill; hand it to `hana-cloud-validation` for review and user-run deployment instructions.

## Constraints

- Never execute `cds deploy` against HANA, `cf deploy`, HDI deployment, HANA DDL/DML SQL, undeploy, grant changes, or user/service-key administration.
- Do not store host passwords, `VCAP_SERVICES`, service keys, or HDI deployment credentials in project source, MCP configuration, generated artifacts, or logs.
- Do not claim that compilation or generated artifacts prove a live database deployment succeeded.
