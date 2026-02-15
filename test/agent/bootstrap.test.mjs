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

test('workspace bootstrap manager seeds first-run template and metadata files', async () => {
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

test('bootstrap requires explicit completion marker before it can complete', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();
    await workspaceManager.writeTextFile('IDENTITY.md', 'identity updated');
    await workspaceManager.writeTextFile('SOUL.md', 'soul updated');
    await workspaceManager.writeTextFile('USER.md', 'user updated');

    const noMarker = await bootstrap.maybeCompleteBootstrap();
    assert.equal(noMarker, false);
    assert.equal(await workspaceManager.exists('BOOTSTRAP.md'), true);

    await workspaceManager.writeTextFile('.bootstrap-complete', '{"status":"complete"}');
    const withMarker = await bootstrap.maybeCompleteBootstrap();
    assert.equal(withMarker, true);
    assert.equal(await workspaceManager.exists('BOOTSTRAP.md'), false);
  });
});

test('loadPromptContext exposes bootstrap layer while active and clears it after completion', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();

    const active = await bootstrap.loadPromptContext();
    assert.equal(active.bootstrapState.state, 'active');
    assert.match(active.layers.bootstrap, /Bootstrap mode active/i);

    await workspaceManager.writeTextFile('IDENTITY.md', 'identity updated');
    await workspaceManager.writeTextFile('SOUL.md', 'soul updated');
    await workspaceManager.writeTextFile('USER.md', 'user updated');
    await workspaceManager.writeTextFile('.bootstrap-complete', '{"status":"complete"}');

    const completed = await bootstrap.loadPromptContext();
    assert.equal(completed.bootstrapState.state, 'completed');
    assert.equal(completed.layers.bootstrap, '');
  });
});

test('bootstrap enters failed state when completion marker exists but required files are empty', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();
    await workspaceManager.writeTextFile('IDENTITY.md', '');
    await workspaceManager.writeTextFile('.bootstrap-complete', '{"status":"complete"}');

    const context = await bootstrap.loadPromptContext();
    assert.equal(context.bootstrapState.state, 'failed');
    assert.match(context.extraRules, /failed/i);
    assert.equal(await workspaceManager.exists('BOOTSTRAP.md'), true);
  });
});
