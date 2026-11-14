//! Configuration: MCP host environment over the stored webgui.json (written by
//! `sap-ai-dev --setup-webgui`). Credentials are never read from the file.
use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

pub const DEFAULT_RELAY_PORT: u16 = 47823;
pub const WEBGUI_PATH: &str = "/sap/bc/gui/sap/its/webgui";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Relay,
    Headless,
}

impl Mode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "relay" => Ok(Self::Relay),
            "headless" | "managed" => Ok(Self::Headless),
            other => Err(format!("mode must be relay or headless, got {other:?}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Relay => "relay",
            Self::Headless => "headless",
        }
    }
}

#[derive(Clone)]
pub struct Credentials {
    pub user: String,
    pub password: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials").field("user", &self.user).field("password", &"[redacted]").finish()
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// Base URL without path, e.g. `https://host:44300`.
    pub url: Option<String>,
    pub client: Option<String>,
    pub language: String,
    /// DNS name the certificate is issued for when `url` uses an IP address.
    pub tls_server_name: Option<String>,
    pub mode: Mode,
    pub headed: bool,
    pub relay_port: u16,
    pub relay_token: Option<String>,
    pub browser: Option<PathBuf>,
    pub credentials: Option<Credentials>,
    pub stored_path: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    url: Option<String>,
    client: Option<String>,
    language: Option<String>,
    tls_server_name: Option<String>,
    mode: Option<String>,
    relay_port: Option<u16>,
    relay_token: Option<String>,
}

fn get<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key).map(|v| v.trim()).filter(|v| !v.is_empty())
}

fn truthy(value: Option<&str>) -> bool {
    matches!(value.map(str::to_ascii_lowercase).as_deref(), Some("1" | "true" | "yes"))
}

pub fn stored_path(env: &HashMap<String, String>) -> Option<PathBuf> {
    let base = match get(env, "XDG_CONFIG_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(get(env, "HOME").or_else(|| get(env, "USERPROFILE"))?).join(".config"),
    };
    Some(base.join("sap-ai-dev-toolkit").join("webgui.json"))
}

pub fn cache_dir(env: &HashMap<String, String>) -> Option<PathBuf> {
    if let Some(dir) = get(env, "SAP_AI_DEV_TOOLKIT_CACHE_DIR") {
        return Some(PathBuf::from(dir));
    }
    let base = match get(env, "XDG_CACHE_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(get(env, "HOME").or_else(|| get(env, "USERPROFILE"))?).join(".cache"),
    };
    Some(base.join("sap-ai-dev-toolkit"))
}

fn read_stored(path: Option<&PathBuf>) -> Result<Stored, String> {
    let Some(path) = path else { return Ok(Stored::default()) };
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("stored WebGUI settings at {} are not valid JSON ({e}); rerun sap-ai-dev --setup-webgui", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

/// `https://host:port/any/path?x` → `https://host:port`; a pasted WebGUI or ADT path is dropped.
pub fn base_url(raw: &str) -> Result<String, String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| format!("invalid WebGUI URL {raw:?}: {e}"))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(format!("WebGUI URL must be http(s), got {raw:?}"));
    }
    let host = parsed.host_str().ok_or_else(|| format!("WebGUI URL {raw:?} has no host"))?;
    Ok(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

pub fn resolve(env: &HashMap<String, String>) -> Result<Config, String> {
    let path = stored_path(env);
    let stored = read_stored(path.as_ref())?;
    let url = get(env, "SAP_WEBGUI_URL").or_else(|| get(env, "SAP_URL")).map(str::to_owned).or(stored.url);
    let url = url.map(|u| base_url(&u)).transpose()?;
    let credentials = match (get(env, "SAP_USER"), get(env, "SAP_PASSWORD")) {
        (Some(user), Some(password)) => Some(Credentials { user: user.to_owned(), password: password.to_owned() }),
        _ => None,
    };
    let mode = match get(env, "SAP_AI_DEV_TOOLKIT_WEBGUI_MODE").map(str::to_owned).or(stored.mode) {
        Some(mode) => Mode::parse(&mode)?,
        None if credentials.is_some() => Mode::Headless,
        None => Mode::Relay,
    };
    let relay_port = match get(env, "SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_PORT") {
        Some(port) => port.parse().map_err(|_| format!("SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_PORT must be a port number, got {port:?}"))?,
        None => stored.relay_port.unwrap_or(DEFAULT_RELAY_PORT),
    };
    let tls_server_name = get(env, "SAP_TLS_SERVER_NAMES")
        .and_then(|names| names.split([',', ' ']).map(str::trim).find(|n| !n.is_empty()))
        .map(str::to_owned)
        .or(stored.tls_server_name);
    Ok(Config {
        url,
        client: get(env, "SAP_CLIENT").map(str::to_owned).or(stored.client),
        language: get(env, "SAP_LANGUAGE").map(str::to_owned).or(stored.language).unwrap_or_else(|| "EN".into()),
        tls_server_name,
        mode,
        headed: truthy(get(env, "SAP_AI_DEV_TOOLKIT_WEBGUI_HEADED")),
        relay_port,
        relay_token: get(env, "SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_TOKEN").map(str::to_owned).or(stored.relay_token).filter(|t| !t.is_empty()),
        browser: get(env, "SAP_AI_WEBGUI_BROWSER").or_else(|| get(env, "SAP_BROWSER_EXEC")).map(PathBuf::from),
        credentials,
        stored_path: path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        let mut map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
        map.insert("XDG_CONFIG_HOME".into(), "/nonexistent-webgui-test".into());
        map
    }

    #[test]
    fn credentials_select_headless_and_url_is_reduced_to_origin() {
        let config = resolve(&env(&[
            ("SAP_URL", "https://10.0.0.5:44300/sap/bc/adt/"),
            ("SAP_USER", "U"),
            ("SAP_PASSWORD", "P"),
            ("SAP_TLS_SERVER_NAMES", "sap.example.com"),
        ]))
        .unwrap();
        assert_eq!(config.mode, Mode::Headless);
        assert_eq!(config.url.as_deref(), Some("https://10.0.0.5:44300"));
        assert_eq!(config.tls_server_name.as_deref(), Some("sap.example.com"));
        assert!(!format!("{config:?}").contains("\"P\""));
    }

    #[test]
    fn relay_is_default_without_credentials() {
        let config = resolve(&env(&[])).unwrap();
        assert_eq!(config.mode, Mode::Relay);
        assert_eq!(config.relay_port, DEFAULT_RELAY_PORT);
        assert_eq!(config.language, "EN");
    }
}
