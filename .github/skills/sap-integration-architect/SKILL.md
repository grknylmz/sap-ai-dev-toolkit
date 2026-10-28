---
name: sap-integration-architect
description: Architect SAP Integration Suite solutions — choose API Management, Cloud Integration, or both; design connectivity, per-hop security, error handling, monitoring, naming and versioning; assess the live CPI/APIM tenant; and produce an approved build plan with exact tool calls.
---

# SAP Integration Architect

Use this skill to design an integration on SAP Integration Suite before anything is built: which components to use, how each hop connects and authenticates, how failures surface, and the exact build plan. Build execution follows the `integration-suite-delivery` skill (or the SAP Integration Developer agent where the harness supports agents). ABAP/RAP authoring follows `rap-service-delivery`; SAP-standard and Clean Core decisions follow `sap-standard-api-analysis` and `clean-core-extensibility`.

Tool names shown in PascalCase (such as `GetSource` or `LintABAP`) are logical names; the live MCP surface exposes them as lowercase snake_case. A server scoped to a single destination (the normal case for generated `mcp.json` entries) exposes them unprefixed, so `GetSource` appears as `get_source` and `LintABAP` as `lint_abap`; when several destinations share one server, each name is destination-prefixed with its slug for disambiguation (for example `cfd_run_query`). Always call the exact names returned by `tools/list`.

The Integration Suite companion server is never destination-prefixed. Discover its live `tools/list` and follow each returned schema. Operational tools require their own component credentials; `integration_connection_info({verify:true})` supplies the full capability catalog, native handoffs and primary sources even for unconfigured components. Use current [tool contracts](../../../tools.md), not remembered endpoints or aliases.

## 1. Requirement checklist

Consumers and providers · direction and trigger (synchronous request/reply, asynchronous, scheduled) · protocol and payload (OData V2/V4, REST, SOAP) · volume and latency · data sensitivity · authentication at every hop · error and retry expectations · environments · acceptance tests. Ask only for missing material details.

## 2. Assess before designing (read-only)

- Call `integration_connection_info({verify:true})`; record environment label, immutable bound hosts, configured components, access results and public-contract evidence. A label never switches tenants or credentials. Different environments require independently configured servers; common-subaccount identity remains unverified without authoritative evidence.
- CPI: reuse `cpi_list_packages`, `cpi_list_package_artifacts`, `cpi_list_iflows`, `cpi_get_iflow` and `cpi_get_artifact`; inspect configuration, versions, runtime and endpoints.
- APIM: reuse providers/proxies/products, inspect virtual hosts, `apim_get_api_proxy_status`, registered API documentation and `apim_inspect_api_proxy_security`.
- Traverse every relevant `{items,next_cursor}` collection with unchanged filters until verified end, or report `complete:false` and its `stop_reason`. A first page, `total:null` or missing continuation is not exhaustive inventory. Reuse matching providers, packages, iFlows and shared content instead of duplicating them.
- Inspect exact targets with `integration_inspect_dependencies`; retain `bundle_sha256`, configuration-aware `state_sha256`, literal alias/provider/KVM/certificate references and unresolved dynamic dependencies. Never expose source, configuration values or secrets in summaries.
- SAP backend: confirm on the ABAP destination server that the OData service is published (`PublishServiceBinding` belongs to RAP service delivery) and use its reported service path; check SAP-delivered APIs with `GetAPIReleaseState`.
- Distinguish absent configuration, unauthenticated, forbidden, unavailable, untested, error, empty data and unknown entitlement. HTTP 401/403/404 does not establish the missing role, activation or entitlement cause. No probe may provision services or grant roles. Core CF provisioning requires explicit setup-wizard approval; optional setup stores existing separately typed credentials only.
- Generic OData discovery is not authority to read arbitrary entities/functions or pass through raw schemas. Use only implemented safe metadata projections; monitoring never reads payloads, message bodies, secrets or source bundles. Keep artifact/source inspection explicitly in the authoring phase.

## 3. Pattern decision guide

| Need | Pattern |
|---|---|
| Expose an existing OData/REST service to consumers with a managed URL, no payload change | API Management only — API provider + API proxy |
| Mapping, routing, enrichment, protocol change, multi-call orchestration, scheduled processing | Cloud Integration only — iFlow |
| External consumers need a managed API and the backend needs mediation | API Management in front of Cloud Integration — proxy targets the iFlow endpoint |

API Management targets: an API provider (Internet for S/4HANA Cloud and SAP BTP ABAP; On-Premise through the Cloud Connector virtual host, port and location ID) with a relative path such as `/sap/opu/odata4/...`, or a fixed `https://` URL. To front an iFlow, use the iFlow endpoint URL or an Internet provider on the CPI runtime host with relative path `/http/<sender path>`.

Cloud Integration: prefer the vetted `https-request-reply-http` template (HTTPS sender → Request Reply → HTTP receiver, Internet or On-Premise). Use custom BPMN only when the template cannot express the flow, starting from a model read from an existing iFlow.

## 4. Per-hop security

