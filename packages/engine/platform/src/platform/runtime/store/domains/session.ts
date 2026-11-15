import type { SessionEvent } from '../../../../events/session.js';

/**
 * Session domain state, tracks the active host session lifecycle,
 * recovery machine state, lineage, and identity metadata.
 */

/** States for the session recovery machine. */
export type SessionRecoveryState =
  | 'loading'
  | 'repairing'
  | 'reconciling'
  | 'ready'
  | 'failed';

/** States representing overall session status. */
export type SessionStatus =
  | 'initializing'
  | 'active'
  | 'suspended'
  | 'terminating'
  | 'terminated';

/**
 * Snapshot of a session lineage entry, used for branching/resume tracking.
 */
export interface SessionLineageEntry {
  /** Session ID in the lineage chain. */
  sessionId: string;
  /** Timestamp when this lineage node was created. */
  createdAt: number;
  /** Optional parent session ID (undefined = root). */
  parentId?: string | undefined;
  /** Reason this session was branched or resumed. */
  branchReason?: 'resume' | 'fork' | 'repair' | 'compaction' | undefined;
}

/**
 * SessionDomainState, full session context including recovery state machine.
 */
export interface SessionDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Identity ───────────────────────────────────────────────────────────────
  /**
   * The process session id (`user-<id>`), fixed for the life of this terminal
   * process. It is not a saved conversation and cannot be passed to /resume.
   */
  id: string;
  /**
   * The saved conversation this process is running now: the id /resume and the
   * session list use. It moves on resume, fork and recovery; the runtime's
   * session id setter is its one writer.
   */
  conversationSessionId: string;
  /** Absolute path to the project root for this session. */
  projectRoot: string;
  /** Optional user identifier (from config or auth layer). */
  userId?: string | undefined;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  /** Current overall session status. */
  status: SessionStatus;
  /** Epoch ms when the session was started. */
  startedAt: number;
  /** Epoch ms when the session ended (undefined while active). */
  endedAt?: number | undefined;

  // ── Recovery machine ───────────────────────────────────────────────────────
  /** Current state of the session recovery state machine. */
  recoveryState: SessionRecoveryState;
  /** Whether this process resumed a saved conversation. */
  isResumed: boolean;
  /** The saved conversation that was last resumed (undefined for fresh sessions). */
  resumedFromId?: string | undefined;
  /** Whether a compaction repair was applied during load. */
  wasRepaired: boolean;
  /** Error message if recoveryState === 'failed'. */
  recoveryError?: string | undefined;

  // ── Lineage ────────────────────────────────────────────────────────────────
  /** The root session ID in the lineage chain (equals id for root sessions). */
  lineageId: string;
  /** Ordered lineage history from root to current. */
  lineage: SessionLineageEntry[];

  // ── Compaction ─────────────────────────────────────────────────────────────
  /** Current state of the compaction lifecycle machine. */
  compactionState:
    | 'idle'
    | 'checking_threshold'
    | 'microcompact'
    | 'collapse'
    | 'autocompact'
    | 'reactive_compact'
    | 'boundary_commit'
    | 'done'
    | 'failed';
  /** Epoch ms of the last compaction run. */
  lastCompactedAt?: number | undefined;
  /** Number of messages at last compaction checkpoint. */
  compactionMessageCount?: number | undefined;
  /** Why the last compaction failed; cleared when a compaction succeeds. */
  compactionError?: string | undefined;
}

/**
 * Returns the default initial state for the session domain.
 */
export function createInitialSessionState(): SessionDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    id: '',
    conversationSessionId: '',
    projectRoot: '',
    userId: undefined,
    status: 'initializing',
    startedAt: 0,
    endedAt: undefined,
    recoveryState: 'loading',
    isResumed: false,
    resumedFromId: undefined,
    wasRepaired: false,
    recoveryError: undefined,
    lineageId: '',
    lineage: [],
    compactionState: 'idle',
    lastCompactedAt: undefined,
    compactionMessageCount: undefined,
  };
}

/**
 * The session-domain change a session lifecycle event makes, or undefined for
 * an event that does not move the recovery machine. The machine's state is
 * derived from these events alone: a resumed session announces RESUMED and
 * READY, or RECOVERY_FAILED with the error.
 */
export function sessionRecoveryPatch(event: SessionEvent): Partial<SessionDomainState> | undefined {
  switch (event.type) {
    case 'SESSION_RESUMED':
      return { isResumed: true, resumedFromId: event.sessionId };
    case 'SESSION_READY':
      return { recoveryState: 'ready', recoveryError: undefined };
    case 'SESSION_RECOVERY_FAILED':
      return { recoveryState: 'failed', recoveryError: event.error };
    default:
      return undefined;
  }
}
