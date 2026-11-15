/**
 * pruner.ts
 *
 * Deletes the side-repo refs of checkpoints that retention dropped. The
 * manager removes the records from its index and saves it first, then calls
 * this; a ref that could not be deleted is left unlisted, and the next sweep's
 * unlisted-ref pass deletes it. Object reclamation is a single
 * `git gc --prune=now` run afterwards by `WorkspaceCheckpointManager.gc()`.
 */

import { summarizeError } from '../../utils/error-display.js';
import { SideGitRunner, CHECKPOINT_REF_PREFIX } from './side-git.js';

/** What one retention sweep did. */
export interface CheckpointPruneResult {
  /** Checkpoints whose records and refs are gone. */
  readonly deletedIds: readonly string[];
  /** Checkpoints whose records are gone but whose ref could not be deleted yet. */
  readonly failedIds: readonly string[];
  /** The deletion error for each failed id. */
  readonly errors: Readonly<Record<string, string>>;
}

export async function deleteCheckpointRefs(sideGit: SideGitRunner, ids: readonly string[]): Promise<CheckpointPruneResult> {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  const errors: Record<string, string> = {};
  for (const id of ids) {
    try {
      await sideGit.deleteRef(`${CHECKPOINT_REF_PREFIX}${id}`);
      deletedIds.push(id);
    } catch (err) {
      failedIds.push(id);
      errors[id] = summarizeError(err);
    }
  }
  return { deletedIds, failedIds, errors };
}
