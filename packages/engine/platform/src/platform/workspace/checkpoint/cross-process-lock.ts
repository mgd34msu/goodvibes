/**
 * cross-process-lock.ts, the named-path lock every store shares with other
 * processes, on top of the kernel-released lock (utils/process-lock.ts).
 *
 * Who holds a lock is decided by the kernel alone: the holder takes a SQLite
 * write reservation on `<lockPath>.held`, and the operating system drops it
 * when that process exits, however it exits. No pid is compared, no age is
 * judged and nothing is taken over, so a lock left by a killed, OOM-killed or
 * powered-off holder is free the moment its process is gone, even when the pid
 * has since been reused.
 *
 * While the lock is held, `<lockPath>` itself exists and names the holder
 * (`{"pid","token","acquiredAt"}`), so a refusal can say who holds it and since
 * when, and stores that observe the lock file (its identity, its existence
 * while a creation is in flight) keep working. The holder removes it on
 * release; a file left by a holder that died is replaced by the next one.
 */
import { closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  acquireProcessLock,
  holdProcessLock,
  withProcessLockSync,
  ProcessLockBusyError,
  ProcessLockUnavailableError,
  type HeldProcessLock,
} from '../../utils/process-lock.js';

export interface CrossProcessLockOptions {
  /** Give up and throw after waiting this long in total. Default 15s. */
  readonly totalTimeoutMs?: number | undefined;
  /** Stops the wait (not the locked work). */
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;

/** The kernel lock behind `lockPath`. A separate name, because `lockPath` itself carries the holder record. */
function kernelLockPath(lockPath: string): string {
  return `${lockPath}.held`;
}

/** Who holds `lockPath` and since when, read only to word a refusal. */
function readHolder(lockPath: string): { pid: number; acquiredAt: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown; acquiredAt?: unknown };
    return typeof parsed.pid === 'number' && typeof parsed.acquiredAt === 'number' ? { pid: parsed.pid, acquiredAt: parsed.acquiredAt } : null;
  } catch {
    return null;
  }
}

/** The lock stayed held by another holder for the whole wait. Names the holder, how long it has held, and what to do. */
export class CrossProcessLockBusyError extends ProcessLockBusyError {
  readonly holderPid: number | null;
  readonly heldSince: number | null;
  constructor(lockPath: string, heldBy: 'this-process' | 'another-process', waitedMs: number) {
    super(lockPath, heldBy, waitedMs);
    this.name = 'CrossProcessLockBusyError';
    const holder = readHolder(lockPath);
    this.holderPid = holder?.pid ?? null;
    this.heldSince = holder?.acquiredAt ?? null;
    const who = holder
      ? `process ${holder.pid}${holder.pid === process.pid ? ' (this process)' : ''}, holding it since ${new Date(holder.acquiredAt).toISOString()} (${Math.max(0, Math.round((Date.now() - holder.acquiredAt) / 1000))} s)`
      : heldBy === 'this-process' ? 'other work in this process' : 'another process';
    this.message = `The lock ${lockPath} is held by ${who} and stayed held for ${waitedMs} ms. Nothing was changed. `
      + 'Retry once that work finishes; the lock is released by the operating system when its process exits, so no file needs removing.';
  }
}

/** Word a busy refusal of this lock's own kernel file in terms of `lockPath`; anything else (the locked work's own errors) passes through. */
function asBusy(lockPath: string, error: unknown): unknown {
  return error instanceof ProcessLockBusyError && !(error instanceof CrossProcessLockBusyError) && error.lockPath === resolve(kernelLockPath(lockPath))
    ? new CrossProcessLockBusyError(lockPath, error.heldBy, error.waitedMs)
    : error;
}

/**
 * Publish this holder's record at `lockPath`. Runs only while the kernel lock
 * is held, so whatever is at the path was left by a holder that is gone.
 * Returns the identity of the file written, so release removes only that one.
 */
function publishHolder(lockPath: string, token: string): { dev: number; ino: number } {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProcessLockUnavailableError(lockPath, error);
  }
  // O_EXCL never follows a symlink planted at the path.
  const fd = openSync(lockPath, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }));
    const stat = fstatSync(fd);
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

function removeHolder(lockPath: string, written: { dev: number; ino: number }): void {
  try {
    const onDisk = lstatSync(lockPath);
    if (onDisk.dev === written.dev && onDisk.ino === written.ino) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('cross-process-lock: the holder record could not be removed; the next holder replaces it', { lockPath, error: summarizeError(error) });
  }
}

/** Live releases handed out by this module, for {@link assertCrossProcessLockCurrent}. */
const liveReleases = new WeakMap<() => void, () => void>();

/** Turn a held kernel lock into the release function callers keep. */
function ownedRelease(lockPath: string, held: HeldProcessLock, assertCurrent?: () => void): () => void {
  let written: { dev: number; ino: number };
  try {
    written = publishHolder(lockPath, randomBytes(8).toString('hex'));
  } catch (error) {
    held.release();
    throw error;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    liveReleases.delete(release);
    try { removeHolder(lockPath, written); } finally { held.release(); }
  };
  liveReleases.set(release, () => assertCurrent?.());
  return release;
}

/**
 * Throws unless `release` is a lock from this module that has not been
 * released. The kernel guarantees nobody else holds it meanwhile, so this is a
 * map lookup plus the caller's own `assertCurrent`, with no file access.
 */
export function assertCrossProcessLockCurrent(release: () => void): void {
  const check = liveReleases.get(release);
  if (!check) throw new Error('The lock was released or was never taken by this process.');
  check();
}

/** One attempt, never waits. Null when another holder (in this or another process) has the lock. */
export function tryAcquireCrossProcessLock(lockPath: string, options: { readonly assertCurrent?: (() => void) | undefined } = {}): (() => void) | null {
  const assertCurrent = options.assertCurrent?.bind(options);
  assertCurrent?.();
  mkdirSync(dirname(lockPath), { recursive: true });
  const held = holdProcessLock(kernelLockPath(lockPath));
  if (!held) return null;
  try {
    assertCurrent?.();
  } catch (error) {
    held.release();
    throw error;
  }
  return ownedRelease(lockPath, held, assertCurrent);
}

/**
 * Acquire the lock at `lockPath`, waiting up to `totalTimeoutMs` (default 15s)
 * for other holders in this or another process. Returns a release function the
 * caller must call, typically in a `finally`; it is idempotent. A wait that
 * runs out throws {@link CrossProcessLockBusyError} naming the holder.
 */
export async function acquireCrossProcessLock(lockPath: string, options: CrossProcessLockOptions = {}): Promise<() => void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  let held: HeldProcessLock;
  try {
    held = await acquireProcessLock(kernelLockPath(lockPath), {
      waitMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    throw asBusy(lockPath, error);
  }
  return ownedRelease(lockPath, held);
}

/**
 * Run a synchronous `write` while holding the lock at `lockPath`. Never waits:
 * a lock held elsewhere, including by other work in this process, throws
 * {@link CrossProcessLockBusyError} at once.
 */
export function withCrossProcessLockSync<T>(lockPath: string, write: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    return withProcessLockSync(kernelLockPath(lockPath), () => {
      const written = publishHolder(lockPath, randomBytes(8).toString('hex'));
      try { return write(); } finally { removeHolder(lockPath, written); }
    }, { waitMs: 0 });
  } catch (error) {
    throw asBusy(lockPath, error);
  }
}
