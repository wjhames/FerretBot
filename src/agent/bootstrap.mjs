import fs from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE_VERSION = 'ferretbot-2026-02-17-v1';

const DEFAULT_PROMPT_FILES = Object.freeze({
  agents: 'AGENTS.md',
});
const DAILY_MEMORY_PLACEHOLDER = 'YYYY-MM-DD';
const MAX_INCLUDE_CHARS = 12_000;
const MAX_BOOTSTRAP_CHARS = 28_000;

function normalizeFileNames(input = {}) {
  const merged = { ...DEFAULT_PROMPT_FILES, ...input };
  return { ...merged };
}

export class WorkspaceBootstrapManager {
  #initialized;
  #fileNames;
  #workDir;
  #agentStateDir;
  #clock;
  #cache;

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
    this.#clock = typeof options.now === 'function' ? options.now : () => new Date();
    this.#cache = null;
  }

  async ensureInitialized() {
    this.#initialized = true;
  }

  async loadPromptContext() {
    if (!this.#initialized) {
      await this.ensureInitialized();
    }

    const dayKey = this.#toDayKey(this.#clock());
    const cacheHit = await this.#isCacheFresh(dayKey);
    if (!cacheHit) {
      this.#cache = await this.#rebuildCache(dayKey);
    }

    return {
      bootstrapState: {
        cacheHit,
        dayKey,
        dependencyCount: Array.isArray(this.#cache?.dependencies) ? this.#cache.dependencies.length : 0,
      },
      extraRules: [
        `Working directory: ${this.#workDir}`,
        `Agent state directory: ${this.#agentStateDir}`,
        'Project files are in the working directory.',
        'Agent instruction/memory files are under the agent state directory (.ferretbot).',
        'AGENTS.md policy files are loaded into bootstrap context automatically.',
        'When updating agent memory or profile files, use the .ferretbot/ path prefix.',
        'Use .ferretbot/MEMORY.md as the canonical long-term memory file.',
      ].join('\n'),
      layers: {
        bootstrap: this.#cache?.bootstrapText ?? '',
      },
    };
  }

  #toDayKey(dateValue) {
    const date = dateValue instanceof Date && !Number.isNaN(dateValue.valueOf())
      ? dateValue
      : new Date();
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  #dayOffset(dayKey, offsetDays) {
    const base = new Date(`${dayKey}T12:00:00.000Z`);
    base.setUTCDate(base.getUTCDate() + offsetDays);
    return this.#toDayKey(base);
  }

  async #isCacheFresh(currentDayKey) {
    if (!this.#cache || !Array.isArray(this.#cache.dependencies)) {
      return false;
    }
    if (this.#cache.dayKey !== currentDayKey) {
      return false;
    }

    for (const dependency of this.#cache.dependencies) {
      const currentMtimeMs = await this.#readMtimeMs(dependency.path);
      if (currentMtimeMs !== dependency.mtimeMs) {
        return false;
      }
    }

    return true;
  }

  async #rebuildCache(dayKey) {
    const dependencies = [];
    const includedDocs = [];
    const includeSeen = new Set();

    const projectAgentsPath = path.resolve(this.#workDir, this.#fileNames.agents);
    const stateAgentsPath = path.resolve(this.#agentStateDir, this.#fileNames.agents);

    const projectAgents = await this.#readTrackedFile(projectAgentsPath, dependencies);
    const stateAgents = await this.#readTrackedFile(stateAgentsPath, dependencies);

    const sources = [];
    if (projectAgents) {
      sources.push({
        label: `Project ${this.#fileNames.agents}`,
        path: projectAgentsPath,
        content: projectAgents,
      });
    }
    if (stateAgents) {
      sources.push({
        label: `.ferretbot/${this.#fileNames.agents}`,
        path: stateAgentsPath,
        content: stateAgents,
      });
    }

    for (const source of sources) {
      const includePaths = this.#extractIncludePaths(source.content, source.path, dayKey);
      for (const includePath of includePaths) {
        const includeKey = includePath.toLowerCase();
        if (includeSeen.has(includeKey)) {
          continue;
        }
        includeSeen.add(includeKey);
        const includeContent = await this.#readTrackedFile(includePath, dependencies);
        if (!includeContent) {
          continue;
        }
        includedDocs.push({
          path: includePath,
          content: includeContent.length > MAX_INCLUDE_CHARS
            ? `${includeContent.slice(0, MAX_INCLUDE_CHARS)}...`
            : includeContent,
        });
      }
    }

    const bootstrapText = this.#composeBootstrapText(sources, includedDocs);

    return {
      dayKey,
      dependencies,
      bootstrapText: bootstrapText.length > MAX_BOOTSTRAP_CHARS
        ? `${bootstrapText.slice(0, MAX_BOOTSTRAP_CHARS)}...`
        : bootstrapText,
    };
  }

  #composeBootstrapText(sources, includedDocs) {
    const parts = [];

    for (const source of sources) {
      parts.push(`${source.label} (${source.path}):\n${source.content.trim()}`);
    }

    for (const doc of includedDocs) {
      parts.push(`Included file (${doc.path}):\n${doc.content.trim()}`);
    }

    return parts.join('\n\n').trim();
  }

  #extractIncludePaths(sourceText, sourcePath, dayKey) {
    if (typeof sourceText !== 'string' || sourceText.length === 0) {
      return [];
    }

    const includeCandidates = new Set();
    const backtickPathPattern = /`([^`]*?\.md[^`]*)`/gi;
    const barePathPattern = /(^|[\s(])([./~]?[a-z0-9._/-]*\/[a-z0-9._/-]*\.md)\b/gim;

    let match;
    while ((match = backtickPathPattern.exec(sourceText)) !== null) {
      const candidate = String(match[1] ?? '').trim();
      if (candidate.length > 0) {
        includeCandidates.add(candidate);
      }
    }

    while ((match = barePathPattern.exec(sourceText)) !== null) {
      const candidate = String(match[2] ?? '').trim();
      if (candidate.length > 0) {
        includeCandidates.add(candidate);
      }
    }

    const resolved = [];
    const sourceDir = path.dirname(sourcePath);
    for (const candidate of includeCandidates) {
      for (const expanded of this.#expandDailyPattern(candidate, dayKey)) {
        const normalized = expanded.replace(/^\.?\//, '');
        if (normalized.toLowerCase() === this.#fileNames.agents.toLowerCase()) {
          continue;
        }
        const includePath = this.#resolveIncludePath(expanded, sourceDir);
        if (!includePath) {
          continue;
        }
        resolved.push(includePath);
      }
    }

    return [...new Set(resolved)];
  }

  #expandDailyPattern(candidate, dayKey) {
    if (!candidate.includes(DAILY_MEMORY_PLACEHOLDER)) {
      return [candidate];
    }

    return [
      candidate.replaceAll(DAILY_MEMORY_PLACEHOLDER, dayKey),
      candidate.replaceAll(DAILY_MEMORY_PLACEHOLDER, this.#dayOffset(dayKey, -1)),
    ];
  }

  #resolveIncludePath(candidatePath, sourceDir) {
    if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) {
      return null;
    }

    const trimmed = candidatePath.trim();
    let resolved;
    if (path.isAbsolute(trimmed)) {
      resolved = path.resolve(trimmed);
    } else if (trimmed.startsWith('.ferretbot/')) {
      resolved = path.resolve(this.#workDir, trimmed);
    } else {
      resolved = path.resolve(sourceDir, trimmed);
    }

    if (!this.#isPathInside(this.#workDir, resolved) && !this.#isPathInside(this.#agentStateDir, resolved)) {
      return null;
    }

    return resolved;
  }

  #isPathInside(baseDir, targetPath) {
    const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  async #readMtimeMs(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.mtimeMs;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async #readTrackedFile(filePath, dependencies) {
    let mtimeMs = null;
    let content = '';

    try {
      const stats = await fs.stat(filePath);
      mtimeMs = stats.mtimeMs;
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }

    dependencies.push({ path: filePath, mtimeMs });
    return content.trim();
  }
}

export function createWorkspaceBootstrapManager(options) {
  return new WorkspaceBootstrapManager(options);
}

export const WORKSPACE_TEMPLATE_VERSION = TEMPLATE_VERSION;
export const WORKSPACE_DEFAULT_PROMPT_FILES = DEFAULT_PROMPT_FILES;
