//! sap-ai-aem: stdio MCP server for SAP Integration Suite, advanced event mesh
//! (Mission Control, SEMP v2 and Event Portal). Server mode writes only MCP
//! JSON-RPC to stdout.
mod config;
mod confirm;
mod http;
mod mission_control;
mod portal;
mod redact;
mod semp;
mod server;

use std::collections::HashMap;
use std::process::ExitCode;

use rmcp::ServiceExt;

pub const VERSION: &str = match option_env!("SAP_AI_AEM_BUILD_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

fn usage(env: &HashMap<String, String>) -> String {
    let stored = config::stored_path(env).map(|p| p.display().to_string()).unwrap_or_else(|| "~/.config/sap-ai-dev-toolkit/aem.json".into());
    [
        "Usage: sap-ai-aem",
        "",
        "Starts a stdio MCP server for SAP Integration Suite, advanced event mesh: event broker service",
        "lifecycle (Mission Control: create, resize, upgrade, delete, operations), broker configuration,",
        "monitoring and actions (SEMP v2), and Event Portal design objects with AsyncAPI export.",
        "Every write requires an exact confirmation string.",
        "",
        "Credentials come from the MCP host environment or from the user-only store filled by",
        "sap-ai-dev --setup-aem:",
        "  AEM_API_TOKEN                             Cloud API token (Mission Control and Event Portal);",
        "                                            SEMP credentials are fetched per service",
        "  AEM_API_URL                               Cloud API base URL (default https://api.solace.cloud)",
        "  AEM_CONFIG                                JSON { \"apiToken\" } (shared with sap-ai-integration)",
        "  AEM_SEMP_URL                              broker SEMP URL, e.g. https://<host>:943",
        "  AEM_SEMP_MSG_VPN                          message VPN (all four AEM_SEMP_* required together)",
        "  AEM_SEMP_USERNAME                         SEMP user",
        "  AEM_SEMP_PASSWORD                         SEMP password",
        "  AEM_SEMP_CONFIG                           JSON { \"url\", \"msgVpnName\", \"username\", \"password\" }",
        "  AEM_CA_FILE                               extra PEM CA bundle (default NODE_EXTRA_CA_CERTS)",
        &format!("  {stored}"),
        "                                            credentials stored by sap-ai-dev --setup-aem (never mcp.json)",
        "",
        "HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored.",
        "",
        "  --check   verify Cloud API and SEMP access; exit 1 when a check fails",
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
    let server = match config::resolve(&env).map_err(http::AemError::from).and_then(server::AemServer::new) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("[sap-ai-aem] {}", error.message);
            return ExitCode::FAILURE;
        }
    };
    if args.iter().any(|a| a == "--check") {
        let mut failed = false;
        for (name, result) in server.verify().await {
            failed |= result.starts_with("failed");
            println!("{name}: {result}");
        }
        return if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS };
    }
    let running = match server.serve(rmcp::transport::stdio()).await {
        Ok(running) => running,
        Err(error) => {
            eprintln!("[sap-ai-aem] {error}");
            return ExitCode::FAILURE;
        }
    };
    match running.waiting().await {
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[sap-ai-aem] {error}");
            ExitCode::FAILURE
        }
    }
}
