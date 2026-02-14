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
    layerBudgets: {
      system: 280,
      task: 120,
      skills: 80,
      prior: 80,
      conversation: 120,
    },
  });

  const conversation = Array.from({ length: 12 }).map((_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `conversation turn ${index} ${'x'.repeat(40)}`,
  }));

  const result = context.buildMessages({
    mode: 'planning',
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
  assert.equal(result.maxOutputTokens, 120);
  assert.ok(result.tokenUsage.usedInputTokens > 0);
  assert.ok(result.tokenUsage.layers.system > 0);
  assert.ok(result.tokenUsage.layers.conversation <= 120);

  const maxInputBudget = result.tokenUsage.totalInputBudget;
  assert.ok(result.tokenUsage.usedInputTokens <= maxInputBudget + result.tokenUsage.layers.userInput);

  const systemJoined = result.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');

  assert.match(systemJoined, /Tool call format:/);
  assert.match(systemJoined, /Planning mode/);
  assert.match(systemJoined, /Step 1: Bootstrap project/);
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
    contextLimit: 3_000,
    outputReserve: 500,
    layerBudgets: {
      systemPrompt: 700,
      taskScope: 1_100,
      skillContent: 400,
      priorContext: 200,
      conversation: 800,
    },
  });

  const budgets = context.getLayerBudgets();
  assert.equal(budgets.system, 700);
  assert.equal(budgets.task, 1_100);
  assert.equal(budgets.skills, 400);
  assert.equal(budgets.prior, 200);
  assert.equal(budgets.conversation, 800);
});

test('layer budgets scale when fixed layers exceed the input budget', () => {
  const context = createAgentContext({
    contextLimit: 1_200,
    outputReserve: 200,
    layerBudgets: {
      system: 400,
      task: 400,
      skills: 400,
      prior: 400,
    },
  });

  const budgets = context.getLayerBudgets();
  const totalFixed = budgets.system + budgets.task + budgets.skills + budgets.prior;
  assert.equal(totalFixed, 1_000);
  assert.ok(budgets.system <= 400);
  assert.ok(budgets.task <= 400);
  assert.ok(budgets.skills <= 400);
  assert.ok(budgets.prior <= 400);
});
