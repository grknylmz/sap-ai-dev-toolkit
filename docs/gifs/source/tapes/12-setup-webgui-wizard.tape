Output docs/gifs/12-setup-webgui-wizard.gif
Output docs/gifs/mp4/12-setup-webgui-wizard.mp4
Set Shell "bash"
Set FontSize 17
Set Width 1400
Set Height 860
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 35ms
Hide
Type `export PS1='$ '; alias sap-ai-dev='node src/launcher.mjs'; alias sap-ai-webgui='node src/webgui-server.mjs'; clear` Enter
Type `rm -rf /tmp/you && mkdir /tmp/you && export HOME=/tmp/you; unset XDG_CONFIG_HOME; clear` Enter
Show
Type "sap-ai-dev --setup-webgui" Sleep 300ms Enter
Sleep 3s
Type "https://sap.example.com:44300" Sleep 600ms Enter
Sleep 1s
Type "100" Sleep 500ms Enter
Sleep 1s
Enter
Sleep 1.5s
Down Sleep 600ms Up Sleep 600ms Enter
Sleep 4s
Enter
Sleep 4s
