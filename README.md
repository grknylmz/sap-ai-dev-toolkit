<h1 align="center">🧭 SAP AI Development Toolkit</h1>

<p align="center">
  <strong>Build, test, and deliver ABAP with AI that understands your SAP landscape.</strong><br>
  Bring your favorite AI coding assistant into your SAP development workflow with destination-aware SAP tools.<br>
  Explore real system context, make focused changes, and verify results before delivery.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sap-ai-dev-toolkit"><img src="https://img.shields.io/npm/v/sap-ai-dev-toolkit?style=for-the-badge&color=CB3837&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/sap-ai-dev-toolkit"><img src="https://img.shields.io/npm/dm/sap-ai-dev-toolkit?style=for-the-badge&color=CB3837&logo=npm&logoColor=white" alt="npm downloads"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 20 or newer">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-75B900?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/SAP-Business%20Application%20Studio-0A6ED1?style=flat-square&logo=sap&logoColor=white" alt="SAP Business Application Studio">
  <img src="https://img.shields.io/badge/AI%20agents-Copilot%20%7C%20Claude%20%7C%20Codex%20%7C%20Cursor%20%7C%20Gemini%20%7C%20opencode%20%7C%20Pi-000000?style=flat-square" alt="Works with GitHub Copilot, Claude Code, OpenAI Codex, Cursor, Gemini CLI, opencode, and Pi Coding Agent">
  <img src="https://img.shields.io/badge/MCP-enabled-7B61FF?style=flat-square" alt="MCP enabled">
  <img src="https://img.shields.io/badge/SAP%20ADT-connected-0A6ED1?style=flat-square&logo=sap&logoColor=white" alt="SAP ADT connected">
  <img src="https://img.shields.io/badge/ABAP-CDS%20%7C%20RAP-EA4AAA?style=flat-square" alt="ABAP CDS RAP">
</p>

<p align="center">
  <a href="#install"><strong>Get started →</strong></a> ·
  <a href="#agents">Meet the agents</a> ·
  <a href="#bas">Connect your SAP systems</a> ·
  <a href="#tools">Explore the tools</a>
</p>

## From a prompt to SAP-ready work

SAP AI Dev Toolkit connects your AI coding assistant to the SAP development tools available for each selected destination. Agents can inspect ABAP and CDS, propose changes, run checks, and return the evidence—without losing sight of which SAP system each operation targets.

<p align="center">
  <strong>Agent chat</strong> → <strong>destination-scoped MCP</strong> → <strong>VSP + configured route (BAS, CF, or local SAP GUI)</strong> → <strong>SAP ADT</strong> → <strong>your SAP system</strong><br>
  <em>results and diagnostics flow back along the same path</em>
</p>

<p align="center"><strong>Explore → Build → Verify → Prepare for delivery</strong></p>

## ⚡ Quick start

The default installation is a single npx command — no global install, nothing left behind except the generated MCP configuration:

```sh
npx --yes --ignore-scripts sap-ai-dev-toolkit --setup
```

Prefer a persistent global install instead?

```sh
npm install --global sap-ai-dev-toolkit
sap-ai-dev --setup
```

To also add optional full-stack SAP companion MCP servers for Fiori, UI5, CAP, and browser validation, run:

```sh
sap-ai-dev --setup --tools
```

After setup, connect a selected BAS destination or local SAP GUI system from your MCP-capable editor:

1. Open the Command Palette.
2. Run **MCP: List Servers**.
3. Start the server named after your selected destination (the lowercase slug, for example `demo-abap` for destination `DEMO_ABAP`).
4. In your AI assistant's chat, choose the best-fit bundled agent from the agent picker (GitHub Copilot, Claude Code, and opencode install the agents) or invoke the matching Pi prompt template (`/sap-solution-architect`, `/abap-developer`, `/abap-runtime-debugger`, `/rap-service-developer`, or `/hana-cloud-hdi-specialist`): **SAP Solution Architect**, **ABAP Developer**, **ABAP Runtime Debugger**, **RAP Service Developer**, or **HANA Cloud/HDI Specialist**.
5. In the Chat tools picker, enable the server for that destination.
6. Ask the agent to inspect, build, test, or verify something in your SAP landscape.

Use the attached destination-prefixed tools directly in chat. Do not launch `sap-ai-dev` or handcraft MCP JSON-RPC in a terminal to discover or call them.

**Prerequisite:** Node.js 20 or newer. The pinned VSP runtime ships with the package; no Go toolchain is installed or required.

## 🤖 Available agents and skills

**Agents:** Five user-invocable custom agents are included. Select the best fit from the agent picker in your harness's chat (GitHub Copilot, Claude Code, or opencode), or use the matching Pi prompt command, as shown in Quick start.

| | Agent | Best for |
| --- | --- | --- |
| 🧭 | **SAP Solution Architect** | System investigation, SAP standard/API recommendations, Clean Core and side-by-side design, and SDLC orchestration through implementation handoffs and validation gates |
| 🧑‍💻 | **ABAP Developer** | General ABAP, CDS, and RAP implementation, validation, and transport-preparation tasks |
| 🐞 | **ABAP Runtime Debugger** | Runtime incidents, application logs, debugger sessions, and performance symptoms; call relationships are derived from source inspection |
| 🚀 | **RAP Service Developer** | RAP business objects, behavior implementations, projections, service definitions, service bindings, and OData validation |
| 🗃️ | **HANA Cloud/HDI Specialist** | Read-only HANA Cloud container inspection, CAP/HDI artifact generation, local validation, and user-run deployment handoffs |

**Included skills:** `abap-development` · `abap-testing-quality` · `cds-development` · `rap-development` · `abap-debugging` · `abap-runtime-analysis` · `rap-service-delivery` · `sap-standard-api-analysis` · `clean-core-extensibility` · `sap-sdlc-orchestration` · `sap-transport-release` · `hana-cloud-inspection` · `hana-cloud-native-development` · `hana-cloud-validation`

Agents and skills install for the harnesses you pick during global installation: a multi-select offers GitHub Copilot and Claude Code pre-checked, plus OpenAI Codex, Cursor, Gemini CLI, opencode, and Pi Coding Agent. In non-interactive installs they are installed for GitHub Copilot only; run `sap-ai-dev --setup` afterwards to configure destinations or local SAP GUI systems. Repository-scoped installation instructions appear below.

## ✨ Your SAP development cockpit, inside your AI assistant

`sap-ai-dev-toolkit` installs `sap-ai-dev`, discovers your BAS destinations or local SAP GUI systems, and exposes a curated SAP development toolset through MCP. Instead of manually switching between chat, terminal commands, repository searches, ADT screens, and SAP checks, describe the outcome you want and let the appropriate bundled agent coordinate the available tools.

<p align="center"><strong>💬 Request → 🔎 Inspect → 🧠 Reason → 🧑‍💻 Implement → 🧪 Verify → 📋 Report</strong></p>

The workflow covers ABAP, CDS, RAP, repository analysis, table and query access, testing, ATC, application logs, transports, and controlled source changes. The live MCP tool list remains the source of truth for what your connected SAP system and active VSP mode expose.

## 🌟 Feature highlights

| | Feature | What it gives you |
| --- | --- | --- |
| 🤖 | **AI-driven ABAP development** | Describe the outcome; a task-fit agent coordinates inspection, implementation, validation, and a clear report. |
| 🧭 | **Destination-aware by design** | Discover BAS destinations or local SAP GUI systems and connect each MCP server to one selected SAP system. |
| 🔎 | **Understand before editing** | Trace source, callers, definitions, package contents, dependencies, and CDS impact in one workflow. |
| 🧩 | **CDS + RAP development** | Explore models and dependencies, then build RAP business objects and services with system context. |
| 🗃️ | **Ground decisions in SAP data** | Inspect DDIC structures, read table contents, and run controlled ABAP SQL queries. |
| ☁️ | **Read-only HANA Cloud inspection** | Inspect an environment-bound HDI schema, object metadata, and capped query results without exposing deployment credentials. |
| ✍️ | **Edit ABAP safely** | Update supported source, stage reviewed change sets, create transport requests, and run syntax checks before requested activation. |
| ✅ | **Quality built into the flow** | Pair local ABAP linting with SAP syntax checks, ABAP Unit, ATC, editor diagnostics, and formatting. |
| 🐞 | **Debug with system context** | Investigate dumps, traces, application logs, runtime failures, capabilities, and installed components. |
| 🚚 | **Transport-aware workflows** | Check request and lock context before preparing a change; create transports only when authorized. |
| 🧾 | **Reviewable change sets** | Stage multi-object diffs and re-read each source before an explicitly requested apply. |
| 📋 | **Transport readiness evidence** | Bring request, dependency, inactive-object, test, and ATC results together in one report. |
| 🧭 | **ABAP Cloud migration assessment** | Check SAP API release evidence in batches and focus review on recognized unreleased APIs. |
| 🚀 | **Reusable RAP smoke suites** | Turn OData metadata into repeatable GET checks with saved assertions. |
| 🩺 | **Connection Doctor** | Find setup issues across destination reachability, VSP startup, SAP system info, and tool discovery. |
| 🧪 | **Offline playground** | Try the agents and workflows locally with sample SAP data; demo changes disappear on exit. |
| 🔐 | **Controlled SAP state changes** | State-changing actions require a known target and an explicit request; SAP authorizations still apply. |
| 🧱 | **Destination isolation** | Each generated MCP server is tied to its own `SAP_AI_DEV_TOOLKIT_DESTINATION`, helping prevent accidental cross-system execution. |
| 🛡️ | **Credential-safe configuration** | Credentials, cookies, usernames, passwords, and raw destination payloads are not written into MCP configuration. |

The catalog below covers source inspection, data, editing, quality, transports, logs, and multi-step development workflows. Availability can vary by SAP system and VSP mode, so the live `tools/list` response is authoritative.

## 🚀 What can the agent do?

### 🧑‍💻 Build and refactor

