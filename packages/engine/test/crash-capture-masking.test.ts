import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCrashRecord, buildCrashRecord, CRASH_LOG_FILENAME, CRASH_LOG_MAX_RECORDS, readCrashRecords } from '../platform/src/platform/runtime/crash-capture.ts';
import { syncFileLockPath } from '../platform/src/platform/config/sync-file-lock.ts';
import { holdProcessLock } from '../platform/src/platform/utils/process-lock.ts';
import { registerProfileRedactionValues } from '../platform/src/platform/utils/redaction.ts';

const dirs: string[] = [];
const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** True while some holder has `lock`: taking it here fails. */
function held(lock: string): boolean {
  const probe = holdProcessLock(lock);
  probe?.release();
  return probe === null;
}

const record = () => buildCrashRecord('uncaughtException', new Error('boom'), { version: '1', surface: 'agent', sessionId: null, pid: 1 });

test('a crash record that cannot be masked is not written and the handler gets false, not a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-mask-'));
  dirs.push(dir);
  const file = join(dir, CRASH_LOG_FILENAME);
  // An unreadable owner profile makes masking unavailable.
  restore.push(registerProfileRedactionValues(() => { throw new Error('profile unavailable'); }));

  expect(appendCrashRecord(file, record())).toBe(false);
  expect(() => readFileSync(file, 'utf8')).toThrow();
});

test('the log is held under the cross-process lock while a record is appended and the log trimmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-lock-'));
  dirs.push(dir);
  const file = join(dir, CRASH_LOG_FILENAME);
  const lock = syncFileLockPath(file);
  // Fill past the size guard with records large enough to force a trim.
  const big = buildCrashRecord('uncaughtException', new Error('x'.repeat(2000)), { version: '1', surface: 'agent', sessionId: null, pid: 1 });
  for (let i = 0; i < CRASH_LOG_MAX_RECORDS + 5; i++) appendFileSync(file, `${JSON.stringify(big)}\n`);

  // The trim redacts each kept record; observe the lock while that runs.
  const seen: boolean[] = [];
  restore.push(registerProfileRedactionValues(() => { seen.push(held(lock)); return { guarded: [], absolute: [] }; }));

  expect(appendCrashRecord(file, record())).toBe(true);
  // Masking the new record happens before the lock is taken; the trim's readings come last and must be under it.
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.at(-1)).toBe(true);
  expect(held(lock)).toBe(false);
  expect(readCrashRecords(file)).toHaveLength(CRASH_LOG_MAX_RECORDS);
});
