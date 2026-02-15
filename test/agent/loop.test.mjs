import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createEventBus } from '../../src/core/bus.mjs';
import { createAgentLoop } from '../../src/agent/loop.mjs';

function createSequencedProvider(items) {
  let index = 0;
  return {
    async chatCompletion() {
      const item = items[index] ?? items[items.length - 1] ?? '';
      index += 1;

      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return {
          text: item.text ?? '',
          toolCalls: item.toolCalls ?? [],
          finishReason: item.finishReason ?? 'stop',
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
        };
      }

      return {
        text: String(item ?? ''),
        toolCalls: [],
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

test('loop executes native OpenAI tool_calls and emits final response', async () => {
  const bus = createEventBus();
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider([
    {
      text: '',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_1',
          name: 'bash',
          arguments: { command: 'pwd' },
        },
      ],
    },
    {
      text: 'Final response after tool',
      finishReason: 'stop',
    },
  ]);

  const parser = {
    parse(text) {
      return { kind: 'final', text };
    },
  };

  const toolRegistry = {
    calls: [],
    list() {
      return [{ name: 'bash', description: 'run shell', schema: { type: 'object' } }];
    },
    validateCall() {
      return { valid: true, errors: [] };
    },
    async execute(call) {
      this.calls.push(call);
      return { stdout: '/workspace' };
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

  const toolDoneStatus = emitted.find(
    (event) => event.type === 'agent:status' && event.content.phase === 'tool:complete',
  );
  assert.ok(toolDoneStatus);

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
    { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'bash', arguments: {} }] },
    { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c2', name: 'bash', arguments: {} }] },
    { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c3', name: 'bash', arguments: {} }] },
  ]);

  const parser = {
    parse() {
      return { kind: 'tool_call', toolName: 'bash', arguments: {} };
    },
  };

  const toolRegistry = {
    list() {
      return [{ name: 'bash', description: 'run shell', schema: { type: 'object' } }];
    },
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
    '{tool: "bash", args: {"command":"pwd"}}',
    '{"name":"bash","arguments":{"command":123}}',
    '{"name":"bash","arguments":{"command":"pwd"}}',
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
    list() {
      return [{ name: 'bash', description: 'run shell', schema: { type: 'object' } }];
    },
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
      list() {
        return [];
      },
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

test('loop default context includes a system prompt message', async () => {
  const bus = createEventBus();
  const providerCalls = [];
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = {
    async chatCompletion(input) {
      providerCalls.push(input);
      return {
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      };
    },
  };

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
      list() {
        return [];
      },
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
    sessionId: 's6',
    content: { text: 'hello' },
  });

  await waitFor(() => emitted.some((event) => event.type === 'agent:response'));
  loop.stop();

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].messages[0].role, 'system');
  assert.match(providerCalls[0].messages[0].content, /You are FerretBot/);
  assert.equal(providerCalls[0].messages.at(-1).role, 'user');
  assert.equal(providerCalls[0].messages.at(-1).content, 'hello');
});

test('loop treats markdown answers as final output instead of parse-error retry', async () => {
  const bus = createEventBus();
  const emitted = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider(['## Result\n\n- item 1\n- item 2']);
  const parser = {
    parse() {
      return { kind: 'parse_error', error: 'should not be used for plain markdown' };
    },
  };

  const loop = createAgentLoop({
    bus,
    provider,
    parser,
    toolRegistry: {
      list() {
        return [{ name: 'bash', description: 'run shell', schema: { type: 'object' } }];
      },
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
    sessionId: 's5',
    content: { text: 'respond in markdown' },
  });

  await waitFor(() => emitted.some((event) => event.type === 'agent:response'));
  loop.stop();

  const parseRetry = emitted.find(
    (event) => event.type === 'agent:status' && event.content.phase === 'parse:retry',
  );
  assert.equal(parseRetry, undefined);

  const responseEvent = emitted.find((event) => event.type === 'agent:response');
  assert.ok(responseEvent);
  assert.equal(responseEvent.content.text, '## Result\n\n- item 1\n- item 2');
});

test('loop restricts task step tool schemas to step tools plus task', async () => {
  const bus = createEventBus();
  const emitted = [];
  const providerCalls = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = {
    async chatCompletion(input) {
      providerCalls.push(input);
      return {
        text: 'step done',
        toolCalls: [],
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      };
    },
  };

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
      list() {
        return [
          { name: 'bash', description: 'run shell', schema: { type: 'object' } },
          { name: 'read', description: 'read file', schema: { type: 'object' } },
          { name: 'task', description: 'task control', schema: { type: 'object' } },
        ];
      },
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
    type: 'task:step:start',
    channel: 'tui',
    sessionId: 's-step',
    content: {
      step: {
        id: 1,
        total: 2,
        instruction: 'do work',
        tools: ['read'],
      },
    },
  });

  await waitFor(() => emitted.some((event) => event.type === 'task:step:complete'));
  loop.stop();

  assert.equal(providerCalls.length, 1);
  const sentTools = providerCalls[0].tools.map((tool) => tool.name).sort();
  assert.deepEqual(sentTools, ['read', 'task']);
});

