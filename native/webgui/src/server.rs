//! MCP server: one WebGUI session per server process.
use std::collections::BTreeMap;
use std::sync::Arc;

use base64::Engine;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::{Config, Mode};
use crate::relay::RelayHub;
use crate::session::{OpenOptions, Session};
use crate::{VERSION, recipes};

const INSTRUCTIONS: &str = "Drive SAP GUI for HTML (WebGUI) read-only: open a session, start display transactions, read screens (fields, buttons, tabs, ABAP lists, ALV grids, table controls), and run curated recipes. Use it only where ADT tools have no endpoint (background jobs, short dumps, authorization checks, user display, lock entries, customizing display). Refs like f3/b7/t2/g1 are valid for the screen they came from; read the returned screen after every change. Save/post/delete/change actions are refused. Always webgui_close when done.";
const NO_SESSION: &str = "no WebGUI session is open; call webgui_open first";
const SCREEN_ROWS: usize = 25;

#[derive(Clone)]
pub struct WebguiServer {
    config: Arc<Config>,
    hub: Arc<RelayHub>,
    session: Arc<Mutex<Option<Session>>>,
    tool_router: ToolRouter<Self>,
}

fn ok(value: Value) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(serde_json::to_string(&value).unwrap_or_else(|_| "null".into()))]))
}

fn fail(message: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(message.into())]))
}

