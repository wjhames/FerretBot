import { promises as fs } from 'node:fs';

export class TurnWriteRollback {
  #snapshots;

  constructor() {
    this.#snapshots = new Map();
  }

  hasChanges() {
    return this.#snapshots.size > 0;
  }

  clear() {
    this.#snapshots.clear();
  }

  async captureFile(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string.');
    }

    if (this.#snapshots.has(filePath)) {
      return;
    }

    try {
      const content = await fs.readFile(filePath);
      this.#snapshots.set(filePath, { existed: true, content });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#snapshots.set(filePath, { existed: false, content: null });
        return;
      }

      throw error;
    }
  }

  async restore() {
    const entries = [...this.#snapshots.entries()].reverse();
    let restoredCount = 0;

    for (const [filePath, snapshot] of entries) {
      if (snapshot.existed) {
        await fs.writeFile(filePath, snapshot.content);
      } else {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      restoredCount += 1;
    }

    this.#snapshots.clear();
    return restoredCount;
  }
}

export function createTurnWriteRollback() {
  return new TurnWriteRollback();
}
