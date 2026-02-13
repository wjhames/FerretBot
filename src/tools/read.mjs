import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 16 * 1024;

function resolveSafePath(rootDir, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new TypeError('path must be a non-empty string.');
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, targetPath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Path escapes root directory.');
  }

  return resolvedPath;
}

export class ReadTool {
  #rootDir;
  #maxBytes;

  constructor(options = {}) {
    this.#rootDir = options.rootDir ?? process.cwd();
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async execute(input = {}) {
    const { path: targetPath, maxBytes = this.#maxBytes } = input;
    const resolvedPath = resolveSafePath(this.#rootDir, targetPath);

    const fileBuffer = await fs.readFile(resolvedPath);
    const truncated = fileBuffer.byteLength > maxBytes;
    const usedBuffer = truncated ? fileBuffer.subarray(0, maxBytes) : fileBuffer;

    return {
      path: path.relative(this.#rootDir, resolvedPath) || path.basename(resolvedPath),
      content: usedBuffer.toString('utf8'),
      bytesRead: usedBuffer.byteLength,
      truncated,
    };
  }
}

export function createReadTool(options) {
  return new ReadTool(options);
}

export { DEFAULT_MAX_BYTES, resolveSafePath };
