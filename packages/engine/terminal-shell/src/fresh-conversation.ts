/**
 * fresh-conversation.ts, what /clear does: start a fresh conversation in this
 * terminal session without losing the one on screen.
 *
 * /clear used to hide the transcript while keeping every message in the
 * model's context, so the header kept the old title and the status line kept
 * the old context usage, both true of a conversation the screen no longer
 * showed. Now the conversation on screen is first saved as its own session
 * (resumable by id, like /session fork, taking its view sidecar and rewind
 * anchors with it), then the live conversation is reset: no messages, no
 * title, the system prompt reloaded, no rewind anchors, and the usage counters
 * recomputed from the (empty) transcript, so the header and status line
 * describe the fresh conversation.
 */

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMeta, SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import type { TerminalConversationManager } from './terminal-conversation.js';
import type { SessionSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
export interface FreshConversationContext {
  readonly session: {
    readonly conversationManager: TerminalConversationManager;
    readonly sessionManager?: (Pick<SessionManager, 'save'> & Partial<Pick<SessionManager, 'delete'>>) | null | undefined;
    readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string; systemPrompt: string };
    readonly hydrateSessionUsage?: (() => void) | undefined;
  };
  readonly reloadSystemPrompt?: (() => string) | undefined;
  readonly cancelPendingRecovery?: (() => void) | undefined;
  /**
   * Runs once the local conversation is reset. A host that routes turns to a
   * daemon-held session uses it to let go of that session, so the next message
   * starts a fresh one instead of continuing the conversation that was cleared.
   */
  readonly abandonHostedSession?: (() => void) | undefined;
}

import { saveWorkTreeFolds } from './work-tree-fold-store.js';
import { deleteRecoveryFile } from '@goodvibes-jev/engine/platform/platform/runtime/operations';

export interface FreshConversationResult {
  /** Session id the previous conversation was saved under, or null when there was nothing to keep. */
  readonly savedAs: string | null;
}

/** Whether a transcript holds a conversation worth keeping (anything the user or the model said). */
function hasConversation(ctx: FreshConversationContext): boolean {
  return ctx.session.conversationManager.getMessageSnapshot().some((m) => m.role === 'user' || m.role === 'assistant');
}

/**
 * Save the conversation on screen as its own session, then reset the live one.
 * Throws (and changes nothing) when the save fails, so a conversation is never
 * dropped without a saved copy.
 */
export function startFreshConversation(ctx: FreshConversationContext, surface?: SessionSurface | null): FreshConversationResult {
  const conversation = ctx.session.conversationManager;
  const keep = hasConversation(ctx);
  if (keep && !ctx.session.sessionManager) {
    // One property read: clearing without a store would drop the only copy of the conversation.
    throw new RefusalError(refusal({
      code: 'NO_SESSION_STORE',
      state: 'nothing was cleared',
      reason: 'This session has no session store, so the conversation on screen cannot be saved before it is cleared',
      next: ['Keep a copy with /export markdown <path> --yes, then clear'],
    }));
  }
  let savedAs: string | null = null;
  const sessionManager = ctx.session.sessionManager;
  if (keep && sessionManager) {
    const id = `user-${randomBytes(4).toString('hex')}`;
    const exported = conversation.toJSON() as { messages?: unknown[] };
    const meta: SessionMeta = {
      title: conversation.title,
      model: ctx.session.runtime.model,
      provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      titleSource: conversation.getTitleSource(),
      // The user asked for this conversation to be set aside; it is not turn machinery.
      saveSource: 'user',
    };
    sessionManager.save(id, (exported.messages ?? []) as Parameters<SessionManager['save']>[1], meta, undefined, undefined, conversation.branchState());
    try {
      if (surface) {
        // The saved copy keeps its view (folds, failed/cancelled turn headers)
        // and its rewind anchors, which describe exactly that transcript.
        saveWorkTreeFolds(surface.sessionsDir, id, conversation.workTree.foldState(), conversation.workTree.turnOutcomes());
        for (const anchor of getTurnAnchors(ctx.session.runtime.sessionId)) recordTurnAnchor(id, anchor);
        persistTurnAnchors(id, surface);
      }
    } catch (error) {
      // The live conversation is untouched, so a half-written copy would only be a stray duplicate.
      try { sessionManager.delete?.(id); } catch { /* the copy is harmless if it cannot be removed */ }
      throw error;
    }
    savedAs = id;
  }

  const liveId = ctx.session.runtime.sessionId;
  // Close the durable snapshot boundary before changing memory. A crash or
  // immediate resume must see the same empty conversation as the screen.
  const liveMessages = (conversation.toJSON() as { messages?: unknown[] }).messages ?? [];
  const liveBranches = conversation.branchState();
  const liveMeta: SessionMeta = {
    title: conversation.title, model: ctx.session.runtime.model, provider: ctx.session.runtime.provider,
    timestamp: Date.now(), titleSource: conversation.getTitleSource(), saveSource: 'auto',
  };
  sessionManager?.save(liveId, [], {
    title: '', model: ctx.session.runtime.model, provider: ctx.session.runtime.provider,
    timestamp: Date.now(), saveSource: 'auto',
  });
  try {
    ctx.cancelPendingRecovery?.();
    // The live snapshot goes; a crash snapshot of this session still on offer is kept apart, not deleted.
    if (surface) deleteRecoveryFile({ surface }, liveId);
  } catch (error) {
    // Memory still holds the conversation, so disk must not say it is empty.
    try { sessionManager?.save(liveId, liveMessages as Parameters<SessionManager['save']>[1], liveMeta, undefined, undefined, liveBranches); } catch { /* the next autosave rewrites it */ }
    throw error;
  }
  conversation.resetAll();
  ctx.abandonHostedSession?.();
  if (ctx.reloadSystemPrompt) ctx.session.runtime.systemPrompt = ctx.reloadSystemPrompt();
  // Rewind anchors and the view sidecar point into the old transcript.
  clearTurnAnchors(liveId);
  if (surface) {
    // persistTurnAnchors writes nothing for an empty list, so the old sidecar
    // (`<sessionId>.anchors.json`, the platform's rewind/turn-anchors.ts name) is
    // removed here, or a later resume would bring the old anchors back.
    try {
      if (!/[\\/]/.test(liveId)) rmSync(join(surface.sessionsDir, `${liveId}.anchors.json`), { force: true });
    } catch {
      // best effort: the in-memory anchors are already gone
    }
    saveWorkTreeFolds(surface.sessionsDir, liveId, [], []);
  }
  // Token counters and context usage come from the transcript: now empty.
  ctx.session.hydrateSessionUsage?.();
  conversation.rebuildHistory();
  return { savedAs };
}
