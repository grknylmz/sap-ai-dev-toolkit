Output docs/gifs/19-webgui-unit-tests.gif
Output docs/gifs/mp4/19-webgui-unit-tests.mp4
Set Shell "bash"
Set FontSize 17
Set Width 1400
Set Height 860
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 35ms
Hide
Type `export PS1='$ '; alias sap-ai-dev='node src/launcher.mjs'; alias sap-ai-webgui='node src/webgui-server.mjs'; clear` Enter
Show
Type `cargo test --manifest-path native/webgui/Cargo.toml 2>/dev/null | grep -E "^test |result"` Sleep 300ms Enter
Sleep 14s
