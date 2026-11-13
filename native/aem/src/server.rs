//! MCP server: tool registration, result shaping and access checks.
use std::collections::HashMap;
use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::http::{AemError, CloudClient, SempClient, build_client};
use crate::mission_control::{self as mc, MC};
use crate::{VERSION, portal, redact, semp};

pub const CLOUD_NOT_CONFIGURED: &str =
    "The Advanced Event Mesh Cloud API token is not configured (AEM_API_TOKEN or sap-ai-dev --setup-aem).";

const INSTRUCTIONS: &str = "Manage SAP Integration Suite, advanced event mesh: broker service lifecycle (Mission Control), broker configuration, monitoring and actions (SEMP v2), and Event Portal design objects. Every write needs the exact confirmation string named in the tool description.";

pub struct State {
    pub http: reqwest::Client,
    pub cloud: Option<CloudClient>,
    pub semp: Option<Arc<SempClient>>,
    pub semp_by_service: Mutex<HashMap<String, Arc<SempClient>>>,
    summary: Value,
}

#[derive(Clone)]
pub struct AemServer {
    inner: Arc<State>,
    tool_router: ToolRouter<Self>,
}

fn host(url: &str) -> Value {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| match u.port() {
        Some(port) => format!("{h}:{port}"),
        None => h.to_owned(),
    })).map(Value::String).unwrap_or(Value::Null)
}

fn ok(value: Value) -> CallToolResult {
    let text = serde_json::to_string(&redact::redact(value)).unwrap_or_else(|_| "null".into());
    CallToolResult::success(vec![ContentBlock::text(text)])
}

fn fail(error: AemError) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(error.message)])
}

