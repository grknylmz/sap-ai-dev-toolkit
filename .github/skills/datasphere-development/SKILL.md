---
description: Model, deploy, load and verify SAP Datasphere content with the sap-ai-datasphere MCP server: CSN objects of every type, packages, task chains, replication flows, data products, consumption queries and Open SQL.
name: datasphere-development
---

# SAP Datasphere development

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. Call only the exact schemas exposed by the `sap-ai-datasphere` server:

- `datasphere_connection_info` — tenant host, token host, auth mode, CLI version, SQL configuration, and `admin_commands_available` (interactive auth).
- `datasphere_list_spaces`, `datasphere_list_assets`, `datasphere_get_asset_metadata` — consumption catalog inventory.
- `datasphere_list_objects`, `datasphere_read_object` — design-time and run-time object content per space and object type.
- `datasphere_create_object` — requires confirmation `CREATE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>`.
- `datasphere_update_object` — requires `expected_changed_on` from the last list result and confirmation `UPDATE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>`.
- `datasphere_delete_object` — requires confirmation `DELETE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>`.
- `datasphere_export_package` — requires confirmation `EXPORT DATASPHERE PACKAGE <SPACE>.<TECHNICAL_NAME>`.
- `datasphere_list_task_logs`, `datasphere_get_task_log` — task log listing and detail.
- `datasphere_run_task_chain` — requires confirmation `RUN DATASPHERE TASK CHAIN <SPACE>.<TASK_CHAIN>`.
- `datasphere_retry_task_chain` — requires confirmation `RETRY DATASPHERE TASK CHAIN <SPACE>.<TASK_CHAIN>`.
- `datasphere_cancel_task_chain` — requires confirmation `CANCEL DATASPHERE TASK CHAIN RUN <SPACE>.<LOG_ID>`.
- `datasphere_replication_flow` — actions `run`, `pause`, `resume`, `stop`, `pause-object`, `resume-object`, `restart-object` require confirmation `<ACTION> DATASPHERE REPLICATION FLOW <SPACE>.<TECHNICAL_NAME>`; action `status` needs no confirmation.
- `datasphere_list_connections`, `datasphere_validate_connection` — connection inventory and validation.
- `datasphere_list_data_providers`, `datasphere_list_data_products`, `datasphere_read_data_product`, `datasphere_create_data_product` (confirmation `CREATE DATASPHERE DATA PRODUCT`), `datasphere_set_data_product_status` (confirmation `SET DATASPHERE DATA PRODUCT <UUID> <Listed|Delisted|Deactivated>`), `datasphere_install_data_product` (confirmation `INSTALL DATASPHERE DATA PRODUCT <UUID> INTO <SPACE>`) — Data Marketplace.
- `datasphere_query_relational`, `datasphere_query_analytical`, `datasphere_reconcile` — consumption queries and baseline reconciliation.
- `datasphere_build_local_table_csn` — pure CSN generation for local tables from DDIC-typed field lists.
- `datasphere_list_commands`, `datasphere_describe_command`, `datasphere_run_read_command`, `datasphere_run_command` — every remaining (and future) CLI function; `datasphere_run_command` requires `RUN DATASPHERE <command>` (or `DELETE DATASPHERE <command>` for deletions).
- `datasphere_sql_query`, `datasphere_sql_execute` — Open SQL on the configured database user's schema; `datasphere_sql_execute` requires confirmation `EXECUTE DATASPHERE SQL AS <USER>` and is available only when Open SQL is configured.

## Procedure

1. Call `datasphere_connection_info` first. Compare tenant host, auth mode, and SQL configuration against the request. Technical-user (client credentials) OAuth clients can run only `configuration certificates`, `marketplace`, `objects`, `spaces connections`, and `tasks` commands; everything else needs Interactive Usage auth (`admin_commands_available` in the result). If the target is missing or mismatched, stop and report; never ask the user to paste credentials.
2. Query live `tools/list`, use the returned tool names and schemas exactly, and invoke the chat-attached tools directly. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-datasphere` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue. Tool names shown in PascalCase (such as `GetTable` or `RunQuery` on the ABAP destination server) are logical names; the live MCP surface exposes them as lowercase snake_case. Always call the exact names returned by `tools/list`.
3. Inventory the target space with `datasphere_list_objects`, then `datasphere_read_object` of an existing object of the same type as a template before authoring anything new.
4. Write CSN definitions locally under `datasphere/<SPACE>/<object-type>/<TECHNICAL_NAME>.json`. One CSN file per object; dependencies (tables before views, views before analytic models, models before task chains) come first. Use `datasphere_build_local_table_csn` for local tables.
5. Create or update with `datasphere_create_object` / `datasphere_update_object`. Take `expected_changed_on` from the most recent list result; if the object changed since, re-read before updating. Provide the exact confirmation string.
6. Check `read_back.status` in the create/update result equals `Deployed`. If not, read task logs with `datasphere_list_task_logs` / `datasphere_get_task_log` and fix the reported `DesignTimeError`, then update again.
7. Run loads: `datasphere_run_task_chain` (or `datasphere_replication_flow` with action `run`), then poll `datasphere_get_task_log` / `datasphere_list_task_logs` or replication-flow `status` until the run finishes.
8. Verify data with `datasphere_query_relational` / `datasphere_query_analytical` and reconcile expected figures with `datasphere_reconcile`.

## Rules

- Consumption queries require assets to be exposed for consumption; `datasphere_list_assets` shows only exposed assets.
- `$count`, `$top`, and `$skip` are unsupported when the asset's lineage contains non-replicated sources.
- Analytic models support analytical requests only (`datasphere_query_analytical`); relational requests are for relational assets.
- Technical users cannot run task chains containing BW bridge process chains.
- For anything without a typed tool, use `datasphere_list_commands` to find the command (`usable_with_current_auth` per command), `datasphere_describe_command` for its exact options, then `datasphere_run_read_command` for reads or `datasphere_run_command` (with `input` for JSON definitions) for writes.

## Safety boundaries

- Writes are confirmation-gated only: never call `datasphere_create_object`, `datasphere_update_object`, `datasphere_delete_object`, `datasphere_export_package`, `datasphere_run_task_chain`, `datasphere_retry_task_chain`, `datasphere_cancel_task_chain`, `datasphere_replication_flow` (write actions), `datasphere_create_data_product`, `datasphere_set_data_product_status`, `datasphere_install_data_product`, `datasphere_run_command`, or `datasphere_sql_execute` without the exact confirmation string.
- Never store credentials in `mcp.json` or echo secrets (client secrets, refresh tokens, database-user passwords) into results, files, or chat.
- SQL tools are bound to the configured database user's grants; that user's privileges are the real boundary, not these instructions.
- Do not invent tools or handcraft JSON-RPC; if a needed tool is absent from `tools/list`, report a host/session binding issue.
