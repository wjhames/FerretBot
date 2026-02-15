const BOOTSTRAP_FILE = 'BOOTSTRAP.md';
const BOOTSTRAP_COMPLETE_MARKER = '.bootstrap-complete';
const REQUIRED_BOOTSTRAP_FILES = Object.freeze([
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
]);

const TEMPLATE_AGENTS_DEFAULT = `# AGENTS.md

This file gives baseline guidance to any AI coding assistant working in this repository.

## Project summary
brief project summary.

## Scope
- active goals
- out of scope

## Constraints
- allowed tools/actions
- forbidden actions
- security boundaries

## Code style
- language/style preferences
- lint/format requirements
- testing expectations

## Workflow
- branch strategy
- PR/review process
- commit conventions

## Runtime context
- environment assumptions
- key configs/flags

## Notes for agents
- where to start
- pitfalls
- done criteria
`;

const TEMPLATE_BOOTSTRAP = `This file exists for the first session in a fresh workspace.

## Mission
Initialize your operator identity and working context before normal operation.

## Actions to take now
1. Read \`AGENTS.md\` and follow it.
2. Read and update \`IDENTITY.md\` with your handle, role, and mode.
3. Read and update \`USER.md\` with everything known about the user.
4. Read and update \`SOUL.md\` to set behavioral defaults.
5. Optionally update \`BOOT.md\` if startup behavior should change.
6. Create or update \`memory.md\` with anything durable you should remember.
7. When done, delete this file (\`BOOTSTRAP.md\`).

## Completion rule
Bootstrap is complete only after steps 2-4 are meaningfully filled and this file is deleted.
`;

const TEMPLATE_AGENTS = `# AGENTS.md

This file provides project-level instructions for AI coding agents.

## Project summary
brief project summary

## Scope
- active goals
- out of scope

## Constraints
- security boundaries
- forbidden actions
- tool limits

## Code style
- language conventions
- lint/format rules
- test expectations

## Workflow
- branch + commit conventions
- review process

## Runtime context
- environment assumptions
- important configs

## Notes for agents
- known pitfalls
- completion criteria
`;

const TEMPLATE_IDENTITY = `# IDENTITY

Purpose: Define who you are as this user's persistent coding agent.

## Handle
- Name:
- Alias:

## Role
- Primary function:
- Secondary function:

## Operating mode
- Tone:
- Verbosity:
- Risk posture:

## Interaction preferences
- How you present plans:
- How you report progress:
- How you escalate uncertainty:

## Guardrails
- Never do:
- Always do:

## Session defaults
- Preferred languages/tools:
- Default test strategy:
`;

const TEMPLATE_SOUL = `# SOUL.md

Purpose: Capture enduring behavioral traits that shape decisions.

## Core values
- value:
- value:
- value:

## Decision style
- prioritize:
- avoid:

## Collaboration style
- with user:
- with codebase:

## Quality bar
- minimum acceptable:
- preferred standard:

## Failure behavior
- when blocked:
- when uncertain:

## Evolution notes
- How this should change over time:
`;

const TEMPLATE_USER = `# USER

Purpose: Persist what is known about the user so collaboration improves over time.

## Identity
- Name:
- Role:
- Team/Org:

## Preferences
- Communication:
- Technical depth:
- Tooling:

## Goals
- Short-term:
- Long-term:

## Constraints
- Time:
- Security/compliance:
- Infrastructure:

## Working agreements
- do:
- don't:

## Open questions
- unknowns to clarify:
`;

const TEMPLATE_BOOT = `# BOOT.md

Purpose: Startup checklist run at beginning of normal sessions.

## Startup actions
1. Read \`AGENTS.md\`.
2. Read \`SOUL.md\`.
3. Read \`USER.md\`.
4. Load recent memory context.

## Startup checks
- confirm workspace access
- confirm tool availability
- confirm current goals
`;

