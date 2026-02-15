import { createHash } from 'node:crypto';

const TEMPLATE_VERSION = 'ferretbot-2026-02-15-v2';

const DEFAULT_PROMPT_FILES = Object.freeze({
  agents: 'AGENTS.md',
  agentsTemplate: 'AGENTS.template.md',
  boot: 'BOOT.md',
  bootstrap: 'BOOTSTRAP.md',
  identity: 'IDENTITY.md',
  soul: 'SOUL.md',
  user: 'USER.md',
  memory: 'MEMORY.md',
  systemMemory: 'MEMORY.system.md',
  memoryDir: 'memory',
  workflowsDir: 'workflows',
  bootstrapWorkflowDir: 'workflows/bootstrap-init',
  bootstrapWorkflowFile: 'workflows/bootstrap-init/workflow.yaml',
  bootstrapMarker: '.bootstrap-complete',
  bootstrapState: '.bootstrap-state.json',
  templateMeta: '.workspace-templates.json',
});

const BOOTSTRAP_WORKFLOW_ID = 'bootstrap-init';
const BOOTSTRAP_WORKFLOW_VERSION = '1.0.0';

const BOOTSTRAP_STATES = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const TEMPLATE_AGENTS_DEFAULT = `# AGENTS.md

This file gives baseline guidance to every coding agent in this workspace.

## Project Goal
Define the software outcomes you want.

## Constraints
- Security boundaries
- Tooling limits
- Forbidden actions

## Coding Standards
- Style + formatting rules
- Test expectations
- Review quality bar

## Workflow
- Branch + commit conventions
- PR/review process
- Done criteria

## Runtime Context
- Environment assumptions
- Critical paths/config

## Agent Notes
- Where to begin
- Known pitfalls
- Escalation guidance
`;

const TEMPLATE_BOOTSTRAP = `This file indicates first-run bootstrap is pending.

Bootstrap is now executed by the workspace workflow \
\`${DEFAULT_PROMPT_FILES.bootstrapWorkflowFile}\`.

The workflow should gather or initialize operator context and then:
1. Write \
\`${DEFAULT_PROMPT_FILES.bootstrapMarker}\` with JSON: {"status":"complete"}
2. Delete this file (\`${DEFAULT_PROMPT_FILES.bootstrap}\`)
3. Optionally delete bootstrap workflow files
`;

const TEMPLATE_AGENTS = `# AGENTS.md Template

The AGENTS.md file tells your agent how to work in this repository.

## Role and priorities
Define primary responsibilities and what to optimize for.

## Communication
Explain preferred tone, brevity, and update cadence.

## Engineering standards
- Correctness first
- Clear tradeoffs
- Small, reviewable changes

## Tool behavior
- Which tools to use first
- Validation/testing requirements
- Safety boundaries

## Collaboration norms
- Ask when blocked
- Avoid hidden assumptions
- Record important decisions

## Proactive behavior
Describe when to suggest improvements and when to stay minimal.

## Memory policy
Explain what belongs in durable memory and what should remain ephemeral.

## Make it yours
Tune to your team's workflow, stack, and risk profile.
`;

const TEMPLATE_IDENTITY = `# IDENTITY.md

## Name
FerretBot

## Purpose
Local-first coding partner for this workspace.

## Skills
Implementation, debugging, refactoring, and workflow execution.

## Operating style
Pragmatic, concise, and deterministic.

## Boundaries
No fabricated tool results. No unsafe destructive actions.
`;

const TEMPLATE_SOUL = `# SOUL.md

The Heart of Who You Are

This file defines your enduring identity and values.

## Core Values
- Clarity over ambiguity.
- Truth over convenience.
- Momentum with quality.

## Decision Style
- Prefer small, testable changes.
- Surface tradeoffs explicitly.
- Favor deterministic workflows for repetitive tasks.

## Collaboration
- Ask focused questions when needed.
- Report progress frequently and factually.
- Keep commitments and close loops.

## Voice
- Direct, calm, and technically precise.
- Minimal filler and no hype.

## Boundaries
- Never invent execution results.
- Never bypass explicit security constraints.

## Evolution
Adjust details over time, keep core values stable.
`;

