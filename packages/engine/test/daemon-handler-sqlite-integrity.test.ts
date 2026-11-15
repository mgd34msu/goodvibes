/**
 * Daemon handler store: a second writer on the same file is detected, an
 * unreadable database that was replaced by an empty one is reported through the
 * store, and staging files left by a dead process are removed at open.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { HandlerSqliteStore } from '../platform/src/platform/state/daemon-handler-sqlite-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const SCHEMA = ['CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value TEXT)'];
let directory: string;
const stores: HandlerSqliteStore[] = [];
beforeEach(() => { directory = makeProjectTempDir('gv-handler-sqlite-integrity'); });
afterEach(() => { for (const store of stores.splice(0)) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function makeStore(): HandlerSqliteStore {
  const store = new HandlerSqliteStore({ workingDirectory: directory, fileName: 'probe.sqlite', schema: SCHEMA });
  stores.push(store);
  return store;
}

test('a store that overwrites another writer\'s file reports it', async () => {
  const first = makeStore(); await first.init();
  const second = makeStore(); await second.init();
  first.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['a', '1']);
  await first.save();
  second.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['b', '2']);
  await second.save();
  expect(first.foreignWriterDetected()).toBe(false);
  expect(second.foreignWriterDetected()).toBe(true);
});

test('a single writer is never reported as having a competitor', async () => {
  const store = makeStore(); await store.init();
  store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['a', '1']);
  await store.save();
  store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['b', '2']);
  await store.save();
  expect(store.foreignWriterDetected()).toBe(false);
});

test('an unreadable database is reported by the store after it starts a fresh one', async () => {
  const store = makeStore();
  fs.mkdirSync(dirname(store.dbPath), { recursive: true });
  fs.writeFileSync(store.dbPath, 'not a database at all, just text');
  await store.init();
  expect(store.recoveryNotice()).toContain('a fresh one was started');
  const healthy = makeStore();
  expect(healthy.recoveryNotice()).toBeUndefined();
});

test('staging files from a process that no longer exists are removed at open, this process\'s are kept', async () => {
  const store = makeStore();
  fs.mkdirSync(dirname(store.dbPath), { recursive: true });
  const deadPid = Bun.spawnSync(['true']).pid;
  const stale = `${store.dbPath}.${deadPid}.1700000000000.1.tmp`;
  const own = `${store.dbPath}.${process.pid}.1700000000000.2.tmp`;
  fs.writeFileSync(stale, '');
  fs.writeFileSync(own, '');
  await store.init();
  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(own)).toBe(true);
});

const lockFile = () => join(directory, '.goodvibes', 'tui', 'probe.sqlite.writer-lock');
const holdLockAsAnotherProcess = () => {
  fs.mkdirSync(dirname(lockFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, token: '0123456789abcdef', acquiredAt: Date.now() }));
};

test('a second process refuses to open a store another process holds, and opens once it lets go', async () => {
  holdLockAsAnotherProcess();
  const blocked = new HandlerSqliteStore({ workingDirectory: directory, fileName: 'probe.sqlite', schema: SCHEMA, writerLockWaitMs: 50 });
  stores.push(blocked);
  await expect(blocked.init()).rejects.toThrow('open in another process');
  fs.rmSync(lockFile());
  const retry = makeStore();
  await retry.init();
  retry.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['a', '1']);
  await retry.save();
  expect(retry.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['a'])?.value).toBe('1');
});

test('instances in one process share the writer lock, and closing the last one releases it', async () => {
  const first = makeStore(); await first.init();
  const second = makeStore(); await second.init();
  first.close();
  expect(fs.existsSync(lockFile())).toBe(true);
  second.close();
  await Bun.sleep(0);
  expect(fs.existsSync(lockFile())).toBe(false);
});
