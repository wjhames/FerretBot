import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentLifecycle } from '../../src/core/lifecycle.mjs';

test('lifecycle auto-starts bootstrap workflow when workspace bootstrap is active', async () => {
  const calls = [];

  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      workspace: { path: '/tmp/ferretbot-workspace' },
      workflows: { rootDir: '/tmp/ferretbot-workspace/workflows', runsDir: '/tmp/ferretbot-runs' },
      tools: { rootDir: process.cwd(), cwd: process.cwd() },
    }),
    createBus: () => ({
      on() {
        return () => {};
      },
      async emit() {},
      getQueueDepth() {
        return 0;
      },
    }),
    createProvider: () => ({ chatCompletion: async () => ({ text: '', toolCalls: [], finishReason: 'stop', usage: {} }) }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({
      async loadAll() {},
      get(id, version) {
        if (id === 'bootstrap-init' && version === '1.0.0') {
          return { id: 'bootstrap-init', version: '1.0.0', steps: [] };
        }
        return null;
      },
    }),
    createWorkflowEngine: () => ({
      start() {},
      stop() {},
      listRuns() { return []; },
      async startRun(id, args, options) {
        calls.push({ id, args, options });
        return { id: 1, workflowId: id, state: 'queued' };
      },
    }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({
      baseDir: '/tmp/ferretbot-workspace',
      async ensureWorkspace() {},
      resolve(...segments) { return segments.join('/'); },
      async ensureTextFile() {},
      async readTextFile(relativePath) {
        if (relativePath === 'BOOTSTRAP.md') return 'bootstrap pending';
        if (relativePath === '.bootstrap-complete') return '';
        return '';
      },
      async writeTextFile() {},
      async exists() { return true; },
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
    createAgentLoop: () => ({
      start() {},
      stop() {},
    }),
  });

  await lifecycle.start();
  await lifecycle.shutdown('test');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'bootstrap-init');
  assert.equal(calls[0].options.version, '1.0.0');
});

test('lifecycle does not start duplicate bootstrap run when one is waiting_input', async () => {
  const calls = [];

  const lifecycle = createAgentLifecycle({
    loadConfig: async () => ({
      workspace: { path: '/tmp/ferretbot-workspace' },
      workflows: { rootDir: '/tmp/ferretbot-workspace/workflows', runsDir: '/tmp/ferretbot-runs' },
      tools: { rootDir: process.cwd(), cwd: process.cwd() },
    }),
    createBus: () => ({
      on() {
        return () => {};
      },
      async emit() {},
      getQueueDepth() {
        return 0;
      },
    }),
    createProvider: () => ({ chatCompletion: async () => ({ text: '', toolCalls: [], finishReason: 'stop', usage: {} }) }),
    createParser: () => ({ parse: () => ({ kind: 'final', text: '' }) }),
    createWorkflowRegistry: () => ({
      async loadAll() {},
      get(id, version) {
        if (id === 'bootstrap-init' && version === '1.0.0') {
          return { id: 'bootstrap-init', version: '1.0.0', steps: [] };
        }
        return null;
      },
    }),
    createWorkflowEngine: () => ({
      start() {},
      stop() {},
      listRuns() {
        return [{ workflowId: 'bootstrap-init', state: 'waiting_input' }];
      },
      async startRun(id, args, options) {
        calls.push({ id, args, options });
        return { id: 2, workflowId: id, state: 'queued' };
      },
    }),
    createSkillLoader: () => ({}),
    createSessionMemory: () => ({}),
    createWorkspaceManager: () => ({
      baseDir: '/tmp/ferretbot-workspace',
      async ensureWorkspace() {},
      resolve(...segments) { return segments.join('/'); },
      async ensureTextFile() {},
      async readTextFile(relativePath) {
        if (relativePath === 'BOOTSTRAP.md') return 'bootstrap pending';
        if (relativePath === '.bootstrap-complete') return '';
        return '';
      },
      async writeTextFile() {},
      async exists() { return true; },
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
    createAgentLoop: () => ({
      start() {},
      stop() {},
    }),
  });

  await lifecycle.start();
  await lifecycle.shutdown('test');

  assert.equal(calls.length, 0);
});
