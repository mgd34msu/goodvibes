/**
 * Report fatal boot errors directly to the service's file descriptor before exit.
 * Synchronous writes bypass replaceable stream writers; partial writes are retried.
 */

import { writeSync } from 'node:fs';
import { readRefusal } from '@goodvibes/engine/errors';
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
const MAX_SUMMARY_CHARS = 1_000;

interface FailureDescription {
  /** Each link of the chain, outermost first, masked for credentials, then the next step. */
  readonly summary: string;
  /** Name and errno-style code of the innermost error that has them. */
  readonly name?: string;
  readonly code?: string;
  /** The innermost stack, masked: where the failure actually happened. Written to the activity log only. */
  readonly stack?: string;
}

/**
 * The product's own pairing credential: a companion token (`gv_` and 32
 * base64url characters) and a pairing link's `pair=` fragment. The general
 * masking pass knows issuer credentials, not this one, and a failed pairing
 * output can carry both.
 */
const PAIRING_CREDENTIAL = /\bgv_[A-Za-z0-9_-]{16,}|([#?&]pair=)[^\s&]+/g;
function maskPairingCredential(text: string): string {
  return text.replace(PAIRING_CREDENTIAL, (_match, fragment: string | undefined) => `${fragment ?? ''}[REDACTED_PAIRING_TOKEN]`);
}

/** One link's own text: a refusal's reason, or the error's own message (data properties only). */
function linkText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const carried = readRefusal(value);
  if (carried) return carried.reason.replace(/\.+$/, '');
  const message = ownValue(value, 'message');
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/**
 * Follow the failure's `cause` chain, so "Daemon host server startup failed"
 * reaches the busy port that caused it, and name the next step a refusal in
 * the chain carries. Every message is masked for credentials (tokens, keys,
 * pairing links) by the one local masking pass; paths stay readable because
 * the report is read on this machine.
 */
function describeFailure(error: unknown): FailureDescription {
  const parts: string[] = [];
  let next: string | undefined;
  let name: string | undefined;
  let code: string | undefined;
  let stack: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    let part = linkText(current);
    next ??= readRefusal(current)?.next[0];
    const errors = ownValue(current, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      const named = errors.slice(0, MAX_AGGREGATE_ERRORS).map((inner: unknown) => linkText(inner) ?? 'unknown error');
      part = `${part ?? 'several failures'} (${named.join('; ')}${errors.length > MAX_AGGREGATE_ERRORS ? `; and ${errors.length - MAX_AGGREGATE_ERRORS} more` : ''})`;
    }
    if (part !== undefined && parts[parts.length - 1] !== part) parts.push(part);
    if (current instanceof Error && current.name !== 'Error' && current.name !== 'RefusalError') name = current.name;
    const ownCode = ownValue(current, 'code');
    if ((typeof ownCode === 'string' && /^E[A-Z0-9_]{2,30}$/.test(ownCode)) || typeof ownCode === 'number') code = String(ownCode);
    const ownStack = ownValue(current, 'stack');
    if (typeof ownStack === 'string') stack = ownStack;
    current = typeof current === 'string' ? undefined : ownValue(current, 'cause');
  }
  let summary = parts.length > 0 ? parts.join(': ') : 'the daemon could not continue';
  const cause = [name, code].filter((value): value is string => value !== undefined);
  if (cause.length > 0) summary += ` (${cause.join(' ')})`;
  // Masked first, then one bounded line: the service journal shows a line per write.
  summary = redactDiagnosticText(maskPairingCredential(summary), { anonymize: false }).replace(/\s*[\r\n]+\s*/g, ' ');
  if (summary.length > MAX_SUMMARY_CHARS) summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}…`;
  if (next !== undefined) summary += `. ${next}`;
  return {
    summary,
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack: redactDiagnosticText(maskPairingCredential(stack), { anonymize: false }) }),
  };
}

/**
 * The one masked line a failure prints: each link of its cause chain and the
 * next step. Daemon commands print it too, so a failed command says why.
 */
export function describeFatalFailure(error: unknown): string {
  try { return describeFailure(error).summary; } catch { return 'the daemon could not continue'; }
}

/**
 * Report a fatal boot failure everywhere it can be found, then leave the exit
 * to the caller.
 *
 * The stream line names every link of the failure's `cause` chain (the phase
 * that failed and the reason it failed, such as a port already in use), masked
 * for credentials, and the next step. The innermost stack goes to the activity
 * log only. The stream write happens FIRST and synchronously. The activity log
 * is attempted after, because it is the part that can fail, it needs a
 * configured destination, a writable directory, and a flush, and the guarantee
 * this function makes is the stream line, not the log line.
 */
export function reportFatalBootFailure(error: unknown, context = 'goodvibes daemon host'): void {
  // Local masking: the report is read on this machine, so paths stay readable.
  const safeContext = context === 'goodvibes daemon host' ? context : redactDiagnosticText(context, { anonymize: false });
  let described: FailureDescription;
  try { described = describeFailure(error); } catch { described = { summary: 'the daemon could not continue' }; }
  writeFatalLine(`${safeContext} failed: ${described.summary}`);
  try {
    logger.error(`${safeContext} failed`, {
      error: described.summary,
      ...(described.name === undefined ? {} : { name: described.name }),
      ...(described.code === undefined ? {} : { code: described.code }),
      ...(described.stack === undefined ? {} : { stack: described.stack }),
    });
    flushActivityLogSync();
  } catch {
    // The reason is already on stderr, which is the guarantee. A log that
    // cannot be written must not escalate into a different failure.
  }
}
