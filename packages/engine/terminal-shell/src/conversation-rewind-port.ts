// ---------------------------------------------------------------------------
// conversation-rewind-port.ts, the TUI's ConversationManager as the platform unified
// rewind service's RewindConversationPort.
//
// The platform's UnifiedRewindService (platform/rewind) joins files rewind (workspace
// checkpoints) with conversation rewind through two ports. The conversation port
// is "a daemon-hosted mutable conversation store": preview() reports how many
// messages would truncate to a recorded turn boundary, and rewind() performs the
// truncation and captures the pre-/post-truncation snapshots so the reversal can
// be undone and re-applied. The truncation boundary is the anchor recorded for
// the turnId at TURN_COMPLETED (platform/rewind turn-anchors), resolved by the
// key of the turn's last message so a compacted history is never cut at an
// unrelated message; the turnId is the same join key files rewind uses
// against the workspace checkpoint. With an `undoDir` the snapshots are also
// written to disk, so an undo still works after the process restarted.
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
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationManager as CoreConversation } from '@goodvibes-jev/engine/platform/platform/core';
export interface RewindConversation extends Pick<CoreConversation, 'getMessageCount' | 'toJSON' | 'fromJSON' | 'removeMessagesAfter'> {
  rebuildHistory(): void;
  /** Saves the changed conversation where its owner keeps it; a rewind awaits it and reports a failure. */
  persist?(): Promise<void>;
}
import { resolveTurnAnchor, resolveTurnBoundary, type BoundaryMessage } from '@goodvibes-jev/engine/platform/platform/rewind';
import { logger, readDocument, summarizeError, writeDocument } from '@goodvibes-jev/engine/platform/platform/utils';

type ConversationJson = Parameters<CoreConversation['fromJSON']>[0];

/** The port plus the reversal accessors the TUI-side undo/redo needs. */
export interface ConversationRewindPort extends RewindConversationPort {
  /** Restore the pre-truncation conversation (the /undo direction). */
  restoreBefore(undoSnapshotId: string): boolean;
  /** restoreBefore, then the conversation's save awaited: `notSaved` says why when it failed. */
  restoreBeforeSaved(undoSnapshotId: string): Promise<{ readonly restored: boolean; readonly notSaved?: string }>;
  /** Restore the post-truncation conversation (the /redo direction). */
  restoreAfter(undoSnapshotId: string): boolean;
  /**
   * How many messages the conversation holds beyond (positive) or short of
   * (negative) what that rewind left it with; null when the snapshot is
   * unknown. Anything but 0 means restoring the pre-rewind copy would replace
   * newer history. NaN means the conversation was edited in place without
   * changing its length, so there is no count to give.
   */
  messagesSinceRewind(undoSnapshotId: string): number | null;
}

/** How many rewinds stay reversible per port; older ones are forgotten so a long-lived process does not keep every closed conversation alive. */
const MAX_UNDOABLE_REWINDS = 32;

/** One truncation's captured state, the target conversation and its snapshots. */
interface SnapshotPair {
  readonly conv: RewindConversation;
  readonly before: ConversationJson;
  readonly after: ConversationJson;
  readonly afterCount: number;
  /** The post-truncation conversation as text, so an edit that keeps the length is still seen. */
  readonly afterSerialized: string;
}

/** A snapshot pair as written to `<undoDir>/<undoSnapshotId>.json`. */
interface StoredSnapshot {
  readonly sessionId: string;
  readonly before: ConversationJson;
  readonly after: ConversationJson;
  readonly afterCount: number;
}

export interface ConversationRewindPortOptions {
  /**
   * Directory for the undo snapshots, one file per rewind, the newest
   * {@link MAX_UNDOABLE_REWINDS} kept. Absent: snapshots live in memory only
   * and an undo after a restart finds nothing.
   */
  readonly undoDir?: string | undefined;
}

const UNDO_SNAPSHOT_ID = /^rwc_[a-z0-9]+_[a-z0-9]+$/;

