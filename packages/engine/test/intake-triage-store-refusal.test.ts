/**
 * A triage receipt file the store refuses must say which file and what to do.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inboxTriage } from '../platform/src/platform/intake/triage/battery.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';

const settledReceipt = {
  id: 'a', battery: inboxTriage.name, batteryVersion: inboxTriage.version, receiptVersion: 3 as const, status: 'unavailable' as const,
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'triage-refusal-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('SqliteTriageStore refusing an unreadable receipt file', () => {
  test('names the file and the way out on read and on commit, and leaves the bytes alone', async () => {
    const store = new SqliteTriageStore(root);
    mkdirSync(dirname(store.dbPath), { recursive: true });
    const bytes = Buffer.from('not SQLite, but long enough to be a file somebody edited by hand');
    writeFileSync(store.dbPath, bytes);
    await expect(store.readBatch(['a'])).rejects.toThrow(store.dbPath);
    await expect(store.readBatch(['a'])).rejects.toThrow('Move it aside');
    await expect(store.commit([settledReceipt])).rejects.toThrow('Move it aside');
    await store.close();
    expect(readFileSync(store.dbPath)).toEqual(bytes);
  });
});
