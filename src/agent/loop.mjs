import {
  DEFAULT_CONTEXT_LIMIT,
  deriveOutputReserve,
  createAgentContext,
} from './context.mjs';
import { buildSystemPrompt } from './prompt.mjs';

const WORKFLOW_STEP_START_EVENT = 'workflow:step:start';
const STEP_START_EVENTS = new Set([
  WORKFLOW_STEP_START_EVENT,
]);

const DEFAULT_PROCESSABLE_EVENTS = new Set([
  'user:input',
  'schedule:trigger',
  ...STEP_START_EVENTS,
]);

const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_MAX_CONTINUATIONS = 3;
const EMPTY_RESPONSE_TEXT = 'Model returned an empty response.';

function coerceInputText(event) {
  const { content } = event;

  if (typeof content === 'string') {
    return content;
  }

  if (
    content &&
    typeof content === 'object' &&
    typeof content.text === 'string'
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
        step: STEP_START_EVENTS.has(event?.type) ? (event?.content?.step ?? null) : null,
      }),
    },
    { role: 'user', content: coerceInputText(event) },
  ];
}

function shouldAttemptTextToolParse(text, finishReason) {
  if (finishReason === 'tool_calls') {
    return true;
  }

  if (typeof text !== 'string') {
    return false;
  }

  return text.trimStart().startsWith('{');
}

function buildCorrectionPrompt(reason) {
  return [
    'Your previous response was invalid for tool execution.',
    `Reason: ${reason}`,
    'Respond with either:',
    '1) Exactly one JSON tool call object: {"tool":"name","args":{...}}',
    '2) Plain text final answer (no JSON).',
  ].join('\n');
}

function buildContinuationPrompt() {
  return [
    'Continue exactly from where your previous response stopped.',
    'Do not repeat earlier text.',
    'Do not add preamble or explanation.',
  ].join('\n');
}

function getToolDefinitions(toolRegistry) {
  if (!toolRegistry || typeof toolRegistry.list !== 'function') {
    return [];
  }

  const listed = toolRegistry.list();
  return Array.isArray(listed) ? listed : [];
}

function getToolDefinitionsForEvent(toolRegistry, event) {
  const allTools = getToolDefinitions(toolRegistry);

  const stepTools = event.content?.step?.tools;
  if (!Array.isArray(stepTools)) return allTools;

  const allowed = new Set(
    stepTools.filter(
      (name) => typeof name === 'string' && name.trim().length > 0,
    ),
  );

  return allTools.filter((tool) => allowed.has(tool.name));
}

