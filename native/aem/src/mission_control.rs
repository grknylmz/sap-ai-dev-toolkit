//! Mission Control (Cloud REST v2) event broker service lifecycle.
use std::time::Duration;

use reqwest::Method;
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::confirm;
use crate::http::{AemError, CloudClient};
use crate::semp::semp_endpoint_from_service;

pub const MC: &str = "/api/v2/missionControl";

const SERVICE_FIELDS: &[&str] = &[
    "id", "name", "serviceClassId", "datacenterId", "eventBrokerServiceVersion", "adminState", "creationState", "locked",
    "msgVpnName", "environmentId", "ongoingOperationIds", "createdTime",
];
const OPERATION_FIELDS: &[&str] = &["id", "operationType", "status", "resourceId", "createdTime", "completedTime", "error", "progressLogs"];

/// `^[A-Za-z0-9_-]{1,64}$`
pub fn check_id(field: &str, value: &str) -> Result<(), AemError> {
    let valid = (1..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid { Ok(()) } else { Err(AemError::msg(format!("{field} must be 1-64 letters, digits, _ or -"))) }
}

fn check_name(field: &str, value: &str) -> Result<(), AemError> {
    let length = value.chars().count();
    if (1..=100).contains(&length) { Ok(()) } else { Err(AemError::msg(format!("{field} must be 1-100 characters"))) }
}

pub fn paging(page_number: Option<u32>, page_size: Option<u32>) -> Result<Vec<(String, String)>, AemError> {
    let number = page_number.unwrap_or(1);
    let size = page_size.unwrap_or(25);
    if number < 1 {
        return Err("page_number must be at least 1".into());
    }
    if !(1..=100).contains(&size) {
        return Err("page_size must be between 1 and 100".into());
    }
    Ok(vec![("pageNumber".into(), number.to_string()), ("pageSize".into(), size.to_string())])
}

/// Copies only the listed fields that are present; absent fields are omitted.
pub fn project(value: &Value, fields: &[&str]) -> Value {
    let mut out = Map::new();
    for field in fields {
        if let Some(v) = value.get(*field) {
            out.insert((*field).to_owned(), v.clone());
        }
    }
    Value::Object(out)
}

pub fn take_data(mut body: Value) -> Value {
    body.get_mut("data").map(Value::take).unwrap_or(Value::Null)
}

pub fn paged(body: Value, map: impl Fn(&Value) -> Value) -> Value {
    let items: Vec<Value> = body.get("data").and_then(Value::as_array).map(|a| a.iter().map(&map).collect()).unwrap_or_default();
    json!({ "items": items, "page": body.pointer("/meta/pagination").cloned().unwrap_or(Value::Null) })
}

fn operation(body: Value) -> Value {
    project(&take_data(body), OPERATION_FIELDS)
}

fn service_path(service_id: &str) -> String {
    format!("{MC}/eventBrokerServices/{service_id}")
}

fn push(query: &mut Vec<(String, String)>, key: &str, value: Option<impl ToString>) {
    if let Some(value) = value {
        query.push((key.to_owned(), value.to_string()));
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PagingParams {
    /// 1-based page number (default 1).
    pub page_number: Option<u32>,
    /// Page size, 1-100 (default 25).
    pub page_size: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceIdParams {
    /// Event broker service id (from aem_list_services).
    pub service_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatacentersParams {
    /// 1-based page number (default 1).
    pub page_number: Option<u32>,
    /// Page size, 1-100 (default 25).
    pub page_size: Option<u32>,
    /// Only datacenters available to this environment id.
    pub environment_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrokerVersionsParams {
    /// 1-based page number (default 1).
    pub page_number: Option<u32>,
    /// Page size, 1-100 (default 25).
    pub page_size: Option<u32>,
    /// Only versions available in this datacenter.
    pub datacenter_id: Option<String>,
    /// Only recommended versions.
    pub recommended: Option<bool>,
}

#[allow(non_camel_case_types, clippy::upper_case_acronyms)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum ServiceClass {
    DEVELOPER,
    ENTERPRISE_250_STANDALONE,
    ENTERPRISE_1K_STANDALONE,
    ENTERPRISE_5K_STANDALONE,
    ENTERPRISE_10K_STANDALONE,
    ENTERPRISE_50K_STANDALONE,
    ENTERPRISE_100K_STANDALONE,
    ENTERPRISE_200K_STANDALONE,
    ENTERPRISE_250_HIGHAVAILABILITY,
    ENTERPRISE_1K_HIGHAVAILABILITY,
    ENTERPRISE_5K_HIGHAVAILABILITY,
    ENTERPRISE_10K_HIGHAVAILABILITY,
    ENTERPRISE_50K_HIGHAVAILABILITY,
    ENTERPRISE_100K_HIGHAVAILABILITY,
    ENTERPRISE_200K_HIGHAVAILABILITY,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateServiceParams {
    /// Service name, 1-100 characters.
    pub name: String,
    /// Service class (size and high availability); see aem_list_service_classes.
    pub service_class_id: ServiceClass,
    /// Datacenter id from aem_list_datacenters.
    pub datacenter_id: String,
    /// Message VPN name (default chosen by Mission Control).
    pub msg_vpn_name: Option<String>,
    /// Event broker version from aem_list_broker_versions (default: recommended).
    pub event_broker_version: Option<String>,
    /// Maximum message spool usage in GB.
    pub max_spool_usage_gb: Option<u32>,
    /// Environment id.
    pub environment_id: Option<String>,
    /// Cluster name.
    pub cluster_name: Option<String>,
    /// Exactly `CREATE AEM SERVICE <name>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateServiceParams {
    /// Event broker service id.
    pub service_id: String,
    /// New service name, 1-100 characters.
    pub name: Option<String>,
    /// New owner user id.
    pub owned_by: Option<String>,
    /// Lock (true) or unlock (false) the service against deletion.
    pub locked: Option<bool>,
    /// Exactly `UPDATE AEM SERVICE <service_id>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResizeSpoolParams {
    /// Event broker service id.
    pub service_id: String,
    /// New message spool size in GB (at least 1).
    pub message_spool_size_gb: u32,
    /// Exactly `RESIZE AEM SPOOL <service_id> <message_spool_size_gb>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpgradeServiceParams {
    /// Event broker service id.
    pub service_id: String,
    /// Target event broker version (see aem_get_upgrade_status).
    pub target_version: String,
    /// Maintenance window id.
    pub maintenance_window_id: Option<String>,
    /// Maintenance time ordinal within the window.
    pub maintenance_time_ordinal: Option<u32>,
    /// Exactly `UPGRADE AEM SERVICE <service_id> TO <target_version>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteServiceParams {
    /// Event broker service id.
    pub service_id: String,
    /// Exactly `DELETE AEM SERVICE <service_id> <service name>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetOperationParams {
    /// Event broker service id.
    pub service_id: String,
    /// Operation id returned by a create, resize or delete.
    pub operation_id: String,
    /// Poll every 5 s for up to this many seconds (0-300, default 0) until the operation is SUCCEEDED or FAILED.
    pub wait_seconds: Option<u32>,
}

pub async fn list_services(cloud: &CloudClient, p: PagingParams) -> Result<Value, AemError> {
    let body = cloud.get(&format!("{MC}/eventBrokerServices"), &paging(p.page_number, p.page_size)?).await?;
    Ok(paged(body, |s| project(s, SERVICE_FIELDS)))
}

pub async fn get_service(cloud: &CloudClient, p: ServiceIdParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    let query = vec![("expand".into(), "broker,serviceConnectionEndpoints,allowedActions,messageSpoolDetails".into())];
    let data = take_data(cloud.get(&service_path(&p.service_id), &query).await?);
    let mut result = json!({ "service": data });
    match semp_endpoint_from_service(&result["service"]) {
        Ok(url) => result["semp_endpoint"] = Value::String(url),
        Err(error) => {
            result["semp_endpoint"] = Value::Null;
            result["semp_endpoint_error"] = Value::String(error.message);
        }
    }
    Ok(result)
}

pub async fn list_service_classes(cloud: &CloudClient) -> Result<Value, AemError> {
    Ok(take_data(cloud.get(&format!("{MC}/serviceClasses"), &[]).await?))
}

pub async fn list_datacenters(cloud: &CloudClient, p: DatacentersParams) -> Result<Value, AemError> {
    let mut query = paging(p.page_number, p.page_size)?;
    push(&mut query, "environmentId", p.environment_id);
    Ok(paged(cloud.get(&format!("{MC}/datacenters"), &query).await?, Value::clone))
}

pub async fn list_broker_versions(cloud: &CloudClient, p: BrokerVersionsParams) -> Result<Value, AemError> {
    let mut query = paging(p.page_number, p.page_size)?;
    if let Some(id) = &p.datacenter_id {
        check_id("datacenter_id", id)?;
    }
    push(&mut query, "datacenterId", p.datacenter_id);
    push(&mut query, "recommended", p.recommended);
    Ok(paged(cloud.get(&format!("{MC}/eventBrokerServiceVersions"), &query).await?, Value::clone))
}

pub async fn create_service(cloud: &CloudClient, p: CreateServiceParams) -> Result<Value, AemError> {
    check_name("name", &p.name)?;
    check_id("datacenter_id", &p.datacenter_id)?;
    confirm::require(&p.confirmation, &format!("CREATE AEM SERVICE {}", p.name))?;
    let mut body = Map::new();
    body.insert("name".into(), json!(p.name));
    body.insert("serviceClassId".into(), json!(p.service_class_id));
    body.insert("datacenterId".into(), json!(p.datacenter_id));
    let optional = [
        ("msgVpnName", p.msg_vpn_name.map(Value::from)),
        ("eventBrokerVersion", p.event_broker_version.map(Value::from)),
        ("maxSpoolUsage", p.max_spool_usage_gb.map(Value::from)),
        ("environmentId", p.environment_id.map(Value::from)),
        ("clusterName", p.cluster_name.map(Value::from)),
    ];
    for (key, value) in optional {
        if let Some(value) = value {
            body.insert(key.into(), value);
        }
    }
    let (_, response) = cloud.request(Method::POST, &format!("{MC}/eventBrokerServices"), &[], Some(Value::Object(body))).await?;
    Ok(operation(response))
}

pub async fn update_service(cloud: &CloudClient, p: UpdateServiceParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    if p.name.is_none() && p.owned_by.is_none() && p.locked.is_none() {
        return Err("nothing to update".into());
    }
    if let Some(name) = &p.name {
        check_name("name", name)?;
    }
    confirm::require(&p.confirmation, &format!("UPDATE AEM SERVICE {}", p.service_id))?;
    let mut body = Map::new();
    if let Some(name) = p.name {
        body.insert("name".into(), json!(name));
    }
    if let Some(owner) = p.owned_by {
        body.insert("ownedBy".into(), json!(owner));
    }
    if let Some(locked) = p.locked {
        body.insert("locked".into(), json!(locked));
    }
    let (_, response) = cloud.request(Method::PATCH, &service_path(&p.service_id), &[], Some(Value::Object(body))).await?;
    Ok(project(&take_data(response), SERVICE_FIELDS))
}

pub async fn resize_message_spool(cloud: &CloudClient, p: ResizeSpoolParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    if p.message_spool_size_gb < 1 {
        return Err("message_spool_size_gb must be at least 1".into());
    }
    confirm::require(&p.confirmation, &format!("RESIZE AEM SPOOL {} {}", p.service_id, p.message_spool_size_gb))?;
    let body = json!({ "messageSpoolSizeInGB": p.message_spool_size_gb });
    let (_, response) = cloud.request(Method::PATCH, &format!("{}/messageSpool", service_path(&p.service_id)), &[], Some(body)).await?;
    Ok(operation(response))
}

pub async fn get_upgrade_status(cloud: &CloudClient, p: ServiceIdParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    let base = service_path(&p.service_id);
    let paths = [format!("{base}/recommendedVersions"), format!("{base}/upgradeReadiness"), format!("{base}/upgrades")];
    let (recommended, readiness, upgrades) = tokio::join!(cloud.get(&paths[0], &[]), cloud.get(&paths[1], &[]), cloud.get(&paths[2], &[]));
    let field = |result: Result<Value, AemError>| match result {
        Ok(body) => take_data(body),
        Err(error) => json!({ "error": error.message }),
    };
    Ok(json!({ "recommended_versions": field(recommended), "readiness": field(readiness), "upgrades": field(upgrades) }))
}

pub async fn upgrade_service(cloud: &CloudClient, p: UpgradeServiceParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    if p.target_version.trim().is_empty() {
        return Err("target_version is required".into());
    }
    confirm::require(&p.confirmation, &format!("UPGRADE AEM SERVICE {} TO {}", p.service_id, p.target_version))?;
    let mut body = Map::new();
    body.insert("targetVersion".into(), json!(p.target_version));
    if let Some(id) = p.maintenance_window_id {
        body.insert("maintenanceWindowId".into(), json!(id));
    }
    if let Some(ordinal) = p.maintenance_time_ordinal {
        body.insert("maintenanceTimeOrdinal".into(), json!(ordinal));
    }
    let (_, response) = cloud.request(Method::POST, &format!("{}/upgrades", service_path(&p.service_id)), &[], Some(Value::Object(body))).await?;
    Ok(take_data(response))
}

pub async fn delete_service(cloud: &CloudClient, p: DeleteServiceParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    let path = service_path(&p.service_id);
    let service = take_data(cloud.get(&path, &[]).await?);
    if service.get("locked").and_then(Value::as_bool) == Some(true) {
        return Err(AemError::msg(format!("service {} is locked; unlock it with aem_update_service first", p.service_id)));
    }
    let name = service.get("name").and_then(Value::as_str).unwrap_or_default();
    confirm::require(&p.confirmation, &format!("DELETE AEM SERVICE {} {name}", p.service_id))?;
    let (_, response) = cloud.request(Method::DELETE, &path, &[], None).await?;
    Ok(operation(response))
}

pub async fn list_operations(cloud: &CloudClient, p: ServiceIdParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    let data = take_data(cloud.get(&format!("{}/operations", service_path(&p.service_id)), &[]).await?);
    Ok(match data {
        Value::Array(items) => Value::Array(items.iter().map(|o| project(o, OPERATION_FIELDS)).collect()),
        other => other,
    })
}

pub async fn get_operation(cloud: &CloudClient, p: GetOperationParams) -> Result<Value, AemError> {
    check_id("service_id", &p.service_id)?;
    check_id("operation_id", &p.operation_id)?;
    let wait = p.wait_seconds.unwrap_or(0);
    if wait > 300 {
        return Err("wait_seconds must be between 0 and 300".into());
    }
    let path = format!("{}/operations/{}", service_path(&p.service_id), p.operation_id);
    let mut waited = 0;
    loop {
        let operation = operation(cloud.get(&path, &[]).await?);
        let status = operation.get("status").and_then(Value::as_str).unwrap_or_default().to_ascii_uppercase();
        let terminal = status == "SUCCEEDED" || status == "FAILED";
        if terminal || waited >= wait {
            return Ok(json!({ "operation": operation, "terminal": terminal, "waited_seconds": waited }));
        }
        let step = (wait - waited).min(5);
        tokio::time::sleep(Duration::from_secs(step.into())).await;
        waited += step;
    }
}
