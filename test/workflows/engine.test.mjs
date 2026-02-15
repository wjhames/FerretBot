import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowEngine, createWorkflowEngine } from '../../src/workflows/engine.mjs';
import { createWorkspaceManager } from '../../src/memory/workspace.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-engine-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate, { timeoutMs = 800, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await Promise.resolve(predicate())) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error('Timed out waiting for condition.');
}

class FakeBus {
  #handlers = new Map();
  events = [];

  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, []);
    this.#handlers.get(type).push(handler);
    return () => {
      const list = this.#handlers.get(type);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  async emit(event) {
    this.events.push(event);
    const typed = this.#handlers.get(event.type) ?? [];
    const wildcard = this.#handlers.get('*') ?? [];
    for (const handler of [...typed, ...wildcard]) {
      await handler(event);
    }
    return event;
  }

  eventsOfType(type) {
    return this.events.filter((e) => e.type === type);
  }
}

function makeWorkflow(overrides = {}) {
  return {
    id: 'test-wf',
    version: '1.0.0',
    dir: '/tmp/test-wf',
    name: 'Test',
    description: '',
    inputs: [],
    steps: [
      {
        id: 'step-1',
        name: 'Step 1',
        instruction: 'Do first thing',
        tools: ['bash'],
        loadSkills: [],
        dependsOn: [],
        successChecks: [],
        timeout: null,
        retries: 0,
        approval: false,
        condition: null,
      },
    ],
    ...overrides,
  };
}

function makeRegistry(workflows = []) {
  const map = new Map();
  for (const wf of workflows) {
    map.set(wf.id, wf);
  }
  return {
    get(id) { return map.get(id) ?? null; },
    has(id) { return map.has(id); },
    list() { return workflows.map((w) => ({ id: w.id, version: w.version })); },
  };
}

test('startRun creates a run and emits workflow:step:start', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow();
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');

    assert.equal(run.workflowId, 'test-wf');
    assert.ok(bus.eventsOfType('workflow:run:queued').length > 0);
    assert.ok(bus.eventsOfType('workflow:step:start').length > 0);

    const stepStart = bus.eventsOfType('workflow:step:start')[0];
    assert.equal(stepStart.content.step.id, 'step-1');
    assert.equal(stepStart.content.step.instruction, 'Do first thing');
    assert.deepEqual(stepStart.content.step.tools, ['bash']);
    assert.deepEqual(stepStart.content.step.loadSkills, []);
    assert.equal(stepStart.content.workflowDir, wf.dir);

    engine.stop();
  });
});

test('completing a step advances to next and completes the run', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow({
      steps: [
        { id: 's1', name: 's1', instruction: 'first', tools: ['bash'], loadSkills: [], dependsOn: [], successChecks: [], timeout: null, retries: 0, approval: false, condition: null },
        { id: 's2', name: 's2', instruction: 'second', tools: ['read'], loadSkills: [], dependsOn: ['s1'], successChecks: [], timeout: null, retries: 0, approval: false, condition: null },
      ],
    });
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');
    assert.equal(run.state, 'running');

    await bus.emit({
      type: 'workflow:step:complete',
      content: { runId: run.id, stepId: 's1', result: 'done step 1' },
    });

    await waitFor(() => bus.eventsOfType('workflow:step:start').length >= 2);
    assert.ok(bus.eventsOfType('workflow:step:start').length >= 2);
    const secondStart = bus.eventsOfType('workflow:step:start')[1];
    assert.equal(secondStart.content.step.id, 's2');

    await bus.emit({
      type: 'workflow:step:complete',
      content: { runId: run.id, stepId: 's2', result: 'done step 2' },
    });

    await waitFor(() => run.state === 'completed');
    await waitFor(() => bus.eventsOfType('workflow:run:complete').length > 0);
    const completeEvents = bus.eventsOfType('workflow:run:complete');
    assert.ok(completeEvents.length > 0);
    assert.equal(completeEvents[0].content.state, 'completed');
    assert.equal(run.state, 'completed');

    engine.stop();
  });
});

test('dependency ordering prevents step from starting before deps complete', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow({
      steps: [
        { id: 'a', name: 'a', instruction: 'do a', tools: ['bash'], loadSkills: [], dependsOn: [], successChecks: [], timeout: null, retries: 0, approval: false, condition: null },
        { id: 'b', name: 'b', instruction: 'do b', tools: ['bash'], loadSkills: [], dependsOn: ['a'], successChecks: [], timeout: null, retries: 0, approval: false, condition: null },
      ],
    });
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    await engine.startRun('test-wf');

    const starts = bus.eventsOfType('workflow:step:start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].content.step.id, 'a');

    engine.stop();
  });
});

