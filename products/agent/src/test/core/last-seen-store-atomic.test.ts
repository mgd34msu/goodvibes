import { describe, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { LastSeenStore, lastSeenStorePath } from '../../core/last-seen-store.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('LastSeenStore.save', () => {
  // A permission-denied directory cannot be simulated for a user who bypasses permissions.
  const privileged = typeof process.getuid === 'function' && process.getuid() === 0;

  test('a save that cannot complete leaves the previous timestamp readable', () => {
    if (privileged) return;
    const root = makeProjectTempDir('goodvibes-last-seen-atomic');
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const store = LastSeenStore.fromShellPaths(paths);
    store.save(1_700_000_000_000);
    const dir = dirname(lastSeenStorePath(paths));
    chmodSync(dir, 0o500);
    try {
      store.save(1_800_000_000_000);
      expect(store.read()).toBe(1_700_000_000_000);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
