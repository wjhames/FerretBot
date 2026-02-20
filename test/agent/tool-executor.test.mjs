import test from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCall } from '../../src/agent/turn/tool-executor.mjs';

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

test('executeToolCall retries when tool execution throws', async () => {
  const messages = [];
  const emitted = [];

  const result = await executeToolCall({
    event: { channel: 'tui', sessionId: 's1' },
    messages,
    completion: { text: '{"tool":"write"}', usage: {} },
    parsedToolCall: {
      toolName: 'write',
      arguments: { path: '\\.ferretbot/file.txt', content: '' },
      toolCallId: null,
      rawAssistantText: '{"tool":"write"}',
    },
    toolCalls: 0,
    correctionRetries: 0,
    retryLimit: 2,
    maxToolCallsPerStep: 3,
    toolRegistry: {
      validateCall() {
        return { valid: true, errors: [] };
      },
      async execute() {
        throw new Error('Path cannot start with a backslash.');
      },
    },
    queueEmit: (event) => emitted.push(event),
    appendSessionTurn: async () => {},
    emitCorrectionFailure: () => {},
  });

  assert.equal(result.done, false);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.correctionRetries, 1);
  assert.equal(messages.length, 2);

  const status = emitted.find((event) => event.type === 'agent:status' && event.content.phase === 'tool:retry');
  assert.ok(status);
  assert.equal(status.content.phase, 'tool:retry');
});

test('executeToolCall forwards tool execution context into registry execute', async () => {
  let capturedContext = null;

  await executeToolCall({
    event: { channel: 'tui', sessionId: 's1' },
    messages: [],
    completion: { text: '{"tool":"write"}', usage: {} },
    parsedToolCall: {
      toolName: 'write',
      arguments: { path: 'notes/a.txt', content: 'hello' },
      toolCallId: null,
      rawAssistantText: '{"tool":"write"}',
    },
    toolCalls: 0,
    correctionRetries: 0,
    retryLimit: 2,
    maxToolCallsPerStep: 3,
    toolExecutionContext: { writeRollback: { id: 'rollback' } },
    toolRegistry: {
      validateCall() {
        return { valid: true, errors: [] };
      },
      async execute(call) {
        capturedContext = call.context;
        return { ok: true };
      },
    },
    queueEmit: () => {},
    appendSessionTurn: async () => {},
    emitCorrectionFailure: () => {},
  });

  assert.deepEqual(capturedContext, { writeRollback: { id: 'rollback' } });
});

test('executeToolCall allows recursive ls -R command when schema-valid', async () => {
  const messages = [];
  const emitted = [];
  const executions = [];

  const result = await executeToolCall({
    event: { channel: 'tui', sessionId: 's1' },
    messages,
    completion: { text: '{"tool":"bash"}', usage: {} },
    parsedToolCall: {
      toolName: 'bash',
      arguments: { command: 'ls -R .' },
      toolCallId: null,
      rawAssistantText: '{"tool":"bash"}',
    },
    toolCalls: 0,
    correctionRetries: 0,
    retryLimit: 2,
    maxToolCallsPerStep: 3,
    toolRegistry: {
      validateCall() {
        return { valid: true, errors: [] };
      },
      async execute(call) {
        executions.push(call);
        return { ok: true };
      },
    },
    queueEmit: (event) => emitted.push(event),
    appendSessionTurn: async () => {},
    emitCorrectionFailure: () => {},
  });

  assert.equal(result.done, false);
  assert.equal(result.correctionRetries, 0);
  assert.equal(executions.length, 1);

  const status = emitted.find((event) => event.type === 'agent:status' && event.content.phase === 'tool:complete');
  assert.ok(status);
});

test('executeToolCall allows overwrite calls without rewriteReason', async () => {
  const messages = [];
  const emitted = [];
  const executions = [];

  const result = await executeToolCall({
    event: { channel: 'tui', sessionId: 's1' },
    messages,
    completion: { text: '{"tool":"write"}', usage: {} },
    parsedToolCall: {
      toolName: 'write',
      arguments: { path: 'src/agent/loop/loop.mjs', content: 'x', mode: 'overwrite' },
      toolCallId: null,
      rawAssistantText: '{"tool":"write"}',
    },
    toolCalls: 0,
    correctionRetries: 0,
    retryLimit: 2,
    maxToolCallsPerStep: 3,
    toolRegistry: {
      validateCall() {
        return { valid: true, errors: [] };
      },
      async execute(call) {
        executions.push(call);
        return { ok: true };
      },
    },
    queueEmit: (event) => emitted.push(event),
    appendSessionTurn: async () => {},
    emitCorrectionFailure: () => {},
  });

  assert.equal(result.done, false);
  assert.equal(result.correctionRetries, 0);
  assert.equal(messages.length, 2);
  assert.equal(executions.length, 1);

  const status = emitted.find((event) => event.type === 'agent:status' && event.content.phase === 'tool:complete');
  assert.ok(status);
});
