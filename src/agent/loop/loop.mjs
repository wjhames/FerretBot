import {
  DEFAULT_CONTEXT_LIMIT,
  deriveOutputReserve,
  createAgentContext,
} from '../context/manager.mjs';
import { buildSystemPrompt } from '../prompt.mjs';
import {
  DEFAULT_PROCESSABLE_EVENTS,
  WORKFLOW_STEP_START_EVENT,
} from '../events.mjs';
import { createAgentContextLoader } from '../runtime/context-loader.mjs';
import { normalizeFinalText } from '../turn/policy.mjs';
import { executeToolCall } from '../turn/tool-executor.mjs';
import { runAgentTurn } from '../turn/runner.mjs';

const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_MAX_CONTINUATIONS = 3;

function coerceInputText(event) {
  const { content } = event;

  if (typeof content === 'string') {
    return content;
  }

  if (
    content
    && typeof content === 'object'
    && typeof content.text === 'string'
  ) {
    return content.text;
  }

  return JSON.stringify(content ?? '');
}

function defaultBuildMessages(event) {
  return [
    {
      role: 'system',
      content: buildSystemPrompt({
        step: event?.type === WORKFLOW_STEP_START_EVENT ? (event?.content?.step ?? null) : null,
      }),
    },
    { role: 'user', content: coerceInputText(event) },
  ];
}

export class AgentLoop {
  #bus;
  #provider;
  #parser;
  #contextManager;
  #toolRegistry;
  #workflowRegistry;
  #workflowEngine;
  #skillLoader;
  #sessionMemory;
  #workspaceBootstrap;
  #maxTokens;
  #contextLimit;
  #maxToolCallsPerStep;
  #maxContinuations;
  #retryLimit;
  #unsubscribe;
  #pendingEmits;
  #contextLoader;

  constructor(options = {}) {
    const {
      bus,
      provider,
      parser,
      contextManager,
      toolRegistry = null,
      workflowRegistry = null,
      workflowEngine = null,
      skillLoader = null,
      sessionMemory = null,
      workspaceBootstrap = null,
      maxTokens,
      contextLimit = DEFAULT_CONTEXT_LIMIT,
      outputReserve,
      layerBudgets,
      maxToolCallsPerStep = 10,
      maxContinuations = DEFAULT_MAX_CONTINUATIONS,
      retryLimit = DEFAULT_RETRY_LIMIT,
      buildMessages,
    } = options;

    if (
      !bus
      || typeof bus.on !== 'function'
      || typeof bus.emit !== 'function'
    ) {
      throw new TypeError('AgentLoop requires a bus with on/emit methods.');
    }

    if (!provider || typeof provider.chatCompletion !== 'function') {
      throw new TypeError(
        'AgentLoop requires a provider with chatCompletion().',
      );
    }

    if (!parser || typeof parser.parse !== 'function') {
      throw new TypeError('AgentLoop requires a parser with parse().');
    }

    if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      throw new TypeError('maxTokens must be a positive integer.');
    }

    if (!Number.isInteger(contextLimit) || contextLimit <= 0) {
      throw new TypeError('contextLimit must be a positive integer.');
    }

    if (outputReserve != null && (!Number.isInteger(outputReserve) || outputReserve <= 0)) {
      throw new TypeError('outputReserve must be a positive integer when provided.');
    }

    if (!Number.isInteger(maxToolCallsPerStep) || maxToolCallsPerStep <= 0) {
      throw new TypeError('maxToolCallsPerStep must be a positive integer.');
    }

