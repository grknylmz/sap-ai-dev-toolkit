//! Event Portal design-time objects (`/api/v2/architecture`).
use reqwest::Method;
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::confirm;
use crate::http::{AemError, CloudClient};
use crate::mission_control::{check_id, paged, paging, take_data};
use crate::semp::named_enum;

const ARCH: &str = "/api/v2/architecture";
const EXPORT_LIMIT: usize = 524_288;

struct PortalDef {
    name: &'static str,
    path: &'static str,
    writable: bool,
    /// (tool filter, query parameter)
    filters: &'static [(&'static str, &'static str)],
}

const PORTAL_OBJECTS: &[PortalDef] = &[
    PortalDef { name: "application_domain", path: "applicationDomains", writable: true, filters: &[("name", "name"), ("ids", "ids")] },
    PortalDef {
        name: "application",
        path: "applications",
        writable: true,
        filters: &[("name", "name"), ("application_domain_id", "applicationDomainId"), ("ids", "ids")],
    },
    PortalDef { name: "application_version", path: "applicationVersions", writable: true, filters: &[("parent_ids", "applicationIds"), ("ids", "ids")] },
    PortalDef {
        name: "event",
        path: "events",
        writable: true,
        filters: &[("name", "name"), ("application_domain_id", "applicationDomainId"), ("ids", "ids")],
    },
    PortalDef { name: "event_version", path: "eventVersions", writable: true, filters: &[("parent_ids", "eventIds"), ("ids", "ids")] },
    PortalDef {
        name: "schema",
        path: "schemas",
        writable: true,
        filters: &[("name", "name"), ("application_domain_id", "applicationDomainId"), ("ids", "ids")],
    },
    PortalDef { name: "schema_version", path: "schemaVersions", writable: true, filters: &[("parent_ids", "schemaIds"), ("ids", "ids")] },
    PortalDef { name: "messaging_service", path: "messagingServices", writable: false, filters: &[("ids", "ids")] },
    PortalDef { name: "event_mesh", path: "eventMeshes", writable: false, filters: &[("name", "name"), ("ids", "ids")] },
    PortalDef { name: "state", path: "states", writable: false, filters: &[] },
];

named_enum!(
    /// Event Portal object type.
    PortalObjectType {
        ApplicationDomain => "application_domain",
        Application => "application",
        ApplicationVersion => "application_version",
        Event => "event",
        EventVersion => "event_version",
        Schema => "schema",
        SchemaVersion => "schema_version",
        MessagingService => "messaging_service",
        EventMesh => "event_mesh",
        State => "state",
    }
);

named_enum!(
    /// Versioned Event Portal object type.
    VersionObjectType {
        ApplicationVersion => "application_version",
        EventVersion => "event_version",
        SchemaVersion => "schema_version",
    }
);

named_enum!(
    /// Event Portal version type that can be associated with messaging services.
    AssociableObjectType {
        ApplicationVersion => "application_version",
        EventVersion => "event_version",
    }
);

named_enum!(
    /// AsyncAPI document format.
    ExportFormat { Json => "json", Yaml => "yaml" }
);

named_enum!(
    /// AsyncAPI specification version.
    AsyncApiVersion { V2_5_0 => "2.5.0", V3_0_0 => "3.0.0" }
);

fn lookup(name: &str) -> &'static PortalDef {
    PORTAL_OBJECTS.iter().find(|d| d.name == name).expect("portal enum and table agree")
}

fn writable(name: &str) -> Result<&'static PortalDef, AemError> {
    let def = lookup(name);
    if def.writable { Ok(def) } else { Err(AemError::msg(format!("{name} is read-only"))) }
}

