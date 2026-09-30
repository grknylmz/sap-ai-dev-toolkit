<h1 align="center">🧭 SAP AI Development Toolkit</h1>

<p align="center">
  <strong>Build, test, and deliver ABAP with AI that understands your SAP landscape.</strong><br>
  Bring GitHub Copilot Chat into your development workflow with destination-aware SAP tools.<br>
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
  <img src="https://img.shields.io/badge/GitHub%20Copilot-Agent-000000?style=flat-square&logo=githubcopilot&logoColor=white" alt="GitHub Copilot Agent">
  <img src="https://img.shields.io/badge/MCP-enabled-7B61FF?style=flat-square" alt="MCP enabled">
  <img src="https://img.shields.io/badge/SAP%20ADT-connected-0A6ED1?style=flat-square&logo=sap&logoColor=white" alt="SAP ADT connected">
  <img src="https://img.shields.io/badge/ABAP-CDS%20%7C%20RAP-EA4AAA?style=flat-square" alt="ABAP CDS RAP">
</p>

<p align="center">
  <a href="#install"><strong>Get started →</strong></a> ·
  <a href="#copilot-agent">Meet the agents</a> ·
  <a href="#bas">Connect your SAP systems</a> ·
  <a href="#tools">Explore the tools</a>
</p>

## From a prompt to SAP-ready work

SAP AI Dev Toolkit connects GitHub Copilot Chat to the SAP development tools available for each selected destination. Agents can inspect ABAP and CDS, propose changes, run checks, and return the evidence—without losing sight of which SAP system each operation targets.

```mermaid
flowchart LR
  Dev[Developer] --> Chat[GitHub Copilot Chat]
  Chat -->|request and tool calls| Toolkit[SAP AI Dev Toolkit]
  Toolkit -->|destination-scoped MCP| VSP[VSP and BAS destination]
  VSP -->|SAP ADT| SAP[SAP system]
  SAP -->|results and diagnostics| Toolkit
  Toolkit --> Chat
```

<p align="center"><strong>Explore → Build → Verify → Prepare for delivery</strong></p>

## ⚡ Quick start

```sh
npm install --global sap-ai-dev-toolkit
sap-ai-dev --setup
```

To also add optional full-stack SAP companion MCP servers for Fiori, UI5, CAP, and browser validation, run:

```sh
sap-ai-dev --setup --tools
```

Then connect a destination in SAP Business Application Studio:

1. Open the Command Palette.
2. Run **MCP: List Servers**.
3. Start the server named after your selected BAS destination (the lowercase slug, for example `demo-abap` for destination `DEMO_ABAP`).
4. In GitHub Copilot Chat, choose the best-fit bundled agent from the agent picker: **SAP Solution Architect**, **ABAP Developer**, **ABAP Runtime Debugger**, **RAP Service Developer**, or **HANA Cloud/HDI Specialist**.
5. In the Chat tools picker, enable the server for that BAS destination.
6. Ask Copilot to inspect, build, test, or verify something in your SAP landscape.

Use the attached destination-prefixed tools directly in chat. Do not launch `sap-ai-dev` or handcraft MCP JSON-RPC in a terminal to discover or call them.

**Prerequisite:** Node.js 20 or newer. The pinned VSP runtime ships with the package; no Go toolchain is installed or required.

## 🤖 Available agents and skills

**Agents:** Five user-invocable custom agents are included. Select the best fit from the agent picker in GitHub Copilot Chat, as shown in Quick start.

| | Agent | Best for |
| --- | --- | --- |
| 🧭 | **SAP Solution Architect** | System investigation, SAP standard/API recommendations, Clean Core and side-by-side design, and SDLC orchestration through implementation handoffs and validation gates |
| 🧑‍💻 | **ABAP Developer** | General ABAP, CDS, and RAP implementation, validation, and transport-preparation tasks |
| 🐞 | **ABAP Runtime Debugger** | Runtime incidents, application logs, debugger sessions, and performance symptoms; call relationships are derived from source inspection |
| 🚀 | **RAP Service Developer** | RAP business objects, behavior implementations, projections, service definitions, service bindings, and OData validation |
| 🗃️ | **HANA Cloud/HDI Specialist** | Read-only HANA Cloud container inspection, CAP/HDI artifact generation, local validation, and user-run deployment handoffs |

