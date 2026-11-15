/**
 * Atomic JSON publication and transaction serialization for agent stores.
 * writeStoreFile prevents torn files; runStoreFileUpdate and
 * runStoreFileUpdateSync hold the store's process lock for the whole
 * transaction, so a CLI process and a running agent updating one store take
 * turns, and updates within one process run in the order they were made.
 */
import { atomicWriteFileSync, type AtomicWriteOptions } from '@goodvibes-jev/engine/platform/platform/config';
import { withProcessLock, withProcessLockSync } from '@goodvibes-jev/engine/platform/platform/utils';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Atomic single-file writes
// ---------------------------------------------------------------------------

/**
 * Write `contents` to `path` through the platform's atomic-write primitive
 * (private temp file, fsync, then rename), creating the parent directory if
 * needed. A failed write leaves `path` holding its previous contents; the platform
 * primitive removes its own temp file on failure.
 */
export function writeStoreFile(path: string, contents: string, options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {}): void {
  atomicWriteFileSync(path, contents, { ...options, mkdirp: true });
}

/** {@link writeStoreFile} for the pretty-printed-JSON-plus-newline shape most stores use. */
export function writeStoreJson(path: string, data: unknown, options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {}): void {
  writeStoreFile(path, `${JSON.stringify(data, null, 2)}\n`, options);
}

// ---------------------------------------------------------------------------
// Serializing read-modify-write cycles
// ---------------------------------------------------------------------------

/** The store's lock file, next to it; created on first use and never removed. */
function storeLockPath(path: string): string {
  return `${resolve(path)}.writer.sqlite`;
}

/** Serialize a synchronous read-modify-write transaction across CLI and agent processes. */
export function runStoreFileUpdateSync<T>(path: string, update: () => T): T {
  return withProcessLockSync(storeLockPath(path), update);
}

/**
 * Run `update` once every earlier update of `path` in this process has
 * settled and no other process holds the store's lock. A failed update never
 * wedges the ones behind it; `update`'s own result or rejection is returned.
 */
export function runStoreFileUpdate<T>(path: string, update: () => Promise<T> | T): Promise<T> {
  return withProcessLock(storeLockPath(path), update);
}
