import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { evaluateChecks, registerCheckType } from '../../src/workflows/checks.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-checks-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('contains check passes when output includes text', async () => {
  const result = await evaluateChecks(
    [{ type: 'contains', text: 'hello' }],
    { stepOutput: 'say hello world' },
  );
  assert.equal(result.passed, true);
  assert.equal(result.results[0].passed, true);
});

test('contains check fails when output lacks text', async () => {
  const result = await evaluateChecks(
    [{ type: 'contains', text: 'missing' }],
    { stepOutput: 'hello world' },
  );
  assert.equal(result.passed, false);
});

test('not_contains check passes when text is absent', async () => {
  const result = await evaluateChecks(
    [{ type: 'not_contains', text: 'error' }],
    { stepOutput: 'all good' },
  );
  assert.equal(result.passed, true);
});

test('not_contains check fails when text is present', async () => {
  const result = await evaluateChecks(
    [{ type: 'not_contains', text: 'error' }],
    { stepOutput: 'got an error' },
  );
  assert.equal(result.passed, false);
});

test('regex check passes on match', async () => {
  const result = await evaluateChecks(
    [{ type: 'regex', pattern: '\\d+ files' }],
    { stepOutput: '5 files processed' },
  );
  assert.equal(result.passed, true);
});

test('regex check fails on no match', async () => {
  const result = await evaluateChecks(
    [{ type: 'regex', pattern: '^SUCCESS$' }],
    { stepOutput: 'FAILURE' },
  );
  assert.equal(result.passed, false);
});

test('regex check handles invalid pattern gracefully', async () => {
  const result = await evaluateChecks(
    [{ type: 'regex', pattern: '[invalid' }],
    { stepOutput: 'anything' },
  );
  assert.equal(result.passed, false);
  assert.ok(result.results[0].message.includes('invalid regex'));
});

test('exit_code check matches expected code', async () => {
  const result = await evaluateChecks(
    [{ type: 'exit_code', expected: 0 }],
    { toolResults: [{ exitCode: 0 }] },
  );
  assert.equal(result.passed, true);
});

test('exit_code check fails on mismatch', async () => {
  const result = await evaluateChecks(
    [{ type: 'exit_code', expected: 0 }],
    { toolResults: [{ exitCode: 1 }] },
  );
  assert.equal(result.passed, false);
});

test('command_exit_code check matches expected code', async () => {
  const result = await evaluateChecks(
    [{ type: 'command_exit_code', expected: 0 }],
    { toolResults: [{ code: 0 }] },
  );
  assert.equal(result.passed, true);
});

test('file_exists check passes for existing file', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'output.txt');
    await fs.writeFile(filePath, 'data');

    const result = await evaluateChecks(
      [{ type: 'file_exists', path: filePath }],
      {},
    );
    assert.equal(result.passed, true);
  });
});

test('file_exists check fails for missing file', async () => {
  const result = await evaluateChecks(
    [{ type: 'file_exists', path: '/tmp/nonexistent-' + Date.now() }],
    {},
  );
  assert.equal(result.passed, false);
});

test('file_not_exists check passes for missing file', async () => {
  const result = await evaluateChecks(
    [{ type: 'file_not_exists', path: '/tmp/nonexistent-' + Date.now() }],
    {},
  );
  assert.equal(result.passed, true);
});

test('file_contains check validates file content', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'status.txt');
    await fs.writeFile(filePath, 'build SUCCESS');

    const result = await evaluateChecks(
      [{ type: 'file_contains', path: filePath, text: 'SUCCESS' }],
      {},
    );
    assert.equal(result.passed, true);
  });
});

test('file_regex check validates file content pattern', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'status.txt');
    await fs.writeFile(filePath, 'tests: 14 passed');

    const result = await evaluateChecks(
      [{ type: 'file_regex', path: filePath, pattern: '\\d+ passed' }],
      {},
    );
    assert.equal(result.passed, true);
  });
});

test('file_hash_changed check fails when hash is unchanged', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'artifact.txt');
    const content = 'same content';
    await fs.writeFile(filePath, content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    const result = await evaluateChecks(
      [{ type: 'file_hash_changed', path: filePath, previousHash: hash }],
      {},
    );
    assert.equal(result.passed, false);
  });
});

test('non_empty check passes for non-empty output', async () => {
  const result = await evaluateChecks(
    [{ type: 'non_empty' }],
    { stepOutput: 'data' },
  );
  assert.equal(result.passed, true);
});

test('non_empty check fails for empty output', async () => {
  const result = await evaluateChecks(
    [{ type: 'non_empty' }],
    { stepOutput: '' },
  );
  assert.equal(result.passed, false);
});

test('multiple checks require all to pass', async () => {
  const result = await evaluateChecks(
    [
      { type: 'contains', text: 'ok' },
      { type: 'non_empty' },
    ],
    { stepOutput: 'ok done' },
  );
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 2);
});

test('multiple checks fail if any fails', async () => {
  const result = await evaluateChecks(
    [
      { type: 'contains', text: 'ok' },
      { type: 'contains', text: 'missing' },
    ],
    { stepOutput: 'ok done' },
  );
  assert.equal(result.passed, false);
});

test('unknown check type returns error result', async () => {
  const result = await evaluateChecks(
    [{ type: 'nonexistent_type' }],
    { stepOutput: 'data' },
  );
  assert.equal(result.passed, false);
  assert.ok(result.results[0].message.includes('unknown check type'));
});

test('empty checks array passes', async () => {
  const result = await evaluateChecks([], {});
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 0);
});

test('registerCheckType adds custom check type', async () => {
  registerCheckType('always_pass', () => ({
    type: 'always_pass',
    passed: true,
    message: 'always passes.',
  }));

  const result = await evaluateChecks(
    [{ type: 'always_pass' }],
    {},
  );
  assert.equal(result.passed, true);
  assert.equal(result.results[0].type, 'always_pass');
});
