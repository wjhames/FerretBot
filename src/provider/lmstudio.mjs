const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

export class LmStudioProvider {
  #baseUrl;
  #defaultModel;
  #defaultTemperature;
  #defaultTopP;
  #timeoutMs;
  #fetch;

  constructor(options = {}) {
    const {
      baseUrl = DEFAULT_BASE_URL,
      model = null,
      temperature = 0,
      topP = 1,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      fetchImpl = globalThis.fetch,
    } = options;

    if (typeof fetchImpl !== 'function') {
      throw new TypeError('A fetch implementation is required.');
    }

    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#defaultModel = model;
    this.#defaultTemperature = temperature;
    this.#defaultTopP = topP;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  getConfig() {
    return {
      baseUrl: this.#baseUrl,
      model: this.#defaultModel,
      temperature: this.#defaultTemperature,
      topP: this.#defaultTopP,
      timeoutMs: this.#timeoutMs,
    };
  }

  async chatCompletion(input) {
    const {
      messages,
      maxTokens,
      model = this.#defaultModel,
      temperature = this.#defaultTemperature,
      topP = this.#defaultTopP,
      stream = false,
      signal,
    } = input ?? {};

    this.#validateMessages(messages);

    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new TypeError('maxTokens must be a positive integer.');
    }

    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('model must be provided as a non-empty string.');
    }

    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      stream,
    };

    const response = await this.#fetchJson('/chat/completions', body, signal);
    const firstChoice = response.choices?.[0];

    return {
      id: response.id ?? null,
      model: response.model ?? model,
      text: firstChoice?.message?.content ?? '',
      finishReason: firstChoice?.finish_reason ?? null,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      raw: response,
    };
  }

  async #fetchJson(path, body, signal) {
    const requestSignal = signal ?? AbortSignal.timeout(this.#timeoutMs);
    const url = `${this.#baseUrl}${path}`;

    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LM Studio request failed (${response.status}): ${errorBody}`);
    }

    return response.json();
  }

  #validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError('messages must be a non-empty array.');
    }

    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        throw new TypeError('Each message must be an object.');
      }

      if (typeof message.role !== 'string' || message.role.length === 0) {
        throw new TypeError('Each message.role must be a non-empty string.');
      }

      if (typeof message.content !== 'string') {
        throw new TypeError('Each message.content must be a string.');
      }
    }
  }
}

export function createLmStudioProvider(options) {
  return new LmStudioProvider(options);
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS };
