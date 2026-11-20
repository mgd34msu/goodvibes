/**
 * workspace/registration/types.ts
 *
 * Shared shapes for the daemon-side registered-workspace registry: the roots an
 * operator has explicitly opted into (coverage flows DOWN each root's subtree),
 * the subtree-scoped declined prompts remembered at the root that was asked, and
 * the result of resolving a path against them.
 *
 * RECORD-SHAPE COMPATIBILITY. `RegisteredWorkspaceRecord` is deliberately
 * field-identical to the agent fork's local registry record
 * (goodvibes-agent/src/config/workspace-registry.ts): `{ root, registeredAt,
 * label? }`. That fork keeps a per-user JSON file the platform's automatic
 * checkpoints gate on; this store is the platform-wide successor the whole
 * platform reads, and the shared record shape lets the fork's file migrate in
 * (its `workspaces` array drops straight into this store's `workspaces`).
 */

import { refusal, type Refusal } from '@goodvibes/engine/errors';

/** An explicitly registered workspace root. Field-compatible with the agent registry record. */
export interface RegisteredWorkspaceRecord {
  /** Normalized absolute path (see normalizeWorkspaceRoot): coverage flows DOWN this subtree. */
  readonly root: string;
  /** ISO-8601 timestamp of when this root was registered. */
  readonly registeredAt: string;
  /** Optional human label. */
  readonly label?: string;
  /**
   * Which surface/flow wrote this record (e.g. a TUI self-recording, an
   * operator verb, an agent boot stamp). Absent on records written before
   * provenance existed, honest absence, never back-filled.
   */
  readonly origin?: string;
  /**
   * Whether this root is in scope for the automatic checkpoint boundary.
   * ABSENT MEANS FALSE: one surface's self-recording must never silently
   * widen another consumer's checkpoint scope. Existing records (including
   * those migrated from the agent's explicit list, which are not
   * distinguishable after the fact) default to not-eligible; the consumer
   * that owns checkpointing re-stamps its own roots on boot.
   */
  readonly checkpointEligible?: boolean;
  /** Prospective native authority, minted only by a new registration event. Never inferred for legacy rows. */
  readonly nativeScope?: {
    readonly id: string;
    readonly canonicalRoot: string;
    readonly generation: number;
  };
}

/** A host-owned current scope reference. Data alone is not an execution capability. */
export interface NativeWorkspaceScope {
  /** Canonical directory whose direct registration coverage was checked. */
  readonly root: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
}

/**
 * Why native work cannot use a workspace scope, each with its own way out:
 * register the workspace, clear a decline, repair the register, use an existing
 * directory, register again to grant a native scope, start the step again, or
 * simply retry.
 */
export type NativeWorkspaceScopeReason =
  | 'not-registered' | 'declined' | 'registry-unreadable' | 'root-missing' | 'unmigrated' | 'changed' | 'retry';

export class NativeWorkspaceScopeError extends Error {
  readonly reason: NativeWorkspaceScopeReason;
  /** The same facts in the shared refusal shape (`readRefusal` finds it). */
  readonly refusal: Refusal;
  readonly retryable: boolean;
  constructor(
    readonly code: 'unavailable' | 'unmigrated' | 'changed' | 'callback',
    detail: { readonly reason: NativeWorkspaceScopeReason; readonly state: string; readonly next: readonly string[] } = {
      reason: code === 'unmigrated' ? 'unmigrated' : code === 'unavailable' ? 'registry-unreadable' : 'changed',
      state: `native workspace scope ${code}`, next: [],
    },
  ) {
    super(`Native workspace scope: ${code} (${detail.reason}): ${detail.state}.${detail.next[0] ? ` ${detail.next[0]}` : ''}`);
    this.name = 'NativeWorkspaceScopeError';
    this.reason = detail.reason;
    this.retryable = detail.reason === 'retry' || detail.reason === 'changed';
    this.refusal = refusal({
      code: `WORKSPACE_SCOPE_${detail.reason.toUpperCase().replace(/-/g, '_')}`,
      state: detail.state,
      reason: 'Native work cannot run in this workspace',
      next: detail.next,
      retryable: this.retryable,
      status: detail.reason === 'retry' || detail.reason === 'changed' ? 409 : detail.reason === 'registry-unreadable' ? 500 : 403,
    });
  }
}

