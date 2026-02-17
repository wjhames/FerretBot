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

const FIXED_LAYER_NAMES = [
  'system',
  'step',
  'skills',
  'identity',
  'soul',
  'user',
  'boot',
  'memory',
  'bootstrap',
  'prior',
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

export function normalizeLayerBudgetConfig(rawBudgets, inputBudget) {
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

export function deriveOutputReserve(contextLimit = DEFAULT_CONTEXT_LIMIT) {
  const normalizedContextLimit = Number.isFinite(contextLimit) && contextLimit > 0
    ? Math.floor(contextLimit)
    : DEFAULT_CONTEXT_LIMIT;
  const target = Math.ceil(normalizedContextLimit * 0.15);
  return clamp(target, MIN_OUTPUT_RESERVE, MAX_OUTPUT_RESERVE);
}
