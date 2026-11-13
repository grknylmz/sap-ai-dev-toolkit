import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Merges sha256 entries for `assets` into dist/checksums.txt, keeping the
// entries other build scripts wrote (vsp and sap-ai-aem build separately).
export async function writeDistChecksums(dist, assets) {
  const path = join(dist, 'checksums.txt');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const replaced = new Set(assets);
  const lines = existing.split(/\r?\n/).map(line => line.trim()).filter(line => line && !replaced.has(line.split(/\s+/)[1]));
  for (const asset of assets) {
    const bytes = await readFile(join(dist, asset));
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${asset}`);
  }
  const name = line => line.split(/\s+/)[1] ?? '';
  lines.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  await writeFile(path, `${lines.join('\n')}\n`);
}
