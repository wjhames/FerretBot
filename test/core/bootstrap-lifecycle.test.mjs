import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentLifecycle } from '../../src/core/lifecycle.mjs';
import { createEventBus } from '../../src/core/bus.mjs';

test('lifecycle auto-runs workspace bootstrap workflow and completes deterministically', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-lifecycle-bootstrap-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionsPath = path.join(tempRoot, 'sessions');

  try {
    const bus = createEventBus();
    const emitted = [];
    bus.on('*', async (event) => {
      emitted.push(event);
    });

    const lifecycle = createAgentLifecycle({
      createBus: () => bus,
      loadConfig: async () => ({
        workspace: {
          path: workspacePath,
        },
        memory: {
          sessionsDir: sessionsPath,
        },
        workflows: {
          runsDir: path.join(tempRoot, 'workflow-runs'),
        },
        ipc: {
          socketPath: path.join(tempRoot, 'agent.sock'),
        },
        agent: {
          maxToolCallsPerStep: 8,
          maxTokens: 256,
        },
      }),
      createProvider: () => ({ chatCompletion: async () => ({ text: 'ok', toolCalls: [], finishReason: 'stop', usage: {} }) }),
      createParser: () => ({ parse: (text) => ({ kind: 'final', text }) }),
      createIpcServer: () => ({
        async start() {},
        async stopAccepting() {},
        async disconnectAllClients() {},
      }),
      createScheduler: () => ({ async restore() {}, async start() {}, async stop() {} }),
    });

    await lifecycle.start();
    try {
      let bootstrapExists = true;
      for (let index = 0; index < 100; index += 1) {
        bootstrapExists = await fs.access(path.join(workspacePath, 'BOOTSTRAP.md'))
          .then(() => true)
          .catch(() => false);
        if (!bootstrapExists) {
          break;
        }
        await delay(20);
      }

      const markerText = await fs.readFile(path.join(workspacePath, '.bootstrap-complete'), 'utf8');
      assert.match(markerText, /complete/i);

      assert.equal(bootstrapExists, false);

      const stateText = await fs.readFile(path.join(workspacePath, '.bootstrap-state.json'), 'utf8');
      const state = JSON.parse(stateText);
      assert.equal(state.state, 'completed');

      assert.ok(emitted.some((event) => event.type === 'workflow:run:queued' && event.content?.workflowId === 'bootstrap-init'));
      assert.ok(emitted.some((event) => event.type === 'workflow:run:complete' && event.content?.workflowId === 'bootstrap-init' && event.content?.state === 'completed'));
    } finally {
      await lifecycle.shutdown('test');
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
