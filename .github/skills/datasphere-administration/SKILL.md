---
description: Administer SAP Datasphere through the sap-ai-datasphere MCP server: spaces and space users, database users, workload priorities, global and scoped roles, users, connections, TLS certificates, and task-scheduling consent.
name: datasphere-administration
---

# SAP Datasphere administration

## Tool shortlist

- `datasphere_connection_info` — auth mode and `admin_commands_available` (true only with Interactive Usage auth).
- `datasphere_list_commands` — every CLI command with `usable_with_current_auth` per command; filter with a `prefix`.
- `datasphere_describe_command` — authoritative option list for one command.
- `datasphere_run_read_command` — read-only commands.
- `datasphere_run_command` — any command; write commands require confirmation `RUN DATASPHERE <command>`, deletions `DELETE DATASPHERE <command>`.
- `datasphere_list_connections`, `datasphere_validate_connection` — typed connection tools.
- `datasphere_list_task_logs`, `datasphere_get_task_log` — task-log reads for consent/scheduling checks.

## Procedure

1. Call `datasphere_connection_info` and confirm `admin_commands_available` is true (Interactive Usage auth). Technical-user (client credentials) OAuth clients can run only `configuration certificates`, `marketplace`, `objects`, `spaces connections`, and `tasks` commands; everything else needs Interactive Usage auth. If admin commands are unavailable, report the limitation instead of attempting them.
2. Query live `tools/list`, use the returned tool names and schemas exactly, and invoke the chat-attached tools directly. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-datasphere` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue. Tool names shown in PascalCase (such as `GetTable` or `RunQuery` on the ABAP destination server) are logical names; the live MCP surface exposes them as lowercase snake_case. Always call the exact names returned by `tools/list`.
3. Discover commands with `datasphere_list_commands` using a prefix: `spaces`, `dbusers`, `workload`, `global-roles`, `scoped-roles`, `users`, `spaces connections`, `configuration certificates`, `tasks consent`. Check `usable_with_current_auth` before planning.
4. `datasphere_describe_command` on the chosen command for its exact options and whether it takes a request body.
5. `datasphere_run_read_command` to read the current state before changing anything (for example the current space definition, database-user list, role assignments, or users).
6. `datasphere_run_command` with the exact confirmation `RUN DATASPHERE <command>` (or `DELETE DATASPHERE <command>` for deletions). Pass JSON definitions (space definitions, role/user lists, connection definitions) in `input`, never spread across options.
7. Read back the changed entity with `datasphere_run_read_command` and report before/after evidence.

## Rules

- JSON definitions go in `input`: space definitions, role/user lists, and connection definitions with credentials. Never echo credentials or secrets back into chat or files.
- Database-user passwords are redacted in results; the user reads them in the Datasphere UI. Do not attempt to work around this.
- For SQL access, configure `DATASPHERE_SQL_*` via `sap-ai-dev --setup-datasphere`; the SQL tools are bound to that database user's grants.
- Prefer the narrowest command that achieves the change; do not blanket-update lists when a single-member change command exists.

## Safety boundaries

- Never run a write or delete command without its exact confirmation string (`RUN DATASPHERE <command>` / `DELETE DATASPHERE <command>`).
- Never store credentials in `mcp.json` and never echo secrets, connection credentials, or tokens into results or chat; results pass through server-side redaction — do not reconstruct redacted values.
- Administrative scope is bounded by the OAuth client's authorizations; do not attempt privilege escalation or role self-assignment.
- Do not invent commands; every command must appear in `datasphere_list_commands` and be described by `datasphere_describe_command` before use.
