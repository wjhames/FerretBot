import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowRegistry, createWorkflowRegistry } from '../../src/workflows/registry.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-registry-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeWorkflow(overrides = {}) {
  return {
    id: 'test-flow',
    version: '1.0.0',
    name: 'Test Flow',
    description: 'A test workflow',
    inputs: [],
    steps: [{ id: 'step-1', name: 'step-1', instruction: 'Do it', tools: ['bash'], loadSkills: [], dependsOn: [], successChecks: [], timeout: null, retries: 0, approval: false, condition: null }],
    ...overrides,
  };
}

test('register and retrieve a workflow by id', () => {
  const registry = new WorkflowRegistry();
  const wf = makeWorkflow();
  registry.register(wf);

  assert.equal(registry.has('test-flow'), true);
  assert.equal(registry.get('test-flow').id, 'test-flow');
});

test('get returns null for unknown id', () => {
  const registry = new WorkflowRegistry();
  assert.equal(registry.get('unknown'), null);
  assert.equal(registry.has('unknown'), false);
});

test('register multiple versions and retrieve by version', () => {
  const registry = new WorkflowRegistry();
  registry.register(makeWorkflow({ version: '1.0.0' }));
  registry.register(makeWorkflow({ version: '2.0.0' }));

  assert.equal(registry.get('test-flow', '1.0.0').version, '1.0.0');
  assert.equal(registry.get('test-flow', '2.0.0').version, '2.0.0');
  assert.equal(registry.get('test-flow', '3.0.0'), null);
});

test('get without version returns latest registered', () => {
  const registry = new WorkflowRegistry();
  registry.register(makeWorkflow({ version: '1.0.0' }));
  registry.register(makeWorkflow({ version: '2.0.0' }));

  assert.equal(registry.get('test-flow').version, '2.0.0');
});

test('list returns summaries of all registered workflows', () => {
  const registry = new WorkflowRegistry();
  registry.register(makeWorkflow({ id: 'flow-a', version: '1.0.0', name: 'Flow A' }));
  registry.register(makeWorkflow({ id: 'flow-b', version: '1.0.0', name: 'Flow B' }));

  const listed = registry.list();
  assert.equal(listed.length, 2);
  assert.ok(listed.some((w) => w.id === 'flow-a'));
  assert.ok(listed.some((w) => w.id === 'flow-b'));
  assert.ok(!listed[0].steps);
});

test('duplicate id+version registration throws', () => {
  const registry = new WorkflowRegistry();
  registry.register(makeWorkflow());

  assert.throws(
    () => registry.register(makeWorkflow()),
    /already registered/,
  );
});

test('register rejects workflow without id or version', () => {
  const registry = new WorkflowRegistry();
  assert.throws(() => registry.register({}), /must have id and version/);
});

test('loadAll discovers and loads from filesystem', async () => {
  await withTempDir(async (dir) => {
    const yamlContent = `
id: disk-flow
version: "1.0.0"
steps:
  - id: s1
    instruction: run it
    tools:
      - bash
`;
    await fs.mkdir(path.join(dir, 'disk-flow'));
    await fs.writeFile(path.join(dir, 'disk-flow', 'workflow.yaml'), yamlContent);

    const registry = createWorkflowRegistry({ baseDir: dir });
    await registry.loadAll();

    assert.equal(registry.has('disk-flow'), true);
    assert.equal(registry.get('disk-flow').id, 'disk-flow');
  });
});

test('loadAll does nothing without a baseDir', async () => {
  const registry = new WorkflowRegistry();
  await registry.loadAll();
  assert.deepEqual(registry.list(), []);
});
