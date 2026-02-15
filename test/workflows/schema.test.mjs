import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../../src/workflows/schema.mjs';

function minimalWorkflow(overrides = {}) {
  return {
    id: 'test-flow',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        instruction: 'Do something',
        tools: ['bash'],
      },
    ],
    ...overrides,
  };
}

test('validates a minimal valid workflow', () => {
  const result = validateWorkflow(minimalWorkflow());
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.workflow.id, 'test-flow');
  assert.equal(result.workflow.version, '1.0.0');
  assert.equal(result.workflow.steps.length, 1);
  assert.equal(result.workflow.steps[0].id, 'step-1');
  assert.equal(result.workflow.steps[0].retries, 0);
  assert.equal(result.workflow.steps[0].approval, false);
  assert.equal(result.workflow.steps[0].condition, null);
});

test('validates a workflow with all optional fields', () => {
  const result = validateWorkflow({
    id: 'full-flow',
    version: '2.1.0',
    name: 'Full Workflow',
    description: 'A workflow with all fields',
    inputs: [{ name: 'target', type: 'string', required: true }],
    steps: [
      {
        id: 'build',
        name: 'Build Project',
        instruction: 'Run the build',
        tools: ['bash'],
        loadSkills: ['build.skill.md'],
        dependsOn: [],
        successChecks: [{ type: 'exit_code', expected: 0 }],
        timeout: 30000,
        retries: 2,
        approval: true,
        condition: 'steps.init.output',
      },
    ],
  });

  assert.equal(result.valid, true);
  assert.equal(result.workflow.name, 'Full Workflow');
  assert.equal(result.workflow.description, 'A workflow with all fields');
  assert.equal(result.workflow.inputs.length, 1);
  const step = result.workflow.steps[0];
  assert.equal(step.name, 'Build Project');
  assert.equal(step.timeout, 30000);
  assert.equal(step.retries, 2);
  assert.equal(step.approval, true);
  assert.equal(step.loadSkills.length, 1);
  assert.equal(step.successChecks.length, 1);
});

test('rejects non-object input', () => {
  assert.equal(validateWorkflow(null).valid, false);
  assert.equal(validateWorkflow('string').valid, false);
  assert.equal(validateWorkflow([]).valid, false);
});

test('requires id', () => {
  const result = validateWorkflow(minimalWorkflow({ id: '' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('id is required')));
});

test('rejects invalid id characters', () => {
  const result = validateWorkflow(minimalWorkflow({ id: 'Bad_Id!' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must match')));
});

test('requires version', () => {
  const result = validateWorkflow(minimalWorkflow({ version: '' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('version is required')));
});

test('requires non-empty steps', () => {
  const result = validateWorkflow(minimalWorkflow({ steps: [] }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('steps must be a non-empty array')));
});

test('detects duplicate step ids', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [
      { id: 'a', instruction: 'first', tools: ['bash'] },
      { id: 'a', instruction: 'second', tools: ['bash'] },
    ],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate step id')));
});

test('detects cyclic dependencies', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [
      { id: 'a', instruction: 'first', tools: ['bash'], dependsOn: ['b'] },
      { id: 'b', instruction: 'second', tools: ['bash'], dependsOn: ['a'] },
    ],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('dependency cycle')));
});

test('detects unknown dependency references', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [
      { id: 'a', instruction: 'first', tools: ['bash'], dependsOn: ['nonexistent'] },
    ],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown step')));
});

test('rejects unknown top-level fields', () => {
  const result = validateWorkflow(minimalWorkflow({ extra: true }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("unknown field 'extra'")));
});

test('rejects unknown step-level fields', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', instruction: 'do it', tools: ['bash'], foo: 'bar' }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("unknown field 'foo'")));
});

test('requires tools per step', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', instruction: 'do it' }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('tools must be a non-empty array')));
});

test('allows system_write_file step without tools and validates path/content', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', type: 'system_write_file', path: 'x.txt', content: 'hello' }],
  }));
  assert.equal(result.valid, true);
  assert.equal(result.workflow.steps[0].type, 'system_write_file');
  assert.equal(result.workflow.steps[0].tools.length, 0);
});

test('rejects invalid system step definitions', () => {
  const missingPath = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', type: 'system_delete_file' }],
  }));
  assert.equal(missingPath.valid, false);
  assert.ok(missingPath.errors.some((e) => e.includes('path is required for system steps')));

  const missingContent = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', type: 'system_write_file', path: 'x.txt' }],
  }));
  assert.equal(missingContent.valid, false);
  assert.ok(missingContent.errors.some((e) => e.includes('content is required for system_write_file')));
});

test('requires step instruction', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', tools: ['bash'] }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('instruction is required')));
});

test('validates successChecks require type field', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [{ id: 'a', instruction: 'do it', tools: ['bash'], successChecks: [{}] }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must have a type field')));
});

test('defaults name to id when not provided', () => {
  const result = validateWorkflow(minimalWorkflow());
  assert.equal(result.workflow.name, 'test-flow');
  assert.equal(result.workflow.steps[0].name, 'step-1');
});

test('accepts valid dependency chain', () => {
  const result = validateWorkflow(minimalWorkflow({
    steps: [
      { id: 'a', instruction: 'first', tools: ['bash'] },
      { id: 'b', instruction: 'second', tools: ['read'], dependsOn: ['a'] },
      { id: 'c', instruction: 'third', tools: ['write'], dependsOn: ['a', 'b'] },
    ],
  }));
  assert.equal(result.valid, true);
  assert.equal(result.workflow.steps.length, 3);
  assert.deepEqual(result.workflow.steps[2].dependsOn, ['a', 'b']);
});
