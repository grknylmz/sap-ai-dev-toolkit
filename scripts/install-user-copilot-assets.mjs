import { homedir } from 'node:os';
import { installUserAssets } from '../src/install-user-assets.mjs';
import { harnessById } from '../src/harnesses.mjs';

export async function installUserCopilotAssets({ home = process.env.HOME || homedir(), root } = {}) {
  return installUserAssets({ harness: harnessById('github-copilot'), home, root });
}
