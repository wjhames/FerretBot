import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const DEFAULT_SKILLS_DIR = 'skills';
const DEFAULT_STEP_DIR = 'steps';
const DEFAULT_WORKFLOW_SKILL_FILE = 'SKILL.md';

function normalizeKey(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

function limitSkillContent(content, maxChars) {
  const normalized = content.trim();
  if (!Number.isFinite(maxChars)) {
    return normalized;
  }

  if (maxChars <= 0) {
    return '';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const allow = Math.max(0, maxChars - 3);
  if (allow === 0) {
    return '...';
  }

  return `${normalized.slice(0, allow)}...`;
}

async function safeReaddir(dir, options) {
  try {
    return await fs.readdir(dir, options);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

async function safeAccess(target) {
  try {
    await fs.access(target);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function stripFrontMatter(content, filePath) {
  const frontMatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontMatterMatch) {
    return { body: content, meta: {} };
  }

  let meta = {};
  try {
    meta = parseYaml(frontMatterMatch[1]) ?? {};
  } catch (err) {
    throw new Error(`invalid front matter in ${filePath}: ${err.message}`);
  }

  return {
    body: content.slice(frontMatterMatch[0].length),
    meta,
  };
}

function stripHeaders(body) {
  let cleaned = body;
  cleaned = cleaned.replace(/^\s*#\s*skill:[^\n]*\r?\n?/i, '');
  cleaned = cleaned.replace(/^\s*##\s*description:[^\n]*\r?\n?/i, '');
  return cleaned.trim();
}

function fallbackSkillId(filePath) {
  const fileName = path.basename(filePath);
  return fileName
    .replace(/\.skill$/i, '')
    .replace(/\.md$/i, '')
    .trim() || 'skill';
}

function buildSkillEntry({ id, description, content, filePath, scope, workflowDir, stepFileName }) {
  const fileName = path.basename(filePath);
  const baseName = fileName.replace(/\.skill$/i, '').replace(/\.md$/i, '').trim();
  const keys = new Set();

  const normalizedId = normalizeKey(id);
  if (normalizedId) {
    keys.add(normalizedId);
  }

  const normalizedFile = normalizeKey(fileName);
  if (normalizedFile) {
    keys.add(normalizedFile);
  }

  const normalizedBase = normalizeKey(baseName);
  if (normalizedBase) {
    keys.add(normalizedBase);
  }

  if (stepFileName) {
    const normalizedStep = normalizeKey(stepFileName);
    if (normalizedStep) {
      keys.add(normalizedStep);
    }
  }

  return {
    id,
    description: description ?? '',
    content,
    path: filePath,
    scope,
    workflowDir,
    stepFileName,
    matchingKeys: keys,
    uid: `${scope}:${id}:${filePath}`,
    fileName,
    baseName,
  };
}

async function readSkillFile(filePath, options) {
  if (!filePath) {
    return null;
  }

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const { body, meta } = stripFrontMatter(raw, filePath);
  const trimmedBody = body.trimStart();

  const headerMatch = trimmedBody.match(/^#\s*skill:\s*(.+)$/im);
  const descriptionMatch = trimmedBody.match(/^##\s*description:\s*(.+)$/im);

  const id = (meta.skill ?? headerMatch?.[1]?.trim() ?? fallbackSkillId(filePath)).trim();
  const description = (meta.description ?? descriptionMatch?.[1]?.trim() ?? '').trim();
  const content = stripHeaders(trimmedBody);

  return buildSkillEntry({
    id,
    description,
    content,
    filePath,
    scope: options.scope,
    workflowDir: options.workflowDir,
    stepFileName: options.stepFileName,
  });
}

function createLookupMap(entries) {
  const lookup = new Map();
  for (const entry of entries ?? []) {
    for (const key of entry.matchingKeys) {
      if (!key || lookup.has(key)) {
        continue;
      }
      lookup.set(key, entry);
    }
  }
  return lookup;
}

function resolveByPrecedence(lookups, key) {
  for (const lookup of lookups) {
    const match = lookup.get(key);
    if (match) {
      return match;
    }
  }

  return null;
}

async function loadWorkflowSkillEntries(resolvedDir, options) {
  const workflowExists = await safeAccess(resolvedDir);
  if (!workflowExists) {
    return { workflowSkills: [], stepSkills: [] };
  }

  const workflowSkills = [];

  const mainSkillPath = path.join(resolvedDir, options.workflowSkillFileName);
  const mainSkill = await readSkillFile(mainSkillPath, {
    scope: 'workflow',
    workflowDir: resolvedDir,
  });
  if (mainSkill) {
    workflowSkills.push(mainSkill);
  }

  const entries = await safeReaddir(resolvedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.toLowerCase() === options.workflowSkillFileName.toLowerCase()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.skill.md')) {
      continue;
    }

    const skillPath = path.join(resolvedDir, entry.name);
    const skill = await readSkillFile(skillPath, {
      scope: 'workflow',
      workflowDir: resolvedDir,
    });
    if (skill) {
      workflowSkills.push(skill);
    }
  }

  const stepsDir = path.join(resolvedDir, options.stepDirName);
  const stepEntries = await safeReaddir(stepsDir, { withFileTypes: true });
  const stepSkills = [];
  for (const entry of stepEntries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.skill.md')) {
      continue;
    }

    const skillPath = path.join(stepsDir, entry.name);
    const skill = await readSkillFile(skillPath, {
      scope: 'step',
      workflowDir: resolvedDir,
      stepFileName: entry.name,
    });
    if (skill) {
      stepSkills.push(skill);
    }
  }

  return { workflowSkills, stepSkills };
}

async function indexGlobalSkills(rootDir, skillsDirName) {
  const baseDir = path.join(rootDir, skillsDirName);
  const entries = await safeReaddir(baseDir, { withFileTypes: true });
  const skills = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(baseDir, entry.name);
    const primary = path.join(skillDir, 'SKILL.md');
    const hasPrimary = await safeAccess(primary);
    let skillPath = null;
    if (hasPrimary) {
      skillPath = primary;
    } else {
      const contents = await safeReaddir(skillDir, { withFileTypes: true });
      for (const file of contents) {
        if (!file.isFile()) {
          continue;
        }
        if (!file.name.toLowerCase().endsWith('.md')) {
          continue;
        }
        skillPath = path.join(skillDir, file.name);
        break;
      }
    }

    if (!skillPath) {
      continue;
    }

    const skill = await readSkillFile(skillPath, {
      scope: 'global',
    });
    if (!skill) {
      continue;
    }

    if (!skills.has(skill.id)) {
      skills.set(skill.id, skill);
    }
  }

  return skills;
}

export class SkillLoader {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    this.skillsDirName = options.skillsDirName ?? DEFAULT_SKILLS_DIR;
    this.stepDirName = options.stepDirName ?? DEFAULT_STEP_DIR;
    this.workflowSkillFileName = options.workflowSkillFileName ?? DEFAULT_WORKFLOW_SKILL_FILE;
    this._globalCache = null;
    this._workflowCache = new Map();
  }

  async getGlobalSkills() {
    if (this._globalCache) {
      return this._globalCache;
    }

    const skills = await indexGlobalSkills(this.rootDir, this.skillsDirName);
    this._globalCache = skills;
    return skills;
  }

  async getWorkflowSkills(workflowDir = '.') {
    const resolvedDir = path.resolve(this.rootDir, workflowDir);
    if (this._workflowCache.has(resolvedDir)) {
      return this._workflowCache.get(resolvedDir);
    }

    const entry = await loadWorkflowSkillEntries(resolvedDir, {
      workflowSkillFileName: this.workflowSkillFileName,
      stepDirName: this.stepDirName,
    });
    this._workflowCache.set(resolvedDir, entry);
    return entry;
  }

  async loadSkillsForStep(options = {}) {
    const {
      workflowDir = '.',
      skillNames = [],
      maxSkillContentChars = Number.POSITIVE_INFINITY,
    } = options;

    const globalSkills = await this.getGlobalSkills();
    const { workflowSkills, stepSkills } = await this.getWorkflowSkills(workflowDir);

    const stepLookup = createLookupMap(stepSkills);
    const workflowLookup = createLookupMap(workflowSkills);
    const globalLookup = createLookupMap(Array.from(globalSkills.values()));

    const resolvedEntries = [];
    const missing = [];
    const seen = new Set();

    for (const rawName of skillNames) {
      const key = normalizeKey(rawName);
      if (!key) {
        continue;
      }

      const match = resolveByPrecedence(
        [stepLookup, workflowLookup, globalLookup],
        key,
      );

      if (!match) {
        missing.push(rawName);
        continue;
      }

      if (seen.has(match.uid)) {
        continue;
      }

      seen.add(match.uid);

      const entry = {
        ...match,
        content: limitSkillContent(match.content, maxSkillContentChars),
      };
      resolvedEntries.push(entry);
    }

    const aggregated = resolvedEntries
      .map((entry) => entry.content)
      .filter((text) => text && text.length > 0)
      .join('\n\n');

    return {
      entries: resolvedEntries,
      missing,
      text: aggregated,
      requested: skillNames,
    };
  }
}

export function createSkillLoader(options) {
  return new SkillLoader(options);
}
