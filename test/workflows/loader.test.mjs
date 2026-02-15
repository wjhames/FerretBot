import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWorkflow, discoverWorkflows } from '../../src/workflows/loader.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-loader-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const VALID_YAML = `
id: test-flow
version: "1.0.0"
steps:
  - id: step-1
    instruction: Do something
    tools:
      - bash
`;

test('loads a valid workflow.yaml from a directory', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'workflow.yaml'), VALID_YAML);
    const workflow = await loadWorkflow(dir);
    assert.equal(workflow.id, 'test-flow');
    assert.equal(workflow.version, '1.0.0');
    assert.equal(workflow.steps.length, 1);
    assert.equal(workflow.dir, dir);
  });
});

test('throws when workflow.yaml is missing', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      loadWorkflow(dir),
      /workflow\.yaml not found/,
    );
  });
});

test('throws on invalid YAML content', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'workflow.yaml'), '{ invalid yaml: [}');
    await assert.rejects(
      loadWorkflow(dir),
      /invalid YAML/,
    );
  });
});

test('throws when schema validation fails', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'workflow.yaml'),
      'id: BAD_ID\nversion: "1"\nsteps:\n  - id: a\n    instruction: do it\n    tools: [bash]\n',
    );
    await assert.rejects(
      loadWorkflow(dir),
      /invalid workflow/,
    );
  });
});

test('discoverWorkflows finds directories with workflow.yaml', async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'flow-a'));
    await fs.writeFile(path.join(dir, 'flow-a', 'workflow.yaml'), VALID_YAML);
    await fs.mkdir(path.join(dir, 'flow-b'));
    await fs.writeFile(path.join(dir, 'flow-b', 'workflow.yaml'), VALID_YAML);
    await fs.mkdir(path.join(dir, 'no-workflow'));

    const dirs = await discoverWorkflows(dir);
    assert.equal(dirs.length, 2);
    assert.ok(dirs.includes(path.join(dir, 'flow-a')));
    assert.ok(dirs.includes(path.join(dir, 'flow-b')));
  });
});

test('discoverWorkflows returns empty array for missing base directory', async () => {
  const dirs = await discoverWorkflows('/tmp/nonexistent-' + Date.now());
  assert.deepEqual(dirs, []);
});