- ABAP reports, classes, interfaces, and function groups
- CDS definitions and dependency-aware changes
- RAP business objects and services
- Focused source edits with syntax validation

### 🔍 Understand your SAP codebase

- Search repository objects and packages
- Find definitions and references
- Compare implementations
- Inspect class metadata and dependencies
- Run CDS forward and reverse impact analysis

### 🧪 Validate quality

- ABAP Unit
- ATC checks
- SAP syntax checks
- Local `abaplint`
- BAS editor and LSP diagnostics
- Pretty-print source

### 🏢 Work with the live SAP system

- Read DDIC structures and table content
- Execute ABAP SQL queries
- Inspect system and component information
- Read SLG1 application logs
- Review and create transport requests

## 🧠 Five agents, fourteen focused skills

The package ships with five custom agents plus fourteen task-focused Agent Skills:

| | Skill | Best for |
| --- | --- | --- |
| 🧑‍💻 | `abap-development` | Implementing and refactoring ABAP reports, classes, interfaces, and function groups |
| ✅ | `abap-testing-quality` | ABAP Unit, lint, LSP diagnostics, SAP syntax checks, and ATC |
| 🧩 | `cds-development` | CDS modeling, dependency inspection, and consumer impact analysis |
| 🚀 | `rap-development` | RAP business objects and service development |
| 🧭 | `sap-standard-api-analysis` | SAP standard capability, released API, CDS/RAP/OData, and fit-gap analysis before custom development |
| 🧱 | `clean-core-extensibility` | Clean Core, released extensibility, and side-by-side extension design with risk classification |
| 🔁 | `sap-sdlc-orchestration` | Requirement-to-release lifecycle planning, delegated implementation, quality gates, validation, and handover |
| 🐞 | `abap-debugging` | Dumps, logs, traces, and runtime failure diagnosis |
| 🔬 | `abap-runtime-analysis` | Incident triage, debugger state, and performance analysis; call relationships come from source inspection |
| 🚀 | `rap-service-delivery` | RAP service activation, publication, OData validation, and end-to-end runtime checks |
| 🚚 | `sap-transport-release` | Dependency checks and transport preparation; release itself is intentionally unavailable here |
| 🔎 | `hana-cloud-inspection` | Verify the selected HANA Cloud binding and inspect bounded HDI catalog/data results |
| 🧱 | `hana-cloud-native-development` | Generate CAP-owned CDS models or required native HDI artifacts without duplicating generated sources |
| ✅ | `hana-cloud-validation` | Run local CAP/HANA builds and prepare a reviewed, user-run deployment handoff |

## 🗺️ How it fits together

Each selected BAS destination becomes its own isolated MCP server identity. The MCP client discovers the live tools and schemas, the add-on routes calls to the correct VSP child, and VSP reaches SAP ADT through the selected BAS destination.

## 🧰 Optional full-stack companion MCP servers

ABAP/RAP backend access is provided by this add-on's BAS/VSP proxy. For end-to-end SAP development, setup can also add managed companion MCP entries for frontend, CAP, browser validation, and read-only HANA inspection:

```sh
sap-ai-dev --setup --tools
```

The companion entries are optional and are launched through `npx` only when the MCP client starts them. They are marked as managed by `sap-ai-dev-toolkit`, so rerunning setup can update or remove them without touching unrelated MCP servers. The HANA companion uses `--ignore-scripts` so the toolkit postinstall wizard cannot run during MCP startup.

| MCP entry | Package | Launches | Use when the agent needs to |
| --- | --- | --- | --- |
| `sap-fiori-tools` | `@sap-ux/fiori-mcp-server` | `fiori-mcp` | Generate or adapt Fiori elements/freestyle apps, annotations, and SAP Fiori UX artifacts |
| `ui5-tools` | `@ui5/mcp-server` | `ui5mcp` | Inspect SAPUI5/OpenUI5 projects, manifests, routing, views, controllers, and UI5-specific issues |
| `cap-tools` | `@cap-js/mcp-server` | `cds-mcp` | Inspect CAP CDS models, services, entities, actions, and local CAP application structure |
| `browser-validation` | `@playwright/mcp` | `playwright-mcp` | Open BAS previews, smoke-test Fiori/UI flows, collect screenshots, and verify browser runtime behavior |
| `hana-cloud-inspector` | `sap-ai-dev-toolkit` | `sap-ai-hana` | Inspect a bound HANA Cloud HDI schema using read-only catalog tools and capped row reads |

Recommended profiles:

- **RAP + Fiori:** select your BAS destination plus `sap-fiori-tools`, `ui5-tools`, and `browser-validation`.
- **CAP on BTP:** select `cap-tools`, `sap-fiori-tools`, `ui5-tools`, and `browser-validation`.
- **CAP + HANA Cloud:** select `cap-tools` and `hana-cloud-inspector`; provide the inspector's read-only connection through MCP-host environment variables.
- **UI-only:** select `sap-fiori-tools`, `ui5-tools`, and optionally `browser-validation`.

### HANA Cloud/HDI inspector

Select `hana-cloud-inspector` in the optional companion-server setup, then start it from **MCP: List Servers**. The process reads its connection from the MCP host's environment; setup never copies HANA credentials into `mcp.json`. Make sure variables are available to the BAS/VS Code MCP host process (not only to a later terminal session), then reload/restart the MCP host if needed.

Use either:

- A dedicated read-only VCAP binding with `credentials.host`, `port`, `user`, `password`, and `schema` in `VCAP_SERVICES`; optionally set `HANA_RO_VCAP_SERVICE` to the exact VCAP service key and `HANA_RO_BINDING` to the binding/instance name when selection is ambiguous.
- Explicit `HANA_RO_HOST`, `HANA_RO_PORT`, `HANA_RO_USER`, `HANA_RO_PASSWORD`, and `HANA_RO_SCHEMA` variables. `HANA_RO_TRUST_STORE` is optional; TLS and certificate verification are always enabled.

The configured identity must be a separate least-privileged read-only HANA user. The server rejects bindings that offer only HDI deployment credentials and never falls back to `hdi_user`/`hdi_password`. Its tools are limited to connection identity, object listing/descriptions, and parameterized row reads capped at 200 rows; credential-like columns are blocked, and there is no arbitrary SQL, DDL/DML, grant, deployment, or undeploy tool. Use the existing project deployment workflow yourself after reviewing the exact generated artifact diff and target. The SAP HANA Node.js driver is provided under the SAP Developer License Agreement.

## 💡 Example requests

Once the destination server is enabled in your chat's tools picker, ask for outcomes instead of manually orchestrating individual SAP operations:

> Find every reference to `ZCL_ORDER`, explain the impact of changing method `CREATE_ORDER`, and show me the callers before editing anything.

> Fix the defect in `ZCL_PRICING`, add or update ABAP Unit coverage, run syntax checks and the available tests, and summarize exactly what passed or was skipped.

> Inspect the dependencies and downstream consumers of this CDS view and tell me what would be affected by renaming the field.

> Read company codes from `T001` for this destination and return `BUKRS`, `BUTXT`, `WAERS`, and `LAND1`.

> Inspect the HANA HDI container attached to this workspace, describe the relevant tables, and show at most 20 rows for the columns needed to explain the issue. Do not change database state.

> Check the current object's transport context, prepare the change for transport, but do not release anything.

## 🔐 Enterprise-friendly safety model

| Guardrail | Behavior |
| --- | --- |
| 🎯 **Explicit target** | SAP changes only proceed when the destination and required target details are known. |
| 🚦 **Explicit state change** | Activation, service publication, and transport creation happen only when requested and authorized. |
| 🧪 **Verification first** | The agent uses available lint, syntax, unit-test, ATC, and diagnostics workflows and reports what actually ran. |
| 🔒 **SAP authorization remains authoritative** | The add-on does not bypass backend SAP permissions. |
| 🚚 **Curated VSP tool surface** | The proxy exposes the same curated developer-lifecycle set for every destination, plus local workflow tools; SAP authorizations and VSP safety checks still apply. |
| 🧱 **Per-destination isolation** | Generated MCP entries are scoped to a single `SAP_AI_DEV_TOOLKIT_DESTINATION`. |
| 🔑 **Credential-aware setup** | BAS authentication material stays in Destination configuration. Local SAP GUI setup writes VS Code input prompts for SAP user/password instead of raw credentials. |

<a id="install"></a>

## 📦 Installation

The default installation is a single npx command that runs the guided setup directly through npm — no global install required. It works in SAP Business Application Studio and on local workstations alike:

```sh
npx --yes --ignore-scripts sap-ai-dev-toolkit --setup
```

Prefer a persistent global install? Install globally from SAP Business Application Studio or from a local workstation with SAP GUI installed, then run setup explicitly for your environment:

| Environment / device | What to run | What setup does |
| --- | --- | --- |
| **Any environment (default — no global install)** | `npx --yes --ignore-scripts sap-ai-dev-toolkit --setup` | Runs the guided setup through npm and writes generated entries that launch the pinned package through `npx` (`cmd /c npx` on Windows). Add `--npx` to force the npx launcher even when a global `sap-ai-dev` command exists. |
| **SAP Business Application Studio dev space (global install)** | `npm install --global sap-ai-dev-toolkit`<br>`sap-ai-dev --setup` | Discovers BAS destinations, optionally imports Cloud Foundry Destination service records, and writes VS Code/BAS MCP entries. |
| **Windows workstation with SAP GUI (global install)** | `npm install --global sap-ai-dev-toolkit`<br>`sap-ai-dev --setup` | Discovers SAP GUI landscape entries, asks for SAP client(s) and ADT URL, then writes local VS Code MCP entries. Windows / smart card SSO (Edge) or username/password can be selected. |
| **macOS workstation with SAP GUI (global install)** | `npm install --global sap-ai-dev-toolkit`<br>`sap-ai-dev --setup` | Discovers SAP GUI landscape entries, asks for SAP client(s) and ADT URL, then writes local VS Code MCP entries with secure login prompts. |
| **Any local interactive terminal, already installed** | `sap-ai-dev --setup` | Re-runs the wizard to add, update, or remove generated MCP entries. Plain `sap-ai-dev` with no arguments also starts local setup when no BAS environment is detected. |
| **npm install hook did not show a wizard** | `sap-ai-dev --setup` | This is expected on some npm/Windows combinations because lifecycle scripts may run without an interactive console. The explicit setup command is the reliable path. |
| **Force npm to show install-time script output** | `npm install --global --foreground-scripts sap-ai-dev-toolkit` | Optional troubleshooting mode if you specifically want to see postinstall output during installation. Still run `sap-ai-dev --setup` afterwards if no destinations were configured. |

