/** Regression source intentionally unrun during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.js';
import { writeFileAtomic } from '../sdk/src/platform/state/durable-file-io.js';
const stores: HandlerSqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0).reverse()) store.close(); });
function store(root: string) { const value = new HandlerSqliteStore({ workingDirectory: root, fileName: 'private.sqlite', schema: ['CREATE TABLE IF NOT EXISTS notes (value TEXT NOT NULL)'] }); stores.push(value); return value; }

test('ordinary and staged SQLite images are 0600 inside an owner-only operator directory', async () => {
  const root = makeProjectTempDir('handler-sqlite-mode'), database = store(root); await database.init();
  database.run('INSERT INTO notes (value) VALUES (?)', ['Private fixture value']); await database.save();
  expect(statSync(database.dbPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, '.goodvibes', 'tui', 'operator')).mode & 0o777).toBe(0o700);
  await database.persistTransaction(transaction => { transaction.run('INSERT INTO notes (value) VALUES (?)', ['Another private fixture']); }, () => {});
  expect(statSync(database.dbPath).mode & 0o777).toBe(0o600); expect(database.all('SELECT value FROM notes')).toHaveLength(2);
});

test('opening a genuine older image tightens its descriptor permissions without changing rows', async () => {
  const root = makeProjectTempDir('handler-sqlite-old-mode'), old = store(root); await old.init(); old.run('INSERT INTO notes (value) VALUES (?)', ['Keep this row']); await old.save(); old.close();
  chmodSync(old.dbPath, 0o644); const reopened = store(root); await reopened.init();
  expect(statSync(old.dbPath).mode & 0o777).toBe(0o600); expect(reopened.get('SELECT value FROM notes')).toEqual({ value: 'Keep this row' });
});

test.each(['symlink', 'hardlink'] as const)('a %s is refused without quarantining or rewriting its target', async kind => {
  const root = makeProjectTempDir('handler-sqlite-alias'), old = store(root); await old.init(); old.run('INSERT INTO notes (value) VALUES (?)', ['Keep original']); await old.save(); old.close();
  const retained = `${old.dbPath}.retained`; renameSync(old.dbPath, retained);
  if (kind === 'symlink') symlinkSync(retained, old.dbPath); else linkSync(retained, old.dbPath);
  const before = readFileSync(retained); await expect(store(root).init()).rejects.toThrow('unavailable'); expect(readFileSync(retained)).toEqual(before);
});

test('an aliased managed ancestor cannot create an operator directory outside the workspace', async () => {
  const root = makeProjectTempDir('handler-sqlite-managed-alias'), outside = makeProjectTempDir('handler-sqlite-outside');
  symlinkSync(outside, join(root, '.goodvibes')); await expect(store(root).init()).rejects.toThrow('unavailable');
  expect(existsSync(join(outside, 'tui'))).toBe(false);
});

test('closing during asynchronous initialization cannot publish a late live database', async () => {
  const database = store(makeProjectTempDir('handler-sqlite-init-close')); const initializing = database.init(); database.close();
  await expect(initializing).rejects.toThrow('closed'); expect(() => database.get('SELECT 1')).toThrow('not initialized');
  await expect(database.init()).rejects.toThrow('closed');
});

test('the additive atomic binary path preserves exact detached bytes and existing string behavior', () => {
  const root = makeProjectTempDir('atomic-binary-bytes'), path = join(root, 'image.sqlite');
  const original = Buffer.from([0, 255, 128, 1, 0, 10]); const expected = Buffer.from(original);
  writeFileAtomic(path, original, { durable: true, mode: 0o600, assertCurrent() { original.fill(17); } });
  expect(readFileSync(path)).toEqual(expected); expect(statSync(path).mode & 0o777).toBe(0o600);
  writeFileAtomic(path, 'String behavior: é\\n'); expect(readFileSync(path, 'utf8')).toBe('String behavior: é\\n');
});


test('a preexisting staging collision is neither overwritten nor deleted', async () => {
  const database = store(makeProjectTempDir('handler-sqlite-staging-collision')); await database.init();
  database.run('INSERT INTO notes (value) VALUES (?)', ['Pending private row']);
  const time = 1_700_000_000_123;
  const next = (HandlerSqliteStore as unknown as { saveSequence: number }).saveSequence + 1;
  const path = `${database.dbPath}.${process.pid}.${time}.${next}.tmp`;
  writeFileSync(path, 'Foreign original staging evidence', { mode: 0o600 });
  const clock = spyOn(Date, 'now').mockReturnValue(time);
  try { await expect(database.save()).rejects.toThrow(); }
  finally { clock.mockRestore(); }
  expect(readFileSync(path, 'utf8')).toBe('Foreign original staging evidence');
  expect(existsSync(database.dbPath)).toBe(false);
});

test('restrictive umask cannot remove owner access from either private SQLite publication path', async () => {
  const database = store(makeProjectTempDir('handler-sqlite-umask')); await database.init();
  database.run('INSERT INTO notes (value) VALUES (?)', ['Private row']);
  const previous = process.umask(0o777);
  try {
    await database.save(); expect(statSync(database.dbPath).mode & 0o777).toBe(0o600);
    await database.persistTransaction(transaction => { transaction.run('INSERT INTO notes (value) VALUES (?)', ['Private transaction']); }, () => {});
    expect(statSync(database.dbPath).mode & 0o777).toBe(0o600);
  } finally { process.umask(previous); }
});


test('a missing workspace below an existing alias is refused before creating outside directories', async () => {
  const root = makeProjectTempDir('handler-sqlite-missing-workspace-alias'), outside = makeProjectTempDir('handler-sqlite-workspace-outside');
  symlinkSync(outside, join(root, 'alias'));
  await expect(store(join(root, 'alias', 'new-workspace')).init()).rejects.toThrow('unavailable');
  expect(existsSync(join(outside, 'new-workspace'))).toBe(false);
});

test('an existing explicitly selected workspace alias stays bound to its original physical root', async () => {
  const root = makeProjectTempDir('handler-sqlite-explicit-alias'), target = makeProjectTempDir('handler-sqlite-original-target'), other = makeProjectTempDir('handler-sqlite-other-target');
  const alias = join(root, 'selected'); symlinkSync(target, alias);
  const database = store(alias); await database.init(); database.run('INSERT INTO notes (value) VALUES (?)', ['Original physical workspace']); await database.save();
  const originalPath = join(target, '.goodvibes', 'tui', 'operator', 'private.sqlite'), before = readFileSync(originalPath);
  unlinkSync(alias); symlinkSync(other, alias);
  database.run('INSERT INTO notes (value) VALUES (?)', ['Must not move to replacement']);
  await expect(database.save()).rejects.toThrow('unavailable');
  expect(readFileSync(originalPath)).toEqual(before); expect(existsSync(join(other, '.goodvibes'))).toBe(false);
});

test('new workspace and managed ancestors publish exact private permissions despite restrictive umask', async () => {
  const parent = makeProjectTempDir('handler-sqlite-new-workspace-mode'), root = join(parent, 'missing', 'workspace');
  const database = store(root), previous = process.umask(0o777);
  try {
    await database.init(); database.run('INSERT INTO notes (value) VALUES (?)', ['Private workspace']); await database.save();
    for (const path of [join(parent, 'missing'), root, join(root, '.goodvibes'), join(root, '.goodvibes', 'tui'), join(root, '.goodvibes', 'tui', 'operator')]) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    expect(statSync(database.dbPath).mode & 0o777).toBe(0o600);
  } finally { process.umask(previous); }
});
