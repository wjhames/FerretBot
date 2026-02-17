import test from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCall } from '../../src/agent/tool-executor.mjs';

test('executeToolCall emits validation retry when tool args invalid', async () => {
  const messages = [];
  const emitted = [];

  const result = await executeToolCall({
    event: { channel: 'tui', sessionId: 's1' },
    messages,
    completion: { text: '{"tool":"bash"}', usage: {} },
    parsedToolCall: {
      toolName: 'bash',
      arguments: { command: 123 },
      toolCallId: null,
      rawAssistantText: '{"tool":"bash"}',
    },
    toolCalls: 0,
    correctionRetries: 0,
    retryLimit: 2,
    maxToolCallsPerStep: 3,
    toolRegistry: {
      validateCall() {
        return { valid: false, errors: ['command must be string'] };
      },
      async execute() {
        return { ok: true };
      },
    },
    queueEmit: (event) => emitted.push(event),
    appendSessionTurn: async () => {},
    emitCorrectionFailure: () => {},
  });

  assert.equal(result.done, false);
  assert.equal(result.correctionRetries, 1);
  assert.equal(messages.length, 2);

  const status = emitted.find((event) => event.type === 'agent:status');
  assert.ok(status);
  assert.equal(status.content.phase, 'validate:retry');
});

test('executeToolCall stops with tool_limit when cap exceeded', async () => {
  const emitted = [];

  const result = await executeToolCall({
    event: { channel: 'tui', sessionId: 's1' },
    messages: [],
    completion: { text: '', usage: { totalTokens: 2 } },
    parsedToolCall: {
      toolName: 'bash',
      arguments: { command: 'pwd' },
      toolCallId: null,
      rawAssistantText: '',
    },
    toolCalls: 2,
    correctionRetries: 0,
    retryLimit: 2,
    maxToolCallsPerStep: 2,
    toolRegistry: {
      validateCall() {
        return { valid: true, errors: [] };
      },
      async execute() {
        return { ok: true };
      },
    },
    queueEmit: (event) => emitted.push(event),
    appendSessionTurn: async () => {},
    emitCorrectionFailure: () => {},
  });

  assert.equal(result.done, true);
  assert.equal(result.toolCalls, 3);

  const response = emitted.find((event) => event.type === 'agent:response');
  assert.ok(response);
  assert.equal(response.content.finishReason, 'tool_limit');
});
