import { buildSystemPrompt } from './prompt.mjs';

export const DEFAULT_CONTEXT_LIMIT = 32_000;
export const DEFAULT_OUTPUT_RESERVE = 3_000;

export const DEFAULT_LAYER_BUDGETS = Object.freeze({
  system: 800,
  task: 4_000,
  skills: 3_000,
  prior: 2_000,
  conversation: 4_000,
});

const LAYER_NAME_ALIASES = Object.freeze({
  systemPrompt: 'system',
  taskScope: 'task',
  stepScope: 'task',
  skillContent: 'skills',
  priorContext: 'prior',
});

const FIXED_LAYER_NAMES = ['system', 'task', 'skills', 'prior'];

const DEFAULT_TOKEN_ESTIMATOR_CONFIG = Object.freeze({
  charsPerToken: 4,
  safetyMargin: 1.1,
});

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
  const sanitized = { ...DEFAULT_LAYER_BUDGETS };
  const mapped = mapLayerBudgetKeys(rawBudgets);
  const normalizedInputBudget = Math.max(0, inputBudget);

  for (const [name, value] of Object.entries(mapped)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LAYER_BUDGETS, name)) {
      continue;
    }

    sanitized[name] = normalizeBudgetValue(value, sanitized[name]);
  }

  return scaleFixedLayerBudgets(sanitized, normalizedInputBudget);
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
    skillContent = '',
    priorSteps = [],
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

  return {
    system: systemText,
    task: stepScopeParts.join('\n\n'),
    skills: toText(skillContent).trim(),
    prior: compressPriorSteps(priorSteps),
  };
}

export class AgentContext {
  #contextLimit;
  #outputReserve;
  #layerBudgets;
  #tokenEstimatorConfig;

  constructor(options = {}) {
    this.#contextLimit = options.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    this.#outputReserve = options.outputReserve ?? DEFAULT_OUTPUT_RESERVE;
    const inputBudget = Math.max(0, this.#contextLimit - this.#outputReserve);
    this.#layerBudgets = normalizeLayerBudgetConfig(options.layerBudgets ?? {}, inputBudget);
    this.#tokenEstimatorConfig = {
      ...DEFAULT_TOKEN_ESTIMATOR_CONFIG,
      ...(options.tokenEstimatorConfig ?? {}),
    };

    if (this.#outputReserve >= this.#contextLimit) {
      throw new TypeError('outputReserve must be smaller than contextLimit.');
    }
  }

  getLayerBudgets() {
    return { ...this.#layerBudgets };
  }

  buildMessages(input = {}) {
    const inputBudget = this.#contextLimit - this.#outputReserve;
    const layers = buildLayerText(input);

    const allocationOrder = ['system', 'task', 'skills', 'prior'];
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

    if (rendered.task) {
      messages.push({ role: 'system', content: rendered.task });
    }

    if (rendered.skills) {
      messages.push({ role: 'system', content: `Skill content:\n${rendered.skills}` });
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

    return {
      messages,
      tokenUsage,
      maxOutputTokens: this.#outputReserve,
    };
  }
}

export function createAgentContext(options) {
  return new AgentContext(options);
}
