import type { ShellPathService } from '@/runtime/index.ts';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { openWorkspaceRegistrationStore, readWorkspaceRegisterSync } from '@goodvibes/engine/platform/platform/workspace/registration/store';
import { readCheckpointEligibilitySync, createCheckpointEligibilityChecker } from '@goodvibes/engine/platform/platform/workspace/registration/checkpoint-eligibility';
import { broadRootReason } from '@goodvibes/engine/platform/platform/workspace/checkpoint/root-guard';
import { resolveWorkspaceRegistration, normalizeWorkspaceRoot } from '@goodvibes/engine/platform/platform/workspace/registration/resolution';
import { probeWorktreeLink } from '@goodvibes/engine/platform/platform/workspace/registration/worktree-link';
import type { WorkspaceRegistrationStore, CheckpointEligibility, RegisterWorkspaceResult, RegisteredWorkspaceRecord, DeclinedWorkspaceRecord, WorkspaceGitMetadata, WorkspaceResolution } from '@goodvibes/engine/platform/platform/workspace';
import { sharedWorkspaceRegisterPath } from '@goodvibes/engine/platform/platform/workspace/registration/shared-register-path';

export { normalizeWorkspaceRoot } from '@goodvibes/engine/platform/platform/workspace/registration/resolution';
export type {
  DeclinedWorkspaceRecord,
  RegisteredWorkspaceRecord,
  WorkspaceCoverageStatus,
  WorkspaceResolution,
} from '@goodvibes/engine/platform/platform/workspace';

/**
 * CHECKPOINT-ELIGIBILITY BOUNDARY (owner ruling: the checkpoint boundary stays
 * EXPLICIT, never silently widened).
 *
 * The shared registration store is ONE file the whole platform reads and writes
 * (~/.goodvibes/control-plane/workspace-registrations.json). The TUI's first-open
 * self-recording writes a plain {@link RegisteredWorkspaceRecord} to it for any
 * directory a user merely opens, so "registered in the store" can no longer mean
 * "the owner opted this workspace into automatic checkpoints". The agent's
 * checkpoint boundary must therefore consume ONLY records the owner EXPLICITLY
 * registered for checkpoints, marked by `checkpointEligible === true`.
 *
 * The platform record schema natively carries both fields (typed on
 * {@link RegisteredWorkspaceRecord}): `origin`, which flow wrote/stamped the
 * record, provenance only, and `checkpointEligible`, where ABSENT MEANS FALSE.
 * The store's `add` stamps/upgrades them typed, and absent options never strip
 * an existing stamp, so one surface's plain self-recording cannot demote
 * another consumer's eligibility.
 */
export const AGENT_EXPLICIT_REGISTRATION_ORIGIN = 'agent-explicit-registration';

/**
 * Shared registered-workspace registry (platform/workspace/registration).
 *
 * WHY A SYNCHRONOUS RESOLVER EXISTS ALONGSIDE THE ASYNC STORE. The platform's
 * WorkspaceRegistrationStore is Promise-based (it persists through
 * PersistentStore). createRuntimeServices() (../runtime/services.ts) is
 * synchronous by design, every consumer (the CLI, the TUI bootstrap, every
 * test file) calls it synchronously, and the automatic-checkpoint decision
 * (whether to pass runtimeBus to WorkspaceCheckpointManager) must be made AT
 * construction time, not after an async read resolves later. So this module
 * also ships a synchronous snapshot read + the platform's PURE resolver
 * (resolveWorkspaceRegistration, no disk/git I/O) for that one call site;
 * every other consumer (the workspaces CLI, a future interactive prompt) goes
 * through the real async store below, the single source of truth for writes.
 * Both read the exact same on-disk file, so there is only ever one registry.
 */

export type StoreShellPaths = Pick<ShellPathService, 'resolveUserPath' | 'homeDirectory'>;