### 🪟 Windows notes

Everything works natively on Windows — PowerShell, cmd, and Windows Terminal are all supported:

- `npm install --global sap-ai-dev-toolkit` puts three commands on `PATH`: `sap-ai-dev`, its alias `sap-ai-dev-toolkit`, and `sap-ai-hana`. If `sap-ai-dev` is reported as unknown, npm's global bin directory is missing from `PATH` (run `npm prefix -g` to find it) or the install did not complete — `npx --yes --ignore-scripts sap-ai-dev-toolkit --setup` works without any global install.
- The pinned VSP runtime ships inside the package as a native `vsp-win32-x64.exe`; no Go toolchain, WSL, or extra downloads are required.
- MCP entries that launch through npm are written as `cmd /c npx ...` on Windows — the form VS Code, Claude Code, and Cursor can spawn there. Entries written on Linux/macOS use plain `npx`.
- Setup reads `mcp.json` even when Windows tools saved it with a UTF-8/UTF-16 BOM (PowerShell `>`/`Set-Content`, Notepad "UTF-8 with BOM") and rewrites it as plain UTF-8. If the existing file cannot be used as-is, setup self-heals before falling back to a reset: VS Code-style comments and trailing commas (JSONC) are recovered in place, torn reads from a concurrent editor save are re-read once, and broken `servers`/`inputs` fields are repaired individually. Every lossy change first backs up the original next to the real file as `mcp.json.healed|repaired|invalid-<timestamp>.bak` (exclusive create, so reruns never overwrite an earlier backup; symlinked configs keep their link). `sap-ai-dev --doctor` stays strict and reports such files instead of rewriting them — run `sap-ai-dev --setup` to heal.
- Local SAP GUI discovery reads the Windows landscape files and registry, and setup can write a Windows / smart card SSO entry that signs in through Microsoft Edge; see the “Local machine SAP GUI support” section below.

If you previously installed the old package, remove it first because the legacy `bas-vsp-mcp` command is no longer shipped:

```sh
npm uninstall --global bas-mcp-addon
npm install --global sap-ai-dev-toolkit
sap-ai-dev --setup
```

The guided setup can also offer companion MCP entries with `sap-ai-dev --setup --tools`:

| Server | npm package | Best for |
| --- | --- | --- |
| SAP Fiori tools | `@sap-ux/fiori-mcp-server` | Fiori elements/freestyle apps, annotations, and UX guidance |
| UI5 tools | `@ui5/mcp-server` | SAPUI5/OpenUI5 project inspection, help, and lint/project support |
| CAP tools | `@cap-js/mcp-server` | CAP CDS/service model inspection and CAP app development |
| Browser validation | `@playwright/mcp` | Fiori/UI smoke tests, screenshots, and browser runtime validation |

The installer handles VSP provisioning automatically:

- Uses the package's bundled patched VSP binary for the current platform, verified against the npm-published `dist/checksums.txt`. When the bundled asset is missing (an interrupted install, an antivirus quarantine, or a git checkout without `dist/`), a checksum-anchored download from the matching GitHub release is the fallback; MCP server startup runs it too, because npx entries skip install scripts.
- No Go toolchain is downloaded or required at install time; Go is only used by the repository's own `build:vsp` development script.

Setup detects where it is running. With `H2O_URL` set, it treats the environment as SAP Business Application Studio and opens a checkbox picker for BAS destinations, with no destinations selected by default: every row starts with an empty box `[ ]`. Use **Space** to tick a destination (`[✓]`) and **Enter** to confirm; the line under the list always names the next key to press. Press **a** to toggle all destinations (select all if any are unchecked; otherwise clear the selection). Pressing **Enter** with nothing selected asks for a second **Enter**, because confirming with none selected removes this add-on's managed MCP entries. When the `cf` CLI 8.18 or newer is authenticated to a targeted space, setup first offers an optional import from that space's Destination service; type **y** then **Enter** to include it, or press **Enter** to skip. Accepted CF and BAS destinations appear together in the picker.

Without `H2O_URL`, interactive setup looks for local SAP GUI system configuration on macOS and Windows (for example SAP GUI landscape XML and `saplogon.ini`). SAP GUI landscape files describe SAP GUI/DIAG connectivity, not the ADT HTTP(S) endpoint or a complete ABAP client catalog, so setup asks for the SAP client or comma-separated clients to configure for each selected system (for example `100,200`), proposes an ADT URL from the SAP GUI host and instance when it can, and asks you to confirm or edit that value. Multiple entered clients create separate isolated MCP entries, one per system/client pair. Local SAP GUI MCP server keys use the SAP system ID and client (for example `t4d-100`) instead of the longer SAP GUI description, while `SAP_AI_DEV_TOOLKIT_DESTINATION` still preserves the display name. When the ADT URL uses an IP address, setup automatically inspects the SAP HTTPS certificate, extracts DNS subjectAltName entries, and offers to enable secure TLS self-healing with a simple yes/no confirmation; you do not need to type certificate names. The generated MCP entry uses VS Code input prompts for the SAP user and password at server start; raw SAP credentials are not stored in `mcp.json`. On Windows, setup offers Windows / smart card SSO (the default) instead, which writes `SAP_AUTH_MODE=sso` without username/password prompts. At server start, VSP opens a Microsoft Edge window on the ADT URL whenever no session is cached yet; Edge completes the login the same way it does in your browser (smart card certificate and PIN, Kerberos, or company SAML/Entra login). Keep the MCP server running until the sign-in finishes; the session is then cached and refreshed automatically. SSO entries need an ADT URL with a host name, not an IP address. npm may run its install hook without an interactive terminal, even when the shell is interactive; in that case, destination selection is skipped without changing MCP config, and you should run `sap-ai-dev --setup` afterwards.

### 🖥️ Local machine SAP GUI support

Local setup is intended for developers running the MCP server from their own workstation rather than SAP Business Application Studio.

Supported discovery and runtime behavior:

- **Discovery sources:** SAP GUI landscape XML and `saplogon.ini` style configuration on macOS and Windows. Setup de-duplicates entries, ignores incomplete DIAG records, and shows the discovered SAP systems in the same checkbox picker used for BAS destinations.
- **Client selection:** SAP GUI entries may contain one default client but cannot reliably list every ABAP client available through ADT. Setup asks for one or more 3-digit clients per selected system; enter comma-separated values such as `100,200` to create separate MCP servers for each client.
- **ADT endpoint derivation:** SAP GUI entries usually contain DIAG/router information, not the HTTP(S) ADT endpoint. Setup derives the common ADT port from the SAP instance when possible, for example instance `00` → `https://host:44300`, and asks for confirmation only when configuring the selected entry.
- **Credential handling:** username/password local entries use VS Code MCP input prompts (`${input:...}`) at server start. Plain SAP credentials are not written to `mcp.json`.
- **Login methods:** local entries use either username/password or Windows / smart card SSO. SSO sets `SAP_SSO=true` for the VSP runtime, which drives Microsoft Edge for the login: the first sign-in opens an Edge window immediately, and an expired session is refreshed without a window for up to 15 seconds before Edge opens again. While a sign-in is pending, the MCP server output repeats a reminder every 15 seconds. If a sign-in fails — the browser cannot start, its window is closed, or the sign-in times out — the server retries with the next Chromium-based browser it finds (Microsoft Edge, Google Chrome, Brave, Vivaldi, Chromium, including per-user installs and Windows App Paths registrations), or once more with the only one, and logs each attempt with its reason.
- **IP-address HTTPS self-healing:** if the confirmed ADT URL is `https://<ip>:<port>` and the certificate is issued to DNS names, setup reads the certificate DNS SANs automatically and stores them as `SAP_TLS_SERVER_NAMES`. At runtime a loopback proxy dials the IP address but verifies TLS against those discovered DNS names, trying them one by one. Certificate verification stays enabled; there is no `--insecure` mode.
- **Private CAs:** if the SAP HTTPS certificate chains to an internal CA that is not trusted by the local Node runtime, set `SAP_TLS_CA_FILE` or `SAP_AI_DEV_TOOLKIT_TLS_CA_FILE` to a PEM CA bundle. This adds trust roots for the self-healing proxy without disabling certificate validation.
- **Redirect and request safety:** local loopback proxies reject cross-origin forward-form requests and rewrite same-origin SAP redirects back through the loopback listener, so VSP stays on the safe route.

Typical local setup flow:

```sh
sap-ai-dev --setup
```

1. Select the discovered SAP GUI system with **Space** and confirm with **Enter**. If no SAP GUI entries are found, setup offers the manual entry wizard: enter a system name, ADT URL, client(s), and login mode instead.
2. Confirm the detected/default SAP client, or enter multiple clients such as `100,200`.
3. Accept the proposed ADT URL when it is correct, or edit it if your landscape exposes ADT through a different HTTP(S) host/port.
4. If setup discovers certificate DNS names for an IP-based HTTPS URL, accept the yes/no TLS self-healing prompt.
5. Choose Windows / smart card SSO or username/password when the prompt is available.
6. Start each generated MCP server from VS Code's **MCP: List Servers** command.

