/**
 * workspace/registration/checkpoint-eligibility.ts
 *
 * Whether automatic checkpoints may run in a directory, read synchronously from
 * the shared register through the store's own parser, so every product and the
 * `workspaces.*` verbs agree on what the register says. Only rows registered
 * for checkpoints (`checkpointEligible === true`) count; worktree-link
 * inheritance still applies. An unreadable register is reported as unreadable,
 * with its reason, never as "not registered".
 */

import { resolveWorkspaceRegistration } from './resolution.js';
import { readWorkspaceRegisterSync } from './store.js';
import type { WorkspaceGitMetadata, WorkspaceResolution } from './types.js';
import { probeWorktreeLink } from './worktree-link.js';

export type CheckpointEligibility =
  | { readonly state: 'readable'; readonly resolution: WorkspaceResolution }
  | { readonly state: 'unreadable'; readonly reason: string };

/** One read of the register at `registerPath`, resolved for `path`. `git` defaults to a real worktree-link probe. */
export function readCheckpointEligibilitySync(registerPath: string, path: string, git?: WorkspaceGitMetadata): CheckpointEligibility {
  const read = readWorkspaceRegisterSync(registerPath);
  if (read.state === 'unreadable') return { state: 'unreadable', reason: read.reason };
  const rows = read.state === 'ok' ? read : { workspaces: [], declines: [] };
  return {
    state: 'readable',
    resolution: resolveWorkspaceRegistration({
      path,
      git: git ?? probeWorktreeLink(path),
      registrations: rows.workspaces.filter((row) => row.checkpointEligible === true),
      declines: rows.declines,
    }),
  };
}

/**
 * A repeatable checker for one fixed directory. The git worktree probe (a
 * subprocess) runs once here; each call is one small file read, cheap enough
 * for every turn and agent-run event, so registering a workspace takes effect
 * at the next event. `registerPath` is asked each call because the register can
 * move from its pre-split location to the shared tier while the process runs.
 */
export function createCheckpointEligibilityChecker(registerPath: () => string, path: string): () => CheckpointEligibility {
  const git = probeWorktreeLink(path);
  return () => readCheckpointEligibilitySync(registerPath(), path, git);
}

/** The sentence a refused explicit checkpoint shows, naming the actual state. */
export function checkpointEligibilityRefusal(eligibility: CheckpointEligibility, workspaceRoot: string): string {
  if (eligibility.state === 'unreadable') {
    return `Checkpoints are off for this workspace: the workspace register cannot be read (${eligibility.reason}). `
      + 'Repair the register in ~/.goodvibes/shared, then retry (or set checkpoints.unregisteredWorkspaces to "guarded" '
      + 'to opt this workspace out of the registration gate).';
  }
  const declined = eligibility.resolution.status === 'declined' && eligibility.resolution.declinedRoot
    ? ` (registration was declined at ${eligibility.resolution.declinedRoot})` : '';
  return `Checkpoints are off for this workspace: ${workspaceRoot} is not registered for checkpoints${declined}. `
    + 'Register it first, then retry (or set checkpoints.unregisteredWorkspaces to "guarded" '
    + 'to opt this workspace out of the registration gate).';
}
