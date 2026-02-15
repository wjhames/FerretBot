function sanitizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

export function coreIdentity() {
  return [
    'You are FerretBot, a local-first workflow execution agent.',
    'Be precise, concise, and deterministic.',
    'Follow user intent while minimizing unnecessary steps.',
    'Do not fabricate tool results or external facts.',
    'If a required tool fails, explain the failure and next best action.',
    'Use tools only when needed; otherwise return a direct final answer.',
  ].join('\n');
}

export function toolCallFormat() {
  return [
    'Tool call format:',
    '{"tool": "tool_name", "args": {"param": "value"}}',
    'Rules:',
    '- Output exactly one JSON object when calling a tool.',
    '- Use double quotes for all keys and string values.',
    '- Do not include markdown fences or extra prose with tool JSON.',
    '- For final answers, output plain text only (no JSON).',
  ].join('\n');
}

export function stepPreamble(step) {
  const id = Number.isInteger(step?.id) ? step.id : '?';
  const total = Number.isInteger(step?.total) ? step.total : '?';
  const instruction = sanitizeText(step?.instruction) || 'No step instruction provided.';

  return [
    `You are executing step ${id} of ${total}.`,
    `Step instruction: ${instruction}`,
    'Complete this step safely and return either a valid tool call or a final answer.',
  ].join('\n');
}

export function buildSystemPrompt(options = {}) {
  const sections = [coreIdentity(), toolCallFormat()];

  if (options.step) {
    sections.push(stepPreamble(options.step));
  }

  if (options.extraRules && typeof options.extraRules === 'string' && options.extraRules.trim().length > 0) {
    sections.push(options.extraRules.trim());
  }

  return sections.join('\n\n');
}
