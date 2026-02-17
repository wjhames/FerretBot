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
      now: () => new Date('2026-02-15T12:00:00.000Z'),
      workDir: '/tmp/project-root',
      agentStateDir: baseDir,
    });

    await bootstrap.ensureInitialized();

    const expectedMissing = [
      'AGENTS.md',
      'BOOT.md',
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
      'MEMORY.md',
      'MEMORY.system.md',
      'memory/2026-02-15.md',
      'memory/2026-02-14.md',
    ];

    for (const relativePath of expectedMissing) {
      const exists = await workspaceManager.exists(relativePath);
      assert.equal(exists, false, `expected ${relativePath} to be absent`);
    }
  });
});

test('loadPromptContext reads existing local files only', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
      workDir: '/tmp/project-root',
      agentStateDir: baseDir,
    });

    await workspaceManager.writeTextFile('AGENTS.md', '# Agents');
    await workspaceManager.writeTextFile('BOOT.md', '# Boot');
    await workspaceManager.writeTextFile('IDENTITY.md', '# Identity');
    await workspaceManager.writeTextFile('SOUL.md', '# Soul');
    await workspaceManager.writeTextFile('USER.md', '# User');
    await workspaceManager.writeTextFile('MEMORY.md', '# Memory');
    await workspaceManager.writeTextFile('MEMORY.system.md', '# System Memory');
    await workspaceManager.writeTextFile('memory/2026-02-15.md', '# 2026-02-15\n\n- today');
    await workspaceManager.writeTextFile('memory/2026-02-14.md', '# 2026-02-14\n\n- yesterday');

    const context = await bootstrap.loadPromptContext();

    assert.match(context.layers.boot, /AGENTS\.md/);
    assert.match(context.layers.boot, /BOOT\.md/);
    assert.match(context.layers.identity, /# Identity/);
    assert.match(context.layers.soul, /# Soul/);
    assert.match(context.layers.user, /# User/);
    assert.match(context.layers.memory, /# Memory/);
    assert.match(context.layers.systemMemory, /# System Memory/);
    assert.match(context.layers.dailyMemory, /Yesterday memory/);
    assert.match(context.layers.dailyMemory, /Today memory/);
    assert.equal(context.layers.bootstrap, '');
    assert.match(context.extraRules, /Working directory: \/tmp\/project-root/);
    assert.match(context.extraRules, new RegExp(`Agent state directory: ${baseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(context.extraRules, /Project files are in the working directory/);
    assert.match(context.extraRules, /Agent instruction\/memory files are under the agent state directory/);
    assert.match(context.extraRules, /use the \.ferretbot\/ path prefix/);
  });
});
