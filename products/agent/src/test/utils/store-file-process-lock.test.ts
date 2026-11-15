import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runStoreFileUpdate } from '../../utils/store-file.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A second connection on the store's lock sidecar stands in for another process. */
function tryTakeLock(storePath: string): 'taken' | 'busy' {
  const other = new Database(`${storePath}.writer.sqlite`);
  try {
    other.exec('PRAGMA busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
    other.exec('ROLLBACK');
    return 'taken';
  } catch {
    return 'busy';
  } finally { other.close(); }
}

describe('runStoreFileUpdate holds the cross-process store lock', () => {
  test('another process cannot take the lock while an async update is in flight', async () => {
    const path = join(makeProjectTempDir('gv-store-file-lock'), 'store.json');
    let during: 'taken' | 'busy' | undefined;
    await runStoreFileUpdate(path, async () => {
      await Promise.resolve();
      during = tryTakeLock(path);
    });
    expect(during).toBe('busy');
  });

  test('the lock is released when the update finishes, and when it fails', async () => {
    const path = join(makeProjectTempDir('gv-store-file-lock'), 'store.json');
    await runStoreFileUpdate(path, () => undefined);
    expect(tryTakeLock(path)).toBe('taken');
    await expect(runStoreFileUpdate(path, () => { throw new Error('update failed'); })).rejects.toThrow('update failed');
    expect(tryTakeLock(path)).toBe('taken');
  });

  test('an update waits for a lock another process holds, and runs only after it is released', async () => {
    const path = join(makeProjectTempDir('gv-store-file-lock'), 'store.json');
    await runStoreFileUpdate(path, () => undefined);
    const holder = new Database(`${path}.writer.sqlite`);
    holder.exec('BEGIN IMMEDIATE');
    let released = false;
    // The first attempt runs in a microtask, while the lock is still held; this timer fires before the retry.
    setTimeout(() => { holder.exec('COMMIT'); holder.close(); released = true; }, 0);
    let ranAfterRelease: boolean | undefined;
    await runStoreFileUpdate(path, () => { ranAfterRelease = released; });
    expect(ranAfterRelease).toBe(true);
  });
});
