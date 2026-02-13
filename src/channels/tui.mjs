function toDisplayText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  return JSON.stringify(content ?? '');
}

export const INITIAL_TUI_STATE = Object.freeze({
  input: '',
  queueDepth: 0,
  status: 'idle',
  messages: [],
});

export function reduceTuiState(state, action) {
  switch (action.type) {
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
    case 'status:set':
      return {
        ...state,
        status: action.value,
      };
    case 'queue:set':
      return {
        ...state,
        queueDepth: action.value,
      };
    case 'message:append': {
      const nextMessages = [...state.messages, action.value];
      return {
        ...state,
        messages: nextMessages.slice(-200),
      };
    }
    default:
      return state;
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

  function TuiApp({ state, onInputChange, onSubmit, onExit }) {
    const { exit } = useApp();

    useInput((input, key) => {
      if (key.ctrl && input === 'c') {
        onExit?.();
        exit();
      }
    });

    const transcript = state.messages.map((message, index) =>
      h(
        Text,
        { key: `${index}-${message.role}-${message.timestamp}` },
        `[${message.role}] ${message.text}`,
      ),
    );

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, 'FerretBot TUI (Ctrl+C to exit)'),
      h(Text, { color: 'cyan' }, `Status: ${state.status} | Queue: ${state.queueDepth}`),
      h(Box, { marginTop: 1 }, h(Text, { color: 'yellow' }, 'Transcript:')),
      h(
        Box,
        { flexDirection: 'column' },
        h(Static, { items: transcript }, (item) => item),
      ),
      h(Box, { marginTop: 1 }, h(Text, null, '> '), h(TextInput, { value: state.input, onChange: onInputChange, onSubmit })),
    );
  }

  let mounted = null;

  return {
    mount(props) {
      mounted = render(h(TuiApp, props));
    },
    update(props) {
      if (!mounted) {
        throw new Error('Renderer must be mounted before update.');
      }

      mounted.rerender(h(TuiApp, props));
    },
    unmount() {
      mounted?.unmount();
      mounted = null;
    },
  };
}

export class TuiChannel {
  #bus;
  #sessionId;
  #channel;
  #state;
  #unsubscribe;
  #renderer;
  #rendererFactory;
  #started;

  constructor(options = {}) {
    const { bus, sessionId = 'default', channel = 'tui', rendererFactory = createInkRenderer } = options;

    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
      throw new TypeError('TuiChannel requires a bus with on/emit methods.');
    }

    this.#bus = bus;
    this.#sessionId = sessionId;
    this.#channel = channel;
    this.#state = { ...INITIAL_TUI_STATE };
    this.#unsubscribe = null;
    this.#renderer = null;
    this.#rendererFactory = rendererFactory;
    this.#started = false;
  }

  async start() {
    if (this.#started) {
      return;
    }

    this.#renderer = await this.#rendererFactory();
    this.#renderer.mount(this.#createRendererProps());

    this.#unsubscribe = this.#bus.on('*', async (event) => {
      this.#handleEvent(event);
      this.#setState({ type: 'queue:set', value: this.#bus.getQueueDepth() });
    });

    this.#setState({ type: 'status:set', value: 'ready' });
    this.#started = true;
  }

  stop() {
    if (!this.#started) {
      return;
    }

    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#renderer?.unmount();
    this.#renderer = null;
    this.#started = false;
  }

  getState() {
    return {
      ...this.#state,
      messages: [...this.#state.messages],
    };
  }

  async #submitInput(rawValue) {
    const text = String(rawValue ?? '').trim();
    if (text.length === 0) {
      return;
    }

    this.#setState({ type: 'input:clear' });

    await this.#bus.emit({
      type: 'user:input',
      channel: this.#channel,
      sessionId: this.#sessionId,
      content: { text },
    });
  }

  #handleEvent(event) {
    switch (event.type) {
      case 'user:input': {
        if (event.channel !== this.#channel || event.sessionId !== this.#sessionId) {
          return;
        }

        this.#setState({
          type: 'message:append',
          value: {
            role: 'user',
            text: toDisplayText(event.content),
            timestamp: event.timestamp,
          },
        });
        this.#setState({ type: 'status:set', value: 'processing' });
        return;
      }
      case 'agent:response': {
        if (event.channel !== this.#channel || event.sessionId !== this.#sessionId) {
          return;
        }

        this.#setState({
          type: 'message:append',
          value: {
            role: 'assistant',
            text: toDisplayText(event.content),
            timestamp: event.timestamp,
          },
        });
        this.#setState({ type: 'status:set', value: 'ready' });
        return;
      }
      case 'task:created':
      case 'task:step:start':
      case 'task:step:complete':
      case 'task:complete': {
        this.#setState({ type: 'status:set', value: event.type });
        return;
      }
      default:
        return;
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

export function createTuiChannel(options) {
  return new TuiChannel(options);
}
