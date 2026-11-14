//! Request/response plumbing shared by both transports: a JSON-over-WebSocket
//! RPC (`Rpc`) and the page link (`Link`) the WebGUI driver talks to.
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::relay::RelayHub;

type Reply = Result<Value, String>;
type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;
type BoxSink = Pin<Box<dyn Sink<Message, Error = WsError> + Send>>;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// JSON messages with a numeric `id` are replies; anything else is an event.
pub struct Rpc {
    sink: Mutex<BoxSink>,
    pending: Pending,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
}

fn error_text(error: &Value) -> String {
    match error {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            let message = map.get("message").and_then(Value::as_str).unwrap_or("error");
            match map.get("data").and_then(Value::as_str) {
                Some(data) => format!("{message}: {data}"),
                None => message.to_owned(),
            }
        }
        other => other.to_string(),
    }
}

impl Rpc {
    /// Starts the reader task; events are forwarded to `events` when given.
    pub fn start<S>(ws: S, events: Option<mpsc::UnboundedSender<Value>>) -> Arc<Self>
    where
        S: Stream<Item = Result<Message, WsError>> + Sink<Message, Error = WsError> + Send + 'static,
    {
        let (sink, mut stream) = ws.split();
        let pending: Pending = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let rpc = Arc::new(Self { sink: Mutex::new(Box::pin(sink)), pending: pending.clone(), next: AtomicU64::new(1), alive: alive.clone() });
        tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let Ok(text) = message.to_text() else { continue };
                let Ok(value) = serde_json::from_str::<Value>(text) else { continue };
                match value.get("id").and_then(Value::as_u64) {
                    Some(id) => {
                        let reply = match value.get("error") {
                            Some(error) if !error.is_null() => Err(error_text(error)),
                            _ => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(reply);
                        }
                    }
                    None => {
                        if let Some(events) = &events {
                            let _ = events.send(value);
                        }
                    }
                }
            }
            alive.store(false, Ordering::SeqCst);
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err("browser connection closed".into()));
            }
        });
        rpc
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub async fn send_raw(&self, value: Value) -> Result<(), String> {
        self.sink.lock().await.send(Message::text(value.to_string())).await.map_err(|e| format!("browser connection: {e}"))
    }

    /// Sends `fields` plus a fresh `id` and waits for the matching reply.
    pub async fn request(&self, mut fields: Map<String, Value>, timeout: Duration) -> Reply {
        if !self.alive() {
            return Err("browser connection closed".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        fields.insert("id".into(), json!(id));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(error) = self.send_raw(Value::Object(fields)).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("browser connection closed".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("browser did not answer within {} s", timeout.as_secs()))
            }
        }
    }
}

/// One attached WebGUI page, either a flat CDP session on a managed browser
/// or a tab in the user's Chrome driven through the relay extension.
pub enum Link {
    Direct { rpc: Arc<Rpc>, session: String },
    Relay { hub: Arc<RelayHub>, tab: i64 },
}

impl Link {
    pub async fn call(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        match self {
            Self::Direct { rpc, session } => {
                let mut fields = Map::new();
                fields.insert("method".into(), json!(method));
                fields.insert("params".into(), params);
                fields.insert("sessionId".into(), json!(session));
                rpc.request(fields, timeout).await
            }
            Self::Relay { hub, tab } => hub.request("cdp", json!({ "tabId": tab, "method": method, "params": params }), timeout).await,
        }
    }

    pub fn alive(&self) -> bool {
        match self {
            Self::Direct { rpc, .. } => rpc.alive(),
            Self::Relay { hub, .. } => hub.connected(),
        }
    }
}
