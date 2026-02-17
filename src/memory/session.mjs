import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_AGENT_DIR } from '../core/config-defaults.mjs';

const DEFAULT_SESSION_FOLDER = path.resolve(DEFAULT_AGENT_DIR, 'sessions');
const DEFAULT_TOKEN_ESTIMATOR = Object.freeze({
  charsPerToken: 4,
  safetyMargin: 1.1,
});
const SESSION_ID_SANITIZE = /[^a-z0-9._-]/gi;
const SUMMARY_LINE_LIMIT = 4;
const SUMMARY_SNIPPET_LENGTH = 60;
const SUMMARY_MAX_LINES = 20;

function ensureSessionDir(baseDir) {
  return fs.mkdir(baseDir, { recursive: true });
}

function toSafeString(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function estimateTokens(text, config = DEFAULT_TOKEN_ESTIMATOR) {
  if (text == null || text.length === 0) {
    return 0;
  }

  const charsPerToken = config.charsPerToken ?? DEFAULT_TOKEN_ESTIMATOR.charsPerToken;
  const safetyMargin = config.safetyMargin ?? DEFAULT_TOKEN_ESTIMATOR.safetyMargin;
  const raw = text.length / charsPerToken;
  return Math.ceil(raw * safetyMargin);
}

function sanitizeSessionId(sessionId) {
  const normalized = String(sessionId ?? 'default').trim().toLowerCase();
  if (normalized.length === 0) {
    return 'default';
  }
  return normalized.replace(SESSION_ID_SANITIZE, '_');
}

function formatSummaryLine(entry) {
  const role = entry.role ?? entry.type ?? 'turn';
  const content = toSafeString(entry.content ?? entry.text).trim();
  if (content.length === 0) {
    return `${role}: [no text]`;
  }
  const snippet = content.length > SUMMARY_SNIPPET_LENGTH
    ? `${content.slice(0, SUMMARY_SNIPPET_LENGTH)}...`
    : content;
  return `${role}: ${snippet}`;
}

function summarizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  const recent = entries.slice(-SUMMARY_LINE_LIMIT);
  const lines = recent.map(formatSummaryLine);
  return `Earlier turns: ${lines.join(' | ')}`;
}

function toSummaryLine(entry) {
  const role = entry.role ?? entry.type ?? 'turn';
  const content = toSafeString(entry.content ?? entry.text).trim();
  if (content.length === 0) {
    return `${role}: [no text]`;
  }
  const snippet = content.length > SUMMARY_SNIPPET_LENGTH
    ? `${content.slice(0, SUMMARY_SNIPPET_LENGTH)}...`
    : content;
  return `${role}: ${snippet}`;
}

function mergeSummaryLines(existing = [], incoming = []) {
  const merged = [...existing, ...incoming];
  const deduped = [];
  const seen = new Set();
  for (const line of merged) {
    if (typeof line !== 'string') {
      continue;
    }
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped.slice(-SUMMARY_MAX_LINES);
}

function normalizeEntry(entry) {
  return {
    timestamp: Number.isFinite(entry?.timestamp) ? entry.timestamp : Date.now(),
    role: entry?.role ?? entry?.type ?? 'system',
    type: entry?.type ?? 'message',
    content: toSafeString(entry?.content).trim(),
    meta: entry?.meta ?? {},
  };
}

function parseJsonLines(raw) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed = [];

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Preserve forward progress when a single JSONL line is malformed.
    }
  }

  return parsed;
}

export class SessionMemory {
  #baseDir;
  #tokenEstimatorConfig;
  #dirEnsured;

  constructor(options = {}) {
    this.#baseDir = path.resolve(options.baseDir ?? DEFAULT_SESSION_FOLDER);
    this.#tokenEstimatorConfig = {
      ...DEFAULT_TOKEN_ESTIMATOR,
      ...(options.tokenEstimatorConfig ?? {}),
    };
    this.#dirEnsured = false;
  }

  async #ensureDir() {
    if (this.#dirEnsured) {
      return;
    }

    await ensureSessionDir(this.#baseDir);
    this.#dirEnsured = true;
  }

  #resolveSessionPath(sessionId) {
    const fileName = `${sanitizeSessionId(sessionId)}.jsonl`;
    return path.join(this.#baseDir, fileName);
  }

  #resolveSummaryPath(sessionId) {
    const fileName = `${sanitizeSessionId(sessionId)}.summary.json`;
    return path.join(this.#baseDir, fileName);
  }

  async #readStoredSummary(sessionId) {
    const filePath = this.#resolveSummaryPath(sessionId);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const lines = Array.isArray(parsed?.lines)
        ? parsed.lines.filter((line) => typeof line === 'string')
        : [];
      return { lines };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { lines: [] };
      }
      return { lines: [] };
    }
  }

  async #writeStoredSummary(sessionId, lines = []) {
    const filePath = this.#resolveSummaryPath(sessionId);
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      lines: lines.slice(-SUMMARY_MAX_LINES),
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  async appendTurn(sessionId, entry) {
    if (!sessionId) {
      throw new TypeError('sessionId is required.');
    }

    await this.#ensureDir();
    const normalized = normalizeEntry(entry ?? {});
    const line = `${JSON.stringify(normalized)}\n`;
    const filePath = this.#resolveSessionPath(sessionId);
    await fs.appendFile(filePath, line, 'utf-8');
    return normalized;
  }

  async readTurns(sessionId) {
    if (!sessionId) {
      throw new TypeError('sessionId is required.');
    }

    const filePath = this.#resolveSessionPath(sessionId);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const parsed = parseJsonLines(raw);
    return parsed.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  async collectConversation(sessionId, options = {}) {
    const { tokenLimit = 0 } = options;
    const turns = await this.readTurns(sessionId);
    if (turns.length === 0) {
      return { turns: [], summary: '' };
    }

    if (!tokenLimit || tokenLimit <= 0) {
      return { turns, summary: '' };
    }

    const selected = [];
    let usedTokens = 0;
    let summaryEntries = [];

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const entry = turns[index];
      const tokens = estimateTokens(entry.content, this.#tokenEstimatorConfig);

      if (selected.length > 0 && usedTokens + tokens > tokenLimit) {
        summaryEntries = turns.slice(0, index + 1);
        break;
      }

      selected.unshift(entry);
      usedTokens += tokens;

      if (usedTokens > tokenLimit && selected.length === 1) {
        summaryEntries = turns.slice(0, index);
        break;
      }
    }

    if (summaryEntries.length === 0 && selected.length < turns.length) {
      summaryEntries = turns.slice(0, turns.length - selected.length);
    }

    const storedSummary = await this.#readStoredSummary(sessionId);
    const incomingLines = summaryEntries.map(toSummaryLine);
    const mergedLines = mergeSummaryLines(storedSummary.lines, incomingLines);
    if (incomingLines.length > 0) {
      await this.#writeStoredSummary(sessionId, mergedLines);
    }

    const summary = mergedLines.length > 0
      ? `Earlier turns: ${mergedLines.slice(-SUMMARY_LINE_LIMIT).join(' | ')}`
      : summarizeEntries(summaryEntries);

    return { turns: selected, summary };
  }
}

export function createSessionMemory(options) {
  return new SessionMemory(options);
}
