//! SEMP v2 config, monitor and action tools against one broker message VPN.
use std::sync::Arc;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Method;
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::config::validate_url;
use crate::confirm;
use crate::http::{AemError, SempClient};
use crate::mission_control::{MC, check_id, take_data};
use crate::server::{CLOUD_NOT_CONFIGURED, State};

/// Encodes everything except ALPHA, DIGIT, `-`, `.`, `_`, `~`.
const KEY: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

fn encode(value: &str) -> String {
    utf8_percent_encode(value, KEY).to_string()
}

fn non_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
}

fn service_label(data: &Value) -> &str {
    data.get("id").and_then(Value::as_str).unwrap_or("?")
}

/// SEMP management URL of a Mission Control service (`expand=serviceConnectionEndpoints`).
pub fn semp_endpoint_from_service(data: &Value) -> Result<String, AemError> {
    let default_host = non_empty(data, "defaultManagementHostname");
    let endpoints = data.get("serviceConnectionEndpoints").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let ordered = endpoints
        .iter()
        .filter(|e| e.get("accessType").and_then(Value::as_str) == Some("PUBLIC"))
        .chain(endpoints.iter().filter(|e| e.get("accessType").and_then(Value::as_str) != Some("PUBLIC")));
    for endpoint in ordered {
        let port = endpoint.get("ports").and_then(Value::as_array).into_iter().flatten().find_map(|p| {
            let port = p.get("port").and_then(Value::as_u64).filter(|port| *port > 0)?;
            (p.get("protocol").and_then(Value::as_str) == Some("serviceManagementTlsListenPort")).then_some(port)
        });
        let Some(port) = port else { continue };
        let host = endpoint
            .get("hostNames")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|h| !h.is_empty())
            .or(default_host);
        if let Some(host) = host {
            return Ok(validate_url(&format!("SEMP URL of service {}", service_label(data)), &format!("https://{host}:{port}"))?);
        }
    }
    match default_host {
        Some(host) => Ok(validate_url(&format!("SEMP URL of service {}", service_label(data)), &format!("https://{host}:943"))?),
        None => Err(AemError::msg(format!("service {} exposes no SEMP management endpoint", service_label(data)))),
    }
}

/// (url, vpn, username, password) for a Mission Control service fetched with
/// `expand=broker,serviceConnectionEndpoints`.
pub fn semp_target_from_service(data: &Value) -> Result<(String, String, String, String), AemError> {
    let vpns = data.pointer("/broker/msgVpns").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let vpn = non_empty(data, "msgVpnName").or_else(|| vpns.first().and_then(|v| non_empty(v, "msgVpnName")));
    let entry = match vpn {
        Some(name) => vpns.iter().find(|v| v.get("msgVpnName").and_then(Value::as_str) == Some(name)),
        None => vpns.first(),
    };
    let credential = entry.and_then(|entry| {
        ["missionControlManagerLoginCredential", "managementAdminLoginCredential"].iter().find_map(|kind| {
            let credential = entry.get(*kind)?;
            Some((non_empty(credential, "username")?.to_owned(), non_empty(credential, "password")?.to_owned()))
        })
    });
    let (Some(vpn), Some((username, password))) = (vpn, credential) else {
        return Err(AemError::msg(format!(
            "service {} response has no SEMP management credential; the Cloud API token needs permission to read services with management credentials, or configure AEM_SEMP_* explicitly",
            service_label(data)
        )));
    };
    Ok((semp_endpoint_from_service(data)?, vpn.to_owned(), username, password))
}

pub struct ObjectDef {
    pub name: &'static str,
    pub template: &'static str,
    pub keys: &'static [&'static str],
    pub parent: Option<&'static str>,
}

const fn def(name: &'static str, template: &'static str, keys: &'static [&'static str], parent: Option<&'static str>) -> ObjectDef {
    ObjectDef { name, template, keys, parent }
}