| Hop | How it authenticates |
|---|---|
| Client → API Management | Include API-key or OAuth verification in `apim_create_api_proxy.policies` to protect the first deployed revision. Without policies, the client `Authorization` header is forwarded unchanged. |
| Client or APIM → Cloud Integration | OAuth token from a Process Integration Runtime `integration-flow` client with role `ESBMessaging.send`; calls without it get HTTP 401. |
| Cloud Integration → backend | Receiver authentication None, Basic, OAuth2 Client Credentials, Client Certificate or Principal Propagation; security materials are referenced by name and must already exist on the tenant. |
| API Management → backend | API providers store no credentials; use Cloud Connector principal propagation, forward the client credentials, or include `basic_auth_from_kvm` with securely populated encrypted backend credentials. |

Never request or print secrets. Configure credentials through the MCP host environment or hidden setup input. Consumer keys are provisioned by `devhub_create_application` and used privately by `apim_test_api`; OAuth verification works without DEVHUB. No credentials in plans or results.

## 5. Plan release, operations and recovery

Design the entire lifecycle, then delegate implementation to `integration-suite-delivery`:

1. Discover capabilities and exact host/object identities → reuse content → inspect dependencies and digests → approve author/configure actions. Preserve source defaults separately from fresh configured values; partial configuration restoration must stop the release.
2. Save an explicit retained iFlow version with `cpi_save_iflow_version` using fresh current-version/bundle preconditions. A patch update changes the draft, not retained history. Validate that **selected saved version** with `cpi_validate_iflow`; HTTP acceptance is not `Passed`.
3. Preview and separately approve `integration_snapshot_content` for immutable private original ZIPs/configuration. Check `integration_check_release_readiness` against exact target versions (`cpi_iflow:<id>` / `apim_proxy:<id>` keys). Readiness needs the latest matching successful validation, including configured-state digest, within its 15-minute lifetime; failed, unknown, stale or configuration-changed evidence cannot reuse an older success.
4. Separately approve selected-version deployment or native promotion. Continue an accepted deployment with `cpi_get_deployment_task` after timeout; never repeat the deploy POST. Require build/task success **and fresh runtime identity for the requested version**, not an old `STARTED`. Same-version redeploy without freshness proof remains unverified. Endpoint registration/log visibility may lag.
5. APIM create/import, routing, policy and documentation changes deploy a new revision and may replace the draft. Plan private intended-content/preserved-resource read-back separately from runtime observation and approved consumer smoke reads. Existing `DEPLOYED`, an import acceptance or a runtime URL alone proves neither the new content nor effective security. `apim_test_api` supports APIM-only issuer-pinned OAuth from a privately read named CF key; API-key mode additionally needs DEVHUB.
6. Plan bounded UTC `[from,to)` observations, at most 31 days: CPI `cpi_get_message_statistics`, MPL/run/step evidence and `cpi_get_operational_summary`; APIM aggregate/series/error-group reports with source watermark. No traffic is not healthy; incomplete sources stay explicit. Rates need complete nonzero denominators; no fabricated percentiles, consumer analytics or instantaneous-health claims.
7. Use `integration_monitoring_readiness` and native ALM/ANS evidence. An administrator owns dedicated monitoring credentials, collection/categories, Health Monitoring and thresholds/notifications. Require observed collection and separately approved synthetic notification delivery before claiming continuous monitoring verified; API access or valid rules alone is insufficient.
8. Plan incident ownership and separately approved recovery/retirement. Retained CPI rollback is exact-version deployment. Snapshot restore previews current state hashes, checks every target and restores CPI active draft/configuration only; deployment is separate. APIM ZIP restoration imports/deploys a new revision, not native retained Revert. Neither rollback nor restore reverses messages, datastores, security material, issued tokens or receiver transactions.

### Operational design recipes

- **Failed business correlation:** freeze exact message/business identifiers and UTC window; use exact MPL filters and `cpi_trace_message`, enumerate runs and freeze the selected run ID (or explicitly record the latest chosen run), then page all selected-run steps. No correlation means seed-only evidence, not a guessed trace or APIM linkage; never read bodies/attachments.
- **Stuck asynchronous work:** combine broker limits, warning/critical/inactive queues, named queue metadata, overdue stores/entries and variable metadata. Global stores use `integration_flow:''`. Store totals differ from fetched entry counts; positive backlog/depth or processing alone is not unhealthy. Resolve a MessageId before linking MPL. Queue retry/consume/start/stop is not automatic remediation.
- **APIM policy versus target errors:** compare `apim_get_analytics`, `apim_get_analytics_series` and `apim_get_api_error_breakdown` over the same window/proxy scope. Pair policy/target error totals and weighted latency with static policy attachments, provider, KVM and issuer evidence. Static configuration is not proof of effective authentication/trust, and source lag prevents current-health inference.
- **Certificate impact:** map `cpi_get_certificate_health` findings to referenced aliases/dependencies. Referenced expired/not-yet-valid certificates block; unrelated expiry is an inventory finding, not an unrelated release blocker. Missing/invalid validity and unproven trust/connectivity remain unknown.
- **Consumer offboarding:** inventory exact owner, subscriptions and legacy product links with Developer Hub tools. Separately approve unsubscription and fresh dry-run application deletion; incomplete/ambiguous relationships block, changed dependencies invalidate approval, and partial failure stops. API-key invalidation, native key/secret rotation, portal-access revoke and issued OAuth-token revocation are different outcomes; none may be substituted for another.

