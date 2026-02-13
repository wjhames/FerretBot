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

test('loop executes tool call and emits status + final response', async () => {
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
    validateCall() {
      return { valid: true, errors: [] };
    },
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

  const toolStartStatus = emitted.find(
    (event) => event.type === 'agent:status' && event.content.phase === 'tool:start',
  );
  assert.ok(toolStartStatus);
  assert.equal(toolStartStatus.content.tool.name, 'bash');

  const toolDoneStatus = emitted.find(
    (event) => event.type === 'agent:status' && event.content.phase === 'tool:complete',
  );
  assert.ok(toolDoneStatus);
  assert.equal(toolDoneStatus.content.tool.name, 'bash');

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
    validateCall() {
      return { valid: true, errors: [] };
    },
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

test('loop retries on parse/validation errors and then succeeds', async () => {
  const bus = createEventBus();
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider([
    '```json\n{tool: "bash", args: {"command":"pwd"}}\n```', // parse_error
    '{"name":"bash","arguments":{"command":123}}', // validation error
    '{"name":"bash","arguments":{"command":"pwd"}}', // valid tool call
    'Final after correction',
  ]);

  const parser = {
    parse(text) {
      if (text.includes('{tool:')) {
        return { kind: 'parse_error', text, error: 'Unable to parse tool call JSON.' };
      }

      if (text.startsWith('{')) {
        const args = text.includes('123') ? { command: 123 } : { command: 'pwd' };
        return {
          kind: 'tool_call',
          toolName: 'bash',
          arguments: args,
        };
      }

      return { kind: 'final', text };
    },
  };

  const toolRegistry = {
    calls: [],
    validateCall(call) {
      if (typeof call.arguments.command !== 'string') {
        return { valid: false, errors: ["argument 'command' must be of type 'string'."] };
      }
      return { valid: true, errors: [] };
    },
    async execute(call) {
      this.calls.push(call);
      return { stdout: '/tmp/work' };
    },
  };

  const loop = createAgentLoop({
    bus,
    provider,
    parser,
    toolRegistry,
    maxTokens: 128,
    maxToolCallsPerStep: 3,
    retryLimit: 2,
  });

  loop.start();
  await bus.emit({
    type: 'user:input',
    channel: 'tui',
    sessionId: 's3',
    content: { text: 'where am i?' },
  });

  await waitFor(() => emitted.some((event) => event.type === 'agent:response'));
  loop.stop();

  assert.equal(toolRegistry.calls.length, 1);
  assert.equal(toolRegistry.calls[0].arguments.command, 'pwd');

  const parseRetry = emitted.find(
    (event) => event.type === 'agent:status' && event.content.phase === 'parse:retry',
  );
  assert.ok(parseRetry);

  const validateRetry = emitted.find(
    (event) => event.type === 'agent:status' && event.content.phase === 'validate:retry',
  );
  assert.ok(validateRetry);

  const responseEvent = emitted.find((event) => event.type === 'agent:response');
  assert.equal(responseEvent.content.text, 'Final after correction');
});

test('loop replaces blank final text with diagnostic message', async () => {
  const bus = createEventBus();
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider(['']);
  const parser = {
    parse(text) {
      return { kind: 'final', text };
    },
  };

  const loop = createAgentLoop({
    bus,
    provider,
    parser,
    toolRegistry: {
      validateCall() {
        return { valid: true, errors: [] };
      },
      async execute() {
        return {};
      },
    },
    maxTokens: 128,
  });

  loop.start();
  await bus.emit({
    type: 'user:input',
    channel: 'tui',
    sessionId: 's4',
    content: { text: 'say something' },
  });

  await waitFor(() => emitted.some((event) => event.type === 'agent:response'));
  loop.stop();

  const responseEvent = emitted.find((event) => event.type === 'agent:response');
  assert.ok(responseEvent);
  assert.equal(responseEvent.content.text, 'Model returned an empty response.');
});
