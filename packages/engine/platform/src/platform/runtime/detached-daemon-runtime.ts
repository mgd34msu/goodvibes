/**
 * pid/port discovery for the running daemon.
 *
 * The daemon records where it actually listens (pid, host, port, start time) in
 * a small JSON file under the daemon home once its listener is bound
 * ({@link publishDaemonRuntimeRecord}), and removes it again when it stops. A
 * client that resolves the daemon's address (config routing, settings
 * preconditions) prefers that record over the configured binding, so a daemon
 * started on another port, for one run, is still found. It is a plain record,
 * not a lock: the pid check and the identity probe decide whether it is alive
 * and the daemon; a record left by a daemon that died is reaped by the reader
 * that proved it stale.
 */

import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { rmSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { join } from 'node:path';

/** File name of the detached-daemon runtime record within the daemon home dir. */
export const DETACHED_DAEMON_RUNTIME_FILE = 'detached-daemon.json';

export interface DetachedDaemonRuntimeRecord {
  readonly pid: number | undefined;
  readonly host: string;
  readonly port: number;
  readonly command: string;
  readonly startedAt: string;
  readonly logFilePath?: string | undefined;
}

/** Absolute path of the runtime record file for a given daemon runtime dir. */
export function detachedDaemonRuntimePath(runtimeDir: string): string {
  return join(runtimeDir, DETACHED_DAEMON_RUNTIME_FILE);
}

/**
 * The part of a runtime record that endpoint discovery actually uses: where to
 * dial, and whose liveness to check. Kept narrow deliberately, a caller
 * supplying a hint should not have to invent a `command` and a `startedAt` it
 * has no opinion about, and the full record satisfies this by construction.
 */
export interface DetachedDaemonRuntimeHint {
  readonly host: string;
  readonly port: number;
  readonly pid?: number | undefined;
  /** When the daemon recorded itself; with the pid it tells one daemon's record from the next. */
  readonly startedAt?: string | undefined;
}

/** Is this pid a process that still exists? Injectable so a test needs no real pid. */
export type ProcessAliveCheck = (pid: number) => boolean;

/**
 * Default liveness check. `kill(pid, 0)` sends no signal, it only asks the
 * kernel whether the pid exists and is signallable. EPERM means it exists and
 * belongs to another user, which still counts as alive.
 */
export const defaultProcessAliveCheck: ProcessAliveCheck = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
};

/**
 * Whether the process this record names still exists.
 *
 * A record with NO pid cannot be checked this way and is not declared dead on
 * that basis, the port probe is then the only evidence, and calling it dead
 * here would strand a daemon that simply recorded no pid.
 */
export function detachedDaemonProcessAlive(
  record: DetachedDaemonRuntimeHint,
  isProcessAlive: ProcessAliveCheck = defaultProcessAliveCheck,
): boolean {
  if (record.pid === undefined) return true;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  return isProcessAlive(record.pid);
}

/** What a reap removed and why; the reader discloses it (config routing passes it to `onRuntimeRecordReaped`). */
export interface DetachedDaemonReapReceipt {
  readonly reapedAt: string;
  /** Plain-language reason: which check the record failed. */
  readonly reason: string;
  readonly record: DetachedDaemonRuntimeHint;
}

/**
 * Remove a runtime record that has been proven not to describe a live daemon,
 * and return what was removed and why.
 *
 * Best-effort and idempotent: two processes can reap the same record
 * concurrently and neither throws. The record is removed only while the file
 * still holds the one that was judged stale: a daemon that started and wrote
 * its own record while the caller was probing keeps it (null is returned and
 * nothing is removed). Removing the record is the point, while it
 * sits there, every endpoint discovery keeps preferring an address nothing
 * answers at, which is exactly the failure this reaping exists to end.
 */
export function reapDetachedDaemonRuntime(
  runtimeDir: string,
  record: DetachedDaemonRuntimeHint,
  reason: string,
): DetachedDaemonReapReceipt | null {
  const receipt: DetachedDaemonReapReceipt = {
    reapedAt: new Date().toISOString(),
    reason,
    record,
  };
  try {
    const onDisk = readDetachedDaemonRuntime(runtimeDir);
    if (onDisk !== null && !sameDaemonRecord(onDisk, record)) {
      logger.info('[detached-daemon] runtime record was replaced while it was judged stale; leaving the new record', {
        stalePid: record.pid,
        currentPid: onDisk.pid,
      });
      return null;
    }
    rmSync(detachedDaemonRuntimePath(runtimeDir), { force: true });
  } catch {
    return null;
  }
  return receipt;
}

