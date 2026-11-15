import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { HandlerSqliteStore } from '../platform/src/platform/state/daemon-handler-sqlite-store.ts';
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

test('a file that is not a database is kept aside, a fresh store starts, and the store says so', async () => {
  const dir = makeProjectTempDir('handler-store-damaged');
  const operator = join(dir, '.goodvibes', 'tui', 'operator');
  mkdirSync(operator, { recursive: true });
  writeFileSync(join(operator, 'routes.sqlite'), 'not a database at all');
  const fresh = await store(dir);
  expect(fresh.all('SELECT id FROM routes')).toEqual([]);
  expect(fresh.recoveryNotice()).toContain('routes.sqlite.unreadable-1');
  expect(existsSync(join(operator, 'routes.sqlite.unreadable-1'))).toBe(true);
  expect(readFileSync(join(operator, 'routes.sqlite.unreadable-1'), 'utf8')).toBe('not a database at all');
});
