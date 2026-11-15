/**
 * session-changes.ts
 *
 * Pure computation for `WorkspaceCheckpointManager.sessionChanges`, the
 * aggregate file changes a single session made, joined over its
 * sessionId-stamped checkpoints. Split out of manager.ts (at the 800-line cap)
 * as a self-contained helper; the manager calls it while holding its index
 * lock, so the caller, not this function, is responsible for serialization.
 */

import type { SideGitRunner } from './side-git.js';
import type { WorkspaceCheckpoint, CheckpointSessionChanges } from './types.js';

/**
 * Compute a session's aggregate change: the net diff from the state BEFORE the
 * session's earliest checkpoint (that checkpoint's parent) to the session's
 * LATEST checkpoint. When that parent is not known (the earliest checkpoint has
 * none, or retention removed it) the diff starts at the earliest checkpoint
 * itself and `baseUnavailable` says so. A session with no stamped checkpoints
 * yields `checkpointCount: 0` with an empty diff (from/to === 'EMPTY'), an
 * honest "nothing recorded", never an error.
 */
export async function computeSessionChanges(
  checkpoints: ReadonlyMap<string, WorkspaceCheckpoint>,
  sideGit: SideGitRunner,
  sessionId: string,
): Promise<CheckpointSessionChanges> {
  // Oldest-first, so [0] is the session's first change and [last] its latest.
  const sessionCheckpoints = Array.from(checkpoints.values())
    .filter((c) => c.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (sessionCheckpoints.length === 0) {
    return { sessionId, checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY', files: [], unifiedDiff: '', stat: '' };
  }

  const earliest = sessionCheckpoints[0]!;
  const latest = sessionCheckpoints[sessionCheckpoints.length - 1]!;
  // The state before the session's first change is that checkpoint's parent.
  // Without one (no snapshot preceded it, or retention removed it) the state
  // before is unknown: the empty tree would report every file in the workspace
  // as this session's work, so the diff starts at the earliest checkpoint and
  // says so.
  const parent = earliest.parentId ? checkpoints.get(earliest.parentId) : undefined;
  const baseUnavailable = !parent;
  const baseCommit = parent ? parent.commit : earliest.commit;
  const fromLabel = parent ? parent.id : earliest.id;
  const [unifiedDiff, stat_, files] = await Promise.all([
    sideGit.diff(baseCommit, latest.commit),
    sideGit.diffStat(baseCommit, latest.commit),
    sideGit.diffNameOnly(baseCommit, latest.commit),
  ]);

  return {
    sessionId,
    checkpointCount: sessionCheckpoints.length,
    checkpointIds: sessionCheckpoints.map((c) => c.id),
    from: fromLabel,
    ...(baseUnavailable ? { baseUnavailable: true } : {}),
    // A checkpoint holds the whole workspace as it was when the snapshot ran, so
    // edits by another session, an agent or the user (with or without a
    // checkpoint of their own) land in this diff and nothing recorded tells
    // them apart: every result with checkpoints carries the flag.
    attributionApproximate: true,
    to: latest.id,
    files,
    unifiedDiff,
    stat: stat_,
  };
}
