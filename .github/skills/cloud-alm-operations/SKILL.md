---
description: Monitor, triage and track SAP landscapes with the sap-ai-cloud-alm MCP server: Integration & Exception Monitoring records and analytics, health and alert hotspots per DEV/TEST/PROD tier, incident triage correlated with CPI message processing logs and ABAP SLG1 logs, feature and transport deployment status, and confirmation-gated event situation closing.
name: cloud-alm-operations
---

# SAP Cloud ALM operations

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. Call only the exact schemas exposed by the `sap-ai-cloud-alm` server (11 tools):

Connection and landscape
- `calm_connection_info` — `api_host`, `token_host`, `auth`, `source`; `verify: true` checks Landscape and Analytics API access.
- `calm_list_landscape` — landscape objects with `lmsId` (the `serviceId` of every other API), `role`, `serviceType`, `systemNumber`, `logicalSystems`; filters by object type, role, service type, name, system number, LMS id, external id.
- `calm_get_landscape_health` — exceptions (EXM), critical/warning Health Monitoring metrics and EVENTS alerts per service, grouped into role tiers; at most 30 services, 1 to 744 hours.

Records and triage
- `calm_list_monitoring_records` — Raw Data Outbound Logs for `im`, `exm.im`, `exm.jam`, `iep`, `jam.run`, `bsm`; `next_offset` paging.
- `calm_triage_incident` — alert counts, `iep` events, `exm.im` errors, optional `im` messages for one service, plus `handoff` arguments for `cpi_list_message_logs` and `get_application_log`.

Analytics
- `calm_list_analytics_providers` — authorized providers.
- `calm_describe_analytics_provider` — dimensions, measures, attributes, or one attribute's values.
- `calm_query_analytics` — one query, aggregated with `sum` / `max` or raw per time bucket (`none`).

Deployment
- `calm_list_features` — features with status, priority, project, release and transport ids.
- `calm_get_feature` — one feature by `feature_uuid` or `display_id`, or the features linked to a `transport_id`.

Event situations
- `calm_close_event_situation` — closes an alert (and mapped tickets unless `notify_ticketing: false`); requires confirmation `CLOSE CALM EVENT SITUATION <event_situation_id>` or `CLOSE CALM EVENT SITUATION BY EXTERNAL ID <external_id>`.

## Setup and scopes

- Create an instance of the BTP service "SAP Cloud ALM API", plan `standard`, in the Cloud ALM subaccount, and a binding (service key) that carries `uaa.clientsecret` (credential type `binding-secret`; x509 bindings are rejected). The key's `endpoints.Api` is the API base URL including `/api`.
- Grant the scopes the tools need as instance `authorities`:
  - `calm-api.landscape.read`
  - `calm-api.analytics.read`
  - `calm-api.analytics.providers.read`
  - `calm-api.exm.read`
  - `calm-api.exm.personal.read`
  - `calm-api.integration-monitoring.read`
  - `calm-api.integration-monitoring.personal.read`
  - `calm-api.hm.read`
  - `calm-api.iep.read`
  - `calm-api.jobs.read`
  - `calm-api.bsm.read`
  - `calm-api.logs.read`
  - `calm-api.features.read`
  - `calm-api.event-situations.write` (only for closing alerts)
- Example instance parameters:

  ```json
  {
    "xs-security": {
      "xsappname": "<instance-name>",
      "authorities": [
        "$XSMASTERAPPNAME.calm-api.landscape.read",
        "$XSMASTERAPPNAME.calm-api.analytics.read",
        "$XSMASTERAPPNAME.calm-api.logs.read",
        "$XSMASTERAPPNAME.calm-api.exm.read",
        "$XSMASTERAPPNAME.calm-api.integration-monitoring.read",
        "$XSMASTERAPPNAME.calm-api.hm.read",
        "$XSMASTERAPPNAME.calm-api.iep.read",
        "$XSMASTERAPPNAME.calm-api.features.read"
      ],
      "oauth2-configuration": { "credential-types": ["binding-secret", "x509"] }
    }
  }
  ```

  When updating an existing instance, use the instance GUID as `xsappname`.
- Configure with `sap-ai-dev --setup-cloud-alm` (stored for the user only), or `CLOUD_ALM_SERVICE_KEY` / `CLOUD_ALM_URL` + `CLOUD_ALM_TOKEN_URL` + `CLOUD_ALM_CLIENT_ID` + `CLOUD_ALM_CLIENT_SECRET` in the MCP host environment. Only client credentials are supported.

## Procedure

1. **Hotspots.** `calm_connection_info` (`verify: true`), `calm_list_landscape` to learn the role values, then `calm_get_landscape_health` with those `roles`.
2. **Records.** `calm_list_monitoring_records` on the hot services: `exm.im` for exceptions, `im` with category labels for message flows, `iep` for monitoring events, `jam.run` for jobs.
3. **Triage.** `calm_triage_incident` for the affected service and window.
4. **Correlate.** Follow the CPI and ABAP hops below with the returned `handoff`.
5. **Deployment check.** `calm_list_features` / `calm_get_feature`, plus `calm_get_landscape_health` on the target tier before and after the deployment window.
6. **Optional close.** `calm_close_event_situation` only on explicit request after the cause is fixed.

## Analytics recipes

Pass these to `calm_query_analytics` (`provider`, `dimensions`, `measures`, `filters`). Filter values such as status groups are tenant data: discover them with `calm_describe_analytics_provider` (for example `attribute: "StatusGroup"`).

