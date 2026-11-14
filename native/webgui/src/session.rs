//! One WebGUI session: open + logon handling, readiness, screen reads, and
//! guarded actions through SAP's built-in `window.UCF_Automation` API.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::browser::{self, Browser, LaunchOptions, Profile};
use crate::cdp::{DEFAULT_TIMEOUT, Link};
use crate::config::{Config, Mode, WEBGUI_PATH};
use crate::guard;
use crate::relay::RelayHub;
use crate::screen::{self, RawScreen, Screen, TargetKind};

const EXTRACT_JS: &str = include_str!("extract.js");

const READY_JS: &str = r#"(async () => {
  if (document.readyState !== 'complete') return 'loading';
  if (document.getElementById('sap-user') || document.getElementById('delete-session-cb')) return 'logon';
  if (!window.UCF_Automation) return 'other';
  await window.UCF_Automation.waitUntilReady();
  return 'ready';
})()"#;

pub const VIEWPORT: (u32, u32) = (1440, 1000);

pub struct OpenOptions {
    pub mode: Mode,
    pub url: String,
    pub client: Option<String>,
    pub language: String,
}

/// Text-like fields are UR `InputField`s or, with value help, `ComboBox`es
/// (the command field too); pick the action by the control's real class.
fn text_setter(dom_id: &str, value: &str, enter: bool) -> String {
    format!(
        "const A = window.UCF_Automation; const id = {id}; const c = A.getControl(id);
         const is = (t) => UCF_JsUtil.bInstanceOf(c, 'UCF_' + t);
         const kind = is('ComboBox') ? 'ComboBox' : is('InputField') ? 'InputField' : null;
         if (!kind) throw new Error('control ' + id + ' is a ' + A.getRealClassName(c) + ', not a text field');
         await A.Actions[kind][{method}](id, {value})",
        id = js(&dom_id),
        method = if enter { "'EnterValue'" } else { "'ChangeValue'" },
        value = js(&value),
    )
}

pub struct Session {
    link: Link,
    pub mode: Mode,
    browser: Option<Browser>,
    relay_tab_owned: bool,
    last: Option<Screen>,
}

fn js(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// When the configured host is an IP address but the certificate names a DNS
/// host, open the DNS name and (headless) map it to the IP.
pub fn navigation_origin(base: &str, tls_server_name: Option<&str>) -> (String, Option<String>) {
    let Ok(url) = url::Url::parse(base) else { return (base.to_owned(), None) };
    let is_ip = matches!(url.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)));
    match (is_ip, tls_server_name) {
        (true, Some(name)) => {
            let ip = url.host_str().unwrap_or_default().trim_matches(['[', ']']).to_owned();
            let origin = match url.port() {
                Some(port) => format!("{}://{name}:{port}", url.scheme()),
                None => format!("{}://{name}", url.scheme()),
            };
            (origin, Some(format!("MAP {name} {ip}")))
        }
        _ => (base.to_owned(), None),
    }
}

fn key_code(key: &str) -> Option<(String, i64, i64)> {
    let upper = key.trim().to_ascii_uppercase();
    let (modifiers, base) = if let Some(rest) = upper.strip_prefix("SHIFT_").or_else(|| upper.strip_prefix("SHIFT+")) {
        (8, rest.to_owned())
    } else if let Some(rest) = upper.strip_prefix("CTRL_").or_else(|| upper.strip_prefix("CTRL+")) {
        (2, rest.to_owned())
    } else {
        (0, upper)
    };
    match base.as_str() {
        "ENTER" => Some(("Enter".into(), 13, modifiers)),
        "ESC" | "ESCAPE" => Some(("Escape".into(), 27, modifiers)),
        f if f.starts_with('F') => {
            let n: i64 = f[1..].parse().ok().filter(|n| (1..=12).contains(n))?;
            Some((format!("F{n}"), 111 + n, modifiers))
        }
        _ => None,
    }
}

