import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgentLifecycle } from '../../src/core/lifecycle.mjs';

function createOrderRecorder() {
  const order = [];
  return {
    order,
    push(label) {
      order.push(label);
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1200, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
}

test('lifecycle start/shutdown follows expected orchestration order', async () => {
  const recorder = createOrderRecorder();
  const signalSource = new EventEmitter();

  let queueDepth = 1;
  const bus = {
    on() {
      return () => {};
    },
    async emit() {},
    getQueueDepth() {
      const current = queueDepth;
      queueDepth = 0;
      return current;
    },
  };

  const toolRegistry = {
    async registerBuiltIns() {
      recorder.push('tools.registerBuiltIns');
    },
    async execute() {
      return { ok: true };
    },
  };

  const loop = {
    start() {
      recorder.push('agentLoop.start');
    },
    stop() {
      recorder.push('agentLoop.stop');
    },
  };

  const ipcServer = {
    async start() {
      recorder.push('ipc.start');
    },
    async stopAccepting() {
      recorder.push('ipc.stopAccepting');
    },
    async disconnectAllClients() {
      recorder.push('ipc.disconnectAllClients');
    },
  };

  const scheduler = {
    async restore() {
      recorder.push('scheduler.restore');
    },
    async start() {
      recorder.push('scheduler.start');
    },
    async stop() {
      recorder.push('scheduler.stop');
    },
  };

  const lifecycle = createAgentLifecycle({
    signalSource,
    shutdownTimeoutMs: 200,
    drainPollMs: 1,
    loadConfig: async () => {
      recorder.push('config.load');
      return { agent: { maxTokens: 128, maxToolCallsPerStep: 3 } };
    },
    createBus: () => {
      recorder.push('bus.create');
      return bus;
    },
    createProvider: () => {
      recorder.push('provider.create');
      return { chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }) };
    },
    createParser: () => {
      recorder.push('parser.create');
      return { parse: () => ({ kind: 'final', text: '' }) };
    },
    createWorkflowRegistry: () => {
      recorder.push('workflowRegistry.create');
      return {
        async loadAll() { recorder.push('workflowRegistry.loadAll'); },
        get() { return null; },
      };
    },
    createWorkflowEngine: () => {
      recorder.push('workflowEngine.create');
      return {
        start() { recorder.push('workflowEngine.start'); },
        stop() { recorder.push('workflowEngine.stop'); },
      };
    },
    createSkillLoader: () => {
      recorder.push('skills.create');
      return {};
    },
    createSessionMemory: () => {
      recorder.push('session.create');
      return {};
    },
    createWorkspaceManager: () => {
      recorder.push('workspace.create');
      return {
        async ensureWorkspace() {
          recorder.push('workspace.ensure');
        },
      };
    },
    createToolRegistry: () => {
      recorder.push('tools.create');
      return toolRegistry;
    },
    createAgentLoop: () => {
      recorder.push('agentLoop.create');
      return loop;
    },
    createIpcServer: () => {
      recorder.push('ipc.create');
      return ipcServer;
    },
    createScheduler: () => {
      recorder.push('scheduler.create');
      return scheduler;
    },
    persistState: async () => {
      recorder.push('state.persist');
    },
  });

  await lifecycle.start();
  await lifecycle.shutdown('test');

  assert.deepEqual(recorder.order, [
    'config.load',
    'bus.create',
    'provider.create',
    'parser.create',
    'skills.create',
    'session.create',
    'workspace.create',
    'workspace.ensure',
    'workflowRegistry.create',
    'workflowRegistry.loadAll',
    'workflowEngine.create',
    'workflowEngine.start',
    'tools.create',
    'tools.registerBuiltIns',
    'agentLoop.create',
    'agentLoop.start',
    'ipc.create',
    'ipc.start',
    'scheduler.create',
    'scheduler.restore',
    'scheduler.start',
    'ipc.stopAccepting',
    'state.persist',
    'ipc.disconnectAllClients',
    'scheduler.stop',
    'workflowEngine.stop',
    'agentLoop.stop',
  ]);
});