**Included skills:** `abap-development` · `abap-testing-quality` · `cds-development` · `rap-development` · `abap-debugging` · `abap-runtime-analysis` · `rap-service-delivery` · `sap-standard-api-analysis` · `clean-core-extensibility` · `sap-sdlc-orchestration` · `sap-transport-release` · `hana-cloud-inspection` · `hana-cloud-native-development` · `hana-cloud-validation`

Agents and skills install for the harnesses you pick during global installation: a multi-select offers GitHub Copilot and Claude Code pre-checked, plus OpenAI Codex, Cursor, Gemini CLI, and opencode. In non-interactive installs they are installed for GitHub Copilot only. Repository-scoped installation instructions appear below.

## ✨ Your SAP development cockpit, inside Copilot Chat

`sap-ai-dev-toolkit` installs `sap-ai-dev`, discovers your BAS destinations, and exposes a curated SAP development toolset through MCP. Instead of manually switching between chat, terminal commands, repository searches, ADT screens, and SAP checks, describe the outcome you want and let the appropriate bundled agent coordinate the available tools.

<p align="center"><strong>💬 Request → 🔎 Inspect → 🧠 Reason → 🧑‍💻 Implement → 🧪 Verify → 📋 Report</strong></p>

The workflow covers ABAP, CDS, RAP, repository analysis, table and query access, testing, ATC, application logs, transports, and controlled source changes. The live MCP tool list remains the source of truth for what your connected SAP system and active VSP mode expose.

## 🌟 Feature highlights

| | Feature | What it gives you |
| --- | --- | --- |
| 🤖 | **AI-driven ABAP development** | Describe the outcome; a task-fit agent coordinates inspection, implementation, validation, and a clear report. |
| 🧭 | **Destination-aware by design** | Discover BAS destinations and connect each MCP server to one selected SAP system. |
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

The package ships with five custom agents plus fourteen task-focused Copilot Agent Skills:

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

Once the destination server is enabled in Copilot Chat, ask for outcomes instead of manually orchestrating individual SAP operations:

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
| 🔑 **No credentials in `mcp.json`** | Authentication material stays in BAS destination configuration rather than MCP config. |

<a id="install"></a>

## 📦 Installation

Install globally from a BAS dev space:

```sh
npm install --global sap-ai-dev-toolkit
```

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

- Uses the package's bundled patched VSP binary for the current platform, verified against the npm-published `dist/checksums.txt`. A checksum-anchored remote download is the fallback only when the package has no bundled asset.
- No Go toolchain is downloaded or required at install time; Go is only used by the repository's own `build:vsp` development script.

With `H2O_URL` set, an interactive install opens a checkbox picker with no destinations selected by default. Use **Space** to choose destinations and **Enter** to confirm. Press **a** to toggle all destinations (select all if any are unchecked; otherwise clear the selection). Confirming with none selected removes this add-on's managed MCP entries. When the `cf` CLI 8.18 or newer is authenticated to a targeted space, setup first offers an optional import from that space's Destination service; type **y** then **Enter** to include it, or press **Enter** to skip. Accepted CF and BAS destinations appear together in the picker. npm may run its install hook without an interactive terminal, even when the shell is interactive; in that case, selection is skipped without changing MCP config.


The same postinstall offers the bundled agents and skills for several AI coding harnesses in a checkbox picker. **GitHub Copilot** and **Claude Code** start pre-checked, so pressing **Enter** alone installs both; **Space** selects or deselects a harness, **a** toggles all six, and confirming with none selected skips the step without changing files. With no interactive terminal, the assets are installed for GitHub Copilot only; set `SAP_AI_DEV_TOOLKIT_HARNESSES` to a comma-separated list of harness ids (`github-copilot`, `claude-code`, `codex`, `cursor`, `gemini-cli`, `opencode`) to choose non-interactively.

Some current npm versions also require install hooks to be approved. If npm reports that `sap-ai-dev-toolkit`'s `postinstall` was blocked, allow it during a fresh install with `npm install --global --allow-scripts=sap-ai-dev-toolkit sap-ai-dev-toolkit`, or run `sap-ai-dev --setup` from an interactive BAS terminal after installation.

The setup report uses icons and terminal colors; set `NO_COLOR=1` to disable ANSI colors. The table is a weather report, not a bouncer: green **PASS** means the ADT probe responded, red **FAIL** means it failed, and yellow **SKIPPED** means it was skipped. Probe failures do not block MCP registration or startup for destinations you select.

Run `sap-ai-dev --setup` later to change the destination selection or remove generated destination entries. Run `sap-ai-dev --setup --tools` to also choose optional companion tools. Use `--npx` to make generated BAS/VSP destination entries start the pinned package through npm instead of relying on a global `sap-ai-dev` command; companion tools already use `npx` with their own npm packages.