| Goal | Provider | Dimensions | Measures | Notes |
|---|---|---|---|---|
| CPI messages per iFlow and status | `CPI_MESSAGES` | `IntegrationArtifactName`, `StatusGroup` (also `ServiceName`, `serviceId`, `Status`) | `Count` | `aggregate: "sum"` |
| IDocs | `IDOC` | `MessageType`, `Direction`, `Status Group` (also `Sender Port`, `Receiver Port`, `Mandant`) | `Count` | `aggregate: "sum"` |
| Web service messages | `WS` | `Sender Interface Name`, `Receiver Interface Name`, `Direction`, `Status Group` | `Count` | `aggregate: "sum"` |
| AIF messages | `AIF` | `Namespace`, `Interface`, `StatusGroup` (also `Direction`, `Category`, `Version`, `Status`) | `Count` | `aggregate: "sum"` |
| Exceptions per category | `EXM_DATAPROVIDER` | `serviceId`, `categoryName` (also `serviceType`, `serviceName`, `categoryId`, `useCase`) | `counter` (`method: "SUM"`) | `serviceId` filter is multi-select |
| Health metrics | `HM_ANALYTICS_DP` | `metricName` (also `metricId`, `metricLabel`) | `criticalStatus`, `warningStatus`, `okStatus`, `value`, `limit`, `usage` | `serviceId` filter is single-select; status measures are percentages, use `aggregate: "max"` |
| Monitoring events and alerts | `EVENTS` | `useCase`, `eventName` | `events`, `alerts`, `eventSituations`, `tickets`, `mails`, `chatMessages`, `operationFlows`, `totalDuration` | a filter is mandatory (HTTP 428 without one); use a single `serviceId` |

Other Integration Monitoring providers: C4C, MDI, SF, FG, Concur, Ariba_Sourcing, Ariba_Procurement, Ariba_CIG, Ariba_Network, Mob_Srv. Message and exception counts use `aggregate: "sum"`; Health Monitoring status measures use `aggregate: "max"`. Analytics answers at most 5000 rows per query; `truncated: true` means narrow the window, filters or dimensions.

## Records rules

- Windows are at most 60 minutes for every provider except `bsm` (up to 31 days). Use analytics for longer windows.
- `im` needs `categories`: the labels shown in the Integration Monitoring UI (for example "SAP Integration Suite Messages", "IDoc", "Web Service Messages", "AIF").
- `iep` and `bsm` take exactly one service id; `jam.run` at most 27; the rest at most 30.
- `iep` records exist only when the event action "Store Event Payload for 24 Hours" is active for the monitoring event.
- Page with `next_offset`; `total_count` comes from the `x-total-count` header when SAP sends it.
- Record attribute names are passed through exactly as delivered; read them from the result instead of assuming a schema.

## Correlation guide

- **CPI hop.** Check that the Integration Suite companion's `integration_connection_info` host belongs to the same tenant as the Cloud ALM service (`mainUrl` / name). Then call `cpi_list_message_logs` with `handoff.cpi.arguments` (status FAILED, then RETRY/ESCALATED), and drill into `cpi_get_message_log`, `cpi_get_message_log_steps` and `cpi_trace_message` with message ids from `im` records or the MPL list.
- **ABAP hop.** Check with `get_system_info` / `get_connection_info` that the ABAP destination's SID equals `handoff.abap.system` and its client is in `handoff.abap.clients`. Then call `get_application_log` with `handoff.abap.arguments` and narrow it with `object`, `subobject`, `user` or `program` from the `exm.im` record attributes. SLG1 dates are server-local, so the handoff pads the UTC window by one day on each side; compare record timestamps, not dates.
- **Failed RFCs.** Health Monitoring "Communication" metrics (tRFC CPICERR/SYSFAIL, qRFC IN/OUT errors, bgRFC errors, RFC Connection Status) plus `exm.im` ABAP Runtime exceptions on the same system.
- **Event Mesh.** Health Monitoring broker metrics (Event Mesh broker statistics, Advanced Event Mesh broker metrics, CPI JMS queues); Integration & Exception Monitoring has no Event Mesh category. Use the Integration Suite companion's `event_mesh_get_queue` / `aem_*` tools for live queue state when configured.

## Deployment rules

- Feature transports (`toTransports`, `toTransportReferences`) carry transport ids only. No public Cloud ALM API exposes per-system import status: never claim a transport reached TEST or PROD from Features data.
- Feature status codes: CREATED, NOT_PLANNED, IN_REALIZATION, IN_TESTING, SUCCESSFULLY_TESTED, APPROVED_FOR_DEPLOYMENT, CONFIRMED.
- Observed `im` records for a CPI service are the "observed collection" evidence that the Integration Suite companion's `integration_monitoring_readiness` asks for.

## HTTP meanings

- 403: the instance lacks the API's `calm-api.*` scope.
- 428: a mandatory filter is missing (EVENTS analytics without a filter).
- 429: rate limit (analytics and logs allow 100 requests per minute).
- 413: request too large; narrow the query.
- On close, an "already closed" error right after a gateway error means the earlier close took effect: PUT is retried on 5xx.

## Safety boundaries

- The only write is `calm_close_event_situation`, and only with its exact confirmation string on explicit user request; never guess an event situation id.
- Never store credentials in `mcp.json` or echo secrets (client secrets, tokens) into results, files or chat.
- Records may hold personal data (users, business payload values); quote only what the diagnosis needs.
- Do not invent tools or handcraft JSON-RPC; if a needed tool is absent from `tools/list`, report a host/session binding issue.
