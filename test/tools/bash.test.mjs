import test from 'node:test';
import assert from 'node:assert/strict';

import { createBashTool } from '../../src/tools/bash.mjs';

test('bash tool executes command and captures stdout', async () => {
  const tool = createBashTool();
  const result = await tool.execute({ command: 'printf "ferret"' });

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ferret');
});

test('bash tool returns failure shape on non-zero exit', async () => {
  const tool = createBashTool();
  const result = await tool.execute({ command: 'sh -c "echo no >&2; exit 7"' });

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /no/);
});