fn respond(result: Result<Value, AemError>) -> Result<CallToolResult, ErrorData> {
    Ok(match result {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    })
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionInfoParams {
    /// Also call the Cloud API and SEMP to verify access.
    pub verify: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NoParams {}

impl AemServer {
    pub fn new(config: Config) -> Result<Self, AemError> {
        let http = build_client(config.ca_file.as_ref())?;
        let summary = json!({
            "cloud": match &config.cloud {
                Some(c) => json!({ "configured": true, "api_host": host(&c.url), "source": c.source }),
                None => json!({ "configured": false }),
            },
            "semp": match &config.semp {
                Some(s) => json!({ "configured": true, "url_host": host(&s.url), "msg_vpn": s.msg_vpn, "source": s.source }),
                None => json!({ "configured": false }),
            },
            "version": VERSION,
        });
        let cloud = config.cloud.map(|c| CloudClient { http: http.clone(), url: c.url, token: c.token });
        let semp = config.semp.map(|s| {
            Arc::new(SempClient { http: http.clone(), url: s.url, msg_vpn: s.msg_vpn, username: s.username, password: s.password })
        });
        let state = State { http, cloud, semp, semp_by_service: Mutex::new(HashMap::new()), summary };
        Ok(Self { inner: Arc::new(state), tool_router: Self::tool_router() })
    }

    fn cloud(&self) -> Result<&CloudClient, AemError> {
        self.inner.cloud.as_ref().ok_or_else(|| AemError::msg(CLOUD_NOT_CONFIGURED))
    }

    /// Ordered `(check, result)` pairs; a result starting with `failed` is a failure.
    pub async fn verify(&self) -> Vec<(String, String)> {
        let cloud = match &self.inner.cloud {
            None => "not configured".to_owned(),
            Some(cloud) => {
                let query = vec![("pageNumber".to_owned(), "1".to_owned()), ("pageSize".to_owned(), "1".to_owned())];
                match cloud.get(&format!("{MC}/eventBrokerServices"), &query).await {
                    Ok(body) => {
                        let count = body
                            .pointer("/meta/pagination/count")
                            .and_then(Value::as_u64)
                            .or_else(|| body.get("data").and_then(Value::as_array).map(|a| a.len() as u64))
                            .unwrap_or(0);
                        format!("ok ({count} service(s) visible)")
                    }
                    Err(error) => format!("failed: {}", error.message),
                }
            }
        };
        let semp = match &self.inner.semp {
            None => "not configured".to_owned(),
            Some(client) => {
                let vpn = &client.msg_vpn;
                let path = format!("/SEMP/v2/monitor/msgVpns/{}", percent_encoding::utf8_percent_encode(vpn, percent_encoding::NON_ALPHANUMERIC));
                let query = vec![("select".to_owned(), "msgVpnName,state".to_owned())];
                match client.request(reqwest::Method::GET, &path, &query, None).await {
                    Ok((_, body)) => {
                        let state = body.pointer("/data/state").and_then(Value::as_str).unwrap_or("unknown");
                        format!("ok (VPN {vpn} state {state})")
                    }
                    Err(error) => format!("failed: {}", error.message),
                }
            }
        };
        vec![("cloud_api".to_owned(), cloud), ("semp".to_owned(), semp)]
    }
}

#[tool_router]
impl AemServer {
    #[tool(
        description = "Show which advanced event mesh credentials this server uses (Cloud API host, SEMP broker host and VPN, and their source) without secrets. verify: true also checks Cloud API and SEMP access online.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_connection_info(&self, Parameters(p): Parameters<ConnectionInfoParams>) -> Result<CallToolResult, ErrorData> {
        let mut info = self.inner.summary.clone();
        if p.verify == Some(true) {
            let checks: serde_json::Map<String, Value> = self.verify().await.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
            info["checks"] = Value::Object(checks);
        }
        respond(Ok(info))
    }

    // ----- Mission Control -----

    #[tool(
        description = "List event broker services (Mission Control) with id, name, service class, datacenter, version, admin/creation state, lock flag, message VPN and ongoing operations.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_list_services(&self, Parameters(p): Parameters<mc::PagingParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::list_services(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Read one event broker service with broker details, connection endpoints, allowed actions and message spool details (credentials redacted), plus its SEMP management endpoint URL.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_get_service(&self, Parameters(p): Parameters<mc::ServiceIdParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::get_service(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "List the service classes (broker sizes) available to the account.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_list_service_classes(&self, Parameters(_): Parameters<NoParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::list_service_classes(self.cloud()?).await }.await)
    }

    #[tool(
        description = "List datacenters where event broker services can be created.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_list_datacenters(&self, Parameters(p): Parameters<mc::DatacentersParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::list_datacenters(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "List event broker versions, optionally for one datacenter or only recommended ones.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_list_broker_versions(&self, Parameters(p): Parameters<mc::BrokerVersionsParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::list_broker_versions(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Create an event broker service. Asynchronous: returns the operation; poll it with aem_get_operation. confirmation must be exactly `CREATE AEM SERVICE <name>`, e.g. `CREATE AEM SERVICE orders-dev`.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_create_service(&self, Parameters(p): Parameters<mc::CreateServiceParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::create_service(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Rename an event broker service, change its owner, or lock/unlock it against deletion. confirmation must be exactly `UPDATE AEM SERVICE <service_id>`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_update_service(&self, Parameters(p): Parameters<mc::UpdateServiceParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::update_service(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Resize the message spool of an event broker service (asynchronous; returns the operation). confirmation must be exactly `RESIZE AEM SPOOL <service_id> <message_spool_size_gb>`, e.g. `RESIZE AEM SPOOL abc123 50`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_resize_message_spool(&self, Parameters(p): Parameters<mc::ResizeSpoolParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::resize_message_spool(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Show upgrade options for an event broker service: recommended versions, upgrade readiness and scheduled upgrades.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_get_upgrade_status(&self, Parameters(p): Parameters<mc::ServiceIdParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::get_upgrade_status(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Schedule an event broker version upgrade. Check aem_get_upgrade_status first. confirmation must be exactly `UPGRADE AEM SERVICE <service_id> TO <target_version>`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_upgrade_service(&self, Parameters(p): Parameters<mc::UpgradeServiceParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::upgrade_service(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Delete an event broker service and all its data (asynchronous; returns the operation). Locked services must be unlocked with aem_update_service first. confirmation must be exactly `DELETE AEM SERVICE <service_id> <service name>`, e.g. `DELETE AEM SERVICE abc123 orders-dev`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_delete_service(&self, Parameters(p): Parameters<mc::DeleteServiceParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::delete_service(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "List operations (create, resize, delete, ...) of an event broker service with status PENDING, INPROGRESS, SUCCEEDED or FAILED.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_list_operations(&self, Parameters(p): Parameters<mc::ServiceIdParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::list_operations(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Read one service operation; with wait_seconds, poll every 5 s until it is SUCCEEDED or FAILED (terminal) or the wait elapses.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_get_operation(&self, Parameters(p): Parameters<mc::GetOperationParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { mc::get_operation(self.cloud()?, p).await }.await)
    }

    // ----- SEMP v2 -----

    #[tool(
        description = "List SEMP configuration objects of a broker message VPN (queues, subscriptions, client usernames, profiles, ACL exceptions, REST delivery points, bridges, replay logs). Use service_id to resolve the broker from the Cloud API, or omit it for the explicit AEM_SEMP_* broker.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_semp_list_objects(&self, Parameters(p): Parameters<semp::ListObjectsParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::list_objects(&self.inner, p).await)
    }

    #[tool(
        description = "Read one SEMP configuration object by its ordered key parts (msg_vpn: no key).",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_semp_get_object(&self, Parameters(p): Parameters<semp::GetObjectParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::get_object(&self.inner, p).await)
    }

    #[tool(
        description = "Create a SEMP configuration object; key fields come from attributes, child types also need parent. confirmation must be exactly `CREATE AEM <OBJECT_TYPE> <vpn>/<key parts joined by ','>` (own key only, never the parent), e.g. `CREATE AEM QUEUE default/orders` or `CREATE AEM QUEUE_SUBSCRIPTION default/orders/>`.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_semp_create_object(&self, Parameters(p): Parameters<semp::CreateObjectParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::create_object(&self.inner, p).await)
    }

    #[tool(
        description = "Update attributes of a SEMP configuration object. confirmation must be exactly `UPDATE AEM <OBJECT_TYPE> <vpn>/<key parts joined by ','>`, e.g. `UPDATE AEM QUEUE default/orders`; for the VPN itself `UPDATE AEM MSG_VPN <vpn>`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_semp_update_object(&self, Parameters(p): Parameters<semp::UpdateObjectParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::update_object(&self.inner, p).await)
    }

    #[tool(
        description = "Delete a SEMP configuration object. confirmation must be exactly `DELETE AEM <OBJECT_TYPE> <vpn>/<key parts joined by ','>`, e.g. `DELETE AEM BRIDGE default/b1,primary`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_semp_delete_object(&self, Parameters(p): Parameters<semp::DeleteObjectParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::delete_object(&self.inner, p).await)
    }

    #[tool(
        description = "Read SEMP monitoring state: message VPN, queues, queue messages, topic endpoints, clients, REST delivery points and consumers, bridges. Give key to read one object, omit it to list. HTTP 529 means no SEMP session slot is free, not empty data.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_semp_monitor(&self, Parameters(p): Parameters<semp::MonitorParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::monitor(&self.inner, p).await)
    }

    #[tool(
        description = "Run a SEMP action: delete queue messages, clear queue/client/VPN statistics, start or cancel a queue replay, disconnect a client. confirmation must be exactly `RUN AEM <ACTION> <vpn>/<key>`, e.g. `RUN AEM QUEUE_DELETE_MSGS default/orders`; for msg_vpn_clear_stats `RUN AEM MSG_VPN_CLEAR_STATS <vpn>`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_semp_action(&self, Parameters(p): Parameters<semp::ActionParams>) -> Result<CallToolResult, ErrorData> {
        respond(semp::action(&self.inner, p).await)
    }

    // ----- Event Portal -----

    #[tool(
        description = "List Event Portal objects: application domains, applications, events, schemas and their versions, messaging services, event meshes, or the version states.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_portal_list(&self, Parameters(p): Parameters<portal::ListParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::list(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Read one Event Portal object by id.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_portal_get(&self, Parameters(p): Parameters<portal::GetParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::get(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Create an Event Portal application domain, application, event, schema or one of their versions. confirmation must be exactly `CREATE AEM PORTAL <OBJECT_TYPE> <attributes.name, else attributes.version>`, e.g. `CREATE AEM PORTAL APPLICATION_DOMAIN Orders` or `CREATE AEM PORTAL EVENT_VERSION 1.0.0`.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_portal_create(&self, Parameters(p): Parameters<portal::CreateParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::create(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Update an Event Portal object. confirmation must be exactly `UPDATE AEM PORTAL <OBJECT_TYPE> <id>`, e.g. `UPDATE AEM PORTAL APPLICATION a1b2c3`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_portal_update(&self, Parameters(p): Parameters<portal::UpdateParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::update(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Delete an Event Portal object. confirmation must be exactly `DELETE AEM PORTAL <OBJECT_TYPE> <id>`, e.g. `DELETE AEM PORTAL SCHEMA a1b2c3`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_portal_delete(&self, Parameters(p): Parameters<portal::DeleteParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::delete(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Set the lifecycle state (e.g. Draft, Released, Deprecated, Retired; ids from aem_portal_list object_type state) of an application, event or schema version. confirmation must be exactly `SET AEM PORTAL STATE <id> <state_id>`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_portal_set_version_state(&self, Parameters(p): Parameters<portal::SetStateParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::set_version_state(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Replace the messaging services associated with an application or event version (empty list removes all). confirmation must be exactly `ASSOCIATE AEM PORTAL <id>`.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true)
    )]
    async fn aem_portal_associate_messaging_services(&self, Parameters(p): Parameters<portal::AssociateParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::associate_messaging_services(self.cloud()?, p).await }.await)
    }

    #[tool(
        description = "Export an application version as an AsyncAPI document (json or yaml, AsyncAPI 2.5.0 or 3.0.0); documents over 512 KiB are truncated.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn aem_portal_export_asyncapi(&self, Parameters(p): Parameters<portal::ExportParams>) -> Result<CallToolResult, ErrorData> {
        respond(async { portal::export_asyncapi(self.cloud()?, p).await }.await)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AemServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sap-ai-aem", VERSION))
            .with_instructions(INSTRUCTIONS)
    }
}
