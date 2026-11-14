//! sap-ai-webgui: stdio MCP server that drives SAP GUI for HTML (WebGUI)
//! read-only through the user's Chrome (relay extension) or a managed
//! browser. Server mode writes only MCP JSON-RPC to stdout.
mod browser;
mod cdp;
mod config;
mod guard;
mod recipes;
mod relay;
mod screen;
mod server;
mod session;

use std::collections::HashMap;
use std::process::ExitCode;

use rmcp::ServiceExt;

pub const VERSION: &str = match option_env!("SAP_AI_WEBGUI_BUILD_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

fn usage(env: &HashMap<String, String>) -> String {
    let stored = config::stored_path(env).map(|p| p.display().to_string()).unwrap_or_else(|| "~/.config/sap-ai-dev-toolkit/webgui.json".into());
    [
        "Usage: sap-ai-webgui",
        "",
        "Starts a stdio MCP server that drives SAP GUI for HTML (WebGUI) read-only: display transactions,",
        "screens, fields, ABAP lists, ALV grids and curated recipes (SM37, ST22, SU53, SU01D, SE16N, AL11,",
        "SM12). Save/post/delete/change actions are refused.",
        "",
        "Settings come from the MCP host environment or from the file written by sap-ai-dev --setup-webgui:",
        "  SAP_WEBGUI_URL / SAP_URL                  WebGUI base URL, e.g. https://host:44300",
        "  SAP_CLIENT, SAP_LANGUAGE                  logon client and language (default EN)",
        "  SAP_TLS_SERVER_NAMES                      certificate host name when the URL uses an IP address",
        "  SAP_USER / SAP_PASSWORD                   headless logon (optional; otherwise interactive sign-in)",
        "  SAP_AI_DEV_TOOLKIT_WEBGUI_MODE            relay (your Chrome + extension) or headless",
        "  SAP_AI_DEV_TOOLKIT_WEBGUI_HEADED=1        show the managed browser window",
        "  SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_PORT      relay port (default 47823)",
        "  SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_TOKEN     relay pairing token (also in the extension options)",
        "  SAP_AI_WEBGUI_BROWSER / SAP_BROWSER_EXEC  browser executable for headless mode",
        &format!("  {stored}"),
        "",
        "  --check   print the effective settings and browser/relay readiness; exit 1 when unusable",
        "  --version print the version",
        "",
    ]
    .join("\n")
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env: HashMap<String, String> =
        std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", usage(&env));
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version") {
        println!("{VERSION}");
        return ExitCode::SUCCESS;
    }
    let config = match config::resolve(&env) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("[sap-ai-webgui] {error}");
            return ExitCode::FAILURE;
        }
    };
    if args.iter().any(|a| a == "--check") {
        let usable = config.url.is_some()
            && match config.mode {
                config::Mode::Headless => browser::find_executable(config.browser.as_deref()).is_ok(),
                config::Mode::Relay => config.relay_token.is_some(),
            };
        let server = server::WebguiServer::new(config);
        println!("{}", serde_json::to_string_pretty(&server.summary()).unwrap_or_default());
        return if usable { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    let server = server::WebguiServer::new(config);
    let handle = server.clone();
    let running = match server.serve(rmcp::transport::stdio()).await {
        Ok(running) => running,
        Err(error) => {
            eprintln!("[sap-ai-webgui] {error}");
            return ExitCode::FAILURE;
        }
    };
    // Log off and stop the managed browser when the host closes stdin or stops us;
    // an abandoned WebGUI tab keeps an SAP session alive until it times out.
    let outcome = tokio::select! {
        result = running.waiting() => result.map(|_| ()).map_err(|e| e.to_string()),
        _ = shutdown_signal() => Ok(()),
    };
    handle.shutdown().await;
    // Exit explicitly: the stdio transport's blocking stdin reader would keep
    // the runtime from shutting down after a signal.
    let code = match outcome {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("[sap-ai-webgui] {error}");
            1
        }
    };
    std::process::exit(code);
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(term) => term,
            Err(_) => return std::future::pending().await,
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
