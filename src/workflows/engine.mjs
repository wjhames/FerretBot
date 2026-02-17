import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evaluateChecks } from './checks.mjs';
import { DEFAULT_AGENT_DIR } from '../core/config-defaults.mjs';

const DEFAULT_RUNS_DIR = path.join(DEFAULT_AGENT_DIR, 'workflow-runs');

const RUN_STATE = {
  queued: 'queued',
  running: 'running',
  waitingApproval: 'waiting_approval',
  waitingInput: 'waiting_input',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const STEP_STATE = {
  pending: 'pending',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

const SUCCESS_STATES = new Set([STEP_STATE.completed, STEP_STATE.skipped]);

function formatIsoNow() {
  return new Date().toISOString();
}

function coerceInputText(event) {
  const content = event?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim();
  }
  return String(content ?? '').trim();
}

function resolvePathValue(objectValue, pathValue) {
  if (!pathValue) {
    return '';
  }

  const parts = String(pathValue).split('.').filter(Boolean);
  let current = objectValue;
  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !(part in current)) {
      return '';
    }
    current = current[part];
  }

  if (current == null) {
    return '';
  }

  return String(current);
}

function createRunRecord(id, workflow, args) {
  return {
    id,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    state: RUN_STATE.queued,
    args: args ?? {},
    approvedStepId: null,
    steps: workflow.steps.map((step) => ({
      id: step.id,
      state: STEP_STATE.pending,
      result: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      checkResults: null,
    })),
    createdAt: formatIsoNow(),
    updatedAt: formatIsoNow(),
  };
}

export class WorkflowEngine {
  #bus;
  #registry;
  #storageDir;
  #workspaceManager;
  #runs = new Map();
  #storageReady = false;
  #nextId = 1;
  #unsubscribes = [];

  constructor(options = {}) {
    const { bus, registry, storageDir = DEFAULT_RUNS_DIR, workspaceManager = null } = options;

    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
      throw new TypeError('WorkflowEngine requires a bus with on/emit methods.');
    }

    if (!registry || typeof registry.get !== 'function') {
      throw new TypeError('WorkflowEngine requires a registry with get().');
    }

