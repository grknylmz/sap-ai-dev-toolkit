//! Credential resolution for the Cloud API (Mission Control, Event Portal) and
//! broker SEMP. Mirrors the Node companions: explicit environment first, then
//! the JSON variables shared with the Integration Suite companion, then the
//! user-only file written by `sap-ai-dev --setup-aem`.
use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;

pub const DEFAULT_API_URL: &str = "https://api.solace.cloud";

const SEMP_VARS: [&str; 4] = ["AEM_SEMP_URL", "AEM_SEMP_MSG_VPN", "AEM_SEMP_USERNAME", "AEM_SEMP_PASSWORD"];

#[derive(Debug, Clone)]
pub struct CloudConfig {
    pub url: String,
    pub token: String,
    pub source: &'static str,
}

#[derive(Debug, Clone)]
pub struct SempConfig {
    pub url: String,
    pub msg_vpn: String,
    pub username: String,
    pub password: String,
    pub source: &'static str,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub cloud: Option<CloudConfig>,
    pub semp: Option<SempConfig>,
    /// (variable name, PEM bundle path) of extra trusted roots.
    pub ca_file: Option<(&'static str, String)>,
}

fn get<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key).map(|v| v.trim()).filter(|v| !v.is_empty())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

/// `<config home>/sap-ai-dev-toolkit/aem.json`, matching `userConfigFilePath` in
/// src/integration-credentials.mjs.
pub fn stored_path(env: &HashMap<String, String>) -> Option<PathBuf> {
    let base = match get(env, "XDG_CONFIG_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(
            env.get("HOME").filter(|v| !v.is_empty()).or_else(|| env.get("USERPROFILE").filter(|v| !v.is_empty()))?,
        )
        .join(".config"),
    };
    Some(base.join("sap-ai-dev-toolkit").join("aem.json"))
}

fn read_stored(env: &HashMap<String, String>) -> Result<Option<Value>, String> {
    let Some(path) = stored_path(env) else { return Ok(None) };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(format!("Stored Advanced Event Mesh credentials at {} could not be read", path.display())),
    };
    serde_json::from_str(&text).map(Some).map_err(|_| {
        format!(
            "Stored Advanced Event Mesh credentials at {} are not valid JSON; rerun sap-ai-dev --setup-aem",
            path.display()
        )
    })
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "[::1]" | "::1" | "localhost")
}

/// https only (http allowed on loopback); returns the URL without a trailing slash.
pub fn validate_url(name: &str, raw: &str) -> Result<String, String> {
    let error = || format!("{name} must be an https URL");
    let parsed = url::Url::parse(raw.trim()).map_err(|_| error())?;
    let host = parsed.host_str().ok_or_else(error)?;
    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        _ => return Err(error()),
    }
    Ok(raw.trim().trim_end_matches('/').to_owned())
}

fn parse_json_var(env: &HashMap<String, String>, name: &str) -> Result<Option<Value>, String> {
    match get(env, name) {
        None => Ok(None),
        Some(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(value) if value.is_object() => Ok(Some(value)),
            _ => Err(format!("{name} is not valid JSON")),
        },
    }
}

fn api_url(env: &HashMap<String, String>) -> Result<String, String> {
    validate_url("AEM_API_URL", get(env, "AEM_API_URL").unwrap_or(DEFAULT_API_URL))
}

fn resolve_cloud(env: &HashMap<String, String>, stored: Option<&Value>) -> Result<Option<CloudConfig>, String> {
    if let Some(token) = get(env, "AEM_API_TOKEN") {
        return Ok(Some(CloudConfig { url: api_url(env)?, token: token.to_owned(), source: "environment" }));
    }
    if let Some(value) = parse_json_var(env, "AEM_CONFIG")? {
        let token = text(&value, "apiToken").ok_or("AEM_CONFIG is missing apiToken")?;
        return Ok(Some(CloudConfig { url: api_url(env)?, token, source: "aem-config" }));
    }
    if let Some(api) = stored.and_then(|s| s.get("api")).filter(|a| a.is_object())
        && let Some(token) = text(api, "token")
    {
        let url = validate_url("stored api.url", &text(api, "url").unwrap_or_else(|| DEFAULT_API_URL.to_owned()))?;
        return Ok(Some(CloudConfig { url, token, source: "stored" }));
    }
    Ok(None)
}

