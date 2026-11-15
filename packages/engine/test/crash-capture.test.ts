import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCrashRecord,
  buildCrashRecord,
  CRASH_LOG_FILENAME,
  CRASH_LOG_PREVIOUS_FILENAME,
  CRASH_LOG_ROTATE_BYTES,
  CRASH_STACK_MAX_CHARS,
  readCrashRecords,
} from '../platform/src/platform/runtime/crash-capture.ts';
import {
  APPEND_ONLY_STORES,
  isAppendOnlyStoreRegistered,
} from '../platform/src/platform/runtime/retention/append-only-registry.ts';

// The gap this closes: an agent died on an uncaught exception and the stack
// existed ONLY on the operator's terminal, nothing in the activity log, no
// crash file, recovered afterwards only from a lucky pane capture.

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crash-capture-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CONTEXT = { version: '2.0.6', surface: 'agent', sessionId: 'user-cd11b528', pid: 4242 };

describe('crash record', () => {
  test('carries the five fields forensics needed and did not have', () => {
    const error = new Error('hosted turn exploded');
    const record = buildCrashRecord('uncaughtException', error, {
      ...CONTEXT,
      now: () => new Date('2026-08-05T22:26:00.000Z'),
    });

    expect(record.kind).toBe('uncaughtException');
    expect(record.message).toBe('hosted turn exploded');
    expect(record.stack).toContain('hosted turn exploded');
    expect(record.version).toBe('2.0.6');
    expect(record.pid).toBe(4242);
    expect(record.sessionId).toBe('user-cd11b528');
    expect(record.timestamp).toBe('2026-08-05T22:26:00.000Z');
    expect(record.surface).toBe('agent');
  });

  test('survives exotic throw values rather than failing to report', () => {
    // A crash handler that itself throws loses the very report it exists for.
    expect(buildCrashRecord('unhandledRejection', 'plain string', CONTEXT).message).toBe('plain string');
    expect(buildCrashRecord('unhandledRejection', undefined, CONTEXT).message).toBe('undefined');
    expect(buildCrashRecord('unhandledRejection', { nope: 1 }, CONTEXT).stack).toBeNull();

    const hostile = new Proxy(new Error('x'), {
      get(): never { throw new Error('getter exploded'); },
    });
    expect(() => buildCrashRecord('uncaughtException', hostile, CONTEXT)).not.toThrow();
  });

  test('a runaway stack is truncated so one crash cannot evict the history around it', () => {
    const error = new Error('deep');
    error.stack = 'x'.repeat(CRASH_STACK_MAX_CHARS * 3);
    const record = buildCrashRecord('uncaughtException', error, CONTEXT);
    expect(record.stack!.length).toBeLessThan(CRASH_STACK_MAX_CHARS + 200);
    expect(record.stack).toContain('stack truncated');
  });
});