### Native promotion and wider Suite boundaries

- `integration_transport_readiness` must cover every selected package artifact group/version, not the first page or first 20 iFlows. `ctms_list_nodes` proves node visibility only. Authorized owners verify Content Agent assembly, export node, destinations and route, name the request set, separately approve assembly/upload/import, track native request/action logs, then verify content/version/runtime through an **independently target-bound server**. Snapshots/iFlow ZIPs are not MTARs; partial import and reset-to-Repeatable are not rollback.
- Use ANS rule inspection/validation and narrowly approved condition/subscription changes only. cTMS alerts use trusted internal ANS integration with intentional event/node scope, not obsolete `ALERT_NOTIFICATION_SERVICE` destinations. APIM anomaly events differ from analytics polling; CPI failures are not automatically ANS events.
- Narrow adapters: standalone `event_mesh_get_queue`; AEM `aem_list_brokers`, `aem_get_broker`, `aem_get_broker_operation`; broker-local SEMP `aem_list_queues`; Open Connectors identity reads and separately approved enabled-state action; Edge local metadata/MPL reads. Keep each credential/host authority separate. Queue metadata is not consumption, connector disable is not deletion or provider-health proof, and Edge metadata does not establish component-control schemas.
- Follow source-backed native sequences in the capability catalog/[tool contracts](../../../tools.md) for Suite-embedded Event Mesh, TPM agreement activation/interchanges, Advisor MIG/MAG validation/export, Assessment API Reference, Migration extraction/evaluation/conversion, new Integration Cell API/MCP design/deploy/monitor, Edge Operations Cockpit, shared-artifact creation/version history, queue controls/retry, CPI cancellation/design deletion, APIM retained Revert/standalone Undeploy and consumer key rotation/portal revoke. Include exact identities, prerequisites, authorized owner, safety impact and post-action reads. Never replace a missing/inaccessible public contract with a guessed API, generated Partner Directory edits or broader platform administration.

## 6. Naming and versioning rules

- Package ids: letters, digits, underscore. iFlow ids: letters, digits, `.`, `_`, `-`.
- iFlow names: ASCII letters, digits, space, period, hyphen or underscore; no trailing period. Put non-ASCII text in descriptions.
- API proxy and provider names: letters, digits, `_`, `-`. Reserved provider names: `TC_*`, `DEST_CI`, `APIMGMT_PORTAL`, `ON_PREM`, `Apimgmt_rt*`, and ContentCatalog.
- Base paths and sender paths: unique, lowercase, versioned (for example `/s4/salesorder/v1`); no `//`, `..` or trailing `/`.
- API proxy descriptions are stored as HTML (`<`, `>`, `&` come back escaped).
- Every iFlow update needs `expected_version` from a fresh read and bumps the draft patch version; only explicit SaveAsVersion creates retained history. APIM import/update/policy/documentation changes deploy a new revision; disclose that release effect.

## 7. Design deliverable and approval

1. Chosen pattern, rationale and rejected alternatives; component flow (consumer → gateway → integration → backend).
2. Per-hop host, port, path, route (Internet or Cloud Connector), authentication and separately managed credential owner.
3. Complete objects/identities/versions to reuse, create, configure or retire: package, iFlows/template, parameters, security aliases, shared artifacts, providers (`sap-client` where needed), proxies, policies, KVMs, products and consumer subscriptions.
4. Ordered build/release calls with exact live-schema confirmation strings, fresh optimistic hashes/versions, selected-version validation, immutable snapshot and readiness gates. Include partial-progress stop conditions; no implicit deployment or mutation retries.
5. Deployment versus native-promotion approvals, target-bound verification and explicit runtime/synthetic-test approval. Consumer onboarding/governance, Cloud Connector, runtime clients, account entitlements, platform roles and native operations have named owners.
6. Bounded observation window, expected signals, completeness/watermark limits, native collection/delivery evidence, diagnostic recipes and incident/recovery ownership.
7. Separately approved recovery/retirement sequence. `devhub_unsubscribe_application` and `devhub_delete_application` handle guarded consumer retirement, not APIM cleanup. APIM product/proxy deletion remains dependency-blocked; explicit-list cleanup never cascades into consumers/providers/KVMs/credentials. Include full target set, `allow_deployed` / `allow_active_subscriptions` permissions where applicable and returned dry-run confirmations.
8. Observed evidence, unresolved prerequisites and source-backed next actions, clearly separating acceptance, read-back, runtime proof and unexercised native criteria.

Present tenant hosts, exact actions and confirmations and obtain explicit user approval before **every write**, including validation, saved history, snapshots, deployment, alert changes, restore and deletion. A correct confirmation or preview hash is not approval. Never ask for secrets in chat or broaden authority to grant roles, provision optional services, consume/retry messages or bypass governance.
