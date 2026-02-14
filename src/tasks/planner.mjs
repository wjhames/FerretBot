import { createAgentContext } from '../agent/context.mjs';

const DEFAULT_MAX_TOKENS = 1_200;

export class TaskPlanningError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'TaskPlanningError';
    this.errors = errors;
  }
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function extractJsonObject(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }

  let depth = 0;
  let start = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parsePlanPayload(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const snippet = extractJsonObject(text);
    if (!snippet) {
      return null;
    }

    try {
      return JSON.parse(snippet);
    } catch (innerError) {
      return null;
    }
  }
}

function coerceInteger(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number.isInteger(value) ? value : null;
}

export class TaskPlanner {
  #context;
  #provider;
  #toolRegistry;
  #maxTokens;
  #skillNames;

  constructor(options = {}) {
    const { provider, toolRegistry, skillNames = [], contextOptions = {}, maxTokens = DEFAULT_MAX_TOKENS } = options;

    if (!provider || typeof provider.chatCompletion !== 'function') {
      throw new TypeError('TaskPlanner requires a provider with chatCompletion().');
    }

    if (!toolRegistry || typeof toolRegistry.list !== 'function') {
      throw new TypeError('TaskPlanner requires a toolRegistry that exposes list().');
    }

    this.#provider = provider;
    this.#toolRegistry = toolRegistry;
    this.#context = createAgentContext(contextOptions);
    this.#maxTokens = maxTokens;
    this.#skillNames = new Set(this.#normalizeSkillNames(skillNames));
  }

  async plan(goal, options = {}) {
    const normalizedGoal = normalizeText(goal ?? '');
    if (!normalizedGoal) {
      throw new TaskPlanningError('Goal must be provided.');
    }

    const toolDefinitions = this.#getToolsForPlanning(options);
    const contextInput = this.#context.buildMessages({
      mode: 'planning',
      userInput: normalizedGoal,
      tools: toolDefinitions,
      skillContent: options.skillContent ?? '',
      extraRules: options.extraRules ?? '',
    });

    const completion = await this.#provider.chatCompletion({
      messages: contextInput.messages,
      maxTokens: options.maxTokens ?? this.#maxTokens,
      tools: toolDefinitions,
    });

    const rawPlan = parsePlanPayload(completion?.text ?? '');
    if (!rawPlan) {
      throw new TaskPlanningError('Unable to parse a JSON plan from model output.');
    }

    const skillSet = this.#getSkillNames(options);
    return this.#validatePlan(rawPlan, toolDefinitions, skillSet);
  }

  #getToolsForPlanning(options) {
    const provided = options.tools;
    if (Array.isArray(provided) && provided.length > 0) {
      return provided;
    }

    return this.#toolRegistry.list();
  }

  #normalizeSkillNames(values) {
    if (!Array.isArray(values)) {
      return [];
    }

    return values
      .filter((value) => value != null && String(value).trim().length > 0)
      .map((value) => String(value).trim());
  }

  #getSkillNames(options) {
    const extra = options.skillNames ?? [];
    if (Array.isArray(extra) && extra.length > 0) {
      return new Set(this.#normalizeSkillNames(extra));
    }

    return new Set(this.#skillNames);
  }

  #validatePlan(rawPlan, toolDefinitions, skillSet) {
    const errors = [];
    const goal = normalizeText(rawPlan.goal ?? '');

    if (!goal) {
      errors.push('goal is required and must be non-empty.');
    }

    const stepsInput = Array.isArray(rawPlan.steps) ? rawPlan.steps : null;
    if (!stepsInput) {
      errors.push('steps must be an array.');
    }

    const toolNames = new Set(toolDefinitions.map((tool) => tool.name));

    const normalizedSteps = [];
    const seenIds = new Set();

    if (Array.isArray(stepsInput)) {
      for (const rawStep of stepsInput) {
        const stepErrors = [];
        const idValue = coerceInteger(rawStep?.id);

        if (idValue === null) {
          stepErrors.push('step id must be an integer.');
        } else if (seenIds.has(idValue)) {
          stepErrors.push(`duplicate step id ${idValue}.`);
        }

        const instruction = normalizeText(rawStep?.instruction ?? '');
        if (!instruction) {
          stepErrors.push('instruction is required.');
        }

        const tools = Array.isArray(rawStep?.tools)
          ? rawStep.tools.map((tool) => normalizeText(tool)).filter((value) => value.length > 0)
          : [];

        for (const toolName of tools) {
          if (!toolNames.has(toolName)) {
            stepErrors.push(`unknown tool '${toolName}'.`);
          }
        }

        const stepSkill = rawStep?.skill == null ? null : normalizeText(rawStep.skill);
        if (stepSkill && skillSet.size > 0 && !skillSet.has(stepSkill)) {
          stepErrors.push(`unknown skill '${stepSkill}'.`);
        }

        const dependsOnArray = Array.isArray(rawStep?.dependsOn) ? rawStep.dependsOn : [];
        const dependsOn = [];
        for (const ref of dependsOnArray) {
          const refId = coerceInteger(ref);
          if (refId === null) {
            stepErrors.push('dependsOn entries must be integers.');
            continue;
          }
          dependsOn.push(refId);
        }

        if (stepErrors.length === 0) {
          normalizedSteps.push({
            id: idValue,
            instruction,
            tools,
            skill: stepSkill || null,
            dependsOn,
          });
          seenIds.add(idValue);
        } else {
          errors.push(`step ${idValue ?? 'unknown'}: ${stepErrors.join(' ')}`);
        }
      }
    }

    if (normalizedSteps.length === 0) {
      errors.push('at least one valid step is required.');
    }

    for (const step of normalizedSteps) {
      for (const dependency of step.dependsOn) {
        if (!seenIds.has(dependency)) {
          errors.push(`step ${step.id} depends on unknown step ${dependency}.`);
          continue;
        }

        if (dependency >= step.id) {
          errors.push(`step ${step.id} depends on a future or same step ${dependency}.`);
        }
      }
    }

    if (errors.length > 0) {
      throw new TaskPlanningError('Plan validation failed.', errors);
    }

    normalizedSteps.sort((a, b) => a.id - b.id);

    return {
      goal,
      steps: normalizedSteps.map((step) => ({
        id: step.id,
        instruction: step.instruction,
        tools: step.tools,
        skill: step.skill,
        dependsOn: step.dependsOn,
      })),
    };
  }
}

export function createTaskPlanner(options) {
  return new TaskPlanner(options);
}