pub const CONFIG_OBJECTS: &[ObjectDef] = &[
    def("msg_vpn", "msgVpns/{vpn}", &[], None),
    def("queue", "msgVpns/{vpn}/queues", &["queueName"], None),
    def("queue_subscription", "msgVpns/{vpn}/queues/{parent}/subscriptions", &["subscriptionTopic"], Some("queueName")),
    def("topic_endpoint", "msgVpns/{vpn}/topicEndpoints", &["topicEndpointName"], None),
    def("client_username", "msgVpns/{vpn}/clientUsernames", &["clientUsername"], None),
    def("client_profile", "msgVpns/{vpn}/clientProfiles", &["clientProfileName"], None),
    def("acl_profile", "msgVpns/{vpn}/aclProfiles", &["aclProfileName"], None),
    def(
        "acl_publish_topic_exception",
        "msgVpns/{vpn}/aclProfiles/{parent}/publishTopicExceptions",
        &["publishTopicExceptionSyntax", "publishTopicException"],
        Some("aclProfileName"),
    ),
    def(
        "acl_subscribe_topic_exception",
        "msgVpns/{vpn}/aclProfiles/{parent}/subscribeTopicExceptions",
        &["subscribeTopicExceptionSyntax", "subscribeTopicException"],
        Some("aclProfileName"),
    ),
    def("rest_delivery_point", "msgVpns/{vpn}/restDeliveryPoints", &["restDeliveryPointName"], None),
    def("rest_consumer", "msgVpns/{vpn}/restDeliveryPoints/{parent}/restConsumers", &["restConsumerName"], Some("restDeliveryPointName")),
    def("rdp_queue_binding", "msgVpns/{vpn}/restDeliveryPoints/{parent}/queueBindings", &["queueBindingName"], Some("restDeliveryPointName")),
    def("bridge", "msgVpns/{vpn}/bridges", &["bridgeName", "bridgeVirtualRouter"], None),
    def("replay_log", "msgVpns/{vpn}/replayLogs", &["replayLogName"], None),
];

pub const MONITOR_OBJECTS: &[ObjectDef] = &[
    def("msg_vpn", "msgVpns/{vpn}", &[], None),
    def("queue", "msgVpns/{vpn}/queues", &["queueName"], None),
    def("queue_message", "msgVpns/{vpn}/queues/{parent}/msgs", &["msgId"], Some("queueName")),
    def("topic_endpoint", "msgVpns/{vpn}/topicEndpoints", &["topicEndpointName"], None),
    def("client", "msgVpns/{vpn}/clients", &["clientName"], None),
    def("rest_delivery_point", "msgVpns/{vpn}/restDeliveryPoints", &["restDeliveryPointName"], None),
    def("rest_consumer", "msgVpns/{vpn}/restDeliveryPoints/{parent}/restConsumers", &["restConsumerName"], Some("restDeliveryPointName")),
    def("bridge", "msgVpns/{vpn}/bridges", &["bridgeName", "bridgeVirtualRouter"], None),
];

pub struct ActionDef {
    pub name: &'static str,
    pub template: &'static str,
    /// Key field of the target object; None for VPN-level actions.
    pub key: Option<&'static str>,
    pub params: &'static [&'static str],
}

pub const ACTIONS: &[ActionDef] = &[
    ActionDef { name: "queue_delete_msgs", template: "msgVpns/{vpn}/queues/{key}/deleteMsgs", key: Some("queueName"), params: &[] },
    ActionDef { name: "queue_clear_stats", template: "msgVpns/{vpn}/queues/{key}/clearStats", key: Some("queueName"), params: &[] },
    ActionDef {
        name: "queue_start_replay",
        template: "msgVpns/{vpn}/queues/{key}/startReplay",
        key: Some("queueName"),
        params: &["replayLogName", "fromTime", "replicationGroupMessageId"],
    },
    ActionDef { name: "queue_cancel_replay", template: "msgVpns/{vpn}/queues/{key}/cancelReplay", key: Some("queueName"), params: &[] },
    ActionDef { name: "client_disconnect", template: "msgVpns/{vpn}/clients/{key}/disconnect", key: Some("clientName"), params: &[] },
    ActionDef { name: "client_clear_stats", template: "msgVpns/{vpn}/clients/{key}/clearStats", key: Some("clientName"), params: &[] },
    ActionDef { name: "msg_vpn_clear_stats", template: "msgVpns/{vpn}/clearStats", key: None, params: &[] },
];

