import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES, harnessById, harnessRoot } from './harnesses.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const MANIFEST_NAME = '.sap-ai-dev-toolkit-assets.json';
const LEGACY_MANIFEST_NAME = '.bas-mcp-addon-assets.json';

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function collectFiles(sourceRoot, targetPrefix, relativePath = '') {
  const files = [];
  const entries = await readdir(join(sourceRoot, relativePath), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childPath = join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(sourceRoot, targetPrefix, childPath));
    } else if (entry.isFile()) {
      files.push({ source: join(sourceRoot, childPath), target: join(targetPrefix, childPath) });
    }
  }
  return files;
}

async function readManagedFiles(path) {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest === null || typeof manifest !== 'object' || manifest.version !== 1 || manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) return {};
    return manifest.files;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function replaceFile(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function collectSourceFiles(root) {
  const sourceRoot = join(root, '.github');
  const files = [
    ...await collectFiles(join(sourceRoot, 'agents'), 'agents'),
    ...await collectFiles(join(sourceRoot, 'skills'), 'skills')
  ];
  if (!files.some(file => file.target === join('agents', 'abap-developer.agent.md'))) {
    throw new Error('Packaged ABAP Developer agent profile is missing');
  }
  if (!files.some(file => file.target.startsWith(`skills${sep}`) && file.target.endsWith('SKILL.md'))) {
    throw new Error('Packaged Agent Skills are missing');
  }
  return files;
}

async function planDestinations(harness, files) {
  const destinations = [];
  for (const file of files) {
    const raw = await readFile(file.source);
    if (!file.target.startsWith(`agents${sep}`)) {
      destinations.push({ target: file.target, content: raw, aliases: [] });
      continue;
    }
    if (!harness.supportsAgents) continue;
    const sourceName = basename(file.target);
    const fileName = harness.agentFileName ? harness.agentFileName(sourceName) : sourceName;
    const prefix = harness.agentTargetPrefix || 'agents';
    const target = join(prefix, fileName);
    const aliasCandidates = [
      file.target,
      join(prefix, sourceName),
      join('agents', fileName)
    ];
    const aliases = [...new Set(aliasCandidates.filter(alias => alias !== target))];
    const content = harness.agentDocument ? Buffer.from(harness.agentDocument(raw.toString('utf8')), 'utf8') : raw;
    destinations.push({ target, content, aliases });
  }
  return destinations;
}

async function reconcileRemovableFile({ targetRoot, target, contentHash, previousFiles }) {
  const path = join(targetRoot, target);
  let existing;
  try {
    existing = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
  const existingHash = digest(existing);
  if (previousFiles[target] === existingHash || existingHash === contentHash) {
    await rm(path, { force: true });
    return 'removed';
  }
  return 'conflict';
}

export async function installUserAssets({ harness, home = process.env.HOME || homedir(), root = packageRoot, env = process.env } = {}) {
  const destinations = await planDestinations(harness, await collectSourceFiles(root));
  const targetRoot = harnessRoot(harness, { home, env });
  const manifestPath = join(targetRoot, MANIFEST_NAME);
  const legacyManifestPath = join(targetRoot, LEGACY_MANIFEST_NAME);
  await mkdir(targetRoot, { recursive: true, mode: 0o755 });
  const legacyFiles = harness.legacyManifest ? await readManagedFiles(legacyManifestPath) : {};
  const currentFiles = await readManagedFiles(manifestPath);
  const previousFiles = { ...legacyFiles, ...currentFiles };
  const managedFiles = {};
  const activeTargets = new Set(destinations.flatMap(file => [file.target, ...file.aliases]));
  const conflicts = [];
  let installed = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;

  for (const file of destinations) {
    const destination = join(targetRoot, file.target);
    const contentHash = digest(file.content);
    for (const alias of file.aliases) {
      const status = await reconcileRemovableFile({ targetRoot, target: alias, contentHash, previousFiles });
      if (status === 'removed') removed += 1;
      if (status === 'conflict') conflicts.push(alias);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });

    let existing;
    try {
      existing = await readFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await writeFile(destination, file.content, { flag: 'wx', mode: 0o644 });
        managedFiles[file.target] = contentHash;
        installed += 1;
        continue;
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        existing = await readFile(destination);
      }
    }

    const existingHash = digest(existing);
    if (existingHash === contentHash) {
      managedFiles[file.target] = contentHash;
      unchanged += 1;
    } else if (previousFiles[file.target] === existingHash) {
      await replaceFile(destination, file.content);
      managedFiles[file.target] = contentHash;
      updated += 1;
    } else {
      conflicts.push(file.target);
    }
  }

  for (const target of Object.keys(previousFiles)) {
    if (activeTargets.has(target) || managedFiles[target]) continue;
    const status = await reconcileRemovableFile({ targetRoot, target, contentHash: '', previousFiles });
    if (status === 'removed') removed += 1;
    if (status === 'conflict') conflicts.push(target);
  }

  await replaceFile(manifestPath, `${JSON.stringify({ version: 1, files: managedFiles }, null, 2)}\n`);
  if (harness.legacyManifest) await rm(legacyManifestPath, { force: true });
  return { harness: harness.id, label: harness.label, root: targetRoot, installed, updated, unchanged, removed, conflicts };
}

export async function installUserAssetsForHarnesses(ids, { home, root = packageRoot, env = process.env } = {}) {
  const results = [];
  const failures = [];
  for (const id of ids) {
    try {
      results.push(await installUserAssets({ harness: harnessById(id), home, root, env }));
    } catch (error) {
      const entry = HARNESSES.find(harness => harness.id === id);
      failures.push({ id, label: entry ? entry.label : id, error });
    }
  }
  return { results, failures };
}
