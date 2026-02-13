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

test('parser returns parse_error for malformed tool-like JSON', () => {
  const parser = createAgentParser();
  const result = parser.parse('{"tool":"bash","args":{"command":"pwd",}}');

  // trailing comma is repaired, so this should still parse as a tool call
  assert.deepEqual(result, {
    kind: 'tool_call',
    toolName: 'bash',
    arguments: { command: 'pwd' },
  });

  const malformed = parser.parse('{tool: "bash", args: {"command":"pwd"}}');
  assert.equal(malformed.kind, 'parse_error');
  assert.match(malformed.error, /Unable to parse tool call JSON/);
});
