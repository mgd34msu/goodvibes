/**
 * companion-chat-gc.ts
 *
 * Pure GC-sweep planning for CompanionChatManager. Kept separate from the
 * manager so the deletion-authority split (charter: closed sessions are HISTORY)
 * is expressed as data, one decision per session, and unit-testable without a
 * live manager or disk.
 *
 * Two distinct authorities, deliberately decoupled:
 *  - MEMORY eviction: cheap and aggressive. A chat nobody has used for a while
 *    (an active one past its idle time, a closed one past a short grace) has
 *    its model-facing history and its transcript dropped from memory. Only its
 *    summary stays; the transcript is read again from disk when the chat is
 *    opened, and the history is rebuilt from it on the next send. Idleness never
 *    closes a chat: closing is a person's decision.
 *  - PERSISTENT deletion: rare and explicit. The on-disk session file is removed
 *    ONLY when the caller opted into a finite retention window (or, in future, an
 *    explicit delete verb). The default is `undefined` = retain indefinitely, so
 *    a closed session is never deleted off disk by the periodic sweep.
 */

export type CompanionSweepAction =
  /** Session past its idle time or closed grace → drop its history and transcript from memory, keep its summary. */
  | { readonly kind: 'evict-memory' }
  /** Closed session past an explicit finite retention window → delete off disk. */
  | { readonly kind: 'delete-persistent' }
  /** Nothing to do this sweep. */
  | { readonly kind: 'retain' };

export interface CompanionSweepSessionView {
  readonly status: 'active' | 'closed';
  readonly closedAt: number | null | undefined;
  /** epoch ms of last activity (idle measured from here for active sessions). */
  readonly lastActivityAt: number;
  /** whether the session still holds its transcript or model-facing history in memory. */
  readonly hasReplayInMemory: boolean;
  /** whether the session is empty (no messages), selects the idle TTL. */
  readonly isEmpty: boolean;
}

export interface CompanionSweepPolicy {
  readonly now: number;
  readonly idleActiveMs: number;
  readonly idleEmptyMs: number;
  /**
   * Age past `closedAt` at which heavy in-memory handles are evicted while meta
   * stays listable. Bounds resident memory for long-closed history.
   */
  readonly closedMemoryGraceMs: number;
  /**
   * Age past `closedAt` at which the persisted session file is permanently
   * deleted. `undefined` = retain indefinitely (never delete via the sweep).
   */
  readonly closedRetentionMs: number | undefined;
}

export function planCompanionSweep(
  session: CompanionSweepSessionView,
  policy: CompanionSweepPolicy,
): CompanionSweepAction {
  if (session.status === 'closed') {
    const closedAt = session.closedAt ?? policy.now;
    const closedFor = policy.now - closedAt;
    // Explicit finite retention is the ONLY authority for persistent deletion.
    if (policy.closedRetentionMs !== undefined && closedFor >= policy.closedRetentionMs) {
      return { kind: 'delete-persistent' };
    }
    // Otherwise evict the replay state once past the memory grace, but only if
    // it is still resident (idempotent across sweeps).
    if (closedFor >= policy.closedMemoryGraceMs && session.hasReplayInMemory) {
      return { kind: 'evict-memory' };
    }
    return { kind: 'retain' };
  }

  const idleMs = policy.now - session.lastActivityAt;
  const ttl = session.isEmpty ? policy.idleEmptyMs : policy.idleActiveMs;
  return idleMs >= ttl && session.hasReplayInMemory ? { kind: 'evict-memory' } : { kind: 'retain' };
}
