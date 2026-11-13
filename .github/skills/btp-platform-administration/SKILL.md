---
description: Audit and operate SAP BTP core platform administration with the sap-ai-btp MCP server: global account hierarchy, entitlements and quotas, Service Manager service instances and service keys, destinations, identity and destination trust, Cloud Connectors and principal propagation checks.
name: btp-platform-administration
---

# SAP BTP platform administration

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. Call only the exact schemas exposed by the `sap-ai-btp` server (15 tools):

- `btp_connection_info` — btp CLI path, source and config file; `verify: true` checks the CLI version and the login session.
- `btp_get_account_hierarchy` — global account, directories and subaccounts (GUIDs, regions, states).
- `btp_list_entitlements` — entitlements at global-account, directory or subaccount scope.
- `btp_check_quota` — can plan P of service S be created in subaccount X (`available`, `not_entitled`, `insufficient_quota`, `assignment_not_ready`).
- `btp_list_service_instances` — Service Manager instances with offering and plan names.
- `btp_get_service_instance` — one instance with last operation, service keys and optionally redacted parameters.
- `btp_list_service_keys` — service keys (never credentials).
- `btp_get_service_key` — one key with redacted credentials.
- `btp_list_destinations` — subaccount or service-instance destinations without secret properties.
- `btp_get_destination` — one destination configuration, redacted.
- `btp_get_trust` — identity provider trusts and the destination trust certificate expiry.
- `btp_list_cloud_connectors` — connected Cloud Connectors and exposed systems via a Connectivity `api_access` instance.
- `btp_check_destination` — pass/warn/fail/unknown checks for URL, authentication properties, proxy type, trust, Cloud Connector and exposed system.
- `btp_create_service_instance` — confirmation `CREATE BTP SERVICE INSTANCE <name>`.
- `btp_create_service_key` — confirmation `CREATE BTP SERVICE KEY <name>`.

## Procedure

1. Connection: `btp_connection_info` with `verify: true`.
2. Hierarchy: `btp_get_account_hierarchy` to resolve subaccount and directory GUIDs.
3. Audit: `btp_list_entitlements`, then `btp_check_quota` for the service and plan in question.
4. Inspect: `btp_list_service_instances`, `btp_get_service_instance`, `btp_list_service_keys`, `btp_get_service_key`, `btp_list_destinations`, `btp_get_destination`, `btp_get_trust`, `btp_list_cloud_connectors`.
5. Diagnose destinations: `btp_check_destination`.
6. Confirmed create: `btp_create_service_instance` / `btp_create_service_key` with the exact confirmation string.
7. Poll and verify: `btp_get_service_instance` until `last_operation.state` is `succeeded`; `btp_get_service_key` until the key is ready.

## Rules

- Subaccount GUIDs are required on every subaccount-scoped tool; the server never uses `btp target`.
- Instances created here are Service Manager ("Other environment") instances, not bound to a Cloud Foundry space. Use `cf create-service` for CF-space instances.
- `btp_check_quota` counts the service instances of the plan in the subaccount, and only for entitlement category `SERVICE`; other categories have no numeric instance quota.
- Cloud Connector data needs a Connectivity `api_access` instance with a client-secret service key.
- Check statuses mean pass, warn, fail or unknown. `unknown` principal-propagation items (system certificate, principal-propagation CA certificate, synchronized IdP trust, X.509 principal type of the system mapping, backend certificate mapping such as CERTRULE) must be verified in the Cloud Connector administration and the backend.
- Session errors mean the user runs `btp login --sso` in their own terminal; a missing CLI means `sap-ai-dev --setup-btp` or `BTP_CLI`.
- Do not invent tools or handcraft JSON-RPC; if a needed tool is absent from `tools/list`, report a host/session binding issue.

## Safety boundaries

- Use confirmation strings verbatim; never guess or bypass them.
- Never echo or request secrets. Credentials are always redacted; full keys are fetched by the user with `btp get services/binding --name <key> --subaccount <id>`.
- Pass passwords only inside `parameters`; they are written to a private temporary file, never to the command line.
- No destructive operations: no deletions, entitlement assignments, or destination, trust or role-collection changes. Give the cockpit path or btp CLI command instead.
