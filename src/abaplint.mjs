import { Config, MemoryFile, Registry } from '@abaplint/core';

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

export async function runABAPLint(arguments_) {
  try {
    validateArguments(arguments_);
    const config = arguments_.config === undefined
      ? Config.getDefault()
      : new Config(JSON.stringify(arguments_.config));
    const files = arguments_.files.map(({ filename, source }) => new MemoryFile(filename, source));
    const registry = new Registry(config).addFiles(files);
    await registry.parseAsync();
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
    const report = {
      status: reportIssues.length === 0 ? 'clean' : 'issues',
      filesChecked: files.length,
      issueCount: reportIssues.length,
      errors: counts.Error,
      warnings: counts.Warning,
      infos: counts.Info,
      issues: reportIssues
    };
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(report) }] };
  } catch (error) {
    return errorResult(error);
  }
}
