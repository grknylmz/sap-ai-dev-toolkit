---
description: Read SAP GUI for HTML (WebGUI) transactions read-only with the sap-ai-webgui MCP server when no ADT or companion tool covers the task: background jobs, short dumps, failed authorization checks, user display, lock entries, server directories, customizing display, through curated recipes or generic screen, field and table tools.
name: sap-webgui-fallback
---

# SAP GUI for HTML (WebGUI) fallback

## When to use

Use the `webgui_*` tools only when no ADT (vsp) or companion MCP tool covers the task:

- Display transactions without an ADT endpoint: background jobs (SM37), short dumps (ST22), the last failed authorization check (SU53), user master display (SU01D), lock entries (SM12), application server directories (AL11), customizing display (SPRO), and other display screens.
- A vsp tool answered that the operation has no endpoint, is unsupported, or is not implemented (the proxy appends a hint pointing here).
- The user explicitly asks for a transaction code.

## When not to use

- Source reading or editing, activation, ATC, ABAP Unit, transports: use the vsp tools.
- Bulk or filtered table reads: try vsp `run_query` or `get_table_contents` first; SE16N screens show only what is rendered.
- Missing objects or missing authorizations: WebGUI fails the same way.
- SAP BTP ABAP Environment (Steampunk): it has no SAP GUI for HTML; this server does not apply.

## Tool shortlist

Use the live MCP `tools/list` result as authoritative. The `sap-ai-webgui` server exposes:

- `webgui_connection_info` — configured URL, client, language, mode (relay or headless), relay pairing state.
- `webgui_open {mode?, url?, client?, language?}` — open or reuse a WebGUI session.
- `webgui_list_recipes` — curated read-only recipes: `sm37_jobs`, `st22_dumps`, `su53_auth_check`, `su01d_user`, `se16n_table`, `al11_directories`, `sm12_locks`.
- `webgui_run_recipe {name, params}` — run one recipe; every step checks the expected screen and stops with the current screen on a mismatch.
- `webgui_start_transaction {tcode, prefill?, okcode?}` — start a transaction, optionally prefilling first-screen fields by DDIC name.
- `webgui_screen {rows?}` — current screen: transaction, PROGRAM/DYNPRO, status, fields, buttons, tabs, tables.
- `webgui_set_fields {values}` — fill fields by ref (`f3`), SID, or DDIC name.
- `webgui_press {ref|fkey|okcode}` — press a button or tab, a function key, or an OK code.
- `webgui_table {ref, from?, count?, page?}` — read table rows; `page` scrolls long ABAP lists on the server.
- `webgui_screenshot {path?}` — capture the screen for the user.
- `webgui_close` — end the session.

## Workflow

1. Call `webgui_list_recipes`; when a recipe covers the task, use `webgui_run_recipe` and stop there.
2. Otherwise `webgui_start_transaction`, then loop `webgui_screen` → `webgui_set_fields` / `webgui_press` → read the returned screen, and `webgui_table` for lists. Refs (`f3`, `b7`, `t2`, `g1`) belong to the screen they came from; never guess them.
3. Always finish with `webgui_close`, also after errors.

## Safety

- The server is read-only: it refuses save, post, delete, change, release and execute-update actions, F11, and transactions that edit data or run arbitrary programs. Do not work around a refusal through other buttons, OK codes or transactions; report it and hand the change to the user or the matching ADT/companion tool.
- The guard matches English button texts; keep the logon language EN.
- The server never ticks "Cancel all existing logons" on the Logon Status Check page (it unticks it when SAP pre-ticks it); do not tick it yourself in the browser.
- Do not enter credentials into screens; logon comes from the server configuration (relay: the user's own Chrome session; headless: host environment or a one-time sign-in).
- Setup: `sap-ai-dev --setup-webgui`.
