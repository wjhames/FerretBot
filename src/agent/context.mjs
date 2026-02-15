import { buildSystemPrompt } from './prompt.mjs';

export const DEFAULT_CONTEXT_LIMIT = 32_000;
export const DEFAULT_OUTPUT_RESERVE = 2_048;
export const MIN_OUTPUT_RESERVE = 256;
export const MAX_OUTPUT_RESERVE = 4_096;

export const DEFAULT_LAYER_BUDGETS = Object.freeze({
  system: 800,
  step: 4_000,
  skills: 3_000,
  identity: 800,
  soul: 1_000,
  user: 800,
  boot: 600,
  memory: 1_200,
  bootstrap: 1_000,
  prior: 2_000,
  conversation: 4_000,
});
export const DEFAULT_LAYER_WEIGHTS = Object.freeze({
  system: 0.08,
  step: 0.25,
  skills: 0.10,
  identity: 0.08,
  soul: 0.10,
  user: 0.08,
  boot: 0.06,
  memory: 0.10,
  bootstrap: 0.07,
  prior: 0.08,
  conversation: 0.10,
});
export const DEFAULT_LAYER_MINIMUMS = Object.freeze({
  system: 256,
  step: 512,
  skills: 256,
  identity: 128,
  soul: 192,
  user: 128,
  boot: 96,
  memory: 128,
  bootstrap: 128,
  prior: 192,
  conversation: 256,
});

const LAYER_NAME_ALIASES = Object.freeze({
  systemPrompt: 'system',
  taskScope: 'step',
  stepScope: 'step',
  skillContent: 'skills',
  identityContext: 'identity',
  soulContext: 'soul',
  userContext: 'user',
  bootContext: 'boot',
  memoryContext: 'memory',
  bootstrapContext: 'bootstrap',
  priorContext: 'prior',
});

const FIXED_LAYER_NAMES = ['system', 'step', 'skills', 'identity', 'soul', 'user', 'boot', 'memory', 'bootstrap', 'prior'];

const DEFAULT_TOKEN_ESTIMATOR_CONFIG = Object.freeze({
  charsPerToken: 4,
  safetyMargin: 1.1,
});
const DEFAULT_COMPLETION_SAFETY_BUFFER = 32;
const CONTINUATION_KEEP_IF_POSSIBLE_TAIL = 8;
const CONTINUATION_SUMMARY_LIMIT = 6;
const CONTINUATION_SUMMARY_SNIPPET_LENGTH = 80;

function normalizeBudgetValue(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function mapLayerBudgetKeys(rawBudgets = {}) {
  const mapped = {};

  for (const [key, value] of Object.entries(rawBudgets)) {
    const canonical = LAYER_NAME_ALIASES[key] ?? key;
    mapped[canonical] = value;
  }

  return mapped;
}

function scaleFixedLayerBudgets(budgets, inputBudget) {
  const sanitized = { ...budgets };
  const totalFixed = FIXED_LAYER_NAMES.reduce((sum, layer) => sum + sanitized[layer], 0);

  if (totalFixed <= inputBudget) {
    return sanitized;
  }

  const scale = inputBudget / totalFixed;
  let scaledTotal = 0;

  for (const layer of FIXED_LAYER_NAMES) {
    const scaledValue = Math.max(0, Math.floor(sanitized[layer] * scale));
    sanitized[layer] = scaledValue;
    scaledTotal += scaledValue;
  }

  let remainder = Math.max(0, inputBudget - scaledTotal);
  for (const layer of FIXED_LAYER_NAMES) {
    if (remainder <= 0) {
      break;
    }

    sanitized[layer] += 1;
    remainder -= 1;
  }

  return sanitized;
}

function normalizeLayerBudgetConfig(rawBudgets, inputBudget) {
  const mapped = mapLayerBudgetKeys(rawBudgets);
  const normalizedInputBudget = Math.max(0, inputBudget);
  const hasExplicitBudgets = Object.keys(mapped).some((name) =>
    Object.prototype.hasOwnProperty.call(DEFAULT_LAYER_BUDGETS, name),
  );
  const sanitized = hasExplicitBudgets
    ? { ...DEFAULT_LAYER_BUDGETS }
    : deriveLayerBudgetsFromInputBudget(normalizedInputBudget);

  if (!hasExplicitBudgets) {
    return sanitized;
  }

  for (const [name, value] of Object.entries(mapped)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LAYER_BUDGETS, name)) {
      continue;
    }

    sanitized[name] = normalizeBudgetValue(value, sanitized[name]);
  }

  return scaleFixedLayerBudgets(sanitized, normalizedInputBudget);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function deriveOutputReserve(contextLimit = DEFAULT_CONTEXT_LIMIT) {
  const normalizedContextLimit = Number.isFinite(contextLimit) && contextLimit > 0
    ? Math.floor(contextLimit)
    : DEFAULT_CONTEXT_LIMIT;
  const target = Math.ceil(normalizedContextLimit * 0.15);
  return clamp(target, MIN_OUTPUT_RESERVE, MAX_OUTPUT_RESERVE);
}

