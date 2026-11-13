//! HTTP clients for the Cloud API (bearer token) and broker SEMP (Basic auth).
//! Error texts never include URL queries or headers.
use std::time::Duration;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client, Method, RequestBuilder};
use serde_json::Value;

use crate::VERSION;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AemError {
    pub message: String,
    /// HTTP status when the error is an HTTP response.
    pub status: Option<u16>,
}

impl AemError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self { message: message.into(), status: None }
    }
}

impl From<String> for AemError {
    fn from(message: String) -> Self {
        Self::msg(message)
    }
}

impl From<&str> for AemError {
    fn from(message: &str) -> Self {
        Self::msg(message)
    }
}

pub fn build_client(ca_file: Option<&(&'static str, String)>) -> Result<Client, AemError> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .user_agent(format!("sap-ai-aem/{VERSION}"));
    if let Some((var, path)) = ca_file {
        let error = || AemError::msg(format!("{var} {path} could not be read as PEM certificates"));
        let pem = std::fs::read(path).map_err(|_| error())?;
        let certificates = reqwest::Certificate::from_pem_bundle(&pem).map_err(|_| error())?;
        if certificates.is_empty() {
            return Err(error());
        }
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder.build().map_err(|e| AemError::msg(format!("HTTP client could not be created: {e}")))
}

fn truncate(text: &str) -> String {
    text.chars().take(500).collect()
}

fn error_chain(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let part = cause.to_string();
        if !text.contains(&part) {
            text.push_str(": ");
            text.push_str(&part);
        }
        source = cause.source();
    }
    text
}

#[derive(Clone, Copy)]
enum Api {
    Cloud,
    Semp,
}

impl Api {
    fn label(self) -> &'static str {
        match self {
            Api::Cloud => "Advanced Event Mesh API",
            Api::Semp => "SEMP",
        }
    }

    fn failure(self, method: &Method, path: &str, status: u16, body: &Value, raw: &str) -> String {
        let fallback = || {
            let raw = raw.trim();
            if raw.is_empty() {
                reqwest::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("no response body").to_owned()
            } else {
                truncate(raw)
            }
        };
        match self {
            Api::Cloud => {
                let message = body.get("message").and_then(Value::as_str).map(truncate).unwrap_or_else(fallback);
                let mut text = format!("Advanced Event Mesh API {method} {path} failed (HTTP {status}): {message}");
                if let Some(details) = body.get("validationDetails").and_then(Value::as_object) {
                    for (field, messages) in details {
                        let joined = match messages {
                            Value::Array(items) => items.iter().map(|m| m.as_str().map(str::to_owned).unwrap_or_else(|| m.to_string())).collect::<Vec<_>>().join(", "),
                            other => other.as_str().map(str::to_owned).unwrap_or_else(|| other.to_string()),
                        };
                        text.push_str(&format!("; {field}: {}", truncate(&joined)));
                    }
                }
                text
            }
            Api::Semp => {
                let error = body.pointer("/meta/error");
                let semp_status = error.and_then(|e| e.get("status")).and_then(Value::as_str);
                let description = error.and_then(|e| e.get("description")).and_then(Value::as_str).map(truncate).unwrap_or_else(fallback);
                let mut text = match semp_status {
                    Some(s) => format!("SEMP {method} {path} failed (HTTP {status}, {s}): {description}"),
                    None => format!("SEMP {method} {path} failed (HTTP {status}): {description}"),
                };
                match status {
                    529 => text.push_str(" (no SEMP session slot available on the broker; retry later)"),
                    401 => text.push_str(" (check the SEMP user and password)"),
                    _ => {}
                }
                text
            }
        }
    }
}

async fn execute(
    api: Api,
    request: RequestBuilder,
    method: &Method,
    path: &str,
) -> Result<(u16, Value), AemError> {
    let transport = |e: reqwest::Error| AemError::msg(format!("{} {method} {path} request failed: {}", api.label(), error_chain(&e.without_url())));
    let response = request.send().await.map_err(transport)?;
    let status = response.status().as_u16();
    let raw = response.text().await.map_err(transport)?;
    let body = if raw.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&raw).unwrap_or_else(|_| Value::String(raw.clone()))
    };
    if !(200..300).contains(&status) {
        return Err(AemError { message: api.failure(method, path, status, &body, &raw), status: Some(status) });
    }
    Ok((status, body))
}

/// Query values keep `,` literal: SEMP splits `select`/`where` lists (and Mission
/// Control `expand` lists) on a raw comma before decoding, so `%2C` breaks them.
const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~').remove(b',');

fn request_url(base: &str, path: &str, query: &[(String, String)]) -> String {
    let mut url = format!("{base}{path}");
    for (index, (key, value)) in query.iter().enumerate() {
        url.push(if index == 0 { '?' } else { '&' });
        url.extend(utf8_percent_encode(key, QUERY_VALUE));
        url.push('=');
        url.extend(utf8_percent_encode(value, QUERY_VALUE));
    }
    url
}

fn prepare(http: &Client, base: &str, method: &Method, path: &str, query: &[(String, String)], body: Option<Value>) -> RequestBuilder {
    let mut request = http.request(method.clone(), request_url(base, path, query));
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
}

#[cfg(test)]
mod tests {
    use super::request_url;

    #[test]
    fn query_keeps_list_commas_literal_and_encodes_the_rest() {
        let query = [
            ("select".to_owned(), "queueName,msgs".to_owned()),
            ("where".to_owned(), "queueName==e2e/q*".to_owned()),
            ("ids".to_owned(), "a".to_owned()),
            ("ids".to_owned(), "b&c".to_owned()),
        ];
        assert_eq!(
            request_url("http://h", "/p", &query),
            "http://h/p?select=queueName,msgs&where=queueName%3D%3De2e%2Fq%2A&ids=a&ids=b%26c"
        );
        assert_eq!(request_url("http://h", "/p", &[]), "http://h/p");
    }
}

pub struct CloudClient {
    pub http: Client,
    pub url: String,
    pub token: String,
}

impl CloudClient {
    pub async fn request(&self, method: Method, path: &str, query: &[(String, String)], body: Option<Value>) -> Result<(u16, Value), AemError> {
        let request = prepare(&self.http, &self.url, &method, path, query, body).bearer_auth(&self.token);
        execute(Api::Cloud, request, &method, path).await
    }

    pub async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value, AemError> {
        Ok(self.request(Method::GET, path, query, None).await?.1)
    }
}

pub struct SempClient {
    pub http: Client,
    pub url: String,
    pub msg_vpn: String,
    pub username: String,
    pub password: String,
}

impl SempClient {
    pub async fn request(&self, method: Method, path: &str, query: &[(String, String)], body: Option<Value>) -> Result<(u16, Value), AemError> {
        let request = prepare(&self.http, &self.url, &method, path, query, body).basic_auth(&self.username, Some(&self.password));
        execute(Api::Semp, request, &method, path).await
    }
}