function normalizeFinalText(text) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  return normalized.length > 0 ? normalized : EMPTY_RESPONSE_TEXT;
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
      !bus ||
      typeof bus.on !== 'function' ||
      typeof bus.emit !== 'function'
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
  }

  start() {
    if (this.#unsubscribe) {
      return;
    }

    this.#unsubscribe = this.#bus.on('*', async (event) => {
      if (!DEFAULT_PROCESSABLE_EVENTS.has(event.type)) {
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

  #toCharBudget(tokenBudget) {
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
      return 0;
    }

    return Math.max(0, Math.floor((tokenBudget * 4) / 1.1));
  }

  async #loadConversationContext(event) {
    if (!this.#sessionMemory || typeof this.#sessionMemory.collectConversation !== 'function') {
      return { turns: [], summary: '' };
    }
    if (!event?.sessionId) {
      return { turns: [], summary: '' };
    }

    const conversationLimit = this.#getLayerBudget('conversation');
    const tokenLimit = Number.isFinite(conversationLimit) && conversationLimit > 0 ? conversationLimit : undefined;

    const collected = await this.#sessionMemory.collectConversation(event.sessionId, {
      tokenLimit,
    });

    const turns = Array.isArray(collected?.turns)
      ? collected.turns.map((entry) => ({
          role: entry?.role === 'assistant' ? 'assistant' : 'user',
          content: String(entry?.content ?? '').trim(),
        })).filter((entry) => entry.content.length > 0)
      : [];

    return {
      turns,
      summary: typeof collected?.summary === 'string' ? collected.summary : '',
    };
  }

  #resolveWorkflowRuntime(event) {
    if (event.type !== WORKFLOW_STEP_START_EVENT) {
      return { workflow: null, run: null };
    }

    const runId = event.content?.runId;
    const run = this.#workflowEngine && typeof this.#workflowEngine.getRun === 'function'
      ? this.#workflowEngine.getRun(runId)
      : null;

    const workflowId = run?.workflowId ?? event.content?.workflowId;
    const workflowVersion = run?.workflowVersion;
    const workflow = workflowId && this.#workflowRegistry && typeof this.#workflowRegistry.get === 'function'
      ? this.#workflowRegistry.get(workflowId, workflowVersion)
      : null;

    return { workflow, run };
  }

  async #loadSkillText(event) {
    if (event.type !== WORKFLOW_STEP_START_EVENT) {
      return '';
    }

    if (!this.#skillLoader || typeof this.#skillLoader.loadSkillsForStep !== 'function') {
      return '';
    }

    const step = event.content?.step;
    const requestedSkills = Array.isArray(step?.loadSkills) ? step.loadSkills : [];
    if (requestedSkills.length === 0) {
      return '';
    }

    const { workflow } = this.#resolveWorkflowRuntime(event);
    const workflowDir = event.content?.workflowDir ?? workflow?.dir;
    if (!workflowDir) {
      return '';
    }

    const skillsBudget = this.#getLayerBudget('skills');
    const loaded = await this.#skillLoader.loadSkillsForStep({
      workflowDir,
      skillNames: requestedSkills,
      maxSkillContentChars: this.#toCharBudget(skillsBudget),
    });

    return loaded?.text ?? '';
  }

  #buildPriorSteps(event) {
    if (event.type !== WORKFLOW_STEP_START_EVENT) {
      return [];
    }

    const { workflow, run } = this.#resolveWorkflowRuntime(event);
    if (!workflow || !run || !Array.isArray(run.steps) || !Array.isArray(workflow.steps)) {
      return [];
    }

    const currentStepId = event.content?.step?.id;
    const currentIndex = workflow.steps.findIndex((step) => step.id === currentStepId);
    const byId = new Map(workflow.steps.map((step, index) => [step.id, { step, index }]));

    const completed = [];
    for (const runStep of run.steps) {
      if (runStep?.state !== 'completed') {
        continue;
      }
      if (runStep.id === currentStepId || runStep.result == null) {
        continue;
      }

      const workflowStep = byId.get(runStep.id);
      if (!workflowStep) {
        continue;
      }
      if (currentIndex !== -1 && workflowStep.index >= currentIndex) {
        continue;
      }

      completed.push({
        id: completed.length + 1,
        instruction: workflowStep.step.instruction,
        result: runStep.result,
      });
    }

    return completed;
  }

  async #buildInitialContext(event) {
    const isStepEvent = STEP_START_EVENTS.has(event.type);
    const conversationContext = await this.#loadConversationContext(event);
    const skillContent = await this.#loadSkillText(event);
    const priorSteps = this.#buildPriorSteps(event);
    const promptContext = await this.#loadPromptContext();

    const builtContext = await Promise.resolve(this.#contextManager.buildMessages({
      event,
      mode: isStepEvent ? 'step' : 'interactive',
      userInput: coerceInputText(event),
      extraRules: promptContext.extraRules,
      step: isStepEvent ? (event.content?.step ?? null) : null,
      conversation: conversationContext.turns,
      conversationSummary: conversationContext.summary,
      skillContent,
      priorSteps,
      tools: getToolDefinitionsForEvent(this.#toolRegistry, event),
    }));

    return {
      messages: [...(builtContext.messages ?? defaultBuildMessages(event))],
      maxOutputTokens: Number.isInteger(builtContext.maxOutputTokens)
        ? builtContext.maxOutputTokens
        : this.#maxTokens,
    };
  }

  async #loadPromptContext() {
    if (!this.#workspaceBootstrap || typeof this.#workspaceBootstrap.loadPromptContext !== 'function') {
      return { extraRules: '' };
    }

    try {
      const loaded = await this.#workspaceBootstrap.loadPromptContext();
      return {
        extraRules: typeof loaded?.extraRules === 'string' ? loaded.extraRules : '',
      };
    } catch {
      return { extraRules: '' };
    }
  }

  async #maybeCompleteBootstrap(event) {
    if (!this.#workspaceBootstrap || typeof this.#workspaceBootstrap.maybeCompleteBootstrap !== 'function') {
      return;
    }

    try {
      const completed = await this.#workspaceBootstrap.maybeCompleteBootstrap();
      if (!completed) {
        return;
      }

      this.#queueEmit({
        type: 'agent:status',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          phase: 'bootstrap:complete',
          text: 'Bootstrap complete. BOOTSTRAP.md removed.',
        },
      });
    } catch {
      // Bootstrap completion is best-effort and must not block loop execution.
    }
  }

  async #handleEvent(event) {
    let { messages, maxOutputTokens } = await this.#buildInitialContext(event);
    await this.#persistInputTurn(event);

    let toolCalls = 0;
    let correctionRetries = 0;
    let continuationCount = 0;
    const accumulatedTextParts = [];

    while (true) {
      const completion = await this.#provider.chatCompletion({
        messages,
        maxTokens: maxOutputTokens,
        tools: getToolDefinitionsForEvent(this.#toolRegistry, event),
        toolChoice: 'auto',
      });

      const nativeToolCall =
        Array.isArray(completion.toolCalls) && completion.toolCalls.length > 0
          ? completion.toolCalls[0]
          : null;

      if (nativeToolCall) {
        const handled = await this.#handleToolCall({
          event,
          messages,
          completion,
          parsedToolCall: {
            toolName: nativeToolCall.name,
            arguments: nativeToolCall.arguments ?? {},
            toolCallId: nativeToolCall.id,
            rawAssistantText: completion.text,
          },
          toolCalls,
          correctionRetries,
        });

        toolCalls = handled.toolCalls;
        correctionRetries = handled.correctionRetries;

        if (handled.done) {
          return;
        }

        continue;
      }

      const parsed = this.#parseCompletion(completion);

      if (parsed.kind === 'emit_final') {
        if (
          this.#shouldContinueCompletion(completion, continuationCount)
        ) {
          continuationCount += 1;
          const textPart = typeof parsed.text === 'string' ? parsed.text : '';
          if (textPart.length > 0) {
            accumulatedTextParts.push(textPart);
          }

          messages.push({
            role: 'assistant',
            content: typeof completion.text === 'string' ? completion.text : '',
          });
          messages.push({ role: 'user', content: buildContinuationPrompt() });
          const compacted = await this.#compactMessagesForContinuation({
            messages,
            maxOutputTokens,
            continuationCount,
            lastCompletionText: textPart,
          });
          messages = compacted.messages;
          maxOutputTokens = compacted.maxOutputTokens;
          this.#queueEmit({
            type: 'agent:status',
            channel: event.channel,
            sessionId: event.sessionId,
            content: {
              phase: 'generation:continue',
              text: `Continuing truncated response (${continuationCount}/${this.#maxContinuations}).`,
            },
          });
          continue;
        }

        const fullText = `${accumulatedTextParts.join('')}${typeof parsed.text === 'string' ? parsed.text : ''}`;
        await this.#emitFinal(event, completion, fullText);
        return;
      }

      if (parsed.kind === 'retry_parse') {
        const retry = this.#handleParseRetry({
          event,
          messages,
          completion,
          correctionRetries,
          error: parsed.error,
        });

        if (retry.done) {
          return;
        }

        correctionRetries = retry.correctionRetries;
        continue;
      }

      const handled = await this.#handleToolCall({
        event,
        messages,
        completion,
        parsedToolCall: {
          toolName: parsed.toolName,
          arguments: parsed.arguments,
          toolCallId: null,
          rawAssistantText: completion.text,
        },
        toolCalls,
        correctionRetries,
      });

      toolCalls = handled.toolCalls;
      correctionRetries = handled.correctionRetries;

      if (handled.done) {
        return;
      }
    }
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

  #shouldContinueCompletion(completion, continuationCount) {
    if (continuationCount >= this.#maxContinuations) {
      return false;
    }

    const reason = String(completion?.finishReason ?? '').toLowerCase();
    return reason === 'length' || reason === 'max_tokens';
  }

  #parseCompletion(completion) {
    if (!shouldAttemptTextToolParse(completion.text, completion.finishReason)) {
      return {
        kind: 'emit_final',
        text: completion.text,
      };
    }

    const parsed = this.#parser.parse(completion.text);

    if (parsed.kind === 'parse_error') {
      return {
        kind: 'retry_parse',
        error: parsed.error,
      };
    }

    if (parsed.kind === 'final') {
      return {
        kind: 'emit_final',
        text: parsed.text,
      };
    }

    return {
      kind: 'tool_call',
      toolName: parsed.toolName,
      arguments: parsed.arguments,
    };
  }

  #handleParseRetry({ event, messages, completion, correctionRetries, error }) {
    const shouldRetry = correctionRetries < this.#retryLimit;
    if (!shouldRetry) {
      this.#emitCorrectionFailure(
        event,
        'Unable to parse model tool JSON after retries.',
      );
      return { done: true, correctionRetries };
    }

    const nextRetries = correctionRetries + 1;
    messages.push({ role: 'assistant', content: completion.text });
    messages.push({ role: 'system', content: buildCorrectionPrompt(error) });
    this.#queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'parse:retry',
        text: `Retrying response parse (${nextRetries}/${this.#retryLimit}).`,
      },
    });

    return { done: false, correctionRetries: nextRetries };
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

  async #handleToolCall({
    event,
    messages,
    completion,
    parsedToolCall,
    toolCalls,
    correctionRetries,
  }) {
    if (
      !this.#toolRegistry ||
      typeof this.#toolRegistry.execute !== 'function'
    ) {
      throw new Error(
        'Tool call requested but no toolRegistry.execute is configured.',
      );
    }

    const validation =
      typeof this.#toolRegistry.validateCall === 'function'
        ? this.#toolRegistry.validateCall({
            name: parsedToolCall.toolName,
            arguments: parsedToolCall.arguments,
          })
        : { valid: true, errors: [] };

    if (!validation.valid) {
      const reason = validation.errors?.join(' ') || 'Invalid tool call.';
      const shouldRetry = correctionRetries < this.#retryLimit;

      if (!shouldRetry) {
        this.#emitCorrectionFailure(
          event,
          'Unable to produce a valid tool call after retries.',
        );
        return { done: true, toolCalls, correctionRetries };
      }

      const nextRetries = correctionRetries + 1;
      messages.push({
        role: 'assistant',
        content: parsedToolCall.rawAssistantText ?? completion.text,
      });
      messages.push({ role: 'system', content: buildCorrectionPrompt(reason) });
      this.#queueEmit({
        type: 'agent:status',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          phase: 'validate:retry',
          text: `Retrying invalid tool call (${nextRetries}/${this.#retryLimit}).`,
          detail: reason,
        },
      });

      return {
        done: false,
        toolCalls,
        correctionRetries: nextRetries,
      };
    }

    const nextToolCalls = toolCalls + 1;
    if (nextToolCalls > this.#maxToolCallsPerStep) {
      this.#queueEmit({
        type: 'agent:response',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          text: 'Tool call limit reached before final response.',
          finishReason: 'tool_limit',
          usage: completion.usage,
        },
      });
      return { done: true, toolCalls: nextToolCalls, correctionRetries: 0 };
    }

    this.#queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'tool:start',
        text: `Running tool: ${parsedToolCall.toolName}`,
        tool: {
          name: parsedToolCall.toolName,
          arguments: parsedToolCall.arguments,
        },
      },
    });

    const toolResult = await this.#toolRegistry.execute({
      name: parsedToolCall.toolName,
      arguments: parsedToolCall.arguments,
      event,
    });
    await this.#maybeCompleteBootstrap(event);
    await this.#appendSessionTurn(event.sessionId, {
      role: 'assistant',
      type: 'tool_call',
      content: JSON.stringify({
        name: parsedToolCall.toolName,
        arguments: parsedToolCall.arguments,
      }),
    });
    await this.#appendSessionTurn(event.sessionId, {
      role: 'system',
      type: 'tool_result',
      content: JSON.stringify(toolResult),
      meta: { tool: parsedToolCall.toolName },
    });

    this.#queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'tool:complete',
        text: `Tool complete: ${parsedToolCall.toolName}`,
        tool: {
          name: parsedToolCall.toolName,
        },
      },
    });

    messages.push({
      role: 'assistant',
      content: typeof completion.text === 'string' ? completion.text : '',
    });

    messages.push({
      role: 'tool',
      content: JSON.stringify(toolResult),
      tool_call_id: parsedToolCall.toolCallId,
      name: parsedToolCall.toolName,
    });

    return {
      done: false,
      toolCalls: nextToolCalls,
      correctionRetries: 0,
    };
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
