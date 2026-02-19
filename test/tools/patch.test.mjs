import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { createPatchTool } from '../../src/tools/patch.mjs';

const execFile = promisify(execFileCallback);

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-patch-tool-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function initGitRepo(rootDir) {
  await execFile('git', ['init'], { cwd: rootDir });
  await execFile('git', ['config', 'user.email', 'patch-test@example.com'], { cwd: rootDir });
  await execFile('git', ['config', 'user.name', 'Patch Test'], { cwd: rootDir });
}

test('patch tool applies unified diff hunks to existing file', async () => {
  await withTempDir(async (rootDir) => {
    await initGitRepo(rootDir);

    const filePath = path.join(rootDir, 'notes', 'todo.txt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'line one\nline two\n', 'utf8');

    const patchTool = createPatchTool({ rootDir, cwd: rootDir });
    const patch = [
      'diff --git a/notes/todo.txt b/notes/todo.txt',
      'index 1111111..2222222 100644',
      '--- a/notes/todo.txt',
      '+++ b/notes/todo.txt',
      '@@ -1,2 +1,2 @@',
      ' line one',
      '-line two',
      '+line two patched',
      '',
    ].join('\n');

    const result = await patchTool.execute({ patch });
    const content = await fs.readFile(filePath, 'utf8');

    assert.equal(result.applied, true);
    assert.equal(result.hunks, 1);
    assert.deepEqual(result.files, ['notes/todo.txt']);
    assert.equal(content, 'line one\nline two patched\n');
  });
});

test('patch tool rejects patch paths that escape allowed roots', async () => {
  await withTempDir(async (rootDir) => {
    await initGitRepo(rootDir);
    const patchTool = createPatchTool({ rootDir, cwd: rootDir });

    const patch = [
      'diff --git a/../outside.txt b/../outside.txt',
      '--- a/../outside.txt',
      '+++ b/../outside.txt',
      '@@ -0,0 +1 @@',
      '+escape',
      '',
    ].join('\n');

    await assert.rejects(
      patchTool.execute({ patch }),
      /escapes root directory/,
    );
  });
});
