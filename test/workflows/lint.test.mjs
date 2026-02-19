import test from 'node:test';
import assert from 'node:assert/strict';
import { lintWorkflow } from '../../src/workflows/lint.mjs';

test('lintWorkflow reports missing contracts and unknown checks', () => {
  const report = lintWorkflow({
    id: 'demo',
    steps: [
      {
        id: 'step-1',
        type: 'agent',
        outputs: [],
        doneWhen: [{ type: 'missing_check_type' }],
      },
    ],
  }, {
    knownCheckTypes: ['non_empty'],
  });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => entry.includes('missing outputs')));
  assert.ok(report.errors.some((entry) => entry.includes("unknown check type 'missing_check_type'")));
});

test('lintWorkflow passes fully contracted workflow', () => {
  const report = lintWorkflow({
    id: 'demo',
    steps: [
      {
        id: 'step-1',
        type: 'agent',
        outputs: ['facts.md'],
        doneWhen: [{ type: 'file_exists', path: 'facts.md' }],
      },
    ],
  }, {
    knownCheckTypes: ['file_exists'],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});
