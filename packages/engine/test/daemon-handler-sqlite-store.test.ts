import { afterEach, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { HandlerSqliteStore } from '../platform/src/platform/state/daemon-handler-sqlite-store.ts';
import { capturePrivateSqliteDirectory } from '../platform/src/platform/state/private-sqlite-path.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const SCHEMA = ['CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, value TEXT NOT NULL)'];
const open: HandlerSqliteStore[] = [];
afterEach(() => { for (const store of open.splice(0)) store.close(); });

async function store(dir: string): Promise<HandlerSqliteStore> {
  const created = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'routes.sqlite', schema: SCHEMA });
  open.push(created);
  await created.init();
  return created;
}

test('two openers of one working directory both read and write the same rows', async () => {
  const dir = makeProjectTempDir('handler-store-shared');
  const first = await store(dir);
  const second = await store(dir);
  first.run('INSERT INTO routes VALUES (?, ?)', ['a', 'from first']);
  await second.persistTransaction(tx => { tx.run('INSERT INTO routes VALUES (?, ?)', ['b', 'from second']); }, () => {});
  expect(first.all('SELECT id FROM routes ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
  expect(second.all('SELECT id FROM routes ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
});

test('a failed transaction leaves no row behind, and committed rows survive a reopen', async () => {
  const dir = makeProjectTempDir('handler-store-rollback');
  const first = await store(dir);
  first.run('INSERT INTO routes VALUES (?, ?)', ['kept', 'x']);
  await expect(first.persistTransaction(tx => {
    tx.run('INSERT INTO routes VALUES (?, ?)', ['lost', 'y']);
    throw new Error('refused');
  }, () => {})).rejects.toThrow('refused');
  first.close();
  const reopened = await store(dir);
  expect(reopened.all('SELECT id FROM routes')).toEqual([{ id: 'kept' }]);
});

test('a plain workspace gets an owner-only store directory', () => {
  const { directory } = capturePrivateSqliteDirectory(join(makeProjectTempDir('private-sqlite'), 'repo'), { create: true, assertCurrent() {} });
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});
