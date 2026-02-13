const DEFAULT_PROCESSABLE_EVENTS = new Set([
  'user:input',
  'schedule:trigger',
  'task:step:start',
]);

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

export class AgentLoop {
  #bus;
  #provider;
  #parser;
  #toolRegistry;
  #maxTokens;
  #maxToolCallsPerStep;
  #buildMessages;
  #unsubscribe;
  #pendingEmits;

  constructor(options = {}) {
    const {
      bus,
      provider,
      parser,
      toolRegistry = null,
      maxTokens = 1024,
      maxToolCallsPerStep = 5,
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

    this.#bus = bus;
    this.#provider = provider;
    this.#parser = parser;
    this.#toolRegistry = toolRegistry;
    this.#maxTokens = maxTokens;
    this.#maxToolCallsPerStep = maxToolCallsPerStep;
    this.#buildMessages = buildMessages ?? ((event) => [{ role: 'user', content: coerceInputText(event) }]);
    this.#unsubscribe = null;
    this.#pendingEmits = new Set();
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
    const messages = [...this.#buildMessages(event)];
    let toolCalls = 0;

    while (true) {
      const completion = await this.#provider.chatCompletion({
        messages,
        maxTokens: this.#maxTokens,
      });

      const parsed = this.#parser.parse(completion.text);
      if (parsed.kind === 'final') {
        this.#queueEmit({
          type: 'agent:response',
          channel: event.channel,
          sessionId: event.sessionId,
          content: {
            text: parsed.text,
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
              result: parsed.text,
            },
          });
        }

        return;
      }

      if (!this.#toolRegistry || typeof this.#toolRegistry.execute !== 'function') {
        throw new Error('Tool call requested but no toolRegistry.execute is configured.');
      }

      toolCalls += 1;
      if (toolCalls > this.#maxToolCallsPerStep) {
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
        return;
      }

      this.#queueEmit({
        type: 'agent:status',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          phase: 'tool:start',
          text: `Running tool: ${parsed.toolName}`,
          tool: {
            name: parsed.toolName,
            arguments: parsed.arguments,
          },
        },
      });

      const toolResult = await this.#toolRegistry.execute({
        name: parsed.toolName,
        arguments: parsed.arguments,
        event,
      });

      this.#queueEmit({
        type: 'agent:status',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          phase: 'tool:complete',
          text: `Tool complete: ${parsed.toolName}`,
          tool: {
            name: parsed.toolName,
          },
        },
      });

      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          name: parsed.toolName,
          result: toolResult,
        }),
      });
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