test('successChecks failure retries up to limit then fails the run', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow({
      steps: [
        {
          id: 's1', name: 's1', instruction: 'do it', tools: ['bash'],
          loadSkills: [], dependsOn: [],
          successChecks: [{ type: 'contains', text: 'SUCCESS' }],
          timeout: null, retries: 1, approval: false, condition: null,
        },
      ],
    });
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');

    await bus.emit({
      type: 'workflow:step:complete',
      content: { runId: run.id, stepId: 's1', result: 'FAILURE' },
    });

    await waitFor(() => bus.eventsOfType('workflow:step:start').length >= 2);
    const startsAfterRetry = bus.eventsOfType('workflow:step:start');
    assert.equal(startsAfterRetry.length, 2);

    await bus.emit({
      type: 'workflow:step:complete',
      content: { runId: run.id, stepId: 's1', result: 'FAILURE again' },
    });

    await waitFor(() => run.state === 'failed');
    await waitFor(() => bus.eventsOfType('workflow:run:complete').some((e) => e.content.state === 'failed'));
    assert.equal(run.state, 'failed');
    const completeEvents = bus.eventsOfType('workflow:run:complete');
    assert.ok(completeEvents.some((e) => e.content.state === 'failed'));

    engine.stop();
  });
});

test('successChecks pass after retry', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow({
      steps: [
        {
          id: 's1', name: 's1', instruction: 'do it', tools: ['bash'],
          loadSkills: [], dependsOn: [],
          successChecks: [{ type: 'contains', text: 'SUCCESS' }],
          timeout: null, retries: 1, approval: false, condition: null,
        },
      ],
    });
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');

    await bus.emit({
      type: 'workflow:step:complete',
      content: { runId: run.id, stepId: 's1', result: 'nope' },
    });

    await waitFor(() => bus.eventsOfType('workflow:step:start').length >= 2);
    await bus.emit({
      type: 'workflow:step:complete',
      content: { runId: run.id, stepId: 's1', result: 'SUCCESS here' },
    });

    await waitFor(() => run.state === 'completed');
    assert.equal(run.state, 'completed');
    engine.stop();
  });
});

test('approval gate pauses run and resumeRun continues', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow({
      steps: [
        {
          id: 's1', name: 's1', instruction: 'needs approval', tools: ['bash'],
          loadSkills: [], dependsOn: [], successChecks: [],
          timeout: null, retries: 0, approval: true, condition: null,
        },
      ],
    });
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');
    assert.equal(run.state, 'waiting_approval');

    const approvalEvents = bus.eventsOfType('workflow:needs_approval');
    assert.equal(approvalEvents.length, 1);
    assert.equal(approvalEvents[0].content.stepId, 's1');

    const startsBefore = bus.eventsOfType('workflow:step:start').length;
    await engine.resumeRun(run.id);

    assert.equal(run.state, 'running');
    assert.ok(bus.eventsOfType('workflow:step:start').length > startsBefore);

    engine.stop();
  });
});

test('cancelRun sets state to cancelled and emits run complete', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow();
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');
    await engine.cancelRun(run.id);

    assert.equal(run.state, 'cancelled');
    const completeEvents = bus.eventsOfType('workflow:run:complete');
    assert.ok(completeEvents.some((e) => e.content.state === 'cancelled'));

    engine.stop();
  });
});

test('getRun and listRuns return stored runs', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow();
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');

    assert.equal(engine.getRun(run.id).id, run.id);
    assert.equal(engine.getRun(999), null);
    assert.equal(engine.listRuns().length, 1);

    engine.stop();
  });
});

test('startRun throws for unknown workflow', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const registry = makeRegistry([]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });

    await assert.rejects(engine.startRun('nonexistent'), /not found/);
  });
});

test('persists run state to disk', async () => {
  await withTempDir(async (storageDir) => {
    const bus = new FakeBus();
    const wf = makeWorkflow();
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir });
    engine.start();

    const run = await engine.startRun('test-wf');

    const files = await fs.readdir(storageDir);
    assert.ok(files.some((f) => f.includes(`run-${run.id}`)));

    const content = JSON.parse(await fs.readFile(path.join(storageDir, `run-${run.id}.json`), 'utf8'));
    assert.equal(content.workflowId, 'test-wf');

    engine.stop();
  });
});

