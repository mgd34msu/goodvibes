/**
 * restore.ts
 *
 * The file-writing half of `WorkspaceCheckpointManager.restore()`, split out of
 * manager.ts (at its line cap). The manager takes the lock, resolves the target
 * and the safety checkpoint, then calls this while still holding the lock.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { literalPathspec, type SideGitRunner } from './side-git.js';
import type { WorkspaceCheckpoint, RestoreResult } from './types.js';

/**
 * Apply `target` to the workspace. With `paths`, only those paths are checked
 * out and nothing is removed; otherwise the whole tree is restored and every
 * file in `beforeFiles` that the target lacks is removed. A path that could not
 * be applied is reported in `failedPaths` (present only when something failed), never silently dropped from the result.
 */
export async function applyRestore(
  sideGit: SideGitRunner,
  workspaceRoot: string,
  target: WorkspaceCheckpoint,
  safetyCheckpointId: string | null,
  beforeFiles: string[],
  paths: readonly string[] | undefined,
): Promise<RestoreResult> {
  const id = target.id;
  const failedPaths: { path: string; reason: string }[] = [];
  if (paths) {
    const restoredFiles: string[] = [];
    for (const path of paths) {
      try {
        await sideGit.raw(['checkout', target.commit, '--', literalPathspec(path)]);
        restoredFiles.push(path);
      } catch (err) {
        logger.warn('WorkspaceCheckpointManager.restore: scoped path checkout failed', { id, path, error: summarizeError(err) });
        failedPaths.push({ path, reason: summarizeError(err) });
      }
    }
    return { checkpointId: id, safetyCheckpointId, restoredFiles, removedFiles: [], ...(failedPaths.length > 0 ? { failedPaths } : {}) };
  }

  const targetFiles = await sideGit.listTrackedFiles(target.commit);
  const targetFileSet = new Set(targetFiles);
  const toRemove = beforeFiles.filter((path) => !targetFileSet.has(path));

  await sideGit.readTreeReset(target.commit);
  await sideGit.checkoutIndexAll();

  const removedFiles: string[] = [];
  for (const path of toRemove) {
    try {
      rmSync(join(workspaceRoot, path), { force: true });
      removedFiles.push(path);
    } catch (err) {
      logger.warn('WorkspaceCheckpointManager.restore: failed to remove file added after checkpoint', { id, path, error: summarizeError(err) });
      failedPaths.push({ path, reason: summarizeError(err) });
    }
  }

  logger.debug('WorkspaceCheckpointManager.restore: restored', { id, safetyCheckpointId, restoredCount: targetFiles.length, removedCount: removedFiles.length });
  return { checkpointId: id, safetyCheckpointId, restoredFiles: targetFiles, removedFiles, ...(failedPaths.length > 0 ? { failedPaths } : {}) };
}
