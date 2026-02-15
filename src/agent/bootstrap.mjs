import { createHash } from 'node:crypto';

const TEMPLATE_VERSION = 'openclaw-2026-02-15-v1';

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
  bootstrapMarker: '.bootstrap-complete',
  bootstrapState: '.bootstrap-state.json',
  templateMeta: '.workspace-templates.json',
});

const BOOTSTRAP_STATES = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const REQUIRED_BOOTSTRAP_KEYS = Object.freeze(['identity', 'soul', 'user']);

const TEMPLATE_AGENTS_DEFAULT = `# AGENTS.md\n\nThis file gives baseline guidance to every coding agent in this workspace.\n\n## Project Goal\nDefine the software outcomes you want.\n\n## Constraints\n- Security boundaries\n- Tooling limits\n- Forbidden actions\n\n## Coding Standards\n- Style + formatting rules\n- Test expectations\n- Review quality bar\n\n## Workflow\n- Branch + commit conventions\n- PR/review process\n- Done criteria\n\n## Runtime Context\n- Environment assumptions\n- Critical paths/config\n\n## Agent Notes\n- Where to begin\n- Known pitfalls\n- Escalation guidance\n`;

const TEMPLATE_BOOTSTRAP = `This file controls one-time onboarding.\n\nFollow these steps exactly:\n\n1. Read AGENTS.md.\n2. Update IDENTITY.md with who you are and how you operate.\n3. Update USER.md with what you know about the operator.\n4. Update SOUL.md with enduring values and behavior.\n5. Update BOOT.md if startup behavior should change.\n6. Update MEMORY.md with durable context.\n7. Write a completion marker file at .bootstrap-complete with JSON {"status":"complete"}.\n8. After completion marker exists, remove BOOTSTRAP.md.\n\nIf you cannot finish onboarding, explain why and leave BOOTSTRAP.md in place.\n`;

const TEMPLATE_AGENTS = `# AGENTS.md Template\n\nThe AGENTS.md file tells your agent how to work in this repository.\n\n## Role and priorities\nDefine primary responsibilities and what to optimize for.\n\n## Communication\nExplain preferred tone, brevity, and update cadence.\n\n## Engineering standards\n- Correctness first\n- Clear tradeoffs\n- Small, reviewable changes\n\n## Tool behavior\n- Which tools to use first\n- Validation/testing requirements\n- Safety boundaries\n\n## Collaboration norms\n- Ask when blocked\n- Avoid hidden assumptions\n- Record important decisions\n\n## Proactive behavior\nDescribe when to suggest improvements and when to stay minimal.\n\n## Memory policy\nExplain what belongs in durable memory and what should remain ephemeral.\n\n## Make it yours\nTune to your team's workflow, stack, and risk profile.\n`;

const TEMPLATE_IDENTITY = `Who are you?\n\nDescribe your identity as an assistant in this workspace.\n\n## Name\nWhat should the user call you?\n\n## Purpose\nWhat are you for?\n\n## Skills\nWhat are you especially good at?\n\n## Operating style\nHow do you think, communicate, and decide?\n\n## Boundaries\nWhat will you never do?\n`;

const TEMPLATE_SOUL = `The Heart of Who You Are\n\nThis file describes your lasting values and character.\n\n## Core values\n3-5 principles that guide choices.\n\n## Decision model\nHow you trade off speed, quality, and risk.\n\n## Relationship with the user\nHow you support, challenge, and collaborate.\n\n## Voice\nHow your responses should feel.\n\n## Boundaries\nRed lines and non-negotiables.\n\n## Evolution\nHow this soul should adapt over time while staying coherent.\n`;

const TEMPLATE_USER = `Who is the user?\n\nCapture stable facts and collaboration preferences.\n\n## Identity\n- Name\n- Role\n- Context\n\n## Preferences\n- Communication style\n- Technical depth\n- Tooling habits\n\n## Goals\n- Near-term\n- Long-term\n\n## Constraints\n- Time\n- Security/compliance\n- Infrastructure\n\n## Working agreements\n- Do\n- Avoid\n\n## Unknowns\nWhat still needs confirmation.\n`;

const TEMPLATE_BOOT = 'Standard session startup procedures, hooks, and checks.';

const TEMPLATE_MEMORY = `# MEMORY.md\n\nDurable model-owned memory. Keep concise, factual, and useful.\n`;

const TEMPLATE_SYSTEM_MEMORY = `# MEMORY.system.md\n\nSystem-maintained memory summary. Do not treat this as editable preference storage.\n`;

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
  return {
    agents: merged.agents,
    agentsTemplate: merged.agentsTemplate,
    boot: merged.boot,
    bootstrap: merged.bootstrap,
    identity: merged.identity,
    soul: merged.soul,
    user: merged.user,
    memory: merged.memory,
    systemMemory: merged.systemMemory,
    memoryDir: merged.memoryDir,
    bootstrapMarker: merged.bootstrapMarker,
    bootstrapState: merged.bootstrapState,
    templateMeta: merged.templateMeta,
  };
}

