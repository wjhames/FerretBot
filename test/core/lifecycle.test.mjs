import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

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

test('lifecycle start/shutdown follows expected orchestration order', async () => {
  const recorder = createOrderRecorder();
  const signalSource = new EventEmitter();

  let queueDepth = 1;
  const bus = {
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
      getQueueDepth() {
        return 0;
      },
    }),
    createProvider: () => ({ chatCompletion: async () => ({ text: '', usage: {}, finishReason: 'stop' }) }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
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
    'loop.stop',
  ]);
});