test('loop handles workflow:step:start, scopes tools, and emits workflow:step:complete', async () => {
  const bus = createEventBus();
  const emitted = [];
  const providerCalls = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = {
    async chatCompletion(input) {
      providerCalls.push(input);
      return {
        text: 'workflow step done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };

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
      list() {
        return [
          { name: 'bash', description: 'run shell', schema: { type: 'object' } },
          { name: 'read', description: 'read file', schema: { type: 'object' } },
          { name: 'task', description: 'task control', schema: { type: 'object' } },
        ];
      },
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
    type: 'workflow:step:start',
    channel: 'tui',
    sessionId: 's-wf',
    content: {
      runId: 42,
      workflowId: 'test-wf',
      step: {
        id: 'build',
        instruction: 'build the project',
        tools: ['bash'],
        total: 3,
      },
    },
  });

  await waitFor(() => emitted.some((event) => event.type === 'workflow:step:complete'));
  loop.stop();

  const sentTools = providerCalls[0].tools.map((tool) => tool.name).sort();
  assert.deepEqual(sentTools, ['bash']);

  const stepComplete = emitted.find((event) => event.type === 'workflow:step:complete');
  assert.ok(stepComplete);
  assert.equal(stepComplete.content.runId, 42);
  assert.equal(stepComplete.content.stepId, 'build');
  assert.equal(stepComplete.content.result, 'workflow step done');

  const taskComplete = emitted.find((event) => event.type === 'task:step:complete');
  assert.equal(taskComplete, undefined);
});

test('loop enriches workflow context with session turns, summary, skills, and prior steps', async () => {
  const bus = createEventBus();
  const emitted = [];
  const capturedContextInputs = [];
  const skillLoadCalls = [];

  bus.on('*', async (event) => {
    emitted.push(event);
  });

  const provider = createSequencedProvider(['workflow enriched response']);
  const parser = {
    parse(text) {
      return { kind: 'final', text };
    },
  };

  const workflow = {
    id: 'wf-id',
    version: '1.0.0',
    dir: '/tmp/workflows/wf-id',
    steps: [
      { id: 'prepare', instruction: 'prepare workspace' },
      { id: 'build', instruction: 'build project' },
    ],
  };
  const run = {
    id: 7,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    steps: [
      { id: 'prepare', state: 'completed', result: 'workspace ready' },
      { id: 'build', state: 'active', result: null },
    ],
  };

  const contextManager = {
    getLayerBudgets() {
      return { conversation: 100, skills: 50 };
    },
    buildMessages(input) {
      capturedContextInputs.push(input);
      return {
        messages: [{ role: 'user', content: 'synthetic prompt' }],
        maxOutputTokens: 128,
      };
    },
  };

  const loop = createAgentLoop({
    bus,
    provider,
    parser,
    contextManager,
    workflowRegistry: {
      get() {
        return workflow;
      },
    },
    workflowEngine: {
      getRun() {
        return run;
      },
    },
    skillLoader: {
      async loadSkillsForStep(args) {
        skillLoadCalls.push(args);
        return { text: 'workflow skill content', entries: [], missing: [], requested: args.skillNames };
      },
    },
    sessionMemory: {
      async collectConversation() {
        return {
          turns: [
            { role: 'user', content: 'earlier user turn' },
            { role: 'assistant', content: 'earlier assistant turn' },
          ],
          summary: 'Earlier turns: user discussed goals.',
        };
      },
      async appendTurn() {},
    },
    toolRegistry: {
      list() {
        return [{ name: 'bash', description: 'run shell', schema: { type: 'object' } }];
      },
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
    type: 'workflow:step:start',
    channel: 'tui',
    sessionId: 's-wf-enriched',
    content: {
      runId: 7,
      workflowId: 'wf-id',
      workflowDir: workflow.dir,
      step: {
        id: 'build',
        instruction: 'build project',
        tools: ['bash'],
        loadSkills: ['build.skill.md'],
      },
    },
  });

  await waitFor(() => emitted.some((event) => event.type === 'workflow:step:complete'));
  loop.stop();

  assert.equal(skillLoadCalls.length, 1);
  assert.equal(skillLoadCalls[0].workflowDir, workflow.dir);
  assert.deepEqual(skillLoadCalls[0].skillNames, ['build.skill.md']);

  assert.equal(capturedContextInputs.length, 1);
  const contextInput = capturedContextInputs[0];
  assert.equal(contextInput.skillContent, 'workflow skill content');
  assert.equal(contextInput.conversationSummary, 'Earlier turns: user discussed goals.');
  assert.equal(contextInput.conversation.length, 2);
  assert.equal(contextInput.priorSteps.length, 1);
  assert.match(contextInput.priorSteps[0].instruction, /prepare workspace/);
  assert.equal(contextInput.priorSteps[0].result, 'workspace ready');
});
