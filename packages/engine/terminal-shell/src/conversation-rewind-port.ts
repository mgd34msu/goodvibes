// ---------------------------------------------------------------------------
// conversation-rewind-port.ts, the TUI's ConversationManager as the platform unified
// rewind service's RewindConversationPort.
//
// The platform's UnifiedRewindService (platform/rewind) joins files rewind (workspace
// checkpoints) with conversation rewind through two ports. The conversation port
// is "a daemon-hosted mutable conversation store": preview() reports how many
// messages would truncate to a recorded turn boundary, and rewind() performs the
// truncation and captures the pre-/post-truncation snapshots so the reversal can
// be undone and re-applied. The truncation boundary is the message count recorded
// for the anchor's turnId at TURN_COMPLETED (rewind-turn-anchors.ts), the same
// join key files rewind uses against the workspace checkpoint.
//
// This module is the single implementation of that port for the TUI, and it has
// two consumers again, but the second one reaches it differently now.
//
// It used to be the composed daemon's own rewind.plan/apply verbs, resolving a
// conversation out of the registry below because the daemon was this process.
// It is not any more. FILES rewind still works from anywhere (the workspace
// checkpoint store is the daemon's), but the messages live in whichever process
// runs the loop, and for a while a rewind driven from another surface got a
// confident "0 messages to drop" from a daemon registry nothing could populate.
//
// The daemon now ASKS. This surface offers the conversation it is holding
// (rewind.conversation.host.register), takes the questions the daemon puts to it
// and answers them (the platform's client/conversation-rewind-host.ts); this port is what
// produces those answers. So conversation rewind works from any surface, and a
// session nobody has offered is reported unavailable with the reason rather
// than as a zero that cannot be told apart from a real one.
// ---------------------------------------------------------------------------

import type {
  RewindAnchor,
  RewindConversationOutcome,
  RewindConversationPort,
  RewindConversationPreview,
} from '@goodvibes-jev/engine/platform/platform/rewind';
import type { ConversationManager as CoreConversation } from '@goodvibes-jev/engine/platform/platform/core';
export interface RewindConversation extends Pick<CoreConversation, 'getMessageCount' | 'toJSON' | 'fromJSON' | 'removeMessagesAfter'> { rebuildHistory(): void }
import { resolveTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';

type ConversationJson = Parameters<CoreConversation['fromJSON']>[0];

/** The port plus the reversal accessors the TUI-side undo/redo needs. */
export interface ConversationRewindPort extends RewindConversationPort {
  /** Restore the pre-truncation conversation (the /undo direction). */
  restoreBefore(undoSnapshotId: string): boolean;
  /** Restore the post-truncation conversation (the /redo direction). */
  restoreAfter(undoSnapshotId: string): boolean;
}

/** One truncation's captured state, the target conversation and its snapshots. */
interface SnapshotPair {
  readonly conv: RewindConversation;
  readonly before: ConversationJson;
  readonly after: ConversationJson;
}

/**
 * Build a conversation rewind port. `resolveConversation` maps an anchor's
 * sessionId to the live ConversationManager, for the single-session /rewind
 * command it returns the one bound conversation; for the daemon it looks the
 * session up in the live registry. A null resolution means no live conversation
 * for that session, reported as "nothing to drop" rather than a fabricated count.
 */
export function createConversationRewindPort(
  resolveConversation: (sessionId: string) => RewindConversation | null,
): ConversationRewindPort {
  const snapshots = new Map<string, SnapshotPair>();

  function keepFor(anchor: RewindAnchor): { conv: RewindConversation | null; keep: number; total: number } {
    const conv = resolveConversation(anchor.sessionId);
    if (!conv) return { conv: null, keep: 0, total: 0 };
    const total = conv.getMessageCount();
    const rec = anchor.turnId ? resolveTurnAnchor(anchor.sessionId, anchor.turnId) : null;
    const keep = rec ? Math.min(rec.messageCount, total) : total;
    return { conv, keep, total };
  }

  function restore(snapshot: SnapshotPair | undefined, which: 'before' | 'after'): boolean {
    if (!snapshot) return false;
    snapshot.conv.fromJSON(snapshot[which]);
    snapshot.conv.rebuildHistory();
    return true;
  }

  return {
    async preview(anchor: RewindAnchor): Promise<RewindConversationPreview> {
      const { keep, total } = keepFor(anchor);
      return { messagesToDrop: Math.max(0, total - keep), messagesRemaining: keep };
    },

    async rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome> {
      const { conv, keep, total } = keepFor(anchor);
      const undoSnapshotId = `rwc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      if (!conv) return { droppedMessages: 0, undoSnapshotId };
      const before = conv.toJSON() as ConversationJson;
      conv.removeMessagesAfter(keep);
      conv.rebuildHistory();
      const after = conv.toJSON() as ConversationJson;
      snapshots.set(undoSnapshotId, { conv, before, after });
      return { droppedMessages: Math.max(0, total - keep), undoSnapshotId };
    },

    restoreBefore(undoSnapshotId: string): boolean {
      return restore(snapshots.get(undoSnapshotId), 'before');
    },

    restoreAfter(undoSnapshotId: string): boolean {
      return restore(snapshots.get(undoSnapshotId), 'after');
    },
  };
}

// ---------------------------------------------------------------------------
// Live per-session conversation registry.
//
// This process's conversations, by session id. Two readers now: the local
// /rewind command, and the host loop that answers the DAEMON's questions about
// a session this surface is running (the platform's client/conversation-rewind-host.ts),
// which is what makes conversation rewind work from any surface again, since
// only the process holding the messages can count or drop them.
// ---------------------------------------------------------------------------

export function createConversationRewindScope<Conversation extends RewindConversation = RewindConversation>() {
const liveConversations = new Map<string, Conversation>();

/** Register a session's live conversation so the daemon rewind verbs can serve it. */
function registerSessionConversation(sessionId: string, conversation: Conversation): void {
  if (sessionId) liveConversations.set(sessionId, conversation);
}

/** Drop a session's conversation registration. */
function unregisterSessionConversation(sessionId: string): void {
  liveConversations.delete(sessionId);
}

/**
 * Whether this process is actually holding a session's conversation right now.
 *
 * The port below answers "nothing to drop" for a session it cannot resolve,
 * which is the right degrade for a LOCAL /rewind (there is nothing to truncate
 * here). It is the wrong answer for a rewind driven from another surface: a
 * confident zero is indistinguishable from a real zero, and that is exactly the
 * failure the surface-hosted rewind contract exists to end. The host loop
 * (the platform's client/conversation-rewind-host.ts) checks this first and answers
 * `unavailable` with a reason instead.
 */
function hasSessionConversation(sessionId: string): boolean {
  return liveConversations.has(sessionId);
}

/**
 * The port that answers for whichever of this process's conversations an anchor
 * names. Used by the local /rewind command and, through the host loop, by the
 * daemon when a rewind driven from anywhere touches a session running here.
 */
function createSessionConversationRewindPort(): ConversationRewindPort {
  return createConversationRewindPort((sessionId) => liveConversations.get(sessionId) ?? null);
}

function findSessionConversation(sessionId: string): Conversation | null {
  return sessionId ? liveConversations.get(sessionId) ?? null : null;
}
return Object.freeze({ registerSessionConversation, unregisterSessionConversation, hasSessionConversation, findSessionConversation, createSessionConversationRewindPort });
}
