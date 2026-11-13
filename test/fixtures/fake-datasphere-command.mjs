import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.slice(0, 2).join(' ') === 'config passcode-url') {
  process.stdout.write('https://tenant.authentication.eu20.hana.ondemand.com/passcode\n');
} else {
  const optionsPath = argv[argv.indexOf('--options-file') + 1];
  const options = JSON.parse(readFileSync(optionsPath, 'utf8'));
  const marker = join(process.env.HOME, 'initialized');
  if (argv.slice(0, 3).join(' ') === 'config cache init') {
    if (options.passcode !== 'fixture-init-code') throw new Error('Expected a separate code for initialization');
    writeFileSync(marker, 'initialized');
    const cache = join(process.env.HOME, '.@sap', 'datasphere-cli', '.cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'discovery-fixture.json'), JSON.stringify({ paths: { '/views': { get: { operationId: 'objects views list' } } } }));
    writeFileSync(join(cache, 'discovery-metadata.json'), '{}');
  }
  else {
    if (options.passcode !== 'fixture-code_A-1') throw new Error('The initialization code must not be reused for a command');
    if (!existsSync(marker)) throw new Error('The native CLI catalog was not initialized');
    const result = { rows: [{ technicalName: 'V1' }], optionsPath, mode: statSync(optionsPath).mode & 0o777 };
    const output = argv.indexOf('--output');
    if (output >= 0) writeFileSync(argv[output + 1], JSON.stringify(result));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