    this.#bus = bus;
    this.#registry = registry;
    this.#storageDir = storageDir;
    this.#workspaceManager = workspaceManager;
  }

  start() {
    if (this.#unsubscribes.length > 0) return;

    this.#unsubscribes.push(
      this.#bus.on('workflow:step:complete', (event) => {
        void this.#handleStepComplete(event);
      }),
    );
    this.#unsubscribes.push(
      this.#bus.on('user:input', (event) => {
        void this.#handleUserInput(event);
      }),
    );
  }

  stop() {
    for (const unsub of this.#unsubscribes) {
      if (typeof unsub === 'function') unsub();
    }
    this.#unsubscribes = [];
  }

  async startRun(workflowId, args = {}, options = {}) {
    const version = options.version ?? undefined;
    const workflow = this.#registry.get(workflowId, version);
    if (!workflow) {
      throw new Error(`workflow '${workflowId}' not found in registry.`);
    }

    const run = createRunRecord(this.#nextId++, workflow, args);
    this.#runs.set(run.id, run);
    await this.#persistRun(run);

    await this.#bus.emit({
      type: 'workflow:run:queued',
      content: { runId: run.id, workflowId: workflow.id },
    });

    await this.#advance(run);
    return run;
  }

  async resumeRun(runId) {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found.`);

    if (run.state !== RUN_STATE.waitingApproval) {
      throw new Error(`run ${runId} is not waiting for approval (state: ${run.state}).`);
    }

    run.state = RUN_STATE.running;
    run.updatedAt = formatIsoNow();
    await this.#persistRun(run);

    await this.#advance(run);
    return run;
  }

  async cancelRun(runId) {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found.`);

    run.state = RUN_STATE.cancelled;
    run.updatedAt = formatIsoNow();
    await this.#persistRun(run);

    await this.#bus.emit({
      type: 'workflow:run:complete',
      content: { runId: run.id, workflowId: run.workflowId, state: RUN_STATE.cancelled },
    });

    return run;
  }

  getRun(runId) {
    return this.#runs.get(runId) ?? null;
  }

  listRuns() {
    return [...this.#runs.values()];
  }

  hasPendingInput(sessionId = null) {
    if (!sessionId) {
      return false;
    }

    return this.listRuns().some((run) =>
      run.state === RUN_STATE.waitingInput
      && run.args
      && typeof run.args === 'object'
      && run.args.sessionId === sessionId,
    );
  }

  async #handleStepComplete(event) {
    const runId = event?.content?.runId;
    const stepId = event?.content?.stepId;
    const result = event?.content?.result ?? '';

    const run = this.#runs.get(runId);
    if (!run) return;

    const workflow = this.#registry.get(run.workflowId, run.workflowVersion);
    if (!workflow) return;

    const runStep = run.steps.find((s) => s.id === stepId);
    if (!runStep || runStep.state !== STEP_STATE.active) return;

    const workflowStep = workflow.steps.find((s) => s.id === stepId);
    await this.#completeActiveStep({
      run,
      runStep,
      workflowStep,
      result,
      toolResults: [],
      emitStepCompleteEvent: false,
    });
  }

  async #advance(run) {
    if (run.state === RUN_STATE.cancelled || run.state === RUN_STATE.failed) return;

    const workflow = this.#registry.get(run.workflowId, run.workflowVersion);
    if (!workflow) return;

    const nextStep = this.#findNextReadyStep(run);
    if (!nextStep) {
      if (this.#isRunComplete(run)) {
        run.state = RUN_STATE.completed;
        run.updatedAt = formatIsoNow();
        await this.#persistRun(run);
        await this.#bus.emit({
          type: 'workflow:run:complete',
          content: { runId: run.id, workflowId: run.workflowId, state: RUN_STATE.completed },
        });
      }
      return;
    }

    const workflowStep = workflow.steps.find((s) => s.id === nextStep.id);

    if (workflowStep?.approval && run.approvedStepId !== nextStep.id) {
      run.state = RUN_STATE.waitingApproval;
      run.approvedStepId = nextStep.id;
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);
      await this.#bus.emit({
        type: 'workflow:needs_approval',
        content: {
          runId: run.id,
          stepId: nextStep.id,
          instruction: workflowStep.instruction,
        },
      });
      return;
    }

    run.approvedStepId = null;
    nextStep.state = STEP_STATE.active;
    nextStep.startedAt = formatIsoNow();
    run.state = RUN_STATE.running;
    run.updatedAt = formatIsoNow();
    await this.#persistRun(run);

    await this.#bus.emit({
      type: 'workflow:step:start',
      content: {
        runId: run.id,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        workflowDir: workflow.dir ?? null,
        step: {
          id: workflowStep.id,
          type: workflowStep.type ?? 'agent',
          instruction: workflowStep.instruction,
          tools: [...workflowStep.tools],
          loadSkills: [...(workflowStep.loadSkills ?? [])],
          total: workflow.steps.length,
        },
      },
    });

    const stepType = String(workflowStep?.type ?? 'agent');
    if (stepType === 'wait_for_input') {
      const responseKey = workflowStep?.responseKey;
      const existingValue = responseKey && run.args && typeof run.args === 'object'
        ? String(run.args[responseKey] ?? '').trim()
        : '';
      if (existingValue) {
        await this.#completeActiveStep({
          run,
          runStep: nextStep,
          workflowStep,
          result: existingValue,
          toolResults: [],
          emitStepCompleteEvent: false,
        });
        return;
      }

      run.state = RUN_STATE.waitingInput;
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);

      const prompt = String(workflowStep?.prompt ?? '').trim();
      await this.#bus.emit({
        type: 'workflow:needs_input',
        sessionId: run.args?.sessionId ?? undefined,
        content: {
          runId: run.id,
          stepId: workflowStep.id,
          prompt,
          responseKey: workflowStep.responseKey,
        },
      });

      await this.#bus.emit({
        type: 'agent:response',
        sessionId: run.args?.sessionId ?? undefined,
        content: {
          text: prompt,
          finishReason: 'workflow_input',
        },
      });
      return;
    }

    if (stepType !== 'agent') {
      await this.#executeSystemStep(run, workflowStep, nextStep);
    }
  }

  async #executeSystemStep(run, workflowStep, runStep) {
    let result = '';
    let failedReason = '';

    try {
      const type = String(workflowStep?.type ?? '');
      const stepPath = workflowStep?.path;
      const content = this.#renderTemplate(workflowStep?.content ?? '', run);

      if (!this.#workspaceManager) {
        throw new Error('workspaceManager is required for system workflow steps.');
      }

      if (type === 'system_write_file') {
        await this.#workspaceManager.writeTextFile(stepPath, String(content));
        result = `Wrote ${stepPath}`;
      } else if (type === 'system_ensure_file') {
        await this.#workspaceManager.ensureTextFile(stepPath, String(content));
        result = `Ensured ${stepPath}`;
      } else if (type === 'system_delete_file') {
        await this.#workspaceManager.removePath(stepPath);
        result = `Deleted ${stepPath}`;
      } else {
        throw new Error(`Unsupported system step type '${type}'.`);
      }
    } catch (error) {
      failedReason = error?.message ?? String(error);
    }

    if (failedReason) {
      runStep.state = STEP_STATE.failed;
      runStep.result = failedReason;
      runStep.completedAt = formatIsoNow();
      run.state = RUN_STATE.failed;
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);
      await this.#bus.emit({
        type: 'workflow:run:complete',
        content: { runId: run.id, workflowId: run.workflowId, state: RUN_STATE.failed },
      });
      return;
    }

    await this.#completeActiveStep({
      run,
      runStep,
      workflowStep,
      result,
      toolResults: [],
      emitStepCompleteEvent: true,
    });
  }

  async #completeActiveStep({
    run,
    runStep,
    workflowStep,
    result,
    toolResults = [],
    emitStepCompleteEvent = false,
  }) {
    const checks = workflowStep?.successChecks ?? [];

    const checkResult = await evaluateChecks(checks, {
      stepOutput: result,
      toolResults,
      workflowInputs: run.args,
      stepResults: this.#buildStepResults(run),
    });

    runStep.checkResults = checkResult.results;

    if (checkResult.passed) {
      runStep.state = STEP_STATE.completed;
      runStep.result = result;
      runStep.completedAt = formatIsoNow();
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);

      if (emitStepCompleteEvent) {
        await this.#bus.emit({
          type: 'workflow:step:complete',
          content: {
            runId: run.id,
            stepId: runStep.id,
            result,
          },
        });
      }

      await this.#advance(run);
      return;
    }

    if (runStep.retryCount < (workflowStep?.retries ?? 0)) {
      runStep.retryCount += 1;
      runStep.state = STEP_STATE.pending;
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);
      await this.#advance(run);
      return;
    }

    runStep.state = STEP_STATE.failed;
    runStep.completedAt = formatIsoNow();
    run.state = RUN_STATE.failed;
    run.updatedAt = formatIsoNow();
    await this.#persistRun(run);
    await this.#bus.emit({
      type: 'workflow:run:complete',
      content: { runId: run.id, workflowId: run.workflowId, state: RUN_STATE.failed },
    });
  }

  async #handleUserInput(event) {
    const run = this.#findRunWaitingForInput(event?.sessionId ?? null);
    if (!run) {
      return;
    }

    const workflow = this.#registry.get(run.workflowId, run.workflowVersion);
    if (!workflow) {
      return;
    }

    const runStep = run.steps.find((step) => step.state === STEP_STATE.active);
    if (!runStep) {
      return;
    }

    const workflowStep = workflow.steps.find((step) => step.id === runStep.id);
    if (!workflowStep || String(workflowStep.type ?? 'agent') !== 'wait_for_input') {
      return;
    }

    if (!run.args || typeof run.args !== 'object') {
      run.args = {};
    }

    const incomingSessionId = event?.sessionId ?? null;
    const boundSessionId = run.args.sessionId ?? null;
    if (!boundSessionId && incomingSessionId) {
      run.args.sessionId = incomingSessionId;
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);

      event.__workflowConsumed = true;

      const prompt = String(workflowStep?.prompt ?? '').trim();
      await this.#bus.emit({
        type: 'workflow:needs_input',
        sessionId: incomingSessionId,
        content: {
          runId: run.id,
          stepId: workflowStep.id,
          prompt,
          responseKey: workflowStep.responseKey,
        },
      });
      await this.#bus.emit({
        type: 'agent:response',
        sessionId: incomingSessionId,
        content: {
          text: prompt,
          finishReason: 'workflow_input',
        },
      });
      return;
    }

    if (boundSessionId && incomingSessionId && boundSessionId !== incomingSessionId) {
      return;
    }

    const inputText = coerceInputText(event);
    if (!inputText) {
      return;
    }

    run.args[workflowStep.responseKey] = inputText;
    run.state = RUN_STATE.running;
    run.updatedAt = formatIsoNow();
    await this.#persistRun(run);

    event.__workflowConsumed = true;

    await this.#completeActiveStep({
      run,
      runStep,
      workflowStep,
      result: inputText,
      toolResults: [],
      emitStepCompleteEvent: false,
    });
  }

  #findRunWaitingForInput(sessionId = null) {
    const candidates = this.listRuns()
      .filter((run) => run.state === RUN_STATE.waitingInput)
      .sort((left, right) => left.id - right.id);

    if (candidates.length === 0) {
      return null;
    }

    if (sessionId && sessionId.length > 0) {
      const matched = candidates.find((run) =>
        !run.args?.sessionId || run.args.sessionId === sessionId,
      );
      if (matched) {
        return matched;
      }
    }

    return candidates[0];
  }

  #renderTemplate(text, run) {
    const source = String(text ?? '');
    return source.replace(/\{\{\s*args\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, keyPath) => (
      resolvePathValue(run.args ?? {}, keyPath)
    ));
  }

  #findNextReadyStep(run) {
    const workflow = this.#registry.get(run.workflowId, run.workflowVersion);
    if (!workflow) return null;

    for (const runStep of run.steps) {
      if (runStep.state !== STEP_STATE.pending) continue;

      const workflowStep = workflow.steps.find((s) => s.id === runStep.id);
      if (!workflowStep) continue;

      const deps = workflowStep.dependsOn ?? [];
      const allSatisfied = deps.every((depId) => {
        const dep = run.steps.find((s) => s.id === depId);
        return dep && SUCCESS_STATES.has(dep.state);
      });

      if (!allSatisfied) continue;
      return runStep;
    }

    return null;
  }

  #isRunComplete(run) {
    return run.steps.every((s) => SUCCESS_STATES.has(s.state));
  }

  #buildStepResults(run) {
    const results = new Map();
    for (const step of run.steps) {
      if (step.state === STEP_STATE.completed && step.result != null) {
        results.set(step.id, step.result);
      }
    }
    return results;
  }

  async #persistRun(run) {
    await this.#ensureStorageDir();
    const filePath = path.join(this.#storageDir, `run-${run.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(run, null, 2), 'utf8');
  }

  async #ensureStorageDir() {
    if (this.#storageReady) return;
    await fs.mkdir(this.#storageDir, { recursive: true });
    this.#storageReady = true;
  }
}

export function createWorkflowEngine(options) {
  return new WorkflowEngine(options);
}
