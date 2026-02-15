/**
 * @deprecated Compatibility adapter — will be removed after the workflow engine
 * (src/workflows/engine.mjs) reaches full feature parity.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TASKS_DIR = path.join(os.homedir(), '.agent', 'tasks');
const DEFAULT_STEP_STATE = {
  pending: 'pending',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

const DEFAULT_TASK_STATE = {
  planned: 'planned',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

const SUCCESS_STEP_STATES = new Set([DEFAULT_STEP_STATE.completed, DEFAULT_STEP_STATE.skipped]);

function formatIsoNow() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function createTaskRecord(id, plan) {
  return {
    id,
    goal: plan.goal,
    state: DEFAULT_TASK_STATE.planned,
    currentStepId: null,
    createdAt: formatIsoNow(),
    updatedAt: formatIsoNow(),
    steps: plan.steps.map((step) => ({
      ...step,
      state: DEFAULT_STEP_STATE.pending,
      result: null,
      startedAt: null,
      completedAt: null,
      notes: [],
    })),
    notes: [],
  };
}

function formatStepForEvent(step, totalSteps) {
  return {
    id: step.id,
    instruction: step.instruction,
    tools: Array.isArray(step.tools) ? [...step.tools] : [],
    skill: step.skill ?? null,
    dependsOn: Array.isArray(step.dependsOn) ? [...step.dependsOn] : [],
    total: totalSteps,
  };
}

function ensureList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

export class TaskManager {
  #bus;
  #storageDir;
  #tasks = new Map();
  #pendingQueue = [];
  #runningTaskId = null;
  #storageReady = false;
  #nextId = 1;

  constructor(options = {}) {
    const { bus, storageDir = DEFAULT_TASKS_DIR, startListening = true } = options;

    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
      throw new TypeError('TaskManager requires a bus with on/emit methods.');
    }

    this.#bus = bus;
    this.#storageDir = storageDir;

    if (startListening) {
      this.#bus.on('task:step:complete', (event) => {
        void this.#handleStepComplete(event);
      });
      this.#bus.on('task:step:failed', (event) => {
        void this.#handleStepFailed(event);
      });
      this.#bus.on('task:step:skipped', (event) => {
        void this.#handleStepSkipped(event);
      });
      this.#bus.on('task:note', (event) => {
        void this.#handleNoteEvent(event);
      });
    }
  }

  async createTask(plan) {
    if (!plan || typeof plan !== 'object') {
      throw new TypeError('Plan must be an object.');
    }

    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new TypeError('Plan must include at least one step.');
    }

    const task = createTaskRecord(this.#nextId++, plan);
    this.#tasks.set(task.id, task);
    this.#pendingQueue.push(task.id);
    await this.#persistTask(task);

    void this.#bus.emit({
      type: 'task:created',
      content: {
        taskId: task.id,
        goal: task.goal,
      },
    });

    await this.#tryScheduleNext();

    return task;
  }

  getTask(id) {
    if (!Number.isInteger(id)) {
      return null;
    }

    return this.#tasks.get(id) ?? null;
  }

  async getPriorStepResults(taskId) {
    const task = this.getTask(taskId);
    if (!task) {
      return [];
    }

    return task.steps
      .filter((step) => step.state === DEFAULT_STEP_STATE.completed && typeof step.result === 'string' && step.result.length > 0)
      .map((step) => ({
        id: step.id,
        instruction: step.instruction,
        result: step.result,
      }));
  }

  getActiveStepContext() {
    const context = this.#getRunningContext();
    if (!context) {
      return null;
    }

    const { task, step } = context;
    return {
      taskId: task.id,
      goal: task.goal,
      stepId: step.id,
      instruction: step.instruction,
      totalSteps: task.steps.length,
    };
  }

  async #handleStepComplete(event) {
    if (this.#runningTaskId == null) {
      return;
    }

    const task = this.#tasks.get(this.#runningTaskId);
    if (!task) {
      return;
    }

    const activeStep = task.steps.find((step) => step.id === task.currentStepId);
    if (!activeStep) {
      return;
    }

    activeStep.state = DEFAULT_STEP_STATE.completed;
    activeStep.completedAt = formatIsoNow();
    activeStep.result = typeof event?.content?.result === 'string' ? event.content.result : null;
    task.currentStepId = null;
    task.updatedAt = formatIsoNow();

    await this.#persistTask(task);

    this.#runningTaskId = null;
    await this.#tryScheduleNext();
  }

  #getRunningContext() {
    if (!Number.isInteger(this.#runningTaskId)) {
      return null;
    }

    const task = this.#tasks.get(this.#runningTaskId);
    if (!task) {
      return null;
    }

    const step = task.steps.find((entry) => entry.id === task.currentStepId);
    if (!step) {
      return null;
    }

    return { task, step };
  }

  async #handleStepFailed(event) {
    const context = this.#getRunningContext();
    if (!context) {
      return;
    }

    const { task, step } = context;
    const reason = normalizeText(event?.content?.reason ?? '');

    step.state = DEFAULT_STEP_STATE.failed;
    step.completedAt = formatIsoNow();
    if (reason.length > 0) {
      step.result = reason;
    }

    task.currentStepId = null;
    task.state = DEFAULT_TASK_STATE.failed;
    task.updatedAt = formatIsoNow();

    await this.#persistTask(task);

    this.#runningTaskId = null;
    await this.#bus.emit({
      type: 'task:failed',
      content: {
        taskId: task.id,
        goal: task.goal,
        stepId: step.id,
        reason: reason || 'step failed',
      },
    });

    await this.#tryScheduleNext();
  }

  async #handleStepSkipped(event) {
    const context = this.#getRunningContext();
    if (!context) {
      return;
    }

    const { task, step } = context;
    const note = normalizeText(event?.content?.reason ?? '');

    step.state = DEFAULT_STEP_STATE.skipped;
    step.completedAt = formatIsoNow();
    if (note.length > 0) {
      step.result = note;
    }

    task.currentStepId = null;
    task.updatedAt = formatIsoNow();

    await this.#persistTask(task);

    this.#runningTaskId = null;
    await this.#tryScheduleNext();
  }

  async #handleNoteEvent(event) {
    const context = this.#getRunningContext();
    if (!context) {
      return;
    }

    const { task, step } = context;
    const content = normalizeText(event?.content?.content ?? '');
    if (!content) {
      return;
    }

    step.notes.push({
      content,
      timestamp: formatIsoNow(),
    });

    task.updatedAt = formatIsoNow();
    await this.#persistTask(task);
  }

  async #tryScheduleNext() {
    if (this.#runningTaskId != null) {
      return;
    }

    while (this.#pendingQueue.length > 0) {
      const taskId = this.#pendingQueue[0];
      const task = this.#tasks.get(taskId);

      if (!task) {
        this.#pendingQueue.shift();
        continue;
      }

      if (task.state === DEFAULT_TASK_STATE.completed || task.state === DEFAULT_TASK_STATE.failed) {
        this.#pendingQueue.shift();
        continue;
      }

      const readyStep = this.#findNextReadyStep(task);
      if (!readyStep) {
        if (this.#isTaskComplete(task)) {
          task.state = DEFAULT_TASK_STATE.completed;
          task.updatedAt = formatIsoNow();
          await this.#persistTask(task);
          this.#pendingQueue.shift();
          await this.#bus.emit({
            type: 'task:complete',
            content: { taskId: task.id, goal: task.goal },
          });
          continue;
        }

        return;
      }

      await this.#startStep(task, readyStep);
      return;
    }
  }

  #isTaskComplete(task) {
    return task.steps.every((step) => step.state === DEFAULT_STEP_STATE.completed);
  }

  #findNextReadyStep(task) {
    for (const step of task.steps) {
      if (step.state !== DEFAULT_STEP_STATE.pending) {
        continue;
      }

      const dependencies = ensureList(step.dependsOn);
      const allSatisfied = dependencies.every((depId) => {
        const preceding = task.steps.find((candidate) => candidate.id === depId);
        return preceding && SUCCESS_STEP_STATES.has(preceding.state);
      });

      if (!allSatisfied) {
        continue;
      }

      return step;
    }

    return null;
  }

  async #startStep(task, step) {
    step.state = DEFAULT_STEP_STATE.active;
    step.startedAt = formatIsoNow();
    task.currentStepId = step.id;
    task.state = DEFAULT_TASK_STATE.running;
    task.updatedAt = formatIsoNow();

    await this.#persistTask(task);

    this.#runningTaskId = task.id;

    await this.#bus.emit({
      type: 'task:step:start',
      content: {
        taskId: task.id,
        goal: task.goal,
        step: formatStepForEvent(step, task.steps.length),
      },
    });
  }

  async #persistTask(task) {
    await this.#ensureStorageDir();

    const filePath = path.join(this.#storageDir, `task-${task.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(task, null, 2), 'utf8');
  }

  async #ensureStorageDir() {
    if (this.#storageReady) {
      return;
    }

    await fs.mkdir(this.#storageDir, { recursive: true });
    this.#storageReady = true;
  }
}

export function createTaskManager(options) {
  return new TaskManager(options);
}