If a setup step is skipped or fails, rerun it from an interactive BAS terminal:

```sh
sap-ai-dev --setup
```

To configure without a global install, run the guided setup directly through npm:

```sh
npx --yes --ignore-scripts --package=sap-ai-dev-toolkit sap-ai-dev --setup --npx
```

This lists discovered systems in the same checkbox picker, with nothing selected by default. Use **Space** to choose destinations, **Enter** to confirm, and **a** to toggle all (select all if any are unchecked; otherwise clear the selection). It writes MCP entries that launch the selected servers through npx. The entries pin the package version used during setup, and `--ignore-scripts` avoids running the install-time wizard a second time. After setup, in BAS run **MCP: List Servers**, select each chosen destination, and choose **Start Server**.

For a non-interactive installation or a platform without a published VSP asset, provide a trusted binary override:

```sh
SAP_AI_DEV_TOOLKIT_BINARY=/path/to/vsp npm install --global sap-ai-dev-toolkit
```

At the end of a global install, the color-coded summary shows the MCP config path, each generated entry name, destination/client/authentication, launch command, and environment key names (not values). The installer does not open an editor automatically; in BAS/VS Code:

1. Open the Command Palette.
2. Run **MCP: List Servers**.
3. Select the generated server name shown in the report and choose **Start Server**.
4. Use **MCP: Open User Configuration** to inspect or edit the generated entries. Each entry is isolated to its destination.

<a id="copilot-agent"></a>

## 🤖 GitHub Copilot ABAP agents and skills

The package includes five user-invocable custom agents (**SAP Solution Architect**, **ABAP Developer**, **ABAP Runtime Debugger**, **RAP Service Developer**, and **HANA Cloud/HDI Specialist**) and fourteen task-focused Agent Skills for GitHub Copilot in BAS.

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

### 📥 Install for your BAS user

After destination setup, the installer prints a 🤖 notice and a checkbox picker asking which AI coding harnesses should receive the bundled agents and skills. **Space** selects or deselects, **a** toggles all, **Enter** confirms. **GitHub Copilot** and **Claude Code** are pre-checked, so pressing **Enter** without changes installs both; confirming with none selected skips the step and leaves your files unchanged.

| Harness | Skills land in | Agents land in |
| --- | --- | --- |
| GitHub Copilot | `$HOME/.copilot/skills/` | `$HOME/.copilot/agents/*.agent.md` |
| Claude Code | `$HOME/.claude/skills/` | `$HOME/.claude/agents/<id>.md` (frontmatter reduced to `name` and `description`) |
| OpenAI Codex | `$HOME/.agents/skills/` | — |
| Cursor | `$HOME/.cursor/skills/` | — |
| Gemini CLI | `$HOME/.gemini/skills/` | — |
| opencode | `$XDG_CONFIG_HOME/opencode/skills/` (default `$HOME/.config/opencode/skills/`) | `$XDG_CONFIG_HOME/opencode/agents/<id>.md` (as subagents) |

All 14 skills use the portable `SKILL.md` format and are installed verbatim. The 5 agents use Copilot's `.agent.md` format, so they are only installed for harnesses with a custom-agent mechanism (GitHub Copilot, Claude Code, opencode), with frontmatter adapted where needed. Selecting several harnesses duplicates the small markdown payloads on disk.

These user-level customizations are available across workspaces opened by the same BAS user in the same dev space. The harness must be available in BAS and may need a window reload to discover new files. A non-interactive install skips the picker and installs for GitHub Copilot only; override with `SAP_AI_DEV_TOOLKIT_HARNESSES` (comma-separated harness ids). `npm install --ignore-scripts` skips the postinstall wizard entirely.

On reinstall or package upgrade, unchanged add-on-managed files are updated per harness. Existing customizations and files edited since the previous install are preserved; postinstall reports paths that need manual review instead of overwriting them.

### 🗂️ Add the agents and skills to a repository

To commit repository-scoped customizations, copy the packaged files from the BAS workspace root without overwriting existing files:

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

Interactive npm install and `sap-ai-dev --setup` both use a checkbox picker with no destinations selected by default. Use **Space** to choose destinations, **Enter** to confirm, and **a** to toggle all (select all if any are unchecked; otherwise clear the selection). Confirming with none checked removes this package's generated MCP entries. Non-interactive installs skip destination selection without changing MCP config. Run the interactive setup command above; add `--npx` when the package is not installed globally.

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