function messagesOf(json: unknown): readonly BoundaryMessage[] | null {
  const messages = (json as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? messages as BoundaryMessage[] : null;
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string' && typeof v.afterCount === 'number'
    && messagesOf(v.before) !== null && messagesOf(v.after) !== null;
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
  options: ConversationRewindPortOptions = {},
): ConversationRewindPort {
  const snapshots = new Map<string, SnapshotPair>();
  const undoDir = options.undoDir;
  const undoLifetime = undoDir
    ? `until ${MAX_UNDOABLE_REWINDS} newer conversation rewinds on this machine; it survives a restart and works while the session is open`
    : `until ${MAX_UNDOABLE_REWINDS} newer conversation rewinds in this process, or until the process exits`;

  /** Each snapshot holds a whole conversation, so only the newest reversals stay undoable. */
  function remember(id: string, sessionId: string, pair: SnapshotPair): void {
    snapshots.set(id, pair);
    while (snapshots.size > MAX_UNDOABLE_REWINDS) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    if (undoDir) store(id, { sessionId, before: pair.before, after: pair.after, afterCount: pair.afterCount });
  }

  /** One write of the pair per rewind, then the oldest files past the bound go (ids sort by creation time). */
  function store(id: string, stored: StoredSnapshot): void {
    if (!undoDir) return;
    try {
      writeDocument(join(undoDir, `${id}.json`), stored, { indent: null });
      const files = readdirSync(undoDir).filter((name) => name.startsWith('rwc_') && name.endsWith('.json')).sort();
      for (const name of files.slice(0, Math.max(0, files.length - MAX_UNDOABLE_REWINDS))) {
        try { unlinkSync(join(undoDir, name)); } catch { /* another process pruned it first */ }
      }
    } catch (error) {
      // The rewind itself succeeded; only its undo after a restart is lost.
      logger.warn('conversation rewind undo snapshot could not be written', { undoSnapshotId: id, error: summarizeError(error) });
    }
  }

  /** The pair for an undo id: from memory, or from its file when this process restarted since the rewind. */
  function snapshotFor(id: string): SnapshotPair | undefined {
    const held = snapshots.get(id);
    if (held || !undoDir || !UNDO_SNAPSHOT_ID.test(id)) return held;
    const stored = readDocument(join(undoDir, `${id}.json`), {
      label: 'rewind/undo-snapshot',
      recovery: 'That rewind can no longer be undone; the conversation itself is unchanged.',
      validate: (parsed) => {
        if (!isStoredSnapshot(parsed)) throw new Error('not a conversation rewind undo snapshot');
        return parsed;
      },
    });
    const conv = stored ? resolveConversation(stored.sessionId) : null;
    if (!stored || !conv) return undefined;
    const pair: SnapshotPair = { conv, before: stored.before, after: stored.after, afterCount: stored.afterCount, afterSerialized: JSON.stringify(stored.after) };
    snapshots.set(id, pair);
    return pair;
  }

  /**
   * Where a rewind to `anchor` cuts `conv`. `messages` is the conversation as
   * it is now; it is read only when the anchor carries a boundary key.
   */
  function keepFor(anchor: RewindAnchor, conv: RewindConversation, messages: () => readonly BoundaryMessage[] | null): { keep: number; total: number } | { reason: string; total: number } {
    const total = conv.getMessageCount();
    if (!anchor.turnId) return { keep: total, total };
    const rec = resolveTurnAnchor(anchor.sessionId, anchor.turnId);
    if (!rec) return { reason: `this conversation has no recorded boundary for turn ${anchor.turnId}, so there is no point to rewind it to`, total };
    const resolved = resolveTurnBoundary(rec, total, messages);
    return resolved.reason === undefined ? { keep: resolved.keep, total } : { reason: resolved.reason, total };
  }

  /** The conversation's save, awaited; the reason when it failed. */
  async function save(conv: RewindConversation): Promise<string | undefined> {
    if (!conv.persist) return undefined;
    try {
      await conv.persist();
      return undefined;
    } catch (error) {
      return summarizeError(error);
    }
  }

  function apply(snapshot: SnapshotPair | undefined, which: 'before' | 'after'): boolean {
    if (!snapshot) return false;
    snapshot.conv.fromJSON(snapshot[which]);
    snapshot.conv.rebuildHistory();
    return true;
  }

  /** The synchronous restore: a save its owner keeps runs behind it and a failure is logged. */
  function restore(snapshot: SnapshotPair | undefined, which: 'before' | 'after'): boolean {
    if (!apply(snapshot, which)) return false;
    const conv = snapshot!.conv;
    if (conv.persist) {
      void save(conv).then((notSaved) => {
        if (notSaved) logger.warn('a restored conversation could not be saved; a restart brings back the transcript from before the restore', { error: notSaved });
      });
    }
    return true;
  }

  return {
    async preview(anchor: RewindAnchor): Promise<RewindConversationPreview> {
      const conv = resolveConversation(anchor.sessionId);
      if (!conv) return { messagesToDrop: 0, messagesRemaining: 0 };
      const cut = keepFor(anchor, conv, () => messagesOf(conv.toJSON()));
      if ('reason' in cut) return { available: false, unavailableReason: cut.reason, messagesToDrop: 0, messagesRemaining: cut.total };
      return { messagesToDrop: Math.max(0, cut.total - cut.keep), messagesRemaining: cut.keep };
    },

    async rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome> {
      const conv = resolveConversation(anchor.sessionId);
      const undoSnapshotId = `rwc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      if (!conv) return { droppedMessages: 0, undoSnapshotId };
      const before = conv.toJSON() as ConversationJson;
      const cut = keepFor(anchor, conv, () => messagesOf(before));
      // Reporting success for a rewind that dropped nothing would leave files and conversation at different points.
      if ('reason' in cut) return { available: false, unavailableReason: cut.reason, droppedMessages: 0, undoSnapshotId };
      conv.removeMessagesAfter(cut.keep);
      conv.rebuildHistory();
      const after = conv.toJSON() as ConversationJson;
      remember(undoSnapshotId, anchor.sessionId, { conv, before, after, afterCount: conv.getMessageCount(), afterSerialized: JSON.stringify(after) });
      const notSaved = await save(conv);
      return {
        droppedMessages: Math.max(0, cut.total - cut.keep), undoSnapshotId, undoExpiresAfter: undoLifetime,
        ...(notSaved === undefined ? {} : { notSaved }),
      };
    },

    restoreBefore(undoSnapshotId: string): boolean {
      return restore(snapshotFor(undoSnapshotId), 'before');
    },

    async restoreBeforeSaved(undoSnapshotId: string): Promise<{ readonly restored: boolean; readonly notSaved?: string }> {
      const snapshot = snapshotFor(undoSnapshotId);
      if (!apply(snapshot, 'before')) return { restored: false };
      const notSaved = await save(snapshot!.conv);
      return notSaved === undefined ? { restored: true } : { restored: true, notSaved };
    },

    restoreAfter(undoSnapshotId: string): boolean {
      return restore(snapshotFor(undoSnapshotId), 'after');
    },

    messagesSinceRewind(undoSnapshotId: string): number | null {
      const snapshot = snapshotFor(undoSnapshotId);
      if (!snapshot) return null;
      const delta = snapshot.conv.getMessageCount() - snapshot.afterCount;
      if (delta !== 0) return delta;
      return JSON.stringify(snapshot.conv.toJSON()) === snapshot.afterSerialized ? 0 : Number.NaN;
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
const changeListeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...changeListeners]) {
    try { listener(); } catch { /* a listener's failure never blocks a registration */ }
  }
}

/** Register a session's live conversation so the daemon rewind verbs can serve it. */
function registerSessionConversation(sessionId: string, conversation: Conversation): void {
  if (!sessionId) return;
  liveConversations.set(sessionId, conversation);
  changed();
}

/** Drop a session's conversation registration. */
function unregisterSessionConversation(sessionId: string): void {
  if (liveConversations.delete(sessionId)) changed();
}

/**
 * Run `listener` after each change of which session a conversation of this
 * process runs (a resume, a new or forked session, a session closed), so what
 * follows the open session (the owner inbox's mark that it is running) moves
 * with it at once. Returns the function that removes it.
 */
function onSessionConversationChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
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
function createSessionConversationRewindPort(options: ConversationRewindPortOptions = {}): ConversationRewindPort {
  return createConversationRewindPort((sessionId) => liveConversations.get(sessionId) ?? null, options);
}

function findSessionConversation(sessionId: string): Conversation | null {
  return sessionId ? liveConversations.get(sessionId) ?? null : null;
}
return Object.freeze({ registerSessionConversation, unregisterSessionConversation, hasSessionConversation, findSessionConversation, createSessionConversationRewindPort, onSessionConversationChange });
}
