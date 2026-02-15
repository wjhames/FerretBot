import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { IpcNdjsonClient, INITIAL_TUI_STATE, reduceTuiState, TuiClient } from '../../src/clients/tui.mjs';

class FakeSocket extends EventEmitter {
  writes = [];

  write(value) {
    this.writes.push(String(value));
  }

  end() {
    this.emit('close');
  }

  destroy() {
    this.emit('close');
  }
}

test('reduceTuiState updates bounded transcript and connection status', () => {
  let state = { ...INITIAL_TUI_STATE };
  state = reduceTuiState(state, { type: 'connection:set', value: 'connected' });
  state = reduceTuiState(state, { type: 'status:set', value: 'Connected' });

  for (let i = 0; i < 305; i += 1) {
    state = reduceTuiState(state, {
      type: 'message:append',
      value: { role: 'assistant', text: `m${i}`, timestamp: i },
    });
  }

  assert.equal(state.connection, 'connected');
  assert.equal(state.statusLine, 'Connected');
  assert.equal(state.messages.length, 300);
  assert.equal(state.messages[0].text, 'm5');
});

test('ipc client parses hello/message lines and writes user input', () => {
  const statuses = [];
  const messages = [];
  const fakeSocket = new FakeSocket();

  const client = new IpcNdjsonClient({
    port: 1234,
    connectImpl: (_opts, onConnect) => {
      queueMicrotask(() => onConnect());
      return fakeSocket;
    },
    onStatus: (status) => statuses.push(status),
    onMessage: (message) => messages.push(message),
  });

  client.connect();

  fakeSocket.emit('data', Buffer.from('{"type":"system:hello","clientId":"client-1"}\n', 'utf8'));
  fakeSocket.emit('data', Buffer.from('{"type":"agent:response","content":{"text":"hello"}}\n', 'utf8'));

  client.sendUserInput('run diagnostics');

  assert.equal(client.getClientId(), 'client-1');
  assert.ok(statuses.some((status) => status.type === 'hello' && status.clientId === 'client-1'));
  assert.ok(messages.some((message) => message.type === 'agent:response'));

  const written = fakeSocket.writes.join('');
  assert.match(written, /"type":"user:input"/);
  assert.match(written, /"clientId":"client-1"/);
  assert.match(written, /run diagnostics/);
});

test('tui client appends inbound messages and sends user input through ipc', async () => {
  const sent = [];
  let rendererProps;

  const rendererFactory = async () => ({
    mount(props) {
      rendererProps = props;
    },
    update(props) {
      rendererProps = props;
    },
    unmount() {},
  });

  let onMessage;
  let onStatus;
  const fakeIpc = {
    connectCalled: false,
    disconnectCalled: false,
    connect() {
      this.connectCalled = true;
      onStatus({ type: 'connecting' });
      onStatus({ type: 'connected' });
      onStatus({ type: 'hello', clientId: 'client-9' });
    },
    disconnect() {
      this.disconnectCalled = true;
    },
    sendUserInput(text) {
      sent.push(text);
    },
  };

  const client = new TuiClient({
    rendererFactory,
    ipcFactory: ({ onMessage: messageHandler, onStatus: statusHandler }) => {
      onMessage = messageHandler;
      onStatus = statusHandler;
      return fakeIpc;
    },
  });

  await client.start();
  assert.equal(fakeIpc.connectCalled, true);

  rendererProps.onInputChange('hello agent');
  rendererProps.onSubmit('hello agent');

  onMessage({ type: 'agent:response', content: { text: 'hello human' } });
  onMessage({ type: 'workflow:run:queued', content: { runId: 1, workflowId: 'demo' } });

  const state = client.getState();
  assert.equal(state.clientId, 'client-9');
  assert.equal(state.messages[0].role, 'user');
  assert.equal(state.messages[0].text, 'hello agent');
  assert.equal(state.messages[1].role, 'assistant');
  assert.equal(state.messages[1].text, 'hello human');
  assert.equal(state.messages.length, 2);
  assert.equal(sent[0], 'hello agent');

  client.stop();
  assert.equal(fakeIpc.disconnectCalled, true);
});
