import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createEventBus } from '../../src/core/bus.mjs';
import { registerWorkflowIpcCommands } from '../../src/workflows/ipc-commands.mjs';

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

test('workflow:run:start dispatches to engine and emits targeted command status', async () => {
  const bus = createEventBus();
  const calls = [];
  const statuses = [];

  bus.on('agent:status', async (event) => {
    statuses.push(event);
  });

  const unregister = registerWorkflowIpcCommands({
    bus,
    workflowRegistry: {
      list() {
        return [];
      },
    },
    workflowEngine: {
      async startRun(workflowId, args, options) {
        calls.push({ workflowId, args, options });
        return {
          id: 41,
          workflowId,
          workflowVersion: options.version ?? '1.0.0',
          state: 'running',
        };
      },
      async cancelRun() {},
      listRuns() {
        return [];
      },
    },
  });

  await bus.emit({
    type: 'workflow:run:start',
    sessionId: 'client-77',
    content: {
      requestId: 'req-1',
      workflowId: 'demo-flow',
      version: '2.0.0',
      args: { topic: 'safety' },
    },
  });

  await waitFor(() => statuses.length === 1);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    workflowId: 'demo-flow',
    args: {
      topic: 'safety',
      sessionId: 'client-77',
    },
    options: {
      version: '2.0.0',
    },
  });

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].sessionId, 'client-77');
  assert.deepEqual(statuses[0].content, {
    kind: 'workflow_command_result',
    command: 'workflow:run:start',
    requestId: 'req-1',
    ok: true,
    message: 'workflow run 41 queued.',
    data: {
      runId: 41,
      workflowId: 'demo-flow',
      workflowVersion: '2.0.0',
      state: 'running',
    },
  });

  unregister();
});

test('workflow:lint returns lint report through workflow command status', async () => {
  const bus = createEventBus();
  const statuses = [];

  bus.on('agent:status', async (event) => {
    statuses.push(event);
  });

  const unregister = registerWorkflowIpcCommands({
    bus,
    workflowRegistry: { list() { return []; } },
    workflowEngine: {
      lintWorkflow(workflowId, options) {
        return {
          workflowId,
          version: options?.version ?? null,
          ok: true,
          errors: [],
          warnings: [],
        };
      },
      async startRun() {},
      async cancelRun() {},
      listRuns() { return []; },
      dryRun() { return { ok: true, plan: [] }; },
    },
  });

  await bus.emit({
    type: 'workflow:lint',
    sessionId: 'client-1',
    content: { requestId: 'req-lint', workflowId: 'demo-flow', version: '1.2.3' },
  });

  await waitFor(() => statuses.length === 1);
  assert.equal(statuses[0].content.ok, true);
  assert.equal(statuses[0].content.command, 'workflow:lint');
  assert.equal(statuses[0].content.data.workflowId, 'demo-flow');

  unregister();
});

test('workflow:dry-run validates workflow and returns plan', async () => {
  const bus = createEventBus();
  const statuses = [];

  bus.on('agent:status', async (event) => {
    statuses.push(event);
  });

  const dryRunCalls = [];
  const unregister = registerWorkflowIpcCommands({
    bus,
    workflowRegistry: { list() { return []; } },
    workflowEngine: {
      dryRun(workflowId, args, options) {
        dryRunCalls.push({ workflowId, args, options });
        return {
          ok: true,
          workflowId,
          workflowVersion: options?.version ?? '1.0.0',
          args,
          unresolvedDependencies: [],
          plan: [{ id: 's1', doneWhenCount: 1 }],
        };
      },
      lintWorkflow() { return { ok: true, errors: [], warnings: [] }; },
      async startRun() {},
      async cancelRun() {},
      listRuns() { return []; },
    },
  });

  await bus.emit({
    type: 'workflow:dry-run',
    sessionId: 'client-2',
    content: {
      requestId: 'req-dry',
      workflowId: 'demo-flow',
      version: '2.0.0',
      args: { target: 'docs' },
    },
  });

  await waitFor(() => statuses.length === 1);
  assert.equal(dryRunCalls.length, 1);
  assert.deepEqual(dryRunCalls[0], {
    workflowId: 'demo-flow',
    args: { target: 'docs' },
    options: { version: '2.0.0' },
  });
  assert.equal(statuses[0].content.command, 'workflow:dry-run');
  assert.equal(statuses[0].content.ok, true);
  assert.equal(statuses[0].content.data.plan.length, 1);

  unregister();
});
