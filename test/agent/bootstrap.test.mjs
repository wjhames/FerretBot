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

test('bootstrap manager does not scaffold profile files', async () => {
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = createWorkspaceManager({ baseDir: agentStateDir });
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    await bootstrap.ensureInitialized();

    const agentsExists = await workspaceManager.exists('AGENTS.md');
    assert.equal(agentsExists, false, 'expected AGENTS.md to be absent');

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
      'Read `.ferretbot/PROFILE_A.md` and `.ferretbot/PROFILE_B.md`.',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'PROFILE_A.md'), 'Profile text a v1', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'PROFILE_B.md'), 'Profile text b v1', 'utf8');

    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    const first = await bootstrap.loadPromptContext();
    assert.equal(first.bootstrapState?.cacheHit, false);
    assert.match(first.layers.bootstrap, /Project AGENTS\.md/);
    assert.match(first.layers.bootstrap, /\.ferretbot\/AGENTS\.md/);
    assert.match(first.layers.bootstrap, /Profile text a v1/);
    assert.match(first.layers.bootstrap, /Profile text b v1/);

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
    await fs.writeFile(path.join(agentStateDir, 'AGENTS.md'), 'Read `.ferretbot/PROFILE_A.md`.', 'utf8');
    await fs.writeFile(path.join(agentStateDir, 'PROFILE_A.md'), 'Profile text a v1', 'utf8');

    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    const first = await bootstrap.loadPromptContext();
    assert.equal(first.bootstrapState?.cacheHit, false);
    assert.match(first.layers.bootstrap, /Profile text a v1/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(agentStateDir, 'PROFILE_A.md'), 'Profile text a v2', 'utf8');

    const second = await bootstrap.loadPromptContext();
    assert.equal(second.bootstrapState?.cacheHit, false);
    assert.match(second.layers.bootstrap, /Profile text a v2/);
  });
});

test('loadPromptContext treats YYYY-MM-DD include paths as literal and does not auto-expand dates', async () => {
  await withTempWorkspace(async ({ agentStateDir, workDir }) => {
    const workspaceManager = {
      baseDir: agentStateDir,
    };
    await fs.mkdir(path.join(agentStateDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(agentStateDir, 'AGENTS.md'), 'Read `.ferretbot/memory/YYYY-MM-DD.md`.', 'utf8');
    const bootstrap = createWorkspaceBootstrapManager({
      workspaceManager,
      workDir,
      agentStateDir,
    });

    const first = await bootstrap.loadPromptContext();
    assert.equal(first.bootstrapState?.cacheHit, false);
    assert.match(first.layers.bootstrap, /memory\/YYYY-MM-DD\.md/);
    assert.doesNotMatch(first.layers.bootstrap, /Included file/);
  });
});
