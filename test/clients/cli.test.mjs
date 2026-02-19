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

test('parseCliArgs parses workflow lint and dry-run commands', () => {
  const lintParsed = parseCliArgs([
    'workflow',
    'lint',
    'demo-flow',
    '--version',
    '3.0.0',
  ]);
  assert.equal(lintParsed.ok, true);
  assert.equal(lintParsed.command.kind, 'workflow:lint');
  assert.equal(lintParsed.command.workflowId, 'demo-flow');
  assert.equal(lintParsed.command.version, '3.0.0');

  const dryRunParsed = parseCliArgs([
    'workflow',
    'dry-run',
    'demo-flow',
    '--version',
    '2.0.0',
    '--arg',
    'target=src',
  ]);
  assert.equal(dryRunParsed.ok, true);
  assert.equal(dryRunParsed.command.kind, 'workflow:dry-run');
  assert.equal(dryRunParsed.command.workflowId, 'demo-flow');
  assert.equal(dryRunParsed.command.version, '2.0.0');
  assert.deepEqual(dryRunParsed.command.args, { target: 'src' });
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
  assert.equal(stdout.buffer, '');
  assert.equal(stderr.buffer, '');
});

test('runCli message prints only assistant response text', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const sent = [];

  const code = await runCli({
    argv: ['message', 'Hello'],
    stdout,
    stderr,
    clientFactory: ({ onMessage, onStatus }) => ({
      connect() {
        queueMicrotask(() => {
          onStatus({ type: 'hello', clientId: 'client-9' });
        });
      },
      disconnect() {},
      send(payload) {
        sent.push(payload);
        queueMicrotask(() => {
          onMessage({
            type: 'agent:status',
            clientId: 'client-9',
            content: { phase: 'thinking' },
          });
          onMessage({
            type: 'agent:response',
            clientId: 'client-9',
            content: { text: 'Hi there', requestId: payload.content.requestId },
          });
        });
      },
      getClientId() {
        return 'client-9';
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'user:input');
  assert.equal(stdout.buffer, 'Hi there\n');
  assert.equal(stderr.buffer, '');
});

test('runCli message ignores non-matching requestId responses', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const code = await runCli({
    argv: ['message', 'Hello'],
    stdout,
    stderr,
    clientFactory: ({ onMessage, onStatus }) => ({
      connect() {
        queueMicrotask(() => {
          onStatus({ type: 'hello', clientId: 'client-22' });
        });
      },
      disconnect() {},
      send(payload) {
        queueMicrotask(() => {
          onMessage({
            type: 'agent:response',
            clientId: 'client-22',
            content: { text: 'stale', requestId: 'req-stale' },
          });
          onMessage({
            type: 'agent:response',
            clientId: 'client-22',
            content: { text: 'fresh', requestId: payload.content.requestId },
          });
        });
      },
      getClientId() {
        return 'client-22';
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(stdout.buffer, 'fresh\n');
  assert.equal(stderr.buffer, '');
});
