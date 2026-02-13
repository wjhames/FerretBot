import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgent, startAgent } from '../../src/agent.mjs';

test('startAgent creates and starts lifecycle', async () => {
  const calls = [];
  const fakeLifecycle = {
    async start() {
      calls.push('lifecycle.start');
    },
  };

  const lifecycle = await startAgent({
    createLifecycle: (options) => {
      calls.push(['createLifecycle', options]);
      return fakeLifecycle;
    },
    lifecycleOptions: { test: true },
  });

  assert.equal(lifecycle, fakeLifecycle);
  assert.deepEqual(calls, [
    ['createLifecycle', { test: true }],
    'lifecycle.start',
  ]);
});

test('runAgent logs success on startup', async () => {
  const logs = [];
  const logger = {
    info(...args) {
      logs.push(['info', ...args]);
    },
    error(...args) {
      logs.push(['error', ...args]);
    },
  };

  const lifecycle = await runAgent({
    logger,
    createLifecycle: () => ({
      async start() {},
    }),
  });

  assert.ok(lifecycle);
  assert.equal(logs[0][0], 'info');
  assert.match(logs[0][1], /agent started/i);
  assert.equal(logs.some((line) => line[0] === 'error'), false);
});

test('runAgent logs and rethrows startup errors', async () => {
  const loggerCalls = [];
  const logger = {
    info(...args) {
      loggerCalls.push(['info', ...args]);
    },
    error(...args) {
      loggerCalls.push(['error', ...args]);
    },
  };

  await assert.rejects(
    runAgent({
      logger,
      createLifecycle: () => ({
        async start() {
          throw new Error('boom');
        },
      }),
    }),
    /boom/,
  );

  assert.equal(loggerCalls.some((line) => line[0] === 'info'), false);
  assert.equal(loggerCalls[0][0], 'error');
  assert.match(loggerCalls[0][1], /failed to start/i);
  assert.match(String(loggerCalls[0][2]), /boom/);
});
