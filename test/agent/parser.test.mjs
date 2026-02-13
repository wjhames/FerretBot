import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentParser } from '../../src/agent/parser.mjs';

test('parser extracts tool calls from structured JSON', () => {
  const parser = createAgentParser();

  const direct = parser.parse('{"name":"bash","arguments":{"cmd":"pwd"}}');
  assert.deepEqual(direct, {
    kind: 'tool_call',
    toolName: 'bash',
    arguments: { cmd: 'pwd' },
  });

  const wrapped = parser.parse('```json\n{"tool_call":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}\n```');
  assert.deepEqual(wrapped, {
    kind: 'tool_call',
    toolName: 'read',
    arguments: { path: 'README.md' },
  });
});

test('parser returns final text for non-tool output', () => {
  const parser = createAgentParser();
  const result = parser.parse('Here is the final answer.');

  assert.deepEqual(result, {
    kind: 'final',
    text: 'Here is the final answer.',
  });
});
