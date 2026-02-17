import { WORKFLOW_STEP_START_EVENT, STEP_START_EVENTS } from './agent-events.mjs';

function toCharBudget(tokenBudget) {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor((tokenBudget * 4) / 1.1));
}

export function createAgentContextLoader(options = {}) {
  const {
    contextManager,
    toolRegistry,
    workflowRegistry,
    workflowEngine,
    skillLoader,
    sessionMemory,
    workspaceBootstrap,
    maxTokens,
    getLayerBudget,
    buildMessages,
    defaultBuildMessages,
    coerceInputText,
  } = options;

  function getToolDefinitions() {
    if (!toolRegistry || typeof toolRegistry.list !== 'function') {
      return [];
    }

    const listed = toolRegistry.list();
    return Array.isArray(listed) ? listed : [];
  }

  function getToolDefinitionsForEvent(event) {
    const allTools = getToolDefinitions();

    const stepTools = event.content?.step?.tools;
    if (!Array.isArray(stepTools)) {
      return allTools;
    }

    const allowed = new Set(
      stepTools.filter(
        (name) => typeof name === 'string' && name.trim().length > 0,
      ),
    );

    return allTools.filter((tool) => allowed.has(tool.name));
  }

  async function loadConversationContext(event) {
    if (!sessionMemory || typeof sessionMemory.collectConversation !== 'function') {
      return { turns: [], summary: '' };
    }
    if (!event?.sessionId) {
      return { turns: [], summary: '' };
    }

    const conversationLimit = getLayerBudget('conversation');
    const tokenLimit = Number.isFinite(conversationLimit) && conversationLimit > 0 ? conversationLimit : undefined;

    const collected = await sessionMemory.collectConversation(event.sessionId, {
      tokenLimit,
    });

    const turns = Array.isArray(collected?.turns)
      ? collected.turns.map((entry) => ({
          role: entry?.role === 'assistant' ? 'assistant' : 'user',
          content: String(entry?.content ?? '').trim(),
        })).filter((entry) => entry.content.length > 0)
      : [];

    return {
      turns,
      summary: typeof collected?.summary === 'string' ? collected.summary : '',
    };
  }

  function resolveWorkflowRuntime(event) {
    if (event.type !== WORKFLOW_STEP_START_EVENT) {
      return { workflow: null, run: null };
    }

    const runId = event.content?.runId;
    const run = workflowEngine && typeof workflowEngine.getRun === 'function'
      ? workflowEngine.getRun(runId)
      : null;

    const workflowId = run?.workflowId ?? event.content?.workflowId;
    const workflowVersion = run?.workflowVersion;
    const workflow = workflowId && workflowRegistry && typeof workflowRegistry.get === 'function'
      ? workflowRegistry.get(workflowId, workflowVersion)
      : null;

    return { workflow, run };
  }

  async function loadSkillText(event) {
    if (event.type !== WORKFLOW_STEP_START_EVENT) {
      return '';
    }

    if (!skillLoader || typeof skillLoader.loadSkillsForStep !== 'function') {
      return '';
    }

    const step = event.content?.step;
    const requestedSkills = Array.isArray(step?.loadSkills) ? step.loadSkills : [];
    if (requestedSkills.length === 0) {
      return '';
    }

    const { workflow } = resolveWorkflowRuntime(event);
    const workflowDir = event.content?.workflowDir ?? workflow?.dir;
    if (!workflowDir) {
      return '';
    }

    const skillsBudget = getLayerBudget('skills');
    const loaded = await skillLoader.loadSkillsForStep({
      workflowDir,
      skillNames: requestedSkills,
      maxSkillContentChars: toCharBudget(skillsBudget),
    });

    return loaded?.text ?? '';
  }

  function buildPriorSteps(event) {
    if (event.type !== WORKFLOW_STEP_START_EVENT) {
      return [];
    }

    const { workflow, run } = resolveWorkflowRuntime(event);
    if (!workflow || !run || !Array.isArray(run.steps) || !Array.isArray(workflow.steps)) {
      return [];
    }

    const currentStepId = event.content?.step?.id;
    const currentIndex = workflow.steps.findIndex((step) => step.id === currentStepId);
    const byId = new Map(workflow.steps.map((step, index) => [step.id, { step, index }]));

    const completed = [];
    for (const runStep of run.steps) {
      if (runStep?.state !== 'completed') {
        continue;
      }
      if (runStep.id === currentStepId || runStep.result == null) {
        continue;
      }

      const workflowStep = byId.get(runStep.id);
      if (!workflowStep) {
        continue;
      }
      if (currentIndex !== -1 && workflowStep.index >= currentIndex) {
        continue;
      }

      completed.push({
        id: completed.length + 1,
        instruction: workflowStep.step.instruction,
        result: runStep.result,
      });
    }

    return completed;
  }

  async function loadPromptContext() {
    if (!workspaceBootstrap || typeof workspaceBootstrap.loadPromptContext !== 'function') {
      return { extraRules: '', layers: {} };
    }

    try {
      const loaded = await workspaceBootstrap.loadPromptContext();
      return {
        extraRules: typeof loaded?.extraRules === 'string' ? loaded.extraRules : '',
        layers: loaded && typeof loaded.layers === 'object' && loaded.layers
          ? loaded.layers
          : {},
      };
    } catch {
      return { extraRules: '', layers: {} };
    }
  }

  async function buildInitialContext(event) {
    const isStepEvent = STEP_START_EVENTS.has(event.type);
    const conversationContext = await loadConversationContext(event);
    const skillContent = await loadSkillText(event);
    const priorSteps = buildPriorSteps(event);
    const promptContext = await loadPromptContext();

    const builtContext = await Promise.resolve(contextManager.buildMessages({
      event,
      mode: isStepEvent ? 'step' : 'interactive',
      userInput: coerceInputText(event),
      extraRules: promptContext.extraRules,
      promptLayers: promptContext.layers,
      step: isStepEvent ? (event.content?.step ?? null) : null,
      conversation: conversationContext.turns,
      conversationSummary: conversationContext.summary,
      skillContent,
      priorSteps,
      tools: getToolDefinitionsForEvent(event),
    }));

    return {
      messages: [...(builtContext.messages ?? defaultBuildMessages(event))],
      maxOutputTokens: Number.isInteger(builtContext.maxOutputTokens)
        ? builtContext.maxOutputTokens
        : maxTokens,
    };
  }

  return {
    buildInitialContext,
    getToolDefinitionsForEvent,
  };
}
