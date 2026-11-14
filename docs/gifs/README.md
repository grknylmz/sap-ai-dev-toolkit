# Demo recordings

Short recordings of SAP AI Dev Toolkit features. All were made against a live SAP S/4HANA 2023 system (SAP_BASIS 758), except `17-offline-playground` (no SAP system) and the unit-test run. Each recording comes as a GIF (960 px wide, for README files and chat) and as an MP4 in [`mp4/`](mp4/) (1440×1000, H.264). LinkedIn plays MP4 uploads inline; use the GIFs where video is not supported.

| # | Recording | What it shows | Suggested post text |
| --- | --- | --- | --- |
| 01 | [webgui-headless-logon](01-webgui-headless-logon.gif) | `webgui_open` signs a headless browser in to SAP GUI for HTML. SAP pre-ticks "Cancel all existing logons" on the Logon Status Check page; the server unticks it before continuing. | The AI agent signs in to SAP GUI for HTML without ending your other sessions. |
| 02 | [recipe-sm37-job-overview](02-recipe-sm37-job-overview.gif) | `sm37_jobs` recipe: background jobs of all users in a date window, returned as text lines with the total row count. | Ask "which jobs ran since yesterday?" and the agent reads SM37 for you. |
| 03 | [abap-list-paging](03-abap-list-paging.gif) | `webgui_table page=next/last` pages a 15,000-row ABAP list on the server. | Long SAP lists, paged by the agent. |
| 04 | [recipe-st22-short-dumps](04-recipe-st22-short-dumps.gif) | `st22_dumps` recipe: short dumps as ALV rows with DDIC column ids. | Dump triage starts with the agent reading ST22. |
| 05 | [recipe-su53-authorization-check](05-recipe-su53-authorization-check.gif) | `su53_auth_check` recipe: the last failed authorization checks. | "Why am I not authorized?" answered from SU53. |
| 06 | [recipe-se16n-table-display](06-recipe-se16n-table-display.gif) | `se16n_table` recipe on T000, with a screen check before every step. | Table display through SE16N when ADT data preview is not an option. |
| 07 | [recipe-al11-directories](07-recipe-al11-directories.gif) | `al11_directories` recipe: application server directories. | Server directories from AL11. |
| 08 | [recipe-sm12-lock-entries](08-recipe-sm12-lock-entries.gif) | `sm12_locks` recipe: current enqueue locks for one user. | Who is locking what, from SM12. |
| 09 | [generic-transaction-driving](09-generic-transaction-driving.gif) | No recipe: `webgui_start_transaction SE16`, `webgui_set_fields` by DDIC name, then F7 and F8. | Any display transaction, driven step by step. |
| 10 | [read-only-guard](10-read-only-guard.gif) | "Delete job", SE38 and `/11` (Save) are refused before anything reaches SAP. | Read-only by design: change actions are blocked. |
| 11 | [webgui-logoff](11-webgui-logoff.gif) | `webgui_close` logs off with `/nex`. | No SAP session is left behind. |
| 12 | [setup-webgui-wizard](12-setup-webgui-wizard.gif) | `sap-ai-dev --setup-webgui`: URL, client, mode, pairing token, extension folder, MCP entry, agents and skills. | One command to set it up. |
| 13 | [webgui-server-check](13-webgui-server-check.gif) | `sap-ai-webgui --version` and `--check`. | Inspect the effective settings. |
| 14 | [live-webgui-suite](14-live-webgui-suite.gif) | `npm run test:live:webgui`: all recipes, the guard, a screenshot and the logoff against the live system. | Verified end to end against S/4HANA 2023. |
| 15 | [live-adt-suite](15-live-adt-suite.gif) | `npm run test:live:s4h`: the curated ADT tool surface and read-only SAP calls. | The ABAP development tools, verified live. |
| 16 | [adt-tools-live-tour](16-adt-tools-live-tour.gif) | MCP calls against the live system: system info, object search, class source, an ABAP SQL query on T000, and local abaplint. | What the agent sees when it works with ABAP. |
| 17 | [offline-playground](17-offline-playground.gif) | `sap-ai-dev --demo`: search, source, ABAP Unit and ATC on sample objects without an SAP system. | Try the agents without an SAP system. |
| 18 | [cli-overview](18-cli-overview.gif) | `sap-ai-dev --help`: setup wizards for every companion. | One CLI for the whole SAP landscape. |
| 19 | [webgui-unit-tests](19-webgui-unit-tests.gif) | The native WebGUI server's unit tests: guard, screen model, recipes, config. | Guard rules are covered by unit tests. |
| 20 | [relay-extension-pairing](20-relay-extension-pairing.gif) | The SAP AI WebGUI Relay extension options page pairs with the local server using the token. | Pair your own Chrome once. |
| 21 | [relay-drives-your-chrome](21-relay-drives-your-chrome.gif) | Relay mode: the agent drives the WebGUI tab you are already signed in to; no SAP credentials reach the toolkit. | Your SSO session, your browser, read-only. |

## Re-recording

The sources are in [`source/`](source/). The browser recordings need `ffmpeg` with the `drawtext` filter (Homebrew `ffmpeg-full`); the terminal recordings need [`vhs`](https://github.com/charmbracelet/vhs).

```sh
export FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg SAP_URL=https://host:44300 SAP_CLIENT=100 SAP_USER=... SAP_PASSWORD=...
node docs/gifs/source/record-webgui.mjs            # 01-11, headless; pass names to record a subset
CHROME=/path/to/chrome-for-testing node docs/gifs/source/record-relay.mjs   # 20-21
for tape in docs/gifs/source/tapes/*.tape; do vhs "$tape"; done              # 12-19
```

The live tapes (14-16) load the SAP settings from `.env` in the repository root. The relay recording needs a Chromium build that still accepts `--load-extension` (Chrome for Testing or Chromium); it uses `SAP_USER`/`SAP_PASSWORD` only to sign in the stand-in browser, never the toolkit.