test('system workflow steps execute without agent loop and complete run', async () => {
  await withTempDir(async (storageDir) => {
    const workspaceDir = path.join(storageDir, 'workspace');
    const workspaceManager = createWorkspaceManager({ baseDir: workspaceDir });
    await workspaceManager.ensureWorkspace();

    const bus = new FakeBus();
    const wf = makeWorkflow({
      id: 'system-wf',
      steps: [
        {
          id: 'write',
          name: 'write',
          type: 'system_write_file',
          instruction: '',
          path: 'out.txt',
          content: 'hello',
          tools: [],
          loadSkills: [],
          dependsOn: [],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
        },
        {
          id: 'delete',
          name: 'delete',
          type: 'system_delete_file',
          instruction: '',
          path: 'out.txt',
          content: null,
          tools: [],
          loadSkills: [],
          dependsOn: ['write'],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
        },
      ],
    });
    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir, workspaceManager });
    engine.start();

    const run = await engine.startRun('system-wf');
    assert.equal(run.state, 'completed');
    assert.equal(run.steps[0].state, 'completed');
    assert.equal(run.steps[1].state, 'completed');

    const exists = await workspaceManager.exists('out.txt');
    assert.equal(exists, false);
    assert.ok(bus.eventsOfType('workflow:run:complete').some((event) => event.content?.state === 'completed'));

    engine.stop();
  });
});

test('wait_for_input steps pause run, capture user input, and continue', async () => {
  await withTempDir(async (storageDir) => {
    const workspaceDir = path.join(storageDir, 'workspace');
    const workspaceManager = createWorkspaceManager({ baseDir: workspaceDir });
    await workspaceManager.ensureWorkspace();

    const bus = new FakeBus();
    const wf = makeWorkflow({
      id: 'input-wf',
      steps: [
        {
          id: 'ask-name',
          name: 'ask-name',
          type: 'wait_for_input',
          instruction: '',
          prompt: 'What is your name?',
          responseKey: 'user_name',
          tools: [],
          loadSkills: [],
          dependsOn: [],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          path: null,
          content: null,
          mode: null,
        },
        {
          id: 'write-name',
          name: 'write-name',
          type: 'system_write_file',
          instruction: '',
          path: 'name.txt',
          content: '{{args.user_name}}',
          tools: [],
          loadSkills: [],
          dependsOn: ['ask-name'],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          prompt: null,
          responseKey: null,
          mode: null,
        },
      ],
    });

    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir, workspaceManager });
    engine.start();

    const run = await engine.startRun('input-wf');
    assert.equal(run.state, 'waiting_input');
    assert.ok(bus.eventsOfType('workflow:needs_input').length >= 1);
    assert.equal(engine.hasPendingInput(), false);

    await bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 's-input',
      content: { text: 'hello' },
    });

    assert.equal(run.state, 'waiting_input');
    assert.equal(run.args.user_name, undefined);
    assert.equal(run.args.sessionId, 's-input');
    assert.equal(engine.hasPendingInput('s-input'), true);

    await bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 's-input',
      content: { text: 'Morgan' },
    });

    await waitFor(() => run.state === 'completed');
    assert.equal(run.state, 'completed');
    assert.equal(run.args.user_name, 'Morgan');
    assert.equal(await workspaceManager.readTextFile('name.txt'), 'Morgan');

    engine.stop();
  });
});

test('wait_for_input normalizes mixed name answers and can auto-skip prefilled follow-up', async () => {
  await withTempDir(async (storageDir) => {
    const workspaceDir = path.join(storageDir, 'workspace');
    const workspaceManager = createWorkspaceManager({ baseDir: workspaceDir });
    await workspaceManager.ensureWorkspace();

    const bus = new FakeBus();
    const wf = makeWorkflow({
      id: 'mixed-name-wf',
      steps: [
        {
          id: 'ask-user',
          name: 'ask-user',
          type: 'wait_for_input',
          instruction: '',
          prompt: 'Who are you?',
          responseKey: 'user_name',
          tools: [],
          loadSkills: [],
          dependsOn: [],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          path: null,
          content: null,
          mode: null,
        },
        {
          id: 'ask-assistant',
          name: 'ask-assistant',
          type: 'wait_for_input',
          instruction: '',
          prompt: 'Who am I?',
          responseKey: 'assistant_name',
          tools: [],
          loadSkills: [],
          dependsOn: ['ask-user'],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          path: null,
          content: null,
          mode: null,
        },
        {
          id: 'write-both',
          name: 'write-both',
          type: 'system_write_file',
          instruction: '',
          path: 'names.txt',
          content: 'user={{args.user_name}} assistant={{args.assistant_name}}',
          tools: [],
          loadSkills: [],
          dependsOn: ['ask-assistant'],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          prompt: null,
          responseKey: null,
          mode: null,
        },
      ],
    });

    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir, workspaceManager });
    engine.start();

    const run = await engine.startRun('mixed-name-wf');
    assert.equal(run.state, 'waiting_input');

    await bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 'mix-1',
      content: { text: 'Hello' },
    });

    await bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 'mix-1',
      content: { text: 'You are FerretBot. I am Jason.' },
    });

    await waitFor(() => run.state === 'completed');
    assert.equal(run.args.user_name, 'Jason');
    assert.equal(run.args.assistant_name, 'FerretBot');
    assert.equal(await workspaceManager.readTextFile('names.txt'), 'user=Jason assistant=FerretBot');

    engine.stop();
  });
});