The same postinstall offers the bundled agents and skills for several AI coding harnesses in a checkbox picker. **GitHub Copilot** and **Claude Code** start pre-checked, so pressing **Enter** alone installs both; **Space** selects or deselects a harness, **a** toggles all seven, and confirming with none selected skips the step without changing files. When MCP setup succeeds, the generated managed MCP servers are also mirrored into selected harnesses that have a stable user-level JSON MCP configuration (Claude Code, Cursor, Gemini CLI, and Pi Coding Agent). GitHub Copilot continues to use the VS Code/BAS MCP configuration written during setup. With no interactive terminal, the assets are installed for GitHub Copilot only; set `SAP_AI_DEV_TOOLKIT_HARNESSES` to a comma-separated list of harness ids (`github-copilot`, `claude-code`, `codex`, `cursor`, `gemini-cli`, `opencode`, `pi-coding-agent`) to choose non-interactively.

Some current npm versions also require install hooks to be approved. If npm reports that `sap-ai-dev-toolkit`'s `postinstall` was blocked, allow it during a fresh install with `npm install --global --allow-scripts=sap-ai-dev-toolkit sap-ai-dev-toolkit`, or run `sap-ai-dev --setup` from an interactive terminal after installation.

The setup report uses icons and terminal colors; set `NO_COLOR=1` to disable ANSI colors. Long-running steps (BAS destination discovery, ADT probes, VSP runtime provisioning, `--doctor` checks) show an animated progress line so the terminal never looks stuck; it appears only on interactive terminals and is disabled automatically on CI — set `SAP_AI_DEV_TOOLKIT_DISABLE_SCAN_ANIMATION=true` to turn it off. The table is a weather report, not a bouncer: green **PASS** means the ADT probe responded, red **FAIL** means it failed, and yellow **SKIPPED** means it was skipped. Probe failures do not block MCP registration or startup for destinations you select.

Run `sap-ai-dev --setup` later to change the destination selection or remove generated destination entries. Run `sap-ai-dev --setup --tools` to also choose optional companion tools. Generated destination entries use the global `sap-ai-dev` command when it is on `PATH` and is the same package version as the setup that writes them; otherwise (for example after a pure npx setup, or when an older global install is still on `PATH`) they automatically launch the pinned package version through `npx`, routed through `cmd /c npx` on Windows so every MCP host can spawn them. Setup warns when it skips a global install of another version. Pass `--npx` to force the npx launcher even when a global command exists; companion tools already use `npx` with their own npm packages.

If a setup step is skipped or fails, rerun it from an interactive terminal:

```sh
sap-ai-dev --setup
```

To configure without a global install, run the guided setup directly through npm:

```sh
npx --yes --ignore-scripts sap-ai-dev-toolkit --setup
```

This lists discovered systems in the same checkbox picker, with nothing selected by default. Use **Space** to choose destinations, **Enter** to confirm, **a** to toggle all (select all if any are unchecked; otherwise clear the selection), and **m** to configure an undiscovered system manually in the manual entry wizard; configured systems join the picker pre-selected. Because no global `sap-ai-dev` command is on `PATH`, it writes MCP entries that launch the pinned package version through npx — through `cmd /c npx` on Windows, which is the form VS Code, Claude Code, and Cursor can spawn there. `--ignore-scripts` avoids running the install-time wizard a second time; add `--npx` to force this launcher shape even when the toolkit is installed globally. After setup, in BAS or VS Code run **MCP: List Servers**, select each chosen destination, and choose **Start Server**.

For a non-interactive installation or a platform without a published VSP asset, provide a trusted binary override:

```sh
SAP_AI_DEV_TOOLKIT_BINARY=/path/to/vsp npm install --global sap-ai-dev-toolkit
```

At the end of a global install, the color-coded summary shows the MCP config path, each generated entry name, destination/client/authentication, launch command, and environment key names (not values). The installer does not open an editor automatically; in BAS/VS Code:

1. Open the Command Palette.
2. Run **MCP: List Servers**.
3. Select the generated server name shown in the report and choose **Start Server**.
4. Use **MCP: Open User Configuration** to inspect or edit the generated entries. Each entry is isolated to its destination.

<a id="agents"></a>

## 🤖 ABAP agents and skills for your AI harness

The package includes five user-invocable custom agents (**SAP Solution Architect**, **ABAP Developer**, **ABAP Runtime Debugger**, **RAP Service Developer**, and **HANA Cloud/HDI Specialist**) and fourteen task-focused Agent Skills for GitHub Copilot, Claude Code, and other supported AI coding harnesses in BAS.

### 🧠 How the SAP Solution Architect and ABAP Developer agents work

1. **Start with architecture when requirements are open-ended.** Use **SAP Solution Architect** to investigate the SAP system, evaluate SAP standard solutions, recommend released APIs, apply Clean Core and side-by-side extensibility, create the solution design, and orchestrate the SDLC through implementation work packages and validation gates.
2. **Understand the request.** Establish the expected behavior and, for SAP changes, the destination, package, and transport or temporary target. Ask only when a material detail is missing.
3. **Plan before implementing.** Every implementation task starts with a presented plan: objects to change, ABAP Unit test approach, local authoring/validation, and the SAP write/activation steps it requires. The agents proceed while work stays read-only or workspace-local and wait for explicit approval before any plan that writes to, activates in, or publishes to the SAP system.
4. **Inspect before editing.** Read relevant source, tests, callers, dependencies, standard APIs, release state, and conventions; query the active MCP server's live `tools/list` and use its exact destination-prefixed tools and schemas.
5. **Implement with behavior in mind, locally first.** Add or refine an ABAP Unit assertion first when an executable regression test is available, then make the smallest change that meets the request. Sources are authored locally as plain workspace source files (`object.type.extension`), and checked and linted there before they are sent to SAP.
6. **Check and lint before sending to SAP.** Run the local `LintABAP` tool on the caller-supplied files plus required dependencies and consume BAS editor LSP diagnostics when configured; fix findings locally and re-lint. Only then transfer the sources to SAP and use the remote `SyntaxCheck`, `RunUnitTests`, and `RunATCCheck` when exposed and relevant. Lint and syntax checks do not replace behavior tests.
7. **Protect SAP state.** Only make requested changes. Activate objects or publish services only when asked; create transports only when explicitly authorized. Release and deletion of transports are unavailable through this add-on.
8. **Report observed results.** Summarize architecture decisions, changed objects, implementation handoff or actual validation, activation, and publication outcomes. Identify skipped checks and exact blockers; never claim a check passed if it did not run.

### 🧩 Included Agent Skills

| | Skill | Focus |
| --- | --- | --- |
| 🧑‍💻 | `abap-development` | Implement and refactor ABAP reports, classes, interfaces, and function groups. |
| ✅ | `abap-testing-quality` | ABAP Unit behavior tests, lint, LSP diagnostics, syntax checks, and ATC. |
| 🧩 | `cds-development` | Model CDS definitions and inspect dependencies and consumers. |
| 🚀 | `rap-development` | Build RAP business objects and services; publish only when requested. |
| 🧭 | `sap-standard-api-analysis` | Assess SAP standard capabilities, released APIs, CDS/RAP/OData options, and fit-gap before custom code. |
| 🧱 | `clean-core-extensibility` | Design Clean Core compliant in-app, developer, API/event, and side-by-side extension patterns. |
| 🔁 | `sap-sdlc-orchestration` | Orchestrate discovery, design, implementation handoffs, quality gates, transport readiness, and handover. |
| 🐞 | `abap-debugging` | Diagnose dumps, application logs, traces, and runtime failures. |
| 🔬 | `abap-runtime-analysis` | Analyze incidents, debugger state, and performance symptoms; derive call relationships from source inspection. |
| 🚀 | `rap-service-delivery` | Validate RAP service bindings, activation, publication, and end-to-end OData behavior. |
| 🚚 | `sap-transport-release` | Check dependencies and prepare changes for transport; release is not available here. |
| 🔎 | `hana-cloud-inspection` | Verify the attached HANA target and inspect bounded HDI metadata and rows. |
| 🧱 | `hana-cloud-native-development` | Create CAP CDS or required native HDI source artifacts while avoiding duplicate models. |
| ✅ | `hana-cloud-validation` | Build locally, review deployment risks, and hand off deployment to the user. |

### 📥 Install agents and skills for your user

During npm postinstall, after the destination or local SAP GUI setup step, the installer prints a 🤖 notice and a checkbox picker asking which AI coding harnesses should receive the bundled agents and skills. **Space** selects or deselects, **a** toggles all, **Enter** confirms. **GitHub Copilot** and **Claude Code** are pre-checked, so pressing **Enter** without changes installs both; confirming with none selected skips the step and leaves your files unchanged.

| Harness | Skills land in | Agents land in | MCP auto-wiring |
| --- | --- | --- | --- |
| GitHub Copilot | `$HOME/.copilot/skills/` | `$HOME/.copilot/agents/*.agent.md` | Uses the VS Code/BAS `mcp.json` written by setup |
| Claude Code | `$HOME/.claude/skills/` | `$HOME/.claude/agents/<id>.md` (frontmatter reduced to `name` and `description`) | `$HOME/.claude.json` |
| OpenAI Codex | `$HOME/.agents/skills/` | — | Not changed automatically |
| Cursor | `$HOME/.cursor/skills/` | — | `$HOME/.cursor/mcp.json` |
| Gemini CLI | `$HOME/.gemini/skills/` | — | `$HOME/.gemini/settings.json` |
| opencode | `$XDG_CONFIG_HOME/opencode/skills/` (default `$HOME/.config/opencode/skills/`) | `$XDG_CONFIG_HOME/opencode/agents/<id>.md` (as subagents) | Not changed automatically |
| Pi Coding Agent | `$PI_CODING_AGENT_DIR/skills/` (default `$HOME/.pi/agent/skills/`) | `$PI_CODING_AGENT_DIR/prompts/<id>.md` (as `/` prompt commands) | `$PI_CODING_AGENT_DIR/mcp.json` (default `$HOME/.pi/agent/mcp.json`) |

