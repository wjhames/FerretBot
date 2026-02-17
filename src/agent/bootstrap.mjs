const TEMPLATE_VERSION = 'ferretbot-2026-02-17-v1';

const DEFAULT_PROMPT_FILES = Object.freeze({
  agents: 'AGENTS.md',
  boot: 'BOOT.md',
  identity: 'IDENTITY.md',
  soul: 'SOUL.md',
  user: 'USER.md',
  memory: 'MEMORY.md',
  systemMemory: 'MEMORY.system.md',
  memoryDir: 'memory',
});

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

function normalizeFileNames(input = {}) {
  const merged = { ...DEFAULT_PROMPT_FILES, ...input };
  return { ...merged };
}

export class WorkspaceBootstrapManager {
  #workspaceManager;
  #now;
  #initialized;
  #fileNames;

  constructor(options = {}) {
    const workspaceManager = options.workspaceManager;
    if (!workspaceManager) {
      throw new TypeError('WorkspaceBootstrapManager requires workspaceManager.');
    }

    this.#workspaceManager = workspaceManager;
    this.#now = typeof options.now === 'function' ? options.now : () => new Date();
    this.#initialized = false;
    this.#fileNames = normalizeFileNames(options.fileNames);
  }

  async ensureInitialized() {
    this.#initialized = true;
  }

  async loadPromptContext() {
    if (!this.#initialized) {
      await this.ensureInitialized();
    }

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
      bootstrapState: null,
      extraRules: '',
      layers,
    };
  }
}

export function createWorkspaceBootstrapManager(options) {
  return new WorkspaceBootstrapManager(options);
}

export const WORKSPACE_TEMPLATE_VERSION = TEMPLATE_VERSION;
export const WORKSPACE_DEFAULT_PROMPT_FILES = DEFAULT_PROMPT_FILES;
