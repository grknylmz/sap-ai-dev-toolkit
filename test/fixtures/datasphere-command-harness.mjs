// Exercise the actual terminal prompts and child-process boundary without a live tenant.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDatasphereCommand } from '../../src/datasphere-command.mjs';

const fakeCli = fileURLToPath(new URL('./fake-datasphere-command.mjs', import.meta.url));
try {
  process.exitCode = await runDatasphereCommand(process.argv.slice(2), {
    spawnImpl: (file, argv, options) => spawn(file, [fakeCli, ...argv.slice(1)], options),
    openUrl: url => process.stderr.write(`Browser opened: ${url}\n`)
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
