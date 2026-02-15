import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

import { DEFAULT_AGENT_SOCKET_PATH } from './config-defaults.mjs';

const DEFAULT_SOCKET_PATH = DEFAULT_AGENT_SOCKET_PATH;
const OUTBOUND_EVENT_TYPES = new Set([
  'agent:response',
  'agent:status',
  'workflow:run:queued',
  'workflow:step:start',
  'workflow:step:complete',
  'workflow:needs_approval',
  'workflow:run:complete',
]);

function normalizeInboundMessage(rawLine) {
  if (typeof rawLine !== 'string' || rawLine.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawLine);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (typeof parsed.type !== 'string' || parsed.type.length === 0) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function toOutboundMessage(event) {
  return {
    type: event.type,
    content: event.content ?? null,
    clientId: event.sessionId ?? null,
    timestamp: event.timestamp ?? Date.now(),
  };
}

export class IpcServer {
  #bus;
  #transport;
  #socketPath;
  #host;
  #port;
  #server;
  #clients;
  #nextClientId;
  #unsubscribe;
  #started;
  #createServer;

  constructor(options = {}) {
    const { bus, socketPath = DEFAULT_SOCKET_PATH, host = '127.0.0.1', port = null, createServer } = options;

    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
      throw new TypeError('IpcServer requires a bus with on/emit methods.');
    }

    this.#bus = bus;
    this.#transport = Number.isInteger(port) ? 'tcp' : 'unix';
    this.#socketPath = socketPath;
    this.#host = host;
    this.#port = port;
    this.#createServer = createServer ?? net.createServer;

    this.#server = null;
    this.#clients = new Map();
    this.#nextClientId = 1;
    this.#unsubscribe = null;
    this.#started = false;
  }

  async start() {
    if (this.#started) {
      return this.getAddress();
    }

    if (this.#transport === 'unix') {
      await this.#prepareSocketPath();
    }

    this.#server = this.#createServer((socket) => {
      this.#handleConnection(socket);
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.#server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server?.off('error', onError);
        resolve();
      };

      this.#server.once('error', onError);
      this.#server.once('listening', onListening);

      if (this.#transport === 'tcp') {
        this.#server.listen({ host: this.#host, port: this.#port });
      } else {
        this.#server.listen(this.#socketPath);
      }
    });

    this.#unsubscribe = this.#bus.on('*', async (event) => {
      if (!OUTBOUND_EVENT_TYPES.has(event.type)) {
        return;
      }

      this.#routeOutboundEvent(event);
    });

    this.#started = true;
    return this.getAddress();
  }

  async stopAccepting() {
    if (!this.#server) {
      return;
    }

    const server = this.#server;
    this.#server = null;

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async disconnectAllClients() {
    for (const { socket } of this.#clients.values()) {
      socket.end();
      socket.destroy();
    }

    this.#clients.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = null;

    if (this.#transport === 'unix') {
      await this.#cleanupSocketPath();
    }

    this.#started = false;
  }

  getAddress() {
    if (!this.#server) {
      return null;
    }

    const address = this.#server.address();
    if (typeof address === 'string') {
      return { transport: 'unix', socketPath: address };
    }

    return {
      transport: 'tcp',
      host: address?.address ?? this.#host,
      port: address?.port ?? this.#port,
    };
  }

  getClientCount() {
    return this.#clients.size;
  }

  #handleConnection(socket) {
    const assignedClientId = `client-${this.#nextClientId}`;
    this.#nextClientId += 1;

    this.#clients.set(assignedClientId, {
      clientId: assignedClientId,
      socket,
      buffer: '',
    });

    socket.on('data', (chunk) => {
      this.#handleSocketData(assignedClientId, chunk.toString('utf8'));
    });

    socket.on('error', () => {
      this.#clients.delete(assignedClientId);
    });

    socket.on('close', () => {
      this.#clients.delete(assignedClientId);
    });

    socket.write(`${JSON.stringify({ type: 'system:hello', clientId: assignedClientId })}\n`);
  }

  #handleSocketData(assignedClientId, chunk) {
    const client = this.#clients.get(assignedClientId);
    if (!client) {
      return;
    }

    client.buffer += chunk;

    while (true) {
      const newLineIndex = client.buffer.indexOf('\n');
      if (newLineIndex === -1) {
        return;
      }

      const line = client.buffer.slice(0, newLineIndex);
      client.buffer = client.buffer.slice(newLineIndex + 1);

      const parsed = normalizeInboundMessage(line);
      if (!parsed) {
        continue;
      }

      const sessionId =
        typeof parsed.clientId === 'string' && parsed.clientId.length > 0 ? parsed.clientId : assignedClientId;

      void this.#bus.emit({
        type: parsed.type,
        channel: 'ipc',
        sessionId,
        content: parsed.content ?? null,
      });
    }
  }

  #routeOutboundEvent(event) {
    const payload = `${JSON.stringify(toOutboundMessage(event))}\n`;

    if (typeof event.sessionId === 'string' && event.sessionId.length > 0) {
      const targetedClient = this.#clients.get(event.sessionId);
      if (targetedClient) {
        targetedClient.socket.write(payload);
        return;
      }
    }

    for (const client of this.#clients.values()) {
      client.socket.write(payload);
    }
  }

  async #prepareSocketPath() {
    await fs.mkdir(path.dirname(this.#socketPath), { recursive: true });

    try {
      await fs.unlink(this.#socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async #cleanupSocketPath() {
    try {
      await fs.unlink(this.#socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function createIpcServer(options) {
  return new IpcServer(options);
}

export { DEFAULT_SOCKET_PATH, OUTBOUND_EVENT_TYPES, normalizeInboundMessage };
