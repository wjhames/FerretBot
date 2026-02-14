import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskPlanner, TaskPlanningError } from '../../src/tasks/planner.mjs';

function createProviderStub(responseText) {
  const calls = [];
  return {
    calls,
    async chatCompletion(input) {
      calls.push(input);
      return { text: responseText };
    },
  };
}

const mockTools = [
  { name: 'bash', description: 'run shell' },
  { name: 'write', description: 'write files' },
];

const mockToolRegistry = {
  list() {
    return mockTools;
  },
};

test('planner returns normalized steps for valid plan response', async () => {
  const response = JSON.stringify({
    goal: 'Bootstrap project',
    steps: [
      {
        id: 1,
        instruction: 'Init repo and install dependencies',
        tools: ['bash'],
        skill: null,
        dependsOn: [],
      },
      {
        id: 2,
        instruction: 'Create README and docs',
        tools: ['write'],
        skill: 'doc-writing',
        dependsOn: [1],
      },
    ],
  });

  const provider = createProviderStub(response);
  const planner = new TaskPlanner({
    provider,
    toolRegistry: mockToolRegistry,
    skillNames: ['doc-writing'],
    contextOptions: { contextLimit: 2_000, outputReserve: 500 },
  });

  const result = await planner.plan('Setup project');

  assert.equal(result.goal, 'Bootstrap project');
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps[0], {
    id: 1,
    instruction: 'Init repo and install dependencies',
    tools: ['bash'],
    skill: null,
    dependsOn: [],
  });

  assert.deepEqual(result.steps[1].dependsOn, [1]);
  assert.match(provider.calls[0].messages[0].content, /FerretBot/);
  assert.match(provider.calls[0].messages[0].content, /Tool call format/);
});

test('planner throws when plan is missing goal', async () => {
  const provider = createProviderStub('{"steps":[]}');
  const planner = new TaskPlanner({ provider, toolRegistry: mockToolRegistry });

  await assert.rejects(
    planner.plan('   '),
    (error) => error instanceof TaskPlanningError && /Goal must be provided/.test(error.message),
  );
});

test('planner rejects unknown tools and skills', async () => {
  const response = JSON.stringify({
    goal: 'Write docs',
    steps: [
      {
        id: 1,
        instruction: 'Draft guide',
        tools: ['unknown-tool'],
        skill: 'marketing',
        dependsOn: [],
      },
    ],
  });

  const provider = createProviderStub(response);
  const planner = new TaskPlanner({
    provider,
    toolRegistry: mockToolRegistry,
    skillNames: ['doc-writing'],
  });

  await assert.rejects(
    planner.plan('Write docs'),
    (error) =>
      error instanceof TaskPlanningError &&
      error.errors.some((message) => message.includes("unknown tool 'unknown-tool'")) &&
      error.errors.some((message) => message.includes("unknown skill 'marketing'")),
  );
});
