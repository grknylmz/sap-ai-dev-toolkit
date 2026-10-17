import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Config, MemoryFile, Registry } from '@abaplint/core';

const MAX_PROJECT_FILES = 20_000;
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_SOURCE_BYTES = 32 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', '.build', '.next', '.cache', 'coverage', 'dist', 'node_modules']);
const PROJECT_CONFIG_FILES = ['.abaplint.jsonc', 'abaplint.jsonc', '.abaplint.json', 'abaplint.json'];

export const ABAP_LINT_TOOL = {
  name: 'LintABAP',
  description: 'Run abaplint on caller-supplied source files in memory; does not read workspace files or call SAP.',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string', minLength: 1 },
            source: { type: 'string' }
          },
          required: ['filename', 'source'],
          additionalProperties: false
        }
      },
      config: { type: 'object' }
    },
    required: ['files'],
    additionalProperties: false
  }
};

export const ABAP_LINT_PROJECT_TOOL = {
  name: 'LintABAPProject',
  description: 'Run read-only abaplint checks over serialized ABAP objects under the configured workspace root. Loads the project config and local dependency folders when present; does not call SAP, write files, or activate ABAP.',
  inputSchema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Optional project subdirectory relative to the configured workspace root.' },
      config: { type: 'object', description: 'Optional abaplint config object that overrides project config discovery.' }
    },
    required: [],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`Unknown ${label} field: ${field}`);
  }
}

function validateArguments(arguments_) {
  if (!isObject(arguments_)) throw new Error('Arguments must be an object');
  rejectUnknownFields(arguments_, new Set(['files', 'config']), 'argument');
  if (!Array.isArray(arguments_.files) || arguments_.files.length === 0) {
    throw new Error('files must be a nonempty array');
  }
  for (const file of arguments_.files) {
    if (!isObject(file)) throw new Error('Each file must be an object');
    rejectUnknownFields(file, new Set(['filename', 'source']), 'file');
    if (typeof file.filename !== 'string' || typeof file.source !== 'string') {
      throw new Error('Each file must contain string filename and source fields');
    }
    const basename = file.filename.split(/[\\/]/).at(-1);
    if (!/^[^.]+\.[^.]+\.[^.]+$/.test(basename)) {
      throw new Error('Each filename must have an object.type.extension basename');
    }
  }
  if (arguments_.config !== undefined && !isObject(arguments_.config)) {
    throw new Error('config must be an object');
  }
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: error.message || String(error) }) }]
  };
}

function reportResult(report) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(report) }],
    structuredContent: report
  };
}

function lintReport(registry, filesChecked) {
  const issues = registry.findIssues();
  const counts = { Error: 0, Warning: 0, Info: 0 };
  const reportIssues = issues.map(issue => {
    counts[issue.getSeverity()] += 1;
    const start = issue.getStart();
    const end = issue.getEnd();
    return {
      filename: issue.getFilename(),
      rule: issue.getKey(),
      severity: issue.getSeverity(),
      message: issue.getMessage(),
      start: { line: start.getRow(), column: start.getCol() },
      end: { line: end.getRow(), column: end.getCol() }
    };
  });
  return {
    status: reportIssues.length === 0 ? 'clean' : 'issues',
    filesChecked,
    issueCount: reportIssues.length,
    errors: counts.Error,
    warnings: counts.Warning,
    infos: counts.Info,
    issues: reportIssues
  };
}

function pathIsWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function validateProjectArguments(arguments_) {
  if (!isObject(arguments_)) throw new Error('Arguments must be an object');
  rejectUnknownFields(arguments_, new Set(['directory', 'config']), 'argument');
  if (arguments_.directory !== undefined) {
    if (typeof arguments_.directory !== 'string' || arguments_.directory.includes('\0') ||
        isAbsolute(arguments_.directory) || /^[A-Za-z]:[\\/]/.test(arguments_.directory) ||
        arguments_.directory.split(/[\\/]+/).includes('..')) {
      throw new Error('directory must be a relative path inside the configured workspace root');
    }
  }
  if (arguments_.config !== undefined && !isObject(arguments_.config)) {
    throw new Error('config must be an object');
  }
}