impl Session {
    pub async fn open(config: &Config, hub: &Arc<RelayHub>, options: OpenOptions) -> Result<(Self, Screen), String> {
        let (origin, host_rules) = navigation_origin(&options.url, config.tls_server_name.as_deref());
        let mut query = format!("sap-language={}", options.language);
        if let Some(client) = &options.client {
            query = format!("sap-client={client}&{query}");
        }
        let start_url = format!("{origin}{WEBGUI_PATH}?{query}");
        let (link, browser, relay_tab_owned) = match options.mode {
            Mode::Headless => {
                let executable = browser::find_executable(config.browser.as_deref())?;
                let interactive = config.credentials.is_none();
                let profile = if interactive {
                    let dir = crate::config::cache_dir(&std::env::vars().collect()).ok_or("cannot resolve a cache directory for the browser profile")?.join("webgui-profile");
                    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
                    Profile::Persistent(dir)
                } else {
                    Profile::temporary()?
                };
                let browser = Browser::launch(LaunchOptions {
                    executable: &executable,
                    profile,
                    headed: config.headed || interactive,
                    host_rules,
                    width: VIEWPORT.0,
                    height: VIEWPORT.1,
                })
                .await?;
                let link = browser.new_page(VIEWPORT.0, VIEWPORT.1).await?;
                link.call("Page.navigate", json!({ "url": start_url }), DEFAULT_TIMEOUT).await?;
                (link, Some(browser), false)
            }
            Mode::Relay => {
                hub.ensure_listening().await?;
                hub.wait_connected(Duration::from_secs(45)).await?;
                let tabs = hub.request("tabs.find", json!({ "prefix": format!("{origin}{WEBGUI_PATH}") }), DEFAULT_TIMEOUT).await?;
                let existing = tabs.as_array().and_then(|t| t.iter().find(|t| t["active"] == true).or_else(|| t.first())).and_then(|t| t["tabId"].as_i64());
                let (tab, owned) = match existing {
                    Some(tab) => (tab, false),
                    None => {
                        let created = hub.request("tabs.create", json!({ "url": start_url }), DEFAULT_TIMEOUT).await?;
                        (created["tabId"].as_i64().ok_or("relay extension returned no tab id")?, true)
                    }
                };
                hub.request("debugger.attach", json!({ "tabId": tab }), DEFAULT_TIMEOUT).await?;
                (Link::Relay { hub: hub.clone(), tab }, None, owned)
            }
        };
        // UR actions simulate focus/blur; without focus emulation they are lost
        // whenever the browser window is not the OS foreground window.
        link.call("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), DEFAULT_TIMEOUT).await?;
        let mut session = Self { link, mode: options.mode, browser, relay_tab_owned, last: None };
        let screen = session.reach_webgui(config).await?;
        Ok((session, screen))
    }

    async fn reach_webgui(&mut self, config: &Config) -> Result<Screen, String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        let mut logon_attempted = false;
        loop {
            self.settle(Duration::from_secs(60)).await?;
            let screen = self.read_screen().await?;
            match screen.page.as_str() {
                "webgui" => return Ok(screen),
                "login" => {
                    match (&config.credentials, self.mode) {
                        (Some(credentials), Mode::Headless) if !logon_attempted => {
                            logon_attempted = true;
                            self.type_into("sap-user", &credentials.user).await?;
                            self.type_into("sap-password", &credentials.password).await?;
                            self.key("ENTER").await?;
                        }
                        (Some(_), Mode::Headless) => {
                            return Err("SAP rejected the logon (still on the logon page); check SAP_USER/SAP_PASSWORD and the client".into());
                        }
                        _ => {
                            if Instant::now() > deadline {
                                return Err("nobody signed in to SAP within 3 minutes; sign in in the opened browser window and call webgui_open again".into());
                            }
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    }
                }
                "session_query" => self.continue_without_cancelling_logons().await?,
                _ => {
                    if Instant::now() > deadline {
                        return Err(format!("WebGUI did not open: {} {}", screen.title, screen.to_json(0)["text"].as_str().unwrap_or("")));
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    /// The "Logon Status Check" page pre-ticks "Cancel all existing logons" on
    /// some systems; continuing with it ticked would end every other session
    /// of this user (including the ADT session). Untick, verify, continue.
    async fn continue_without_cancelling_logons(&mut self) -> Result<(), String> {
        const STATE: &str = "(() => { const c = document.getElementById('delete-session-cb'); const h = document.getElementById('delete_session'); return { checked: c ? c.getAttribute('aria-checked') === 'true' : false, hidden: h ? h.value : '' }; })()";
        let state = self.eval(STATE, false, DEFAULT_TIMEOUT).await?;
        if state["checked"] == true {
            self.eval("document.getElementById('delete-session-cb').click()", false, DEFAULT_TIMEOUT).await?;
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let state = self.eval(STATE, false, DEFAULT_TIMEOUT).await?;
        if state["checked"] == true || state["hidden"] == "X" {
            return Err("the Logon Status Check page keeps \"Cancel all existing logons\" ticked; refusing to continue because it would end your other SAP sessions. Untick it in the browser and continue manually.".into());
        }
        self.eval("document.getElementById('SESSION_QUERY_CONTINUE_BUTTON').click()", false, DEFAULT_TIMEOUT).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        Ok(())
    }

    pub async fn eval(&self, expression: &str, await_promise: bool, timeout: Duration) -> Result<Value, String> {
        let result = self
            .link
            .call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": await_promise }), timeout)
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            let text = details.pointer("/exception/description").and_then(Value::as_str).or_else(|| details.get("text").and_then(Value::as_str)).unwrap_or("script error");
            return Err(text.lines().next().unwrap_or(text).to_owned());
        }
        Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    /// Waits until the page finished loading and UR reports ready (two
    /// consecutive ready probes), tolerating navigations in between.
    pub async fn settle(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut ready_streak = 0;
        loop {
            if !self.link.alive() {
                return Err("the browser connection closed".into());
            }
            match self.eval(READY_JS, true, Duration::from_secs(15)).await.as_ref().map(|v| v.as_str().unwrap_or("")) {
                Ok("ready") => {
                    ready_streak += 1;
                    if ready_streak >= 2 {
                        return Ok(());
                    }
                }
                Ok("logon" | "other") => return Ok(()),
                _ => ready_streak = 0,
            }
            if Instant::now() > deadline {
                return Err(format!("WebGUI did not become ready within {} s", timeout.as_secs()));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    pub async fn read_screen(&mut self) -> Result<Screen, String> {
        let raw = self.eval(EXTRACT_JS, false, DEFAULT_TIMEOUT).await?;
        let raw: RawScreen = serde_json::from_value(raw).map_err(|e| format!("unexpected screen data: {e}"))?;
        Ok(screen::build(raw))
    }

    /// Fresh screen, remembered for ref resolution.
    pub async fn screen(&mut self) -> Result<&Screen, String> {
        let screen = self.read_screen().await?;
        self.last = Some(screen);
        Ok(self.last.as_ref().unwrap())
    }

    async fn type_into(&self, dom_id: &str, text: &str) -> Result<(), String> {
        self.eval(&format!("(() => {{ const e = document.getElementById({}); e.focus(); e.select && e.select(); }})()", js(&dom_id)), false, DEFAULT_TIMEOUT).await?;
        self.link.call("Input.insertText", json!({ "text": text }), DEFAULT_TIMEOUT).await?;
        Ok(())
    }

    pub async fn key(&self, key: &str) -> Result<(), String> {
        let (name, code, modifiers) = key_code(key).ok_or_else(|| format!("unsupported key {key:?}; use ENTER, ESC, F1-F12 with optional SHIFT_ or CTRL_"))?;
        let text = if name == "Enter" { "\r" } else { "" };
        for kind in ["keyDown", "keyUp"] {
            let mut params = json!({ "type": kind, "key": name, "code": name, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code, "modifiers": modifiers });
            if kind == "keyDown" && !text.is_empty() {
                params["text"] = json!(text);
            }
            self.link.call("Input.dispatchKeyEvent", params, DEFAULT_TIMEOUT).await?;
        }
        Ok(())
    }

    async fn action(&self, script: String) -> Result<(), String> {
        self.eval(&format!("(async () => {{ {script}; return true; }})()"), true, Duration::from_secs(60)).await?;
        self.settle(Duration::from_secs(120)).await
    }

    /// Submits an OK code through the command field (empty = Enter).
    pub async fn enter_okcode(&mut self, okcode: &str) -> Result<(), String> {
        let id = match self.last.as_ref().and_then(|s| s.okcode_dom_id.clone()) {
            Some(id) => id,
            None => self.screen().await?.okcode_dom_id.clone().ok_or("this screen has no command field")?,
        };
        if let Err(error) = self.action(text_setter(&id, okcode, true)).await {
            // Some releases render the command field without UR automation support.
            if !(error.contains("not a text field") || error.contains("ControlTypeError") || error.contains("InvalidControlIdError")) {
                return Err(error);
            }
            self.type_into(&id, okcode).await?;
            self.key("ENTER").await?;
            self.settle(Duration::from_secs(120)).await?;
        }
        Ok(())
    }

    pub async fn start_transaction(&mut self, tcode: &str, prefill: &BTreeMap<String, String>, okcode: Option<&str>) -> Result<(), String> {
        guard::check_tcode(tcode)?;
        if let Some(okcode) = okcode {
            guard::check_okcode(okcode)?;
        }
        self.screen().await?;
        self.enter_okcode(&format!("/n{}", tcode.trim())).await?;
        if !prefill.is_empty() {
            self.screen().await?;
            self.set_fields(prefill).await?;
        }
        if let Some(okcode) = okcode {
            self.enter_okcode(okcode).await?;
        }
        Ok(())
    }

    pub async fn set_fields(&mut self, values: &BTreeMap<String, String>) -> Result<Vec<String>, String> {
        if self.last.is_none() {
            self.screen().await?;
        }
        let mut done = Vec::new();
        for (key, value) in values {
            let screen = self.last.as_ref().unwrap();
            let target = screen.resolve(key).ok_or_else(|| format!("no field {key:?} on {}; read webgui_screen for refs", screen.summary()))?.clone();
            if target.readonly {
                return Err(format!("field {key} ({}) is read-only on this screen", target.sid));
            }
            let id = js(&target.dom_id);
            let truthy = matches!(value.to_ascii_lowercase().as_str(), "x" | "true" | "1" | "yes");
            let script = match target.kind {
                TargetKind::Field | TargetKind::Combo => text_setter(&target.dom_id, value, false),
                TargetKind::CheckBox => format!("await window.UCF_Automation.Actions.CheckBox.ChangeValue({id}, {truthy})"),
                TargetKind::Radio => format!("await window.UCF_Automation.Actions.RadioButton.ChangeValue({id}, true)"),
                TargetKind::TextEdit => format!("await window.UCF_Automation.Actions.TextEdit.ChangeText({id}, {})", js(value)),
                _ => return Err(format!("{key} ({}) is not an input field", target.sid)),
            };
            self.action(script).await.map_err(|e| format!("setting {key}: {e}"))?;
            done.push(target.sid);
        }
        self.screen().await?;
        Ok(done)
    }

    pub async fn press_ref(&mut self, key: &str) -> Result<String, String> {
        if self.last.is_none() {
            self.screen().await?;
        }
        let screen = self.last.as_ref().unwrap();
        let target = screen.resolve(key).ok_or_else(|| format!("no button or tab {key:?} on {}", screen.summary()))?.clone();
        let script = match &target.kind {
            TargetKind::Button => {
                guard::check_button(&target.text, target.fkey.as_deref())?;
                format!("await window.UCF_Automation.Actions.Button.Press({})", js(&target.dom_id))
            }
            TargetKind::Tab { strip } => format!("await window.UCF_Automation.Actions.TabStrip.SelectItem({}, {})", js(strip), js(&target.dom_id)),
            _ => return Err(format!("{key} ({}) is not a button or tab", target.sid)),
        };
        self.action(script).await?;
        Ok(target.sid)
    }

    pub async fn press_fkey(&mut self, fkey: &str) -> Result<String, String> {
        let upper = fkey.trim().to_ascii_uppercase().replace('+', "_");
        if upper == "ENTER" {
            self.enter_okcode("").await?;
            return Ok("ENTER".into());
        }
        let screen = self.screen().await?;
        let button = screen.refs.iter().find(|(_, t)| t.kind == TargetKind::Button && t.fkey.as_deref().is_some_and(|f| f.eq_ignore_ascii_case(&upper))).map(|(r, _)| r.clone());
        if let Some(r) = button {
            return self.press_ref(&r).await;
        }
        guard::check_fkey(&upper)?;
        self.key(&upper).await?;
        self.settle(Duration::from_secs(120)).await?;
        Ok(upper)
    }

    pub async fn screenshot(&self) -> Result<String, String> {
        let shot = self.link.call("Page.captureScreenshot", json!({ "format": "png" }), Duration::from_secs(30)).await?;
        shot["data"].as_str().map(str::to_owned).ok_or_else(|| "browser returned no screenshot".into())
    }

    /// Sends `/nex` without awaiting it (the page unloads mid-action) and
    /// waits until the WebGUI page is gone.
    async fn logoff(&mut self) -> Result<(), String> {
        let id = match self.last.as_ref().and_then(|s| s.okcode_dom_id.clone()) {
            Some(id) => id,
            None => self.screen().await?.okcode_dom_id.clone().ok_or("this screen has no command field")?,
        };
        self.eval(&format!("(async () => {{ {} }})(); true", text_setter(&id, "/nex", true)), false, DEFAULT_TIMEOUT).await?;
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if let Ok(Value::Bool(false)) = self.eval("!!(window.UCF_Automation && document.getElementById('ToolbarOkCode'))", false, Duration::from_secs(5)).await {
                return Ok(());
            }
        }
        Err("WebGUI did not confirm the logoff within 15 s".into())
    }

    /// Ends the SAP session with `/nex`, then releases the browser or tab. A
    /// relay tab the user already had open stays signed in: only detach.
    pub async fn close(mut self) -> Result<(), String> {
        let borrowed = self.mode == Mode::Relay && !self.relay_tab_owned;
        let logoff = if borrowed { Ok(()) } else { self.logoff().await };
        match self.mode {
            Mode::Headless => {
                if let Some(browser) = self.browser.take() {
                    browser.close().await;
                }
            }
            Mode::Relay => {
                if let Link::Relay { hub, tab } = &self.link {
                    let method = if self.relay_tab_owned { "tabs.remove" } else { "debugger.detach" };
                    let _ = hub.request(method, json!({ "tabId": tab }), DEFAULT_TIMEOUT).await;
                }
            }
        }
        logoff.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_url_with_certificate_name_maps_host() {
        let (origin, rules) = navigation_origin("https://10.0.0.5:44300", Some("sap.example.com"));
        assert_eq!(origin, "https://sap.example.com:44300");
        assert_eq!(rules.as_deref(), Some("MAP sap.example.com 10.0.0.5"));
        let (origin, rules) = navigation_origin("https://sap.example.com", Some("other"));
        assert_eq!(origin, "https://sap.example.com");
        assert!(rules.is_none());
    }

    #[test]
    fn function_keys_map_to_virtual_key_codes() {
        assert_eq!(key_code("F8"), Some(("F8".into(), 119, 0)));
        assert_eq!(key_code("shift_f3"), Some(("F3".into(), 114, 8)));
        assert_eq!(key_code("enter").unwrap().1, 13);
        assert!(key_code("F13").is_none());
    }
}
