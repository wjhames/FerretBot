import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveSafePath } from './read.mjs';

export class WriteTool {
  #rootDir;

  constructor(options = {}) {
    this.#rootDir = options.rootDir ?? process.cwd();
  }

  async execute(input = {}) {
    const { path: targetPath, content = '', mode = 'overwrite' } = input;
    const resolvedPath = resolveSafePath(this.#rootDir, targetPath);

    const normalizedPath = targetPath.trim();
    if (normalizedPath === '.env' || normalizedPath.startsWith('.env.')) {
      throw new Error('Writing .env files is not allowed.');
    }

    if (mode !== 'overwrite' && mode !== 'append') {
      throw new TypeError("mode must be either 'overwrite' or 'append'.");
    }

    if (typeof content !== 'string') {
      throw new TypeError('content must be a string.');
    }

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

    if (mode === 'append') {
      await fs.appendFile(resolvedPath, content, 'utf8');
    } else {
      await fs.writeFile(resolvedPath, content, 'utf8');
    }

    const stats = await fs.stat(resolvedPath);

    return {
      path: path.relative(this.#rootDir, resolvedPath) || path.basename(resolvedPath),
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      size: stats.size,
      mode,
    };
  }
}

export function createWriteTool(options) {
  return new WriteTool(options);
}
