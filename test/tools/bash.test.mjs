import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBashTool } from '../../src/tools/bash.mjs';

test('BASH-01: safe command returns success with full output shape', async () => {
  const tool = createBashTool();
  const result = await tool.execute({ command: 'sh -c "echo out; echo err >&2"' });

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
});

test('BASH-02: non-zero exit returns failure and preserves output streams', async () => {
  const tool = createBashTool();
  const result = await tool.execute({ command: 'sh -c "echo so; echo se >&2; exit 7"' });

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /so/);
  assert.match(result.stderr, /se/);
});

test('BASH-03: timeout returns deterministic failure result', async () => {
  const tool = createBashTool();
  const result = await tool.execute({ command: 'sleep 1', timeoutMs: 25 });

  assert.equal(result.success, false);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /timed out/i);
  assert.equal(result.timedOut, true);
});

test('BASH-04: command runs in configured cwd', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferret-bash-'));
  const tempCwd = path.join(tempRoot, 'work');
  await fs.mkdir(tempCwd, { recursive: true });

  try {
    const tool = createBashTool({ cwd: tempCwd });
    const result = await tool.execute({ command: 'pwd' });

    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), tempCwd);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('BASH-05: blocked command returns explicit deterministic guardrail failure', async () => {
  const tool = createBashTool();
  const result = await tool.execute({ command: 'ls -R .' });

  assert.equal(result.success, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.blocked, true);
  assert.equal(result.errorCode, 'GUARDRAIL_BLOCKED_COMMAND');
  assert.match(result.stderr, /blocked command/i);
  assert.match(result.retryGuidance, /use a non-recursive listing/i);
});
