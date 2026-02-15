import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentLifecycle } from '../../src/core/lifecycle.mjs';

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for condition.');
}

function createSequencedProvider(items) {
  let index = 0;
  return {
    async chatCompletion() {
      const item = items[index] ?? items[items.length - 1];
      index += 1;

      return {
        text: item.text ?? '',
        toolCalls: item.toolCalls ?? [],
        finishReason: item.finishReason ?? 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      };
    },
  };
}

test('lifecycle bootstrap flow completes after explicit marker using real write tool', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-lifecycle-bootstrap-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionsPath = path.join(tempRoot, 'sessions');

  try {
    const provider = createSequencedProvider([
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'w1', name: 'write', arguments: { path: 'IDENTITY.md', content: 'Identity initialized' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'w2', name: 'write', arguments: { path: 'SOUL.md', content: 'Soul initialized' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'w3', name: 'write', arguments: { path: 'USER.md', content: 'User initialized' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'w4', name: 'write', arguments: { path: '.bootstrap-complete', content: '{"status":"complete"}' } }],
      },
      {
        text: 'bootstrap done',
        finishReason: 'stop',
      },
    ]);

    const lifecycle = createAgentLifecycle({
      loadConfig: async () => ({
        workspace: {
          path: workspacePath,
        },
        memory: {
          sessionsDir: sessionsPath,
        },
        ipc: {
          socketPath: path.join(tempRoot, 'agent.sock'),
        },
        agent: {
          maxToolCallsPerStep: 8,
          maxTokens: 256,
        },
      }),
      createProvider: () => provider,
      createParser: () => ({ parse: (text) => ({ kind: 'final', text }) }),
      createWorkflowRegistry: () => ({ async loadAll() {}, get() { return null; } }),
      createWorkflowEngine: () => ({ start() {}, stop() {}, getRun() { return null; } }),
      createIpcServer: () => ({
        async start() {},
        async stopAccepting() {},
        async disconnectAllClients() {},
      }),
      createScheduler: () => ({ async restore() {}, async start() {}, async stop() {} }),
    });

    const runtime = await lifecycle.start();
    const emitted = [];
    runtime.bus.on('*', async (event) => {
      emitted.push(event);
    });

    await runtime.bus.emit({
      type: 'user:input',
      channel: 'tui',
      sessionId: 'bootstrap-session',
      content: { text: 'initialize yourself' },
    });

    await waitFor(() => emitted.some((event) => event.type === 'agent:response'));

    const bootstrapExists = await fs.access(path.join(workspacePath, 'BOOTSTRAP.md')).then(() => true).catch(() => false);
    assert.equal(bootstrapExists, false);

    const markerText = await fs.readFile(path.join(workspacePath, '.bootstrap-complete'), 'utf8');
    assert.match(markerText, /complete/i);

    const stateText = await fs.readFile(path.join(workspacePath, '.bootstrap-state.json'), 'utf8');
    const state = JSON.parse(stateText);
    assert.equal(state.state, 'completed');

    const completionStatus = emitted.find(
      (event) => event.type === 'agent:status' && event.content?.phase === 'bootstrap:complete',
    );
    assert.ok(completionStatus);

    await lifecycle.shutdown('test');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
