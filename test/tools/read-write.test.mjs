import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReadTool } from '../../src/tools/read.mjs';
import { createWriteTool } from '../../src/tools/write.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-tools-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('write tool writes and appends files; read tool truncates by maxBytes', async () => {
  await withTempDir(async (rootDir) => {
    const writeTool = createWriteTool({ rootDir });
    const readTool = createReadTool({ rootDir, maxBytes: 5 });

    const firstWrite = await writeTool.execute({
      path: 'notes/todo.txt',
      content: 'hello',
      mode: 'overwrite',
    });

    assert.equal(firstWrite.path, 'notes/todo.txt');
    assert.equal(firstWrite.bytesWritten, 5);

    await writeTool.execute({
      path: 'notes/todo.txt',
      content: '-world',
      mode: 'append',
    });

    const read = await readTool.execute({ path: 'notes/todo.txt' });
    assert.equal(read.path, 'notes/todo.txt');
    assert.equal(read.content, 'hello');
    assert.equal(read.bytesRead, 5);
    assert.equal(read.truncated, true);
  });
});

test('read/write tools reject root escape and .env writes', async () => {
  await withTempDir(async (rootDir) => {
    const writeTool = createWriteTool({ rootDir });
    const readTool = createReadTool({ rootDir });

    await assert.rejects(
      writeTool.execute({ path: '../outside.txt', content: 'x' }),
      /Path escapes root directory/,
    );

    await assert.rejects(
      readTool.execute({ path: '../outside.txt' }),
      /Path escapes root directory/,
    );

    await assert.rejects(
      writeTool.execute({ path: '.env', content: 'SECRET=1' }),
      /not allowed/,
    );
  });
});

test('write tool normalizes mode for common model output variants', async () => {
  await withTempDir(async (rootDir) => {
    const writeTool = createWriteTool({ rootDir });
    const readTool = createReadTool({ rootDir });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'A',
      mode: ' overwrite ',
    });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'B',
      mode: 'APPEND',
    });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'C',
      mode: null,
    });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'D',
      mode: 'add',
    });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'E',
      mode: 'APPEND_MODE',
    });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'F',
      mode: 'w',
    });

    await writeTool.execute({
      path: 'notes/mode.txt',
      content: 'G',
      mode: 'unknown-model-value',
    });

    const read = await readTool.execute({ path: 'notes/mode.txt' });
    assert.equal(read.content, 'G');
  });
});
