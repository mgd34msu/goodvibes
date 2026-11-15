import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mutual exclusion for BUILDS only (build.ts, package staging), so two builders
 * never write the same output tree at once. Tests do not take it: they run from
 * source (the `bun` export condition) and read nothing a build rewrites.
 *
 * A lock is a directory holding its owner's pid. A directory whose owner is
 * dead (or that never got a pid and is older than a few seconds) is stale and
 * taken over.
 */
const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_DIR = resolve(ENGINE_ROOT, '.tmp/build.lock');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function isStale(lockDir: string): boolean {
  try {
    const pid = Number(readFileSync(resolve(lockDir, 'pid'), 'utf8'));
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  } catch {
    try { return Date.now() - statSync(lockDir).mtimeMs > 5_000; } catch { return true; }
  }
}

/**
 * Remove a stale lock. Several waiters can judge the same dead lock stale at
 * once, and removing "the lock" by name would let a slower one delete the live
 * lock a faster one has just created. Takeover is therefore serialized by its
 * own mutex directory, and staleness is judged again inside it: while the stale
 * directory exists nobody can create a new lock, so the judgment and the
 * removal cannot straddle one.
 */
function takeOverStale(lockDir: string): boolean {
  const mutex = `${lockDir}.takeover`;
  try { mkdirSync(mutex); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A takeover that died half-way must not block every later one.
    try { if (Date.now() - statSync(mutex).mtimeMs > 10_000) rmSync(mutex, { recursive: true, force: true }); } catch { /* released meanwhile */ }
    return false;
  }
  try {
    if (isStale(lockDir)) rmSync(lockDir, { recursive: true, force: true });
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
  return true;
}

/** Remove the lock only while it still names this process, never one a takeover handed to another. */
function release(lockDir: string): void {
  try {
    if (readFileSync(resolve(lockDir, 'pid'), 'utf8') !== String(process.pid)) return;
  } catch { return; }
  rmSync(lockDir, { recursive: true, force: true });
}

export async function withWorkspaceLock<T>(label: string, fn: () => T | Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS, lockDir = DEFAULT_LOCK_DIR): Promise<T> {
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(resolve(lockDir, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStale(lockDir)) {
        // Another waiter is taking it over: let it finish rather than spin.
        if (!takeOverStale(lockDir)) await new Promise((done) => setTimeout(done, 50));
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the build lock before "${label}" (${lockDir})`);
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  try { return await fn(); } finally { release(lockDir); }
}