async function loadProjectConfig(directory, override) {
  if (override !== undefined) return { config: new Config(JSON.stringify(override)), source: 'caller' };
  for (const filename of PROJECT_CONFIG_FILES) {
    const configPath = resolve(directory, filename);
    let info;
    try { info = await lstat(configPath); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${filename} must be a regular file inside the workspace`);
    try {
      return { config: new Config(await readFile(configPath, 'utf8')), source: filename };
    } catch (error) {
      throw new Error(`Could not load ${filename}: ${error.message || error}`);
    }
  }
  return { config: Config.getDefault(), source: 'default' };
}

function enableSyntaxRules(config) {
  const projectConfig = config.get();
  const rules = { ...(projectConfig.rules || {}) };
  const disabled = [];
  for (const rule of ['parser_error', 'check_syntax']) {
    if (rules[rule] === false) disabled.push(rule);
    else if (rules[rule] === undefined) rules[rule] = true;
  }
  return {
    config: new Config(JSON.stringify({ ...projectConfig, rules })),
    disabled
  };
}

async function dependencyRoots(config, projectRoot) {
  const declared = config.get()?.dependencies;
  if (!Array.isArray(declared)) return { roots: [], missing: [], count: 0 };
  const roots = [];
  const missing = [];
  for (const dependency of declared) {
    const folder = dependency?.folder;
    if (typeof folder !== 'string' || !folder.trim()) {
      missing.push(String(folder || '(unspecified folder)'));
      continue;
    }
    const relativeFolder = folder.replace(/^[\\/]+/, '');
    if (/^[A-Za-z]:[\\/]/.test(relativeFolder) || relativeFolder.split(/[\\/]+/).includes('..')) {
      throw new Error('Dependency folders must stay inside the configured project directory');
    }
    const candidate = resolve(projectRoot, relativeFolder || '.');
    if (!pathIsWithin(projectRoot, candidate)) throw new Error('Dependency folders must stay inside the configured project directory');
    let canonical;
    try { canonical = await realpath(candidate); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        missing.push(folder);
        continue;
      }
      throw error;
    }
    if (!pathIsWithin(projectRoot, canonical)) throw new Error('Dependency folders must stay inside the configured project directory');
    const info = await lstat(canonical);
    if (!info.isDirectory()) {
      missing.push(folder);
      continue;
    }
    roots.push(canonical);
  }
  return { roots, missing, count: declared.length };
}

async function collectProjectFiles(projectRoot, dependencies) {
  const sourceFiles = [];
  const dependencyFiles = [];
  const pending = [projectRoot];
  let totalBytes = 0;
  while (pending.length) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        const isDependencyPath = dependencies.some(root => pathIsWithin(absolutePath, root) || pathIsWithin(root, absolutePath));
        if (!IGNORED_DIRECTORIES.has(entry.name) || isDependencyPath) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const filename = relative(projectRoot, absolutePath).split(sep).join('/');
      const basename = filename.split('/').at(-1);
      const nameParts = basename.split('.');
      if (nameParts.length < 3 || !nameParts[0] || !nameParts[1]) continue;
      if (!new MemoryFile(filename, '').getObjectType()) continue;
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.size > MAX_PROJECT_FILE_BYTES) throw new Error(`ABAP file exceeds ${MAX_PROJECT_FILE_BYTES} bytes: ${filename}`);
      totalBytes += info.size;
      if (totalBytes > MAX_PROJECT_SOURCE_BYTES) throw new Error(`Workspace ABAP sources exceed ${MAX_PROJECT_SOURCE_BYTES} bytes`);
      const file = new MemoryFile(filename, await readFile(absolutePath, 'utf8'));
      const isDependency = dependencies.some(root => pathIsWithin(root, absolutePath));
      (isDependency ? dependencyFiles : sourceFiles).push(file);
      if (sourceFiles.length + dependencyFiles.length > MAX_PROJECT_FILES) {
        throw new Error(`Workspace contains more than ${MAX_PROJECT_FILES} ABAP files`);
      }
    }
  }
  return { sourceFiles, dependencyFiles };
}

export async function runABAPLint(arguments_) {
  try {
    validateArguments(arguments_);
    const config = arguments_.config === undefined
      ? Config.getDefault()
      : new Config(JSON.stringify(arguments_.config));
    const files = arguments_.files.map(({ filename, source }) => new MemoryFile(filename, source));
    const registry = new Registry(config).addFiles(files);
    await registry.parseAsync();
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(lintReport(registry, files.length)) }] };
  } catch (error) {
    return errorResult(error);
  }
}

export async function runABAPLintProject(arguments_, { workspaceRoot = process.cwd() } = {}) {
  try {
    validateProjectArguments(arguments_);
    const root = await realpath(workspaceRoot);
    const directory = resolve(root, arguments_.directory || '.');
    if (!pathIsWithin(root, directory)) throw new Error('directory must stay inside the configured workspace root');
    const projectRoot = await realpath(directory);
    if (!pathIsWithin(root, projectRoot)) throw new Error('directory must stay inside the configured workspace root');
    const projectInfo = await lstat(projectRoot);
    if (!projectInfo.isDirectory()) throw new Error('directory must identify a workspace directory');

    const { config: projectConfig, source: configSource } = await loadProjectConfig(projectRoot, arguments_.config);
    const { config, disabled: disabledSyntaxRules } = enableSyntaxRules(projectConfig);
    const dependencies = await dependencyRoots(config, projectRoot);
    const { sourceFiles, dependencyFiles } = await collectProjectFiles(projectRoot, dependencies.roots);
    const registry = new Registry(config);
    registry.addDependencies(dependencyFiles);
    registry.addFiles(sourceFiles);
    await registry.parseAsync();

    const report = lintReport(registry, sourceFiles.length);
    if (report.filesChecked === 0) report.status = 'no-abap-files';
    else if (report.status === 'clean' && (dependencies.missing.length || disabledSyntaxRules.length)) report.status = 'incomplete';
    return reportResult({
      ...report,
      scope: 'workspace-static',
      activation: 'not-performed',
      workspaceDirectory: arguments_.directory || '.',
      configSource,
      targetRelease: config.getVersion(),
      syntaxRules: { enabled: ['parser_error', 'check_syntax'].filter(rule => !disabledSyntaxRules.includes(rule)), disabled: disabledSyntaxRules },
      dependencies: {
        declared: dependencies.count,
        filesLoaded: dependencyFiles.length,
        missingFolders: dependencies.missing
      }
    });
  } catch (error) {
    return errorResult(error);
  }
}
