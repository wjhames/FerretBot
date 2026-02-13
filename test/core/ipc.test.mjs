import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { createEventBus } from '../../src/core/bus.mjs';
import { createIpcServer } from '../../src/core/ipc.mjs';

async function waitFor(predicate, { timeoutMs = 800, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for condition.');
}

class FakeSocket extends EventEmitter {
  writes = [];

  write(value) {
    this.writes.push(String(value));
  }

  end() {
    this.emit('close');
  }

  destroy() {
    this.emit('close');
  }
}

class FakeServer extends EventEmitter {
  #onConnection;

  constructor(onConnection) {
    super();
    this.#onConnection = onConnection;
  }

  listen() {
    queueMicrotask(() => this.emit('listening'));
  }

  close(callback) {
    callback?.();
  }

  address() {
    return { address: '127.0.0.1', port: 43210 };
  }

  connect(socket) {
    this.#onConnection(socket);
  }
}

function parseLines(socket) {
  return socket.writes
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('ipc server translates inbound client JSON lines into bus events', async () => {
  const bus = createEventBus();
  const received = [];

  bus.on('user:input', async (event) => {
    received.push(event);
  });

  let fakeServer;
  const server = createIpcServer({
    bus,
    port: 0,
    createServer: (onConnection) => {
      fakeServer = new FakeServer(onConnection);
      return fakeServer;
    },
  });

  await server.start();

  const socket = new FakeSocket();
  fakeServer.connect(socket);

  const hello = parseLines(socket).find((message) => message.type === 'system:hello');
  assert.ok(hello);

  socket.emit('data', Buffer.from(`${JSON.stringify({ type: 'user:input', content: 'hello from client' })}\n`, 'utf8'));

  await waitFor(() => received.length === 1);

  assert.equal(received[0].type, 'user:input');
  assert.equal(received[0].channel, 'ipc');
  assert.equal(received[0].content, 'hello from client');
  assert.equal(received[0].sessionId, hello.clientId);

  await server.stopAccepting();
  await server.disconnectAllClients();
});

test('ipc routes targeted responses and broadcasts untargeted events', async () => {
  const bus = createEventBus();

  let fakeServer;
  const server = createIpcServer({
    bus,
    port: 0,
    createServer: (onConnection) => {
      fakeServer = new FakeServer(onConnection);
      return fakeServer;
    },
  });

  await server.start();

  const socketA = new FakeSocket();
  const socketB = new FakeSocket();
  fakeServer.connect(socketA);
  fakeServer.connect(socketB);

  const idA = parseLines(socketA).find((message) => message.type === 'system:hello').clientId;
  const idB = parseLines(socketB).find((message) => message.type === 'system:hello').clientId;
  assert.notEqual(idA, idB);

  await bus.emit({
    type: 'agent:response',
    channel: 'ipc',
    sessionId: idA,
    content: { text: 'only A' },
  });

  const outboundA = parseLines(socketA);
  const outboundB = parseLines(socketB);
  assert.ok(outboundA.some((message) => message.type === 'agent:response' && message.content.text === 'only A'));
  assert.equal(outboundB.some((message) => message.type === 'agent:response' && message.content.text === 'only A'), false);

  await bus.emit({
    type: 'agent:status',
    channel: 'ipc',
    content: { phase: 'heartbeat' },
  });

  const withBroadcastA = parseLines(socketA);
  const withBroadcastB = parseLines(socketB);
  assert.ok(withBroadcastA.some((message) => message.type === 'agent:status'));
  assert.ok(withBroadcastB.some((message) => message.type === 'agent:status'));

  assert.equal(server.getClientCount(), 2);

  await server.stopAccepting();
  await server.disconnectAllClients();
});
