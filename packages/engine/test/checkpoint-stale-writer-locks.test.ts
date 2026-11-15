/**
 * Locks left behind by a process that was killed must not wedge later writers: the synchronous
 * writer lock and the strict takeover ticket are both released once their recorded owner is gone.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileWriteLockSync } from '../platform/src/platform/workspace/checkpoint/sync-write-lock.js';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';

// Larger than any pid_max, so no process can hold it: kill(pid, 0) reports ESRCH.
const DEAD_PID = 2_147_483_646;
const lockBody = (pid: number): string => JSON.stringify({ pid, token: 'a1b2c3d4e5f60718', acquiredAt: Date.now() });

describe('stale writer locks', () => {
  test('the synchronous writer lock is taken over from a dead process and the write succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcp-sync-lock-'));
    try {
      const target = join(dir, 'register.json');
      writeFileSync(`${target}.lock`, lockBody(DEAD_PID));
      expect(withFileWriteLockSync(target, () => 'written')).toBe('written');
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lock held by a live process is still refused, and says which lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcp-sync-lock-live-'));
    try {
      const target = join(dir, 'register.json');
      writeFileSync(`${target}.lock`, lockBody(process.pid));
      expect(() => withFileWriteLockSync(target, () => 'never')).toThrow(`${target}.lock`);
      expect(readFileSync(`${target}.lock`, 'utf8')).toContain(String(process.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the write result survives the lock having been reclaimed during the write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcp-sync-lock-gone-'));
    try {
      const target = join(dir, 'register.json');
      expect(withFileWriteLockSync(target, () => { rmSync(`${target}.lock`); return 'kept'; })).toBe('kept');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a strict acquire reclaims a dead owner whose takeover ticket was left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcp-ticket-'));
    try {
      const lockPath = join(dir, 'lock');
      writeFileSync(lockPath, lockBody(DEAD_PID));
      writeFileSync(`${lockPath}.takeover`, `${DEAD_PID} ${Date.now()}`);
      // The first attempt clears the abandoned ticket; the next takes the stale lock.
      const release = tryAcquireCrossProcessLock(lockPath) ?? tryAcquireCrossProcessLock(lockPath);
      expect(release).not.toBeNull();
      release?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a takeover ticket of a live process is left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcp-ticket-live-'));
    try {
      const lockPath = join(dir, 'lock');
      writeFileSync(lockPath, lockBody(DEAD_PID));
      writeFileSync(`${lockPath}.takeover`, `${process.pid} ${Date.now()}`);
      expect(tryAcquireCrossProcessLock(lockPath)).toBeNull();
      expect(tryAcquireCrossProcessLock(lockPath)).toBeNull();
      expect(existsSync(`${lockPath}.takeover`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