const TEMPLATE_MEMORY = `# MEMORY.md

Durable memory. Keep concise, high-signal, and factual.
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

function equalTrimmed(left, right) {
  return normalizeText(left) === normalizeText(right);
}

const TEMPLATE_BY_FILE = Object.freeze({
  'AGENTS.md': TEMPLATE_AGENTS_DEFAULT,
  'BOOTSTRAP.md': TEMPLATE_BOOTSTRAP,
  'BOOT.md': TEMPLATE_BOOT,
  'IDENTITY.md': TEMPLATE_IDENTITY,
  'SOUL.md': TEMPLATE_SOUL,
  'USER.md': TEMPLATE_USER,
  'MEMORY.md': TEMPLATE_MEMORY,
  'AGENTS.template.md': TEMPLATE_AGENTS,
});

export class WorkspaceBootstrapManager {
  #workspaceManager;
  #now;
  #initialized;

  constructor(options = {}) {
    const workspaceManager = options.workspaceManager;
    if (!workspaceManager) {
      throw new TypeError('WorkspaceBootstrapManager requires workspaceManager.');
    }

    this.#workspaceManager = workspaceManager;
    this.#now = typeof options.now === 'function' ? options.now : () => new Date();
    this.#initialized = false;
  }

  async ensureInitialized() {
    if (this.#initialized) {
      return;
    }

    for (const [fileName, template] of Object.entries(TEMPLATE_BY_FILE)) {
      await this.#workspaceManager.ensureTextFile(fileName, template);
    }

    const today = this.#now();
    const todayPath = `memory/${formatDateSegment(today)}.md`;
    const yesterdayPath = `memory/${formatDateSegment(offsetDate(today, -1))}.md`;

    await this.#workspaceManager.ensureTextFile(
      todayPath,
      buildDailyMemoryTemplate(formatDateSegment(today)),
    );
    await this.#workspaceManager.ensureTextFile(
      yesterdayPath,
      buildDailyMemoryTemplate(formatDateSegment(offsetDate(today, -1))),
    );

    this.#initialized = true;
  }

  async maybeCompleteBootstrap() {
    await this.ensureInitialized();

    const bootstrap = normalizeText(await this.#workspaceManager.readTextFile(BOOTSTRAP_FILE));
    if (!bootstrap) {
      return false;
    }

    for (const fileName of REQUIRED_BOOTSTRAP_FILES) {
      const content = await this.#workspaceManager.readTextFile(fileName);
      if (!normalizeText(content)) {
        return false;
      }
      const template = TEMPLATE_BY_FILE[fileName] ?? '';
      if (equalTrimmed(content, template)) {
        return false;
      }
    }

    await this.#workspaceManager.removePath(BOOTSTRAP_FILE);
    const payload = JSON.stringify(
      {
        completedAt: this.#now().toISOString(),
        version: 1,
      },
      null,
      2,
    );
    await this.#workspaceManager.writeTextFile(BOOTSTRAP_COMPLETE_MARKER, payload);
    return true;
  }

  async loadPromptContext() {
    await this.ensureInitialized();
    await this.maybeCompleteBootstrap();

    const [
      agents,
      boot,
      identity,
      soul,
      user,
      memory,
      bootstrap,
      todayMemory,
      yesterdayMemory,
    ] = await Promise.all([
      this.#workspaceManager.readTextFile('AGENTS.md'),
      this.#workspaceManager.readTextFile('BOOT.md'),
      this.#workspaceManager.readTextFile('IDENTITY.md'),
      this.#workspaceManager.readTextFile('SOUL.md'),
      this.#workspaceManager.readTextFile('USER.md'),
      this.#workspaceManager.readTextFile('MEMORY.md'),
      this.#workspaceManager.readTextFile(BOOTSTRAP_FILE),
      this.#workspaceManager.readTextFile(`memory/${formatDateSegment(this.#now())}.md`),
      this.#workspaceManager.readTextFile(`memory/${formatDateSegment(offsetDate(this.#now(), -1))}.md`),
    ]);

    const extraRulesParts = [];
    if (normalizeText(agents)) {
      extraRulesParts.push(`AGENTS.md:\n${agents.trim()}`);
    }
    if (normalizeText(boot)) {
      extraRulesParts.push(`BOOT.md:\n${boot.trim()}`);
    }
    if (normalizeText(identity)) {
      extraRulesParts.push(`IDENTITY.md:\n${identity.trim()}`);
    }
    if (normalizeText(soul)) {
      extraRulesParts.push(`SOUL.md:\n${soul.trim()}`);
    }
    if (normalizeText(user)) {
      extraRulesParts.push(`USER.md:\n${user.trim()}`);
    }
    if (normalizeText(memory)) {
      extraRulesParts.push(`MEMORY.md:\n${memory.trim()}`);
    }
    if (normalizeText(yesterdayMemory)) {
      extraRulesParts.push(`Yesterday memory:\n${yesterdayMemory.trim()}`);
    }
    if (normalizeText(todayMemory)) {
      extraRulesParts.push(`Today memory:\n${todayMemory.trim()}`);
    }

    const bootstrapActive = normalizeText(bootstrap).length > 0;
    if (bootstrapActive) {
      extraRulesParts.push(
        [
          'Bootstrap mode active: complete initialization now.',
          'Update IDENTITY.md, SOUL.md, and USER.md with meaningful content.',
          'When done, delete BOOTSTRAP.md.',
        ].join('\n'),
      );
      extraRulesParts.push(`BOOTSTRAP.md:\n${bootstrap.trim()}`);
    }

    return {
      bootstrapActive,
      extraRules: extraRulesParts.join('\n\n'),
    };
  }
}

export function createWorkspaceBootstrapManager(options) {
  return new WorkspaceBootstrapManager(options);
}

export const WORKSPACE_TEMPLATE_CONTENT = TEMPLATE_BY_FILE;
