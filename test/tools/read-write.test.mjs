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

    await assert.rejects(
      writeTool.execute({ path: '\\.ferretbot/.tmp/workflow-artifacts/repo/git-status.txt', content: '' }),
      /cannot start with a backslash/,
    );

    await assert.rejects(
      readTool.execute({ path: '\\.ferretbot/.tmp/workflow-artifacts/repo/git-status.txt' }),
      /cannot start with a backslash/,
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

test('read/write tools support multiple allowed roots', async () => {
  await withTempDir(async (baseDir) => {
    const repoRoot = path.join(baseDir, 'repo');
    const workspaceRoot = path.join(baseDir, 'workspace');
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });

    const writeTool = createWriteTool({ rootDirs: [repoRoot, workspaceRoot] });
    const readTool = createReadTool({ rootDirs: [repoRoot, workspaceRoot] });

    const writeRelative = await writeTool.execute({
      path: 'notes/from-repo.txt',
      content: 'repo-write',
      mode: 'overwrite',
    });
    assert.equal(writeRelative.path, 'notes/from-repo.txt');

    const workspaceFile = path.join(workspaceRoot, 'notes', 'from-workspace.txt');
    await writeTool.execute({
      path: workspaceFile,
      content: 'workspace-write',
      mode: 'overwrite',
    });

    const readWorkspaceRelative = await readTool.execute({ path: 'notes/from-workspace.txt' });
    assert.equal(readWorkspaceRelative.content, 'workspace-write');

    const readRepoRelative = await readTool.execute({ path: 'notes/from-repo.txt' });
    assert.equal(readRepoRelative.content, 'repo-write');
  });
});

test('write tool calls rollback capture hook before writes', async () => {
  await withTempDir(async (rootDir) => {
    const writeTool = createWriteTool({ rootDir });
    const filePath = path.join(rootDir, 'notes', 'log.txt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'start', 'utf8');

    const captured = [];
    const rollback = {
      async captureFile(targetPath) {
        captured.push(targetPath);
      },
    };

    await writeTool.execute(
      { path: 'notes/log.txt', content: '-one', mode: 'append' },
      { writeRollback: rollback },
    );

    await writeTool.execute(
      { path: 'notes/log.txt', content: '-two', mode: 'append' },
      { writeRollback: rollback },
    );

    assert.equal(captured.length, 2);
    assert.equal(captured[0], filePath);
    assert.equal(captured[1], filePath);
  });
});

test('write tool rejects overwrite of existing code file without rewriteReason', async () => {
  await withTempDir(async (rootDir) => {
    const writeTool = createWriteTool({ rootDir });
    const targetPath = path.join(rootDir, 'src', 'app.mjs');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, 'export const a = 1;\n', 'utf8');

    await assert.rejects(
      writeTool.execute({ path: 'src/app.mjs', content: 'export const a = 2;\n', mode: 'overwrite' }),
      /requires rewriteReason/,
    );

    await writeTool.execute({
      path: 'src/app.mjs',
      content: 'export const a = 2;\n',
      mode: 'overwrite',
      rewriteReason: 'intentional full-file rewrite',
    });

    const readTool = createReadTool({ rootDir });
    const read = await readTool.execute({ path: 'src/app.mjs' });
    assert.match(read.content, /a = 2/);
  });
});