fn respond(result: Result<Value, String>) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => ok(value),
        Err(message) => fail(message),
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NoParams {}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OpenParams {
    /// `relay` (your own signed-in Chrome through the SAP AI WebGUI Relay extension) or `headless` (managed browser). Default from setup.
    pub mode: Option<String>,
    /// WebGUI base URL, e.g. https://host:44300 (default from setup or SAP_URL).
    pub url: Option<String>,
    /// SAP client, e.g. 100.
    pub client: Option<String>,
    /// Logon language (default EN; the read-only guard matches English button texts).
    pub language: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScreenParams {
    /// Rows per table to include (default 25, max 500).
    pub rows: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StartParams {
    /// Transaction code, e.g. SM37.
    pub tcode: String,
    /// Fields to fill on the first screen, keyed by DDIC name from the SID (e.g. BTCH2170-USERNAME), SID, or ref.
    pub prefill: Option<BTreeMap<String, String>>,
    /// OK code / function code to submit after prefill, e.g. SHOW (guarded).
    pub okcode: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetFieldsParams {
    /// Values keyed by ref (f3), SID, or DDIC field name. Checkboxes take X/true or empty/false.
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PressParams {
    /// Button or tab ref (b7, t2), SID, or field name.
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    /// Function key: ENTER, F1-F12, SHIFT_F1-SHIFT_F12, CTRL_F1-CTRL_F12, ESC.
    pub fkey: Option<String>,
    /// OK code for the command field, e.g. /nSM21, P+ (guarded).
    pub okcode: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TableParams {
    /// Table ref from webgui_screen (g1).
    #[serde(rename = "ref")]
    pub reference: String,
    /// First rendered row to return (default 0).
    pub from: Option<usize>,
    /// Rows to return (default 100, max 500).
    pub count: Option<usize>,
    /// ABAP lists only: scroll first: first, next, prev or last (OK codes P--, P+, P-, P++).
    pub page: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeParams {
    /// Recipe name from webgui_list_recipes, e.g. sm37_jobs.
    pub name: String,
    /// Recipe parameters.
    pub params: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScreenshotParams {
    /// Also write the PNG to this absolute path.
    pub path: Option<String>,
}

impl WebguiServer {
    pub fn new(config: Config) -> Self {
        let hub = RelayHub::new(config.relay_port, config.relay_token.clone());
        if config.mode == Mode::Relay && config.relay_token.is_some() {
            // Listen early so the extension's reconnect loop pairs before the first webgui_open.
            let hub = hub.clone();
            tokio::spawn(async move {
                let _ = hub.ensure_listening().await;
            });
        }
        Self { config: Arc::new(config), hub, session: Arc::new(Mutex::new(None)), tool_router: Self::tool_router() }
    }

    pub fn summary(&self) -> Value {
        let c = &self.config;
        json!({
            "version": VERSION,
            "url": c.url,
            "client": c.client,
            "language": c.language,
            "tls_server_name": c.tls_server_name,
            "mode": c.mode.as_str(),
            "headed": c.headed,
            "credentials": if c.credentials.is_some() { "SAP_USER/SAP_PASSWORD from the host environment" } else { "none (relay session or interactive sign-in)" },
            "browser": crate::browser::find_executable(c.browser.as_deref()).map(|p| p.display().to_string()).unwrap_or_else(|e| e),
            "relay": { "port": self.hub.port(), "token_configured": self.hub.has_token(), "extension_connected": self.hub.connected() },
            "settings_file": c.stored_path.as_ref().map(|p| p.display().to_string()),
            "read_only": true,
        })
    }

    /// Closes the open session (logoff + browser/tab release), if any.
    pub async fn shutdown(&self) {
        if let Some(session) = self.session.lock().await.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(25), session.close()).await;
        }
    }

    async fn with_session<F>(&self, f: F) -> Result<Value, String>
    where
        F: for<'a> FnOnce(&'a mut Session) -> std::pin::Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>,
    {
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().ok_or(NO_SESSION)?;
        f(session).await
    }
}

async fn current(session: &mut Session, rows: usize) -> Result<Value, String> {
    Ok(session.screen().await?.to_json(rows))
}

#[tool_router]
impl WebguiServer {
    #[tool(
        description = "Show the WebGUI settings this server uses (URL, client, mode, browser, relay port and whether the relay extension is connected) without secrets.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn webgui_connection_info(&self, Parameters(_): Parameters<NoParams>) -> Result<CallToolResult, ErrorData> {
        let mut info = self.summary();
        info["session_open"] = json!(self.session.lock().await.is_some());
        ok(info)
    }

    #[tool(
        description = "Open a WebGUI session (SAP GUI for HTML) and return the first screen. relay mode drives a tab in your own signed-in Chrome via the SAP AI WebGUI Relay extension; headless mode uses a managed browser and SAP_USER/SAP_PASSWORD (or an interactive sign-in window). On the Logon Status Check page it never cancels your other sessions. Reuses an open session.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn webgui_open(&self, Parameters(p): Parameters<OpenParams>) -> Result<CallToolResult, ErrorData> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_mut() {
            match session.screen().await {
                Ok(screen) => return ok(json!({ "reused": true, "screen": screen.to_json(SCREEN_ROWS) })),
                Err(_) => {
                    if let Some(stale) = guard.take() {
                        let _ = stale.close().await;
                    }
                }
            }
        }
        let mode = match p.mode.as_deref().map(Mode::parse).transpose() {
            Ok(mode) => mode.unwrap_or(self.config.mode),
            Err(e) => return fail(e),
        };
        let url = match p.url.map(|u| crate::config::base_url(&u)).transpose() {
            Ok(url) => url.or_else(|| self.config.url.clone()),
            Err(e) => return fail(e),
        };
        let Some(url) = url else {
            return fail("no WebGUI URL configured: pass url, set SAP_WEBGUI_URL/SAP_URL, or run sap-ai-dev --setup-webgui");
        };
        let options = OpenOptions { mode, url, client: p.client.or_else(|| self.config.client.clone()), language: p.language.unwrap_or_else(|| self.config.language.clone()) };
        match Session::open(&self.config, &self.hub, options).await {
            Ok((mut session, _)) => {
                let screen = session.screen().await.map(|s| s.to_json(SCREEN_ROWS));
                let mode = session.mode.as_str();
                *guard = Some(session);
                respond(screen.map(|s| json!({ "reused": false, "mode": mode, "screen": s })))
            }
            Err(e) => fail(e),
        }
    }

    #[tool(
        description = "Read the current WebGUI screen: transaction, PROGRAM/DYNPRO, title, status message, popups, fields (ref, SID, DDIC name, label, value), buttons (ref, text, tooltip, function key), tabs, and tables (ABAP lists as text lines, ALV grids and table controls as rows). Refs are valid for this screen only.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn webgui_screen(&self, Parameters(p): Parameters<ScreenParams>) -> Result<CallToolResult, ErrorData> {
        let rows = p.rows.unwrap_or(SCREEN_ROWS).min(500);
        respond(self.with_session(|s| Box::pin(current(s, rows))).await)
    }

    #[tool(
        description = "Start a transaction (/n<TCODE> in the command field), optionally fill first-screen fields by DDIC name (e.g. {\"SUID_ST_BNAME-BNAME\": \"DEVELOPER\"}) and submit an OK code (e.g. SHOW). Transactions that edit data or run arbitrary programs (SE38, SA38, SM30, SU01, SE16N edit, ...) are refused.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn webgui_start_transaction(&self, Parameters(p): Parameters<StartParams>) -> Result<CallToolResult, ErrorData> {
        respond(
            self.with_session(|s| {
                Box::pin(async move {
                    s.start_transaction(&p.tcode, &p.prefill.unwrap_or_default(), p.okcode.as_deref()).await?;
                    current(s, SCREEN_ROWS).await
                })
            })
            .await,
        )
    }

    #[tool(
        description = "Fill input fields, checkboxes, radio buttons or combo boxes on the current screen (selection criteria). Values are not submitted until webgui_press.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn webgui_set_fields(&self, Parameters(p): Parameters<SetFieldsParams>) -> Result<CallToolResult, ErrorData> {
        respond(
            self.with_session(|s| {
                Box::pin(async move {
                    s.set_fields(&p.values).await?;
                    current(s, SCREEN_ROWS).await
                })
            })
            .await,
        )
    }

    #[tool(
        description = "Press a button or select a tab (ref), send a function key (ENTER, F8, SHIFT_F3, ...), or submit an OK code (/nSM21, P+). Exactly one of ref, fkey, okcode. Save/post/delete/change/release actions and F11 are refused (read-only). Returns the next screen.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn webgui_press(&self, Parameters(p): Parameters<PressParams>) -> Result<CallToolResult, ErrorData> {
        let given = [p.reference.is_some(), p.fkey.is_some(), p.okcode.is_some()].iter().filter(|b| **b).count();
        if given != 1 {
            return fail("pass exactly one of ref, fkey, okcode");
        }
        respond(
            self.with_session(|s| {
                Box::pin(async move {
                    if let Some(r) = p.reference {
                        s.press_ref(&r).await?;
                    } else if let Some(fkey) = p.fkey {
                        s.press_fkey(&fkey).await?;
                    } else if let Some(okcode) = p.okcode {
                        crate::guard::check_okcode(&okcode)?;
                        s.enter_okcode(&okcode).await?;
                    }
                    current(s, SCREEN_ROWS).await
                })
            })
            .await,
        )
    }

    #[tool(
        description = "Read rows of a table on the current screen (ref g1 from webgui_screen): ABAP list lines, ALV grid rows or table control rows as rendered. For long ABAP lists pass page next/prev/first/last to scroll on the server; total_rows and first_visible_row report the position.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn webgui_table(&self, Parameters(p): Parameters<TableParams>) -> Result<CallToolResult, ErrorData> {
        respond(
            self.with_session(|s| {
                Box::pin(async move {
                    if let Some(page) = &p.page {
                        let okcode = match page.to_ascii_lowercase().as_str() {
                            "next" => "P+",
                            "prev" | "previous" => "P-",
                            "first" => "P--",
                            "last" => "P++",
                            other => return Err(format!("page must be first, next, prev or last, got {other:?}")),
                        };
                        let screen = s.screen().await?;
                        let kind = screen.tables.get(&p.reference).map(|t| t.kind);
                        if kind != Some("list") {
                            return Err(format!("paging works for ABAP lists; {} is {}", p.reference, kind.unwrap_or("not a table on this screen")));
                        }
                        s.enter_okcode(okcode).await?;
                    }
                    let screen = s.screen().await?;
                    let table = screen.tables.get(&p.reference).ok_or_else(|| format!("no table {} on {}", p.reference, screen.summary()))?;
                    Ok(screen.table_json(&p.reference, table, p.from.unwrap_or(0), p.count.unwrap_or(100).min(500)))
                })
            })
            .await,
        )
    }

    #[tool(
        description = "List the curated read-only WebGUI recipes (SM37 jobs, ST22 dumps, SU53 failed authorization check, SU01D user, SE16N table display, AL11 directories, SM12 lock entries) with their parameters and the cheaper ADT route where one exists.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn webgui_list_recipes(&self, Parameters(_): Parameters<NoParams>) -> Result<CallToolResult, ErrorData> {
        ok(recipes::listing())
    }

    #[tool(
        description = "Run a curated recipe in the open session. Every step checks the expected screen first; on a mismatch the recipe stops and returns the current screen so you can continue with the generic tools.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn webgui_run_recipe(&self, Parameters(p): Parameters<RecipeParams>) -> Result<CallToolResult, ErrorData> {
        respond(self.with_session(|s| Box::pin(async move { recipes::run(s, &p.name, &p.params.unwrap_or_default()).await })).await)
    }

    #[tool(
        description = "Capture a PNG screenshot of the WebGUI page (returned as an image; optionally also written to path).",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn webgui_screenshot(&self, Parameters(p): Parameters<ScreenshotParams>) -> Result<CallToolResult, ErrorData> {
        let guard = self.session.lock().await;
        let Some(session) = guard.as_ref() else { return fail(NO_SESSION) };
        let data = match session.screenshot().await {
            Ok(data) => data,
            Err(e) => return fail(e),
        };
        let mut note = json!({ "format": "png" });
        if let Some(path) = p.path {
            let bytes = match base64::engine::general_purpose::STANDARD.decode(&data) {
                Ok(bytes) => bytes,
                Err(e) => return fail(format!("screenshot decode: {e}")),
            };
            if let Err(e) = std::fs::write(&path, bytes) {
                return fail(format!("cannot write {path}: {e}"));
            }
            note["path"] = json!(path);
        }
        Ok(CallToolResult::success(vec![ContentBlock::image(data, "image/png"), ContentBlock::text(note.to_string())]))
    }

    #[tool(
        description = "End the WebGUI session (/nex logs off on the server) and release the browser or relay tab. Always call it when done; dropped tabs leak SAP sessions.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn webgui_close(&self, Parameters(_): Parameters<NoParams>) -> Result<CallToolResult, ErrorData> {
        let session = self.session.lock().await.take();
        match session {
            None => ok(json!({ "closed": false, "reason": "no session was open" })),
            Some(session) => respond(session.close().await.map(|_| json!({ "closed": true }))),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for WebguiServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sap-ai-webgui", VERSION))
            .with_instructions(INSTRUCTIONS)
    }
}
