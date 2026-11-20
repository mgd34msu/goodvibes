import { sharedWorkspaceRegisterPath } from '@goodvibes/engine/platform/platform/workspace';
import type { ShellPathService } from '../index.js';
import {
  createCheckpointEligibilityChecker,
  readCheckpointEligibilitySync,
  readWorkspaceRegisterSync,
  type CheckpointEligibility,
  type DeclinedWorkspaceRecord,
  type RegisteredWorkspaceRecord,
  type WorkspaceGitMetadata,
  type WorkspaceResolution,
} from '@goodvibes/engine/platform/platform/workspace';

/**
 * Checkpoint eligibility, read live off the shared workspace-registration store.
 *
 * The daemon takes automatic checkpoints on turn and agent-run lifecycle events.
 * Which workspaces that is allowed to happen in is the owner's registered-
 * workspaces-only ruling: only a workspace that was EXPLICITLY registered for
 * checkpoints (`checkpointEligible`) qualifies, and a directory somebody merely
 * opened in a surface never silently becomes checkpoint-eligible.
 *
 * This read is synchronous by design. The decision is made per lifecycle event,
 * inside a subscription callback that cannot await, and it has to reflect the
 * store as it is on disk RIGHT NOW, registering a workspace while the daemon is
 * running has to take effect on the next eligible event, not on the next
 * restart. The platform's resolver is pure, so the only I/O is one small JSON read
 * plus a single git worktree probe amortized at construction. The register is
 * parsed by the platform store's own reader, so this gate and the workspaces.*
 * verbs always agree on what it says.
 */

export type StoreShellPaths = Pick<ShellPathService, 'resolveUserPath' | 'homeDirectory'>;

/**
 * Path of the shared store's JSON document, the same path the platform's gateway
 * verb group constructs its own store over.
 *
 * "The same path" is the whole contract, and it is why this goes through the
 * platform's resolver rather than spelling any location out. goodvibes-agent reads
 * and writes this same file directly and the platform's gateway writes it, so the
 * register is cross-product state rather than the daemon's own, it lives in
 * the shared tier (~/.goodvibes/shared/), which takes no surface root, so all
 * three resolve one identical path.
 */
export function sharedWorkspaceRegistrationStorePath(shellPaths: StoreShellPaths): string {
  return sharedWorkspaceRegisterPath(shellPaths);
}

/**
 * The shared register's coverage rows, through the store's own parser (legacy
 * v1 or native v2). A missing register is empty; an unreadable one is reported
 * by {@link resolveCheckpointEligibility} rather than read as empty here.
 */
export function readSharedWorkspaceRegistrationSnapshotSync(shellPaths: StoreShellPaths): {
  readonly workspaces: readonly RegisteredWorkspaceRecord[];
  readonly declines: readonly DeclinedWorkspaceRecord[];
} {
  const read = readWorkspaceRegisterSync(sharedWorkspaceRegistrationStorePath(shellPaths));
  return read.state === 'ok' ? { workspaces: read.workspaces, declines: read.declines } : { workspaces: [], declines: [] };
}

/** Checkpoint eligibility of `path`, or the reason the register cannot be read. */
export function resolveCheckpointEligibility(shellPaths: StoreShellPaths, path: string, git?: WorkspaceGitMetadata): CheckpointEligibility {
  return readCheckpointEligibilitySync(sharedWorkspaceRegistrationStorePath(shellPaths), path, git);
}

/**
 * Resolve `path` against ONLY the checkpoint-eligible registrations. An
 * unreadable register resolves as not covered; callers that must say why use
 * {@link resolveCheckpointEligibility}.
 */
export function resolveCheckpointEligibilitySync(
  shellPaths: StoreShellPaths,
  path: string,
  git?: WorkspaceGitMetadata,
): WorkspaceResolution {
  const eligibility = resolveCheckpointEligibility(shellPaths, path, git);
  return eligibility.state === 'readable' ? eligibility.resolution : {
    path, status: 'unknown', coveredBy: null, declinedRoot: null, viaWorktreeLink: false,
    reason: `the workspace register cannot be read: ${eligibility.reason}`,
  };
}

/**
 * A cheap, repeatable live checkpoint-eligibility checker for one fixed
 * workspace root: the git worktree probe runs once, each call re-reads the
 * shared register, cheap enough for every turn and agent-run event.
 */
export function createWorkspaceRegistrationLiveChecker(
  shellPaths: StoreShellPaths,
  path: string,
): () => CheckpointEligibility {
  return createCheckpointEligibilityChecker(() => sharedWorkspaceRegistrationStorePath(shellPaths), path);
}
