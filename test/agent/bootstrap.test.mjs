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

test('workspace bootstrap manager seeds prompt files and memory files', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();

    const required = [
      'AGENTS.md',
      'AGENTS.template.md',
      'BOOT.md',
      'BOOTSTRAP.md',
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
      'MEMORY.md',
      'MEMORY.system.md',
      '.workspace-templates.json',
      '.bootstrap-state.json',
      'memory/2026-02-15.md',
      'memory/2026-02-14.md',
    ];

    for (const relativePath of required) {
      const exists = await workspaceManager.exists(relativePath);
      assert.equal(exists, true, `expected ${relativePath} to exist`);
    }
  });
});

test('bootstrap state transitions to completed only when marker exists and BOOTSTRAP is removed', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();

    const active = await bootstrap.getBootstrapState();
    assert.equal(active.state, 'active');
    await workspaceManager.writeTextFile('.bootstrap-complete', '{"status":"complete"}');
    const failed = await bootstrap.getBootstrapState();
    assert.equal(failed.state, 'failed');

    await workspaceManager.removePath('BOOTSTRAP.md');
    const completed = await bootstrap.getBootstrapState();
    assert.equal(completed.state, 'completed');
  });
});

test('loadPromptContext does not inject bootstrap orchestration text', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();

    const context = await bootstrap.loadPromptContext();
    assert.equal(context.layers.bootstrap, '');
    assert.equal(context.extraRules, '');
    assert.match(context.layers.soul, /Heart of Who You Are/);
  });
});
