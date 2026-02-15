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

test('returns full history when token limit is not set', async () => {
  const memory = new SessionMemory({ baseDir: path.join(FIXTURE_ROOT, 'nolimit') });
  await memory.appendTurn('session-full', { role: 'user', content: 'first' });
  await memory.appendTurn('session-full', { role: 'assistant', content: 'second' });
  const result = await memory.collectConversation('session-full');
  assert.equal(result.turns.length, 2);
  assert.equal(result.summary, '');
});