fn resolve_semp(env: &HashMap<String, String>, stored: Option<&Value>) -> Result<Option<SempConfig>, String> {
    if SEMP_VARS.iter().any(|key| env.get(*key).is_some_and(|v| !v.is_empty())) {
        let missing: Vec<&str> = SEMP_VARS.iter().copied().filter(|key| get(env, key).is_none()).collect();
        if !missing.is_empty() {
            return Err(format!("Explicit AEM_SEMP configuration is incomplete: {}", missing.join(", ")));
        }
        return Ok(Some(SempConfig {
            url: validate_url("AEM_SEMP_URL", get(env, "AEM_SEMP_URL").unwrap_or_default())?,
            msg_vpn: get(env, "AEM_SEMP_MSG_VPN").unwrap_or_default().to_owned(),
            username: get(env, "AEM_SEMP_USERNAME").unwrap_or_default().to_owned(),
            password: env.get("AEM_SEMP_PASSWORD").cloned().unwrap_or_default(),
            source: "environment",
        }));
    }
    if let Some(value) = parse_json_var(env, "AEM_SEMP_CONFIG")? {
        let fields = ["url", "msgVpnName", "username", "password"];
        let missing: Vec<&str> = fields.iter().copied().filter(|f| text(&value, f).is_none()).collect();
        if !missing.is_empty() {
            return Err(format!("AEM_SEMP_CONFIG is missing {}", missing.join(", ")));
        }
        let field = |f: &str| text(&value, f).unwrap_or_default();
        return Ok(Some(SempConfig {
            url: validate_url("AEM_SEMP_CONFIG url", &field("url"))?,
            msg_vpn: field("msgVpnName"),
            username: field("username"),
            password: field("password"),
            source: "aem-semp-config",
        }));
    }
    if let Some(semp) = stored.and_then(|s| s.get("semp")).filter(|s| s.is_object()) {
        let fields = ["url", "msg_vpn", "username", "password"];
        let missing: Vec<&str> = fields.iter().copied().filter(|f| text(semp, f).is_none()).collect();
        if !missing.is_empty() {
            return Err(format!(
                "Stored advanced event mesh SEMP credentials are missing {}; rerun sap-ai-dev --setup-aem",
                missing.join(", ")
            ));
        }
        let field = |f: &str| text(semp, f).unwrap_or_default();
        return Ok(Some(SempConfig {
            url: validate_url("stored semp.url", &field("url"))?,
            msg_vpn: field("msg_vpn"),
            username: field("username"),
            password: field("password"),
            source: "stored",
        }));
    }
    Ok(None)
}

pub fn resolve(env: &HashMap<String, String>) -> Result<Config, String> {
    let stored = read_stored(env)?;
    let cloud = resolve_cloud(env, stored.as_ref())?;
    let semp = resolve_semp(env, stored.as_ref())?;
    if cloud.is_none() && semp.is_none() {
        return Err("Configure SAP Integration Suite, advanced event mesh: set AEM_API_TOKEN (Cloud API token, optional AEM_API_URL), or AEM_SEMP_URL/AEM_SEMP_MSG_VPN/AEM_SEMP_USERNAME/AEM_SEMP_PASSWORD, in the MCP host environment, or run sap-ai-dev --setup-aem.".to_owned());
    }
    let ca_file = get(env, "AEM_CA_FILE")
        .map(|p| ("AEM_CA_FILE", p.to_owned()))
        .or_else(|| get(env, "NODE_EXTRA_CA_CERTS").map(|p| ("NODE_EXTRA_CA_CERTS", p.to_owned())));
    Ok(Config { cloud, semp, ca_file })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        let dir = std::env::temp_dir().join(format!("sap-ai-aem-config-test-{}", std::process::id()));
        let mut map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        map.entry("XDG_CONFIG_HOME".into()).or_insert_with(|| dir.join("empty").display().to_string());
        map
    }

    fn with_stored(contents: &str, pairs: &[(&str, &str)]) -> HashMap<String, String> {
        let dir = std::env::temp_dir().join(format!("sap-ai-aem-stored-{}-{}", std::process::id(), contents.len()));
        std::fs::create_dir_all(dir.join("sap-ai-dev-toolkit")).unwrap();
        std::fs::write(dir.join("sap-ai-dev-toolkit").join("aem.json"), contents).unwrap();
        let mut map = env(pairs);
        map.insert("XDG_CONFIG_HOME".into(), dir.display().to_string());
        map
    }

    #[test]
    fn cloud_precedence_env_then_aem_config_then_stored() {
        let stored = r#"{"api":{"url":"https://api.solacecloud.eu","token":"stored-token"}}"#;
        let all = with_stored(stored, &[("AEM_API_TOKEN", "env-token"), ("AEM_CONFIG", r#"{"apiToken":"cfg-token"}"#)]);
        let cloud = resolve(&all).unwrap().cloud.unwrap();
        assert_eq!((cloud.token.as_str(), cloud.source), ("env-token", "environment"));

        let no_env = with_stored(stored, &[("AEM_CONFIG", r#"{"apiToken":"cfg-token"}"#)]);
        let cloud = resolve(&no_env).unwrap().cloud.unwrap();
        assert_eq!((cloud.token.as_str(), cloud.source, cloud.url.as_str()), ("cfg-token", "aem-config", DEFAULT_API_URL));

        let only_stored = with_stored(stored, &[]);
        let cloud = resolve(&only_stored).unwrap().cloud.unwrap();
        assert_eq!((cloud.token.as_str(), cloud.source, cloud.url.as_str()), ("stored-token", "stored", "https://api.solacecloud.eu"));
    }

    #[test]
    fn partial_semp_env_is_rejected() {
        let error = resolve(&env(&[
            ("AEM_SEMP_URL", "https://mr-x.messaging.solace.cloud:943"),
            ("AEM_SEMP_MSG_VPN", "default"),
            ("AEM_SEMP_USERNAME", "admin"),
        ]))
        .unwrap_err();
        assert_eq!(error, "Explicit AEM_SEMP configuration is incomplete: AEM_SEMP_PASSWORD");
    }

    #[test]
    fn url_validation() {
        assert_eq!(validate_url("AEM_API_URL", "http://example.com").unwrap_err(), "AEM_API_URL must be an https URL");
        assert_eq!(validate_url("AEM_API_URL", "http://127.0.0.1:9/").unwrap(), "http://127.0.0.1:9");
        assert_eq!(validate_url("AEM_API_URL", "https://api.solace.cloud/").unwrap(), "https://api.solace.cloud");
    }

    #[test]
    fn nothing_configured() {
        let error = resolve(&env(&[])).unwrap_err();
        assert!(error.starts_with("Configure SAP Integration Suite, advanced event mesh"), "{error}");
    }
}