test('lifecycle responds to SIGTERM and shuts down once', async () => {
  const signalSource = new EventEmitter();
  const calls = [];

  const lifecycle = createAgentLifecycle({
    signalSource,
    shutdownTimeoutMs: 200,
    drainPollMs: 1,
    loadConfig: async () => ({}),
    createBus: () => ({
      on() {
        return () => {};
      },
      async emit() {},
      getQueueDepth() {
        return 0;
      },
    }),
    createProvider: () => ({ chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }) }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({ async loadAll() {}, get() { return null; } }),
    createWorkflowEngine: () => ({ start() {}, stop() { calls.push('workflowEngine.stop'); } }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({ async ensureWorkspace() {} }),
    createToolRegistry: () => ({ execute: async () => ({ ok: true }) }),
    createAgentLoop: () => ({
      start() {
        calls.push('loop.start');
      },
      stop() {
        calls.push('loop.stop');
      },
    }),
    createIpcServer: () => ({
      async start() {},
      async stopAccepting() {
        calls.push('ipc.stopAccepting');
      },
      async disconnectAllClients() {
        calls.push('ipc.disconnectAllClients');
      },
    }),
    createScheduler: () => ({
      async restore() {},
      async start() {},
      async stop() {
        calls.push('scheduler.stop');
      },
    }),
    persistState: async ({ reason }) => {
      calls.push(`persist.${reason}`);
    },
  });

  await lifecycle.start();

  signalSource.emit('SIGTERM');
  signalSource.emit('SIGTERM');

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(calls, [
    'loop.start',
    'ipc.stopAccepting',
    'persist.SIGTERM',
    'ipc.disconnectAllClients',
    'scheduler.stop',
    'workflowEngine.stop',
    'loop.stop',
  ]);
});

test('lifecycle default tool registry registers built-in tools', async () => {
  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      tools: {
        rootDir: process.cwd(),
        cwd: process.cwd(),
      },
    }),
    createProvider: () => ({ chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }) }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({ async loadAll() {}, get() { return null; } }),
    createWorkflowEngine: () => ({ start() {}, stop() {} }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({ async ensureWorkspace() {} }),
    createAgentLoop: () => ({
      start() {},
      stop() {},
    }),
    createIpcServer: () => ({
      async start() {},
      async stopAccepting() {},
      async disconnectAllClients() {},
    }),
    createScheduler: () => ({
      async restore() {},
      async start() {},
      async stop() {},
    }),
  });

  const runtime = await lifecycle.start();

  assert.equal(runtime.toolRegistry.has('bash'), true);
  assert.equal(runtime.toolRegistry.has('read'), true);
  assert.equal(runtime.toolRegistry.has('write'), true);
  const toolNames = runtime.toolRegistry.list().map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ['bash', 'edit', 'patch', 'read', 'write']);

  await lifecycle.shutdown('test');
});

test('lifecycle default tool registry reads relative files from current working directory', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-state-'));

  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({}),
    createProvider: () => ({ chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }) }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({ async loadAll() {}, get() { return null; } }),
    createWorkflowEngine: () => ({ start() {}, stop() {} }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({
      baseDir: stateDir,
      async ensureWorkspace() {},
      readTextFile: async () => '',
    }),
    createAgentLoop: () => ({ start() {}, stop() {} }),
    createIpcServer: () => ({
      async start() {},
      async stopAccepting() {},
      async disconnectAllClients() {},
    }),
    createScheduler: () => ({
      async restore() {},
      async start() {},
      async stop() {},
    }),
  });

  try {
    const runtime = await lifecycle.start();
    const readResult = await runtime.toolRegistry.execute({
      name: 'read',
      arguments: { path: 'package.json' },
    });

    assert.match(readResult.content, /\"name\": \"ferretbot\"/);
  } finally {
    await lifecycle.shutdown('test');
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('lifecycle fails fast when provider preflight fails', async () => {
  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({}),
    createProvider: () => ({
      chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }),
      async discoverModelCapabilities() {
        throw new Error('connection refused');
      },
    }),
  });

  await assert.rejects(
    lifecycle.start(),
    /Provider preflight failed\. Ensure LM Studio is running/,
  );
});