function deriveLayerBudgetsFromInputBudget(inputBudget) {
  const normalizedInputBudget = Math.max(0, Math.floor(inputBudget));
  if (normalizedInputBudget <= 0) {
    return {
      system: 0,
      step: 0,
      skills: 0,
      identity: 0,
      soul: 0,
      user: 0,
      boot: 0,
      memory: 0,
      bootstrap: 0,
      prior: 0,
      conversation: 0,
    };
  }

  const weights = DEFAULT_LAYER_WEIGHTS;
  const minimums = DEFAULT_LAYER_MINIMUMS;
  const budgets = {};
  let assigned = 0;

  for (const name of Object.keys(DEFAULT_LAYER_BUDGETS)) {
    const weighted = Math.floor(normalizedInputBudget * (weights[name] ?? 0));
    const bounded = clamp(weighted, 0, normalizedInputBudget);
    budgets[name] = Math.max(minimums[name] ?? 0, bounded);
    assigned += budgets[name];
  }

  if (assigned > normalizedInputBudget) {
    const fixed = scaleFixedLayerBudgets(budgets, normalizedInputBudget);
    const fixedTotal = Object.keys(DEFAULT_LAYER_BUDGETS).reduce(
      (sum, name) => sum + (fixed[name] ?? 0),
      0,
    );
    if (fixedTotal > normalizedInputBudget) {
      const nonConversationTotal = Object.keys(DEFAULT_LAYER_BUDGETS)
        .filter((name) => name !== 'conversation')
        .reduce((sum, name) => sum + (fixed[name] ?? 0), 0);
      fixed.conversation = Math.max(0, normalizedInputBudget - nonConversationTotal);
    }
    return fixed;
  }

  budgets.conversation += normalizedInputBudget - assigned;
  return budgets;
}
function toText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value == null) {
    return '';
  }

  return JSON.stringify(value);
}

export function estimateTokens(text, options = {}) {
  const charsPerToken = options.charsPerToken ?? DEFAULT_TOKEN_ESTIMATOR_CONFIG.charsPerToken;
  const safetyMargin = options.safetyMargin ?? DEFAULT_TOKEN_ESTIMATOR_CONFIG.safetyMargin;
  const normalized = toText(text);

  if (normalized.length === 0) {
    return 0;
  }

  const raw = normalized.length / charsPerToken;
  return Math.ceil(raw * safetyMargin);
}

function estimateMessageTokens(message, options = {}) {
  return estimateTokens(message?.role ?? '', options)
    + estimateTokens(message?.content ?? '', options)
    + 4;
}

function summarizeMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  return messages
    .slice(-CONTINUATION_SUMMARY_LIMIT)
    .map((message) => {
      const role = toText(message?.role).trim() || 'unknown';
      const content = toText(message?.content).trim();
      if (content.length === 0) {
        return `${role}: [no content]`;
      }
      const snippet = content.length > CONTINUATION_SUMMARY_SNIPPET_LENGTH
        ? `${content.slice(0, CONTINUATION_SUMMARY_SNIPPET_LENGTH)}...`
        : content;
      return `${role}: ${snippet}`;
    })
    .join(' | ');
}

export function truncateToTokenBudget(text, maxTokens, options = {}) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return '';
  }

  const normalized = toText(text);
  if (estimateTokens(normalized, options) <= maxTokens) {
    return normalized;
  }

  const charsPerToken = options.charsPerToken ?? DEFAULT_TOKEN_ESTIMATOR_CONFIG.charsPerToken;
  const safetyMargin = options.safetyMargin ?? DEFAULT_TOKEN_ESTIMATOR_CONFIG.safetyMargin;
  const approxCharBudget = Math.max(0, Math.floor((maxTokens * charsPerToken) / safetyMargin));

  if (approxCharBudget <= 3) {
    return '';
  }

  return `${normalized.slice(0, approxCharBudget - 3)}...`;
}

export function compressPriorSteps(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return '';
  }

  return steps
    .map((step, index) => {
      const id = Number.isInteger(step?.id) ? step.id : index + 1;
      const instruction = toText(step?.instruction).trim() || 'No instruction';
      const result = toText(step?.result).trim() || 'No result';
      return `Step ${id}: ${instruction}. Result: ${result}`;
    })
    .join('\n');
}

export function formatToolSchemas(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  const parts = tools.map((tool) => {
    const name = toText(tool?.name).trim() || 'unknown';
    const description = toText(tool?.description).trim();
    const schema = tool?.schema ? toText(tool.schema) : '';

    const lines = [`Tool: ${name}`];
    if (description) {
      lines.push(`Description: ${description}`);
    }
    if (schema) {
      lines.push(`Schema: ${schema}`);
    }

    return lines.join('\n');
  });

  return parts.join('\n\n');
}

function takeConversationTurns(turns = [], tokenBudget, tokenEstimatorConfig) {
  if (!Array.isArray(turns) || turns.length === 0 || tokenBudget <= 0) {
    return [];
  }

  const selected = [];
  let used = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const role = turn?.role === 'assistant' ? 'assistant' : 'user';
    const content = toText(turn?.content).trim();

    if (content.length === 0) {
      continue;
    }

    const cost = estimateTokens(content, tokenEstimatorConfig);
    if (used + cost > tokenBudget) {
      break;
    }

    used += cost;
    selected.unshift({ role, content });
  }

  return selected;
}

