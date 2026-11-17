// ---------------------------------------------------------------------------
// conversation-rewind-port.ts, the daemon's RewindConversationPort for the
// platform's unified rewind service.
//
// The platform's UnifiedRewindService (platform/rewind) joins files rewind (workspace
// checkpoints) with conversation rewind through two ports. The conversation port
// is "a daemon-hosted mutable conversation store": preview() reports how many
// messages would truncate to a recorded turn boundary, and rewind() performs the
// truncation and captures the pre-/post-truncation snapshots so the reversal can
// be undone and re-applied. The truncation boundary is the message count recorded
// for the anchor's turnId at TURN_COMPLETED (the platform's platform/rewind turn
// anchors), the same
// join key files rewind uses against the workspace checkpoint.
//
// This module is the daemon's implementation of that port, for sessions THIS
// process holds the conversation for. It resolves the live conversation per
// anchor.sessionId from the registry below.
//
// While conversation loops run in the surfaces, that registry is empty here, and
// it used to answer an empty resolution with "0 messages to drop", the same
// answer a conversation already at the anchor gives, which is a confident wrong
// answer rather than a missing one. It now reports the anchor as UNAVAILABLE
// with the reason, which the platform's rewind service turns into a plan warning.
//
// The surfaces reach conversation rewind a different way now: they offer their
// live conversation over the control plane (rewind.conversation.*), and the
// platform's host broker asks them directly. This port is the fallback the broker
// falls through to for sessions no surface has offered, which is exactly the
// case where the daemon hosts the conversation itself. Files-scope rewind,
// entirely daemon-owned, was never affected either way.
//
// The port is written against a structural conversation shape rather than any
// one surface's conversation class, so nothing about it is terminal-specific.
// ---------------------------------------------------------------------------

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RewindAnchor,
  RewindConversationOutcome,
  RewindConversationPreview,
} from '@goodvibes-jev/engine/platform/platform/rewind';
import { captureTurnAnchor, clearTurnAnchors, persistTurnAnchors, recordTurnAnchor, restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import type { HostedSessionConversations, HostedSessionRuntime } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import { createSessionSurface, type SessionSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import {
  createConversationRewindPort as createSharedConversationRewindPort,
  createConversationRewindScope,
  type ConversationRewindPort,
  type ConversationRewindPortOptions,
  type RewindConversation,
} from '@goodvibes-jev/engine/terminal-shell/conversation-rewind-port';

export type { ConversationRewindPort };

/** Whatever a conversation is serialized as by the process that owns it. */
type ConversationJson = unknown;

/**
 * The five operations a rewind needs from a conversation. Any host that can
 * count its messages, serialize them, truncate to a boundary and reload a
 * snapshot satisfies this.
 */
export interface RewindableConversation {
  getMessageCount(): number;
  toJSON(): ConversationJson;
  fromJSON(json: ConversationJson): void;
  rebuildHistory(): void;
  removeMessagesAfter(count: number): void;
  /** Saves the changed conversation; a rewind or undo awaits it and reports a failure. */
  persist?(): Promise<void>;
}

/** What this port says when it holds no conversation for the session asked about. */
const NO_LIVE_CONVERSATION =
  'this daemon holds no live conversation for that session, so it cannot count or drop its messages';

/**
 * The shared terminal port counts and truncates a conversation with the undo
 * guard and a bounded snapshot history; this daemon only differs where nobody
 * holds the conversation. The shared port answers a missing conversation with
 * "nothing to drop", which here would read as a real zero, so that case is
 * reported as unavailable with the reason instead.
 */
export function createConversationRewindPort(
  resolveConversation: (sessionId: string) => RewindableConversation | null,
  options: ConversationRewindPortOptions = {},
): ConversationRewindPort {
  // The shared type pins the JSON shape to the terminal conversation class;
  // the daemon port is written against any structural conversation, and it only
  // ever hands a conversation's own JSON back to that conversation.
  const resolveShared = resolveConversation as unknown as (sessionId: string) => RewindConversation | null;
  const shared = createSharedConversationRewindPort(resolveShared, options);
  return {
    ...shared,
    async preview(anchor: RewindAnchor): Promise<RewindConversationPreview> {
      if (!resolveConversation(anchor.sessionId)) {
        return { messagesToDrop: 0, messagesRemaining: 0, available: false, unavailableReason: NO_LIVE_CONVERSATION };
      }
      return shared.preview(anchor);
    },
    async rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome> {
      if (!resolveConversation(anchor.sessionId)) {
        return { droppedMessages: 0, undoSnapshotId: '', available: false, unavailableReason: NO_LIVE_CONVERSATION };
      }
      return shared.rewind(anchor);
    },
  };
}

// ---------------------------------------------------------------------------
// Live per-session conversation registry, the daemon-hosted mutable store the
// composed daemon's rewind.plan/apply verbs fall back to. A process INSIDE this
// daemon that runs a conversation registers it here; a surface in another
// process offers its conversation over the control plane instead
// (rewind.conversation.host.register), and that offer is consulted first.
// A session in neither reports conversation rewind as unavailable, with the
// reason, rather than as a count.
// ---------------------------------------------------------------------------

const scope = createConversationRewindScope<RewindConversation>();

/** Register a session's live conversation so the daemon rewind verbs can serve it. */
export function registerSessionConversation(sessionId: string, conversation: RewindableConversation): void {
  scope.registerSessionConversation(sessionId, conversation as unknown as RewindConversation);
}

/** Drop a session's conversation registration. */
export function unregisterSessionConversation(sessionId: string): void {
  scope.unregisterSessionConversation(sessionId);
}

/**
 * The conversation rewind port the composed daemon threads into
 * registerGatewayVerbGroups, it resolves each anchor's live conversation from
 * the registry above, so the daemon's own rewind verbs serve conversation scope
 * live in this process. With `undoDir` the undo snapshots are kept on disk, so
 * rewind.undo still works after a daemon restart.
 */
export function createSessionConversationRewindPort(options: ConversationRewindPortOptions = {}): ConversationRewindPort {
  return createConversationRewindPort((sessionId) => scope.findSessionConversation(sessionId), options);
}

// ---------------------------------------------------------------------------
// Hosted sessions. Every conversation loop this daemon hosts registers here
// while it is built, so rewind.plan/apply/undo serve it in place; its turn
// boundaries are recorded as its turns complete, and the undo snapshots and
// boundaries are kept on disk, so an undo or a rewind to an earlier turn still
// works after the daemon restarted.
// ---------------------------------------------------------------------------

/** Where hosted sessions' rewind state is kept, beside the hosted session store. */
export interface HostedRewindStorage {
  /** One file per conversation rewind: the pre- and post-rewind copies its undo restores. */
  readonly undoDir: string;
  /**
   * The turn-anchor sidecars' directory, carried as the `sessionsDir` of a
   * surface because that is the handle the anchor store takes; nothing else of
   * this surface is read.
   */
  readonly anchorSurface: SessionSurface;
}

interface ShellUserPaths { resolveUserPath(...segments: string[]): string }

export function hostedRewindStorage(input: { readonly shellPaths: ShellUserPaths; readonly homeDirectory: string }): HostedRewindStorage {
  const surface = createSessionSurface({ surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, workingDirectory: input.homeDirectory, homeDirectory: input.homeDirectory });
  return {
    undoDir: input.shellPaths.resolveUserPath('hosted-rewind', 'undo'),
    anchorSurface: { ...surface, sessionsDir: input.shellPaths.resolveUserPath('hosted-rewind', 'anchors') },
  };
}

type HostedConversation = HostedSessionRuntime['conversation'];

/** The hosted conversations registered here, for their turn boundaries. */
const hostedConversations = new Map<string, HostedConversation>();

/**
 * A hosted conversation as the rewind port drives it. A rewind and its undo
 * await `persist`, which saves the changed transcript, so a restart brings
 * back the conversation as the rewind left it, and a save that failed is
 * reported in the rewind's answer instead of only in the log.
 */
function rewindableHosted(sessionId: string, conversation: HostedConversation, save: () => Promise<void>): RewindableConversation {
  return {
    getMessageCount: () => conversation.getMessageCount(),
    toJSON: () => conversation.toJSON(),
    fromJSON: (json) => conversation.fromJSON(json as Parameters<HostedConversation['fromJSON']>[0]),
    removeMessagesAfter: (count) => conversation.removeMessagesAfter(count),
    rebuildHistory: () => {},
    persist: async () => {
      try {
        await save();
      } catch (error) {
        logger.warn('a rewound hosted conversation could not be saved; a restart brings back the transcript from before the rewind', { sessionId, error: summarizeError(error) });
        throw error;
      }
    },
  };
}

/** The hosted-session engine's hook: register each hosted loop's conversation and record where its turns end. */
export function hostedSessionConversations(storage: HostedRewindStorage): HostedSessionConversations {
  return {
    opened(sessionId, conversation, save) {
      // Boundaries recorded before a restart or a rebuild, so earlier turns stay rewindable.
      restoreTurnAnchors(sessionId, storage.anchorSurface);
      hostedConversations.set(sessionId, conversation);
      registerSessionConversation(sessionId, rewindableHosted(sessionId, conversation, save));
    },
    turnCompleted(sessionId, turnId) {
      const conversation = hostedConversations.get(sessionId);
      if (!conversation) return;
      recordTurnAnchor(sessionId, captureTurnAnchor(turnId, {
        getMessageCount: () => conversation.getMessageCount(),
        getLastUserMessage: () => conversation.getLastUserMessage(),
        getMessageAt: (index) => conversation.readMessagesInPlace()[index],
      }));
      // persistTurnAnchors logs its own cause; this turn stays rewindable until a restart.
      persistTurnAnchors(sessionId, storage.anchorSurface);
    },
    closed(sessionId, ended) {
      hostedConversations.delete(sessionId);
      unregisterSessionConversation(sessionId);
      if (!ended) return;
      // A terminated session is never built again, so its boundaries have no reader left.
      clearTurnAnchors(sessionId);
      try { unlinkSync(join(storage.anchorSurface.sessionsDir, `${sessionId}.anchors.json`)); } catch { /* none was written */ }
    },
  };
}
