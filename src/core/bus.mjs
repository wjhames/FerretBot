const DEFAULT_ALLOWED_EVENT_TYPES = [
  'user:input',
  'schedule:trigger',
  'agent:response',
  'task:created',
  'task:step:start',
  'task:step:complete',
  'task:step:failed',
  'task:step:skipped',
  'task:note',
  'task:failed',
  'task:complete',
  'agent:status',
  'workflow:run:queued',
  'workflow:step:start',
  'workflow:step:complete',
  'workflow:needs_approval',
  'workflow:run:complete',
];

export class EventBus {
  #handlersByType = new Map();
  #queue = [];
  #processing = false;
  #allowedEventTypes;

  constructor(options = {}) {
    const allowedEventTypes = options.allowedEventTypes ?? DEFAULT_ALLOWED_EVENT_TYPES;
    this.#allowedEventTypes = new Set(allowedEventTypes);
  }

  on(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Event handler must be a function.');
    }

    if (!this.#handlersByType.has(type)) {
      this.#handlersByType.set(type, []);
    }

    this.#handlersByType.get(type).push(handler);

    return () => {
      const handlers = this.#handlersByType.get(type);
      if (!handlers) {
        return;
      }

      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }

      if (handlers.length === 0) {
        this.#handlersByType.delete(type);
      }
    };
  }

  async emit(event) {
    const normalizedEvent = this.#normalizeEvent(event);

    return new Promise((resolve, reject) => {
      this.#queue.push({ event: normalizedEvent, resolve, reject });
      this.#drainQueue();
    });
  }

  getQueueDepth() {
    return this.#queue.length;
  }

  #normalizeEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('Event must be an object.');
    }

    const { type } = event;
    if (typeof type !== 'string' || type.length === 0) {
      throw new TypeError('Event type must be a non-empty string.');
    }

    if (this.#allowedEventTypes.size > 0 && !this.#allowedEventTypes.has(type)) {
      throw new TypeError(`Unsupported event type: ${type}`);
    }

    return {
      type,
      channel: event.channel ?? 'system',
      sessionId: event.sessionId ?? 'default',
      content: event.content ?? null,
      timestamp: event.timestamp ?? Date.now(),
    };
  }

  async #drainQueue() {
    if (this.#processing) {
      return;
    }

    this.#processing = true;

    while (this.#queue.length > 0) {
      const item = this.#queue.shift();

      try {
        await this.#dispatch(item.event);
        item.resolve(item.event);
      } catch (error) {
        item.reject(error);
      }
    }

    this.#processing = false;
  }

  async #dispatch(event) {
    const typedHandlers = this.#handlersByType.get(event.type) ?? [];
    const wildcardHandlers = this.#handlersByType.get('*') ?? [];
    const handlers = [...typedHandlers, ...wildcardHandlers];

    for (const handler of handlers) {
      await handler(event);
    }
  }
}

export function createEventBus(options) {
  return new EventBus(options);
}

export { DEFAULT_ALLOWED_EVENT_TYPES };