/**
 * Path of the shared store's JSON document, the SAME file the platform's
 * registerGatewayVerbGroups writes and the daemon reads for checkpoint
 * eligibility.
 *
 * It lives in the platform's shared tier (~/.goodvibes/shared/), which takes no
 * surface root, precisely because three products share it: scoping it per
 * surface would give this agent its own register, and workspaces registered
 * here would vanish from the daemon while the daemon's vanished from here.
 */
export function sharedWorkspaceRegistrationStorePath(shellPaths: StoreShellPaths): string {
  return sharedWorkspaceRegisterPath(shellPaths);
}

/** This process's store over the shared file, for callers that can go async (CLI commands, interactive prompts). */
export function createWorkspaceRegistrationStore(shellPaths: StoreShellPaths): WorkspaceRegistrationStore {
  return openWorkspaceRegistrationStore({
    path: sharedWorkspaceRegisterPath(shellPaths),
    homeDir: shellPaths.homeDirectory,
    daemonStateDir: shellPaths.resolveUserPath(),
  });
}

/**
 * Synchronous read of the shared store's coverage rows, through the store's
 * own parser (v1 rows normalized, or native v2). This is not a native authority
 * reader; only WorkspaceRegistrationStore.currentScope can establish that. A
 * missing or unreadable file reads as empty here; the checkpoint gate reads the
 * unreadable case itself (resolveCheckpointEligibility) so it can say so.
 */
export function readSharedWorkspaceRegistrationSnapshotSync(shellPaths: StoreShellPaths): {
  readonly workspaces: readonly RegisteredWorkspaceRecord[];
  readonly declines: readonly DeclinedWorkspaceRecord[];
} {
  const read = readWorkspaceRegisterSync(sharedWorkspaceRegistrationStorePath(shellPaths));
  return read.state === 'ok' ? { workspaces: read.workspaces, declines: read.declines } : { workspaces: [], declines: [] };
}

/**
 * Resolve `path` against the shared registration store SYNCHRONOUSLY: a direct
 * on-disk read plus the platform's pure resolveWorkspaceRegistration. `git` defaults
 * to a real worktree-link probe (probeWorktreeLink spawns `git`), so a linked
 * orchestration worktree of a registered repo resolves as covered without any
 * extra wiring, the worktree-link inheritance the shared store provides.
 * Callers that already have git metadata (or want to avoid the spawn, e.g. in
 * a pure unit test) can pass it explicitly.
 */
export function resolveWorkspaceRegistrationSync(
  shellPaths: StoreShellPaths,
  path: string,
  git?: WorkspaceGitMetadata,
): WorkspaceResolution {
  const snapshot = readSharedWorkspaceRegistrationSnapshotSync(shellPaths);
  const gitMeta = git ?? probeWorktreeLink(path);
  return resolveWorkspaceRegistration({
    path,
    git: gitMeta,
    registrations: snapshot.workspaces,
    declines: snapshot.declines,
  });
}

/**
 * Resolve `path` against ONLY the checkpoint-eligible registrations, the
 * boundary the automatic/explicit checkpoint gate consumes. Identical to
 * {@link resolveWorkspaceRegistrationSync} except the registrations are filtered
 * to `checkpointEligible === true` first, so a plain TUI self-record (registered
 * in the shared store, but never explicitly opted into checkpoints) resolves as
 * NOT covered here even though the general resolver reports it registered.
 * Worktree-link inheritance still applies: a linked worktree of a checkpoint-
 * eligible main repo resolves covered.
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

/** Checkpoint eligibility of `path`, or the reason the register cannot be read (the platform's shared reader). */
export function resolveCheckpointEligibility(shellPaths: StoreShellPaths, path: string, git?: WorkspaceGitMetadata): CheckpointEligibility {
  return readCheckpointEligibilitySync(sharedWorkspaceRegistrationStorePath(shellPaths), path, git);
}