macro_rules! named_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
        #[allow(clippy::enum_variant_names)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }
        impl $name {
            pub fn name(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
        }
    };
}
pub(crate) use named_enum;

named_enum!(
    /// SEMP configuration object type.
    ConfigObjectType {
        MsgVpn => "msg_vpn",
        Queue => "queue",
        QueueSubscription => "queue_subscription",
        TopicEndpoint => "topic_endpoint",
        ClientUsername => "client_username",
        ClientProfile => "client_profile",
        AclProfile => "acl_profile",
        AclPublishTopicException => "acl_publish_topic_exception",
        AclSubscribeTopicException => "acl_subscribe_topic_exception",
        RestDeliveryPoint => "rest_delivery_point",
        RestConsumer => "rest_consumer",
        RdpQueueBinding => "rdp_queue_binding",
        Bridge => "bridge",
        ReplayLog => "replay_log",
    }
);

named_enum!(
    /// SEMP monitor object type.
    MonitorObjectType {
        MsgVpn => "msg_vpn",
        Queue => "queue",
        QueueMessage => "queue_message",
        TopicEndpoint => "topic_endpoint",
        Client => "client",
        RestDeliveryPoint => "rest_delivery_point",
        RestConsumer => "rest_consumer",
        Bridge => "bridge",
    }
);

named_enum!(
    /// SEMP action.
    SempAction {
        QueueDeleteMsgs => "queue_delete_msgs",
        QueueClearStats => "queue_clear_stats",
        QueueStartReplay => "queue_start_replay",
        QueueCancelReplay => "queue_cancel_replay",
        ClientDisconnect => "client_disconnect",
        ClientClearStats => "client_clear_stats",
        MsgVpnClearStats => "msg_vpn_clear_stats",
    }
);

fn lookup<'a>(table: &'a [ObjectDef], name: &str) -> &'a ObjectDef {
    table.iter().find(|d| d.name == name).expect("object type enum and table agree")
}

/// `/SEMP/v2/<api>/<template>` with the VPN, parent and key filled in.
/// `key: None` addresses the collection (or the singleton).
pub fn object_path(api: &str, def: &ObjectDef, vpn: &str, parent: Option<&str>, key: Option<&[String]>) -> Result<String, AemError> {
    let mut path = format!("/SEMP/v2/{api}/{}", def.template.replace("{vpn}", &encode(vpn)));
    match (def.parent, parent) {
        (Some(field), None) => return Err(AemError::msg(format!("{} needs parent ({field})", def.name))),
        (None, Some(_)) => return Err(AemError::msg(format!("{} takes no parent", def.name))),
        (Some(_), Some(parent)) => path = path.replace("{parent}", &encode(parent)),
        (None, None) => {}
    }
    if let Some(key) = key {
        if key.len() != def.keys.len() {
            return Err(AemError::msg(format!("{} key needs {} part(s): {}", def.name, def.keys.len(), def.keys.join(", "))));
        }
        if !key.is_empty() {
            path.push('/');
            path.push_str(&key.iter().map(|part| encode(part)).collect::<Vec<_>>().join(","));
        }
    }
    Ok(path)
}

