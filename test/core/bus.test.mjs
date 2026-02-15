import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createEventBus } from '../../src/core/bus.mjs';

test('EventBus processes events serially and normalizes default metadata', async () => {
  const bus = createEventBus();
  const processedIds = [];
  let inFlight = 0;
  let maxInFlight = 0;

  bus.on('user:input', async (event) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);

    await delay(25);
    processedIds.push(event.content.id);

    assert.equal(event.channel, 'system');
    assert.equal(event.sessionId, 'default');
    assert.equal(typeof event.timestamp, 'number');

    inFlight -= 1;
  });

  await Promise.all([
    bus.emit({ type: 'user:input', content: { id: 1 } }),
    bus.emit({ type: 'user:input', content: { id: 2 } }),
    bus.emit({ type: 'user:input', content: { id: 3 } }),
  ]);

  assert.deepEqual(processedIds, [1, 2, 3]);
  assert.equal(maxInFlight, 1);
  assert.equal(bus.getQueueDepth(), 0);
});

test('EventBus accepts workflow event types', async () => {
  const bus = createEventBus();
  const received = [];
  bus.on('*', (event) => { received.push(event.type); });

  const workflowEvents = [
    'workflow:run:queued',
    'workflow:step:start',
    'workflow:step:complete',
    'workflow:needs_approval',
    'workflow:needs_input',
    'workflow:run:complete',
  ];

  for (const type of workflowEvents) {
    await bus.emit({ type, content: {} });
  }

  assert.deepEqual(received, workflowEvents);
});