All 14 skills use the portable `SKILL.md` format and are installed verbatim. The 5 agents use Copilot's `.agent.md` format, so they are installed as native custom agents for harnesses with a custom-agent mechanism (GitHub Copilot, Claude Code, opencode), with frontmatter adapted where needed. Pi receives equivalent prompt templates (`/abap-developer`, `/sap-solution-architect`, and so on) because Pi exposes reusable personas through prompts rather than a separate custom-agent file type. Selecting several harnesses duplicates the small markdown payloads on disk.

MCP auto-wiring preserves unrelated servers in each harness config and replaces only entries previously managed by `sap-ai-dev-toolkit`. Generated entries carry `SAP_AI_DEV_TOOLKIT_MANAGED=true` in their server environment so future reinstalls can reconcile them without touching user-owned MCP servers.

These user-level customizations are available across workspaces opened by the same OS user (or the same BAS user in a dev space). The harness may need a window reload to discover new files. A non-interactive install skips the picker and installs for GitHub Copilot only; override with `SAP_AI_DEV_TOOLKIT_HARNESSES` (comma-separated harness ids). `npm install --ignore-scripts` skips the postinstall wizard entirely.

On reinstall or package upgrade, unchanged add-on-managed files are updated per harness. Existing customizations and files edited since the previous install are preserved; postinstall reports paths that need manual review instead of overwriting them.

### 🗂️ Add the agents and skills to a repository

To commit repository-scoped customizations, copy the packaged files from the installed package without overwriting existing files:

```sh
ADDON_ROOT="$(npm root -g)/sap-ai-dev-toolkit"
mkdir -p .github/agents .github/skills
cp -n "$ADDON_ROOT/.github/agents/"*.agent.md .github/agents/
cp -Rn "$ADDON_ROOT/.github/skills/." .github/skills/
```

Review skipped or conflicting files and merge changes manually. `LintABAP` analyzes caller-supplied source in memory; it does not read workspace files. `vsp lsp --stdio` supplies editor diagnostics separately and does not appear in `tools/list`.

<a id="bas"></a>

## 🧭 SAP AI Dev Toolkit setup in BAS

`sap-ai-dev --setup` reads BAS destination names from `H2O_URL/api/listDestinations`, then gives each destination's `/sap/bc/adt/discovery` endpoint a quick knock through the BAS proxy. HTTP 2xx, 401, and 403 count as reachable; other responses and network failures are reported but do not exclude discovered destinations from the selection list or prevent startup when selected.

If the `cf` CLI is version 8.18 or newer and authenticated to a targeted space, setup offers an opt-in import from that space's SAP Destination service. It does not create service keys unless you accept. The imported records are limited to the current space and are merged with BAS destinations for selection. OnPremise destinations require choosing a Connectivity service instance; runtime traffic uses that service's proxy, and PrincipalPropagation uses the current CF user's token. Internet destinations use the configured HTTP(S) proxy environment. Setup stores only service-instance/key references in `mcp.json`, not the service-key credentials. At runtime the generated entry verifies the active CF space and resolves those references. Setup removes an add-on-created key only when no remaining CF entry references it and the CLI is targeted to the key's recorded space; keys are left untouched when the space cannot be verified.
Cloud Foundry HTTP destination probes use forward-form HTTP requests, not CONNECT tunnels; SAP Connectivity requires HTTP from the application to its proxy. OnPremise requests are canceled when the client disconnects or the runtime route closes.

Interactive npm install and `sap-ai-dev --setup` both use a checkbox picker with no destinations selected by default. Use **Space** to choose destinations, **Enter** to confirm, **a** to toggle all (select all if any are unchecked; otherwise clear the selection), and **m** to configure an undiscovered system manually in the manual entry wizard; configured systems join the picker pre-selected. Confirming with none checked takes a second **Enter** and removes this package's generated MCP entries. Non-interactive installs skip destination or local SAP GUI system selection without changing MCP config. Run the interactive setup command above; generated entries fall back to the pinned npx launcher automatically when the package is not installed globally.

When nothing is detected — no BAS destinations, no Cloud Foundry imports, or no local SAP GUI entries — setup offers the **manual entry wizard** instead of stopping. The same wizard is available at any point in the destination picker via the **m** shortcut. It asks for a system name, the ADT HTTP(S) base URL (for example `https://myhost.example:44300`), one or more 3-digit SAP clients, and (on Windows) the login mode. You can add several systems in one run; each becomes the same isolated per-system/client MCP server the discovery flows generate, including credential input prompts and TLS self-healing for IP-based HTTPS URLs. Declining the wizard when nothing was detected exits setup without changes; aborting it inside the picker (Ctrl+C) returns to the selection unchanged.

Setup tidies its own footprint: it reconciles MCP entries managed by this package and removes legacy `sapAiDev_*` / `basVspMcp_*` entries from earlier releases. Existing unrelated MCP servers and top-level configuration such as `inputs` stay untouched.

### 🌐 BAS destination example

First, give BAS a route to your backend: create the destination in **BTP Cockpit → Connectivity → Destinations** in the subaccount where BAS runs.

The sample values sketch an on-premise ABAP backend routed through SAP Cloud Connector; swap in the URL, proxy type, and authentication configured for your landscape.

| Destination field | Example | Notes |
| --- | --- | --- |
| `Name` | `DEMO_ABAP` | Unique BAS destination name. It becomes `SAP_AI_DEV_TOOLKIT_DESTINATION`, and its lowercase slug (`demo-abap`) becomes the generated MCP server name. |
| `Type` | `HTTP` | ADT is an HTTP service. |
| `URL` | `https://abap.example.com:44300` | Backend URL exposed through the configured route. |
| `Proxy Type` | `OnPremise` | Use `OnPremise` for Cloud Connector; use `Internet` for a directly reachable public endpoint. |
| `Authentication` | `PrincipalPropagation` | Example only; choose an authentication method configured for the backend and Cloud Connector. |
| `sap-client` | `100` | SAP client to target. The add-on defaults to `001` if omitted. |
| `HTML5.DynamicDestination` | `true` | BAS destination property shown in the supplied sample. |
| `WebIDEEnabled` | `true` | Exposes the destination to BAS development tools. |
| `WebIDEUsage` | `dev_abap,odata_abap` | Include `dev_abap` for ABAP development; add other usages required by your BAS scenario. |
| `CloudConnectorLocationId` | `DEMO-LOCATION` | Optional; set only when the Cloud Connector uses a location ID. |

For on-premise systems, configure Cloud Connector access to the backend host and port first. The add-on uses the authentication already configured in BAS or the Cloud Foundry Destination service; manage SAP credentials there.

Think of `H2O_URL` as BAS's front door: it must point to the endpoint serving `/api/listDestinations`, not to the SAP backend.

The `/api/listDestinations` response is a JSON array of destination records. A representative record:

```json
{
  "Type": "HTTP",
  "HTML5.DynamicDestination": "true",
  "Authentication": "PrincipalPropagation",
  "WebIDEEnabled": "true",
  "ProxyType": "OnPremise",
  "sap-client": "100",
  "Name": "DEMO_ABAP",
  "WebIDEUsage": "dev_abap,odata_abap",
  "Host": "https://abap.example.com:44300",
  "WebIDEExposedHost": "abap.example.com:44300"
}
```

The BAS editor calls the backend address URL; the sample-style list response may report it as `Host`. Discovery needs a non-empty `Name`, reads `Authentication` and `sap-client` case-insensitively, and accepts these fields either at the record root or under `Properties`.

A destination name must start with a letter or digit and contain only letters, digits, `.`, `_`, or `-`.

The add-on probes `http://<Name>.dest/sap/bc/adt/discovery` through the BAS proxy. HTTP 2xx, 401, and 403 mean the ADT endpoint is reachable; other responses and network errors are reported but do not exclude a discovered destination from the selection list.

`WebIDEEnabled`, `WebIDEUsage`, `HTML5.DynamicDestination`, and returned host fields are BAS metadata, not filters used by this probe.

See SAP Help: **Create a Destination to Connect to SAP Business Application Studio** and **Creating a Destination to an ABAP System for BAS**.

### 🔌 Generated MCP server entry

One selected system, one isolated stdio MCP entry. Here's the shape:

```json
{
  "type": "stdio",
  "command": "sap-ai-dev",
  "env": {
    "H2O_URL": "https://bas.example.com",
    "SAP_AI_DEV_TOOLKIT_DESTINATION": "DEMO_ABAP",
    "SAP_ALLOW_TRANSPORTABLE_EDITS": "true"
  },
  "BAS_EXT": "true"
}
```

The MCP protocol `serverInfo.name` is the lowercased destination slug (from `SAP_AI_DEV_TOOLKIT_DESTINATION`, legacy `BAS_VSP_DESTINATION` accepted), so each wizard-generated destination has its own identity instead of the shared `sap-ai-dev-toolkit` name.

Credentials, cookies, SAP usernames, passwords, and raw BAS destination payloads are not written to the MCP configuration.

### ⚙️ MCP configuration location

The configuration path is selected in this order:

1. `SAP_AI_DEV_MCP_CONFIG`, when set.
2. `SAP_AI_DEV_TOOLKIT_MCP_CONFIG`, when set.
3. `BAS_VSP_MCP_CONFIG`, when set for compatibility with earlier releases.
4. An existing MCP user configuration detected automatically.
5. The default MCP user configuration location.

Set `SAP_AI_DEV_MCP_CONFIG` to use a specific configuration file:

```sh
SAP_AI_DEV_MCP_CONFIG="/path/to/mcp.json" sap-ai-dev --setup
```

The file must be strict JSON with an object-valued `servers` property. Existing malformed or incompatible files are rejected without overwriting them.

### 🛠️ Commands

| Need | Command |
| --- | --- |
| See options without starting the MCP server | `sap-ai-dev --help` |
| Walk through setup interactively | `sap-ai-dev --setup` |
| See discovered systems and probe results | `sap-ai-dev --list-destinations` |
| Get the same report in machine-readable, redacted form | `sap-ai-dev --list-destinations --json` |
| Check availability without starting the server | `sap-ai-dev --check` |

