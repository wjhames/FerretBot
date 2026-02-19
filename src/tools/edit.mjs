import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeRootDirs, resolveSafePath } from './read.mjs';

function ensureString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
}

function ensureNonEmptyString(value, label) {
  ensureString(value, label);
  if (value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function validateSafeTargetPath(targetPath) {
  const normalizedPath = targetPath.trim();
  if (normalizedPath === '.env' || normalizedPath.startsWith('.env.')) {
    throw new Error('Editing .env files is not allowed.');
  }
}

function replaceText(content, input) {
  const { search, replace = '', all = false } = input;
  ensureNonEmptyString(search, 'search');
  ensureString(replace, 'replace');

  if (!content.includes(search)) {
    throw new Error('replace_text failed: search text not found.');
  }

  if (all) {
    return content.split(search).join(replace);
  }

  return content.replace(search, replace);
}

function replaceRegex(content, input) {
  const { pattern, flags = '', replace = '' } = input;
  ensureNonEmptyString(pattern, 'pattern');
  ensureString(flags, 'flags');
  ensureString(replace, 'replace');

  const regex = new RegExp(pattern, flags);
  if (!regex.test(content)) {
    throw new Error('replace_regex failed: pattern did not match.');
  }

  return content.replace(regex, replace);
}

function findMarkerIndex(content, marker, occurrence = 'first') {
  ensureNonEmptyString(marker, 'marker');
  if (occurrence === 'last') {
    return content.lastIndexOf(marker);
  }

  return content.indexOf(marker);
}

function insertBefore(content, input) {
  const { marker, text, occurrence = 'first' } = input;
  ensureNonEmptyString(text, 'text');
  const index = findMarkerIndex(content, marker, occurrence);
  if (index < 0) {
    throw new Error('insert_before failed: marker not found.');
  }

  return `${content.slice(0, index)}${text}${content.slice(index)}`;
}

function insertAfter(content, input) {
  const { marker, text, occurrence = 'first' } = input;
  ensureNonEmptyString(text, 'text');
  const index = findMarkerIndex(content, marker, occurrence);
  if (index < 0) {
    throw new Error('insert_after failed: marker not found.');
  }
  const endIndex = index + marker.length;
  return `${content.slice(0, endIndex)}${text}${content.slice(endIndex)}`;
}

function deleteRange(content, input) {
  const { startLine, endLine } = input;
  if (!Number.isInteger(startLine) || startLine <= 0) {
    throw new TypeError('startLine must be a positive integer.');
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new TypeError('endLine must be an integer >= startLine.');
  }

  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }

  if (startLine > lines.length) {
    throw new Error('delete_range failed: startLine is beyond file length.');
  }

  const boundedEnd = Math.min(endLine, lines.length);
  lines.splice(startLine - 1, boundedEnd - startLine + 1);
  const rebuilt = lines.join('\n');
  return hasTrailingNewline ? `${rebuilt}\n` : rebuilt;
}

function applyEdit(content, input) {
  const operation = String(input.operation ?? '').trim().toLowerCase();
  if (!operation) {
    throw new TypeError('operation must be provided.');
  }

  if (operation === 'replace_text') {
    return replaceText(content, input);
  }

  if (operation === 'replace_regex') {
    return replaceRegex(content, input);
  }

  if (operation === 'insert_before') {
    return insertBefore(content, input);
  }

  if (operation === 'insert_after') {
    return insertAfter(content, input);
  }

  if (operation === 'delete_range') {
    return deleteRange(content, input);
  }

  throw new Error(`Unsupported edit operation '${operation}'.`);
}

export class EditTool {
  #rootDirs;

  constructor(options = {}) {
    this.#rootDirs = normalizeRootDirs(options);
  }

  async execute(input = {}, context = {}) {
    const { path: targetPath } = input;
    ensureNonEmptyString(targetPath, 'path');
    validateSafeTargetPath(targetPath);

    const { resolvedPath, resolvedRoot } = await resolveSafePath(this.#rootDirs, targetPath, {
      preferExisting: true,
    });

    const rollback = context?.writeRollback;
    if (rollback && typeof rollback.captureFile === 'function') {
      await rollback.captureFile(resolvedPath);
    }

    const before = await fs.readFile(resolvedPath, 'utf8');
    const after = applyEdit(before, input);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, after, 'utf8');

    return {
      path: path.relative(resolvedRoot, resolvedPath) || path.basename(resolvedPath),
      operation: String(input.operation),
      changed: before !== after,
      bytesWritten: Buffer.byteLength(after, 'utf8'),
      size: Buffer.byteLength(after, 'utf8'),
    };
  }
}

export function createEditTool(options) {
  return new EditTool(options);
}
