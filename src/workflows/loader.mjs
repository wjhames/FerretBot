import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorkflow } from './schema.mjs';

export async function loadWorkflow(workflowDir) {
  const filePath = path.join(workflowDir, 'workflow.yaml');

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`workflow.yaml not found in ${workflowDir}`);
    }
    throw err;
  }

  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`invalid YAML in ${filePath}: ${err.message}`);
  }

  const result = validateWorkflow(parsed);
  if (!result.valid) {
    throw new Error(
      `invalid workflow in ${filePath}: ${result.errors.join('; ')}`,
    );
  }

  return { ...result.workflow, dir: workflowDir };
}

export async function discoverWorkflows(baseDir) {
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(baseDir, entry.name, 'workflow.yaml');
    try {
      await fs.access(candidate);
      dirs.push(path.join(baseDir, entry.name));
    } catch {
      // no workflow.yaml in this directory
    }
  }

  return dirs;
}
