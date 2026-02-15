/**
 * @deprecated Compatibility adapter — will be removed after the workflow engine
 * (src/workflows/engine.mjs) reaches full feature parity.
 */

const VALID_ACTIONS = new Set(['complete', 'fail', 'note', 'skip']);

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function inferDetail(action, content) {
  if (content && content.length > 0) {
    return content;
  }

  return `Marked step as ${action}.`;
}

class TaskTool {
  #bus;
  #taskManager;

  constructor(options = {}) {
    const { bus, taskManager } = options;

    if (!bus || typeof bus.emit !== 'function') {
      throw new TypeError('TaskTool requires a bus with emit().');
    }

    if (!taskManager || typeof taskManager.getActiveStepContext !== 'function') {
      throw new TypeError('TaskTool requires a taskManager with getActiveStepContext().');
    }

    this.#bus = bus;
    this.#taskManager = taskManager;
  }

  async execute(input = {}) {
    const action = normalizeText(input.action ?? '').toLowerCase();
    if (!VALID_ACTIONS.has(action)) {
      throw new TypeError(`Unsupported task action: ${input.action ?? ''}`);
    }

    const context = this.#taskManager.getActiveStepContext();
    if (!context) {
      throw new Error('No active task step is running.');
    }

    const payload = {
      taskId: context.taskId,
      stepId: context.stepId,
      goal: context.goal,
      instruction: context.instruction,
    };

    switch (action) {
      case 'complete': {
        const result = normalizeText(input.result ?? '');
        await this.#emit('task:step:complete', { ...payload, result });
        return { status: 'completed', detail: inferDetail('complete', result) };
      }
      case 'fail': {
        const reason = normalizeText(input.reason ?? '');
        if (!reason) {
          throw new TypeError('reason is required when failing a step.');
        }
        await this.#emit('task:step:failed', { ...payload, reason });
        return { status: 'failed', detail: inferDetail('failed', reason) };
      }
      case 'note': {
        const note = normalizeText(input.content ?? '');
        if (!note) {
          throw new TypeError('content is required when adding a note.');
        }
        await this.#emit('task:note', { ...payload, content: note });
        return { status: 'noted', detail: `Stored note: ${note}` };
      }
      case 'skip': {
        const reason = normalizeText(input.reason ?? '');
        await this.#emit('task:step:skipped', { ...payload, reason });
        return { status: 'skipped', detail: inferDetail('skip', reason) };
      }
      default:
        throw new TypeError(`Unhandled action: ${action}`);
    }
  }

  async #emit(type, content) {
    await this.#bus.emit({ type, content });
  }
}

export function createTaskTool(options) {
  return new TaskTool(options);
}

export { TaskTool };