impl State {
    /// SEMP client for a Mission Control service (credentials from the Cloud API, cached)
    /// or for the explicitly configured broker.
    pub async fn semp_target(&self, service_id: Option<&str>) -> Result<Arc<SempClient>, AemError> {
        let Some(service_id) = service_id else {
            return self.semp.clone().ok_or_else(|| {
                AemError::msg("Give service_id (needs the Cloud API token) or configure AEM_SEMP_URL/AEM_SEMP_MSG_VPN/AEM_SEMP_USERNAME/AEM_SEMP_PASSWORD.")
            });
        };
        check_id("service_id", service_id)?;
        let cloud = self.cloud.as_ref().ok_or(CLOUD_NOT_CONFIGURED)?;
        if let Some(client) = self.semp_by_service.lock().await.get(service_id) {
            return Ok(client.clone());
        }
        let query = vec![("expand".into(), "broker,serviceConnectionEndpoints".into())];
        let data = take_data(cloud.get(&format!("{MC}/eventBrokerServices/{service_id}"), &query).await?);
        let (url, msg_vpn, username, password) = semp_target_from_service(&data)?;
        let client = Arc::new(SempClient { http: self.http.clone(), url, msg_vpn, username, password });
        self.semp_by_service.lock().await.insert(service_id.to_owned(), client.clone());
        Ok(client)
    }

