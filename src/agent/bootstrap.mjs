const TEMPLATE_VERSION = 'ferretbot-2026-02-17-v1';

const DEFAULT_PROMPT_FILES = Object.freeze({
  agents: 'AGENTS.md',
});

function normalizeFileNames(input = {}) {
  const merged = { ...DEFAULT_PROMPT_FILES, ...input };
  return { ...merged };
}

export class WorkspaceBootstrapManager {
  #initialized;
  #fileNames;
  #workDir;
  #agentStateDir;

  constructor(options = {}) {
    const workspaceManager = options.workspaceManager;
    if (!workspaceManager) {
      throw new TypeError('WorkspaceBootstrapManager requires workspaceManager.');
    }

    this.#initialized = false;
    this.#fileNames = normalizeFileNames(options.fileNames);
    this.#workDir = typeof options.workDir === 'string' && options.workDir.trim().length > 0
      ? options.workDir
      : process.cwd();
    this.#agentStateDir = typeof options.agentStateDir === 'string' && options.agentStateDir.trim().length > 0
      ? options.agentStateDir
      : workspaceManager.baseDir;
  }

  async ensureInitialized() {
    this.#initialized = true;
  }

  async loadPromptContext() {
    if (!this.#initialized) {
      await this.ensureInitialized();
    }

    return {
      bootstrapState: null,
      extraRules: [
        `Working directory: ${this.#workDir}`,
        `Agent state directory: ${this.#agentStateDir}`,
        'Project files are in the working directory.',
        'Agent instruction/memory files are under the agent state directory (.ferretbot).',
        `At session start, read .ferretbot/${this.#fileNames.agents} and follow it.`,
        'When updating agent memory or profile files, use the .ferretbot/ path prefix.',
        'Use .ferretbot/MEMORY.md as the canonical long-term memory file.',
      ].join('\n'),
      layers: {},
    };
  }
}

export function createWorkspaceBootstrapManager(options) {
  return new WorkspaceBootstrapManager(options);
}

export const WORKSPACE_TEMPLATE_VERSION = TEMPLATE_VERSION;
export const WORKSPACE_DEFAULT_PROMPT_FILES = DEFAULT_PROMPT_FILES;
