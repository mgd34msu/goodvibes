/**
 * A non-coordinated SQLiteStore (the memory database) must publish by replacing
 * the file, so an interrupted save can never leave a truncated database behind.
 */
import { afterEach, expect, test } from 'bun:test';
import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteStore, writeFileAtomically } from '../platform/src/platform/state/sqlite-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

test('a save replaces the file instead of rewriting it in place', async () => {
  const root = makeProjectTempDir('sqlite-atomic-save');
  const path = join(root, 'memory.sqlite');
  const store = new SQLiteStore(path);
  cleanups.push(() => store.close());
  await store.init(db => { db.run('CREATE TABLE IF NOT EXISTS t (v TEXT)'); });
  await store.save();
  // A second name for the published file stands in for a reader (or a crash)
  // that still sees the old bytes: an in-place rewrite would change them too.
  const held = join(root, 'held.sqlite');
  linkSync(path, held);
  const before = readFileSync(held);
  store.run("INSERT INTO t (v) VALUES ('x')");
  await store.save();
  expect(readFileSync(held).equals(before)).toBe(true);
  expect(readFileSync(path).equals(before)).toBe(false);
  expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('a write that cannot complete leaves no temp file behind', () => {
  const root = makeProjectTempDir('sqlite-atomic-fail');
  // The target is a non-empty directory, so the final rename cannot succeed.
  const target = join(root, 'memory.sqlite');
  mkdirSync(target);
  writeFileSync(join(target, 'keep'), 'kept');
  expect(() => writeFileAtomically(target, Buffer.from('new image'))).toThrow();
  expect(readdirSync(root)).toEqual(['memory.sqlite']);
  expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('kept');
});

test('replacing an existing file keeps its permissions', () => {
  const root = makeProjectTempDir('sqlite-atomic-mode');
  const path = join(root, 'memory.sqlite');
  writeFileSync(path, 'old', { mode: 0o600 });
  writeFileAtomically(path, Buffer.from('new'));
  expect(readFileSync(path, 'utf8')).toBe('new');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
