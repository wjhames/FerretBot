import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { DEFAULT_AGENT_CONFIG_PATH } from './config-defaults.mjs';
import { createEventBus } from './bus.mjs';
import { createIpcServer } from './ipc.mjs';
import { createLmStudioProvider } from '../provider/lmstudio.mjs';
import { createAgentParser } from '../agent/parser.mjs';
import { createAgentLoop } from '../agent/loop.mjs';
import { createWorkspaceBootstrapManager } from '../agent/bootstrap.mjs';
import { createToolRegistry } from '../tools/registry.mjs';
import { createWorkflowRegistry } from '../workflows/registry.mjs';
import { createWorkflowEngine } from '../workflows/engine.mjs';
import { registerWorkflowIpcCommands } from '../workflows/ipc-commands.mjs';
import { createSkillLoader } from '../skills/loader.mjs';
import { createSessionMemory } from '../memory/session.mjs';
import { createWorkspaceManager } from '../memory/workspace.mjs';

const DEFAULT_CONFIG_PATH = DEFAULT_AGENT_CONFIG_PATH;
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

async function discoverProviderCapabilities(provider) {
  if (!provider || typeof provider.discoverModelCapabilities !== 'function') {
    return null;
  }

  try {
    return await provider.discoverModelCapabilities();
  } catch {
    return null;
  }
}

async function preflightProvider(provider, config = {}) {
  if (!provider || typeof provider.chatCompletion !== 'function') {
    throw new TypeError('Provider must expose chatCompletion().');
  }

  const shouldPreflight = config.provider?.preflight !== false;
  if (!shouldPreflight || typeof provider.discoverModelCapabilities !== 'function') {
    return null;
  }

  try {
    return await provider.discoverModelCapabilities({
      force: true,
      requireDefaultModel: true,
    });
  } catch (error) {
    throw new Error(
      `Provider preflight failed. Ensure LM Studio is running and the configured model is loaded. ${error?.message ?? String(error)}`,
    );
  }
}

