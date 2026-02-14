import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskManager } from '../../src/tasks/manager.mjs';

class FakeBus {
  constructor() {
    this.handlers = new Map();
    this.waiters = new Map();
    this.events = [];
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-taskmgr-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('creates a task, persists it, and emits lifecycle events', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const manager = new TaskManager({ bus, storageDir, startListening: true });

    const plan = {
      goal: 'Write docs',
      steps: [
        { id: 1, instruction: 'Draft outline', tools: ['bash'], skill: null, dependsOn: [] },
        { id: 2, instruction: 'Publish docs', tools: ['write'], skill: null, dependsOn: [1] },
      ],
    };

    const task = await manager.createTask(plan);

    assert.equal(task.goal, plan.goal);
    assert.equal(bus.events[0].type, 'task:created');
    assert.equal(bus.events[1].type, 'task:step:start');
    assert.equal(bus.events[1].content.step.total, 2);

    const fileContent = JSON.parse(await fs.readFile(path.join(storageDir, `task-${task.id}.json`), 'utf8'));
    assert.equal(fileContent.goal, plan.goal);
    assert.equal(fileContent.steps.length, 2);
  });
});

test('completing a step advances to the next step and emits completion', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const manager = new TaskManager({ bus, storageDir });

    const plan = {
      goal: 'Deploy service',
      steps: [
        { id: 1, instruction: 'Build artifact', tools: ['bash'], skill: null, dependsOn: [] },
        { id: 2, instruction: 'Deploy artifact', tools: ['bash'], skill: null, dependsOn: [1] },
      ],
    };

    const task = await manager.createTask(plan);
    assert.equal(bus.events[1].content.step.instruction, 'Build artifact');

    const secondStart = bus.waitFor('task:step:start');
    await bus.emit({ type: 'task:step:complete', content: { result: 'built' } });
    const stepEvent = await secondStart;
    assert.equal(stepEvent.content.step.id, 2);

    const completion = bus.waitFor('task:complete');
    await bus.emit({ type: 'task:step:complete', content: { result: 'deployed' } });
    const completionEvent = await completion;
    assert.equal(completionEvent.content.taskId, task.id);

    const results = await manager.getPriorStepResults(task.id);
    assert.equal(results.length, 2);
    assert.equal(results[0].result, 'built');
  });
});