function buildLayerText(options = {}) {
  const {
    step,
    extraRules = '',
    tools = [],
    promptLayers = {},
    skillContent = '',
    priorSteps = [],
    conversationSummary = '',
  } = options;

  const systemText = buildSystemPrompt({
    step,
    extraRules,
  });

  const stepScopeParts = [];
  const toolText = formatToolSchemas(tools);
  if (step?.instruction) {
    stepScopeParts.push(`Current step scope:\n${toText(step.instruction).trim()}`);
  }
  if (toolText) {
    stepScopeParts.push(`Available tools:\n${toolText}`);
  }

  const priorParts = [];
  const compressedSteps = compressPriorSteps(priorSteps);
  if (compressedSteps) {
    priorParts.push(compressedSteps);
  }
  if (toText(conversationSummary).trim()) {
    priorParts.push(`Conversation summary:\n${toText(conversationSummary).trim()}`);
  }

  return {
    system: systemText,
    step: stepScopeParts.join('\n\n'),
    skills: toText(skillContent).trim(),
    identity: toText(promptLayers.identity).trim(),
    soul: toText(promptLayers.soul).trim(),
    user: toText(promptLayers.user).trim(),
    boot: toText(promptLayers.boot).trim(),
    memory: [
      toText(promptLayers.memory).trim(),
      toText(promptLayers.systemMemory).trim(),
      toText(promptLayers.dailyMemory).trim(),
    ].filter((value) => value.length > 0).join('\n\n'),
    bootstrap: toText(promptLayers.bootstrap).trim(),
    prior: priorParts.join('\n\n'),
  };
}

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
      ...DEFAULT_TOKEN_ESTIMATOR_CONFIG,
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
    const conversationMessages = takeConversationTurns(input.conversation, conversationCap, this.#tokenEstimatorConfig);
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
    const {
      messages = [],
      maxOutputTokens = this.#outputReserve,
      continuationCount = 0,
      lastCompletionText = '',
    } = options;

    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        messages: [],
        maxOutputTokens: Math.max(1, this.#outputReserve),
        compacted: false,
      };
    }

    const inputBudget = Math.max(
      1,
      this.#contextLimit - Math.max(1, Math.floor(maxOutputTokens)) - this.#completionSafetyBuffer,
    );
    const keepTailStart = Math.max(0, messages.length - CONTINUATION_KEEP_IF_POSSIBLE_TAIL);

    const mustKeep = [];
    const keepIfPossible = [];
    const evictFirst = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const role = message?.role;
      if (role === 'system' || role === 'tool' || index >= messages.length - 2) {
        mustKeep.push(message);
        continue;
      }
      if (index >= keepTailStart) {
        keepIfPossible.push(message);
        continue;
      }
      evictFirst.push(message);
    }

    let dropped = [];
    const candidate = [...messages];
    const mustKeepSet = new Set(mustKeep);
    let estimated = await this.#estimateMessagesTokens(candidate);
    if (estimated > inputBudget) {
      const orderedDrops = [...evictFirst, ...keepIfPossible];
      for (const drop of orderedDrops) {
        if (estimated <= inputBudget) {
          break;
        }
        if (mustKeepSet.has(drop)) {
          continue;
        }
        const index = candidate.indexOf(drop);
        if (index === -1) {
          continue;
        }
        candidate.splice(index, 1);
        dropped.push(drop);
        estimated = await this.#estimateMessagesTokens(candidate);
      }
    }

    let compactedMessages = candidate;
    if (dropped.length > 0) {
      const summary = summarizeMessages(dropped);
      if (summary) {
        const summaryMessage = {
          role: 'system',
          content: `Compacted earlier context:\n${summary}`,
        };
        compactedMessages = [...candidate];
        const insertAt = compactedMessages.findLastIndex((message) => message?.role === 'system');
        compactedMessages.splice(insertAt >= 0 ? insertAt + 1 : 0, 0, summaryMessage);

        let summaryText = summary;
        while (summaryText.length > 16) {
          const compactedTokens = await this.#estimateMessagesTokens(compactedMessages);
          if (compactedTokens <= inputBudget) {
            break;
          }
          summaryText = `${summaryText.slice(0, Math.floor(summaryText.length * 0.8)).trim()}...`;
          summaryMessage.content = `Compacted earlier context:\n${summaryText}`;
        }
      }
    }

    const finalInputTokens = await this.#estimateMessagesTokens(compactedMessages);
    const availableOutput = Math.max(1, this.#contextLimit - finalInputTokens - this.#completionSafetyBuffer);
    const lastCompletionTokens = await this.#estimateTextTokens(lastCompletionText);
    const priorBasedTarget = Math.max(
      64,
      lastCompletionTokens > 0 ? Math.ceil(lastCompletionTokens * 1.8) : this.#outputReserve,
    );
    const continuationTarget = continuationCount <= 0
      ? availableOutput
      : Math.min(availableOutput, priorBasedTarget);

    return {
      messages: compactedMessages,
      maxOutputTokens: Math.max(1, Math.floor(continuationTarget)),
      compacted: dropped.length > 0,
    };
  }
}

export function createAgentContext(options) {
  return new AgentContext(options);
}
