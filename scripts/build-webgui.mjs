// Cross-builds the native sap-ai-webgui MCP server (native/webgui) for every packaged platform.
import { runBuild } from './build-native.mjs';

runBuild({ crate: 'webgui', bin: 'sap-ai-webgui', versionEnv: 'SAP_AI_WEBGUI_BUILD_VERSION' });
