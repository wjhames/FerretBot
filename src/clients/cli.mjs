import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_AGENT_SOCKET_PATH } from '../core/config-defaults.mjs';

const DEFAULT_SOCKET_PATH = DEFAULT_AGENT_SOCKET_PATH;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = null;

function isMainModule() {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }

  const entryUrl = pathToFileURL(path.resolve(entryArg)).href;
  return import.meta.url === entryUrl;
}

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function printUsage(stream) {
  stream.write(
    [
      'FerretBot CLI',
      '',
      'Usage:',
      '  ferretbot-cli message <text>',
      '  ferretbot-cli -m <text>',
      '  ferretbot-cli workflow run <workflow-id> [--version <semver>] [--arg key=value]...',
      '  ferretbot-cli workflow cancel <run-id>',
      '  ferretbot-cli workflow list',
      '',
      'Options:',
      '  --socket <path>   unix socket path',
      '  --host <host>     tcp host (requires --port)',
      '  --port <port>     tcp port',
      '  --watch           keep streaming after command result',
      '',
    ].join('\n'),
  );
}

function parsePort(raw) {
  if (raw == null) {
    return null;
  }

  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function parseKeyValue(raw) {
  const text = String(raw ?? '');
  const index = text.indexOf('=');
  if (index <= 0) {
    return null;
  }

  const key = text.slice(0, index).trim();
  const value = text.slice(index + 1);
  if (key.length === 0) {
    return null;
  }

  return { key, value };
}

export function parseCliArgs(argv = []) {
  const args = [...argv];
  const global = {
    socketPath: DEFAULT_SOCKET_PATH,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    watch: false,
  };

  while (args.length > 0) {
    const token = args[0];
    if (token === '--watch') {
      global.watch = true;
      args.shift();
      continue;
    }
    if (token === '--socket') {
      if (args.length < 2) {
        return { ok: false, error: '--socket requires a value.' };
      }
      global.socketPath = String(args[1]);
      args.splice(0, 2);
      continue;
    }
    if (token === '--host') {
      if (args.length < 2) {
        return { ok: false, error: '--host requires a value.' };
      }
      global.host = String(args[1]);
      args.splice(0, 2);
      continue;
    }
    if (token === '--port') {
      if (args.length < 2) {
        return { ok: false, error: '--port requires a value.' };
      }
      const port = parsePort(args[1]);
      if (port == null) {
        return { ok: false, error: '--port must be a non-negative integer.' };
      }
      global.port = port;
      args.splice(0, 2);
      continue;
    }
    break;
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { ok: true, showHelp: true, global };
  }

  if (args[0] === '-m' || args[0] === 'message') {
    const textParts = args[0] === '-m' ? args.slice(1) : args.slice(1);
    const text = textParts.join(' ').trim();
    if (!text) {
      return { ok: false, error: 'message text is required.' };
    }
    return {
      ok: true,
      global,
      command: { kind: 'message', text },
    };
  }

  if (args[0] !== 'workflow') {
    return { ok: false, error: `unknown command '${args[0]}'.` };
  }

  const sub = args[1];
  if (sub === 'list') {
    return {
      ok: true,
      global,
      command: { kind: 'workflow:list' },
    };
  }

  if (sub === 'cancel') {
    const runId = Number.parseInt(String(args[2] ?? ''), 10);
    if (!Number.isInteger(runId) || runId <= 0) {
      return { ok: false, error: 'cancel requires a positive run-id.' };
    }
    return {
      ok: true,
      global,
      command: { kind: 'workflow:cancel', runId },
    };
  }

  if (sub === 'run') {
    const workflowId = String(args[2] ?? '').trim();
    if (!workflowId) {
      return { ok: false, error: 'workflow run requires workflow-id.' };
    }

    const parsed = {
      kind: 'workflow:run',
      workflowId,
      version: null,
      args: {},
    };

    let index = 3;
    while (index < args.length) {
      const token = args[index];
      if (token === '--version') {
        if (index + 1 >= args.length) {
          return { ok: false, error: '--version requires a value.' };
        }
        parsed.version = String(args[index + 1]).trim() || null;
        index += 2;
        continue;
      }
      if (token === '--arg') {
        if (index + 1 >= args.length) {
          return { ok: false, error: '--arg requires key=value.' };
        }
        const pair = parseKeyValue(args[index + 1]);
        if (!pair) {
          return { ok: false, error: `invalid --arg '${args[index + 1]}'. expected key=value.` };
        }
        parsed.args[pair.key] = pair.value;
        index += 2;
        continue;
      }
      return { ok: false, error: `unknown workflow run option '${token}'.` };
    }

    return {
      ok: true,
      global,
      command: parsed,
    };
  }

  return { ok: false, error: `unknown workflow command '${String(sub ?? '')}'.` };
}

function buildRequestId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `req-${stamp}-${rand}`;
}

export function buildCommandPayload(command, requestId) {
  if (command.kind === 'message') {
    return {
      type: 'user:input',
      content: {
        text: command.text,
        requestId,
      },
    };
  }

  if (command.kind === 'workflow:run') {
    const payload = {
      type: 'workflow:run:start',
      content: {
        requestId,
        workflowId: command.workflowId,
        args: command.args ?? {},
      },
    };
    if (command.version) {
      payload.content.version = command.version;
    }
    return payload;
  }

  if (command.kind === 'workflow:cancel') {
    return {
      type: 'workflow:run:cancel',
      content: { requestId, runId: command.runId },
    };
  }

  if (command.kind === 'workflow:list') {
    return {
      type: 'workflow:run:list',
      content: { requestId },
    };
  }

  throw new Error(`Unsupported command kind '${command.kind}'.`);
}

