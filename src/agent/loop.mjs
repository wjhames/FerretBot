import { createAgentContext } from './context.mjs';

const DEFAULT_PROCESSABLE_EVENTS = new Set([
  'user:input',
  'schedule:trigger',
  'task:step:start',
]);

const DEFAULT_RETRY_LIMIT = 2;
const EMPTY_RESPONSE_TEXT = 'Model returned an empty response.';

function coerceInputText(event) {
  const { content } = event;

  if (typeof content === 'string') {
    return content;
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  return JSON.stringify(content ?? '');
}

function defaultBuildMessages(event) {
  return [{ role: 'user', content: coerceInputText(event) }];
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

function getToolDefinitions(toolRegistry) {
  if (!toolRegistry || typeof toolRegistry.list !== 'function') {
    return [];
  }

  const listed = toolRegistry.list();
  return Array.isArray(listed) ? listed : [];
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
  #maxTokens;
  #maxToolCallsPerStep;
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
      maxTokens = 1024,
      maxToolCallsPerStep = 5,
      retryLimit = DEFAULT_RETRY_LIMIT,
      buildMessages,
    } = options;

    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
      throw new TypeError('AgentLoop requires a bus with on/emit methods.');
    }

    if (!provider || typeof provider.chatCompletion !== 'function') {
      throw new TypeError('AgentLoop requires a provider with chatCompletion().');
    }

    if (!parser || typeof parser.parse !== 'function') {
      throw new TypeError('AgentLoop requires a parser with parse().');
    }

    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new TypeError('maxTokens must be a positive integer.');
    }

    if (!Number.isInteger(maxToolCallsPerStep) || maxToolCallsPerStep <= 0) {
      throw new TypeError('maxToolCallsPerStep must be a positive integer.');
    }

    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new TypeError('retryLimit must be a non-negative integer.');
    }

    this.#bus = bus;
    this.#provider = provider;
    this.#parser = parser;
    this.#toolRegistry = toolRegistry;
    this.#maxTokens = maxTokens;
    this.#maxToolCallsPerStep = maxToolCallsPerStep;
    this.#retryLimit = retryLimit;
    this.#unsubscribe = null;
    this.#pendingEmits = new Set();

    this.#contextManager = this.#createContextManager({ contextManager, buildMessages, maxTokens });
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

  #createContextManager({ contextManager, buildMessages, maxTokens }) {
    if (buildMessages) {
      return {
        buildMessages(input) {
          return {
            messages: buildMessages(input.event),
            maxOutputTokens: maxTokens,
          };
        },
      };
    }

    if (contextManager && typeof contextManager.buildMessages === 'function') {
      return contextManager;
    }

    return {
      buildMessages(input) {
        return {
          messages: defaultBuildMessages(input.event),
          maxOutputTokens: maxTokens,
        };
      },
    };
  }

  #buildInitialContext(event) {
    const builtContext = this.#contextManager.buildMessages({
      event,
      mode: event.type === 'task:step:start' ? 'step' : 'interactive',
      userInput: coerceInputText(event),
      step: event.type === 'task:step:start' ? event.content?.step ?? null : null,
    });

    return {
      messages: [...(builtContext.messages ?? defaultBuildMessages(event))],
      maxOutputTokens: Number.isInteger(builtContext.maxOutputTokens)
        ? builtContext.maxOutputTokens
        : this.#maxTokens,
    };
  }

  async #handleEvent(event) {
    const { messages, maxOutputTokens } = this.#buildInitialContext(event);

    let toolCalls = 0;
    let correctionRetries = 0;

    while (true) {
      const completion = await this.#provider.chatCompletion({
        messages,
        maxTokens: maxOutputTokens,
        tools: getToolDefinitions(this.#toolRegistry),
        toolChoice: 'auto',
      });

      const nativeToolCall = Array.isArray(completion.toolCalls) && completion.toolCalls.length > 0
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
        this.#emitFinal(event, completion, parsed.text);
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
      this.#emitCorrectionFailure(event, 'Unable to parse model tool JSON after retries.');
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

  #emitFinal(event, completion, text) {
    const finalText = normalizeFinalText(text);

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

    if (event.type === 'task:step:start') {
      this.#queueEmit({
        type: 'task:step:complete',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          result: finalText,
        },
      });
    }
  }

  async #handleToolCall({ event, messages, completion, parsedToolCall, toolCalls, correctionRetries }) {
    if (!this.#toolRegistry || typeof this.#toolRegistry.execute !== 'function') {
      throw new Error('Tool call requested but no toolRegistry.execute is configured.');
    }

    const validation =
      typeof this.#toolRegistry.validateCall === 'function'
        ? this.#toolRegistry.validateCall({ name: parsedToolCall.toolName, arguments: parsedToolCall.arguments })
        : { valid: true, errors: [] };

    if (!validation.valid) {
      const reason = validation.errors?.join(' ') || 'Invalid tool call.';
      const shouldRetry = correctionRetries < this.#retryLimit;

      if (!shouldRetry) {
        this.#emitCorrectionFailure(event, 'Unable to produce a valid tool call after retries.');
        return { done: true, toolCalls, correctionRetries };
      }

      const nextRetries = correctionRetries + 1;
      messages.push({ role: 'assistant', content: parsedToolCall.rawAssistantText ?? completion.text });
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
