import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCrashRecord, buildCrashRecord, CRASH_LOG_FILENAME } from '../platform/src/platform/runtime/crash-capture.ts';
import { registerProfileRedactionValues } from '../platform/src/platform/utils/redaction.ts';

const dirs: string[] = [];
const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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
