//! Managed Chromium-family browser for headless mode: own profile, CDP over a
//! loopback WebSocket announced in `<profile>/DevToolsActivePort`.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::cdp::{DEFAULT_TIMEOUT, Link, Rpc};

const CANDIDATES_MAC: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const CANDIDATES_LINUX: &[&str] = &[
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
];
const CANDIDATES_WINDOWS: &[&str] = &[
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
];

pub fn find_executable(configured: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = configured {
        return if path.exists() { Ok(path.to_owned()) } else { Err(format!("browser executable {} does not exist", path.display())) };
    }
    let candidates = if cfg!(target_os = "macos") {
        CANDIDATES_MAC
    } else if cfg!(windows) {
        CANDIDATES_WINDOWS
    } else {
        CANDIDATES_LINUX
    };
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .ok_or_else(|| "no Chrome, Edge or Chromium found; set SAP_AI_WEBGUI_BROWSER to the browser executable".into())
}

/// Profile directory: persistent (keeps an interactive SSO sign-in) or a
/// private temporary one removed when the browser closes.
pub enum Profile {
    Persistent(PathBuf),
    Temporary(PathBuf),
}

impl Profile {
    pub fn temporary() -> Result<Self, String> {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("sap-ai-webgui-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create browser profile {}: {e}", dir.display()))?;
        Ok(Self::Temporary(dir))
    }

    pub fn path(&self) -> &Path {
        match self {
            Self::Persistent(p) | Self::Temporary(p) => p,
        }
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        if let Self::Temporary(dir) = self {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

pub struct Browser {
    child: Child,
    rpc: Arc<Rpc>,
    // Dropped after the child is killed (field order).
    _profile: Profile,
}

pub struct LaunchOptions<'a> {
    pub executable: &'a Path,
    pub profile: Profile,
    pub headed: bool,
    /// `--host-resolver-rules` value, e.g. `MAP sap.example.com 10.0.0.5`.
    pub host_rules: Option<String>,
    pub width: u32,
    pub height: u32,
}

async fn read_devtools_port(profile: &Path, child: &mut Child, deadline: Instant) -> Result<String, String> {
    let file = profile.join("DevToolsActivePort");
    loop {
        if let Ok(text) = tokio::fs::read_to_string(&file).await {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                return Ok(format!("ws://127.0.0.1:{}{}", port.trim(), path.trim()));
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "browser exited ({status}) before opening DevTools; another instance may hold the profile {}",
                profile.display()
            ));
        }
        if Instant::now() > deadline {
            return Err("browser did not open its DevTools port within 30 s".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

impl Browser {
    pub async fn launch(options: LaunchOptions<'_>) -> Result<Self, String> {
        let profile_path = options.profile.path().to_owned();
        let _ = std::fs::remove_file(profile_path.join("DevToolsActivePort"));
        let mut command = Command::new(options.executable);
        command
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile_path.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-features=Translate,MediaRouter")
            .arg("--disable-background-networking")
            .arg(format!("--window-size={},{}", options.width, options.height));
        if !options.headed {
            command.arg("--headless=new");
        }
        if let Some(rules) = &options.host_rules {
            command.arg(format!("--host-resolver-rules={rules}"));
        }
        command.arg("about:blank").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| format!("cannot start {}: {e}", options.executable.display()))?;
        let url = read_devtools_port(&profile_path, &mut child, Instant::now() + Duration::from_secs(30)).await?;
        let (ws, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| format!("cannot connect to browser DevTools: {e}"))?;
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let rpc = Rpc::start(ws, Some(events_tx));
        tokio::spawn(handle_dialogs(rpc.clone(), events_rx));
        Ok(Self { child, rpc, _profile: options.profile })
    }

    async fn browser_call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut fields = Map::new();
        fields.insert("method".into(), json!(method));
        fields.insert("params".into(), params);
        self.rpc.request(fields, DEFAULT_TIMEOUT).await
    }

    /// Opens a page and returns a flat-session link to it.
    pub async fn new_page(&self, width: u32, height: u32) -> Result<Link, String> {
        let target = self.browser_call("Target.createTarget", json!({ "url": "about:blank" })).await?;
        let target_id = target["targetId"].as_str().ok_or("browser returned no target id")?.to_owned();
        let attached = self.browser_call("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true })).await?;
        let session = attached["sessionId"].as_str().ok_or("browser returned no session id")?.to_owned();
        let link = Link::Direct { rpc: self.rpc.clone(), session };
        link.call("Page.enable", json!({}), DEFAULT_TIMEOUT).await?;
        link.call("Emulation.setDeviceMetricsOverride", json!({ "width": width, "height": height, "deviceScaleFactor": 1, "mobile": false }), DEFAULT_TIMEOUT).await?;
        Ok(link)
    }

    pub async fn close(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(3), self.browser_call("Browser.close", json!({}))).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        let _ = self.child.kill().await;
    }
}

/// WebGUI pages can raise `beforeunload` prompts when a transaction ends;
/// accept those, dismiss anything else, so automation never blocks.
async fn handle_dialogs(rpc: Arc<Rpc>, mut events: mpsc::UnboundedReceiver<Value>) {
    while let Some(event) = events.recv().await {
        if event.get("method").and_then(Value::as_str) != Some("Page.javascriptDialogOpening") {
            continue;
        }
        let accept = matches!(event.pointer("/params/type").and_then(Value::as_str), Some("beforeunload" | "alert"));
        let mut fields = Map::new();
        fields.insert("method".into(), json!("Page.handleJavaScriptDialog"));
        fields.insert("params".into(), json!({ "accept": accept }));
        if let Some(session) = event.get("sessionId") {
            fields.insert("sessionId".into(), session.clone());
        }
        let rpc = rpc.clone();
        tokio::spawn(async move {
            let _ = rpc.request(fields, Duration::from_secs(5)).await;
        });
    }
}
