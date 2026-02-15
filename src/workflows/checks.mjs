import fs from 'node:fs/promises';

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
registerCheckType('file_exists', fileExistsCheck);
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

export { registerCheckType };
