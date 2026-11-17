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
 *  - Bounded by rotation, not by rewriting. A record is one O_APPEND write.
 *    Once the log has reached {@link CRASH_LOG_ROTATE_BYTES} it is renamed to
 *    the previous-log name (replacing the older one) before the record is
 *    appended, so the two files together never hold much more than twice
 *    that, and nothing is ever read back or rewritten on the write path. A
 *    record another process appends during the rename lands in one file or
 *    the other; it is not lost. Both files are registered with the
 *    append-only retention registry, whose janitor also applies the age and
 *    total-size caps every other append-only store gets.
 *  - Content-validated. `readCrashRecords` parses and shape-checks every line
 *    and SKIPS anything torn or malformed rather than throwing. A crash log is
 *    written by a process that is in the act of dying, so a half-written last
 *    line is an expected state, not a corruption to escalate.
 *  - Redacted. Every line is credential-redacted before it lands, because a
 *    stack or an error message can carry a token in an argument. The same
 *    local pass the journals use (redactAtRestLine): a credential-shaped span
 *    is kept in the clear only when its characters prove it harmless.
 *
 * The write path is deliberately synchronous. It runs from an
 * `uncaughtException` handler where the process is about to exit, so a
 * promise-based write would lose the race with `process.exit`.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { redactAtRestLine } from './at-rest-persistence.js';
import { resolveScopedDirectory } from './surface-root.js';

/** Which process-level fault produced a record. */
export type CrashKind = 'uncaughtException' | 'unhandledRejection';

/** Filename of the crash log within a surface's home-anchored root. */
export const CRASH_LOG_FILENAME = 'crashes.jsonl';

/** Where a surface's crash log lives: its home-anchored storage root, where the retention janitor also looks. */
export function surfaceCrashLogPath(homeDirectory: string, surfaceRoot: string): string {
  return resolveScopedDirectory(homeDirectory, surfaceRoot, CRASH_LOG_FILENAME);
}

/** Filename the crash log is moved to when it rotates; the one before it is replaced. */
export const CRASH_LOG_PREVIOUS_FILENAME = 'crashes.previous.jsonl';

/** The previous-log path beside a crash log. */
export function previousCrashLogPath(filePath: string): string {
  return join(dirname(filePath), basename(filePath) === CRASH_LOG_FILENAME ? CRASH_LOG_PREVIOUS_FILENAME : `${basename(filePath)}.previous`);
}

/**
 * Size at which the crash log rotates. At the largest record (a stack cut at
 * {@link CRASH_STACK_MAX_CHARS}) that is still about thirty crashes per file;
 * typical records are far smaller.
 */
export const CRASH_LOG_ROTATE_BYTES = 256 * 1024;

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
 * Read every well-formed record from a crash log, oldest first, including the
 * records the log rotated out into its previous file.
 *
 * Content-validated, never existence-validated: a line that does not parse or
 * does not carry the record shape is skipped, so one torn tail line (the
 * normal outcome of crashing mid-write) still yields every record before it.
 * A missing or unreadable file reads as an empty history.
 */
export function readCrashRecords(filePath: string): CrashRecord[] {
  return [...readCrashFile(previousCrashLogPath(filePath)), ...readCrashFile(filePath)];
}

function readCrashFile(filePath: string): CrashRecord[] {
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
 * Append one crash record: one masked line in one O_APPEND write, the cheapest
 * thing that can land from a dying process. When the log has already reached
 * {@link CRASH_LOG_ROTATE_BYTES} it is first renamed to the previous-log name;
 * nothing is read back, rewritten or locked.
 *
 * Best-effort by contract: returns `false` instead of throwing when the record
 * cannot be masked or written. The caller is an exit-boundary handler whose remaining duty (stderr,
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
  try {
    if (statSync(filePath).size >= CRASH_LOG_ROTATE_BYTES) renameSync(filePath, previousCrashLogPath(filePath));
  } catch {
    // No log yet, or it could not be rotated: the record is appended either way.
  }
  try {
    appendFileSync(filePath, line, { mode: 0o600 });
    return true;
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
