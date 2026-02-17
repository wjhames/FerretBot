import path from 'node:path';

export const DEFAULT_AGENT_DIR = path.resolve(process.cwd(), '.ferretbot');
export const DEFAULT_AGENT_CONFIG_PATH = path.join(DEFAULT_AGENT_DIR, 'config.json');
export const DEFAULT_AGENT_SOCKET_PATH = path.join(DEFAULT_AGENT_DIR, 'agent.sock');

export const DEFAULT_LMSTUDIO_BASE_URL = 'http://192.168.1.7:1234/v1';
export const DEFAULT_LMSTUDIO_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_LMSTUDIO_TIMEOUT_MS = 300_000;
