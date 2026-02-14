import {
  DEFAULT_LMSTUDIO_BASE_URL,
  DEFAULT_LMSTUDIO_MODEL,
  DEFAULT_LMSTUDIO_TIMEOUT_MS,
} from '../core/config-defaults.mjs';
import {
  normalizeCompletionText,
  normalizeToolCalls,
  normalizeToolDefinitions,
  normalizeUsage,
} from './lmstudio-normalize.mjs';

const DEFAULT_BASE_URL = DEFAULT_LMSTUDIO_BASE_URL;
const DEFAULT_TIMEOUT_MS = DEFAULT_LMSTUDIO_TIMEOUT_MS;

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
      model = DEFAULT_LMSTUDIO_MODEL,
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
      tools,
      toolChoice,
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

    const normalizedTools = normalizeToolDefinitions(tools);
    if (normalizedTools && normalizedTools.length > 0) {
      body.tools = normalizedTools;
      if (toolChoice) {
        body.tool_choice = toolChoice;
      }
    }

    const response = await this.#fetchJson('/chat/completions', body, signal);
    const firstChoice = response.choices?.[0] ?? null;
    const toolCalls = normalizeToolCalls(firstChoice);

    return {
      id: response.id ?? null,
      model: response.model ?? model,
      text: normalizeCompletionText(firstChoice, toolCalls),
      toolCalls,
      finishReason: firstChoice?.finish_reason ?? null,
      usage: normalizeUsage(response.usage),
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

      if (!(typeof message.content === 'string' || Array.isArray(message.content) || message.content == null)) {
        throw new TypeError('Each message.content must be a string, array, or null.');
      }
    }
  }
}

export function createLmStudioProvider(options) {
  return new LmStudioProvider(options);
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS };
