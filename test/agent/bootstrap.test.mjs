import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createWorkspaceManager } from '../../src/memory/workspace.mjs';
import { createWorkspaceBootstrapManager } from '../../src/agent/bootstrap.mjs';

async function withTempWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-bootstrap-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('bootstrap manager does not scaffold prompt files', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir: '/tmp/project-root',
      agentStateDir: baseDir,
    });

    await bootstrap.ensureInitialized();

    const expectedMissing = [
      'AGENTS.md',
    ];

    for (const relativePath of expectedMissing) {
      const exists = await workspaceManager.exists(relativePath);
      assert.equal(exists, false, `expected ${relativePath} to be absent`);
    }
  });
});

test('loadPromptContext returns minimal startup rules without injecting prompt layers', async () => {
  await withTempWorkspace(async (baseDir) => {
    const readCalls = [];
    const workspaceManager = {
      baseDir,
      async readTextFile(relativePath) {
        readCalls.push(relativePath);
        return '';
      },
    };
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir: '/tmp/project-root',
      agentStateDir: baseDir,
    });

    const context = await bootstrap.loadPromptContext();

    assert.deepEqual(readCalls, []);
    assert.deepEqual(context.layers, {});
    assert.match(context.extraRules, /Working directory: \/tmp\/project-root/);
    assert.match(context.extraRules, new RegExp(`Agent state directory: ${baseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(context.extraRules, /Project files are in the working directory/);
    assert.match(context.extraRules, /Agent instruction\/memory files are under the agent state directory/);
    assert.match(context.extraRules, /At session start, read \.ferretbot\/AGENTS\.md and follow it/);
    assert.match(context.extraRules, /use the \.ferretbot\/ path prefix/);
    assert.match(context.extraRules, /Use \.ferretbot\/MEMORY\.md as the canonical long-term memory file/);
  });
});