const TEMPLATE_USER = `# USER.md

## Identity
- Name:
- Role:
- Context:

## Preferences
- Communication style:
- Technical depth:
- Tooling habits:

## Goals
- Near-term:
- Long-term:

## Constraints
- Time:
- Security/compliance:
- Infrastructure:

## Working agreements
- Do:
- Avoid:

## Unknowns
- Pending clarifications:
`;

const TEMPLATE_BOOT = `# BOOT.md

Session startup checklist.
1. Read AGENTS.md.
2. Read SOUL.md.
3. Read USER.md.
4. Load recent memory files.
`;

const TEMPLATE_MEMORY = `# MEMORY.md

Durable model-owned memory. Keep concise, factual, and useful.
`;

const TEMPLATE_SYSTEM_MEMORY = `# MEMORY.system.md

System-maintained memory summary.
`;

const TEMPLATE_BOOTSTRAP_WORKFLOW = `id: ${BOOTSTRAP_WORKFLOW_ID}
version: "${BOOTSTRAP_WORKFLOW_VERSION}"
name: Workspace Bootstrap
steps:
  - id: ask-user-name
    type: wait_for_input
    prompt: "What name should I use for you?"
    responseKey: user_name
  - id: ask-assistant-name
    type: wait_for_input
    prompt: "What should I call myself in this workspace?"
    responseKey: assistant_name
    dependsOn: [ask-user-name]
  - id: write-user
    type: system_write_file
    path: USER.md
    content: |
      # USER.md

      ## Identity
      - Name: {{args.user_name}}
      - Role:
      - Context:

      ## Preferences
      - Communication style:
      - Technical depth:
      - Tooling habits:

      ## Goals
      - Near-term:
      - Long-term:

      ## Constraints
      - Time:
      - Security/compliance:
      - Infrastructure:

      ## Working agreements
      - Do:
      - Avoid:

      ## Unknowns
      - Pending clarifications:
    dependsOn: [ask-user-name]
  - id: write-identity
    type: system_write_file
    path: IDENTITY.md
    content: |
      # IDENTITY.md

      ## Name
      {{args.assistant_name}}

      ## Purpose
      Local-first coding partner for this workspace.

      ## Skills
      Implementation, debugging, refactoring, and workflow execution.

      ## Operating style
      Pragmatic, concise, and deterministic.

      ## Boundaries
      No fabricated tool results. No unsafe destructive actions.
    dependsOn: [ask-assistant-name]
  - id: mark-complete
    type: system_write_file
    path: ${DEFAULT_PROMPT_FILES.bootstrapMarker}
    content: |
      {"status":"complete"}
    dependsOn: [write-user, write-identity]
  - id: delete-bootstrap-md
    type: system_delete_file
    path: ${DEFAULT_PROMPT_FILES.bootstrap}
    dependsOn: [mark-complete]
  - id: write-bootstrap-state
    type: system_write_file
    path: ${DEFAULT_PROMPT_FILES.bootstrapState}
    content: |
      {
        "state": "completed",
        "reason": "Bootstrap workflow completed.",
        "updatedAt": "workflow-managed"
      }
    dependsOn: [delete-bootstrap-md]
  - id: delete-bootstrap-workflow
    type: system_delete_file
    path: ${DEFAULT_PROMPT_FILES.bootstrapWorkflowDir}
    dependsOn: [write-bootstrap-state]
`;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatDateSegment(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetDate(date, days) {
  const shifted = new Date(date.getTime());
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function buildDailyMemoryTemplate(dateText) {
  return `# ${dateText}\n\n- `;
}

function normalizeFileNames(input = {}) {
  const merged = { ...DEFAULT_PROMPT_FILES, ...input };
  return { ...merged };
}

function digestText(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');
}

function parseJsonSafe(raw = '') {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseCompletionMarker(raw = '') {
  const trimmed = normalizeText(raw);
  if (!trimmed) {
    return false;
  }

  const parsed = parseJsonSafe(trimmed);
  if (parsed && typeof parsed === 'object') {
    if (parsed.complete === true) {
      return true;
    }
    const status = normalizeText(parsed.status).toLowerCase();
    return status === 'complete' || status === 'completed';
  }

  return /\bcomplete(d)?\b/i.test(trimmed);
}

function buildDefaultBootstrapState() {
  return {
    state: BOOTSTRAP_STATES.PENDING,
    updatedAt: null,
    reason: '',
  };
}

export class WorkspaceBootstrapManager {
  #workspaceManager;
  #now;
  #initialized;
  #fileNames;
  #templateVersion;

  constructor(options = {}) {
    const workspaceManager = options.workspaceManager;
    if (!workspaceManager) {
      throw new TypeError('WorkspaceBootstrapManager requires workspaceManager.');
    }

    this.#workspaceManager = workspaceManager;
    this.#now = typeof options.now === 'function' ? options.now : () => new Date();
    this.#initialized = false;
    this.#fileNames = normalizeFileNames(options.fileNames);
    this.#templateVersion = options.templateVersion ?? TEMPLATE_VERSION;
  }

  #buildTemplates() {
    return {
      [this.#fileNames.agents]: TEMPLATE_AGENTS_DEFAULT,
      [this.#fileNames.agentsTemplate]: TEMPLATE_AGENTS,
      [this.#fileNames.boot]: TEMPLATE_BOOT,
      [this.#fileNames.bootstrap]: TEMPLATE_BOOTSTRAP,
      [this.#fileNames.identity]: TEMPLATE_IDENTITY,
      [this.#fileNames.soul]: TEMPLATE_SOUL,
      [this.#fileNames.user]: TEMPLATE_USER,
      [this.#fileNames.memory]: TEMPLATE_MEMORY,
      [this.#fileNames.systemMemory]: TEMPLATE_SYSTEM_MEMORY,
    };
  }

  async #readTemplateMeta() {
    const raw = await this.#workspaceManager.readTextFile(this.#fileNames.templateMeta);
    const parsed = parseJsonSafe(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  }

  async #writeTemplateMeta(templates) {
    const fileDigests = {};
    for (const [fileName, content] of Object.entries(templates)) {
      fileDigests[fileName] = digestText(content);
    }

    const payload = {
      version: this.#templateVersion,
      updatedAt: this.#now().toISOString(),
      migrationStrategy: 'non-destructive',
      files: fileDigests,
    };
    await this.#workspaceManager.writeTextFile(this.#fileNames.templateMeta, JSON.stringify(payload, null, 2));
  }

  async #ensureBootstrapWorkflowSeeded() {
    const state = await this.getBootstrapState();
    const workflowExists = await this.#workspaceManager.exists(this.#fileNames.bootstrapWorkflowFile);

    if (state.state === BOOTSTRAP_STATES.COMPLETED) {
      return;
    }

    if (!workflowExists) {
      await this.#workspaceManager.ensureTextFile(
        this.#fileNames.bootstrapWorkflowFile,
        TEMPLATE_BOOTSTRAP_WORKFLOW,
      );
    }
  }

  async #ensureTemplates() {
    const templates = this.#buildTemplates();
    const priorMeta = await this.#readTemplateMeta();

    for (const [fileName, template] of Object.entries(templates)) {
      await this.#workspaceManager.ensureTextFile(fileName, template);
    }

    if (!priorMeta || priorMeta.version !== this.#templateVersion) {
      await this.#writeTemplateMeta(templates);
    }
  }

  async #writeBootstrapState(state, reason = '') {
    const payload = {
      state,
      reason,
      updatedAt: this.#now().toISOString(),
    };

    await this.#workspaceManager.writeTextFile(
      this.#fileNames.bootstrapState,
      JSON.stringify(payload, null, 2),
    );

    return payload;
  }

  async getBootstrapState() {
    const bootstrapText = await this.#workspaceManager.readTextFile(this.#fileNames.bootstrap);
    const bootstrapExists = normalizeText(bootstrapText).length > 0;

    const markerText = await this.#workspaceManager.readTextFile(this.#fileNames.bootstrapMarker);
    const hasCompletionMarker = parseCompletionMarker(markerText);

    if (hasCompletionMarker && !bootstrapExists) {
      return this.#writeBootstrapState(BOOTSTRAP_STATES.COMPLETED, 'Bootstrap completed.');
    }

    if (hasCompletionMarker && bootstrapExists) {
      return this.#writeBootstrapState(
        BOOTSTRAP_STATES.FAILED,
        'Completion marker exists but BOOTSTRAP.md still present.',
      );
    }

    if (bootstrapExists) {
      return this.#writeBootstrapState(BOOTSTRAP_STATES.ACTIVE, 'Bootstrap in progress.');
    }

    return this.#writeBootstrapState(BOOTSTRAP_STATES.PENDING, 'Bootstrap pending marker.');
  }

  async shouldRunBootstrapWorkflow() {
    await this.ensureInitialized();
    const state = await this.getBootstrapState();
    return state.state === BOOTSTRAP_STATES.ACTIVE;
  }

  async ensureInitialized() {
    if (this.#initialized) {
      return;
    }

    await this.#ensureTemplates();

    const today = this.#now();
    const todayStamp = formatDateSegment(today);
    const yesterdayStamp = formatDateSegment(offsetDate(today, -1));

    await this.#workspaceManager.ensureTextFile(
      `${this.#fileNames.memoryDir}/${todayStamp}.md`,
      buildDailyMemoryTemplate(todayStamp),
    );

    await this.#workspaceManager.ensureTextFile(
      `${this.#fileNames.memoryDir}/${yesterdayStamp}.md`,
      buildDailyMemoryTemplate(yesterdayStamp),
    );

    await this.#workspaceManager.ensureTextFile(
      `${this.#fileNames.workflowsDir}/.keep`,
      '',
    );

    await this.#ensureBootstrapWorkflowSeeded();
    await this.getBootstrapState();
    this.#initialized = true;
  }

  async loadPromptContext() {
    await this.ensureInitialized();

    const now = this.#now();
    const todayStamp = formatDateSegment(now);
    const yesterdayStamp = formatDateSegment(offsetDate(now, -1));

    const [
      agents,
      boot,
      identity,
      soul,
      user,
      memory,
      systemMemory,
      todayMemory,
      yesterdayMemory,
    ] = await Promise.all([
      this.#workspaceManager.readTextFile(this.#fileNames.agents),
      this.#workspaceManager.readTextFile(this.#fileNames.boot),
      this.#workspaceManager.readTextFile(this.#fileNames.identity),
      this.#workspaceManager.readTextFile(this.#fileNames.soul),
      this.#workspaceManager.readTextFile(this.#fileNames.user),
      this.#workspaceManager.readTextFile(this.#fileNames.memory),
      this.#workspaceManager.readTextFile(this.#fileNames.systemMemory),
      this.#workspaceManager.readTextFile(`${this.#fileNames.memoryDir}/${todayStamp}.md`),
      this.#workspaceManager.readTextFile(`${this.#fileNames.memoryDir}/${yesterdayStamp}.md`),
    ]);

    const layers = {
      identity: normalizeText(identity) ? identity.trim() : '',
      soul: normalizeText(soul) ? soul.trim() : '',
      user: normalizeText(user) ? user.trim() : '',
      boot: [
        normalizeText(agents) ? `${this.#fileNames.agents}:\n${agents.trim()}` : '',
        normalizeText(boot) ? `${this.#fileNames.boot}:\n${boot.trim()}` : '',
      ].filter((part) => part.length > 0).join('\n\n'),
      memory: normalizeText(memory) ? `${this.#fileNames.memory}:\n${memory.trim()}` : '',
      systemMemory: normalizeText(systemMemory) ? `${this.#fileNames.systemMemory}:\n${systemMemory.trim()}` : '',
      dailyMemory: [
        normalizeText(yesterdayMemory) ? `Yesterday memory:\n${yesterdayMemory.trim()}` : '',
        normalizeText(todayMemory) ? `Today memory:\n${todayMemory.trim()}` : '',
      ].filter((part) => part.length > 0).join('\n\n'),
      bootstrap: '',
    };

    return {
      bootstrapState: await this.getBootstrapState(),
      extraRules: '',
      layers,
    };
  }

  getBootstrapWorkflowDescriptor() {
    return {
      id: BOOTSTRAP_WORKFLOW_ID,
      version: BOOTSTRAP_WORKFLOW_VERSION,
    };
  }
}

export function createWorkspaceBootstrapManager(options) {
  return new WorkspaceBootstrapManager(options);
}

export const WORKSPACE_TEMPLATE_VERSION = TEMPLATE_VERSION;
export const WORKSPACE_DEFAULT_PROMPT_FILES = DEFAULT_PROMPT_FILES;
export const WORKSPACE_BOOTSTRAP_WORKFLOW_ID = BOOTSTRAP_WORKFLOW_ID;