fn object_path(def: &PortalDef, id: &str) -> Result<String, AemError> {
    check_id("id", id)?;
    Ok(format!("{ARCH}/{}/{id}", def.path))
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListParams {
    /// Object type.
    pub object_type: PortalObjectType,
    /// 1-based page number (default 1; not for state).
    pub page_number: Option<u32>,
    /// Page size, 1-100 (default 25; not for state).
    pub page_size: Option<u32>,
    /// Exact name filter (application_domain, application, event, schema, event_mesh).
    pub name: Option<String>,
    /// Application domain filter (application, event, schema).
    pub application_domain_id: Option<String>,
    /// Parent object ids (application_version: application ids; event_version: event ids; schema_version: schema ids); at most 50.
    pub parent_ids: Option<Vec<String>>,
    /// Object ids; at most 50.
    pub ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetParams {
    /// Object type (not state).
    pub object_type: PortalObjectType,
    /// Object id.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateParams {
    /// Writable object type.
    pub object_type: PortalObjectType,
    /// Event Portal attributes (camelCase as in the Event Portal API), including name (or version for *_version types).
    pub attributes: Map<String, Value>,
    /// Exactly `CREATE AEM PORTAL <OBJECT_TYPE> <attributes.name, else attributes.version>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateParams {
    /// Writable object type.
    pub object_type: PortalObjectType,
    /// Object id.
    pub id: String,
    /// Event Portal attributes to change.
    pub attributes: Map<String, Value>,
    /// Exactly `UPDATE AEM PORTAL <OBJECT_TYPE> <id>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteParams {
    /// Writable object type.
    pub object_type: PortalObjectType,
    /// Object id.
    pub id: String,
    /// Exactly `DELETE AEM PORTAL <OBJECT_TYPE> <id>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetStateParams {
    /// Version object type.
    pub object_type: VersionObjectType,
    /// Version id.
    pub id: String,
    /// Target state id from aem_portal_list object_type state.
    pub state_id: String,
    /// Exactly `SET AEM PORTAL STATE <id> <state_id>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssociateParams {
    /// Version object type.
    pub object_type: AssociableObjectType,
    /// Version id.
    pub id: String,
    /// Messaging service ids (0-50); an empty list removes all associations.
    pub messaging_service_ids: Vec<String>,
    /// Exactly `ASSOCIATE AEM PORTAL <id>`.
    pub confirmation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExportParams {
    /// Application version id.
    pub application_version_id: String,
    /// Document format (default json).
    pub format: Option<ExportFormat>,
    /// AsyncAPI version (default 2.5.0).
    pub asyncapi_version: Option<AsyncApiVersion>,
}

fn check_ids(field: &str, ids: &[String]) -> Result<(), AemError> {
    if ids.len() > 50 {
        return Err(AemError::msg(format!("{field} accepts at most 50 values")));
    }
    ids.iter().try_for_each(|id| check_id(field, id))
}

pub async fn list(cloud: &CloudClient, p: ListParams) -> Result<Value, AemError> {
    let def = lookup(p.object_type.name());
    let mut filters: Vec<(&str, Vec<String>)> = Vec::new();
    if let Some(name) = p.name {
        filters.push(("name", vec![name]));
    }
    if let Some(id) = p.application_domain_id {
        check_id("application_domain_id", &id)?;
        filters.push(("application_domain_id", vec![id]));
    }
    if let Some(ids) = p.parent_ids {
        check_ids("parent_ids", &ids)?;
        filters.push(("parent_ids", ids));
    }
    if let Some(ids) = p.ids {
        check_ids("ids", &ids)?;
        filters.push(("ids", ids));
    }
    let mut query = Vec::new();
    for (filter, values) in filters {
        let parameter = def
            .filters
            .iter()
            .find(|(name, _)| *name == filter)
            .map(|(_, parameter)| *parameter)
            .ok_or_else(|| AemError::msg(format!("{filter} is not supported for {}", def.name)))?;
        query.extend(values.into_iter().map(|v| (parameter.to_owned(), v)));
    }
    let path = format!("{ARCH}/{}", def.path);
    if def.name == "state" {
        return Ok(json!({ "items": take_data(cloud.get(&path, &[]).await?) }));
    }
    query.extend(paging(p.page_number, p.page_size)?);
    Ok(paged(cloud.get(&path, &query).await?, Value::clone))
}

pub async fn get(cloud: &CloudClient, p: GetParams) -> Result<Value, AemError> {
    let def = lookup(p.object_type.name());
    if def.name == "state" {
        return Err("state supports only aem_portal_list".into());
    }
    Ok(take_data(cloud.get(&object_path(def, &p.id)?, &[]).await?))
}

pub async fn create(cloud: &CloudClient, p: CreateParams) -> Result<Value, AemError> {
    let def = writable(p.object_type.name())?;
    let label = ["name", "version"]
        .iter()
        .find_map(|k| p.attributes.get(*k).and_then(Value::as_str).filter(|v| !v.is_empty()))
        .ok_or("attributes must include name or version")?;
    confirm::require(&p.confirmation, &format!("CREATE AEM PORTAL {} {label}", def.name.to_ascii_uppercase()))?;
    let (_, body) = cloud.request(Method::POST, &format!("{ARCH}/{}", def.path), &[], Some(Value::Object(p.attributes))).await?;
    Ok(take_data(body))
}

pub async fn update(cloud: &CloudClient, p: UpdateParams) -> Result<Value, AemError> {
    let def = writable(p.object_type.name())?;
    let path = object_path(def, &p.id)?;
    confirm::require(&p.confirmation, &format!("UPDATE AEM PORTAL {} {}", def.name.to_ascii_uppercase(), p.id))?;
    let (_, body) = cloud.request(Method::PATCH, &path, &[], Some(Value::Object(p.attributes))).await?;
    Ok(take_data(body))
}

pub async fn delete(cloud: &CloudClient, p: DeleteParams) -> Result<Value, AemError> {
    let def = writable(p.object_type.name())?;
    let path = object_path(def, &p.id)?;
    confirm::require(&p.confirmation, &format!("DELETE AEM PORTAL {} {}", def.name.to_ascii_uppercase(), p.id))?;
    cloud.request(Method::DELETE, &path, &[], None).await?;
    Ok(json!({ "deleted": true, "object_type": def.name, "id": p.id }))
}

pub async fn set_version_state(cloud: &CloudClient, p: SetStateParams) -> Result<Value, AemError> {
    let path = object_path(lookup(p.object_type.name()), &p.id)?;
    check_id("state_id", &p.state_id)?;
    confirm::require(&p.confirmation, &format!("SET AEM PORTAL STATE {} {}", p.id, p.state_id))?;
    let (_, body) = cloud.request(Method::PATCH, &format!("{path}/state"), &[], Some(json!({ "stateId": p.state_id }))).await?;
    Ok(take_data(body))
}

pub async fn associate_messaging_services(cloud: &CloudClient, p: AssociateParams) -> Result<Value, AemError> {
    let path = object_path(lookup(p.object_type.name()), &p.id)?;
    check_ids("messaging_service_ids", &p.messaging_service_ids)?;
    confirm::require(&p.confirmation, &format!("ASSOCIATE AEM PORTAL {}", p.id))?;
    let body = json!({ "messagingServiceIds": p.messaging_service_ids });
    let (_, body) = cloud.request(Method::PUT, &format!("{path}/messagingServices"), &[], Some(body)).await?;
    Ok(take_data(body))
}

pub async fn export_asyncapi(cloud: &CloudClient, p: ExportParams) -> Result<Value, AemError> {
    check_id("application_version_id", &p.application_version_id)?;
    let format = p.format.unwrap_or(ExportFormat::Json).name();
    let version = p.asyncapi_version.unwrap_or(AsyncApiVersion::V2_5_0).name();
    let path = format!("{ARCH}/applicationVersions/{}/exports/asyncApi", p.application_version_id);
    let query = vec![("format".to_owned(), format.to_owned()), ("asyncApiVersion".to_owned(), version.to_owned())];
    let document = cloud.get(&path, &query).await?;
    let text = match &document {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if text.len() <= EXPORT_LIMIT {
        return Ok(json!({ "format": format, "document": document, "truncated": false }));
    }
    let mut end = EXPORT_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(json!({ "format": format, "document": &text[..end], "truncated": true }))
}
