import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentContext,
  estimateTokens,
  truncateToTokenBudget,
  compressPriorSteps,
  formatToolSchemas,
} from '../../src/agent/context.mjs';

test('context build enforces input budget and assembles deterministic layers', () => {
  const context = createAgentContext({
    contextLimit: 900,
    outputReserve: 120,
    completionSafetyBuffer: 16,
    layerBudgets: {
      system: 280,
      step: 120,
      skills: 80,
      identity: 0,
      soul: 0,
      user: 0,
      boot: 0,
      memory: 0,
      bootstrap: 0,
      prior: 80,
      conversation: 120,
    },
  });

  const conversation = Array.from({ length: 12 }).map((_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `conversation turn ${index} ${'x'.repeat(40)}`,
  }));

  const result = context.buildMessages({
    step: { id: 2, total: 5, instruction: 'Implement IPC server' },
    tools: [
      { name: 'bash', description: 'run shell', schema: { type: 'object', properties: { command: { type: 'string' } } } },
    ],
    skillContent: 'Skill data '.repeat(120),
    priorSteps: [
      { id: 1, instruction: 'Bootstrap project', result: 'Completed successfully with base files.' },
    ],
    conversation,
    userInput: 'Continue with implementation.',
  });

  assert.ok(result.messages.length > 0);
  assert.ok(result.maxOutputTokens > 120);
  assert.ok(result.maxOutputTokens <= 900);
  assert.ok(result.tokenUsage.usedInputTokens > 0);
  assert.ok(result.tokenUsage.layers.system > 0);
  assert.ok(result.tokenUsage.layers.conversation <= 120);

  const maxInputBudget = result.tokenUsage.totalInputBudget;
  assert.ok(result.tokenUsage.usedInputTokens <= maxInputBudget + result.tokenUsage.layers.userInput);

  const systemJoined = result.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');

  assert.match(systemJoined, /Tool call behavior:/);
  assert.doesNotMatch(systemJoined, /Available tools:/);
  assert.match(systemJoined, /Step 1: Bootstrap project/);
});

test('tool schema prompt text is opt-in for non-native tool models', () => {
  const context = createAgentContext({
    contextLimit: 900,
    outputReserve: 120,
    completionSafetyBuffer: 16,
  });

  const disabled = context.buildMessages({
    step: { id: 1, total: 1, instruction: 'Test tool rendering' },
    tools: [{ name: 'read', description: 'Read file content', schema: { type: 'object' } }],
  });
  const disabledText = disabled.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  assert.doesNotMatch(disabledText, /Available tools:/);
  assert.doesNotMatch(disabledText, /Tool: read/);

  const enabled = context.buildMessages({
    step: { id: 1, total: 1, instruction: 'Test tool rendering' },
    tools: [{ name: 'read', description: 'Read file content', schema: { type: 'object' } }],
    includeToolSchemasInPrompt: true,
  });
  const enabledText = enabled.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  assert.match(enabledText, /Available tools:/);
  assert.match(enabledText, /Tool: read/);
});

test('dynamic output budget scales up when input usage is low', () => {
  const context = createAgentContext({
    contextLimit: 8_192,
    outputReserve: 1_024,
    completionSafetyBuffer: 32,
  });

  const result = context.buildMessages({
    userInput: 'short prompt',
    conversation: [],
    priorSteps: [],
    skillContent: '',
  });

  assert.ok(result.maxOutputTokens > 1_024);
  assert.equal(result.maxOutputTokens, 8_192 - result.tokenUsage.usedInputTokens - 32);
});

