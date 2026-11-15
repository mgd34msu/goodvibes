/**
 * Retained wake clips are reaped for sessions that are gone, judged against the
 * live sessions as of each sweep and in the form clip names carry.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainedClipFileName, startWakeRecoverySweeper } from '../platform/src/platform/voice/wake/recovery.js';
import { resolveManagedWakePaths } from '../platform/src/platform/voice/wake/provisioning.js';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gv-wake-retained-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function clip(sessionId: string): string {
  const paths = resolveManagedWakePaths(root);
  mkdirSync(paths.retainedDir, { recursive: true });
  const path = join(paths.retainedDir, retainedClipFileName(sessionId, Date.now()));
  writeFileSync(path, Buffer.alloc(16));
  return path;
}

describe('orphaned retained clips', () => {
  test('a session started after the sweeper began is live at the next sweep', () => {
    const live = ['first'];
    const sweeper = startWakeRecoverySweeper({ managedRoot: root, liveSessionIds: () => live, intervalMs: 3_600_000 });
    try {
      live.push('second');
      const later = clip('second');
      sweeper.sweepNow();
      expect(existsSync(later)).toBe(true);
    } finally {
      sweeper.stop();
    }
  });

  test('a session id with characters a file name cannot hold still matches its clips', () => {
    const kept = clip('agent:session/1');
    const orphan = clip('gone:session');
    const sweeper = startWakeRecoverySweeper({ managedRoot: root, liveSessionIds: () => ['agent:session/1'], intervalMs: 3_600_000 });
    try {
      expect(existsSync(kept)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      sweeper.stop();
    }
  });

  test('a live list that cannot be read reaps nothing as an orphan', () => {
    const path = clip('some-session');
    const sweeper = startWakeRecoverySweeper({
      managedRoot: root,
      liveSessionIds: () => { throw new Error('session registry unavailable'); },
      intervalMs: 3_600_000,
    });
    try {
      expect(existsSync(path)).toBe(true);
    } finally {
      sweeper.stop();
    }
  });
});
