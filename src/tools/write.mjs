import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeRootDirs, resolveSafePath } from './read.mjs';

const CODE_FILE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.cpp',
  '.cc',
  '.c',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.kt',
  '.kts',
  '.scala',
  '.sh',
  '.sql',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
]);

function normalizeMode(mode) {
  if (mode == null) {
    return 'overwrite';
  }

  if (typeof mode !== 'string') {
    return 'overwrite';
  }

  const normalized = mode.trim().toLowerCase();
  if (!normalized) {
    return 'overwrite';
  }

  const lettersOnly = normalized.replace(/[^a-z]/g, '');

  if (
    normalized === 'overwrite'
    || normalized === 'write'
    || normalized === 'replace'
    || normalized === 'truncate'
    || normalized === 'w'
    || lettersOnly === 'overwrite'
    || lettersOnly === 'write'
    || lettersOnly === 'replace'
    || lettersOnly === 'truncate'
  ) {
    return 'overwrite';
  }

  if (
    normalized === 'append'
    || normalized === 'add'
    || normalized === 'a'
    || lettersOnly === 'append'
    || lettersOnly === 'add'
  ) {
    return 'append';
  }

  return 'overwrite';
}

export class WriteTool {
  #rootDirs;

  constructor(options = {}) {
    this.#rootDirs = normalizeRootDirs(options);
  }

  async execute(input = {}, context = {}) {
    const {
      path: targetPath,
      content = '',
      mode = 'overwrite',
      rewriteReason = null,
    } = input;
    const { resolvedPath, resolvedRoot } = await resolveSafePath(this.#rootDirs, targetPath, {
      preferExisting: false,
    });
    const normalizedMode = normalizeMode(mode);

    const normalizedPath = targetPath.trim();
    if (normalizedPath === '.env' || normalizedPath.startsWith('.env.')) {
      throw new Error('Writing .env files is not allowed.');
    }

    if (typeof content !== 'string') {
      throw new TypeError('content must be a string.');
    }
    const reasonProvided = typeof rewriteReason === 'string' && rewriteReason.trim().length > 0;

    let existedBefore = false;
    try {
      await fs.access(resolvedPath);
      existedBefore = true;
    } catch {
      existedBefore = false;
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    const isCodeFile = CODE_FILE_EXTENSIONS.has(extension);
    if (normalizedMode === 'overwrite' && existedBefore && isCodeFile && !reasonProvided) {
      throw new Error('Overwriting existing code files requires rewriteReason.');
    }

    const rollback = context?.writeRollback;
    if (rollback && typeof rollback.captureFile === 'function') {
      await rollback.captureFile(resolvedPath);
    }

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

    if (normalizedMode === 'append') {
      await fs.appendFile(resolvedPath, content, 'utf8');
    } else {
      await fs.writeFile(resolvedPath, content, 'utf8');
    }

    const stats = await fs.stat(resolvedPath);

    return {
      path: path.relative(resolvedRoot, resolvedPath) || path.basename(resolvedPath),
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      size: stats.size,
      mode: normalizedMode,
      existedBefore,
      isCodeFile,
      rewriteReasonProvided: reasonProvided,
    };
  }
}

export function createWriteTool(options) {
  return new WriteTool(options);
}