/**
 * Build a cheap, repeatable live checkpoint-eligibility checker for one fixed
 * workspace root. `probeWorktreeLink` (a `git` subprocess spawn) runs ONCE here,
 * since a long-running process's working directory and its git-worktree
 * relationship do not change mid-launch; every subsequent call only re-reads the
 * shared registration JSON file (a small synchronous fs read), cheap enough to
 * call on every turn/agent-lifecycle event, unlike calling
 * `resolveCheckpointEligibilitySync` directly (which re-probes git every time).
 *
 * This is what makes registering a workspace mid-launch (an explicit
 * `goodvibes-agent workspaces register` that stamps `checkpointEligible`) take
 * effect on the very next automatic-checkpoint-eligible event in an
 * already-running process, without a restart: a caller that re-runs the returned
 * function on each event always reads current on-disk state. It consumes ONLY
 * checkpoint-eligible records, so a directory a TUI user merely opened never
 * silently becomes checkpoint-eligible to the agent.
 */
export function createWorkspaceRegistrationLiveChecker(
  shellPaths: StoreShellPaths,
  path: string,
): () => CheckpointEligibility {
  return createCheckpointEligibilityChecker(() => sharedWorkspaceRegistrationStorePath(shellPaths), path);
}

/**
 * The agent's EXPLICIT checkpoint-registration path: one typed store `add` that
 * registers `root` (the platform's own root-guarded write) AND stamps it
 * `checkpointEligible: true` with the agent-explicit origin, the store's `add`
 * carries both fields natively, upgrading an already-present record's stamp in
 * the same call. This is the ONLY way a record becomes checkpoint-eligible at
 * write time, a plain platform `add` (the TUI's first-open self-recording) never
 * sets the flag, so opening a directory in the TUI cannot widen the agent's
 * checkpoint boundary. Returns the platform's register result unchanged so callers
 * keep their existing messaging.
 */
export async function registerWorkspaceForCheckpoints(
  shellPaths: StoreShellPaths,
  root: string,
  opts?: { readonly label?: string },
): Promise<RegisterWorkspaceResult> {
  const store = createWorkspaceRegistrationStore(shellPaths);
  return await store.add(root, {
    ...(opts?.label ? { label: opts.label } : {}),
    origin: AGENT_EXPLICIT_REGISTRATION_ORIGIN,
    checkpointEligible: true,
  });
}

// ---------------------------------------------------------------------------
// First-start registration prompt support
// ---------------------------------------------------------------------------

/**
 * Would the shared store refuse to register `root` as too broad? The store's
 * own rule, asked before OFFERING registration in the first-start prompt; the
 * store's add() remains the guard at write time.
 */
export function isBroadWorkspaceRoot(shellPaths: StoreShellPaths, root: string): boolean {
  return broadRootReason(root, shellPaths.homeDirectory, shellPaths.resolveUserPath()) !== null;
}

/** What answering the first-start question actually did. */
export type WorkspaceRegistrationAnswer =
  | { readonly outcome: 'registered' }
  | { readonly outcome: 'declined' }
  /** The store refused or could not write; `reason` is its own message. */
  | { readonly outcome: 'not-saved'; readonly reason: string };

/**
 * Resolve a first-start registration prompt's answer against the shared
 * store, and say what happened: registered, declined, or not saved with the
 * store's reason (a root it refuses, a locked or unwritable register). Never
 * rejects.
 */
export function answerWorkspaceRegistrationPrompt(shellPaths: StoreShellPaths, root: string, accepted: boolean): Promise<WorkspaceRegistrationAnswer> {
  // Accepting the first-start prompt is an EXPLICIT owner opt-in, so it goes
  // through registerWorkspaceForCheckpoints (registers AND stamps eligibility),
  // not a plain store.add, which would register without making the workspace
  // checkpoint-eligible. Declining stays a plain decline.
  const outcome: Promise<unknown> = accepted
    ? registerWorkspaceForCheckpoints(shellPaths, root)
    : createWorkspaceRegistrationStore(shellPaths).decline(root);
  return outcome.then(
    (): WorkspaceRegistrationAnswer => (accepted ? { outcome: 'registered' } : { outcome: 'declined' }),
    (error: unknown): WorkspaceRegistrationAnswer => {
      logger.error('Failed to persist workspace registration prompt answer', { root, accepted, error: summarizeError(error) });
      return { outcome: 'not-saved', reason: summarizeError(error) };
    },
  );
}
