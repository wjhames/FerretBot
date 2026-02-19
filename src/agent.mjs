import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent as UndiciAgent, setGlobalDispatcher } from 'undici';

import { createAgentLifecycle } from './core/lifecycle.mjs';

const UNDICI_HEADERS_TIMEOUT_MS = 30 * 60 * 1000;
const UNDICI_CONNECT_TIMEOUT_MS = 60 * 1000;

setGlobalDispatcher(new UndiciAgent({
  headersTimeout: UNDICI_HEADERS_TIMEOUT_MS,
  connectTimeout: UNDICI_CONNECT_TIMEOUT_MS,
}));

function isMainModule() {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }

  const entryUrl = pathToFileURL(path.resolve(entryArg)).href;
  return import.meta.url === entryUrl;
}

export async function startAgent(options = {}) {
  const {
    createLifecycle = createAgentLifecycle,
    lifecycleOptions,
  } = options;

  if (typeof createLifecycle !== 'function') {
    throw new TypeError('createLifecycle must be a function.');
  }

  const lifecycle = createLifecycle(lifecycleOptions);
  if (!lifecycle || typeof lifecycle.start !== 'function') {
    throw new TypeError('Lifecycle must expose a start() method.');
  }

  await lifecycle.start();
  return lifecycle;
}

export async function runAgent(options = {}) {
  const {
    logger = console,
  } = options;

  try {
    const lifecycle = await startAgent(options);
    logger.info?.('FerretBot agent started.');
    return lifecycle;
  } catch (error) {
    logger.error?.('FerretBot agent failed to start.', error);
    throw error;
  }
}

if (isMainModule()) {
  runAgent().catch(() => {
    process.exitCode = 1;
  });
}
