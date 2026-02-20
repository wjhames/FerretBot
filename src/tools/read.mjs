import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 16 * 1024;
const PATH_ESCAPE_ERROR = 'path-escape: Path escapes root directory.';
const NOT_FOUND_ERROR = 'not-found: File not found.';

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
  if (/^\\+/.test(normalizedPath)) {
    throw new Error('Path cannot start with a backslash.');
  }
  const preferExisting = options.preferExisting !== false;
  const targetIsAbsolute = path.isAbsolute(normalizedPath);

  if (targetIsAbsolute) {
    const absolutePath = path.resolve(normalizedPath);
    const matchedRoot = rootDirs.find((rootDir) => isUnderRoot(rootDir, absolutePath));
    if (!matchedRoot) {
      throw new Error(PATH_ESCAPE_ERROR);
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
    throw new Error(PATH_ESCAPE_ERROR);
  }

  return fallback;
}

export class ReadTool {
  #rootDirs;
  #maxBytes;

  constructor(options = {}) {
    this.#rootDirs = normalizeRootDirs(options);
    this.#maxBytes = options.maxBytes;
  }

  async execute(input = {}) {
    const { path: targetPath, maxBytes = this.#maxBytes } = input;
    const { resolvedPath, resolvedRoot } = await resolveSafePath(this.#rootDirs, targetPath, {
      preferExisting: true,
    });

    let fileBuffer;
    try {
      fileBuffer = await fs.readFile(resolvedPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`${NOT_FOUND_ERROR} ${resolvedPath}`);
      }
      throw error;
    }
    const effectiveMaxBytes = Number.isFinite(maxBytes) ? maxBytes : Number.POSITIVE_INFINITY;
    const truncated = fileBuffer.byteLength > effectiveMaxBytes;
    const usedBuffer = truncated ? fileBuffer.subarray(0, effectiveMaxBytes) : fileBuffer;

    return {
      path: path.relative(resolvedRoot, resolvedPath) || path.basename(resolvedPath),
      content: usedBuffer.toString('utf8'),
      bytes: usedBuffer.byteLength,
      bytesRead: usedBuffer.byteLength,
      truncated,
    };
  }
}

export function createReadTool(options) {
  return new ReadTool(options);
}

export { DEFAULT_MAX_BYTES, resolveSafePath, normalizeRootDirs };