    /// Sends a SEMP request; a 401 on a service-derived client drops the cached
    /// credential and retries once with a fresh lookup.
    async fn semp_send(&self, client: Arc<SempClient>, service_id: Option<&str>, method: Method, path: &str, query: &[(String, String)], body: Option<Value>) -> Result<Value, AemError> {
        match client.request(method.clone(), path, query, body.clone()).await {
            Err(error) if error.status == Some(401) && service_id.is_some() => {
                let service_id = service_id.unwrap_or_default();
                self.semp_by_service.lock().await.remove(service_id);
                let fresh = self.semp_target(Some(service_id)).await?;
                Ok(fresh.request(method, path, query, body).await?.1)
            }
            other => Ok(other?.1),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListObjectsParams {
    /// Mission Control service id; SEMP URL and credentials are fetched with the Cloud API token. Omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Parent object key, required for child types (queue_subscription: queueName; acl_*_topic_exception: aclProfileName; rest_consumer and rdp_queue_binding: restDeliveryPointName).
    pub parent: Option<String>,
    /// Object type.
    pub object_type: ConfigObjectType,
    /// Attributes to return.
    pub select: Option<Vec<String>>,
    /// SEMP where conditions, e.g. `queueName==orders*` (combined with AND).
    #[serde(rename = "where")]
    pub r#where: Option<Vec<String>>,
    /// Page size, 1-100 (default 50).
    pub count: Option<u32>,
    /// Cursor from a previous next_cursor.
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetObjectParams {
    /// Mission Control service id; omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Parent object key for child types.
    pub parent: Option<String>,
    /// Object type.
    pub object_type: ConfigObjectType,
    /// Ordered key parts (bridge: bridgeName, bridgeVirtualRouter; ACL exceptions: syntax, topic); omit for msg_vpn.
    pub key: Option<Vec<String>>,
    /// Attributes to return.
    pub select: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateObjectParams {
    /// Mission Control service id; omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Parent object key for child types.
    pub parent: Option<String>,
    /// Object type (not msg_vpn).
    pub object_type: ConfigObjectType,
    /// SEMP attributes, including the key fields (e.g. queueName).
    pub attributes: Map<String, Value>,
    /// Exactly `CREATE AEM <OBJECT_TYPE> <vpn>/<key parts joined by ','>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateObjectParams {
    /// Mission Control service id; omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Parent object key for child types.
    pub parent: Option<String>,
    /// Object type.
    pub object_type: ConfigObjectType,
    /// Ordered key parts; omit for msg_vpn.
    pub key: Option<Vec<String>>,
    /// SEMP attributes to change.
    pub attributes: Map<String, Value>,
    /// Exactly `UPDATE AEM <OBJECT_TYPE> <vpn>/<key>` (msg_vpn: `UPDATE AEM MSG_VPN <vpn>`).
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteObjectParams {
    /// Mission Control service id; omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Parent object key for child types.
    pub parent: Option<String>,
    /// Object type (not msg_vpn).
    pub object_type: ConfigObjectType,
    /// Ordered key parts.
    pub key: Vec<String>,
    /// Exactly `DELETE AEM <OBJECT_TYPE> <vpn>/<key>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MonitorParams {
    /// Mission Control service id; omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Parent object key (queue_message: queueName; rest_consumer: restDeliveryPointName).
    pub parent: Option<String>,
    /// Monitor object type.
    pub object_type: MonitorObjectType,
    /// Ordered key parts; give them to read one object, omit to list.
    pub key: Option<Vec<String>>,
    /// Attributes to return.
    pub select: Option<Vec<String>>,
    /// SEMP where conditions (list only).
    #[serde(rename = "where")]
    pub r#where: Option<Vec<String>>,
    /// Page size, 1-100 (default 50; list only).
    pub count: Option<u32>,
    /// Cursor from a previous next_cursor (list only).
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActionParams {
    /// Mission Control service id; omit to use the explicit AEM_SEMP_* broker.
    pub service_id: Option<String>,
    /// Message VPN (default: the service's or configured VPN).
    pub msg_vpn: Option<String>,
    /// Action.
    pub action: SempAction,
    /// Target key: queue name for queue_*, client name for client_*; omit for msg_vpn_clear_stats.
    pub key: Option<Vec<String>>,
    /// Action parameters (queue_start_replay: replayLogName, fromTime, replicationGroupMessageId).
    pub parameters: Option<Map<String, Value>>,
    /// Exactly `RUN AEM <ACTION> <vpn>/<key>` (msg_vpn_clear_stats: `RUN AEM MSG_VPN_CLEAR_STATS <vpn>`).
    pub confirmation: String,
}

fn list_query(select: Option<Vec<String>>, r#where: Option<Vec<String>>, count: Option<u32>, cursor: Option<String>) -> Result<Vec<(String, String)>, AemError> {
    let count = count.unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err("count must be between 1 and 100".into());
    }
    let mut query = vec![("count".to_owned(), count.to_string())];
    if let Some(cursor) = cursor.filter(|c| !c.is_empty()) {
        query.push(("cursor".into(), cursor));
    }
    query.extend(select_query(select));
    if let Some(conditions) = r#where.filter(|w| !w.is_empty()) {
        query.push(("where".into(), conditions.join(",")));
    }
    Ok(query)
}

fn select_query(select: Option<Vec<String>>) -> Option<(String, String)> {
    select.filter(|s| !s.is_empty()).map(|s| ("select".to_owned(), s.join(",")))
}

fn list_result(body: Value) -> Value {
    let next = body.pointer("/meta/paging/cursorQuery").cloned().unwrap_or(Value::Null);
    json!({ "items": body.get("data").cloned().unwrap_or(Value::Array(vec![])), "next_cursor": next })
}

fn singleton_guard(def: &ObjectDef) -> Result<(), AemError> {
    if def.keys.is_empty() { Err(AemError::msg(format!("{} supports only get and update", def.name))) } else { Ok(()) }
}

fn key_label(vpn: &str, key: &[String]) -> String {
    if key.is_empty() { vpn.to_owned() } else { format!("{vpn}/{}", key.join(",")) }
}

pub async fn list_objects(state: &State, p: ListObjectsParams) -> Result<Value, AemError> {
    let def = lookup(CONFIG_OBJECTS, p.object_type.name());
    singleton_guard(def)?;
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    let path = object_path("config", def, &vpn, p.parent.as_deref(), None)?;
    let query = list_query(p.select, p.r#where, p.count, p.cursor)?;
    Ok(list_result(state.semp_send(client, p.service_id.as_deref(), Method::GET, &path, &query, None).await?))
}

pub async fn get_object(state: &State, p: GetObjectParams) -> Result<Value, AemError> {
    let def = lookup(CONFIG_OBJECTS, p.object_type.name());
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    let key = p.key.unwrap_or_default();
    let path = object_path("config", def, &vpn, p.parent.as_deref(), Some(&key))?;
    let query: Vec<_> = select_query(p.select).into_iter().collect();
    Ok(take_data(state.semp_send(client, p.service_id.as_deref(), Method::GET, &path, &query, None).await?))
}

pub async fn create_object(state: &State, p: CreateObjectParams) -> Result<Value, AemError> {
    let def = lookup(CONFIG_OBJECTS, p.object_type.name());
    singleton_guard(def)?;
    let key: Option<Vec<String>> = def
        .keys
        .iter()
        .map(|field| p.attributes.get(*field).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned))
        .collect();
    let key = key.ok_or_else(|| AemError::msg(format!("attributes must include {}", def.keys.join(", "))))?;
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    let path = object_path("config", def, &vpn, p.parent.as_deref(), None)?;
    confirm::require(&p.confirmation, &format!("CREATE AEM {} {}", def.name.to_ascii_uppercase(), key_label(&vpn, &key)))?;
    let body = state.semp_send(client, p.service_id.as_deref(), Method::POST, &path, &[], Some(Value::Object(p.attributes))).await?;
    Ok(take_data(body))
}

pub async fn update_object(state: &State, p: UpdateObjectParams) -> Result<Value, AemError> {
    let def = lookup(CONFIG_OBJECTS, p.object_type.name());
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    let key = p.key.unwrap_or_default();
    let path = object_path("config", def, &vpn, p.parent.as_deref(), Some(&key))?;
    confirm::require(&p.confirmation, &format!("UPDATE AEM {} {}", def.name.to_ascii_uppercase(), key_label(&vpn, &key)))?;
    let body = state.semp_send(client, p.service_id.as_deref(), Method::PATCH, &path, &[], Some(Value::Object(p.attributes))).await?;
    Ok(take_data(body))
}

pub async fn delete_object(state: &State, p: DeleteObjectParams) -> Result<Value, AemError> {
    let def = lookup(CONFIG_OBJECTS, p.object_type.name());
    singleton_guard(def)?;
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    let path = object_path("config", def, &vpn, p.parent.as_deref(), Some(&p.key))?;
    confirm::require(&p.confirmation, &format!("DELETE AEM {} {}", def.name.to_ascii_uppercase(), key_label(&vpn, &p.key)))?;
    state.semp_send(client, p.service_id.as_deref(), Method::DELETE, &path, &[], None).await?;
    Ok(json!({ "deleted": true, "object_type": def.name, "key": p.key }))
}

pub async fn monitor(state: &State, p: MonitorParams) -> Result<Value, AemError> {
    let def = lookup(MONITOR_OBJECTS, p.object_type.name());
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    if def.keys.is_empty() || p.key.is_some() {
        let key = p.key.unwrap_or_default();
        let path = object_path("monitor", def, &vpn, p.parent.as_deref(), Some(&key))?;
        let query: Vec<_> = select_query(p.select).into_iter().collect();
        return Ok(take_data(state.semp_send(client, p.service_id.as_deref(), Method::GET, &path, &query, None).await?));
    }
    let path = object_path("monitor", def, &vpn, p.parent.as_deref(), None)?;
    let query = list_query(p.select, p.r#where, p.count, p.cursor)?;
    Ok(list_result(state.semp_send(client, p.service_id.as_deref(), Method::GET, &path, &query, None).await?))
}

pub async fn action(state: &State, p: ActionParams) -> Result<Value, AemError> {
    let def = ACTIONS.iter().find(|a| a.name == p.action.name()).expect("action enum and table agree");
    let key = p.key.unwrap_or_default();
    match def.key {
        Some(field) if key.len() != 1 => return Err(AemError::msg(format!("{} key needs 1 part(s): {field}", def.name))),
        None if !key.is_empty() => return Err(AemError::msg(format!("{} takes no key", def.name))),
        _ => {}
    }
    let parameters = p.parameters.unwrap_or_default();
    if let Some(unknown) = parameters.keys().find(|k| !def.params.contains(&k.as_str())) {
        return Err(AemError::msg(format!("{} does not accept parameter {unknown}", def.name)));
    }
    let client = state.semp_target(p.service_id.as_deref()).await?;
    let vpn = p.msg_vpn.unwrap_or_else(|| client.msg_vpn.clone());
    let mut path = format!("/SEMP/v2/action/{}", def.template.replace("{vpn}", &encode(&vpn)));
    if let Some(part) = key.first() {
        path = path.replace("{key}", &encode(part));
    }
    confirm::require(&p.confirmation, &format!("RUN AEM {} {}", def.name.to_ascii_uppercase(), key_label(&vpn, &key)))?;
    let body = state.semp_send(client, p.service_id.as_deref(), Method::PUT, &path, &[], Some(Value::Object(parameters))).await?;
    Ok(json!({ "done": true, "action": def.name, "meta": body.get("meta").cloned().unwrap_or(Value::Null) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(endpoints: Value, credential: Value) -> Value {
        let mut vpn = credential;
        vpn["msgVpnName"] = json!("orders-vpn");
        json!({
            "id": "svc1",
            "msgVpnName": "orders-vpn",
            "defaultManagementHostname": "mr-default.messaging.solace.cloud",
            "serviceConnectionEndpoints": endpoints,
            "broker": { "msgVpns": [vpn] }
        })
    }

    #[test]
    fn target_prefers_public_management_port_and_mission_control_credential() {
        let data = service(
            json!([
                { "accessType": "PRIVATE", "hostNames": ["private.local"], "ports": [{ "protocol": "serviceManagementTlsListenPort", "port": 943 }] },
                { "accessType": "PUBLIC", "hostNames": ["mr-x.messaging.solace.cloud"], "ports": [
                    { "protocol": "serviceSmfTlsListenPort", "port": 55443 },
                    { "protocol": "serviceManagementTlsListenPort", "port": 943 }
                ] }
            ]),
            json!({
                "missionControlManagerLoginCredential": { "username": "mc-user", "password": "mc-pass" },
                "managementAdminLoginCredential": { "username": "admin", "password": "admin-pass" }
            }),
        );
        let (url, vpn, user, password) = semp_target_from_service(&data).unwrap();
        assert_eq!(url, "https://mr-x.messaging.solace.cloud:943");
        assert_eq!((vpn.as_str(), user.as_str(), password.as_str()), ("orders-vpn", "mc-user", "mc-pass"));
    }

    #[test]
    fn target_falls_back_to_default_management_hostname() {
        let data = service(json!([]), json!({ "managementAdminLoginCredential": { "username": "admin", "password": "p" } }));
        let (url, _, user, _) = semp_target_from_service(&data).unwrap();
        assert_eq!(url, "https://mr-default.messaging.solace.cloud:943");
        assert_eq!(user, "admin");
    }

    #[test]
    fn target_without_credentials_fails() {
        let data = service(json!([]), json!({}));
        let error = semp_target_from_service(&data).unwrap_err();
        assert!(error.message.starts_with("service svc1 response has no SEMP management credential"), "{}", error.message);
    }

    #[test]
    fn object_paths_encode_keys() {
        let queue = lookup(CONFIG_OBJECTS, "queue");
        assert_eq!(
            object_path("config", queue, "default", None, Some(&["q/a".to_owned()])).unwrap(),
            "/SEMP/v2/config/msgVpns/default/queues/q%2Fa"
        );
        let bridge = lookup(CONFIG_OBJECTS, "bridge");
        assert_eq!(
            object_path("config", bridge, "default", None, Some(&["b1".to_owned(), "#v1".to_owned()])).unwrap(),
            "/SEMP/v2/config/msgVpns/default/bridges/b1,%23v1"
        );
        assert_eq!(
            object_path("config", bridge, "default", None, Some(&["b1".to_owned()])).unwrap_err().message,
            "bridge key needs 2 part(s): bridgeName, bridgeVirtualRouter"
        );
        let subscription = lookup(CONFIG_OBJECTS, "queue_subscription");
        assert_eq!(object_path("config", subscription, "default", None, None).unwrap_err().message, "queue_subscription needs parent (queueName)");
        assert_eq!(
            object_path("config", subscription, "default", Some("q1"), Some(&["orders/>".to_owned()])).unwrap(),
            "/SEMP/v2/config/msgVpns/default/queues/q1/subscriptions/orders%2F%3E"
        );
    }
}
