import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionMemory } from '../../src/memory/session.mjs';

const FIXTURE_ROOT = path.resolve('test/memory/session-fixtures');

async function cleanFixtures() {
  await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
}

test.beforeEach(async () => {
  await cleanFixtures();
});

test.afterEach(async () => {
  await cleanFixtures();
});

test('appends and reads turns in chronological order', async () => {
  const memory = new SessionMemory({ baseDir: path.join(FIXTURE_ROOT, 'chronical') });
  await memory.appendTurn('session-a', { role: 'user', content: 'first message' });
  await memory.appendTurn('session-a', { role: 'assistant', content: 'response' });

  const entries = await memory.readTurns('session-a');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[1].role, 'assistant');
  assert.equal(entries[0].content, 'first message');
});

test('collects latest turns up to token budget and summarizes older ones', async () => {
  const memory = new SessionMemory({ baseDir: path.join(FIXTURE_ROOT, 'budget') });
  await memory.appendTurn('session-budget', { role: 'user', content: 'alpha' });
  await memory.appendTurn('session-budget', { role: 'assistant', content: 'beta response' });
  await memory.appendTurn('session-budget', { role: 'user', content: 'gamma reply' });

  const result = await memory.collectConversation('session-budget', { tokenLimit: 1 });
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].role, 'user');
  assert.match(result.summary, /alpha/);
});

test('persists generated summary text across collection calls', async () => {
  const calls = [];
  const memory = new SessionMemory({
    baseDir: path.join(FIXTURE_ROOT, 'summary-persist'),
    conversationSummarizer: async ({ priorSummary, droppedTranscript }) => {
      calls.push({ priorSummary, droppedTranscript });
      const droppedCount = droppedTranscript.split('\n').filter(Boolean).length;
      return `summary(${priorSummary ? 'with-prior' : 'new'})/${droppedCount}`;
    },
  });
  await memory.appendTurn('session-summary', { role: 'user', content: 'first issue discussed' });
  await memory.appendTurn('session-summary', { role: 'assistant', content: 'first resolution proposed' });
  await memory.appendTurn('session-summary', { role: 'user', content: 'second issue discussed' });

  const first = await memory.collectConversation('session-summary', { tokenLimit: 1 });
  assert.equal(first.summary, 'summary(new)/2');

  await memory.appendTurn('session-summary', { role: 'assistant', content: 'follow-up with details' });
  const second = await memory.collectConversation('session-summary', { tokenLimit: 1 });

  assert.equal(second.summary, 'summary(with-prior)/3');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].priorSummary, 'summary(new)/2');

  const summaryPath = path.join(FIXTURE_ROOT, 'summary-persist', 'session-summary.summary.json');
  const persisted = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.summary, 'summary(with-prior)/3');
});

test('returns full history when token limit is not set', async () => {
  const memory = new SessionMemory({ baseDir: path.join(FIXTURE_ROOT, 'nolimit') });
  await memory.appendTurn('session-full', { role: 'user', content: 'first' });
  await memory.appendTurn('session-full', { role: 'assistant', content: 'second' });
  const result = await memory.collectConversation('session-full');
  assert.equal(result.turns.length, 2);
  assert.equal(result.summary, '');
});

test('excludes tool call/result entries from collected conversation', async () => {
  const memory = new SessionMemory({ baseDir: path.join(FIXTURE_ROOT, 'filter-tools') });
  await memory.appendTurn('session-filter', { role: 'user', type: 'user_input', content: 'question' });
  await memory.appendTurn('session-filter', {
    role: 'assistant',
    type: 'tool_call',
    content: '{"name":"read","arguments":{"path":"README.md"}}',
  });
  await memory.appendTurn('session-filter', {
    role: 'system',
    type: 'tool_result',
    content: '{"success":true,"stdout":"..."}',
  });
  await memory.appendTurn('session-filter', { role: 'assistant', type: 'agent_response', content: 'answer' });

  const result = await memory.collectConversation('session-filter');

  assert.equal(result.turns.length, 2);
  assert.deepEqual(
    result.turns.map((entry) => entry.type),
    ['user_input', 'agent_response'],
  );
});

test('readTurns warns when malformed JSONL lines are present', async () => {
  const warned = [];
  const baseDir = path.join(FIXTURE_ROOT, 'malformed-lines');
  const memory = new SessionMemory({
    baseDir,
    logger: {
      warn(...args) {
        warned.push(args);
      },
    },
  });

  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(
    path.join(baseDir, 'session-bad.jsonl'),
    [
      '{"timestamp":1,"role":"user","type":"user_input","content":"hello","meta":{}}',
      '{bad-json',
      '{"timestamp":2,"role":"assistant","type":"agent_response","content":"world","meta":{}}',
      '',
    ].join('\n'),
    'utf-8',
  );

  const turns = await memory.readTurns('session-bad');

  assert.equal(turns.length, 2);
  assert.equal(warned.length, 1);
  assert.equal(warned[0][0], 'Session memory encountered malformed JSONL entries.');
  assert.equal(warned[0][1].sessionId, 'session-bad');
  assert.equal(warned[0][1].malformedCount, 1);
});
