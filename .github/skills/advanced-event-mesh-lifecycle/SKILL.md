---
description: Manage SAP Integration Suite, advanced event mesh (Solace) with the sap-ai-aem MCP server: event broker service create, resize, upgrade and delete with operation polling (Mission Control), SEMP v2 configuration, monitoring and actions, and Event Portal domains, applications, events, schemas, version states and AsyncAPI export.
name: advanced-event-mesh-lifecycle
---

# SAP Integration Suite, advanced event mesh lifecycle

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. Call only the exact schemas exposed by the `sap-ai-aem` server (29 tools):

- `aem_connection_info` — configured Cloud API host, SEMP broker host and VPN, and their source; `verify: true` checks both online.
- `aem_list_services` — event broker services with class, datacenter, version, states, lock flag and ongoing operations.
- `aem_get_service` — one service with broker details, endpoints, allowed actions and spool details (credentials redacted), plus its SEMP endpoint.
- `aem_list_service_classes` — available service classes.
- `aem_list_datacenters` — datacenters, optionally per environment.
- `aem_list_broker_versions` — broker versions, optionally per datacenter or only recommended.
- `aem_create_service` — confirmation `CREATE AEM SERVICE <name>`.
- `aem_update_service` — rename, change owner, lock or unlock; confirmation `UPDATE AEM SERVICE <service_id>`.
- `aem_resize_message_spool` — confirmation `RESIZE AEM SPOOL <service_id> <message_spool_size_gb>`.
- `aem_get_upgrade_status` — recommended versions, upgrade readiness and scheduled upgrades.
- `aem_upgrade_service` — confirmation `UPGRADE AEM SERVICE <service_id> TO <target_version>`.
- `aem_delete_service` — confirmation `DELETE AEM SERVICE <service_id> <service name>`; locked services are refused.
- `aem_list_operations` — operations of a service.
- `aem_get_operation` — one operation; `wait_seconds` (0-300) polls every 5 s until `terminal`.
- `aem_semp_list_objects` — SEMP config collection (`count`, `cursor`, `select`, `where`); returns `next_cursor`.
- `aem_semp_get_object` — one SEMP config object by ordered `key` parts.
- `aem_semp_create_object` — confirmation `CREATE AEM <OBJECT_TYPE> <vpn>/<key parts joined by ','>`, e.g. `CREATE AEM QUEUE default/orders`.
- `aem_semp_update_object` — confirmation `UPDATE AEM <OBJECT_TYPE> <vpn>/<key>`; for the VPN itself `UPDATE AEM MSG_VPN <vpn>`.
- `aem_semp_delete_object` — confirmation `DELETE AEM <OBJECT_TYPE> <vpn>/<key>`, e.g. `DELETE AEM BRIDGE default/b1,primary`.
- `aem_semp_monitor` — monitor state of the VPN, queues, queue messages, topic endpoints, clients, REST delivery points and consumers, bridges.
- `aem_semp_action` — confirmation `RUN AEM <ACTION> <vpn>/<key>`, e.g. `RUN AEM QUEUE_CLEAR_STATS default/orders`; for `msg_vpn_clear_stats` `RUN AEM MSG_VPN_CLEAR_STATS <vpn>`.
- `aem_portal_list` — Event Portal objects with filters, or the version states (`object_type: state`).
- `aem_portal_get` — one Event Portal object.
- `aem_portal_create` — confirmation `CREATE AEM PORTAL <OBJECT_TYPE> <attributes.name, else attributes.version>`.
- `aem_portal_update` — confirmation `UPDATE AEM PORTAL <OBJECT_TYPE> <id>`.
- `aem_portal_delete` — confirmation `DELETE AEM PORTAL <OBJECT_TYPE> <id>`.
- `aem_portal_set_version_state` — confirmation `SET AEM PORTAL STATE <id> <state_id>`.
- `aem_portal_associate_messaging_services` — confirmation `ASSOCIATE AEM PORTAL <id>`; an empty list removes all associations.
- `aem_portal_export_asyncapi` — AsyncAPI document (json or yaml, 2.5.0 or 3.0.0); over 512 KiB it is truncated.

`<OBJECT_TYPE>` and `<ACTION>` are the `object_type` or `action` value in upper case, e.g. `QUEUE_SUBSCRIPTION`, `APPLICATION_DOMAIN`, `QUEUE_DELETE_MSGS`. SEMP confirmations contain only the object's own key parts, never the parent key: subscription `orders/>` on queue `q1` in VPN `default` is `CREATE AEM QUEUE_SUBSCRIPTION default/orders/>`.

## Procedure

1. Connect: `aem_connection_info` with `verify: true`.
2. Plan: `aem_list_service_classes`, `aem_list_datacenters`, `aem_list_broker_versions`, `aem_list_services`.
3. Create and poll: `aem_create_service`, then `aem_get_operation` with `wait_seconds` until `terminal`, then `aem_get_service`.
4. Configure SEMP: `aem_semp_create_object` / `aem_semp_update_object` with `service_id`, reading back with `aem_semp_get_object`.
5. Monitor and act: `aem_semp_monitor`, then `aem_semp_action` when needed.
6. Design in Event Portal: `aem_portal_create` for domains, applications, events, schemas and versions; `aem_portal_set_version_state`.
7. Associate and export: `aem_portal_associate_messaging_services`, then `aem_portal_export_asyncapi`.
8. Upgrade and resize: `aem_get_upgrade_status`, `aem_upgrade_service`; `aem_resize_message_spool` and poll the operation.
9. Decommission: delete SEMP objects with `aem_semp_delete_object`, unlock the service with `aem_update_service` when locked, then `aem_delete_service` and poll the operation.

## Rules

- `service_id` resolves the broker's SEMP URL, VPN and management credentials from the Cloud API automatically; omit it only for the explicitly configured broker.
- Explicit `AEM_SEMP_*` credentials (or `sap-ai-dev --setup-aem` SEMP entries) are for brokers without a Cloud API token.
- Operation statuses are PENDING, INPROGRESS, SUCCEEDED and FAILED; only SUCCEEDED and FAILED are terminal.
- The public API has no service-class change; a different size means a new service.
- SEMP HTTP 529 means no session slot is free on the broker, not empty data; retry later.
- Composite keys take ordered `key` parts: bridge `[bridgeName, bridgeVirtualRouter]`, ACL exceptions `[syntax, topic]`.
- Child SEMP types need `parent`: queue_subscription (queueName), acl_*_topic_exception (aclProfileName), rest_consumer and rdp_queue_binding (restDeliveryPointName), queue_message (queueName).
- Do not invent tools or handcraft JSON-RPC; if a needed tool is absent from `tools/list`, report a host/session binding issue.

## Safety boundaries

- Never echo or request secrets; credentials in results are always redacted. Missing credentials mean the user runs `sap-ai-dev --setup-aem` in their own terminal.
- Use confirmation strings verbatim; never guess or bypass them.
- Read back after every write and report ids with their states.
