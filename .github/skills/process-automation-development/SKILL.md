---
description: Inspect, test and operate SAP Build Process Automation with the sap-ai-process-automation MCP server: process definitions, workflow instances, contexts, logs and errors, stuck instances, user tasks and the user inbox, decisions, API triggers, automations, process visibility, administration jobs, process triggers and business events.
name: process-automation-development
---

# SAP Build Process Automation development

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. Call only the exact schemas exposed by the `sap-ai-process-automation` server (51 tools):

Connection
- `bpa_connection_info` — `api_host`, `uaa_host`, `auth`, `source`, `task_attribution`, `api_key_configured`, `environment_id`; `verify: true` checks Workflow API access.

Workflow definitions
- `bpa_list_process_definitions`, `bpa_get_process_definition` — deployed definitions with optional `model`, `sample_start_context`, `versions`.
- `bpa_list_task_definitions` — user-task definitions, optionally with attribute definitions.
- `bpa_delete_process_definition` — undeploy a classic workflow definition (async, `job_id`); requires confirmation `DELETE BPA DEFINITION <definition_id>`.
- `bpa_delete_form` — undeploy a classic form; requires confirmation `DELETE BPA FORM <form_id>`.

Instances
- `bpa_list_instances` — filtered by definition, status (repeated = OR), business key, text, subject, starter, time ranges, root/parent, project.
- `bpa_get_instance` — includes `context` (or `context_path`), `outputs`, `execution_logs`, `error_messages`, `attributes`, `roles`.
- `bpa_find_stuck_instances` — erroneous (with error messages), suspended, and long-running instances.
- `bpa_trace_process` — instances by id, business key, or text with error messages, tasks, and recent logs.
- `bpa_start_instance` — requires confirmation `START BPA PROCESS <definition_id>`.
- `bpa_change_instance_status` — actions `cancel`, `suspend`, `resume`, `retry` require confirmation `CANCEL BPA INSTANCE <instance_id>`, `SUSPEND BPA INSTANCE <instance_id>`, `RESUME BPA INSTANCE <instance_id>`, or `RETRY BPA INSTANCE <instance_id>`.
- `bpa_update_instance_context` — requires confirmation `MERGE BPA CONTEXT <instance_id>` or `REPLACE BPA CONTEXT <instance_id>`.
- `bpa_update_instance_roles` — requires confirmation `UPDATE BPA ROLES <instance_id>`.
- `bpa_delete_instances` — permanent, async for larger sets; requires confirmation `DELETE BPA INSTANCES <count>`.
- `bpa_send_message` — classic intermediate message events only; requires confirmation `SEND BPA MESSAGE <message_definition_id>`.

User tasks
- `bpa_list_tasks`, `bpa_get_task` — user-task queues (what My Inbox / Fiori Task Center shows) and task context/attributes.
- `bpa_complete_task` — requires confirmation `COMPLETE BPA TASK <task_id>`.
- `bpa_update_tasks` — bulk admin update (async, `job_id`); requires confirmation `UPDATE BPA TASKS <count>`.
- `bpa_update_task_context` — requires confirmation `UPDATE BPA TASK CONTEXT <task_id>`.

Administration / jobs
- `bpa_export_workflow_data` — ZIP export to a new local file.
- `bpa_purge_workflow_data` — erases all workflow data of the tenant (async); requires confirmation `PURGE ALL BPA WORKFLOW DATA`.
- `bpa_get_job` — status of an asynchronous workflow job.

Inbox (user-centric)
- `bpa_inbox_list_tasks`, `bpa_inbox_get_task`, `bpa_inbox_list_task_definitions`, `bpa_inbox_list_substitution_rules` — read the signed-in user's inbox.
- `bpa_inbox_task_action` — requires confirmation `CLAIM BPA INBOX TASK <instance_id>`, `RELEASE BPA INBOX TASK <instance_id>`, or `FORWARD BPA INBOX TASK <instance_id>`.
- `bpa_inbox_create_substitution_rule` — requires confirmation `CREATE BPA SUBSTITUTION FOR <user>`.
- `bpa_inbox_change_substitution_rule` — requires confirmation `ENABLE BPA SUBSTITUTION <rule_id>`, `DISABLE BPA SUBSTITUTION <rule_id>`, or `DELETE BPA SUBSTITUTION <rule_id>`.

Decisions
- `bpa_invoke_decision`, `bpa_test_decision` — evaluate a deployed rule service and compare results with expected outputs.

API triggers (Unified)
- `bpa_list_api_triggers`, `bpa_get_api_trigger` — process API triggers of an environment.
- `bpa_execute_api_trigger` — start a process, or resume a "Wait for an API Call" step with `execution_id`; requires confirmation `EXECUTE BPA TRIGGER <trigger_uid>`.

Automations (execution + monitoring; environment API key required)
- `bpa_list_automation_triggers`, `bpa_get_automation_trigger`, `bpa_list_automation_jobs` — automation triggers and their jobs.
- `bpa_start_automation` — requires confirmation `START BPA AUTOMATION <trigger_uid>`.
- `bpa_export_automation_data` — BAM data or archived jobs as CSV, inline or to a new local file.

Visibility scenarios
- `bpa_list_visibility_scenarios`, `bpa_get_visibility_scenario` — scenario definitions, model, recent executions.
- `bpa_list_visibility_events` — acquired events, or `kind: errors` for data-acquisition errors.
- `bpa_process_visibility_scenario` — requires confirmation `PROCESS BPA VISIBILITY <scenario_id>`.
- `bpa_clear_visibility_data` — requires confirmation `CLEAR BPA VISIBILITY DATA <scenario_id>`.
- `bpa_push_visibility_events` — requires confirmation `PUSH BPA VISIBILITY EVENTS <count>`.

