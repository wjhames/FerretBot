import path from 'node:path';

const DEFAULT_AGENT_DIR_NAME = '.ferretbot';

function normalizeNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolveRuntimePaths(options = {}) {
  const workDir = path.resolve(normalizeNonEmpty(options.workDir) ?? process.cwd());
  const agentDir = path.resolve(normalizeNonEmpty(options.agentDir) ?? path.join(workDir, DEFAULT_AGENT_DIR_NAME));

  return {
    workDir,
    agentDir,
    configPath: path.join(agentDir, 'config.json'),
    socketPath: path.join(agentDir, 'agent.sock'),
  };
}
