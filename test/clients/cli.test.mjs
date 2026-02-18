import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCliArgs, runCli } from '../../src/clients/cli.mjs';

function createCaptureStream() {
  return {
    buffer: '',
    write(chunk) {
      this.buffer += String(chunk);
    },
  };
}

test('parseCliArgs parses workflow run args and version', () => {
  const parsed = parseCliArgs([
    'workflow',
    'run',
    'demo-flow',
    '--version',
    '2.1.0',
    '--arg',
    'ticket=123',
    '--arg',
    'owner=alex',
  ]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.command.kind, 'workflow:run');
  assert.equal(parsed.command.workflowId, 'demo-flow');
  assert.equal(parsed.command.version, '2.1.0');
  assert.deepEqual(parsed.command.args, { ticket: '123', owner: 'alex' });
});

test('runCli sends workflow list command and exits on workflow command result', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const sent = [];
  let disconnected = false;

  const code = await runCli({
    argv: ['workflow', 'list'],
    stdout,
    stderr,
    clientFactory: ({ onMessage, onStatus }) => ({
      connect() {
        queueMicrotask(() => {
          onStatus({ type: 'hello', clientId: 'client-5' });
        });
      },
      disconnect() {
        disconnected = true;
      },
      send(payload) {
        sent.push(payload);
        queueMicrotask(() => {
          onMessage({
            type: 'agent:status',
            clientId: 'client-5',
            content: {
              kind: 'workflow_command_result',
              command: 'workflow:run:list',
              requestId: payload.content.requestId,
              ok: true,
              message: 'listed 0 workflows and 0 runs.',
              data: {
                workflows: [],
                runs: [],
              },
            },
          });
        });
      },
      getClientId() {
        return 'client-5';
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(disconnected, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'workflow:run:list');
  assert.equal(sent[0].clientId, 'client-5');
  assert.equal(typeof sent[0].content.requestId, 'string');
  assert.match(stdout.buffer, /workflow_command_result/);
  assert.equal(stderr.buffer, '');
});