    if (!Number.isInteger(maxContinuations) || maxContinuations < 0) {
      throw new TypeError('maxContinuations must be a non-negative integer.');
    }

    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new TypeError('retryLimit must be a non-negative integer.');
    }

    this.#bus = bus;
    this.#provider = provider;
    this.#parser = parser;
    this.#toolRegistry = toolRegistry;
    this.#workflowRegistry = workflowRegistry;
    this.#workflowEngine = workflowEngine;
    this.#skillLoader = skillLoader;
    this.#sessionMemory = sessionMemory;
    this.#workspaceBootstrap = workspaceBootstrap;
    this.#contextLimit = contextLimit;
    this.#maxTokens = Number.isInteger(maxTokens)
      ? maxTokens
      : (Number.isInteger(outputReserve) ? outputReserve : deriveOutputReserve(contextLimit));
    this.#maxToolCallsPerStep = maxToolCallsPerStep;
    this.#maxContinuations = maxContinuations;
    this.#retryLimit = retryLimit;
    this.#unsubscribe = null;
    this.#pendingEmits = new Set();

    this.#contextManager = this.#createContextManager({
      contextManager,
      buildMessages,
      contextLimit,
      outputReserve,
      layerBudgets,
      maxTokens,
    });

    this.#contextLoader = createAgentContextLoader({
      contextManager: this.#contextManager,
      toolRegistry: this.#toolRegistry,
      workflowRegistry: this.#workflowRegistry,
      workflowEngine: this.#workflowEngine,
      skillLoader: this.#skillLoader,
      sessionMemory: this.#sessionMemory,
      workspaceBootstrap: this.#workspaceBootstrap,
      maxTokens: this.#maxTokens,
      getLayerBudget: (name) => this.#getLayerBudget(name),
      buildMessages,
      defaultBuildMessages,
      coerceInputText,
    });
  }

  start() {
    if (this.#unsubscribe) {
      return;
    }

    this.#unsubscribe = this.#bus.on('*', async (event) => {
      if (!DEFAULT_PROCESSABLE_EVENTS.has(event.type)) {
        return;
      }

      if (
        event.type === WORKFLOW_STEP_START_EVENT
        && event?.content?.step
        && typeof event.content.step === 'object'
      ) {
        const stepType = String(event.content.step.type ?? 'agent');
        if (stepType !== 'agent') {
          return;
        }
      }

      if (
        event.type === 'user:input'
        && (
          event?.__workflowConsumed === true
          || (
            this.#workflowEngine
            && typeof this.#workflowEngine.hasPendingInput === 'function'
            && this.#workflowEngine.hasPendingInput(event?.sessionId ?? null)
          )
        )
      ) {
        return;
      }

      await this.#handleEvent(event);
    });
  }

  stop() {
    if (!this.#unsubscribe) {
      return;
    }

    this.#unsubscribe();
    this.#unsubscribe = null;
  }

  #createContextManager({
    contextManager,
    buildMessages,
    contextLimit,
    outputReserve,
    layerBudgets,
    maxTokens,
  }) {
    const effectiveOutputReserve = Number.isInteger(maxTokens)
      ? maxTokens
      : (Number.isInteger(outputReserve) ? outputReserve : deriveOutputReserve(contextLimit));

    if (buildMessages) {
      return {
        buildMessages(input) {
          return {
            messages: buildMessages(input.event),
            maxOutputTokens: effectiveOutputReserve,
          };
        },
      };
    }

    if (contextManager && typeof contextManager.buildMessages === 'function') {
      return contextManager;
    }

    return createAgentContext({
      contextLimit,
      outputReserve: effectiveOutputReserve,
      layerBudgets,
      tokenCounter: typeof this.#provider?.countTokens === 'function'
        ? (input) => this.#provider.countTokens(input)
        : null,
    });
  }

  #getLayerBudget(name) {
    if (typeof this.#contextManager?.getLayerBudgets !== 'function') {
      return null;
    }

    const budgets = this.#contextManager.getLayerBudgets();
    const value = budgets?.[name];
    return Number.isFinite(value) ? value : null;
  }

  async #handleEvent(event) {
    await runAgentTurn({
      event,
      provider: this.#provider,
      parser: this.#parser,
      maxContinuations: this.#maxContinuations,
      retryLimit: this.#retryLimit,
      compactMessagesForContinuation: (options) => this.#compactMessagesForContinuation(options),
      getToolDefinitionsForEvent: (targetEvent) => this.#contextLoader.getToolDefinitionsForEvent(targetEvent),
      buildInitialContext: (targetEvent) => this.#contextLoader.buildInitialContext(targetEvent),
      persistInputTurn: (targetEvent) => this.#persistInputTurn(targetEvent),
      emitFinal: (targetEvent, completion, text) => this.#emitFinal(targetEvent, completion, text),
      emitCorrectionFailure: (targetEvent, text) => this.#emitCorrectionFailure(targetEvent, text),
      queueEmit: (payload) => this.#queueEmit(payload),
      executeToolCall: (payload) => executeToolCall({
        ...payload,
        retryLimit: this.#retryLimit,
        maxToolCallsPerStep: this.#maxToolCallsPerStep,
        toolRegistry: this.#toolRegistry,
        queueEmit: (queued) => this.#queueEmit(queued),
        appendSessionTurn: (sessionId, entry) => this.#appendSessionTurn(sessionId, entry),
        emitCorrectionFailure: (targetEvent, text) => this.#emitCorrectionFailure(targetEvent, text),
      }),
    });
  }

  async #compactMessagesForContinuation(options = {}) {
    if (typeof this.#contextManager?.compactMessagesForContinuation !== 'function') {
      return {
        messages: options.messages ?? [],
        maxOutputTokens: options.maxOutputTokens ?? this.#maxTokens,
      };
    }

    return this.#contextManager.compactMessagesForContinuation(options);
  }

  async #emitFinal(event, completion, text) {
    const finalText = normalizeFinalText(text);
    await this.#appendSessionTurn(event.sessionId, {
      role: 'assistant',
      type: 'agent_response',
      content: finalText,
      meta: {
        finishReason: completion.finishReason,
        usage: completion.usage,
      },
    });

    this.#queueEmit({
      type: 'agent:response',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        text: finalText,
        finishReason: completion.finishReason,
        usage: completion.usage,
      },
    });

    if (event.type === WORKFLOW_STEP_START_EVENT) {
      this.#queueEmit({
        type: 'workflow:step:complete',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          runId: event.content?.runId,
          stepId: event.content?.step?.id,
          result: finalText,
        },
      });
    }
  }

  #emitCorrectionFailure(event, text) {
    this.#queueEmit({
      type: 'agent:response',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        text,
        finishReason: 'parse_failed',
      },
    });
  }

  async #persistInputTurn(event) {
    if (event.type !== 'user:input') {
      return;
    }

    await this.#appendSessionTurn(event.sessionId, {
      role: 'user',
      type: 'user_input',
      content: coerceInputText(event),
      meta: {
        channel: event.channel,
      },
    });
  }

  async #appendSessionTurn(sessionId, entry) {
    if (!this.#sessionMemory || typeof this.#sessionMemory.appendTurn !== 'function') {
      return;
    }

    if (!sessionId) {
      return;
    }

    try {
      await this.#sessionMemory.appendTurn(sessionId, entry);
    } catch {
      // Session persistence is best-effort and must not block the loop.
    }
  }

  #queueEmit(event) {
    const pending = this.#bus.emit(event).catch(() => {});
    this.#pendingEmits.add(pending);
    pending.finally(() => {
      this.#pendingEmits.delete(pending);
    });
  }
}

export function createAgentLoop(options) {
  return new AgentLoop(options);
}
