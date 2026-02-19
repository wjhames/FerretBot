import { spawn } from 'node:child_process';
import path from 'node:path';

import { normalizeRootDirs, resolveSafePath } from './read.mjs';

function stripDiffPrefix(rawPath) {
  if (typeof rawPath !== 'string') {
    return null;
  }

  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/dev/null') {
    return null;
  }

  return trimmed.replace(/^[ab]\//, '');
}

function extractPatchedPaths(patchText) {
  const lines = patchText.split('\n');
  const paths = [];

  for (const line of lines) {
    if (!line.startsWith('+++ ')) {
      continue;
    }

    const candidate = stripDiffPrefix(line.slice(4));
    if (candidate) {
      paths.push(candidate);
    }
  }

  return [...new Set(paths)];
}

function countHunks(patchText) {
  return patchText
    .split('\n')
    .filter((line) => line.startsWith('@@ '))
    .length;
}

async function runGitApply(args, patchText, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', ...args, '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        code,
        stdout,
        stderr,
      });
    });

    child.stdin.end(patchText);
  });
}

export class PatchTool {
  #rootDirs;
  #cwd;

  constructor(options = {}) {
    this.#rootDirs = normalizeRootDirs(options);
    this.#cwd = options.cwd ?? this.#rootDirs[0] ?? process.cwd();
  }

  async execute(input = {}) {
    const { patch, checkOnly = false } = input;
    if (typeof patch !== 'string' || patch.trim().length === 0) {
      throw new TypeError('patch must be a non-empty string.');
    }

    const touchedPaths = extractPatchedPaths(patch);
    if (touchedPaths.length === 0) {
      throw new Error('Patch did not include any target paths.');
    }

    for (const targetPath of touchedPaths) {
      await resolveSafePath(this.#rootDirs, targetPath, { preferExisting: false });
    }

    const check = await runGitApply(['--check', '--whitespace=nowarn'], patch, this.#cwd);
    if (!check.success) {
      const detail = (check.stderr || check.stdout || 'git apply --check failed').trim();
      throw new Error(`Patch check failed: ${detail}`);
    }

    if (checkOnly) {
      return {
        applied: false,
        checkOnly: true,
        files: touchedPaths,
        hunks: countHunks(patch),
      };
    }

    const applied = await runGitApply(['--whitespace=nowarn'], patch, this.#cwd);
    if (!applied.success) {
      const detail = (applied.stderr || applied.stdout || 'git apply failed').trim();
      throw new Error(`Patch apply failed: ${detail}`);
    }

    return {
      applied: true,
      checkOnly: false,
      files: touchedPaths,
      hunks: countHunks(patch),
      cwd: path.resolve(this.#cwd),
    };
  }
}

export function createPatchTool(options) {
  return new PatchTool(options);
}