test('wait_for_input does not consume mismatched-session input for non-bootstrap runs', async () => {
  await withTempDir(async (storageDir) => {
    const workspaceDir = path.join(storageDir, 'workspace');
    const workspaceManager = createWorkspaceManager({ baseDir: workspaceDir });
    await workspaceManager.ensureWorkspace();

    const bus = new FakeBus();
    const wf = makeWorkflow({
      id: 'session-bound-wf',
      steps: [
        {
          id: 'ask-name',
          name: 'ask-name',
          type: 'wait_for_input',
          instruction: '',
          prompt: 'What is your name?',
          responseKey: 'user_name',
          tools: [],
          loadSkills: [],
          dependsOn: [],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          path: null,
          content: null,
          mode: null,
        },
      ],
    });

    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir, workspaceManager });
    engine.start();

    const run = await engine.startRun('session-bound-wf');
    assert.equal(run.state, 'waiting_input');

    await bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 'session-a',
      content: { text: 'hello' },
    });
    await waitFor(() => run.args.sessionId === 'session-a');
    assert.equal(run.args.sessionId, 'session-a');
    assert.equal(run.args.user_name, undefined);

    await waitFor(() => bus.eventsOfType('workflow:needs_input').length >= 2);
    const needsInputBefore = bus.eventsOfType('workflow:needs_input').length;
    const mismatchedEvent = {
      type: 'user:input',
      channel: 'tui',
      sessionId: 'session-b',
      content: { text: 'Taylor' },
    };
    await bus.emit(mismatchedEvent);
    await delay(10);

    assert.notEqual(mismatchedEvent.__workflowConsumed, true);
    assert.equal(run.state, 'waiting_input');
    assert.equal(run.args.sessionId, 'session-a');
    assert.equal(run.args.user_name, undefined);
    assert.equal(bus.eventsOfType('workflow:needs_input').length, needsInputBefore);

    engine.stop();
  });
});

test('bootstrap wait_for_input rebinds session and re-prompts on reconnect', async () => {
  await withTempDir(async (storageDir) => {
    const workspaceDir = path.join(storageDir, 'workspace');
    const workspaceManager = createWorkspaceManager({ baseDir: workspaceDir });
    await workspaceManager.ensureWorkspace();

    const bus = new FakeBus();
    const wf = makeWorkflow({
      id: 'bootstrap-init',
      steps: [
        {
          id: 'ask-user',
          name: 'ask-user',
          type: 'wait_for_input',
          instruction: '',
          prompt: 'Who are you?',
          responseKey: 'user_name',
          tools: [],
          loadSkills: [],
          dependsOn: [],
          successChecks: [],
          timeout: null,
          retries: 0,
          approval: false,
          condition: null,
          path: null,
          content: null,
          mode: null,
        },
      ],
    });

    const registry = makeRegistry([wf]);
    const engine = createWorkflowEngine({ bus, registry, storageDir, workspaceManager });
    engine.start();

    const run = await engine.startRun('bootstrap-init');
    assert.equal(run.state, 'waiting_input');

    await bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 'session-old',
      content: { text: 'hello' },
    });
    await waitFor(() => run.args.sessionId === 'session-old');
    assert.equal(run.args.sessionId, 'session-old');

    const rebindEvent = {
      type: 'user:input',
      channel: 'tui',
      sessionId: 'session-new',
      content: { text: 'still here' },
    };
    await bus.emit(rebindEvent);
    await waitFor(() => rebindEvent.__workflowConsumed === true);
    await waitFor(() => run.args.sessionId === 'session-new');

    assert.equal(rebindEvent.__workflowConsumed, true);
    assert.equal(run.state, 'waiting_input');
    assert.equal(run.args.sessionId, 'session-new');
    assert.equal(run.args.user_name, undefined);

    await waitFor(() => bus.eventsOfType('workflow:needs_input').some((event) =>
      event.sessionId === 'session-new'
      && event.content?.prompt === 'Who are you?'));
    await waitFor(() => bus.eventsOfType('agent:response').some((event) =>
      event.sessionId === 'session-new'
      && event.content?.text === 'Who are you?'));

    engine.stop();
  });
});
