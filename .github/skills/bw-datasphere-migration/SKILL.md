---
description: Plan and run SAP BW to SAP Datasphere migrations: inventory BW models through the ABAP destination server, choose the Data Product Generator or rebuild path, map objects, baseline BW figures, and reconcile results in Datasphere.
name: bw-datasphere-migration
---

# SAP BW to Datasphere migration

## Path decision

The Data Product Generator (DPG) path requires a Datasphere tenant that is part of an SAP Business Data Cloud formation and BW 7.5 on HANA SPS24+ or BW/4HANA 2021 SPS04+ / BW/4HANA 2023. DPG providers: InfoObject, (a)DSO, CompositeProvider, MultiProvider, InfoCube, and Query as InfoProvider. If these conditions do not hold, use the rebuild path. When tenant formation or BW release is unknown, ask before choosing.

## BW inventory

The BW side is strictly read-only through the ABAP destination MCP server (`GetTable`, `GetTableContents`, `RunQuery`, `SearchObject`). Call `GetTable` on each metadata table FIRST and use only the returned fields; `RunQuery` is ABAP SQL, not HANA SQL.

- `RSOADSO` / `RSOADSOT` — aDSOs (`ADSONM`, `OBJVERS = 'A'`)
- `RSOHCPR` — CompositeProviders (`HCPRNM`, `XML_DEF`)
- `RSDCUBE` — InfoCubes
- `RSDODSO` — classic DSOs
- `RSDIOBJ` / `RSDIOBJT` — InfoObjects (`IOBJNM`, `IOBJTP`)
- `RSDKYF` — key figures (aggregation)
- `RSTRAN` — transformations (`TRANID`, `SOURCETYPE`, `SOURCENAME`, `TARGETTYPE`, `TARGETNAME`)
- `RSBKDTP` — DTPs (`DTP`, `SRC`, `SRCTP`, `TGT`, `TGTTP`)
- `RSRREPDIR` — BEx queries (`COMPID`, `INFOCUBE`)
- `RSPCCHAIN` — process chains (`CHAIN_ID`, `TYPE`, `VARIANTE`)
- `RSDS` — DataSources

Physical tables: aDSO active data `/BIC/A<ADSO>2`, classic DSO active `/BIC/A<DSO>00`, InfoObject master data `/BIC/P<IOBJ>`, texts `/BIC/T<IOBJ>` (`/BI0/` prefix for SAP-delivered objects). CSN field lists come from `GetTable` on the physical table.

## Mapping

| BW object | Rebuild path | DPG path |
|---|---|---|
| aDSO | local table (+ fact view) | Local Table (File) in the BW inbound space |
| InfoObject with master data | dimension local table + text/hierarchy views | Local Table (File); loading stays in BW |
| key figure | measure (aggregation from `RSDKYF`) | measure from provider |
| CompositeProvider | fact view | Local Table (File) |
| BEx query | analytic model | Local Table (File) |
| transformation / DTP | transformation flow or data flow | loading stays in BW |
| DataSource load | replication flow over an existing SAP BW / SAP ABAP connection | loading stays in BW |
| process chain | task chain | loading stays in BW |
| analysis authorizations | data access controls | data access controls |

## Procedure

1. Confirm scope, chosen path, the BW destination server, and the Datasphere tenant (`datasphere_connection_info` with `verify: true`) and target spaces.
2. Inventory BW objects and build the dependency graph (InfoObjects → providers → transformations/DTPs → queries → process chains).
3. Create the migration worksheet `datasphere-migration/<SCOPE>/worksheet.md` and CSN files `datasphere-migration/<SCOPE>/<SPACE>/<object-type>/<TECHNICAL_NAME>.json`.
4. Baseline BW figures with `RunQuery` `SELECT COUNT(*)` and `SUM( <kf> )` using exactly the filters that will be used later in Datasphere; record them in the worksheet.
5. Execute the chosen path:
   - **5a. DPG:** give the user the subscription list (InfoProvider, tenant/BW inbound space, delta/full, schedule) to create in transaction `RSDPS` or the BW/4HANA Cockpit "Data Subscriptions" app — the toolkit has no BW subscription API. Verify landing with `datasphere_list_objects` (`local-tables`) in the inbound space, falling back to `datasphere_list_assets` / data-product tools when objects commands fail on the file space. Expose via `datasphere_list_data_providers` → `datasphere_create_data_product` (definition template from `datasphere_read_data_product`) → `datasphere_set_data_product_status` `Listed` → `datasphere_install_data_product` into the target space.
   - **5b. Rebuild:** create objects in dependency order (tables → flows → views → analytic models → task chains) with `datasphere_build_local_table_csn` + `datasphere_create_object`; deploy each and fix `DesignTimeError`s before continuing.
6. Load with `datasphere_run_task_chain` (confirmation `RUN DATASPHERE TASK CHAIN <SPACE>.<TASK_CHAIN>`) or `datasphere_replication_flow` action `run` (confirmation `RUN DATASPHERE REPLICATION FLOW <SPACE>.<TECHNICAL_NAME>`); poll `datasphere_get_task_log` / `datasphere_list_task_logs` and replication-flow `status`.
7. Reconcile with `datasphere_reconcile` against the BW baseline (`expected_row_count`, `measures`, same filters, tolerance 0 unless agreed).
8. Report evidence: baseline vs. actual figures, `all_within_tolerance`, deployed objects, load logs, and any deviations.

## Live MCP tooling

Query live `tools/list`, use the returned tool names and schemas exactly, and invoke the chat-attached tools directly. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-datasphere` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue. Tool names shown in PascalCase (such as `GetTable`, `GetTableContents`, `RunQuery`, or `SearchObject`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetTable` appears as `get_table`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation. Always call the exact names returned by `tools/list`.

## Safety boundaries

- BW is strictly read-only: no BW writes, no activation, no transports; only `GetTable`, `GetTableContents`, `RunQuery`, and `SearchObject` on the ABAP destination server.
- Every Datasphere write requires its exact confirmation string (`CREATE`/`UPDATE`/`DELETE DATASPHERE <object_type> <SPACE>.<TECHNICAL_NAME>`, `EXPORT DATASPHERE PACKAGE <SPACE>.<TECHNICAL_NAME>`, `RUN`/`RETRY DATASPHERE TASK CHAIN <SPACE>.<TASK_CHAIN>`, `CANCEL DATASPHERE TASK CHAIN RUN <SPACE>.<LOG_ID>`, `<ACTION> DATASPHERE REPLICATION FLOW <SPACE>.<TECHNICAL_NAME>`, `CREATE DATASPHERE DATA PRODUCT`, `SET DATASPHERE DATA PRODUCT <UUID> <Listed|Delisted|Deactivated>`, `INSTALL DATASPHERE DATA PRODUCT <UUID> INTO <SPACE>`).
- Replication-flow action `status` needs no confirmation; all other actions do.
- Never store credentials in `mcp.json` or echo secrets; report only reconciled figures and deployed-object evidence.
