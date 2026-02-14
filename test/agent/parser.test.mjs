import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentParser } from '../../src/agent/parser.mjs';

test('parser extracts tool calls from structured JSON', () => {
  const parser = createAgentParser();

  const direct = parser.parse('{"name":"bash","arguments":{"cmd":"pwd"}}');
  assert.equal(direct.kind, 'tool_call');
  assert.equal(direct.toolName, 'bash');
  assert.deepEqual(direct.arguments, { cmd: 'pwd' });
  assert.ok(typeof direct.rawJson === 'string');
  assert.match(direct.rawJson, /"name":"bash"/);

  const wrapped = parser.parse('```json\n{"tool_call":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}\n```');
  assert.equal(wrapped.kind, 'tool_call');
  assert.equal(wrapped.toolName, 'read');
  assert.deepEqual(wrapped.arguments, { path: 'README.md' });
  assert.ok(typeof wrapped.rawJson === 'string');
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
  assert.equal(result.kind, 'tool_call');
  assert.equal(result.toolName, 'bash');
  assert.deepEqual(result.arguments, { command: 'pwd' });
  assert.ok(typeof result.rawJson === 'string');

  const malformed = parser.parse('{tool: "bash", args: {"command":"pwd"}}');
  assert.equal(malformed.kind, 'parse_error');
  assert.match(malformed.error, /Unable to parse tool call JSON/);
});

test('parser handles tool call embedded in prose and tracks candidate snippet', () => {
  const parser = createAgentParser();
  const text = 'Response:\nPlease run the following command:\n{"tool":"bash","arguments":{"cmd":"ls"}}\nThanks';

  const parsed = parser.parse(text);
  assert.equal(parsed.kind, 'tool_call');
  assert.equal(parsed.toolName, 'bash');
  assert.deepEqual(parsed.arguments, { cmd: 'ls' });
  assert.ok(typeof parsed.rawJson === 'string');
  assert.match(parsed.rawJson, /\{"tool":"bash","arguments":\{"cmd":"ls"\}\}/);
});

test('parser extracts tool call from array output and ignores later entries', () => {
  const parser = createAgentParser();
  const arrayText = '[{"tool_call":{"name":"bash","arguments":{"cmd":"node --version"}}},{"tool_call":{"name":"read","arguments":{"path":"package.json"}}}]';
  const parsed = parser.parse(arrayText);
  assert.equal(parsed.kind, 'tool_call');
  assert.equal(parsed.toolName, 'bash');
  assert.deepEqual(parsed.arguments, { cmd: 'node --version' });
});

test('parser surfaces candidate snippet when failing', () => {
  const parser = createAgentParser();
  const broken = parser.parse('Tool call\n{"tool":"read","arguments":{ invalid }}');
  assert.equal(broken.kind, 'parse_error');
  assert.match(broken.error, /Candidate snippet:/);
});

test('parser truncates oversized candidate snippets in parse errors', () => {
  const parser = createAgentParser();
  const oversized = '{"tool":"read","arguments":{' + 'x'.repeat(800);
  const broken = parser.parse(oversized);

  assert.equal(broken.kind, 'parse_error');
  assert.match(broken.error, /Candidate snippet:/);
  assert.ok(broken.error.length < 400);
  assert.match(broken.error, /\.\.\.$/);
});
