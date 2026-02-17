import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_RESERVE,
  MIN_OUTPUT_RESERVE,
  MAX_OUTPUT_RESERVE,
  DEFAULT_LAYER_BUDGETS,
  DEFAULT_LAYER_WEIGHTS,
  DEFAULT_LAYER_MINIMUMS,
  normalizeLayerBudgetConfig,
  deriveOutputReserve,
} from './budgets.mjs';
import {
  estimateTokens,
  estimateMessageTokens,
  truncateToTokenBudget,
  getDefaultTokenEstimatorConfig,
} from './tokenizer.mjs';
import {
  compressPriorSteps,
  formatToolSchemas,
  takeConversationTurns,
  buildLayerText,
} from './layers.mjs';
import { compactMessagesForContinuation } from './compaction.mjs';

const DEFAULT_COMPLETION_SAFETY_BUFFER = 32;

export {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_RESERVE,
  MIN_OUTPUT_RESERVE,
  MAX_OUTPUT_RESERVE,
  DEFAULT_LAYER_BUDGETS,
  DEFAULT_LAYER_WEIGHTS,
  DEFAULT_LAYER_MINIMUMS,
  deriveOutputReserve,
  estimateTokens,
  truncateToTokenBudget,
  compressPriorSteps,
  formatToolSchemas,
};

export class AgentContext {
  #contextLimit;
  #outputReserve;
  #layerBudgets;
  #tokenEstimatorConfig;
  #completionSafetyBuffer;
  #tokenCounter;

  constructor(options = {}) {
    this.#contextLimit = options.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    this.#outputReserve = options.outputReserve ?? deriveOutputReserve(this.#contextLimit);
    const inputBudget = Math.max(0, this.#contextLimit - this.#outputReserve);
    this.#layerBudgets = normalizeLayerBudgetConfig(options.layerBudgets ?? {}, inputBudget);
    this.#tokenEstimatorConfig = {
      ...getDefaultTokenEstimatorConfig(),
      ...(options.tokenEstimatorConfig ?? {}),
    };
    this.#completionSafetyBuffer = Number.isFinite(options.completionSafetyBuffer)
      ? Math.max(0, Math.floor(options.completionSafetyBuffer))
      : DEFAULT_COMPLETION_SAFETY_BUFFER;
    this.#tokenCounter = typeof options.tokenCounter === 'function' ? options.tokenCounter : null;

    if (this.#outputReserve >= this.#contextLimit) {
      throw new TypeError('outputReserve must be smaller than contextLimit.');
    }
  }

  getLayerBudgets() {
    return { ...this.#layerBudgets };
  }

  async #estimateMessagesTokens(messages = []) {
    if (this.#tokenCounter) {
      try {
        const counted = await this.#tokenCounter(messages);
        if (Number.isFinite(counted) && counted >= 0) {
          return Math.floor(counted);
        }
      } catch {
        // Fall back to local estimator when remote tokenizer is unavailable.
      }
    }

    return messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message, this.#tokenEstimatorConfig),
      0,
    );
  }

  async #estimateTextTokens(text) {
    if (this.#tokenCounter) {
      try {
        const counted = await this.#tokenCounter(String(text ?? ''));
        if (Number.isFinite(counted) && counted >= 0) {
          return Math.floor(counted);
        }
      } catch {
        // Fall back to local estimator when remote tokenizer is unavailable.
      }
    }

    return estimateTokens(text, this.#tokenEstimatorConfig);
  }

  buildMessages(input = {}) {
    const inputBudget = this.#contextLimit - this.#outputReserve;
    const layers = buildLayerText(input);

    const allocationOrder = ['system', 'step', 'skills', 'identity', 'soul', 'user', 'boot', 'memory', 'bootstrap', 'prior'];
    const rendered = {};
    const tokenUsage = {
      totalInputBudget: inputBudget,
      outputReserve: this.#outputReserve,
      usedInputTokens: 0,
      layers: {},
    };

    let remainingBudget = inputBudget;

    for (const name of allocationOrder) {
      const layerBudget = Math.min(this.#layerBudgets[name] ?? 0, remainingBudget);
      const text = truncateToTokenBudget(layers[name], layerBudget, this.#tokenEstimatorConfig);
      const tokens = estimateTokens(text, this.#tokenEstimatorConfig);

      rendered[name] = text;
      tokenUsage.layers[name] = tokens;
      tokenUsage.usedInputTokens += tokens;
      remainingBudget = Math.max(0, remainingBudget - tokens);
    }

    const conversationCap = Math.min(this.#layerBudgets.conversation ?? 0, remainingBudget);
    const conversationMessages = takeConversationTurns(
      input.conversation,
      conversationCap,
      this.#tokenEstimatorConfig,
      estimateTokens,
    );
    const conversationTokens = conversationMessages.reduce(
      (sum, message) => sum + estimateTokens(message.content, this.#tokenEstimatorConfig),
      0,
    );

    tokenUsage.layers.conversation = conversationTokens;
    tokenUsage.usedInputTokens += conversationTokens;

    const messages = [];

    if (rendered.system) {
      messages.push({ role: 'system', content: rendered.system });
    }

    if (rendered.step) {
      messages.push({ role: 'system', content: rendered.step });
    }

    if (rendered.skills) {
      messages.push({ role: 'system', content: `Skill content:\n${rendered.skills}` });
    }

    if (rendered.identity) {
      messages.push({ role: 'system', content: `Identity:\n${rendered.identity}` });
    }

    if (rendered.soul) {
      messages.push({ role: 'system', content: `Soul:\n${rendered.soul}` });
    }

    if (rendered.user) {
      messages.push({ role: 'system', content: `User:\n${rendered.user}` });
    }

    if (rendered.boot) {
      messages.push({ role: 'system', content: `Boot:\n${rendered.boot}` });
    }

    if (rendered.memory) {
      messages.push({ role: 'system', content: `Memory:\n${rendered.memory}` });
    }

    if (rendered.bootstrap) {
      messages.push({ role: 'system', content: `Bootstrap:\n${rendered.bootstrap}` });
    }

    if (rendered.prior) {
      messages.push({ role: 'system', content: `Prior context:\n${rendered.prior}` });
    }

    messages.push(...conversationMessages);

    if (input.userInput && String(input.userInput).trim().length > 0) {
      messages.push({ role: 'user', content: String(input.userInput).trim() });
      const userTokens = estimateTokens(String(input.userInput).trim(), this.#tokenEstimatorConfig);
      tokenUsage.layers.userInput = userTokens;
      tokenUsage.usedInputTokens += userTokens;
    } else {
      tokenUsage.layers.userInput = 0;
    }

    const remainingForOutput = this.#contextLimit - tokenUsage.usedInputTokens - this.#completionSafetyBuffer;
    const dynamicOutputBudget = Math.max(1, Math.floor(remainingForOutput));

    return {
      messages,
      tokenUsage,
      maxOutputTokens: dynamicOutputBudget,
    };
  }

  async compactMessagesForContinuation(options = {}) {
    return compactMessagesForContinuation({
      ...options,
      contextLimit: this.#contextLimit,
      outputReserve: this.#outputReserve,
      completionSafetyBuffer: this.#completionSafetyBuffer,
      estimateMessagesTokens: (messages) => this.#estimateMessagesTokens(messages),
      estimateTextTokens: (text) => this.#estimateTextTokens(text),
    });
  }
}

export function createAgentContext(options) {
  return new AgentContext(options);
}