function defaultCreateToolRegistry({ config = {}, bus, workspaceManager } = {}) {
  const configuredRootDirs = Array.isArray(config.tools?.rootDirs)
    ? config.tools.rootDirs.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const workspaceRoot = workspaceManager?.baseDir;
  const workRoot = process.cwd();
  const rootDirs = [...configuredRootDirs];

  if (typeof config.tools?.rootDir === 'string' && config.tools.rootDir.trim().length > 0) {
    rootDirs.push(config.tools.rootDir);
  }

  if (typeof workRoot === 'string' && workRoot.trim().length > 0) {
    rootDirs.push(workRoot);
  }

  if (typeof workspaceRoot === 'string' && workspaceRoot.trim().length > 0) {
    rootDirs.push(workspaceRoot);
  }

  return createToolRegistry({
    cwd: config.tools?.cwd ?? config.tools?.rootDir ?? workRoot,
    rootDir: config.tools?.rootDir ?? workRoot,
    rootDirs: [...new Set(rootDirs)],
    maxReadBytes: config.tools?.maxReadBytes,
    bus,
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

function defaultCreateSkillLoader({ config = {} }) {
  return createSkillLoader({
    rootDir: config.skills?.rootDir,
    skillsDirName: config.skills?.dirName,
  });
}

function defaultCreateWorkflowRegistry({ config = {}, workspaceManager } = {}) {
  const baseDir = config.workflows?.rootDir
    ?? (workspaceManager && typeof workspaceManager.resolve === 'function'
      ? workspaceManager.resolve('workflows')
      : undefined);
  return createWorkflowRegistry({ baseDir });
}

function createConversationSummarizer(provider, config = {}) {
  if (!provider || typeof provider.chatCompletion !== 'function') {
    return null;
  }

  const maxTokens = Number.isFinite(config.memory?.summaryMaxTokens)
    ? Math.max(64, Math.floor(config.memory.summaryMaxTokens))
    : 160;
  const model = typeof config.memory?.summaryModel === 'string' && config.memory.summaryModel.trim().length > 0
    ? config.memory.summaryModel.trim()
    : undefined;

  return async ({ priorSummary = '', droppedTranscript = '' } = {}) => {
    if (typeof droppedTranscript !== 'string' || droppedTranscript.trim().length === 0) {
      return '';
    }

    const completion = await provider.chatCompletion({
      messages: [
        {
          role: 'system',
          content: 'Summarize earlier conversation for future context. Keep durable facts, decisions, preferences, constraints, and open work. Plain text only, maximum 120 words.',
        },
        {
          role: 'user',
          content: [
            'Existing summary:',
            priorSummary.trim().length > 0 ? priorSummary.trim() : '[none]',
            '',
            'Newly dropped transcript lines:',
            droppedTranscript,
            '',
            'Return a revised single summary only.',
          ].join('\n'),
        },
      ],
      maxTokens,
      ...(model ? { model } : {}),
    });

    return typeof completion?.text === 'string' ? completion.text.trim() : '';
  };
}

function defaultCreateSessionMemory({ config = {}, provider } = {}) {
  return createSessionMemory({
    baseDir: config.memory?.sessionsDir ?? config.session?.storageDir,
    conversationSummarizer: createConversationSummarizer(provider, config),
  });
}

function defaultCreateWorkspaceManager({ config = {} }) {
  return createWorkspaceManager({
    baseDir: config.workspace?.path,
    cleanupThreshold: config.workspace?.cleanupThresholdMs,
  });
}

function defaultCreateWorkspaceBootstrapManager({ config = {}, workspaceManager } = {}) {
  if (!workspaceManager) {
    return null;
  }

  return createWorkspaceBootstrapManager({
    workspaceManager,
    fileNames: config.workspace?.promptFiles,
    workDir: process.cwd(),
    agentStateDir: workspaceManager?.baseDir,
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
  #createWorkflowRegistry;
  #createWorkflowEngine;
  #createSkillLoader;
  #createSessionMemory;
  #createWorkspaceManager;
  #createWorkspaceBootstrapManager;
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
    this.#createWorkflowRegistry = options.createWorkflowRegistry ?? defaultCreateWorkflowRegistry;
    this.#createWorkflowEngine = options.createWorkflowEngine ?? (({ bus, registry, config, workspaceManager }) => createWorkflowEngine({ bus, registry, storageDir: config.workflows?.runsDir, workspaceManager }));
    this.#createSkillLoader = options.createSkillLoader ?? defaultCreateSkillLoader;
    this.#createSessionMemory = options.createSessionMemory ?? defaultCreateSessionMemory;
    this.#createWorkspaceManager = options.createWorkspaceManager ?? defaultCreateWorkspaceManager;
    this.#createWorkspaceBootstrapManager = options.createWorkspaceBootstrapManager ?? defaultCreateWorkspaceBootstrapManager;
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
    const providerCapabilities = await preflightProvider(provider, config)
      ?? await discoverProviderCapabilities(provider);
    const parser = this.#createParser(config);

    const skillLoader = this.#createSkillLoader({ config });
    const sessionMemory = this.#createSessionMemory({ config, provider });
    const workspaceManager = this.#createWorkspaceManager({ config });
    if (workspaceManager && typeof workspaceManager.ensureWorkspace === 'function') {
      await workspaceManager.ensureWorkspace();
    }
    const workspaceBootstrap = this.#createWorkspaceBootstrapManager({
      config,
      workspaceManager,
    });
    if (workspaceBootstrap && typeof workspaceBootstrap.ensureInitialized === 'function') {
      await workspaceBootstrap.ensureInitialized();
    }
    const workflowRegistry = this.#createWorkflowRegistry({ config, workspaceManager });
    await workflowRegistry.loadAll();
    const workflowEngine = this.#createWorkflowEngine({ bus, registry: workflowRegistry, config, workspaceManager });
    workflowEngine.start();
    const unregisterWorkflowIpcCommands = registerWorkflowIpcCommands({
      bus,
      workflowEngine,
      workflowRegistry,
    });

    const toolRegistry = this.#createToolRegistry({
      config,
      bus,
      workspaceManager,
    });

    if (typeof toolRegistry.registerBuiltIns === 'function') {
      await toolRegistry.registerBuiltIns();
    }

    const agentLoop = this.#createAgentLoop({
      bus,
      provider,
      parser,
      toolRegistry,
      workflowRegistry,
      workflowEngine,
      unregisterWorkflowIpcCommands,
      skillLoader,
      sessionMemory,
      workspaceManager,
      workspaceBootstrap,
      maxTokens: config.agent?.maxTokens,
      contextLimit: config.agent?.contextLimit ?? providerCapabilities?.contextWindow,
      outputReserve: config.agent?.outputReserve,
      layerBudgets: config.agent?.layerBudgets,
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
      workflowRegistry,
      workflowEngine,
      skillLoader,
      sessionMemory,
      workspaceManager,
      workspaceBootstrap,
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

    const {
      bus,
      ipcServer,
      scheduler,
      workflowEngine,
      agentLoop,
      unregisterWorkflowIpcCommands,
    } = this.#runtime;

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

      if (typeof unregisterWorkflowIpcCommands === 'function') {
        unregisterWorkflowIpcCommands();
      }

      if (typeof workflowEngine?.stop === 'function') {
        workflowEngine.stop();
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