test('lifecycle can disable provider preflight in config', async () => {
  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      provider: {
        preflight: false,
      },
    }),
    createProvider: () => ({
      chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }),
      async discoverModelCapabilities() {
        throw new Error('should not run');
      },
    }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({ async loadAll() {}, get() { return null; } }),
    createWorkflowEngine: () => ({ start() {}, stop() {} }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({ async ensureWorkspace() {} }),
    createToolRegistry: () => ({ execute: async () => ({ ok: true }) }),
    createAgentLoop: () => ({ start() {}, stop() {} }),
    createIpcServer: () => ({
      async start() {},
      async stopAccepting() {},
      async disconnectAllClients() {},
    }),
    createScheduler: () => ({
      async restore() {},
      async start() {},
      async stop() {},
    }),
  });

  await lifecycle.start();
  await lifecycle.shutdown('test');
});

test('lifecycle passes discovered provider context window into agent loop config', async () => {
  let capturedLoopConfig = null;

  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      agent: {
        maxToolCallsPerStep: 5,
      },
    }),
    createBus: () => ({
      on() {
        return () => {};
      },
      emit: async () => {},
      getQueueDepth() {
        return 0;
      },
    }),
    createProvider: () => ({
      chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }),
      discoverModelCapabilities: async () => ({ model: 'test-model', contextWindow: 8192 }),
    }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({ async loadAll() {}, get() { return null; } }),
    createWorkflowEngine: () => ({ start() {}, stop() {} }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({ async ensureWorkspace() {} }),
    createToolRegistry: () => ({
      async registerBuiltIns() {},
      execute: async () => ({ ok: true }),
    }),
    createAgentLoop: (config) => {
      capturedLoopConfig = config;
      return {
        start() {},
        stop() {},
      };
    },
    createIpcServer: () => ({
      async start() {},
      async stopAccepting() {},
      async disconnectAllClients() {},
    }),
    createScheduler: () => ({
      async restore() {},
      async start() {},
      async stop() {},
    }),
  });

  await lifecycle.start();
  await lifecycle.shutdown('test');

  assert.ok(capturedLoopConfig);
  assert.equal(capturedLoopConfig.contextLimit, 8192);
});