function shouldExitFromCommandResult(command, event, requestId, clientId) {
  if (command.kind === 'message') {
    return event.type === 'agent:response'
      && (event.clientId == null || event.clientId === clientId);
  }

  return event.type === 'agent:status'
    && event.content
    && event.content.kind === 'workflow_command_result'
    && event.content.requestId === requestId
    && (event.clientId == null || event.clientId === clientId);
}

function toDisplayText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }

  return '';
}

export class IpcNdjsonClient {
  #connectImpl;
  #host;
  #port;
  #socketPath;
  #socket;
  #buffer;
  #clientId;
  #onMessage;
  #onStatus;

  constructor(options = {}) {
    this.#connectImpl = options.connectImpl ?? ((connectOptions, onConnect) => net.createConnection(connectOptions, onConnect));
    this.#host = options.host ?? DEFAULT_HOST;
    this.#port = options.port ?? DEFAULT_PORT;
    this.#socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.#onMessage = options.onMessage ?? (() => {});
    this.#onStatus = options.onStatus ?? (() => {});

    this.#socket = null;
    this.#buffer = '';
    this.#clientId = null;
  }

  connect() {
    if (this.#socket) {
      return;
    }

    this.#onStatus({ type: 'connecting' });

    const connectOptions = Number.isInteger(this.#port)
      ? { host: this.#host, port: this.#port }
      : this.#socketPath;

    const socket = this.#connectImpl(connectOptions, () => {
      this.#onStatus({ type: 'connected' });
    });

    this.#socket = socket;

    socket.on('data', (chunk) => {
      this.#handleData(chunk.toString('utf8'));
    });

    socket.on('error', (error) => {
      this.#onStatus({ type: 'error', error });
    });

    socket.on('close', () => {
      this.#socket = null;
      this.#onStatus({ type: 'disconnected' });
    });
  }

  disconnect() {
    if (!this.#socket) {
      return;
    }

    this.#socket.end();
    this.#socket.destroy();
    this.#socket = null;
  }

  send(payload) {
    if (!this.#socket) {
      throw new Error('IPC client is not connected.');
    }

    this.#socket.write(`${JSON.stringify(payload)}\n`);
  }

  getClientId() {
    return this.#clientId;
  }

  #handleData(chunk) {
    this.#buffer += chunk;

    while (true) {
      const newlineIndex = this.#buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);

      if (line.trim().length === 0) {
        continue;
      }

      const parsed = safeParseJson(line);
      if (!parsed || typeof parsed.type !== 'string') {
        continue;
      }

      if (parsed.type === 'system:hello' && typeof parsed.clientId === 'string') {
        this.#clientId = parsed.clientId;
        this.#onStatus({ type: 'hello', clientId: parsed.clientId });
      }

      this.#onMessage(parsed);
    }
  }
}

export async function runCli(options = {}) {
  const {
    argv = process.argv.slice(2),
    stdout = process.stdout,
    stderr = process.stderr,
    clientFactory = (clientOptions) => new IpcNdjsonClient(clientOptions),
  } = options;

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n\n`);
    printUsage(stderr);
    return 1;
  }

  if (parsed.showHelp) {
    printUsage(stdout);
    return 0;
  }

  const requestId = buildRequestId();
  const payload = buildCommandPayload(parsed.command, requestId);

  let resolved = false;
  let resolveRun;
  const done = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const finish = (code) => {
    if (resolved) {
      return;
    }
    resolved = true;
    resolveRun(code);
  };

  const client = clientFactory({
    host: parsed.global.host,
    port: parsed.global.port,
    socketPath: parsed.global.socketPath,
    onMessage: (event) => {
      const clientId = client.getClientId();
      const isTargetedEvent = clientId && (event.clientId == null || event.clientId === clientId);

      if (
        parsed.command.kind === 'message'
        && event.type === 'agent:response'
        && isTargetedEvent
      ) {
        const text = toDisplayText(event.content).trim();
        if (text.length > 0) {
          stdout.write(`${text}\n`);
        }
      }

      if (parsed.global.watch) {
        return;
      }

      if (!clientId) {
        return;
      }

      if (shouldExitFromCommandResult(parsed.command, event, requestId, clientId)) {
        if (
          parsed.command.kind !== 'message'
          && event.type === 'agent:status'
          && event.content?.kind === 'workflow_command_result'
          && event.content?.ok === false
        ) {
          finish(1);
          return;
        }
        finish(0);
      }
    },
    onStatus: (status) => {
      if (status.type === 'error') {
        stderr.write(`Connection error: ${status.error?.message ?? 'unknown'}\n`);
        finish(1);
      }
      if (status.type === 'disconnected' && !resolved) {
        finish(1);
      }
      if (status.type === 'hello') {
        client.send({
          ...payload,
          clientId: status.clientId,
        });
      }
    },
  });

  client.connect();

  const code = await done;
  client.disconnect();
  return code;
}

if (isMainModule()) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
