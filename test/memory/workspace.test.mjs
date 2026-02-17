import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceManager } from '../../src/memory/workspace.mjs';

const FIXTURE_ROOT = path.resolve('test/memory/workspace-fixtures');

async function cleanFixtures() {
  await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
}

test.beforeEach(cleanFixtures);
test.afterEach(cleanFixtures);

test('creates workspace directory and resolves nested paths safely', async () => {
  const manager = new WorkspaceManager({ baseDir: path.join(FIXTURE_ROOT, 'safe') });
  const base = await manager.ensureWorkspace();
  const stats = await fs.stat(base);
  assert.ok(stats.isDirectory());

  const resolved = manager.resolve('notes', 'todo.txt');
  assert.ok(resolved.startsWith(base));

  assert.throws(() => manager.resolve('..', 'escape.txt'), /workspace root/);
});

test('lists contents added after creation', async () => {
  const manager = new WorkspaceManager({ baseDir: path.join(FIXTURE_ROOT, 'listing') });
  await manager.ensureWorkspace();

  const filePath = manager.resolve('readme.md');
  await fs.writeFile(filePath, 'workspace content', 'utf-8');
  const dirPath = manager.resolve('temp');
  await fs.mkdir(dirPath, { recursive: true });

  const contents = await manager.listContents();
  assert.ok(contents.some((entry) => entry.name === 'readme.md' && entry.isFile));
  assert.ok(contents.some((entry) => entry.name === 'temp' && entry.isDirectory));
});

test('cleans entries older than threshold', async () => {
  const manager = new WorkspaceManager({ baseDir: path.join(FIXTURE_ROOT, 'cleanup') });
  await manager.ensureWorkspace();

  const staleFile = manager.resolve('stale.txt');
  await fs.writeFile(staleFile, 'old entry', 'utf-8');
  const now = Date.now();
  const oldSeconds = (now - 3_600_000) / 1000;
  await fs.utimes(staleFile, oldSeconds, oldSeconds);

  await manager.cleanup({ thresholdMs: 1_000 });
  const exists = await fs.stat(staleFile)
    .then(() => true)
    .catch((err) => (err && err.code === 'ENOENT' ? false : Promise.reject(err)));
  assert.ok(!exists);
});

test('defaults workspace baseDir to current working directory', async () => {
  const manager = new WorkspaceManager();
  assert.equal(manager.baseDir, path.resolve(process.cwd()));
});
