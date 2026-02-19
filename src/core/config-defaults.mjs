import { resolveRuntimePaths } from './paths.mjs';

const runtimePaths = resolveRuntimePaths();

export const DEFAULT_AGENT_DIR = runtimePaths.agentDir;
export const DEFAULT_AGENT_CONFIG_PATH = runtimePaths.configPath;
export const DEFAULT_AGENT_SOCKET_PATH = runtimePaths.socketPath;

export const DEFAULT_LMSTUDIO_BASE_URL = 'http://192.168.1.7:1234/v1';
export const DEFAULT_LMSTUDIO_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_LMSTUDIO_TIMEOUT_MS = 600_000;