/** Whether two records describe the same daemon launch: same address, pid and (when both say) start time. */
function sameDaemonRecord(current: DetachedDaemonRuntimeHint, stale: DetachedDaemonRuntimeHint): boolean {
  if (current.host !== stale.host || current.port !== stale.port || current.pid !== stale.pid) return false;
  if (current.startedAt && stale.startedAt) return current.startedAt === stale.startedAt;
  return true;
}

/** Write (or overwrite) the detached-daemon runtime record. Best-effort; never throws. */
export function recordDetachedDaemonRuntime(
  runtimeDir: string,
  record: DetachedDaemonRuntimeRecord,
): string | null {
  const path = detachedDaemonRuntimePath(runtimeDir);
  try {
    writeJsonFileAtomic(path, record);
    return path;
  } catch (error) {
    // A daemon with no record is not discoverable by other surfaces; say so.
    logger.warn('[detached-daemon] could not write the runtime record; other surfaces will not discover this daemon from it', {
      path,
      error: summarizeError(error),
    });
    return null;
  }
}

/** Read the detached-daemon runtime record, or null if missing/unparseable. */
export function readDetachedDaemonRuntime(runtimeDir: string): DetachedDaemonRuntimeRecord | null {
  try {
    return readJsonFileOrQuarantine<DetachedDaemonRuntimeRecord>(detachedDaemonRuntimePath(runtimeDir), {
      label: 'runtime/detached-daemon-runtime',
      recovery: 'The detached daemon is treated as not running from this record; the next daemon start rewrites it, and an already-running daemon is still reachable through its configured host and port.',
      validate: (raw) => {
        const parsed = raw as Partial<DetachedDaemonRuntimeRecord> | null;
        if (!parsed || typeof parsed.port !== 'number' || typeof parsed.host !== 'string') {
          throw new Error('runtime record is missing a numeric port or a host');
        }
        return {
          pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
          host: parsed.host,
          port: parsed.port,
          command: typeof parsed.command === 'string' ? parsed.command : '',
          startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
          logFilePath: typeof parsed.logFilePath === 'string' ? parsed.logFilePath : undefined,
        };
      },
    });
  } catch {
    return null;
  }
}

/** The record a daemon publishes for itself; remove it when the daemon stops. */
export interface PublishedDaemonRuntimeRecord {
  readonly record: DetachedDaemonRuntimeRecord;
  /** Remove the record, unless another daemon has since written its own. Never throws. */
  remove(): void;
}

/**
 * Publish the running daemon's own record once its listener is bound: one
 * atomic write per daemon start. `remove()` takes it away at stop, and leaves
 * the file alone when it no longer holds this daemon's record (a replacement
 * daemon that started meanwhile keeps its own). Returns null when the record
 * could not be written; the daemon is then still found through its configured
 * binding.
 */
export function publishDaemonRuntimeRecord(
  runtimeDir: string,
  bound: { readonly host: string; readonly port: number; readonly command: string; readonly logFilePath?: string | undefined },
  now: () => Date = () => new Date(),
): PublishedDaemonRuntimeRecord | null {
  const record: DetachedDaemonRuntimeRecord = {
    pid: process.pid,
    host: bound.host,
    port: bound.port,
    command: bound.command,
    startedAt: now().toISOString(),
    ...(bound.logFilePath === undefined ? {} : { logFilePath: bound.logFilePath }),
  };
  if (recordDetachedDaemonRuntime(runtimeDir, record) === null) return null;
  return {
    record,
    remove() {
      try {
        const onDisk = readDetachedDaemonRuntime(runtimeDir);
        if (onDisk === null || !sameDaemonRecord(onDisk, record)) return;
        rmSync(detachedDaemonRuntimePath(runtimeDir), { force: true });
      } catch {
        // A record left behind is reaped by the next reader that finds its pid gone.
      }
    },
  };
}