test('integration: lifecycle processes normal request over in-process bus path', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-int-'));
  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      provider: { preflight: false },
      workspace: { path: stateDir },
      memory: { sessionsDir: path.join(stateDir, 'sessions') },
      workflows: { runsDir: path.join(stateDir, 'runs'), rootDir: path.join(stateDir, 'workflows') },
    }),
    createProvider: () => ({
      async chatCompletion() {
        return {
          text: 'integration ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    }),
    createIpcServer: ({ bus }) => ({
      async start() {
        this.unsubscribe = bus.on('*', async () => {});
      },
      async stopAccepting() {},
      async disconnectAllClients() {
        this.unsubscribe?.();
        this.unsubscribe = null;
      },
    }),
  });

  try {
    const runtime = await lifecycle.start();
    const responses = [];
    runtime.bus.on('agent:response', async (event) => {
      responses.push(event);
    });

    await runtime.bus.emit({
      type: 'user:input',
      channel: 'ipc',
      sessionId: 'client-1',
      content: { text: 'hello', requestId: 'req-normal' },
    });

    await waitFor(() => responses.some((event) => event.content?.requestId === 'req-normal'));
    const response = responses.find((event) => event.content?.requestId === 'req-normal');
    assert.equal(response.content.text, 'integration ok');
  } finally {
    await lifecycle.shutdown('test');
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('integration: lifecycle parse-retry path recovers', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-int-'));
  let calls = 0;
  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      provider: { preflight: false },
      workspace: { path: stateDir },
      memory: { sessionsDir: path.join(stateDir, 'sessions') },
      workflows: { runsDir: path.join(stateDir, 'runs'), rootDir: path.join(stateDir, 'workflows') },
    }),
    createProvider: () => ({
      async chatCompletion() {
        calls += 1;
        if (calls === 1) {
          return {
            text: '{tool:bad',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        return {
          text: 'recovered',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    }),
    createIpcServer: ({ bus }) => ({
      async start() {
        this.unsubscribe = bus.on('*', async () => {});
      },
      async stopAccepting() {},
      async disconnectAllClients() {
        this.unsubscribe?.();
      },
    }),
  });

  try {
    const runtime = await lifecycle.start();
    const responses = [];
    runtime.bus.on('agent:response', async (event) => {
      responses.push(event);
    });

    await runtime.bus.emit({
      type: 'user:input',
      channel: 'ipc',
      sessionId: 'client-2',
      content: { text: 'retry', requestId: 'req-retry' },
    });

    await waitFor(() => responses.some((event) => event.content?.requestId === 'req-retry'));
    const response = responses.find((event) => event.content?.requestId === 'req-retry');
    assert.equal(response.content.text, 'recovered');
    assert.equal(calls, 2);
  } finally {
    await lifecycle.shutdown('test');
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('integration: lifecycle timeout path and restart recovery', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-int-'));
  const ipcStub = ({ bus }) => ({
    async start() {
      this.unsubscribe = bus.on('*', async () => {});
    },
    async stopAccepting() {},
    async disconnectAllClients() {
      this.unsubscribe?.();
    },
  });

  const first = createAgentLifecycle({
    loadConfig: async () => ({
      provider: { preflight: false },
      agent: { turnTimeoutMs: 40 },
      workspace: { path: stateDir },
      memory: { sessionsDir: path.join(stateDir, 'sessions') },
      workflows: { runsDir: path.join(stateDir, 'runs'), rootDir: path.join(stateDir, 'workflows') },
    }),
    createProvider: () => ({
      async chatCompletion() {
        return new Promise(() => {});
      },
    }),
    createIpcServer: ipcStub,
  });

  const second = createAgentLifecycle({
    loadConfig: async () => ({
      provider: { preflight: false },
      workspace: { path: stateDir },
      memory: { sessionsDir: path.join(stateDir, 'sessions') },
      workflows: { runsDir: path.join(stateDir, 'runs'), rootDir: path.join(stateDir, 'workflows') },
    }),
    createProvider: () => ({
      async chatCompletion() {
        return {
          text: 'after restart',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    }),
    createIpcServer: ipcStub,
  });

  try {
    const runtime1 = await first.start();
    const firstResponses = [];
    runtime1.bus.on('agent:response', async (event) => {
      firstResponses.push(event);
    });
    await runtime1.bus.emit({
      type: 'user:input',
      channel: 'ipc',
      sessionId: 'client-timeout',
      content: { text: 'hang', requestId: 'req-timeout' },
    });
    await waitFor(
      () => firstResponses.some((event) => event.content?.requestId === 'req-timeout'),
      { timeoutMs: 1800 },
    );
    const timeoutResponse = firstResponses.find((event) => event.content?.requestId === 'req-timeout');
    assert.equal(timeoutResponse.content.finishReason, 'internal_error');
    assert.match(timeoutResponse.content.text, /timed out/i);
    await first.shutdown('test');

    const runtime2 = await second.start();
    const secondResponses = [];
    runtime2.bus.on('agent:response', async (event) => {
      secondResponses.push(event);
    });
    await runtime2.bus.emit({
      type: 'user:input',
      channel: 'ipc',
      sessionId: 'client-timeout',
      content: { text: 'work', requestId: 'req-after-restart' },
    });
    await waitFor(() => secondResponses.some((event) => event.content?.requestId === 'req-after-restart'));
    const okResponse = secondResponses.find((event) => event.content?.requestId === 'req-after-restart');
    assert.equal(okResponse.content.text, 'after restart');
  } finally {
    await first.shutdown('test');
    await second.shutdown('test');
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
