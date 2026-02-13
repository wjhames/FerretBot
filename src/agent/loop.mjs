import { createAgentContext } from './context.mjs';

const DEFAULT_PROCESSABLE_EVENTS = new Set([
  'user:input',
  'schedule:trigger',
  'task:step:start',
]);

const DEFAULT_RETRY_LIMIT = 2;

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
    this.#contextManager =
      contextManager ??
      createAgentContext({
        outputReserve: maxTokens,
      });
    this.#toolRegistry = toolRegistry;
    this.#maxTokens = maxTokens;
    this.#maxToolCallsPerStep = maxToolCallsPerStep;
    this.#retryLimit = retryLimit;
    this.#unsubscribe = null;
    this.#pendingEmits = new Set();

    if (buildMessages) {
      this.#contextManager = {
        buildMessages(input) {
          return {
            messages: buildMessages(input.event),
            maxOutputTokens: maxTokens,
          };
        },
      };
    }

    if (!this.#contextManager || typeof this.#contextManager.buildMessages !== 'function') {
      this.#contextManager = {
        buildMessages(input) {
          return {
            messages: defaultBuildMessages(input.event),
            maxOutputTokens: maxTokens,
          };
        },
      };
    }
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

  async #handleEvent(event) {
    const builtContext = this.#contextManager.buildMessages({
      event,
      mode: event.type === 'task:step:start' ? 'step' : 'interactive',
      userInput: coerceInputText(event),
      step: event.type === 'task:step:start' ? event.content?.step ?? null : null,
    });

    const messages = [...(builtContext.messages ?? defaultBuildMessages(event))];
    const maxOutputTokens = Number.isInteger(builtContext.maxOutputTokens)
      ? builtContext.maxOutputTokens
      : this.#maxTokens;

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
        const parsedToolCall = {
          toolName: nativeToolCall.name,
          arguments: nativeToolCall.arguments ?? {},
          toolCallId: nativeToolCall.id,
          rawAssistantText: completion.text,
        };

        const handled = await this.#handleToolCall({
          event,
          messages,
          completion,
          parsedToolCall,
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

      const parsed = this.#parser.parse(completion.text);

      if (parsed.kind === 'parse_error') {
        const shouldRetry = correctionRetries < this.#retryLimit;
        if (!shouldRetry) {
          this.#emitCorrectionFailure(event, 'Unable to parse model tool JSON after retries.');
          return;
        }

        correctionRetries += 1;
        messages.push({ role: 'assistant', content: completion.text });
        messages.push({ role: 'system', content: buildCorrectionPrompt(parsed.error) });
        this.#queueEmit({
          type: 'agent:status',
          channel: event.channel,
          sessionId: event.sessionId,
          content: {
            phase: 'parse:retry',
            text: `Retrying response parse (${correctionRetries}/${this.#retryLimit}).`,
          },
        });
        continue;
      }

      if (parsed.kind === 'final') {
        const finalText = parsed.text.trim().length > 0 ? parsed.text : 'Model returned an empty response.';
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

        return;
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

    let nextToolCalls = toolCalls + 1;
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
