/**
 * Crash capture, the last durable trace a surface writes before an uncaught
 * fault takes the process down.
 *
 * Why this exists: an agent process died on an uncaught exception and the
 * stack existed ONLY on the operator's terminal. Nothing reached the activity
 * log, and no crash file was written; the stack was recovered afterwards only
 * because a terminal pane happened to have been captured. A fault that leaves
 * no durable trace is a fault nobody can diagnose after the fact.
 *
 * What lands: one JSON record per fault carrying the stack, the surface
 * version, the pid, the session that was active at the moment of the fault,
 * the timestamp, and whether the fault ended the process (`fatal`): an
 * unhandled rejection the surface survives is recorded too, and is told apart
 * from a crash by that field.
 *
 * Where it is read: {@link summarizeCrashLog} gives the count, the newest
 * record and the path, and {@link describeCrashLog} the one line a status or
 * doctor output prints. The daemon installs the same capture through
 * {@link installProcessCrashCapture}.
 *
 * Persisted-state doctrine (bounded / content-validated / disclosed):
 *  - Bounded twice. `appendCrashRecord` keeps at most
 *    {@link CRASH_LOG_MAX_RECORDS} records, dropping oldest-first at write
 *    time, and the store also registers with the append-only retention
 *    registry so the existing janitor enforces the age and total-size caps.
 *    An append-only file nobody prunes is a leak with a nicer name.
 *  - Content-validated. `readCrashRecords` parses and shape-checks every line
 *    and SKIPS anything torn or malformed rather than throwing. A crash log is
 *    written by a process that is in the act of dying, so a half-written last
 *    line is an expected state, not a corruption to escalate.
 *  - Redacted. Every line is credential-redacted before it lands, because a
 *    stack or an error message can carry a token in an argument. A dying
 *    process cannot wait for a reading, so a credential-shaped span is kept in
 *    the clear only when an earlier write already read it as not a credential
 *    (engine.runtime.at-rest-credential); every other such span is masked.
 *
 * The write path is deliberately synchronous. It runs from an
 * `uncaughtException` handler where the process is about to exit, so a
 * promise-based write would lose the race with `process.exit`.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { redactAtRestLine } from './at-rest-persistence.js';
import { withSyncFileLock } from '../config/sync-file-lock.js';
import { resolveScopedDirectory } from './surface-root.js';

/** Which process-level fault produced a record. */
export type CrashKind = 'uncaughtException' | 'unhandledRejection';

/** Filename of the crash log within a surface's home-anchored root. */
export const CRASH_LOG_FILENAME = 'crashes.jsonl';

/** Where a surface's crash log lives: its home-anchored storage root, where the retention janitor also looks. */
export function surfaceCrashLogPath(homeDirectory: string, surfaceRoot: string): string {
  return resolveScopedDirectory(homeDirectory, surfaceRoot, CRASH_LOG_FILENAME);
}

/**
 * Count cap on retained crash records. Small on purpose: the newest crashes
 * are the ones under investigation, and this file is read by a human, not a
 * query engine. Age and total-size caps come from the retention registry on
 * top of this.
 */
export const CRASH_LOG_MAX_RECORDS = 25;

/**
 * Cap on a single record's stack text. A runaway recursive stack can be
 * megabytes; truncating keeps one pathological crash from consuming the whole
 * store's size budget and evicting the history around it.
 */
export const CRASH_STACK_MAX_CHARS = 8_000;

/** One captured process-level fault. */
export interface CrashRecord {
  /** ISO-8601 UTC timestamp of the fault. */
  readonly timestamp: string;
  /** Which process-level fault fired. */
  readonly kind: CrashKind;
  /** The error's message, or a stringified non-Error throw value. */
  readonly message: string;
  /** The stack, truncated to {@link CRASH_STACK_MAX_CHARS}; null when absent. */
  readonly stack: string | null;
  /** Surface version the fault happened on. */
  readonly version: string;
  /** Process id that faulted. */
  readonly pid: number;
  /** Session active at the moment of the fault; null when none was active. */
  readonly sessionId: string | null;
  /** Surface that faulted, e.g. `'agent'`. */
  readonly surface: string;
  /** Whether the fault ended the process. Records written before this field existed read it from `kind`. */
  readonly fatal: boolean;
}

