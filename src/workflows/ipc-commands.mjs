function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function toRunId(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

async function emitCommandResult(bus, event, payload) {
  const requestId = toNonEmptyString(event?.content?.requestId);
  await bus.emit({
    type: 'agent:status',
    sessionId: event?.sessionId ?? undefined,
    content: {
      kind: 'workflow_command_result',
      command: event?.type ?? null,
      requestId,
      ok: payload.ok === true,
      message: toNonEmptyString(payload.message),
      data: payload.data ?? null,
    },
  });
}

function listRuns(workflowEngine) {
  if (!workflowEngine || typeof workflowEngine.listRuns !== 'function') {
    return [];
  }

  return workflowEngine.listRuns()
    .map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

export function registerWorkflowIpcCommands({ bus, workflowEngine, workflowRegistry } = {}) {
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    throw new TypeError('registerWorkflowIpcCommands requires a bus with on/emit methods.');
  }

  if (!workflowEngine) {
    throw new TypeError('registerWorkflowIpcCommands requires workflowEngine.');
  }

  const unsubscribes = [];
  const runDetached = (task) => {
    void task();
  };

  unsubscribes.push(bus.on('workflow:run:start', (event) => {
    runDetached(async () => {
      try {
        const workflowId = toNonEmptyString(event?.content?.workflowId);
        if (!workflowId) {
          throw new Error('workflowId is required.');
        }

        const version = toNonEmptyString(event?.content?.version) ?? undefined;
        const inputArgs = toPlainObject(event?.content?.args);
        const args = { ...inputArgs };

        const sessionId = toNonEmptyString(event?.sessionId);
        if (sessionId && !toNonEmptyString(args.sessionId)) {
          args.sessionId = sessionId;
        }

        const run = await workflowEngine.startRun(workflowId, args, version ? { version } : {});
        await emitCommandResult(bus, event, {
          ok: true,
          message: `workflow run ${run.id} queued.`,
          data: {
            runId: run.id,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion,
            state: run.state,
          },
        });
      } catch (error) {
        await emitCommandResult(bus, event, {
          ok: false,
          message: error?.message ?? String(error),
        });
      }
    });
  }));

  unsubscribes.push(bus.on('workflow:run:cancel', (event) => {
    runDetached(async () => {
      try {
        const runId = toRunId(event?.content?.runId);
        if (!runId) {
          throw new Error('runId must be a positive integer.');
        }

        const run = await workflowEngine.cancelRun(runId);
        await emitCommandResult(bus, event, {
          ok: true,
          message: `workflow run ${run.id} cancelled.`,
          data: {
            runId: run.id,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion,
            state: run.state,
          },
        });
      } catch (error) {
        await emitCommandResult(bus, event, {
          ok: false,
          message: error?.message ?? String(error),
        });
      }
    });
  }));

  unsubscribes.push(bus.on('workflow:run:list', (event) => {
    runDetached(async () => {
      try {
        const workflows = workflowRegistry && typeof workflowRegistry.list === 'function'
          ? workflowRegistry.list()
          : [];
        const runs = listRuns(workflowEngine);
        await emitCommandResult(bus, event, {
          ok: true,
          message: `listed ${workflows.length} workflows and ${runs.length} runs.`,
          data: { workflows, runs },
        });
      } catch (error) {
        await emitCommandResult(bus, event, {
          ok: false,
          message: error?.message ?? String(error),
        });
      }
    });
  }));

  return () => {
    for (const unsubscribe of unsubscribes) {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    }
  };
}
