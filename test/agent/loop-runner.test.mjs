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