Visibility workspace
- `bpa_list_visibility_workspace_scenarios`, `bpa_list_visibility_instances`, `bpa_get_visibility_instance` — scenario instances with phases, paths and steps.

Business events
- `bpa_send_business_event` — requires confirmation `SEND BPA EVENT <type>`.

## Procedure

1. Call `bpa_connection_info` first. Compare API host, `auth`, `task_attribution`, `api_key_configured`, and `environment_id` against the request. If the target is missing or mismatched, stop and report; never ask the user to paste credentials.
2. Query live `tools/list`, use the returned tool names and schemas exactly, and invoke the chat-attached tools directly. Direct MCP invocation is mandatory. Do not launch `sap-ai-dev` or `sap-ai-process-automation` for MCP operations, handcraft JSON-RPC in a terminal, or use a CLI fallback when chat tools are unavailable; report a host/session binding issue. Always call the exact names returned by `tools/list`.
3. Inspect: `bpa_list_process_definitions`, `bpa_get_process_definition` (`sample_start_context` before a start), `bpa_list_instances`, `bpa_get_instance`, `bpa_list_tasks`, `bpa_get_task`; for a user's view, `bpa_inbox_list_tasks` under interactive auth.
4. Diagnose stuck or erroneous instances with `bpa_find_stuck_instances` and `bpa_get_instance` (`error_messages`, then `execution_logs`/`context`). Fix the cause first (if data is wrong: suspend, `bpa_update_instance_context`), then `bpa_change_instance_status` with action `retry`.
5. Test decisions with `bpa_test_decision`, giving explicit `expected` outputs per case; use `bpa_invoke_decision` to inspect raw results. Rule-service ids come from the deployed project; there is no list API.
6. Start a process with `bpa_start_instance`, `bpa_execute_api_trigger`, or event-trigger it with `bpa_send_business_event`, using a test payload. Resume a process waiting in a "Wait for an API Call" step with `bpa_execute_api_trigger` and `execution_id` (the process instance id); `bpa_send_message` only serves classic workflows.
7. API-key-gated tools: `bpa_list_automation_triggers`, `bpa_get_automation_trigger`, `bpa_list_automation_jobs`, `bpa_start_automation`, and `bpa_export_automation_data` fail before any tenant call when `api_key_configured` is false; ask the user to set `PROCESS_AUTOMATION_API_KEY` or rerun `sap-ai-dev --setup-process-automation`. Unified API trigger tools and `bpa_start_instance` send the key only when configured and default `environment_id` to `PROCESS_AUTOMATION_ENVIRONMENT_ID`.
8. Visibility troubleshooting: when a scenario dashboard misses data, check `bpa_get_visibility_scenario` with `include: ["executions"]`, then `bpa_list_visibility_events` with `kind: "errors"` (data-acquisition errors) and `kind: "events"` for the process instance; reprocess with `bpa_process_visibility_scenario` once fixed and verify with `bpa_list_visibility_instances` / `bpa_get_visibility_instance`.
9. Track asynchronous operations (definition undeploy, purge, bulk instance delete, bulk task update) through the returned `job_id` with `bpa_get_job` until it finishes.
10. Trace the result with `bpa_trace_process` (by instance id, business key, or text) and verify statuses, tasks, and logs.

## Rules

- Technical auth attributes starts, status changes, and task completions to the service key's technical client. User auth needs the `ProcessAutomationAdmin` role collection for administration or `ProcessAutomationParticipant` (as task recipient) for task completion and the inbox.
- Workflow API status filters are sent as repeated parameters and are OR-combined; other filters are AND-combined. Task statuses are `READY`, `RESERVED`, `COMPLETED`, `CANCELED`.
- The Inbox (TCM OData) is user-centric: with technical auth it shows the technical client's inbox (normally empty); use interactive auth for a real user's inbox.
- Automation Execution/Monitoring need an environment API key (`irpa-api-key`) with scopes `TRIGGER_READ`, `TRIGGER_EXECUTE`, `BAM_DOWNLOAD`, or `JOB_DATA_DOWNLOAD` as required by the tool. Unified API triggers optionally use `api-key` plus `environmentId`.
- Visibility roles: `PVAdmin` (scenario definitions, executions, clear data, acquisition reads), `PVEventSender` (push events), `PVOperator`/`PVRestrictedOperator` (workspace instances).
- Exports (`bpa_export_workflow_data` ZIP, `bpa_export_automation_data` CSV) write to a new local file: absolute path, never overwritten, mode 0600.
- `bpa_complete_task` `decision` is the form button identifier.
- Context payloads over 48 KiB are truncated (`context_truncated: true` with keys); call `bpa_get_instance` with a single include or a `context_path` to narrow the response.
- Interactive (user) mode withholds SAP error bodies, so read the HTTP status:
  - 400: task already in final status
  - 403: missing ProcessAutomationAdmin/ProcessAutomationParticipant role or not the task recipient
  - 404: unknown id
  - 409: `decision` is not a button id of the form
  - 422: invalid status transition

  Technical mode shows SAP's error message.

## Safety boundaries

- Writes are confirmation-gated only: never call a write tool without its exact confirmation string, and never guess one.
- `bpa_purge_workflow_data`, `bpa_delete_instances`, and `bpa_delete_process_definition` are destructive and irreversible: never run them without explicit user instruction naming the scope.
- Never store credentials in `mcp.json` or echo secrets (client secrets, refresh tokens, access tokens, API keys) into results, files, or chat.
- Never complete tasks, forward inbox tasks, or create substitution rules that represent real approvals without explicit user instruction.
- Do not invent tools or handcraft JSON-RPC; if a needed tool is absent from `tools/list`, report a host/session binding issue.