test('continuation compaction preserves pinned context and fits within budget', async () => {
  const context = createAgentContext({
    contextLimit: 360,
    outputReserve: 120,
    completionSafetyBuffer: 16,
  });

  const messages = [
    { role: 'system', content: 'Global rules stay pinned.' },
    ...Array.from({ length: 10 }).map((_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${index} ${'x'.repeat(80)}`,
    })),
    { role: 'assistant', content: 'Partial answer chunk.' },
    { role: 'user', content: 'Continue exactly.' },
  ];

  const compacted = await context.compactMessagesForContinuation({
    messages,
    maxOutputTokens: 120,
    continuationCount: 1,
    lastCompletionText: 'Partial answer chunk.',
  });

  assert.ok(compacted.messages.length <= messages.length);
  assert.ok(compacted.compacted);
  assert.ok(compacted.messages.some((message) => message.role === 'system'));
  assert.ok(compacted.messages.some((message) => message.role === 'assistant' && /Partial answer chunk/.test(message.content)));
  assert.ok(compacted.messages.some((message) => message.role === 'user' && /Continue exactly/.test(message.content)));
  assert.ok(compacted.maxOutputTokens > 0);
});

test('helper functions provide stable token and compaction behavior', () => {
  const tokenCount = estimateTokens('abcd'.repeat(10));
  assert.ok(tokenCount > 0);

  const truncated = truncateToTokenBudget('x'.repeat(200), 10);
  assert.ok(truncated.length < 200);
  assert.match(truncated, /\.\.\.$/);

  const prior = compressPriorSteps([
    { id: 3, instruction: 'Read file', result: 'Read and summarized.' },
  ]);
  assert.match(prior, /Step 3: Read file/);

  const tools = formatToolSchemas([
    { name: 'read', description: 'Read file content', schema: { type: 'object' } },
  ]);
  assert.match(tools, /Tool: read/);
  assert.match(tools, /Schema:/);
});

test('layer budgets accept alias names and preserve configured values', () => {
  const context = createAgentContext({
    contextLimit: 7_000,
    outputReserve: 500,
    layerBudgets: {
      systemPrompt: 700,
      taskScope: 1_100,
      skillContent: 400,
      identityContext: 120,
      soulContext: 140,
      userContext: 160,
      bootContext: 180,
      memoryContext: 200,
      bootstrapContext: 220,
      priorContext: 200,
      conversation: 800,
    },
  });

  const budgets = context.getLayerBudgets();
  assert.equal(budgets.system, 700);
  assert.equal(budgets.step, 1_100);
  assert.equal(budgets.skills, 400);
  assert.equal(budgets.identity, 120);
  assert.equal(budgets.soul, 140);
  assert.equal(budgets.user, 160);
  assert.equal(budgets.boot, 180);
  assert.equal(budgets.memory, 200);
  assert.equal(budgets.bootstrap, 220);
  assert.equal(budgets.prior, 200);
  assert.equal(budgets.conversation, 800);
});

test('layer budgets scale when fixed layers exceed the input budget', () => {
  const context = createAgentContext({
    contextLimit: 1_200,
    outputReserve: 200,
    layerBudgets: {
      system: 400,
      step: 400,
      skills: 400,
      identity: 400,
      soul: 400,
      user: 400,
      boot: 400,
      memory: 400,
      bootstrap: 400,
      prior: 400,
      conversation: 400,
    },
  });

  const budgets = context.getLayerBudgets();
  const totalScaled = budgets.system
    + budgets.step
    + budgets.skills
    + budgets.identity
    + budgets.soul
    + budgets.user
    + budgets.boot
    + budgets.memory
    + budgets.bootstrap
    + budgets.prior
    + budgets.conversation;
  assert.equal(totalScaled, 1_000);
  assert.ok(budgets.system <= 400);
  assert.ok(budgets.step <= 400);
  assert.ok(budgets.skills <= 400);
  assert.ok(budgets.prior <= 400);
  assert.ok(budgets.conversation <= 400);
  assert.ok(budgets.conversation > 0);
});

test('default derived layer budgets keep meaningful conversation capacity', () => {
  const context = createAgentContext({
    contextLimit: 32_000,
    outputReserve: 2_048,
  });

  const budgets = context.getLayerBudgets();
  assert.ok(budgets.conversation >= 1_000);
  assert.ok(budgets.conversation < 10_000);
});
