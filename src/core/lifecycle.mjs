import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createEventBus } from './bus.mjs';
import { createIpcServer } from './ipc.mjs';
import { createLmStudioProvider } from '../provider/lmstudio.mjs';
import { createAgentParser } from '../agent/parser.mjs';
import { createAgentLoop } from '../agent/loop.mjs';
import { createToolRegistry } from '../tools/registry.mjs';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.agent', 'config.json');
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_POLL_MS = 25;

async function defaultLoadConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function createNoopScheduler() {
  return {
    async restore() {},
    async start() {},
    async stop() {},
  };
}

async function drainBusQueue(bus, { timeoutMs, pollMs }) {
  const start = Date.now();

  while (bus.getQueueDepth() > 0) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out draining event bus after ${timeoutMs}ms.`);
    }

    await delay(pollMs);
  }
}

function defaultCreateToolRegistry(config = {}) {
  return createToolRegistry({
    cwd: config.tools?.cwd,
    rootDir: config.tools?.rootDir,
    maxReadBytes: config.tools?.maxReadBytes,
  });
}

function defaultCreateIpcServer({ bus, config = {} }) {
  return createIpcServer({
    bus,
    socketPath: config.ipc?.socketPath,
    host: config.ipc?.host,
    port: config.ipc?.port,
  });
}

export class AgentLifecycle {
  #configPath;
  #shutdownTimeoutMs;
  #drainPollMs;
  #signalSource;
  #loadConfig;
  #createBus;
  #createProvider;
  #createParser;
  #createToolRegistry;
  #createAgentLoop;
  #createIpcServer;
  #createScheduler;
  #persistState;

  #runtime;
  #signalHandlers;
  #started;
  #shuttingDown;

  constructor(options = {}) {
    this.#configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.#drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;
    this.#signalSource = options.signalSource ?? process;

    this.#loadConfig = options.loadConfig ?? defaultLoadConfig;
    this.#createBus = options.createBus ?? ((_) => createEventBus());
    this.#createProvider = options.createProvider ?? ((config) => createLmStudioProvider(config.provider));
    this.#createParser = options.createParser ?? (() => createAgentParser());
    this.#createToolRegistry = options.createToolRegistry ?? defaultCreateToolRegistry;
    this.#createAgentLoop = options.createAgentLoop ?? ((deps) => createAgentLoop(deps));
    this.#createIpcServer = options.createIpcServer ?? defaultCreateIpcServer;
    this.#createScheduler = options.createScheduler ?? ((_) => createNoopScheduler());
    this.#persistState = options.persistState ?? (async () => {});

    this.#runtime = null;
    this.#signalHandlers = null;
    this.#started = false;
    this.#shuttingDown = false;
  }

  async start() {
    if (this.#started) {
      return this.#runtime;
    }

    const config = await this.#loadConfig(this.#configPath);

    const bus = this.#createBus(config);
    const provider = this.#createProvider(config);
    const parser = this.#createParser(config);
    const toolRegistry = this.#createToolRegistry(config);

    if (typeof toolRegistry.registerBuiltIns === 'function') {
      await toolRegistry.registerBuiltIns();
    }

    const agentLoop = this.#createAgentLoop({
      bus,
      provider,
      parser,
      toolRegistry,
      maxTokens: config.agent?.maxTokens,
      maxToolCallsPerStep: config.agent?.maxToolCallsPerStep,
    });

    if (typeof agentLoop.start !== 'function' || typeof agentLoop.stop !== 'function') {
      throw new TypeError('Agent loop must implement start() and stop().');
    }

    agentLoop.start();

    const ipcServer = this.#createIpcServer({ bus, config });
    await ipcServer.start();

    const scheduler = this.#createScheduler({ bus, config });
    if (typeof scheduler.restore === 'function') {
      await scheduler.restore();
    }
    if (typeof scheduler.start === 'function') {
      await scheduler.start();
    }

    this.#runtime = {
      config,
      bus,
      provider,
      parser,
      toolRegistry,
      agentLoop,
      ipcServer,
      scheduler,
    };

    this.#registerSignalHandlers();
    this.#started = true;

    return this.#runtime;
  }

  async shutdown(reason = 'shutdown') {
    if (!this.#started || !this.#runtime) {
      return;
    }

    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;

    const { bus, ipcServer, scheduler, agentLoop } = this.#runtime;

    try {
      if (typeof ipcServer.stopAccepting === 'function') {
        await ipcServer.stopAccepting();
      }

      await drainBusQueue(bus, {
        timeoutMs: this.#shutdownTimeoutMs,
        pollMs: this.#drainPollMs,
      });

      await this.#persistState({ reason, runtime: this.#runtime });

      if (typeof ipcServer.disconnectAllClients === 'function') {
        await ipcServer.disconnectAllClients();
      }

      if (typeof scheduler.stop === 'function') {
        await scheduler.stop();
      }

      if (typeof agentLoop.stop === 'function') {
        agentLoop.stop();
      }
    } finally {
      this.#removeSignalHandlers();
      this.#started = false;
      this.#shuttingDown = false;
      this.#runtime = null;
    }
  }

  #registerSignalHandlers() {
    if (!this.#signalSource || typeof this.#signalSource.on !== 'function') {
      return;
    }

    const onSigint = () => {
      void this.shutdown('SIGINT');
    };

    const onSigterm = () => {
      void this.shutdown('SIGTERM');
    };

    this.#signalSource.on('SIGINT', onSigint);
    this.#signalSource.on('SIGTERM', onSigterm);

    this.#signalHandlers = {
      SIGINT: onSigint,
      SIGTERM: onSigterm,
    };
  }

  #removeSignalHandlers() {
    if (!this.#signalHandlers || !this.#signalSource || typeof this.#signalSource.off !== 'function') {
      this.#signalHandlers = null;
      return;
    }

    this.#signalSource.off('SIGINT', this.#signalHandlers.SIGINT);
    this.#signalSource.off('SIGTERM', this.#signalHandlers.SIGTERM);
    this.#signalHandlers = null;
  }
}

export function createAgentLifecycle(options) {
  return new AgentLifecycle(options);
}

export {
  DEFAULT_CONFIG_PATH,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_DRAIN_POLL_MS,
  defaultLoadConfig,
  defaultCreateToolRegistry,
  defaultCreateIpcServer,
};
