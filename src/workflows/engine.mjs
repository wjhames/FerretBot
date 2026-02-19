import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evaluateChecks } from './checks.mjs';
import { DEFAULT_AGENT_DIR } from '../core/config-defaults.mjs';

const DEFAULT_RUNS_DIR = path.join(DEFAULT_AGENT_DIR, 'workflow-runs');

const RUN_STATE = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  blocked: 'blocked',
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
    steps: workflow.steps.map((step) => ({
      id: step.id,
      state: STEP_STATE.pending,
      result: null,
      resultMeta: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      attemptCount: 0,
      lastFailureHash: null,
      checkResults: null,
    })),
    failure: null,
    createdAt: formatIsoNow(),
    updatedAt: formatIsoNow(),
  };
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
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

  async cancelRun(runId) {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found.`);

    run.state = RUN_STATE.cancelled;
    run.failure = null;
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

  async #handleStepComplete(event) {
    const runId = event?.content?.runId;
    const stepId = event?.content?.stepId;
    const resultText = event?.content?.resultText ?? event?.content?.result ?? '';
    const toolResults = Array.isArray(event?.content?.toolResults) ? event.content.toolResults : [];
    const toolCalls = Array.isArray(event?.content?.toolCalls) ? event.content.toolCalls : [];
    const artifacts = Array.isArray(event?.content?.artifacts) ? event.content.artifacts : [];

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
      resultText,
      toolResults,
      toolCalls,
      artifacts,
      emitStepCompleteEvent: false,
    });
  }

  async #advance(run) {
    if (run.state === RUN_STATE.cancelled || run.state === RUN_STATE.failed || run.state === RUN_STATE.blocked) return;

    const workflow = this.#registry.get(run.workflowId, run.workflowVersion);
    if (!workflow) return;

    const nextStep = this.#findNextReadyStep(run);
    if (!nextStep) {
      if (this.#isRunComplete(run)) {
        run.state = RUN_STATE.completed;
        run.failure = null;
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
    if (stepType !== 'agent') {
      await this.#executeSystemStep(run, workflowStep, nextStep);
    }
  }

  async #executeSystemStep(run, workflowStep, runStep) {
    let resultText = '';
    let artifacts = [];
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
        resultText = `Wrote ${stepPath}`;
        artifacts = [String(stepPath)];
      } else if (type === 'system_ensure_file') {
        await this.#workspaceManager.ensureTextFile(stepPath, String(content));
        resultText = `Ensured ${stepPath}`;
        artifacts = [String(stepPath)];
      } else if (type === 'system_delete_file') {
        await this.#workspaceManager.removePath(stepPath);
        resultText = `Deleted ${stepPath}`;
        artifacts = [String(stepPath)];
      } else {
        throw new Error(`Unsupported system step type '${type}'.`);
      }
    } catch (error) {
      failedReason = error?.message ?? String(error);
    }

    if (failedReason) {
      await this.#failRun({
        run,
        runStep,
        state: RUN_STATE.failed,
        code: 'tool_error',
        message: failedReason,
      });
      return;
    }

    await this.#completeActiveStep({
      run,
      runStep,
      workflowStep,
      resultText,
      toolResults: [],
      toolCalls: [],
      artifacts,
      emitStepCompleteEvent: true,
    });
  }

  async #completeActiveStep({
    run,
    runStep,
    workflowStep,
    resultText,
    toolResults = [],
    toolCalls = [],
    artifacts = [],
    emitStepCompleteEvent = false,
  }) {
    runStep.attemptCount += 1;
    const checks = workflowStep?.successChecks ?? [];

    const normalizedResultText = String(resultText ?? '');
    const checkResult = await evaluateChecks(checks, {
      stepOutput: normalizedResultText,
      toolResults,
      workflowInputs: run.args,
      stepResults: this.#buildStepResults(run),
    });

    runStep.checkResults = checkResult.results;

    if (checkResult.passed) {
      runStep.state = STEP_STATE.completed;
      runStep.result = normalizedResultText;
      runStep.resultMeta = {
        toolCalls,
        toolResults,
        artifacts,
      };
      runStep.lastFailureHash = null;
      runStep.completedAt = formatIsoNow();
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);

      if (emitStepCompleteEvent) {
        await this.#bus.emit({
          type: 'workflow:step:complete',
          content: {
            runId: run.id,
            stepId: runStep.id,
            result: normalizedResultText,
            resultText: normalizedResultText,
            toolCalls,
            toolResults,
            artifacts,
          },
        });
      }

      await this.#advance(run);
      return;
    }

    const failureHash = stableStringify({
      resultText: normalizedResultText,
      toolResults,
      artifacts,
    });
    if (runStep.lastFailureHash === failureHash) {
      await this.#failRun({
        run,
        runStep,
        state: RUN_STATE.blocked,
        code: 'no_progress',
        message: `step '${runStep.id}' repeated identical failed output.`,
      });
      return;
    }
    runStep.lastFailureHash = failureHash;

    if (runStep.retryCount < (workflowStep?.retries ?? 0)) {
      runStep.retryCount += 1;
      runStep.state = STEP_STATE.pending;
      run.updatedAt = formatIsoNow();
      await this.#persistRun(run);
      await this.#advance(run);
      return;
    }

    await this.#failRun({
      run,
      runStep,
      state: RUN_STATE.failed,
      code: 'check_failed',
      message: `step '${runStep.id}' failed successChecks.`,
    });
  }

  async #failRun({
    run,
    runStep,
    state = RUN_STATE.failed,
    code,
    message,
  }) {
    runStep.state = STEP_STATE.failed;
    runStep.completedAt = formatIsoNow();
    run.state = state;
    run.failure = {
      code,
      message,
      stepId: runStep.id,
      attempts: runStep.attemptCount,
    };
    run.updatedAt = formatIsoNow();
    await this.#persistRun(run);
    await this.#bus.emit({
      type: 'workflow:run:complete',
      content: { runId: run.id, workflowId: run.workflowId, state: run.state },
    });
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
