import { expect, test } from 'bun:test';
import { discardCapturedProjection, type ProjectionCleanupOps } from '../platform/src/platform/tools/exec/captured-exec-cleanup.ts';

test('a failure restoring directory access neither throws nor skips removing the projection', async () => {
  const removed: string[] = [];
  const ops: ProjectionCleanupOps = {
    lstat: (async () => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o000 })) as unknown as ProjectionCleanupOps['lstat'],
    chmod: (async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); }) as ProjectionCleanupOps['chmod'],
    readdir: async () => [],
    rm: (async (path: string) => { removed.push(path); }) as unknown as ProjectionCleanupOps['rm'],
  };
  await discardCapturedProjection('/tmp/projection-x', ops);
  expect(removed).toEqual(['/tmp/projection-x']);
});

test('a failing removal is swallowed so the command result is kept', async () => {
  const ops: ProjectionCleanupOps = {
    lstat: (async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }) as unknown as ProjectionCleanupOps['lstat'],
    chmod: (async () => {}) as ProjectionCleanupOps['chmod'],
    readdir: async () => [],
    rm: (async () => { throw new Error('busy'); }) as unknown as ProjectionCleanupOps['rm'],
  };
  await expect(discardCapturedProjection('/tmp/projection-y', ops)).resolves.toBeUndefined();
});