/** Inputs for {@link buildCrashRecord} other than the thrown value itself. */
export interface CrashContext {
  readonly version: string;
  readonly surface: string;
  readonly sessionId: string | null;
  readonly pid?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Whether the fault ends the process; defaults to true for an uncaught exception and false for a rejection the surface survives. */
  readonly fatal?: boolean;
}

function truncateStack(stack: string): string {
  if (stack.length <= CRASH_STACK_MAX_CHARS) return stack;
  return `${stack.slice(0, CRASH_STACK_MAX_CHARS)}\n… stack truncated at ${CRASH_STACK_MAX_CHARS} characters`;
}

/**
 * Build a crash record from a thrown value. Never throws: a crash handler that
 * itself throws loses the very report it exists to produce, so every field
 * extraction is defensive against exotic throw values (a Proxy whose `message`
 * getter throws, a null prototype object, a bare string).
 */
export function buildCrashRecord(kind: CrashKind, thrown: unknown, context: CrashContext): CrashRecord {
  let message: string;
  let stack: string | null = null;
  try {
    if (thrown instanceof Error) {
      message = thrown.message;
      stack = typeof thrown.stack === 'string' ? truncateStack(thrown.stack) : null;
    } else {
      message = String(thrown);
    }
  } catch {
    message = '<unrepresentable throw value>';
  }
  return {
    timestamp: (context.now?.() ?? new Date()).toISOString(),
    kind,
    message,
    stack,
    version: context.version,
    pid: context.pid ?? process.pid,
    sessionId: context.sessionId,
    surface: context.surface,
    fatal: context.fatal ?? kind === 'uncaughtException',
  };
}

function isCrashRecord(value: unknown): value is CrashRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['timestamp'] === 'string' &&
    (record['kind'] === 'uncaughtException' || record['kind'] === 'unhandledRejection') &&
    typeof record['message'] === 'string' &&
    (record['stack'] === null || typeof record['stack'] === 'string') &&
    typeof record['version'] === 'string' &&
    typeof record['pid'] === 'number' &&
    (record['sessionId'] === null || typeof record['sessionId'] === 'string') &&
    typeof record['surface'] === 'string' &&
    (record['fatal'] === undefined || typeof record['fatal'] === 'boolean')
  );
}

/**
 * Read every well-formed record from a crash log, oldest first.
 *
 * Content-validated, never existence-validated: a line that does not parse or
 * does not carry the record shape is skipped, so one torn tail line (the
 * normal outcome of crashing mid-write) still yields every record before it.
 * A missing or unreadable file reads as an empty history.
 */
export function readCrashRecords(filePath: string): CrashRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const records: CrashRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isCrashRecord(parsed)) continue;
    const fatal = (parsed as { fatal?: unknown }).fatal;
    records.push(typeof fatal === 'boolean' ? parsed : { ...parsed, fatal: parsed.kind === 'uncaughtException' });
  }
  return records;
}

/** What a status or doctor output says about a surface's crash log. */
export interface CrashLogSummary {
  readonly path: string;
  /** Records held, fatal or not. */
  readonly count: number;
  /** Records of faults that ended the process. */
  readonly fatalCount: number;
  /** The newest record, or null when the log is empty or absent. */
  readonly newest: CrashRecord | null;
}

/** Read a crash log into the few facts a status line needs. A missing log is an empty one. */
export function summarizeCrashLog(filePath: string): CrashLogSummary {
  const records = readCrashRecords(filePath);
  return {
    path: filePath,
    count: records.length,
    fatalCount: records.filter((record) => record.fatal).length,
    newest: records.at(-1) ?? null,
  };
}

/** The status/doctor line for a crash log, or null when it holds nothing. */
export function describeCrashLog(summary: CrashLogSummary): string | null {
  if (summary.count === 0 || summary.newest === null) return null;
  const newest = summary.newest;
  const what = newest.fatal ? 'crash' : 'survived error';
  return `crash log: ${summary.fatalCount} crash${summary.fatalCount === 1 ? '' : 'es'} and ${summary.count - summary.fatalCount} survived error${summary.count - summary.fatalCount === 1 ? '' : 's'} recorded; `
    + `newest ${what} ${newest.timestamp} (${newest.message.slice(0, 120)}); see ${summary.path}`;
}