/**
 * A remembered "no" to a registration prompt, scoped to the subtree of the root
 * that was asked. A path under a declined root resolves to `declined` (rather
 * than re-prompting `unknown`) unless a nearer registered root covers it.
 */
export interface DeclinedWorkspaceRecord {
  /** Normalized absolute path of the root the prompt was asked at. */
  readonly root: string;
  /** ISO-8601 timestamp of when the prompt was declined. */
  readonly declinedAt: string;
}

/**
 * The owner's trust decision for one directory, kept in the user's own register
 * and never in the directory it judges: a checkout cannot vouch for itself.
 * Exact-path, not subtree: each directory is decided on its own.
 */
export interface WorkspaceTrustRecord {
  /** Canonical (real) absolute path of the directory decided. */
  readonly root: string;
  readonly level: 'trusted' | 'restricted';
  /** ISO-8601 timestamp of the decision. */
  readonly decidedAt: string;
}

/** Public coverage snapshot. Registry generations remain store-owned. */
export interface WorkspaceRegistrySnapshot {
  readonly workspaces: readonly RegisteredWorkspaceRecord[];
  readonly declines: readonly DeclinedWorkspaceRecord[];
}

/** Coverage verdict for a path: affirmatively covered, remembered-declined, or never seen. */
export type WorkspaceCoverageStatus = 'covered' | 'declined' | 'unknown';

/**
 * Git facts a caller supplies so resolution can honor the worktree→main-repo
 * link instead of path ancestry alone. Kept as plain data so
 * {@link resolveWorkspaceRegistration} stays pure; {@link probeWorktreeLink}
 * produces it from a real repo.
 */
export interface WorkspaceGitMetadata {
  /**
   * The absolute top-level of the MAIN worktree the query path's git worktree
   * links to (derived from `git rev-parse --git-common-dir`, NOT from path
   * ancestry). Set only when the path is a LINKED worktree whose main repo lives
   * elsewhere, so an orchestration-spawned sibling worktree outside the
   * registered root still inherits the main repo's registration. Undefined when
   * the path is the main worktree, not a worktree, or not in a git repo.
   */
  readonly mainWorktreeRoot?: string | undefined;
}

/** Input to the pure resolver: a path, optional git link facts, and the current registry state. */
export interface ResolveWorkspaceInput {
  readonly path: string;
  readonly git?: WorkspaceGitMetadata | undefined;
  readonly registrations: readonly RegisteredWorkspaceRecord[];
  readonly declines: readonly DeclinedWorkspaceRecord[];
}

/** The resolver's verdict. */
export interface WorkspaceResolution {
  /** The normalized query path. */
  readonly path: string;
  readonly status: WorkspaceCoverageStatus;
  /** The nearest registered root covering the path, or null when not covered. */
  readonly coveredBy: string | null;
  /** The root a remembered decline was recorded at, when status is `declined`; else null. */
  readonly declinedRoot: string | null;
  /**
   * True when coverage was inherited through the git worktree→main-repo link
   * (the chosen root covers the main worktree, not the path itself), false when
   * the path is directly under the registered root.
   */
  readonly viaWorktreeLink: boolean;
  /** Human-readable justification. */
  readonly reason: string;
}

/** Error raised by the store for invalid input (broad-root refusal, empty root). */
export class WorkspaceRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_ARGUMENT' = 'INVALID_ARGUMENT',
  ) {
    super(message);
    this.name = 'WorkspaceRegistrationError';
  }
}
