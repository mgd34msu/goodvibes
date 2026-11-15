/** A decision log this build cannot read is kept aside and a new one starts, instead of failing the composition. */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionLogPath, openStateDecisionLogWithNotice, recoverUnreadableLog } from '../platform/src/platform/state/decision-log.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'decision-log-')); dirs.push(dir); return dir; };

test('a log from a newer schema is kept aside and a new log opens', () => {
  const dir = root();
  const path = decisionLogPath(dir);
  const newer = new Database(path);
  newer.exec('CREATE TABLE decisions (id TEXT); PRAGMA user_version = 99;');
  newer.close();
  const { log, notice } = openStateDecisionLogWithNotice(dir);
  expect(notice).toContain(`${path}.unrecognized-1`);
  expect(existsSync(`${path}.unrecognized-1`)).toBe(true);
  expect(log.query()).toEqual([]);
  log[Symbol.dispose]();
  const kept = new Database(`${path}.unrecognized-1`, { readonly: true });
  expect((kept.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(99);
  kept.close();
});

test('a file that is not a database is kept aside too, and a second one gets its own name', () => {
  const dir = root();
  const path = decisionLogPath(dir);
  writeFileSync(path, 'this is not a sqlite database, only some text that is long enough to be read as a header');
  const first = openStateDecisionLogWithNotice(dir);
  expect(first.notice).toContain('unrecognized-1');
  expect(readFileSync(`${path}.unrecognized-1`, 'utf8')).toContain('not a sqlite database');
  first.log[Symbol.dispose]();
  for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true });
  writeFileSync(path, 'again not a database, again long enough to fill the sqlite header read in full');
  const second = openStateDecisionLogWithNotice(dir);
  expect(second.notice).toContain('unrecognized-2');
  second.log[Symbol.dispose]();
});

test('a readable log opens with no notice and is left in place', () => {
  const dir = root();
  const first = openStateDecisionLogWithNotice(dir); first.log[Symbol.dispose]();
  const again = openStateDecisionLogWithNotice(dir);
  expect(again.notice).toBeUndefined();
  expect(existsSync(`${decisionLogPath(dir)}.unrecognized-1`)).toBe(false);
  again.log[Symbol.dispose]();
});

test('a second process whose open failed on the old file does not move the log the first one started', () => {
  const dir = root();
  const path = decisionLogPath(dir);
  writeFileSync(path, 'this is not a sqlite database, only some text that is long enough to be read as a header');
  const first = openStateDecisionLogWithNotice(dir);
  first.log.query();
  const staleError = Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
  const second = recoverUnreadableLog(path, staleError);
  expect(second.notice).toBeUndefined();
  expect(existsSync(`${path}.unrecognized-2`)).toBe(false);
  expect(existsSync(path)).toBe(true);
  second.log[Symbol.dispose]();
  first.log[Symbol.dispose]();
});
