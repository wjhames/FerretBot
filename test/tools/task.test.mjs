import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskManager } from '../../src/tasks/manager.mjs';
import { createTaskTool } from '../../src/tools/task.mjs';

class FakeBus {
  constructor() {
    this.handlers = new Map();
    this.events = [];
    this.waiters = new Map();
  }

  on(type, handler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type).push(handler);
    return () => {
      const list = this.handlers.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index !== -1) {
        list.splice(index, 1);
      }
    };
  }

  async emit(event) {
    this.events.push(event);
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      await handler(event);
    }

    const waiters = this.waiters.get(event.type) ?? [];
    if (waiters.length > 0) {
      this.waiters.set(event.type, []);
      waiters.forEach((resolve) => resolve(event));
    }

    return event;
  }

  waitFor(type) {
    return new Promise((resolve) => {
      if (!this.waiters.has(type)) {
        this.waiters.set(type, []);
      }
      this.waiters.get(type).push(resolve);
    });
  }
}

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-tasktool-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('task tool completes the current step and emits event', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const manager = new TaskManager({ bus, storageDir });
    const plan = {
      goal: 'Review PR',
      steps: [
        { id: 1, instruction: 'Check code', tools: ['bash'], skill: null, dependsOn: [] },
      ],
    };

    const start = bus.waitFor('task:step:start');
    await manager.createTask(plan);
    await start;

    const tool = createTaskTool({ bus, taskManager: manager });
    const response = await tool.execute({ action: 'complete', result: 'tests green' });

    assert.equal(response.status, 'completed');
    assert.match(response.detail, /tests green/);
    assert.ok(bus.events.some((event) => event.type === 'task:step:complete'));
  });
});

test('task tool records a note for the running step', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const manager = new TaskManager({ bus, storageDir });
    const plan = {
      goal: 'Plan release',
      steps: [
        { id: 1, instruction: 'Gather metrics', tools: ['bash'], skill: null, dependsOn: [] },
      ],
    };

    const start = bus.waitFor('task:step:start');
    await manager.createTask(plan);
    await start;

    const tool = createTaskTool({ bus, taskManager: manager });
    await tool.execute({ action: 'note', content: 'Focus on the 99th percentile.' });

    const stored = manager.getTask(1);
    assert.ok(stored.steps[0].notes.length === 1);
    assert.equal(stored.steps[0].notes[0].content, 'Focus on the 99th percentile.');
    assert.ok(bus.events.some((event) => event.type === 'task:note'));
  });
});

test('task tool can fail a step and emit task:failed', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const manager = new TaskManager({ bus, storageDir });
    const plan = {
      goal: 'Deploy service',
      steps: [
        { id: 1, instruction: 'Build release', tools: ['bash'], skill: null, dependsOn: [] },
      ],
    };

    const start = bus.waitFor('task:step:start');
    await manager.createTask(plan);
    await start;

    const tool = createTaskTool({ bus, taskManager: manager });
    const waitForFailure = bus.waitFor('task:failed');
    const response = await tool.execute({ action: 'fail', reason: 'Build artifacts missing.' });

    assert.equal(response.status, 'failed');
    const failureEvent = await waitForFailure;
    assert.equal(failureEvent.content.taskId, 1);
    assert.equal(manager.getTask(1).state, 'failed');
  });
});

test('task tool can skip a step and continue to next', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const manager = new TaskManager({ bus, storageDir });
    const plan = {
      goal: 'Publish',
      steps: [
        { id: 1, instruction: 'Draft blog', tools: ['bash'], skill: null, dependsOn: [] },
        { id: 2, instruction: 'Share announcement', tools: ['bash'], skill: null, dependsOn: [1] },
      ],
    };

    const startFirst = bus.waitFor('task:step:start');
    await manager.createTask(plan);
    const firstStart = await startFirst;
    assert.equal(firstStart.content.step.id, 1);

    const tool = createTaskTool({ bus, taskManager: manager });
    const nextStart = bus.waitFor('task:step:start');
    await tool.execute({ action: 'skip', reason: 'Covered by automation.' });
    const secondStartEvent = await nextStart;
    assert.equal(secondStartEvent.content.step.id, 2);
    assert.ok(bus.events.some((event) => event.type === 'task:step:skipped'));
  });
});