The proxy exposes a curated subset of VSP tools, plus local `LintABAP`, destination-scoped workflow tools, and the convenience `GetApplicationLog` mapping when the VSP SAP router is available. Hidden VSP tools remain available only behind local workflow chaining where required; they are not advertised or directly callable through the proxy. Direct VSP invocation remains unchanged.

Without `H2O_URL`, the command passes arguments directly to the installed VSP binary—no BAS proxy detour.

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

The proxy intentionally does not expose the full child VSP process. Object deletion, broad trace surfaces, arbitrary SAP router/RFC calls, debugger helper/delete-breakpoint routes, and transport release/delete tools are hidden from direct MCP calls. The curated debugger tools (`SetBreakpoint`, `GetBreakpoints`, `DebuggerAttach`, `DebuggerGetStack`, `DebuggerGetVariables`, `DebuggerStep`, and `DebuggerDetach`) remain available when VSP and the target system expose them. Direct VSP invocation without `H2O_URL` retains the VSP binary's own tool surface.

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
| BAS destinations and probe status | `sap-ai-dev --list-destinations --json` |
| Destination availability only | `sap-ai-dev --check` |
| Generated server names and destination mapping | **MCP: Open User Configuration**; look for lowercase slug entries (for example `demo-abap`) whose `SAP_AI_DEV_TOOLKIT_DESTINATION` names the BAS destination. |
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
| `SAP_AI_DEV_TOOLKIT_HTTP_PROXY` | Egress proxy for BAS discovery and probe traffic. Takes precedence over `HTTP_PROXY`/`http_proxy`; unset means the default BAS proxy for `.dest` hosts, empty means direct. |
| `SAP_AI_DEV_TOOLKIT_REQUEST_TIMEOUT_MS` | Per-request timeout for calls forwarded to a VSP child (default 600000 = 10 minutes; `0` disables). A stalled request fails with a timeout error; the child is left running. |
| `SAP_AI_DEV_MCP_CONFIG` | Explicit MCP configuration path; highest precedence. |
| `SAP_AI_DEV_TOOLKIT_MCP_CONFIG` | Branded compatibility alias for the MCP configuration path. |
| `BAS_VSP_MCP_CONFIG` | Backward-compatible alias for the MCP configuration path. |
| `SAP_AI_DEV_TOOLKIT_BINARY` | Trusted prebuilt VSP executable; skips binary provisioning. Legacy `BAS_VSP_BINARY` still works. |
| `SAP_AI_DEV_TOOLKIT_BINARY_URL` | Alternate VSP binary download URL (checksum-verified). Legacy `BAS_VSP_BINARY_URL` still works. |
| `SAP_AI_DEV_TOOLKIT_RELEASE_BASE_URL` | Override the base URL that VSP release binaries are downloaded from. |
| `SAP_AI_DEV_TOOLKIT_CACHE_DIR` | Binary cache directory. Legacy `BAS_VSP_CACHE_DIR` still works. |
| `BAS_CF_SPACE_GUID`, `BAS_CF_DESTINATION_INSTANCE_GUID`, `BAS_CF_DESTINATION_INSTANCE`, `BAS_CF_DESTINATION_KEY`, `BAS_CF_DESTINATION_NAME`, `BAS_CF_CONNECTIVITY_INSTANCE_GUID`, `BAS_CF_CONNECTIVITY_INSTANCE`, `BAS_CF_CONNECTIVITY_KEY` | Written into generated Cloud Foundry destination entries; they reference service instances and key **names** (never credentials). |
| `GO_BINARY` | Explicit Go executable for the repository-only `build:vsp` script; not used during installation. |
| `SAP_AI_DEV_TOOLKIT_SKIP_PROBE=true` | Skip destination probes; useful for controlled diagnostics or fixtures. |
| `HTTP_PROXY` / `HTTPS_PROXY` | BAS proxy settings used for destination-list requests, destination probing, and child processes. |
| `NO_PROXY` | Proxy bypass list for BAS destination-list requests; `.dest` hosts remain routed through the BAS proxy. |

#### Self-healing modes

VSP children connect to each configured destination URL directly. BAS destination authentication remains selected through VSP's `--proxy-auth` path; Cloud Foundry on-premise destinations continue through the separate Connectivity proxy.
Child crash recovery restarts a failed VSP child, re-initializes it, re-registers tools, and retries the interrupted `tools/call` once before surfacing an error. State-changing tools are not retried.
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
