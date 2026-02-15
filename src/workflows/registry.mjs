import { loadWorkflow, discoverWorkflows } from './loader.mjs';

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
      latest = wf;
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
