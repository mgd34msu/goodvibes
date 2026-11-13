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
const LOCK_DIR = resolve(ENGINE_ROOT, '.tmp/build.lock');
const PID_FILE = resolve(LOCK_DIR, 'pid');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function isStale(): boolean {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  } catch {
    try { return Date.now() - statSync(LOCK_DIR).mtimeMs > 5_000; } catch { return true; }
  }
}

export async function withWorkspaceLock<T>(label: string, fn: () => T | Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  mkdirSync(dirname(LOCK_DIR), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(PID_FILE, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStale()) { rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the build lock before "${label}" (${LOCK_DIR})`);
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  try { return await fn(); } finally { rmSync(LOCK_DIR, { recursive: true, force: true }); }
}
