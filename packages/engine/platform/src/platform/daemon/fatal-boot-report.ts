/**
 * Report fatal boot errors directly to the service's file descriptor before exit.
 * Synchronous writes bypass replaceable stream writers; partial writes are retried.
 */

import { writeSync } from 'node:fs';
import { summarizeError } from '../utils/error-display.js';
import { flushActivityLogSync, logger } from '../utils/logger.js';
import { redactDiagnosticText } from '../utils/redaction.js';

/** stdout and stderr, as the file descriptors they actually are. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

/**
 * Write `line` to `fd`, looping until every byte is accepted (or the
 * descriptor stops making progress). A single `writeSync` call can return a
 * short count for a large payload; looping is what lets this module also
 * back callers like `--help`/`--version`/status-render output, not just a
 * short fatal line.
 */
function writeLineToFd(fd: number, line: string): void {
  try {
    const payload = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf-8');
    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      // A zero-byte write would spin forever; stop and take what got through.
      if (n <= 0) break;
      written += n;
    }
  } catch {
    // A closed or unwritable descriptor must never turn a diagnostic into a
    // second failure. There is nothing further to fall back to: this IS the
    // fallback.
  }
}

/**
 * Write one line to stderr synchronously, immune to a replaced
 * `process.stderr` and to exit-time truncation. Use this for anything that
 * gates a process exit.
 */
export function writeFatalLine(line: string): void {
  writeLineToFd(STDERR_FD, line);
}

/**
 * The stdout twin, for output that must survive an exit that follows it,
 * `--install-service` prints the unit path and the follow-up commands and then
 * exits immediately, which is the same race.
 */
export function writeExitingStdoutLine(line: string): void {
  writeLineToFd(STDOUT_FD, line);
}

/** An own data property; an accessor is never run on the fatal path. */
function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** How deep a `cause` chain is followed, and how many errors of an aggregate are named. */
const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE_ERRORS = 3;

interface FailureDescription {
  /** Each error of the chain, outermost first, joined by ": ". */
  readonly summary: string;
  /** Name and errno-style code of the innermost error that has them. */
  readonly name?: string;
  readonly code?: string;
  /** The innermost stack: where the failure actually happened. */
  readonly stack?: string;
}

/**
 * Follow the failure's `cause` chain, so "Daemon host server startup failed"
 * reaches the busy port that caused it. An aggregate names its first errors.
 */
function describeFailure(error: unknown): FailureDescription {
  const parts: string[] = [];
  let name: string | undefined;
  let code: string | undefined;
  let stack: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    let part = summarizeError(current);
    const errors = ownValue(current, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      const named = errors.slice(0, MAX_AGGREGATE_ERRORS).map((inner: unknown) => summarizeError(inner));
      part += ` (${named.join('; ')}${errors.length > MAX_AGGREGATE_ERRORS ? `; and ${errors.length - MAX_AGGREGATE_ERRORS} more` : ''})`;
    }
    parts.push(part);
    if (current instanceof Error && current.name !== 'Error') name = current.name;
    const ownCode = ownValue(current, 'code');
    if (typeof ownCode === 'string' || typeof ownCode === 'number') code = String(ownCode);
    const ownStack = ownValue(current, 'stack');
    if (typeof ownStack === 'string') stack = ownStack;
    current = ownValue(current, 'cause');
  }
  return {
    summary: parts.join(': '),
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack }),
  };
}

/**
 * Report a fatal boot failure everywhere it can be found, then leave the exit
 * to the caller.
 *
 * The line names every error of the failure's `cause` chain (the phase that
 * failed and the reason it failed, such as a port already in use), masked for
 * credentials. The stream write happens FIRST and synchronously. The activity
 * log is attempted after, because it is the part that can fail, it needs a
 * configured destination, a writable directory, and a flush, and the
 * guarantee this function makes is the stream line, not the log line.
 */
export function reportFatalBootFailure(error: unknown, context = 'goodvibes daemon host'): void {
  // Local masking: the report is read on this machine, so paths stay readable.
  const safeContext = context === 'goodvibes daemon host' ? context : redactDiagnosticText(context, { anonymize: false });
  let described: FailureDescription;
  try { described = describeFailure(error); } catch { described = { summary: 'Unexpected error' }; }
  const summary = redactDiagnosticText(described.summary, { anonymize: false });
  const stack = described.stack === undefined ? undefined : redactDiagnosticText(described.stack, { anonymize: false });
  writeFatalLine(`${safeContext} failed: ${summary}`);
  if (stack) writeFatalLine(stack);
  try {
    logger.error(`${safeContext} failed`, {
      error: summary,
      ...(described.name === undefined ? {} : { name: described.name }),
      ...(described.code === undefined ? {} : { code: described.code }),
    });
    flushActivityLogSync();
  } catch {
    // The reason is already on stderr, which is the guarantee. A log that
    // cannot be written must not escalate into a different failure.
  }
}
