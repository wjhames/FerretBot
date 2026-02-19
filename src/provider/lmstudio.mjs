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
  #modelCapabilities;
  #tokenizeSupport;

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
    this.#modelCapabilities = null;
    this.#tokenizeSupport = 'unknown';
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

    const response = await this.#fetchJson('/chat/completions', {
      method: 'POST',
      body,
      signal,
    });
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

  async discoverModelCapabilities(options = {}) {
    if (this.#modelCapabilities && !options.force) {
      return this.#modelCapabilities;
    }

    const response = await this.#fetchJson('/models', {
      method: 'GET',
      signal: options.signal,
    });
    const models = Array.isArray(response?.data) ? response.data : [];
    const selectedExact = models.find((model) => model?.id === this.#defaultModel) ?? null;
    if (options.requireDefaultModel && !selectedExact) {
      throw new Error(`Configured LM Studio model '${this.#defaultModel}' was not found.`);
    }

    const selected = selectedExact ?? models[0] ?? {};
    const contextWindow = extractContextWindow(selected);

    this.#modelCapabilities = contextWindow
      ? { model: selected?.id ?? this.#defaultModel, contextWindow, supportsTokenCounting: this.#tokenizeSupport !== 'unsupported' }
      : { model: selected?.id ?? this.#defaultModel, supportsTokenCounting: this.#tokenizeSupport !== 'unsupported' };

    return this.#modelCapabilities;
  }

  async countTokens(input, options = {}) {
    if (this.#tokenizeSupport === 'unsupported') {
      return null;
    }

    const model = typeof options.model === 'string' && options.model.length > 0
      ? options.model
      : this.#defaultModel;
    const normalizedInput = normalizeTokenInput(input);

    try {
      const response = await this.#fetchJson('/tokenize', {
        method: 'POST',
        body: {
          model,
          input: normalizedInput,
        },
        signal: options.signal,
      });
      const counted = parseTokenCount(response);
      if (Number.isFinite(counted) && counted >= 0) {
        this.#tokenizeSupport = 'supported';
        return Math.floor(counted);
      }
    } catch {
      this.#tokenizeSupport = 'unsupported';
      return null;
    }

    this.#tokenizeSupport = 'unsupported';
    return null;
  }

  async #fetchJson(path, options = {}) {
    const {
      method = 'POST',
      body,
      signal,
    } = options;
    const requestSignal = signal ?? AbortSignal.timeout(this.#timeoutMs);
    const url = `${this.#baseUrl}${path}`;
    const headers = {
      'content-type': 'application/json',
    };
    const requestOptions = {
      method,
      headers,
      signal: requestSignal,
    };

    if (body != null) {
      requestOptions.body = JSON.stringify(body);
    }

    const response = await this.#fetch(url, requestOptions);

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

function extractContextWindow(model = {}) {
  const candidates = [
    model.context_length,
    model.context_window,
    model.max_context_length,
    model.contextLength,
    model.maxContextLength,
    model.n_ctx,
    model?.metadata?.context_length,
    model?.metadata?.context_window,
    model?.metadata?.n_ctx,
  ];

  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }

  return null;
}

function normalizeTokenInput(input) {
  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((message) => {
        const role = typeof message?.role === 'string' ? message.role : 'unknown';
        const content = typeof message?.content === 'string'
          ? message.content
          : JSON.stringify(message?.content ?? '');
        return `${role}: ${content}`;
      })
      .join('\n');
  }

  return JSON.stringify(input ?? '');
}

function parseTokenCount(response) {
  const candidates = [
    response?.count,
    response?.total_tokens,
    response?.token_count,
    response?.usage?.total_tokens,
    Array.isArray(response?.tokens) ? response.tokens.length : null,
  ];

  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }

  return null;
}

export function createLmStudioProvider(options) {
  return new LmStudioProvider(options);
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS };
