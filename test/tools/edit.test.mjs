import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEditTool } from '../../src/tools/edit.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-edit-tool-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('edit tool replace_text updates target segment without full rewrite intent', async () => {
  await withTempDir(async (rootDir) => {
    const target = path.join(rootDir, 'notes', 'daily.txt');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'hello world\nline two\n', 'utf8');

    const editTool = createEditTool({ rootDir });
    const result = await editTool.execute({
      path: 'notes/daily.txt',
      operation: 'replace_text',
      search: 'world',
      replace: 'notes',
    });

    const updated = await fs.readFile(target, 'utf8');
    assert.equal(result.changed, true);
    assert.equal(updated, 'hello notes\nline two\n');
  });
});

test('edit tool insert_after injects text after marker', async () => {
  await withTempDir(async (rootDir) => {
    const target = path.join(rootDir, 'notes', 'plan.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '# Plan\n- one\n', 'utf8');

    const editTool = createEditTool({ rootDir });
    await editTool.execute({
      path: 'notes/plan.md',
      operation: 'insert_after',
      marker: '# Plan\n',
      text: '- zero\n',
    });

    const updated = await fs.readFile(target, 'utf8');
    assert.equal(updated, '# Plan\n- zero\n- one\n');
  });
});

test('edit tool delete_range removes selected line span', async () => {
  await withTempDir(async (rootDir) => {
    const target = path.join(rootDir, 'notes', 'log.txt');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'a\nb\nc\nd\n', 'utf8');

    const editTool = createEditTool({ rootDir });
    await editTool.execute({
      path: 'notes/log.txt',
      operation: 'delete_range',
      startLine: 2,
      endLine: 3,
    });

    const updated = await fs.readFile(target, 'utf8');
    assert.equal(updated, 'a\nd\n');
  });
});

test('edit tool rejects .env edits and root escapes', async () => {
  await withTempDir(async (rootDir) => {
    const editTool = createEditTool({ rootDir });

    await assert.rejects(
      editTool.execute({
        path: '.env',
        operation: 'replace_text',
        search: 'x',
        replace: 'y',
      }),
      /not allowed/,
    );

    await assert.rejects(
      editTool.execute({
        path: '../outside.txt',
        operation: 'replace_text',
        search: 'x',
        replace: 'y',
      }),
      /escapes root directory/,
    );
  });
});
