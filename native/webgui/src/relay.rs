//! Relay mode: the "SAP AI WebGUI Relay" Chrome extension connects to this
//! loopback WebSocket, proves the pairing token, and then executes tab and
//! `chrome.debugger` commands on the user's own signed-in browser.
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;

use crate::cdp::Rpc;

pub const PROTOCOL: u64 = 1;

pub struct RelayHub {
    port: u16,
    token: Option<String>,
    conn: StdMutex<Option<Arc<Rpc>>>,
    listening: tokio::sync::Mutex<bool>,
    changed: Notify,
    pub last_error: StdMutex<Option<String>>,
}

fn same_token(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(clippy::result_large_err)]
fn check_origin(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    let origin = request.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
    if origin.starts_with("chrome-extension://") {
        Ok(response)
    } else {
        let mut reject = ErrorResponse::new(Some("only the SAP AI WebGUI Relay extension may connect".into()));
        *reject.status_mut() = StatusCode::FORBIDDEN;
        Err(reject)
    }
}

impl RelayHub {
    pub fn new(port: u16, token: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            port,
            token,
            conn: StdMutex::new(None),
            listening: tokio::sync::Mutex::new(false),
            changed: Notify::new(),
            last_error: StdMutex::new(None),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    pub fn connected(&self) -> bool {
        self.conn.lock().unwrap().as_ref().is_some_and(|c| c.alive())
    }

    /// Binds `127.0.0.1:<port>` once; later calls are no-ops. Fails when no
    /// pairing token is configured or the port is taken.
    pub async fn ensure_listening(self: &Arc<Self>) -> Result<(), String> {
        let mut listening = self.listening.lock().await;
        if *listening {
            return Ok(());
        }
        if self.token.is_none() {
            return Err("relay mode needs a pairing token: run sap-ai-dev --setup-webgui (or set SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_TOKEN) and paste the same token into the extension options".into());
        }
        let listener = TcpListener::bind(("127.0.0.1", self.port))
            .await
            .map_err(|e| format!("cannot listen for the relay extension on 127.0.0.1:{} ({e}); another sap-ai-webgui may be running", self.port))?;
        *listening = true;
        let hub = self.clone();
        tokio::spawn(async move {
            while let Ok((stream, peer)) = listener.accept().await {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let hub = hub.clone();
                tokio::spawn(async move {
                    if let Err(error) = hub.accept(stream).await {
                        *hub.last_error.lock().unwrap() = Some(error);
                    }
                });
            }
        });
        Ok(())
    }

    async fn accept(self: &Arc<Self>, stream: TcpStream) -> Result<(), String> {
        let mut ws = tokio_tungstenite::accept_hdr_async(stream, check_origin).await.map_err(|e| format!("relay handshake: {e}"))?;
        let hello = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .map_err(|_| "relay extension sent no hello".to_owned())?
            .ok_or("relay extension disconnected")?
            .map_err(|e| format!("relay: {e}"))?;
        let hello: Value = serde_json::from_str(hello.to_text().unwrap_or("")).unwrap_or(Value::Null);
        let token = hello.get("token").and_then(Value::as_str).unwrap_or("");
        let expected = self.token.as_deref().unwrap_or("");
        if hello.get("type").and_then(Value::as_str) != Some("hello") || !same_token(token, expected) {
            let _ = futures_util::SinkExt::send(&mut ws, Message::text(json!({ "type": "rejected", "reason": "pairing token does not match" }).to_string())).await;
            return Err("relay extension offered a wrong pairing token; paste the token from sap-ai-dev --setup-webgui into the extension options".into());
        }
        futures_util::SinkExt::send(&mut ws, Message::text(json!({ "type": "welcome", "protocol": PROTOCOL }).to_string()))
            .await
            .map_err(|e| format!("relay: {e}"))?;
        let rpc = Rpc::start(ws, None);
        *self.conn.lock().unwrap() = Some(rpc);
        *self.last_error.lock().unwrap() = None;
        self.changed.notify_waiters();
        Ok(())
    }

    pub async fn wait_connected(&self, timeout: Duration) -> Result<Arc<Rpc>, String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.changed.notified();
            if let Some(rpc) = self.conn.lock().unwrap().clone().filter(|c| c.alive()) {
                return Ok(rpc);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let detail = self.last_error.lock().unwrap().clone().map(|e| format!(" Last relay error: {e}")).unwrap_or_default();
                return Err(format!(
                    "the SAP AI WebGUI Relay extension did not connect to 127.0.0.1:{} within {} s. Run sap-ai-dev --setup-webgui, load the unpacked extension it installs (~/.config/sap-ai-dev-toolkit/sap-webgui-relay) in Chrome, paste this port and the pairing token into its options, and keep Chrome running.{detail}",
                    self.port,
                    timeout.as_secs()
                ));
            }
        }
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let rpc = self.conn.lock().unwrap().clone().filter(|c| c.alive()).ok_or("the relay extension is not connected")?;
        let mut fields = Map::new();
        fields.insert("type".into(), json!("request"));
        fields.insert("method".into(), json!(method));
        fields.insert("params".into(), params);
        rpc.request(fields, timeout).await
    }
}
