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

test('workspace bootstrap manager seeds first-run template files', async () => {
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
      'memory/2026-02-15.md',
      'memory/2026-02-14.md',
    ];

    for (const relativePath of required) {
      const exists = await workspaceManager.exists(relativePath);
      assert.equal(exists, true, `expected ${relativePath} to exist`);
    }
  });
});

test('bootstrap only completes after required identity files change from defaults', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();

    const firstTry = await bootstrap.maybeCompleteBootstrap();
    assert.equal(firstTry, false);
    assert.equal(await workspaceManager.exists('BOOTSTRAP.md'), true);

    await workspaceManager.writeTextFile('IDENTITY.md', '# IDENTITY\n\nName: FerretBot');
    await workspaceManager.writeTextFile('SOUL.md', '# SOUL.md\n\nValues: clarity');
    await workspaceManager.writeTextFile('USER.md', '# USER\n\nName: Operator');

    const secondTry = await bootstrap.maybeCompleteBootstrap();
    assert.equal(secondTry, true);
    assert.equal(await workspaceManager.exists('BOOTSTRAP.md'), false);
    assert.equal(await workspaceManager.exists('.bootstrap-complete'), true);
  });
});

test('loadPromptContext reports bootstrap mode only while BOOTSTRAP.md exists', async () => {
  await withTempWorkspace(async (baseDir) => {
    const workspaceManager = createWorkspaceManager({ baseDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      now: () => new Date('2026-02-15T12:00:00.000Z'),
    });

    await bootstrap.ensureInitialized();
    const initial = await bootstrap.loadPromptContext();
    assert.equal(initial.bootstrapActive, true);
    assert.match(initial.extraRules, /Bootstrap mode active/i);

    await workspaceManager.writeTextFile('IDENTITY.md', '# IDENTITY\n\nName: FerretBot');
    await workspaceManager.writeTextFile('SOUL.md', '# SOUL.md\n\nValues: clarity');
    await workspaceManager.writeTextFile('USER.md', '# USER\n\nName: Operator');

    const afterUpdate = await bootstrap.loadPromptContext();
    assert.equal(afterUpdate.bootstrapActive, false);
    assert.doesNotMatch(afterUpdate.extraRules, /Bootstrap mode active/i);
  });
});
