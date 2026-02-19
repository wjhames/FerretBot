import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn } from '../../src/agent/turn/runner.mjs';

test('runAgentTurn drives parse-retry then final emit', async () => {
  const emitted = [];
  const persisted = [];
  const completions = [
    { text: '{tool:invalid', finishReason: 'stop', toolCalls: [] },
    { text: 'final answer', finishReason: 'stop', toolCalls: [] },
  ];
  let completionIndex = 0;

  const provider = {
    async chatCompletion() {
      const completion = completions[completionIndex] ?? completions[completions.length - 1];
      completionIndex += 1;
      return {
        ...completion,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };

  const parser = {
    parse(text) {
      if (text.startsWith('{')) {
        return { kind: 'parse_error', error: 'invalid json' };
      }

      return { kind: 'final', text };
    },
  };

  await runAgentTurn({
    event: { type: 'user:input', channel: 'tui', sessionId: 's1', content: { text: 'hi' } },
    provider,
    parser,
    maxContinuations: 2,
    retryLimit: 1,
    compactMessagesForContinuation: async (options) => options,
    getToolDefinitionsForEvent: () => [],
    buildInitialContext: async () => ({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 128,
    }),
    persistInputTurn: async (event) => {
      persisted.push(event.type);
    },
    emitFinal: async (_event, _completion, text) => {
      emitted.push({ type: 'final', text });
    },
    emitCorrectionFailure: (_event, text) => {
      emitted.push({ type: 'failure', text });
    },
    queueEmit: (event) => {
      emitted.push(event);
    },
    executeToolCall: async () => {
      throw new Error('tool execution not expected');
    },
  });

  assert.deepEqual(persisted, ['user:input']);
  const parseRetry = emitted.find((event) => event.type === 'agent:status' && event.content.phase === 'parse:retry');
  assert.ok(parseRetry);

  const final = emitted.find((event) => event.type === 'final');
  assert.ok(final);
  assert.equal(final.text, 'final answer');
});

test('runAgentTurn rolls back writes when parse retries are exhausted', async () => {
  const emitted = [];
  const rollbackEvents = [];

  const provider = {
    async chatCompletion() {
      return {
        text: '{tool:invalid',
        finishReason: 'stop',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };

  const parser = {
    parse() {
      return { kind: 'parse_error', error: 'invalid json' };
    },
  };

  await runAgentTurn({
    event: { type: 'user:input', channel: 'tui', sessionId: 's2', content: { text: 'hi' } },
    provider,
    parser,
    maxContinuations: 2,
    retryLimit: 0,
    compactMessagesForContinuation: async (options) => options,
    getToolDefinitionsForEvent: () => [],
    buildInitialContext: async () => ({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 128,
    }),
    persistInputTurn: async () => {},
    emitFinal: async () => {
      throw new Error('final emit not expected');
    },
    emitCorrectionFailure: (_event, text) => {
      emitted.push({ type: 'failure', text });
    },
    queueEmit: (event) => {
      emitted.push(event);
    },
    executeToolCall: async () => {
      throw new Error('tool execution not expected');
    },
    createWriteRollback: () => ({
      hasChanges() {
        return true;
      },
      async restore() {
        rollbackEvents.push('restored');
        return 1;
      },
    }),
  });

  assert.deepEqual(rollbackEvents, ['restored']);
  const rollbackStatus = emitted.find((event) => event.type === 'agent:status' && event.content.phase === 'tool:rollback');
  assert.ok(rollbackStatus);
  const failure = emitted.find((event) => event.type === 'failure');
  assert.ok(failure);
});

test('runAgentTurn rolls back writes when tool execution exits early', async () => {
  const rollbackEvents = [];

  await runAgentTurn({
    event: { type: 'user:input', channel: 'tui', sessionId: 's3', content: { text: 'hi' } },
    provider: {
      async chatCompletion() {
        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call-1', name: 'write', arguments: { path: 'x.txt', content: 'x' } }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    },
    parser: {
      parse() {
        return { kind: 'final', text: 'not used' };
      },
    },
    maxContinuations: 2,
    retryLimit: 1,
    compactMessagesForContinuation: async (options) => options,
    getToolDefinitionsForEvent: () => [],
    buildInitialContext: async () => ({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 128,
    }),
    persistInputTurn: async () => {},
    emitFinal: async () => {
      throw new Error('final emit not expected');
    },
    emitCorrectionFailure: () => {},
    queueEmit: () => {},
    executeToolCall: async () => ({
      done: true,
      toolCalls: 1,
      correctionRetries: 0,
    }),
    createWriteRollback: () => ({
      hasChanges() {
        return true;
      },
      async restore() {
        rollbackEvents.push('restored');
        return 1;
      },
    }),
  });

  assert.deepEqual(rollbackEvents, ['restored']);
});