function digestText(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');
}

function buildTemplates(fileNames) {
  return {
    [fileNames.agents]: TEMPLATE_AGENTS_DEFAULT,
    [fileNames.agentsTemplate]: TEMPLATE_AGENTS,
    [fileNames.boot]: TEMPLATE_BOOT,
    [fileNames.bootstrap]: TEMPLATE_BOOTSTRAP,
    [fileNames.identity]: TEMPLATE_IDENTITY,
    [fileNames.soul]: TEMPLATE_SOUL,
    [fileNames.user]: TEMPLATE_USER,
    [fileNames.memory]: TEMPLATE_MEMORY,
    [fileNames.systemMemory]: TEMPLATE_SYSTEM_MEMORY,
  };
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

  async #ensureTemplates() {
    const templates = buildTemplates(this.#fileNames);
    const priorMeta = await this.#readTemplateMeta();

    for (const [fileName, template] of Object.entries(templates)) {
      await this.#workspaceManager.ensureTextFile(fileName, template);
    }

    if (!priorMeta || priorMeta.version !== this.#templateVersion) {
      await this.#writeTemplateMeta(templates);
    }
  }

  async #readBootstrapState() {
    const raw = await this.#workspaceManager.readTextFile(this.#fileNames.bootstrapState);
    const parsed = parseJsonSafe(raw);
    if (!parsed || typeof parsed !== 'object') {
      return buildDefaultBootstrapState();
    }

    return {
      state: typeof parsed.state === 'string' ? parsed.state : BOOTSTRAP_STATES.PENDING,
      updatedAt: parsed.updatedAt ?? null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
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

  async #requiredBootstrapFilesReady() {
    for (const key of REQUIRED_BOOTSTRAP_KEYS) {
      const fileName = this.#fileNames[key];
      const content = await this.#workspaceManager.readTextFile(fileName);
      if (!normalizeText(content)) {
        return false;
      }
    }

    return true;
  }

  async #resolveBootstrapState() {
    const bootstrapText = await this.#workspaceManager.readTextFile(this.#fileNames.bootstrap);
    const bootstrapExists = normalizeText(bootstrapText).length > 0;

    const markerText = await this.#workspaceManager.readTextFile(this.#fileNames.bootstrapMarker);
    const hasCompletionMarker = parseCompletionMarker(markerText);

    if (hasCompletionMarker) {
      const ready = await this.#requiredBootstrapFilesReady();
      if (!ready) {
        return this.#writeBootstrapState(
          BOOTSTRAP_STATES.FAILED,
          'Completion marker exists but required bootstrap files are incomplete.',
        );
      }

      if (bootstrapExists) {
        await this.#workspaceManager.removePath(this.#fileNames.bootstrap);
      }

      return this.#writeBootstrapState(BOOTSTRAP_STATES.COMPLETED, 'Bootstrap completed.');
    }

    if (bootstrapExists) {
      return this.#writeBootstrapState(BOOTSTRAP_STATES.ACTIVE, 'Bootstrap in progress.');
    }

    return this.#writeBootstrapState(BOOTSTRAP_STATES.PENDING, 'Bootstrap pending marker.');
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

    await this.#resolveBootstrapState();
    this.#initialized = true;
  }

  async maybeCompleteBootstrap() {
    await this.ensureInitialized();
    const previous = await this.#readBootstrapState();
    const next = await this.#resolveBootstrapState();
    return previous.state !== BOOTSTRAP_STATES.COMPLETED
      && next.state === BOOTSTRAP_STATES.COMPLETED;
  }

  async loadPromptContext() {
    await this.ensureInitialized();
    const bootstrapState = await this.#resolveBootstrapState();

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
      bootstrap,
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
      this.#workspaceManager.readTextFile(this.#fileNames.bootstrap),
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

    if (bootstrapState.state === BOOTSTRAP_STATES.ACTIVE || bootstrapState.state === BOOTSTRAP_STATES.FAILED) {
      layers.bootstrap = [
        'Bootstrap mode active.',
        `Write ${this.#fileNames.bootstrapMarker} with JSON {"status":"complete"} when onboarding is done.`,
        `Then remove ${this.#fileNames.bootstrap}.`,
        normalizeText(bootstrap) ? `${this.#fileNames.bootstrap}:\n${bootstrap.trim()}` : '',
      ].filter((part) => part.length > 0).join('\n\n');
    }

    const extraRules = bootstrapState.state === BOOTSTRAP_STATES.FAILED
      ? `Bootstrap state is failed: ${bootstrapState.reason}`
      : '';

    return {
      bootstrapState,
      extraRules,
      layers,
    };
  }
}

export function createWorkspaceBootstrapManager(options) {
  return new WorkspaceBootstrapManager(options);
}

export const WORKSPACE_TEMPLATE_VERSION = TEMPLATE_VERSION;
export const WORKSPACE_DEFAULT_PROMPT_FILES = DEFAULT_PROMPT_FILES;
