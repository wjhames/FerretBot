import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createToolRegistry } from '../../src/tools/registry.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretbot-registry-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('registry validates and executes registered tools', async () => {
  const registry = createToolRegistry();

  registry.register({
    name: 'echo',
    description: 'Echoes text.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async ({ text }) => ({ text }),
  });

  const good = registry.validateCall({ name: 'echo', arguments: { text: 'hi' } });
  assert.equal(good.valid, true);

  const result = await registry.execute({ name: 'echo', arguments: { text: 'hi' } });
  assert.deepEqual(result, { text: 'hi' });

  const bad = registry.validateCall({ name: 'echo', arguments: { text: 1, extra: true } });
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join(' '), /type 'string'/);
  assert.match(bad.errors.join(' '), /unexpected argument 'extra'/);
});

test('registry rejects unknown tools and malformed definitions', async () => {
  const registry = createToolRegistry();

  assert.throws(
    () => registry.register({ name: 'bad' }),
    /must provide an execute function/,
  );

  const unknown = registry.validateCall({ name: 'missing', arguments: {} });
  assert.equal(unknown.valid, false);
  assert.match(unknown.errors[0], /unknown tool/);

  await assert.rejects(
    registry.execute({ name: 'missing', arguments: {} }),
    /Invalid tool call/,
  );
});

test('registry built-ins register and execute read/write tools', async () => {
  await withTempDir(async (rootDir) => {
    const registry = createToolRegistry({ rootDir, cwd: rootDir, maxReadBytes: 16 });
    await registry.registerBuiltIns();

    const names = registry.list().map((tool) => tool.name).sort();
    assert.deepEqual(names, ['bash', 'read', 'write']);

    await registry.execute({
      name: 'write',
      arguments: { path: 'notes/a.txt', content: 'hello-world', mode: 'overwrite' },
    });

    const read = await registry.execute({
      name: 'read',
      arguments: { path: 'notes/a.txt', maxBytes: 5 },
    });

    assert.equal(read.content, 'hello');
    assert.equal(read.truncated, true);
  });
});
