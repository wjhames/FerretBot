import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../../src/core/bus.mjs';
import { createTuiChannel, reduceTuiState, INITIAL_TUI_STATE } from '../../src/channels/tui.mjs';

test('reduceTuiState updates input, status, queue depth, and bounded messages', () => {
  let state = { ...INITIAL_TUI_STATE };
  state = reduceTuiState(state, { type: 'input:set', value: 'hello' });
  state = reduceTuiState(state, { type: 'status:set', value: 'processing' });
  state = reduceTuiState(state, { type: 'queue:set', value: 3 });

  for (let i = 0; i < 205; i += 1) {
    state = reduceTuiState(state, {
      type: 'message:append',
      value: { role: 'user', text: `m${i}`, timestamp: i },
    });
  }

  assert.equal(state.input, 'hello');
  assert.equal(state.status, 'processing');
  assert.equal(state.queueDepth, 3);
  assert.equal(state.messages.length, 200);
  assert.equal(state.messages[0].text, 'm5');
  assert.equal(state.messages[199].text, 'm204');
});

test('tui channel reacts to bus events and emits user input', async () => {
  const bus = createEventBus();
  const updates = [];
  const emittedInputs = [];

  bus.on('user:input', async (event) => {
    emittedInputs.push(event.content.text);
  });

  let rendererProps;
  const rendererFactory = async () => ({
    mount(props) {
      rendererProps = props;
      updates.push(props.state);
    },
    update(props) {
      rendererProps = props;
      updates.push(props.state);
    },
    unmount() {},
  });

  const tui = createTuiChannel({ bus, sessionId: 's1', rendererFactory });
  await tui.start();

  rendererProps.onInputChange('hello agent');
  rendererProps.onSubmit('hello agent');

  await bus.emit({
    type: 'agent:response',
    channel: 'tui',
    sessionId: 's1',
    content: { text: 'hi human' },
  });

  const state = tui.getState();
  assert.deepEqual(emittedInputs, ['hello agent']);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].role, 'user');
  assert.equal(state.messages[0].text, 'hello agent');
  assert.equal(state.messages[1].role, 'assistant');
  assert.equal(state.messages[1].text, 'hi human');
  assert.equal(state.status, 'ready');
  assert.ok(updates.length >= 3);

  tui.stop();
});
