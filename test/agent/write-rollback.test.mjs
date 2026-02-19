import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTurnWriteRollback } from '../../src/agent/turn/write-rollback.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-write-rollback-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('turn rollback restores existing file content', async () => {
  await withTempDir(async (rootDir) => {
    const filePath = path.join(rootDir, 'notes.txt');
    await fs.writeFile(filePath, 'before', 'utf8');

    const rollback = createTurnWriteRollback();
    await rollback.captureFile(filePath);
    await fs.writeFile(filePath, 'after', 'utf8');

    const restored = await rollback.restore();
    const content = await fs.readFile(filePath, 'utf8');

    assert.equal(restored, 1);
    assert.equal(content, 'before');
  });
});

test('turn rollback removes newly created files', async () => {
  await withTempDir(async (rootDir) => {
    const filePath = path.join(rootDir, 'new.txt');
    const rollback = createTurnWriteRollback();

    await rollback.captureFile(filePath);
    await fs.writeFile(filePath, 'temp', 'utf8');
    await rollback.restore();

    await assert.rejects(fs.stat(filePath), /ENOENT/);
  });
});