/**
 * Append one crash record, enforcing the count cap.
 *
 * Fast path is a plain O_APPEND write, a single small line, which is the
 * cheapest thing that can land from a dying process. The rewrite that enforces
 * {@link CRASH_LOG_MAX_RECORDS} only runs once the file has actually grown
 * past the cap (a log of unusually small records can sit a little over the
 * cap until then; the retention janitor still bounds it), and goes through `writeFileAtomic` so a crash during the
 * trim cannot leave a truncated log.
 *
 * Best-effort by contract: returns `false` instead of throwing when the record
 * cannot be redacted or written. The caller is an exit-boundary handler whose remaining duty (stderr,
 * activity log, exit code) must still run on a read-only or full disk.
 */
export function appendCrashRecord(filePath: string, record: CrashRecord): boolean {
  let line: string;
  try {
    line = `${redactAtRestLine(JSON.stringify(record))}\n`;
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    return false;
  }
  // Appending and trimming run under one cross-process lock: a trim rewrites
  // the whole file, so a record another process appended between its read and
  // its rename would be lost. The lock is brief and, when it cannot be taken,
  // the operation still runs rather than dropping the record.
  try {
    return withSyncFileLock(filePath, () => {
      try {
        appendFileSync(filePath, line, { mode: 0o600 });
      } catch {
        return false;
      }
      try {
        // Cheap guard: only pay for a read+rewrite once the file could plausibly
        // hold more than the cap. An average record is well under 1 KiB.
        if (statSync(filePath).size < CRASH_LOG_MAX_RECORDS * 1024) return true;
        const records = readCrashRecords(filePath);
        if (records.length <= CRASH_LOG_MAX_RECORDS) return true;
        const kept = records.slice(records.length - CRASH_LOG_MAX_RECORDS);
        const contents = kept.map((entry) => `${redactAtRestLine(JSON.stringify(entry))}\n`).join('');
        writeFileAtomic(filePath, contents, { mode: 0o600 });
      } catch {
        // The record itself already landed; failing to trim is not worth losing it.
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * The terminal line that follows a crash: where the record is, or that it is
 * not anywhere, so nobody is sent to a file that does not hold it.
 */
export function crashRecordLine(filePath: string, written: boolean): string {
  return written
    ? `crash record written to ${filePath}`
    : `crash record could not be written to ${filePath}; the stack above is the only copy`;
}

export interface ProcessCrashCaptureOptions {
  readonly surface: string;
  readonly version: string;
  /** Where the records go. */
  readonly crashLogPath: string;
  /** The session active at the moment of the fault, when the process has one. */
  readonly sessionId?: (() => string | null) | undefined;
  /** Injectable for tests; the default writes to file descriptor 2, which no output guard intercepts. */
  readonly writeStderr?: ((line: string) => void) | undefined;
  /** Injectable for tests; the default is `process.exit`. */
  readonly exit?: ((code: number) => void) | undefined;
}

/**
 * Install the crash capture for a process that has no handler of its own (the
 * daemon): an uncaught exception is recorded as fatal, reported on stderr with
 * where the record went, and ends the process with status 1; an unhandled
 * rejection is recorded as survived and the process carries on. Returns the
 * function that removes both listeners.
 */
export function installProcessCrashCapture(options: ProcessCrashCaptureOptions): () => void {
  const writeStderr = options.writeStderr ?? ((line: string): void => { writeSync(2, `${line}\n`); });
  const exit = options.exit ?? ((code: number): void => { process.exit(code); });
  const capture = (kind: CrashKind, thrown: unknown): boolean => {
    let sessionId: string | null = null;
    try { sessionId = options.sessionId?.() ?? null; } catch { /* a broken accessor must not cost the record */ }
    return appendCrashRecord(options.crashLogPath, buildCrashRecord(kind, thrown, { version: options.version, surface: options.surface, sessionId }));
  };
  const onUncaughtException = (error: unknown): void => {
    const written = capture('uncaughtException', error);
    try {
      writeStderr(`${options.surface} crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      writeStderr(crashRecordLine(options.crashLogPath, written));
    } catch { /* the record is the durable part */ }
    exit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    const written = capture('unhandledRejection', reason);
    try {
      writeStderr(`${options.surface} unhandled rejection (still running): ${reason instanceof Error ? reason.message : String(reason)}; ${crashRecordLine(options.crashLogPath, written)}`);
    } catch { /* the record is the durable part */ }
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  return () => {
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  };
}
