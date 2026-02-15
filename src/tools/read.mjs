import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 16 * 1024;

function normalizeRootDirs(options = {}) {
  const roots = [];
  const { rootDirs, rootDir } = options;

  if (Array.isArray(rootDirs)) {
    for (const candidate of rootDirs) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        roots.push(path.resolve(candidate));
      }
    }
  }

  if (typeof rootDir === 'string' && rootDir.trim().length > 0) {
    roots.push(path.resolve(rootDir));
  }

  if (roots.length === 0) {
    roots.push(path.resolve(process.cwd()));
  }

  return [...new Set(roots)];
}

function isUnderRoot(resolvedRoot, resolvedPath) {
  return (
    resolvedPath === resolvedRoot
    || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

async function resolveSafePath(rootDirOrDirs, targetPath, options = {}) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new TypeError('path must be a non-empty string.');
  }

  const rootDirs = Array.isArray(rootDirOrDirs)
    ? normalizeRootDirs({ rootDirs: rootDirOrDirs })
    : normalizeRootDirs({ rootDir: rootDirOrDirs });
  const normalizedPath = targetPath.trim();
  const preferExisting = options.preferExisting !== false;
  const targetIsAbsolute = path.isAbsolute(normalizedPath);

  if (targetIsAbsolute) {
    const absolutePath = path.resolve(normalizedPath);
    const matchedRoot = rootDirs.find((rootDir) => isUnderRoot(rootDir, absolutePath));
    if (!matchedRoot) {
      throw new Error('Path escapes root directory.');
    }
    return { resolvedPath: absolutePath, resolvedRoot: matchedRoot };
  }

  const candidates = rootDirs.map((rootDir) => ({
    resolvedRoot: rootDir,
    resolvedPath: path.resolve(rootDir, normalizedPath),
  }));

  for (const candidate of candidates) {
    if (!isUnderRoot(candidate.resolvedRoot, candidate.resolvedPath)) {
      continue;
    }

    if (!preferExisting) {
      return candidate;
    }

    try {
      await fs.access(candidate.resolvedPath);
      return candidate;
    } catch {
      // Try next root.
    }
  }

  const fallback = candidates.find((candidate) =>
    isUnderRoot(candidate.resolvedRoot, candidate.resolvedPath));

  if (!fallback) {
    throw new Error('Path escapes root directory.');
  }

  return fallback;
}

export class ReadTool {
  #rootDirs;
  #maxBytes;

  constructor(options = {}) {
    this.#rootDirs = normalizeRootDirs(options);
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async execute(input = {}) {
    const { path: targetPath, maxBytes = this.#maxBytes } = input;
    const { resolvedPath, resolvedRoot } = await resolveSafePath(this.#rootDirs, targetPath, {
      preferExisting: true,
    });

    const fileBuffer = await fs.readFile(resolvedPath);
    const truncated = fileBuffer.byteLength > maxBytes;
    const usedBuffer = truncated ? fileBuffer.subarray(0, maxBytes) : fileBuffer;

    return {
      path: path.relative(resolvedRoot, resolvedPath) || path.basename(resolvedPath),
      content: usedBuffer.toString('utf8'),
      bytesRead: usedBuffer.byteLength,
      truncated,
    };
  }
}

export function createReadTool(options) {
  return new ReadTool(options);
}

export { DEFAULT_MAX_BYTES, resolveSafePath, normalizeRootDirs };