With `H2O_URL` set, the normal command starts the MCP proxy. Each generated entry supplies one `SAP_AI_DEV_TOOLKIT_DESTINATION`, so each server stays in its own lane and exposes only its selected SAP system.

The proxy exposes a curated subset of VSP tools, plus local `LintABAP`, destination-scoped workflow tools, and the convenience `GetApplicationLog` mapping when the VSP SAP router is available. Hidden VSP tools remain available only behind local workflow chaining where required; they are not advertised or directly callable through the proxy. Direct VSP invocation remains available outside BAS when you pass an explicit VSP argument.

Without `H2O_URL`, generated local SAP GUI entries start a destination-scoped local MCP server. In an interactive local terminal with no arguments, `sap-ai-dev` starts local setup. Other non-setup arguments are passed directly to the installed VSP binary—no BAS proxy detour.

### 🔄 How an MCP tool call reaches SAP

`sap-ai-dev` is an MCP stdio server and destination router, not a terminal command for individual SAP operations. No shell incantations needed: your MCP client discovers the tools, picks one for the chat request, and sends the call over stdio.

Each generated MCP server entry is named with the lowercased destination slug: `DEMO_ABAP` becomes `demo-abap`. Because every generated entry is scoped to exactly one destination, tool names carry no redundant prefix — they are plain lowercase snake_case (`get_source`, `run_query`, `lint_abap`); the server name already states which SAP system it targets. Only when one server fronts several destinations (manual multi-destination startup) does each name gain its destination slug (`demo-abap_run_query`) to stay unambiguous. Lowercase names are deliberate: BAS and VS Code derive chat tool references from the server and tool names and only bind lowercase identifiers, so mixed-case names show up in the tools picker but never bind to the chat session. Use the exact names shown by your MCP client; punctuation can change during slugification.

Upgrading from an earlier release that wrote mixed-case entry names (for example `ActionS4D` or `cf:<guid>:<guid>:<name>`)? Re-run `sap-ai-dev --setup` to replace legacy entries — this is the only migration path for Cloud Foundry entries — or run `sap-ai-dev --doctor` to rename BAS entries in place. Then reload the BAS window and start a new chat; an existing chat keeps its stale tool binding. If setup reports that the lowercase name already exists and is not managed by this package, rename or remove that user-owned server entry first.

The proxy keeps VSP tool descriptions and input schemas, then adds the destination label. `LintABAP` and the workflow tools are implemented locally; they use the schemas shown by `tools/list` and call only the destination attached to their name. Linting operates on submitted source in memory. The live `tools/list` result remains the source of truth for the installed VSP binary's exact schemas.

<a id="tools"></a>

## 🧰 Tool catalog

From read-only inspection to controlled SAP changes. The catalog is organized by developer intent so you can quickly see what the agent can inspect, query, validate, edit, activate, or prepare for transport.

The menu includes the tools registered by the active VSP mode, the `GetApplicationLog` mapping, local linting, and destination workflows where their required VSP capabilities are available. Focused mode may omit `ActivateMultiple`, `GetUserTransports`, and `GetTransportInfo`; the live `tools/list` result remains authoritative.

### 🧹 Lint submitted ABAP source locally

The tool is named `lint_abap` (the local workflow name `LintABAP` exposed in snake_case; on a multi-destination server it is `<destination-slug>_lint_abap`). It accepts caller-supplied source files with `object.type.extension` filenames; config is optional and, when present, is the full abaplint configuration rather than a merge with defaults.

```json
{
  "files": [
    {
      "filename": "zdemo.prog.abap",
      "source": "REPORT zdemo.\nWRITE 'Hello'."
    }
  ]
}
```

`files` must be a nonempty array of `{ "filename": string, "source": string }` entries. The basename follows `<object>.<type>.<extension>`, such as `zcl_demo.clas.abap`. If the code depends on other objects, include those sources in the same `files` array; the tool does not resolve `config.dependencies`, read local files, make network requests, or contact SAP.

The single text item in the MCP result contains JSON: `{ "status": "clean" | "issues", "filesChecked": number, "issueCount": number, "errors": number, "warnings": number, "infos": number, "issues": [...] }`. Each issue reports filename, rule, severity, message, and start/end positions with line and column. Lint findings—including Error-severity findings—are reports, not MCP tool-call errors.

### 🧩 Review and delivery workflows

These local tools are namespaced by destination. Change-set tools appear when VSP exposes `GetSource` and `WriteSource`; transport and Clean Core tools appear when their underlying checks exist. RAP suite tools use the selected destination's proxy route.

| Tool | Behavior |
| --- | --- |
| `PrepareABAPChangeSet` | Stage up to 12 full-source `WriteSource` changes and return line diffs plus SHA-256 fingerprints. Proposals stay in MCP process memory. |
| `ApplyABAPChangeSet` | Re-read each object and write only when its source still matches the reviewed version. It stops on conflicts or errors and reports partial application; it does not roll back SAP writes. |
| `CheckTransportReadiness` | Run a caller-selected bundle of transport, dependency, inactive-object, ABAP Unit, and ATC checks. Completed calls may still contain findings. |
| `PlanABAPCloudMigration` | Batch `GetAPIReleaseState` checks for ADT object URIs and prioritize recognized unreleased APIs ahead of unknown and released states. SAP evidence stays attached. |
| `GenerateRAPRegressionSuite` | Read `$metadata` and return reusable JSON with a metadata check and one `$top=1` GET for each entity set. |
| `RunRAPRegressionSuite` | Run the saved suite with GET requests, expected status/content-type checks, and optional JSON-path assertions. Requests stay under the same `/sap/opu/odata` service root; response bodies are capped at 2 MiB. |

For a change set, pass the exact `GetSource` arguments and observed full source for each object, plus exact `WriteSource` arguments containing the replacement source. Each source is limited to 128 KiB and 1,000 lines so the full diff can be reviewed. Review every diff before calling `ApplyABAPChangeSet`. Each object is checked immediately before its write; a change after that read can still race the write because VSP does not expose compare-and-write here.

For a transport report, include exactly one `GetTransport` check whose `transport` matches `transport_id`, then add applicable dependency, inactive-object, ABAP Unit, or ATC checks. Each uses the exact arguments in the live upstream schema.

For an ABAP Cloud assessment, get object URIs from `SearchObject` and pass them to `PlanABAPCloudMigration`. It reports release evidence; it does not guess replacement APIs. Save the JSON from `GenerateRAPRegressionSuite` and pass it to `RunRAPRegressionSuite` after relevant service changes.

`sap-ai-dev --doctor` probes each discovered destination, checks that each managed MCP entry still matches its selected BAS destination, starts VSP, lists MCP tools, and calls `GetSystemInfo` directly when that tool is exposed. It repairs only tagged toolkit-owned BAS entries that can be verified against complete destination discovery; it does not add destinations, remove stale or third-party entries, or overwrite malformed configuration. `--doctor --json` reports redacted diagnostics and exits unsuccessfully when a required check fails.

`tools/list` confirms what this MCP server exposes; it does not prove that VS Code attached the server to the active chat. Start the selected destination in **MCP: List Servers**, enable it in the Chat tools picker, and reload/reselect the agent if the host binding is stale. This add-on cannot inspect or repair another MCP server's registration or a host-wide tool budget.

`sap-ai-dev --demo` starts an isolated server with sample ABAP objects, test and ATC results, a sample transport, and synthetic OData metadata and rows. Source edits and transport creation stay in process memory and disappear on exit. The demo does not discover or contact BAS or SAP destinations.

### 🔎 Find and understand ABAP objects

| Tool | What it does |
| --- | --- |
| `GetSource` | Read source for programs, classes, interfaces, function modules and groups, includes, CDS, and supported RAP/DDIC objects. |
| `SearchObject` | Find repository objects by name or wildcard query. |
| `GrepObjects` | Search regular expressions across specified object URLs. |
| `GrepPackages` | Search regular expressions in one or more packages, optionally including subpackages. |
| `FindDefinition` | Locate a symbol's definition from source text and a position. |
| `FindReferences` | Find references to an object or a symbol. |
| `GetContext` | Summarize public signatures of source dependencies for code review. |
| `CompareSource` | Compare two objects and return a unified diff. |
| `GetClassInfo` | Inspect class methods, attributes, interfaces, and inheritance metadata. |
| `GetPackage` | Read package details. |
| `GetAPIReleaseState` | Check whether an object is released for S/4HANA Clean Core / ABAP Cloud development; use the URI returned by `SearchObject`. |
| `GetFunctionGroup` | Read function-group source. |
| `GetFunction`, `GetClass`, `GetClassComponents`, `GetClassInclude`, `GetProgram`, `GetInclude`, `GetInterface` | Read supported object-specific source or metadata views. |
| `ListDependencies` | List dependencies for impact and transport-readiness planning. |
| `GetInactiveObjects` | List objects changed by the current user but not yet activated. |

### 🗃️ Read SAP tables and metadata

| Tool | What it does |
| --- | --- |
| `GetTable` | Read an ABAP Dictionary table's structure. |
| `GetTableContents` | Read table rows, optionally with an ABAP SQL filter and row limit. |
| `RunQuery` | Run a freestyle ABAP SQL query against the SAP database. |
| `GetCDSDependencies` | Follow a CDS view's forward dependencies to its sources. |
| `GetCDSImpactAnalysis` | Find downstream consumers of a CDS view (reverse dependencies). |
| `GetCDSElementInfo` | Read CDS element names, types, annotations, and semantic metadata. |

`RunQuery` uses ABAP SQL, not generic SQL. Use `max_rows` instead of `LIMIT`; for ordering use `ASCENDING` or `DESCENDING`, not `ASC` or `DESC`.

SAP authorizations and the destination's available APIs still apply.

### ✍️ Create, update, and activate

