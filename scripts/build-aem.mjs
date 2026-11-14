// Cross-builds the native sap-ai-aem MCP server (native/aem) for every packaged platform.
import { runBuild } from './build-native.mjs';

runBuild({ crate: 'aem', bin: 'sap-ai-aem', versionEnv: 'SAP_AI_AEM_BUILD_VERSION' });
