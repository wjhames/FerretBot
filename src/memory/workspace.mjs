import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_WORKSPACE_DIR = path.resolve(os.homedir(), '.agent', 'workspace');
const DEFAULT_CLEANUP_THRESHOLD = 7 * 24 * 60 * 60 * 1000;

async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export class WorkspaceManager {
  #baseDir;
  #cleanupThreshold;
  #dirEnsured = false;

  constructor(options = {}) {
    this.#baseDir = path.resolve(options.baseDir ?? DEFAULT_WORKSPACE_DIR);
    this.#cleanupThreshold = Number.isFinite(options.cleanupThreshold)
      ? Number(options.cleanupThreshold)
      : DEFAULT_CLEANUP_THRESHOLD;
  }

  async #ensureBase() {
    if (this.#dirEnsured) {
      return;
    }
    await ensureDir(this.#baseDir);
    this.#dirEnsured = true;
  }

  get baseDir() {
    return this.#baseDir;
  }

  async ensureWorkspace() {
    await this.#ensureBase();
    return this.#baseDir;
  }

  resolve(...segments) {
    const suffix = path.join(...segments.filter((segment) => typeof segment === 'string' && segment.length > 0));
    const resolved = suffix ? path.resolve(this.#baseDir, suffix) : this.#baseDir;
    if (!resolved.startsWith(this.#baseDir)) {
      throw new Error('path escapes the workspace root');
    }
    return resolved;
  }

  async listContents() {
    await this.#ensureBase();
    const entries = await fs.readdir(this.#baseDir, { withFileTypes: true });
    const stats = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(this.#baseDir, entry.name);
      const metadata = await fs.stat(entryPath);
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
    }));

    return stats;
  }

  async cleanup(options = {}) {
    await this.#ensureBase();
    const thresholdMs = Number.isFinite(options.thresholdMs)
      ? Number(options.thresholdMs)
      : this.#cleanupThreshold;
    const entries = await fs.readdir(this.#baseDir, { withFileTypes: true });
    const now = Date.now();

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(this.#baseDir, entry.name);
      const stats = await fs.stat(entryPath);
      const age = now - stats.mtimeMs;
      if (thresholdMs >= 0 && age <= thresholdMs) {
        return;
      }
      await fs.rm(entryPath, { recursive: true, force: true });
    }));
  }
}

export function createWorkspaceManager(options) {
  return new WorkspaceManager(options);
}
