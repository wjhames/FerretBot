const DEFAULT_TOKEN_ESTIMATOR_CONFIG = Object.freeze({
  charsPerToken: 4,
  safetyMargin: 1.1,
});

export function toText(value) {
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

export function estimateMessageTokens(message, options = {}) {
  return estimateTokens(message?.role ?? '', options)
    + estimateTokens(message?.content ?? '', options)
    + 4;
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

export function getDefaultTokenEstimatorConfig() {
  return { ...DEFAULT_TOKEN_ESTIMATOR_CONFIG };
}
