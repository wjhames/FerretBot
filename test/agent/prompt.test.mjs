import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSystemPrompt,
  coreIdentity,
  stepPreamble,
  toolCallFormat,
} from '../../src/agent/prompt.mjs';

test('coreIdentity and toolCallFormat include critical execution rules', () => {
  const identity = coreIdentity();
  const format = toolCallFormat();

  assert.doesNotMatch(identity, /FerretBot/);
  assert.match(identity, /deterministic/i);
  assert.match(identity, /Do not fabricate tool results/i);
  assert.match(format, /Prefer native API tool calls/i);
  assert.match(format, /\{"tool": "tool_name", "args":/);
  assert.match(format, /plain text only/i);
});

test('stepPreamble handles provided and missing step metadata', () => {
  const filled = stepPreamble({ id: 2, total: 5, instruction: 'Run tests' });
  assert.match(filled, /step 2 of 5/);
  assert.match(filled, /Step instruction: Run tests/);

  const fallback = stepPreamble({});
  assert.match(fallback, /step \? of \?/);
  assert.match(fallback, /No step instruction provided/);
});

test('buildSystemPrompt composes step-specific sections deterministically', () => {
  const prompt = buildSystemPrompt({
    step: { id: 1, total: 3, instruction: 'Initialize project' },
    extraRules: 'Never leak secrets.',
  });

  assert.match(prompt, /Do not fabricate tool results/);
  assert.match(prompt, /Tool call behavior:/);
  assert.match(prompt, /step 1 of 3/);
  assert.match(prompt, /Never leak secrets/);
});
