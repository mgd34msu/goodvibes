/**
 * Stores and files the platform writes: snapshots and restores, schema
 * migrations, batched saves, telemetry on close, templates and the VIBE
 * projection.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { restoreStoreSnapshot, snapshotStoreFile, snapshotStoreFileAsync, StoreSnapshotScheduler } from '../platform/src/platform/state/store-snapshots.js';
import { openVersionedBunSqliteStore } from '../platform/src/platform/state/store-versioning.js';
import { selectVibeRecords, VIBE_PERSONA_TAG } from '../platform/src/platform/state/vibe-projection.js';
import type { MemoryRecord } from '../platform/src/platform/state/memory-store.js';
import { TemplateManager } from '../platform/src/platform/templates/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-store-hardening-'));
  roots.push(root);
  return root;
}

/** A real SQLite file holding one row, so a snapshot of it passes its header check. */
function sqliteFile(path: string, value: string): void {
  const db = new Database(path);
  db.run('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  db.run('DELETE FROM t');
  db.run('INSERT INTO t VALUES (?)', [value]);
  db.close();
}

describe('store snapshots', () => {
  test('a restore parks the live file it replaces; one parked copy is kept per store', () => {
    const dir = tempDir();
    const db = join(dir, 'store.sqlite');
    sqliteFile(db, 'snapshotted');
    const snapshot = snapshotStoreFile(db, 'manual')!;
    sqliteFile(db, 'second state');
    const first = restoreStoreSnapshot(db, snapshot);
    sqliteFile(db, 'third state');
    const second = restoreStoreSnapshot(db, snapshot);
    expect(second.keptCurrentAt).toBe(first.keptCurrentAt);
    const parked = new Database(second.keptCurrentAt!, { readonly: true });
    expect((parked.query('SELECT v FROM t').get() as { v: string }).v).toBe('third state');
    parked.close();
  });

  test('a stale -wal beside the live file is not replayed onto the restored snapshot', () => {
    const dir = tempDir();
    const db = join(dir, 'store.sqlite');
    sqliteFile(db, 'snapshotted');
    const snapshot = snapshotStoreFile(db, 'manual')!;
    writeFileSync(`${db}-wal`, 'stale wal bytes');
    writeFileSync(`${db}-shm`, 'stale shm bytes');
    const result = restoreStoreSnapshot(db, snapshot);
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
    // The stale sidecar is parked with the file it belonged to, not lost.
    expect(readFileSync(`${result.keptCurrentAt}-wal`, 'utf8')).toBe('stale wal bytes');
    const restored = new Database(db, { readonly: true });
    expect((restored.query('SELECT v FROM t').get() as { v: string }).v).toBe('snapshotted');
    restored.close();
  });

  test('a snapshot of something that is not a SQLite database is refused rather than kept', () => {
    const dir = tempDir();
    const db = join(dir, 'store.sqlite');
    writeFileSync(db, 'x'.repeat(64));
    expect(() => snapshotStoreFile(db, 'manual')).toThrow('not a SQLite database');
    expect(existsSync(join(dir, 'snapshots', 'store.sqlite'))).toBe(true);
    expect(statSync(join(dir, 'snapshots', 'store.sqlite')).isDirectory()).toBe(true);
  });

  test('the async snapshot used on the exit path refuses a non-SQLite copy and keeps none', async () => {
    const dir = tempDir();
    const db = join(dir, 'store.sqlite');
    writeFileSync(db, 'x'.repeat(64));
    await expect(snapshotStoreFileAsync(db, 'exit')).rejects.toThrow('not a SQLite database');
    expect(readdirSync(join(dir, 'snapshots', 'store.sqlite'))).toEqual([]);
  });

  test('starting the scheduler twice leaves one timer chain, which stop() ends', () => {
    const pending = new Set<number>();
    let nextTimer = 0;
    const scheduler = new StoreSnapshotScheduler({
      stores: [],
      setTimer: () => { const id = ++nextTimer; pending.add(id); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: (timer) => { pending.delete(timer as unknown as number); },
    });
    scheduler.start();
    scheduler.start();
    expect(pending.size).toBe(1);
    scheduler.stop();
    expect(pending.size).toBe(0);
  });
});

describe('schema versioning', () => {
  function open(db: Database, migrate: () => void): void {
    openVersionedBunSqliteStore({
      storeName: 'fixture store', dbPath: ':memory:', db, targetVersion: 2,
      migrations: [{ toVersion: 2, migrate }], closeDb: () => {},
    });
  }

  test('a migration that fails halfway leaves neither its tables nor a new version behind', () => {
    const db = new Database(':memory:');
    expect(() => open(db, () => { db.run('CREATE TABLE half_done (x)'); throw new Error('boom'); })).toThrow('boom');
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half_done'").all()).toEqual([]);
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);
  });

  test('a migration and its version stamp land together', () => {
    const db = new Database(':memory:');
    open(db, () => { db.run('CREATE TABLE done (x)'); });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'done'").all()).toHaveLength(1);
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
  });
});

describe('SQLiteStore', () => {
  test('a database file the store creates is private to its owner', async () => {
    const dir = tempDir();
    const file = join(dir, 'db.sqlite');
    const store = new SQLiteStore(file);
    await store.init((db) => db.run('CREATE TABLE IF NOT EXISTS t (v TEXT)'));
    await store.save();
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  test('a commit callback that fails after a durable write is reported on the completed result', async () => {
    const dir = tempDir();
    const store = new SQLiteStore(join(dir, 'db.sqlite'));
    await store.init((db) => db.run('CREATE TABLE IF NOT EXISTS t (v TEXT)'));
    await store.save();
    const result = await store.transactPersisted((db) => { db.run("INSERT INTO t VALUES ('x')"); return { changed: true, value: 'v' }; }, () => { throw new Error('mirror refresh failed'); });
    expect(result).toEqual({ kind: 'completed', value: 'v', fenced: true });
    // The row is committed whatever the callback did.
    expect(store.exec('SELECT v FROM t')[0]?.values).toEqual([['x']]);
  });
});

describe('TemplateManager', () => {
  test('a variable named like an inherited property is left unexpanded, not replaced by native code', () => {
    const dir = tempDir();
    const manager = new TemplateManager({ projectRoot: dir, homeDirectory: dir });
    expect(manager.expand('{{toString}} {{constructor}} {{name}}', { name: 'x' })).toBe('{{toString}} {{constructor}} x');
  });

  test('save returns the name the template is stored under', () => {
    const dir = tempDir();
    const manager = new TemplateManager({ projectRoot: dir, homeDirectory: dir });
    expect(manager.save('My Plan!', 'body')).toBe('my-plan');
    expect(manager.load('my-plan')).toBe('body');
  });
});

describe('selectVibeRecords', () => {
  const record = (id: string, patch: Partial<MemoryRecord>): MemoryRecord => ({
    id, cls: 'constraint', scope: 'project', tags: [VIBE_PERSONA_TAG], reviewState: 'fresh', createdAt: 1, summary: id,
    ...patch,
  }) as MemoryRecord;

  test('records marked stale or contradicted are not projected', () => {
    const selected = selectVibeRecords([record('keep', {}), record('stale', { reviewState: 'stale' }), record('wrong', { reviewState: 'contradicted' }), record('seen', { reviewState: 'reviewed' })]);
    expect(selected.map((entry) => entry.id)).toEqual(['keep', 'seen']);
  });

  test('widened scopes order by rank, not by a project-or-not comparison', () => {
    const selected = selectVibeRecords(
      [record('team', { scope: 'team' }), record('project', { scope: 'project' }), record('session', { scope: 'session' })],
      { scopes: ['team', 'project', 'session'] },
    );
    expect(selected.map((entry) => entry.id)).toEqual(['session', 'project', 'team']);
  });
});
