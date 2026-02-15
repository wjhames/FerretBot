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

function toDisplayText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }

  return JSON.stringify(value ?? '');
}

export const INITIAL_TUI_STATE = Object.freeze({
  connection: 'disconnected',
  clientId: null,
  input: '',
  messages: [],
  statusLine: 'Not connected.',
});

export function reduceTuiState(state, action) {
  switch (action.type) {
    case 'connection:set':
      return {
        ...state,
        connection: action.value,
      };
    case 'clientId:set':
      return {
        ...state,
        clientId: action.value,
      };
    case 'status:set':
      return {
        ...state,
        statusLine: action.value,
      };
    case 'input:set':
      return {
        ...state,
        input: action.value,
      };
    case 'input:clear':
      return {
        ...state,
        input: '',
      };
    case 'message:append': {
      const next = [...state.messages, action.value];
      return {
        ...state,
        messages: next.slice(-300),
      };
    }
    default:
      return state;
  }
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

    this.#socket = null;
    this.#buffer = '';
    this.#clientId = null;
    this.#onMessage = options.onMessage ?? (() => {});
    this.#onStatus = options.onStatus ?? (() => {});
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

  sendUserInput(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed.length === 0) {
      return;
    }

    this.send({
      type: 'user:input',
      content: trimmed,
      clientId: this.#clientId,
    });
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

async function createInkRenderer() {
  const [{ default: React }, ink, { default: TextInput }] = await Promise.all([
    import('react'),
    import('ink'),
    import('ink-text-input'),
  ]);

  const { render, Box, Text, Static, useApp, useInput } = ink;
  const h = React.createElement;

  function App({ state, onInputChange, onSubmit, onExit }) {
    const { exit } = useApp();

    useInput((input, key) => {
      if (key.ctrl && input === 'c') {
        onExit?.();
        exit();
      }
    });

    const transcript = state.messages.map((message, index) =>
      h(Text, { key: `${index}-${message.role}-${message.timestamp}` }, `[${message.role}] ${message.text}`),
    );

    const clientLabel = state.clientId ? ` (${state.clientId})` : '';

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, `FerretBot TUI${clientLabel}`),
      h(Text, { color: state.connection === 'connected' ? 'green' : 'yellow' }, `Status: ${state.statusLine}`),
      h(Box, { marginTop: 1 }, h(Text, { color: 'cyan' }, 'Transcript:')),
      h(Box, { flexDirection: 'column' }, h(Static, { items: transcript }, (item) => item)),
      h(Box, { marginTop: 1 }, h(Text, null, '> '), h(TextInput, { value: state.input, onChange: onInputChange, onSubmit })),
    );
  }

  let mounted = null;

  return {
    mount(props) {
      mounted = render(h(App, props));
    },
    update(props) {
      if (!mounted) {
        throw new Error('Renderer must be mounted before update.');
      }
      mounted.rerender(h(App, props));
    },
    unmount() {
      mounted?.unmount();
      mounted = null;
    },
  };
}

export class TuiClient {
  #rendererFactory;
  #ipcFactory;
  #ipcOptions;
  #renderer;
  #ipc;
  #state;

  constructor(options = {}) {
    this.#rendererFactory = options.rendererFactory ?? createInkRenderer;
    this.#ipcFactory = options.ipcFactory ?? ((ipcOptions) => new IpcNdjsonClient(ipcOptions));
    this.#ipcOptions = {
      socketPath: options.socketPath,
      host: options.host,
      port: options.port,
    };

    this.#renderer = null;
    this.#ipc = null;
    this.#state = { ...INITIAL_TUI_STATE };
  }

  async start() {
    this.#renderer = await this.#rendererFactory();
    this.#renderer.mount(this.#createRendererProps());

    this.#ipc = this.#ipcFactory({
      ...this.#ipcOptions,
      onMessage: (message) => {
        this.#handleMessage(message);
      },
      onStatus: (status) => {
        this.#handleStatus(status);
      },
    });

    this.#ipc.connect();
  }

  stop() {
    this.#ipc?.disconnect();
    this.#ipc = null;
    this.#renderer?.unmount();
    this.#renderer = null;
  }

  getState() {
    return {
      ...this.#state,
      messages: [...this.#state.messages],
    };
  }

  #handleStatus(status) {
    switch (status.type) {
      case 'connecting':
        this.#setState({ type: 'connection:set', value: 'connecting' });
        this.#setState({ type: 'status:set', value: 'Connecting to agent...' });
        return;
      case 'connected':
        this.#setState({ type: 'connection:set', value: 'connected' });
        this.#setState({ type: 'status:set', value: 'Connected. Waiting for hello...' });
        return;
      case 'hello':
        this.#setState({ type: 'clientId:set', value: status.clientId });
        this.#setState({ type: 'status:set', value: `Connected as ${status.clientId}` });
        return;
      case 'disconnected':
        this.#setState({ type: 'connection:set', value: 'disconnected' });
        this.#setState({ type: 'status:set', value: 'Disconnected. Restart agent and reconnect.' });
        return;
      case 'error':
        this.#setState({ type: 'connection:set', value: 'disconnected' });
        this.#setState({ type: 'status:set', value: `Connection error: ${status.error?.message ?? 'unknown'}` });
        return;
      default:
        return;
    }
  }

  #handleMessage(message) {
    const eventType = message.type;

    if (eventType === 'system:hello') {
      return;
    }

    if (eventType === 'agent:response') {
      this.#appendMessage('assistant', toDisplayText(message.content));
      return;
    }

    if (eventType === 'agent:status') {
      this.#setState({ type: 'status:set', value: toDisplayText(message.content) });
      return;
    }

    if (eventType.startsWith('workflow:')) {
      if (eventType === 'workflow:needs_input') {
        return;
      }
      this.#appendMessage('system', `[${eventType}] ${toDisplayText(message.content)}`);
    }
  }

  #appendMessage(role, text) {
    this.#setState({
      type: 'message:append',
      value: {
        role,
        text,
        timestamp: Date.now(),
      },
    });
  }

  async #submitInput(raw) {
    const text = String(raw ?? '').trim();
    if (text.length === 0) {
      return;
    }

    this.#appendMessage('user', text);
    this.#setState({ type: 'input:clear' });

    try {
      this.#ipc?.sendUserInput(text);
    } catch (error) {
      this.#appendMessage('system', `Failed to send message: ${error.message}`);
    }
  }

  #createRendererProps() {
    return {
      state: this.#state,
      onInputChange: (value) => {
        this.#setState({ type: 'input:set', value });
      },
      onSubmit: (value) => {
        void this.#submitInput(value);
      },
      onExit: () => {
        this.stop();
      },
    };
  }

  #setState(action) {
    this.#state = reduceTuiState(this.#state, action);
    this.#renderer?.update(this.#createRendererProps());
  }
}

export async function runTuiClient(options = {}) {
  const client = new TuiClient(options);
  await client.start();
  return client;
}

if (isMainModule()) {
  runTuiClient().catch((error) => {
    console.error('Failed to start FerretBot TUI client.', error);
    process.exitCode = 1;
  });
}
