/**
 * The store kinds other stores are built on: a record log that loses no
 * acknowledged record, and a SQLite file whose revision moves on another
 * process's commit and whose failed migration changes nothing.
 */
import { describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { openRecordLog } from '../platform/src/platform/state/record-log.ts';
import { openSqliteFile, SqliteMigrationError } from '../platform/src/platform/state/sqlite-file.ts';
import { assertCurrent, captureRevisions, StaleError } from '../platform/src/platform/utils/revision.ts';

interface Entry { readonly id: string; readonly n: number }

describe('record log', () => {
  test('a torn last line is cut before the next append and every complete record survives', () => {
    const path = join(makeProjectTempDir('gv-record-log'), 'log.jsonl');
    const first = openRecordLog<Entry>(path, { fsync: 'each', key: entry => entry.id });
    first.append({ id: 'a', n: 1 });
    first.append({ id: 'b', n: 2 });
    first.close();
    appendFileSync(path, '{"id":"interrupted"');

    const reopened = openRecordLog<Entry>(path, { fsync: 'each', key: entry => entry.id });
    reopened.append({ id: 'a', n: 3 });
    expect([...reopened.scan()].map(entry => entry.n)).toEqual([1, 2, 3]);
    expect(reopened.get('a')).toEqual({ id: 'a', n: 3 });
    expect(reopened.get('b')).toEqual({ id: 'b', n: 2 });
    reopened.close();
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  test('compaction keeps exactly the accepted records and a reader sees the rewrite', async () => {
    const path = join(makeProjectTempDir('gv-record-log'), 'log.jsonl');
    const writer = openRecordLog<Entry>(path, { fsync: 'batch', key: entry => entry.id });
    const reader = openRecordLog<Entry>(path, { fsync: 'batch', key: entry => entry.id });
    for (let n = 0; n < 6; n++) writer.append({ id: `k${n % 3}`, n });
    await writer.flush();
    expect(reader.refresh()).toBe(6);
    const before = reader.revision();

    await writer.compact(entry => entry.n >= 3);
    expect([...writer.scan()].map(entry => entry.n)).toEqual([3, 4, 5]);
    expect(reader.refresh()).toBe(3);
    expect(reader.revision()).toBeGreaterThan(before);
    expect(reader.get('k0')).toEqual({ id: 'k0', n: 3 });
    writer.close();
    reader.close();
  });
});

describe('sqlite file', () => {
  const v1 = [{ toVersion: 1, up: (db: Database) => db.run('CREATE TABLE rows (id TEXT PRIMARY KEY)') }];

  test('a commit by another connection moves the revision and stales a captured token', () => {
    const path = join(makeProjectTempDir('gv-sqlite-file'), 'rows.db');
    const mine = openSqliteFile(path, { migrations: v1 });
    const theirs = openSqliteFile(path, { migrations: v1 });
    const token = captureRevisions([mine]);
    expect(() => assertCurrent(token)).not.toThrow();
    theirs.tx(() => theirs.db.run("INSERT INTO rows VALUES ('x')"));
    expect(() => assertCurrent(token)).toThrow(StaleError);
    mine.close();
    theirs.close();
  });

  test('a failed migration leaves the file at its old version with its rows', () => {
    const path = join(makeProjectTempDir('gv-sqlite-file'), 'rows.db');
    const file = openSqliteFile(path, { migrations: v1 });
    file.db.run("INSERT INTO rows VALUES ('kept')");
    file.close();
    const failing = [...v1, { toVersion: 2, up: (db: Database) => { db.run('ALTER TABLE rows ADD COLUMN extra TEXT'); throw new Error('step failed'); } }];
    expect(() => openSqliteFile(path, { migrations: failing })).toThrow(SqliteMigrationError);

    const again = openSqliteFile(path, { migrations: v1 });
    expect(again.openedAtVersion).toBe(1);
    expect(again.db.query('SELECT id FROM rows').all()).toEqual([{ id: 'kept' }]);
    expect(again.db.query<{ name: string }, []>('PRAGMA table_info(rows)').all().map(column => column.name)).toEqual(['id']);
    again.close();
  });
});
