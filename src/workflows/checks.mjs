import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const checkHandlers = new Map();

function registerCheckType(type, handler) {
  if (typeof type !== 'string' || !type.trim()) {
    throw new TypeError('check type must be a non-empty string.');
  }
  if (typeof handler !== 'function') {
    throw new TypeError('check handler must be a function.');
  }
  checkHandlers.set(type, handler);
}

function containsCheck(check, context) {
  const text = check.text ?? '';
  const passed = (context.stepOutput ?? '').includes(text);
  return {
    type: 'contains',
    passed,
    message: passed
      ? `output contains '${text}'.`
      : `output does not contain '${text}'.`,
  };
}

function notContainsCheck(check, context) {
  const text = check.text ?? '';
  const passed = !(context.stepOutput ?? '').includes(text);
  return {
    type: 'not_contains',
    passed,
    message: passed
      ? `output does not contain '${text}'.`
      : `output unexpectedly contains '${text}'.`,
  };
}

function regexCheck(check, context) {
  const pattern = check.pattern ?? '';
  let passed = false;
  try {
    passed = new RegExp(pattern).test(context.stepOutput ?? '');
  } catch {
    return { type: 'regex', passed: false, message: `invalid regex '${pattern}'.` };
  }
  return {
    type: 'regex',
    passed,
    message: passed
      ? `output matches /${pattern}/.`
      : `output does not match /${pattern}/.`,
  };
}

function exitCodeCheck(check, context) {
  const expected = check.expected ?? 0;
  const results = context.toolResults ?? [];
  const last = results.length > 0 ? results[results.length - 1] : null;
  const actual = last?.exitCode ?? last?.code ?? null;
  const passed = actual === expected;
  return {
    type: 'exit_code',
    passed,
    message: passed
      ? `exit code is ${expected}.`
      : `expected exit code ${expected}, got ${actual}.`,
  };
}

function commandExitCodeCheck(check, context) {
  return exitCodeCheck(check, context);
}

async function fileExistsCheck(check) {
  const filePath = check.path ?? '';
  let passed = false;
  try {
    await fs.access(filePath);
    passed = true;
  } catch {
    // file does not exist
  }
  return {
    type: 'file_exists',
    passed,
    message: passed
      ? `file '${filePath}' exists.`
      : `file '${filePath}' does not exist.`,
  };
}

async function fileNotExistsCheck(check) {
  const filePath = check.path ?? '';
  let exists = false;
  try {
    await fs.access(filePath);
    exists = true;
  } catch {
    exists = false;
  }
  return {
    type: 'file_not_exists',
    passed: !exists,
    message: !exists
      ? `file '${filePath}' does not exist.`
      : `file '${filePath}' exists.`,
  };
}

async function fileContainsCheck(check) {
  const filePath = check.path ?? '';
  const text = String(check.text ?? '');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      type: 'file_contains',
      passed: false,
      message: `file '${filePath}' could not be read.`,
    };
  }

  const passed = content.includes(text);
  return {
    type: 'file_contains',
    passed,
    message: passed
      ? `file '${filePath}' contains '${text}'.`
      : `file '${filePath}' does not contain '${text}'.`,
  };
}

async function fileRegexCheck(check) {
  const filePath = check.path ?? '';
  const pattern = check.pattern ?? '';
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      type: 'file_regex',
      passed: false,
      message: `file '${filePath}' could not be read.`,
    };
  }

  let passed = false;
  try {
    passed = new RegExp(pattern).test(content);
  } catch {
    return { type: 'file_regex', passed: false, message: `invalid regex '${pattern}'.` };
  }

  return {
    type: 'file_regex',
    passed,
    message: passed
      ? `file '${filePath}' matches /${pattern}/.`
      : `file '${filePath}' does not match /${pattern}/.`,
  };
}

async function fileHashChangedCheck(check, context) {
  const filePath = check.path ?? '';
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      type: 'file_hash_changed',
      passed: false,
      message: `file '${filePath}' could not be read.`,
    };
  }

  const currentHash = crypto.createHash('sha256').update(content).digest('hex');
  const previousHash = String(check.previousHash ?? context.previousHash ?? '').trim();
  const passed = previousHash.length > 0 && currentHash !== previousHash;
  return {
    type: 'file_hash_changed',
    passed,
    message: passed
      ? `file '${filePath}' hash changed.`
      : `file '${filePath}' hash did not change.`,
  };
}

function nonEmptyCheck(_check, context) {
  const passed = typeof context.stepOutput === 'string' && context.stepOutput.trim().length > 0;
  return {
    type: 'non_empty',
    passed,
    message: passed ? 'output is non-empty.' : 'output is empty.',
  };
}

registerCheckType('contains', containsCheck);
registerCheckType('not_contains', notContainsCheck);
registerCheckType('regex', regexCheck);
registerCheckType('exit_code', exitCodeCheck);
registerCheckType('command_exit_code', commandExitCodeCheck);
registerCheckType('file_exists', fileExistsCheck);
registerCheckType('file_not_exists', fileNotExistsCheck);
registerCheckType('file_contains', fileContainsCheck);
registerCheckType('file_regex', fileRegexCheck);
registerCheckType('file_hash_changed', fileHashChangedCheck);
registerCheckType('non_empty', nonEmptyCheck);

export async function evaluateChecks(checks, context = {}) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { passed: true, results: [] };
  }

  const results = [];
  for (const check of checks) {
    const handler = checkHandlers.get(check.type);
    if (!handler) {
      results.push({
        type: check.type ?? 'unknown',
        passed: false,
        message: `unknown check type '${check.type}'.`,
      });
      continue;
    }
    const result = await handler(check, context);
    results.push(result);
  }

  const passed = results.every((r) => r.passed);
  return { passed, results };
}

export function listCheckTypes() {
  return [...checkHandlers.keys()].sort();
}

export function hasCheckType(type) {
  return checkHandlers.has(type);
}

export { registerCheckType };
