Output docs/gifs/14-live-webgui-suite.gif
Output docs/gifs/mp4/14-live-webgui-suite.mp4
Set Shell "bash"
Set FontSize 17
Set Width 1400
Set Height 860
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 35ms
Hide
Type `export PS1='$ '; alias sap-ai-dev='node src/launcher.mjs'; alias sap-ai-webgui='node src/webgui-server.mjs'; clear` Enter
Type `set -a; . ./.env; set +a; export SAP_URL=https://196.218.200.67:44300 SAP_CLIENT=100 SAP_TLS_SERVER_NAMES=sap-s4h.erpserveraccess.com; clear` Enter
Show
Type "npm run test:live:webgui" Sleep 300ms Enter
Sleep 29s
