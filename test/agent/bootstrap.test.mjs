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
    const workDir = path.join(root, 'project');
    const agentStateDir = path.join(workDir, '.ferretbot');
    await fs.mkdir(agentStateDir, { recursive: true });
    await run({ root, workDir, agentStateDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('bootstrap manager does not scaffold prompt files', async () => {
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = createWorkspaceManager({ baseDir: agentStateDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
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
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = {
      baseDir: agentStateDir,
    };
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    const context = await bootstrap.loadPromptContext();

    assert.equal(context.bootstrapState?.cacheHit, false);
    assert.equal(context.layers.bootstrap, '');
    assert.match(context.extraRules, new RegExp(`Working directory: ${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(context.extraRules, new RegExp(`Agent state directory: ${agentStateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(context.extraRules, /Project files are in the working directory/);
    assert.match(context.extraRules, /Agent instruction\/memory files are under the agent state directory/);
    assert.match(context.extraRules, /AGENTS\.md policy files are loaded into bootstrap context automatically/);
    assert.match(context.extraRules, /use the \.ferretbot\/ path prefix/);
    assert.match(context.extraRules, /Use \.ferretbot\/MEMORY\.md as the canonical long-term memory file/);
  });
});

test('loadPromptContext merges project and .ferretbot AGENTS and loads referenced files with cache reuse', async () => {
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = {
      baseDir: agentStateDir,
    };
    await fs.writeFile(path.join(workDir, 'AGENTS.md'), [
      '# Project policy',
      '- Use strict shell flags',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'AGENTS.md'), [
      '# State policy',
      'Read `.ferretbot/SOUL.md` and `.ferretbot/USER.md`.',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'SOUL.md'), 'Soul text v1', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'USER.md'), 'User text v1', 'utf8');

    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    const first = await bootstrap.loadPromptContext();
    assert.equal(first.bootstrapState?.cacheHit, false);
    assert.match(first.layers.bootstrap, /Project AGENTS\.md/);
    assert.match(first.layers.bootstrap, /\.ferretbot\/AGENTS\.md/);
    assert.match(first.layers.bootstrap, /Soul text v1/);
    assert.match(first.layers.bootstrap, /User text v1/);

    const second = await bootstrap.loadPromptContext();
    assert.equal(second.bootstrapState?.cacheHit, true);
    assert.equal(second.layers.bootstrap, first.layers.bootstrap);
  });
});

test('loadPromptContext invalidates cached includes when referenced files change', async () => {
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = {
      baseDir: agentStateDir,
    };
    await fs.writeFile(path.join(agentStateDir, 'AGENTS.md'), 'Read `.ferretbot/SOUL.md`.', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'SOUL.md'), 'Soul text v1', 'utf8');

    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    const first = await bootstrap.loadPromptContext();
    assert.equal(first.bootstrapState?.cacheHit, false);
    assert.match(first.layers.bootstrap, /Soul text v1/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(agentStateDir, 'SOUL.md'), 'Soul text v2', 'utf8');

    const second = await bootstrap.loadPromptContext();
    assert.equal(second.bootstrapState?.cacheHit, false);
    assert.match(second.layers.bootstrap, /Soul text v2/);
  });
});

test('loadPromptContext refreshes daily memory includes when day rolls over', async () => {
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = {
      baseDir: agentStateDir,
    };
    await fs.mkdir(path.join(agentStateDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(agentStateDir, 'AGENTS.md'), 'Read `.ferretbot/memory/YYYY-MM-DD.md`.', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'memory', '2026-02-17.md'), 'Yesterday memory', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'memory', '2026-02-18.md'), 'Today memory', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'memory', '2026-02-19.md'), 'Tomorrow memory', 'utf8');

    let nowValue = new Date('2026-02-18T08:00:00.000Z');
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
      now: () => nowValue,
    });

    const first = await bootstrap.loadPromptContext();
    assert.equal(first.bootstrapState?.cacheHit, false);
    assert.match(first.layers.bootstrap, /Today memory/);
    assert.match(first.layers.bootstrap, /Yesterday memory/);
    assert.doesNotMatch(first.layers.bootstrap, /Tomorrow memory/);

    nowValue = new Date('2026-02-19T08:00:00.000Z');
    const second = await bootstrap.loadPromptContext();
    assert.equal(second.bootstrapState?.cacheHit, false);
    assert.match(second.layers.bootstrap, /Today memory/);
    assert.match(second.layers.bootstrap, /Tomorrow memory/);
  });
});
