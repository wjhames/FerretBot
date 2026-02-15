import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SkillLoader } from '../../src/skills/loader.mjs';

const FIXTURE_ROOT = path.resolve('test/skills/fixtures');

function createLoader() {
  return new SkillLoader({ rootDir: FIXTURE_ROOT });
}

const EXPECTED_AGGREGATED_TEXT = [
  'Follow step-specific instructions carefully.',
  'Workflow guidelines first, step-specific context follows.',
  'Treat every step as a new discovery.',
].join('\n\n');

test('prioritizes step, workflow, and global skills and aggregates content', async () => {
  const loader = createLoader();
  const skillNames = ['step-a', 'workflow-alpha', 'global-two', 'missing-skill'];

  const result = await loader.loadSkillsForStep({
    workflowDir: 'workflows/alpha',
    skillNames,
  });

  assert.deepEqual(result.requested, skillNames);
  assert.deepEqual(result.missing, ['missing-skill']);
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries.map((entry) => entry.scope), ['step', 'workflow', 'global']);
  assert.deepEqual(result.entries.map((entry) => entry.id), ['step-a', 'workflow-alpha', 'global-two']);
  assert.equal(result.text, EXPECTED_AGGREGATED_TEXT);
});

test('truncates individual skill content when maxSkillContentChars is provided', async () => {
  const loader = createLoader();
  const { entries, text } = await loader.loadSkillsForStep({
    workflowDir: 'workflows/alpha',
    skillNames: ['workflow-alpha'],
    maxSkillContentChars: 10,
  });

  assert.equal(entries.length, 1);
  assert.ok(entries[0].content.length <= 10);
  assert.ok(entries[0].content.endsWith('...'));
  assert.ok(text.startsWith(entries[0].content));
});
