import { chmod, copyFile, link, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const isWindows = process.platform === 'win32';

// SAP GUI discovery scans machine-wide roots (ProgramData, Public, Windows,
// the SAP registry keys). Point every root at a scratch directory and disable
// the registry scan so a machine that really has SAP GUI installed cannot
// leak entries into tests that expect a clean slate.
export function isolatedWindowsEnv(directory) {
  return {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: join(directory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(directory, 'AppData', 'Local'),
    PROGRAMDATA: join(directory, 'ProgramData'),
    PUBLIC: join(directory, 'Public'),
    WINDIR: join(directory, 'Windows'),
    SystemRoot: join(directory, 'Windows'),
    ProgramFiles: join(directory, 'ProgramFiles'),
    'ProgramFiles(x86)': join(directory, 'ProgramFiles (x86)'),
    SAP_AI_DEV_TOOLKIT_DISABLE_SAP_GUI_REGISTRY: 'true'
  };
}

// Prepending a fake CLI directory must use the platform PATH separator.
export function pathEntry(binDirectory) {
  const separator = isWindows ? ';' : ':';
  return `${binDirectory}${separator}${process.env.PATH || ''}`;
}

// Writes a fake executable for `name` (e.g. the Cloud Foundry CLI) that runs
// `body` — a CommonJS snippet, no imports/exports — with process.argv holding
// the CLI arguments, exactly like a real spawned child.
//
// Unix writes a single shebang script. Windows cannot exec extensionless or
// script files from spawn (Node refuses to resolve .cmd/.bat without shell),
// so the fake is a copy of node.exe named `${name}.exe` whose behavior comes
// from a --require hook in NODE_OPTIONS. The hook stays inert in every other
// Node process (the basename guard) that inherits the same environment.
export async function writeFakeCli(binDirectory, name, body, env = null) {
  if (!isWindows) {
    const path = join(binDirectory, name);
    await writeFile(path, `#!/usr/bin/env node\n${body.trim()}\n`, { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  }
  const hookPath = join(binDirectory, `${name}-hook.cjs`);
  await writeFile(hookPath, [
    `// Test fake for "${name}". Runs only when this Node binary is invoked as ${name}.exe.`,
    `const pathModule = require('node:path');`,
    `if (pathModule.basename(process.execPath).toLowerCase() === '${name}.exe') {`,
    `  // Node treats the first CLI argument as the main script and resolves it`,
    `  // against the cwd. Rebuild process.argv the way a normal CLI child would`,
    `  // see it: the script slot becomes the original first argument and the`,
    `  // remaining arguments pass through verbatim.`,
    `  const originalArguments = process.argv.slice(2);`,
    `  const firstArgument = process.argv.length > 1 ? pathModule.basename(process.argv[1]) : undefined;`,
    `  process.argv = [process.argv[0], '${name}-fake-entry', ...(firstArgument === undefined ? [] : [firstArgument]), ...originalArguments];`,
    '  (function () {',
    body.trim(),
    '  })();',
    '  process.exit(process.exitCode || 0);',
    '}',
    ''
  ].join('\n'));
  const exePath = join(binDirectory, `${name}.exe`);
  try {
    await link(process.execPath, exePath);
  } catch {
    // Cross-volume or unsupported: fall back to a full copy.
    await copyFile(process.execPath, exePath);
  }
  if (env) {
    const addition = `--require ${hookPath}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${addition}` : addition;
  }
  return exePath;
}
