import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createEventBus } from '../../src/core/bus.mjs';
import { createAgentLoop } from '../../src/agent/loop.mjs';

function createSequencedProvider(texts) {
  let index = 0;
  return {
    async chatCompletion() {
      const text = texts[index] ?? texts[texts.length - 1] ?? '';
      index += 1;
      return {
        text,
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      };
    },
  };
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for condition.');
}

test('loop executes tool call and emits final agent response', async () => {
  const bus = createEventBus();
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider([
    '{"name":"bash","arguments":{"cmd":"echo hi"}}',
    'Final response after tool',
  ]);

  const parser = {
    parse(text) {
      if (text.startsWith('{')) {
        return {
          kind: 'tool_call',
          toolName: 'bash',
          arguments: { cmd: 'echo hi' },
        };
      }

      return { kind: 'final', text };
    },
  };

  const toolRegistry = {
    calls: [],
    async execute(call) {
      this.calls.push(call);
      return { stdout: 'hi' };
    },
  };

  const loop = createAgentLoop({
    bus,
    provider,
    parser,
    toolRegistry,
    maxTokens: 128,
    maxToolCallsPerStep: 3,
  });

  loop.start();

  await bus.emit({
    type: 'user:input',
    channel: 'tui',
    sessionId: 's1',
    content: { text: 'say hi' },
  });

  await waitFor(() => emitted.some((event) => event.type === 'agent:response'));
  loop.stop();

  assert.equal(toolRegistry.calls.length, 1);
  assert.equal(toolRegistry.calls[0].name, 'bash');

  const toolCallEvent = emitted.find((event) => event.type === 'tool:call');
  assert.ok(toolCallEvent);

  const toolResultEvent = emitted.find((event) => event.type === 'tool:result');
  assert.ok(toolResultEvent);
  assert.deepEqual(toolResultEvent.content.result, { stdout: 'hi' });

  const responseEvent = emitted.find((event) => event.type === 'agent:response');
  assert.ok(responseEvent);
  assert.equal(responseEvent.content.text, 'Final response after tool');
});

test('loop emits tool-limit response when call cap is exceeded', async () => {
  const bus = createEventBus();
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider([
    '{"name":"bash","arguments":{}}',
    '{"name":"bash","arguments":{}}',
    '{"name":"bash","arguments":{}}',
  ]);

  const parser = {
    parse() {
      return {
        kind: 'tool_call',
        toolName: 'bash',
        arguments: {},
      };
    },
  };

  const toolRegistry = {
    async execute() {
      return { ok: true };
    },
  };

  const loop = createAgentLoop({
    bus,
    provider,
    parser,
    toolRegistry,
    maxTokens: 128,
    maxToolCallsPerStep: 2,
  });

  loop.start();

  await bus.emit({
    type: 'user:input',
    channel: 'telegram',
    sessionId: 's2',
    content: { text: 'do tools forever' },
  });

  await waitFor(() => emitted.some((event) => event.type === 'agent:response'));
  loop.stop();

  const responseEvent = emitted.find((event) => event.type === 'agent:response');
  assert.ok(responseEvent);
  assert.equal(responseEvent.content.finishReason, 'tool_limit');
  assert.match(responseEvent.content.text, /Tool call limit reached/);
});
