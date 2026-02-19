import { loadWorkflow, discoverWorkflows } from './loader.mjs';

function parseSemver(version) {
  if (typeof version !== 'string') {
    return null;
  }

  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i);
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(left, right) {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index];
    const r = rightParts[index];

    if (l == null) {
      return -1;
    }
    if (r == null) {
      return 1;
    }

    const lNumeric = /^\d+$/.test(l) ? Number.parseInt(l, 10) : null;
    const rNumeric = /^\d+$/.test(r) ? Number.parseInt(r, 10) : null;

    if (lNumeric != null && rNumeric != null) {
      if (lNumeric !== rNumeric) {
        return lNumeric > rNumeric ? 1 : -1;
      }
      continue;
    }
    if (lNumeric != null && rNumeric == null) {
      return -1;
    }
    if (lNumeric == null && rNumeric != null) {
      return 1;
    }

    const stringCompare = l.localeCompare(r);
    if (stringCompare !== 0) {
      return stringCompare > 0 ? 1 : -1;
    }
  }

  return 0;
}

function compareVersions(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);

  if (!parsedLeft || !parsedRight) {
    const lexical = String(left ?? '').localeCompare(String(right ?? ''));
    if (lexical === 0) {
      return 0;
    }
    return lexical > 0 ? 1 : -1;
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major > parsedRight.major ? 1 : -1;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor > parsedRight.minor ? 1 : -1;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch > parsedRight.patch ? 1 : -1;
  }

  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export class WorkflowRegistry {
  #workflows = new Map();
  #baseDir;

  constructor(options = {}) {
    this.#baseDir = options.baseDir ?? null;
  }

  register(workflow) {
    if (!workflow || !workflow.id || !workflow.version) {
      throw new TypeError('workflow must have id and version.');
    }

    const versions = this.#workflows.get(workflow.id);
    if (versions && versions.has(workflow.version)) {
      throw new Error(
        `workflow '${workflow.id}' version '${workflow.version}' is already registered.`,
      );
    }

    if (!versions) {
      this.#workflows.set(workflow.id, new Map());
    }

    this.#workflows.get(workflow.id).set(workflow.version, workflow);
  }

  get(id, version) {
    const versions = this.#workflows.get(id);
    if (!versions) return null;

    if (version) return versions.get(version) ?? null;

    let latest = null;
    for (const wf of versions.values()) {
      if (!latest) {
        latest = wf;
        continue;
      }

      if (compareVersions(wf.version, latest.version) > 0) {
        latest = wf;
      }
    }
    return latest;
  }

  has(id) {
    return this.#workflows.has(id);
  }

  list() {
    const result = [];
    for (const versions of this.#workflows.values()) {
      for (const wf of versions.values()) {
        result.push({
          id: wf.id,
          version: wf.version,
          name: wf.name,
          description: wf.description,
        });
      }
    }
    return result;
  }

  async loadAll() {
    if (!this.#baseDir) return;

    const dirs = await discoverWorkflows(this.#baseDir);
    for (const dir of dirs) {
      const workflow = await loadWorkflow(dir);
      this.register(workflow);
    }
  }
}

export function createWorkflowRegistry(options) {
  return new WorkflowRegistry(options);
}
