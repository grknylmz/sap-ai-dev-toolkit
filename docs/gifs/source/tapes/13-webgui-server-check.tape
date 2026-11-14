Output docs/gifs/13-webgui-server-check.gif
Output docs/gifs/mp4/13-webgui-server-check.mp4
Set Shell "bash"
Set FontSize 17
Set Width 1400
Set Height 860
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 35ms
Hide
Type `export PS1='$ '; alias sap-ai-dev='node src/launcher.mjs'; alias sap-ai-webgui='node src/webgui-server.mjs'; clear` Enter
Type `export SAP_WEBGUI_URL=https://sap.example.com:44300 SAP_CLIENT=100 SAP_AI_DEV_TOOLKIT_WEBGUI_RELAY_TOKEN=$(openssl rand -hex 32); clear` Enter
Show
Type "sap-ai-webgui --version" Sleep 300ms Enter
Sleep 1.5s
Type "sap-ai-webgui --check" Sleep 300ms Enter
Sleep 6s
