---
name: hana-cloud-inspection
description: Inspect SAP HANA Cloud HDI containers and schemas using the read-only HANA MCP server. Use for connection verification, catalog inventory, table/view metadata, and bounded data investigation.
---

# HANA Cloud inspection

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. Call only the exact schemas exposed by the HANA inspector:

- `hana_connection_info` verifies the configured endpoint, bound schema, current user, and TLS state without returning a password.
- `hana_list_objects` lists tables and views in the bound HDI schema.
- `hana_describe_object` returns columns for an object in that schema.
- `hana_read_rows` reads selected catalog-verified columns with parameterized filters and a hard 200-row limit.

For the ABAP destination server, `RunQuery` is ABAP SQL—not HANA SQL. Use destination-prefixed tools only when that separate server exposes them.

## Procedure

1. Confirm the user’s requested system/container and expected schema. Do not assume a binding name uniquely identifies a database.
2. Query live `tools/list`, use the returned tool names and schemas exactly, and invoke the chat-attached tools directly. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-hana` for MCP operations, handcraft JSON-RPC in a terminal, or fall back to a CLI when chat tools are missing; report a host/session binding issue. Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them lowercase and snake_case under the `<destination>_` prefix, so `GetSource` on destination `DEMO_ABAP` appears as `demo-abap_get_source`. Always call the exact names returned by `tools/list`.
3. Call `hana_connection_info` first. Compare endpoint, binding, schema, and current user against the request. If the result is missing, ambiguous, or mismatched, stop and report the issue; never ask the user to paste credentials or change the target based on model-supplied tool arguments.
4. Inventory only relevant objects using `hana_list_objects`. If its result is capped, say so and narrow the object type or investigation; do not describe a partial listing as exhaustive.
5. Call `hana_describe_object` before reading values. Select only required columns. Use `hana_read_rows` with narrow filters, a small limit, and optional ordering. Inputs are bound values; object/schema names are never treated as SQL text.
6. Report actual endpoint/schema evidence, object/column names, filters, returned row count, caps, and access errors. Minimize returned personal or sensitive data; summarize or aggregate only with tools/queries the live schema actually permits.

## Safety boundaries

- The configured target/schema is schema-bound server-side. Do not try to select another host, database, tenant, or schema.
- The server does not accept arbitrary SQL and offers no DDL, DML, procedure-call, deployment, undeploy, grant, or service-key tools. Do not invent such tools or use the ABAP `RunQuery` as a substitute.
- The row-read tool rejects credential-like columns (password, secret, token, API-key, private-key, and credential names), including when used as filters or sort keys.
- The process must receive a dedicated HANA read-only identity via `HANA_RO_*` or an unambiguous `VCAP_SERVICES` binding. Never use `hdi_user`/`hdi_password` as a fallback or expose binding contents.
- Tool annotations and agent instructions are not authorization controls. Database grants remain the write barrier.
- If no HANA MCP server is attached, limit work to local project inspection and clearly state that no live HANA inspection occurred.