| Tool | What it does |
| --- | --- |
| `WriteSource` | Create or update supported ABAP source objects; detects create versus update in upsert mode. |
| `EditSource` | Replace a specific source fragment; syntax checking is enabled by default. |
| `PrepareABAPChangeSet` | Stage reviewed full-source diffs for up to 12 `WriteSource` changes. |
| `ApplyABAPChangeSet` | Re-read each staged object and apply reviewed writes when the source still matches. |
| `SyntaxCheck` | Ask SAP to syntax-check source before saving or activation. |
| `Activate` | Activate one named ABAP object. |
| `ActivateMultiple` | Activate related objects together while resolving mutual dependencies, such as an include and its main program. |

The write and activation tools change SAP state. Confirm the target, package, and transport before using them. `EditSource` performs a focused replacement; its default syntax check prevents saving when syntax errors are reported.

### ✅ Test and inspect the system

| Tool | What it does |
| --- | --- |
| `RunUnitTests` | Run ABAP Unit tests for an object; dangerous and long-running tests are excluded by default. |
| `RunATCCheck` | Run an ABAP Test Cockpit check and return findings. |
| `GetSystemInfo` | Read system ID, SAP release, kernel, and database details. |
| `GetInstalledComponents` | List installed software components and versions. |
| `GetFeatures` | Probe optional system capabilities, including RAP/OData, AMDP debugging, UI5/BSP, and CTS transports. |
| `GetConnectionInfo` | Show the connected user, client, URL, mode, and feature-probe summary for the current destination session. |
| `PrettyPrint` | Format ABAP source text without saving it to SAP. |

### 🚚 Inspect and create transports

| Tool | What it does |
| --- | --- |
| `ListTransports` | List a user's transport requests with optional status, type, source, date, and grouping filters. |
| `GetUserTransports` | Read and group a user's transport requests and tasks; supports organizer filters and source selection. |
| `GetTransport` | Read a transport request's details, objects, and tasks. |
| `GetTransportInfo` | Find eligible transports and lock status for an ABAP object or package. |
| `LockObject` | Lock an ABAP repository object in SAP. |
| `UnlockObject` | Unlock an ABAP repository object in SAP. |
| `CreateTransport` | Create a transport request. |
| `CheckTransportReadiness` | Collect a whitelisted bundle of transport, dependency, inactive-object, ABAP Unit, and ATC evidence. |
`LockObject` and `UnlockObject` are state-changing VSP tools; the proxy does not retry them after a child crash to avoid duplicate side effects.

Transport release and deletion are not exposed by the curated proxy surface; release or delete transports outside this add-on after review.

The proxy starts VSP with `--enable-transports` and omits `--transport-read-only`. Generated MCP entries set `SAP_ALLOW_TRANSPORTABLE_EDITS=true` so source edits in transportable packages are permitted. VSP safety checks and SAP authorizations still apply.

### 📜 Read SAP application logs (SLG1)

| Tool | What it does |
| --- | --- |
| `GetApplicationLog` | Extract newest-first application log entries, optionally including message details and texts. |

- Filter by program, user, object, subobject, from, and to.
- `max_results` defaults to 100. Date-only `to` values include the full day.
- `messages: true` adds BALDAT details and T100 message text; otherwise, the tool returns log headers only.
- The proxy maps this convenience tool to the single upstream `SAP(action="analyze", type="application_log")` operation. The general-purpose `SAP` router itself is hidden from direct calls.

The proxy intentionally does not expose the full child VSP process. Object deletion, broad trace surfaces, arbitrary SAP router/RFC calls, debugger helper/delete-breakpoint routes, and transport release/delete tools are hidden from direct MCP calls. The curated debugger tools (`SetBreakpoint`, `GetBreakpoints`, `DebuggerAttach`, `DebuggerGetStack`, `DebuggerGetVariables`, `DebuggerStep`, and `DebuggerDetach`) remain available when VSP and the target system expose them. Direct VSP invocation without `H2O_URL` retains the VSP binary's own tool surface; in an interactive local terminal, use an explicit VSP argument because plain `sap-ai-dev` starts local setup.

### 🚀 Ready to put the tools to work from chat?

1. Start the generated server in BAS with **MCP: List Servers**.
2. In the Chat tools picker, enable the server for the destination you want.
3. Ask for the operation in plain language. The MCP client sends `tools/call`; no need to type a tool such as `GetSource` into a terminal.
4. Check the response in chat. For source edits, ask for a syntax check and tests before activation when that matches your workflow.

For a quick table read—say, company codes from `T001`—select the destination's `RunQuery` tool (exposed as `run_query`; `demo-abap_run_query` only on a multi-destination server) and pass:

```json
{
  "sql_query": "SELECT BUKRS, BUTXT, WAERS, LAND1 FROM T001",
  "max_rows": 100
}
```

