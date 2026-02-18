import { buildSystemPrompt } from '../prompt.mjs';
import { toText } from './tokenizer.mjs';

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

export function takeConversationTurns(turns = [], tokenBudget, tokenEstimatorConfig, estimateTokens) {
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

export function buildLayerText(options = {}) {
  const {
    step,
    extraRules = '',
    tools = [],
    includeToolSchemasInPrompt = false,
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
  const toolText = includeToolSchemasInPrompt ? formatToolSchemas(tools) : '';
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
