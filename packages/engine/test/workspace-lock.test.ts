import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWorkspaceLock } from '../scripts/workspace-lock.ts';

function scratch(): { readonly root: string; readonly lock: string } {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lock-'));
  return { root, lock: join(root, 'build.lock') };
}

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  return Bun.spawnSync(['true']).pid;
}

describe('withWorkspaceLock', () => {
  test('takes over a lock whose owner is dead and leaves nothing behind', async () => {
    const { root, lock } = scratch();
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(deadPid()));
      const seen = await withWorkspaceLock('test', () => readFileSync(join(lock, 'pid'), 'utf8'), 5_000, lock);
      expect(seen).toBe(String(process.pid));
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('never runs two holders at once when several waiters find the same dead lock', async () => {
    const { root, lock } = scratch();
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(deadPid()));
      let inside = 0;
      let overlapped = false;
      const hold = async (): Promise<void> => {
        inside += 1;
        if (inside > 1) overlapped = true;
        await Promise.resolve();
        inside -= 1;
      };
      await Promise.all([1, 2, 3].map(() => withWorkspaceLock('test', hold, 10_000, lock)));
      expect(overlapped).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('does not remove a lock that a takeover has handed to another owner', async () => {
    const { root, lock } = scratch();
    try {
      await withWorkspaceLock('test', () => {
        // While this holder runs, the lock is taken over (it was judged stale) by a live owner.
        writeFileSync(join(lock, 'pid'), String(process.ppid));
      }, 5_000, lock);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.ppid));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('removes its own lock when the work throws', async () => {
    const { root, lock } = scratch();
    try {
      await expect(withWorkspaceLock('test', () => { throw new Error('boom'); }, 5_000, lock)).rejects.toThrow('boom');
      expect(existsSync(lock)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