The same request can be expressed to an MCP client as:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "run_query",
    "arguments": {
      "sql_query": "SELECT BUKRS, BUTXT, WAERS, LAND1 FROM T001",
      "max_rows": 100
    }
  }
}
```

Use the name returned by `tools/list` instead of copying the example name. For a plain table read, `GetTableContents` requires `table_name` and accepts `max_rows`; `RunQuery` requires `sql_query` and accepts `max_rows` or `all_rows`.

To read a class implementation, select `GetSource` and pass:

```json
{
  "object_type": "CLAS",
  "name": "ZCL_ORDER",
  "include": "implementations"
}
```

The MCP client discovers the schemas; callers do not need to memorize every argument. For example, `GetSource` requires `object_type` and `name`, while `GrepPackages` requires `packages` and `pattern`. Inspect the live schema before calling an unfamiliar tool.

### 🔍 Inspect installed servers and tools

| What to inspect | How |
| --- | --- |
| Add-on command options | `sap-ai-dev --help` |
| BAS destinations and probe status | `sap-ai-dev --list-destinations --json` (BAS only) |
| Destination availability only | `sap-ai-dev --check` |
| Generated server names and destination mapping | **MCP: Open User Configuration**; look for lowercase slug entries (for BAS, for example `demo-abap`; for local SAP GUI, system/client slugs such as `t4d-100`) whose `SAP_AI_DEV_TOOLKIT_DESTINATION` names the BAS destination or local SAP GUI system. |
| Running server | **MCP: List Servers**; select the server and choose **Start Server**. |
| Tools and exact schemas | Expand that server in the Chat tools picker. The MCP host requests `tools/list`, whose entries include `name`, `description`, and `inputSchema`; the agent should call those tools through chat, not reproduce the protocol in a terminal. |
| Runtime and tool-call logs | Select the MCP server in the Output view. Startup, call lifecycle, and child stderr logs are written to stderr; child MCP log notifications are forwarded to the client. Tool arguments and result contents are not logged. |
| Installed package version | `npm list --global sap-ai-dev-toolkit` |

If the server is running but an agent reports that SAP tools are unavailable, verify that the same chat is in Agent mode, the generated server is enabled in that chat's tools picker, and concrete names such as `s4h_get_system_info` are listed. All generated server and tool names are lowercase; a mixed-case entry such as `ActionS4D` is a pre-upgrade leftover that chat cannot bind — rerun setup or `--doctor` as described above to migrate it. Reselect the agent or start a new chat if the tool binding is stale, then inspect the MCP server's Output log for startup or `tools/list` errors. Do not try to work around a missing chat binding by starting the server or handcrafting JSON-RPC from the terminal.

After MCP initialization, the host internally sends a request like this; agents should not reproduce it in the terminal:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

The response contains a `tools` array. A `RunQuery` entry resembles this excerpt; the actual description may include more detail:

```json
{
  "name": "run_query",
  "description": "Execute an ABAP SQL query [destination: DEMO_ABAP]",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sql_query": { "type": "string" },
      "max_rows": { "type": "number" },
      "all_rows": { "type": "boolean" }
    },
    "required": ["sql_query"]
  }
}
```

`--list-destinations` reports discovery and probe status; it does not list the MCP tools. Use the MCP client tool picker or its `tools/list` inspection for that. stdout is reserved for MCP protocol messages while the server is running, so do not pipe the normal server command to a shell JSON formatter.

### 🔧 Environment variables

| Variable | Purpose |
| --- | --- |
| `H2O_URL` | BAS endpoint used to discover destinations. Required for BAS discovery. |
| `SAP_AI_DEV_TOOLKIT_DESTINATION` | Comma-separated destination allowlist for normal runtime discovery. Setup clears this temporarily so it can display all eligible systems. |
| `SAP_AI_DEV_TOOLKIT_MODE` | VSP child mode (`expert` by default; `focused` omits `ActivateMultiple`, `GetUserTransports`, and `GetTransportInfo`). The proxy exposes its curated tool subset and local workflow tools, including `LintABAP`. |
| `SAP_ALLOW_TRANSPORTABLE_EDITS` | Generated MCP entries set this to `true` to permit source edits in transportable packages; VSP safety checks and SAP authorizations still apply. |
| `SAP_AUTH_MODE=sso` | Local SAP GUI entry mode for Windows / smart card SSO. Runtime starts VSP with `SAP_SSO=true`, which signs in through Microsoft Edge and caches the session per system and client. Older `windows-sso`, `browser-saml`, and `saml-password` entries are treated as `sso`. |
| `SAP_SSO_FIRST_LOGIN` | Local SSO entries default to `window`: with no cached session, VSP opens the Edge sign-in window at once. Set `silent` to try a hidden browser first. |
| `SAP_SSO_SILENT_TIMEOUT` | How long a hidden SSO refresh may run before the Edge window opens, as a Go duration. Local SSO entries default to `15s`; VSP's own default is `45s`. |
| `SAP_BROWSER_EXEC` | Full path of the Chromium-based browser for SSO sign-in. It is tried first; the other browsers found on the machine remain fallbacks. |
| `SAP_TLS_SERVER_NAMES` / `SAP_AI_DEV_TOOLKIT_TLS_SERVER_NAMES` | Comma-separated local SAP GUI TLS self-healing names, normally auto-discovered during setup from the SAP HTTPS certificate when `SAP_URL` uses an IP address. Runtime tries them one by one while keeping certificate validation enabled. |
| `SAP_TLS_SERVER_NAME` / `SAP_AI_DEV_TOOLKIT_TLS_SERVER_NAME` | Single-name compatibility form of the local SAP GUI TLS self-healing override. Prefer the auto-discovered plural variable written by setup. |
| `SAP_TLS_CA_FILE` / `SAP_AI_DEV_TOOLKIT_TLS_CA_FILE` | Optional PEM CA bundle for the local TLS self-healing proxy when the SAP HTTPS certificate chains to a private CA that is not in the OS/Node trust store. Certificate verification remains enabled. |
| `SAP_AI_DEV_TOOLKIT_HTTP_PROXY` | Egress proxy for BAS discovery and probe traffic. Takes precedence over `HTTP_PROXY`/`http_proxy`; unset means the default BAS proxy for `.dest` hosts, empty means direct. |
| `SAP_AI_DEV_TOOLKIT_REQUEST_TIMEOUT_MS` | Per-request timeout for calls forwarded to a VSP child (default 600000 = 10 minutes; `0` disables). A stalled request fails with a timeout error; the child is left running. |
| `SAP_AI_DEV_MCP_CONFIG` | Explicit MCP configuration path; highest precedence. |
| `SAP_AI_DEV_TOOLKIT_MCP_CONFIG` | Branded compatibility alias for the MCP configuration path. |
| `BAS_VSP_MCP_CONFIG` | Backward-compatible alias for the MCP configuration path. |
| `SAP_AI_DEV_TOOLKIT_BINARY` | Trusted prebuilt VSP executable; skips binary provisioning. Legacy `BAS_VSP_BINARY` still works. |
| `SAP_AI_DEV_TOOLKIT_BINARY_URL` | Alternate VSP binary download URL (checksum-verified). Legacy `BAS_VSP_BINARY_URL` still works. |
| `SAP_AI_DEV_TOOLKIT_RELEASE_BASE_URL` | Override the base URL that VSP release binaries are downloaded from. |
| `SAP_AI_DEV_TOOLKIT_CACHE_DIR` | Binary cache directory. Legacy `BAS_VSP_CACHE_DIR` still works. |
| `SAP_AI_DEV_TOOLKIT_VERSION` | Written by setup into each destination entry: the toolkit version that configured it. An older `sap-ai-dev` started from that entry hands off to this version through `npx` (see Self-healing modes). |
| `BAS_CF_SPACE_GUID`, `BAS_CF_DESTINATION_INSTANCE_GUID`, `BAS_CF_DESTINATION_INSTANCE`, `BAS_CF_DESTINATION_KEY`, `BAS_CF_DESTINATION_NAME`, `BAS_CF_CONNECTIVITY_INSTANCE_GUID`, `BAS_CF_CONNECTIVITY_INSTANCE`, `BAS_CF_CONNECTIVITY_KEY` | Written into generated Cloud Foundry destination entries; they reference service instances and key **names** (never credentials). |
| `GO_BINARY` | Explicit Go executable for the repository-only `build:vsp` script; not used during installation. |
| `SAP_AI_DEV_TOOLKIT_SKIP_PROBE=true` | Skip destination probes; useful for controlled diagnostics or fixtures. |
| `HTTP_PROXY` / `HTTPS_PROXY` | BAS proxy settings used for destination-list requests, destination probing, and child processes. |
| `NO_PROXY` | Proxy bypass list for BAS destination-list requests; `.dest` hosts remain routed through the BAS proxy. |

#### Self-healing modes

VSP children connect to each configured destination URL directly. BAS destination authentication remains selected through VSP's `--proxy-auth` path; Cloud Foundry on-premise destinations continue through the separate Connectivity proxy.
Child crash recovery restarts a failed VSP child, re-initializes it, re-registers tools, and retries the interrupted `tools/call` once before surfacing an error. State-changing tools are not retried.
Stale launcher recovery: when an MCP entry starts a `sap-ai-dev` older than the `SAP_AI_DEV_TOOLKIT_VERSION` setup recorded in it (for example an outdated global install left on `PATH`), the launcher logs a warning and hands off to that version through `npx` on the same stdio, so the host never runs the stale launcher or VSP binary. A source checkout (`npm link`) always runs as-is.
Existing installs that still set the previous `BAS_VSP_*` environment variables remain supported. The setup wizard writes new MCP entries with the `SAP_AI_DEV_TOOLKIT_*` names.

#### Server logging

Every observable event — startup banner (version, PID, VSP binary), destination discovery, VSP session initialization, each JSON-RPC request with its id, every tool call with duration and outcome, self-healing restarts, and errors — is logged twice: to **stderr** with ISO timestamps (visible when the server runs in a terminal or in hosts that surface stderr), and to the host's **MCP server output channel** as standard `notifications/message` log notifications (VS Code/BAS and Claude Code render these under the server's output). Log notifications start at `info`; send `logging/setLevel` with `debug` (or higher) from the client to adjust what reaches the channel — stderr always receives everything. Credentials, cookies, and tokens are redacted.

<a id="troubleshooting"></a>

## 🩺 Troubleshooting

No systems on the list? Start at BAS's front door and check the destination names:

```sh
curl "$H2O_URL/api/listDestinations"
sap-ai-dev --list-destinations --json
```

Next, check that the backend answers at `/sap/bc/adt`.

Runtime diagnostics take the stderr lane. In the MCP server's Output view, check per-destination ADT probe status, VSP child stderr, and failed tool-call details; stdout is reserved for MCP protocol messages.

If `GetSystemInfo` or `RunQuery` reports a CSRF-token fetch failure, VSP tries `/sap/bc/adt/core/discovery` first and falls back to `/sap/bc/adt/discovery` when the core endpoint returns HTTP 404 or 5xx without a token. If both endpoints fail, the error includes their HTTP statuses; check BAS destination routing and the SAP ADT service. `GetInstalledComponents` is a separate GET request and a failure there is not evidence of a CSRF problem.

**`MCP config ... contains invalid JSON`** usually means one of three things, all healed automatically by setup: the file starts with a byte-order mark (Windows PowerShell `>` redirection, `Set-Content`, or Notepad's "UTF-8 with BOM" mode — invisible in editors and terminals), it contains comments or trailing commas (VS Code reads `mcp.json` as JSONC), or setup raced an editor save and read a torn file (retried once before healing). Unrecoverable content is backed up as `mcp.json.<kind>-<timestamp>.bak` and replaced; the backup path is printed in the setup warning. On older versions, re-save the file as UTF-8 without BOM (VS Code: "Change File Encoding → Save with Encoding → UTF-8") and rerun `sap-ai-dev --setup`.

If automatic Go or VSP provisioning fails, check network access and the package's supported platform. You can install Go manually or set `GO_BINARY` as an explicit fallback. A trusted prebuilt VSP can be supplied with `SAP_AI_DEV_TOOLKIT_BINARY`.

## 🧑‍💻 Development

Run the built-in Node.js test suite:

```sh
npm test
```

The package repository is [grknylmz/sap-ai-dev-toolkit](https://github.com/grknylmz/sap-ai-dev-toolkit).

## 🚀 Publishing to npm

The package publisher reads `NPM_PUBLISH_TOKEN` from the root `.env` file (already gitignored) or from the environment. Create `.env` with a publish-capable npm token:

```sh
NPM_PUBLISH_TOKEN=npm_...
```

- `npm run publish:npm` publishes the version already set in `package.json`.
- To publish a patch bump, run `npm run publish:npm -- --patch`; it updates `package.json` and `package-lock.json` before publishing. If publishing fails after the bump, retry without `--patch`.
- npm's `prepublishOnly` hook builds the pinned VSP binaries for all platforms (including the Go toolchain if missing) and refuses to ship a tarball whose `dist/checksums.txt` does not list all five assets; it guards `npm run publish:npm` and a plain `npm publish` alike. Pass `--skip-build` to republish an already-built `dist/` without rebuilding.
- Preview the package without publishing, changing its version, or building with `npm run publish:npm -- --dry-run`.
- GitHub Actions runs the test suite on pushes to `main` and pull requests. A push to `main` that changes the `package.json` version runs the same checks, builds the VSP binaries, publishes that version to npm, and creates a `v<version>` GitHub release with generated notes and the VSP binaries plus `checksums.txt` attached for the download fallback.
- The publish workflow uses the `NPM_PUBLISH_TOKEN` GitHub repository secret. Verify it with `gh secret list`; the token value is never stored in the repository.

The token is not printed or stored in the repository.

## 📄 Acknowledgements and licenses

The original SAP AI Development Toolkit code and project changes are copyright (c) 2026 Gurkan Yilmaz and released under the MIT License. Everyone may use, copy, modify, distribute, sublicense, and sell copies, provided the copyright and license notices are retained; the software is provided without warranty. See `LICENSE`. Bundled VSP and third-party components retain their own licenses and notices in `NOTICE` and `LICENSE-APACHE-2.0.txt`.

This add-on bundles patched binaries from Vibing Steampunk (VSP), created by Alice Vinogradova and contributors. The binaries are built from upstream commit `9886d27`; this repository's BAS proxy-auth patch is in `patches/vsp-bas-proxy-auth.patch`.

Thanks to the VSP maintainers for the ADT/MCP implementation.

VSP is MIT-licensed. It permits use, modification, redistribution, and sale, provided the copyright and license notice are retained. It is permissive, not copyleft, and disclaims warranty.

The upstream VSP NOTICE identifies `open-rfc-go` and `open-rfc` under Apache-2.0. Redistributors must include the license and preserve applicable notices. Apache-2.0's patent license terminates if a recipient initiates patent litigation alleging that the work infringes; it grants no general trademark rights.

This package includes the upstream VSP license and notices, plus the Apache-2.0 license text, in `LICENSE`, `NOTICE`, and `LICENSE-APACHE-2.0.txt`. The upstream notice records other Go-module licenses in VSP's `go.mod` and `go.sum`; this is not a full audit of every transitive dependency.

License sources:

- VSP `LICENSE`
- VSP `NOTICE`
- Apache License 2.0
