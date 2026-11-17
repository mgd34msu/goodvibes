/**
 * The process lock is what keeps two processes from writing one store at once,
 * and a holder that is killed must not leave the store locked.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProcessLockBusyError,
  holdProcessLock,
  withProcessLock,
  withProcessLockSync,
} from '../platform/src/platform/utils/process-lock.js';

const MODULE = join(import.meta.dir, '..', 'platform', 'src', 'platform', 'utils', 'process-lock.ts');
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-process-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Start another process that holds the lock until it is killed; resolves once it reports holding it. */
async function holdInChild(dir: string, lockPath: string) {
  const script = join(dir, 'holder.ts');
  writeFileSync(script, [
    `import { holdProcessLock } from ${JSON.stringify(MODULE)};`,
    'const lock = holdProcessLock(process.argv[2]!);',
    "console.log(lock ? 'held' : 'busy');",
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  const child = Bun.spawn(['bun', script, lockPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value).trim()).toBe('held');
  return child;
}

describe('process lock', () => {
  test('another process cannot take a held lock, and a killed holder releases it', async () => {
    const dir = tempDir();
    const lockPath = join(dir, 'store.json.writer.sqlite');
    const child = await holdInChild(dir, lockPath);
    try {
      expect(holdProcessLock(lockPath)).toBeNull();
      await expect(withProcessLock(lockPath, () => 'never', { waitMs: 0 })).rejects.toMatchObject({ code: 'PROCESS_LOCK_BUSY', heldBy: 'another-process' });
      expect(() => withProcessLockSync(lockPath, () => 'never', { waitMs: 0 })).toThrow(ProcessLockBusyError);

      const waiting = withProcessLock(lockPath, () => 'ran after the holder died');
      child.kill('SIGKILL');
      await child.exited;
      expect(await waiting).toBe('ran after the holder died');
    } finally {
      child.kill('SIGKILL');
    }
    const lock = holdProcessLock(lockPath);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test('holders in one process run one at a time, in the order they asked', async () => {
    const lockPath = join(tempDir(), 'store.json.writer.sqlite');
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withProcessLock(lockPath, async () => { order.push('first:start'); await gate; order.push('first:end'); });
    const second = withProcessLock(lockPath, () => { order.push('second'); });
    const third = withProcessLock(lockPath, () => { order.push('third'); });
    await Promise.resolve();
    expect(() => withProcessLockSync(lockPath, () => 'never')).toThrow(ProcessLockBusyError);
    expect(holdProcessLock(lockPath)).toBeNull();
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });
});
