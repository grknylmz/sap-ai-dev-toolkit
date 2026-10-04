// Cross-platform runner for the live S4H suite: Windows cmd cannot parse the
// Unix `VAR=1 command` prefix used in npm scripts, so the flag is set here
// and the test runner is spawned directly.
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', '--test-force-exit', 'test/live-s4h.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, SAP_AI_DEV_LIVE_S4H: '1' }
});
process.exitCode = result.status ?? 1;