describe('crash log: bounded, validated, disclosed', () => {
  test('a record written by one process is readable afterwards', () => {
    const path = join(tempDir(), CRASH_LOG_FILENAME);
    expect(appendCrashRecord(path, buildCrashRecord('uncaughtException', new Error('boom'), CONTEXT))).toBe(true);

    const records = readCrashRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toBe('boom');
    expect(records[0]!.sessionId).toBe('user-cd11b528');
  });

  test('the log rotates by size and loses no record across one rotation', () => {
    const path = join(tempDir(), CRASH_LOG_FILENAME);
    const padding = 'p'.repeat(4000);
    const perFile = Math.ceil(CRASH_LOG_ROTATE_BYTES / 4000);
    const total = perFile * 3;
    for (let i = 0; i < total; i++) {
      expect(appendCrashRecord(path, buildCrashRecord('uncaughtException', new Error(`crash-${i}`), {
        ...CONTEXT,
        sessionId: `session-${padding}-${i}`,
      }))).toBe(true);
    }
    // Two files at most, each a little over the rotation size.
    expect(statSync(path).size).toBeLessThan(CRASH_LOG_ROTATE_BYTES + 8192);
    expect(statSync(join(path, '..', CRASH_LOG_PREVIOUS_FILENAME)).size).toBeLessThan(CRASH_LOG_ROTATE_BYTES + 8192);
    const records = readCrashRecords(path);
    // The newest crash is the one under investigation, and the ones before it are in order.
    expect(records.at(-1)!.message).toBe(`crash-${total - 1}`);
    const first = Number(records[0]!.message.slice('crash-'.length));
    expect(records.map((entry) => entry.message)).toEqual(records.map((_, index) => `crash-${first + index}`));
  });

  test('a torn final line does not cost the records before it', () => {
    const path = join(tempDir(), CRASH_LOG_FILENAME);
    appendCrashRecord(path, buildCrashRecord('uncaughtException', new Error('first'), CONTEXT));
    appendCrashRecord(path, buildCrashRecord('unhandledRejection', new Error('second'), CONTEXT));
    // Crashing mid-write is the NORMAL way this file ends.
    writeFileSync(path, `${readFileSync(path, 'utf-8')}{"timestamp":"2026-08-05T22:2`);

    const records = readCrashRecords(path);
    expect(records).toHaveLength(2);
    expect(records.map((entry) => entry.message)).toEqual(['first', 'second']);
  });

  test('a line that parses but is not a crash record is skipped, not trusted', () => {
    const path = join(tempDir(), CRASH_LOG_FILENAME);
    writeFileSync(path, '{"timestamp":"x","kind":"nope"}\n[]\n"a string"\n');
    expect(readCrashRecords(path)).toEqual([]);
  });

  test('a missing log reads as an empty history rather than throwing', () => {
    expect(readCrashRecords(join(tempDir(), 'never-written.jsonl'))).toEqual([]);
  });

  test('an unwritable location is reported, never thrown, so the exit path continues', () => {
    // The caller still owes a stderr line, an activity-log line and an exit code.
    const path = join(tempDir(), 'a-file');
    writeFileSync(path, 'not a directory');
    const wrote = appendCrashRecord(join(path, 'nested', CRASH_LOG_FILENAME),
      buildCrashRecord('uncaughtException', new Error('boom'), CONTEXT));
    expect(wrote).toBe(false);
  });

  test('a credential in a crash message does not land in the clear', () => {
    const path = join(tempDir(), CRASH_LOG_FILENAME);
    appendCrashRecord(path, buildCrashRecord(
      'uncaughtException',
      new Error('request failed: authorization: Bearer sk-ant-api03-SECRETVALUE'),
      CONTEXT,
    ));
    expect(readFileSync(path, 'utf-8')).not.toContain('sk-ant-api03-SECRETVALUE');
    // The record still parses, redaction must keep the line valid JSON.
    expect(readCrashRecords(path)).toHaveLength(1);
  });
});

describe('crash log: retention ownership', () => {
  test('the store is registered, so the existing janitor bounds it by age and size too', () => {
    // An append-only path nobody registered would grow unowned; the registry
    // fails closed on unregistered ids precisely to prevent that.
    expect(isAppendOnlyStoreRegistered('surface-crash-log')).toBe(true);
    const descriptor = APPEND_ONLY_STORES.find((store) => store.id === 'surface-crash-log');
    expect(descriptor).toBeDefined();
    expect(descriptor!.owner).toContain('crash-capture');
  });

  test('it resolves to the home-anchored surface root, and to nothing without one', () => {
    const descriptor = APPEND_ONLY_STORES.find((store) => store.id === 'surface-crash-log')!;
    const targets = descriptor.resolve({ homeDirectory: '/home/op', surfaceRoot: 'agent' });
    expect(targets.files).toEqual([`/home/op/.goodvibes/agent/${CRASH_LOG_FILENAME}`, `/home/op/.goodvibes/agent/${CRASH_LOG_PREVIOUS_FILENAME}`]);
    expect(targets.journalDirs).toEqual([]);
    // A faulting process may have no usable working directory; absent a home
    // root the store is skipped rather than guessed at.
    expect(descriptor.resolve({ workingDirectory: '/proj' }).files).toEqual([]);
  });
});
