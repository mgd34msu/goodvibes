/**
 * session-resume-core.ts, the ONE resume routine both resume seams call.
 *
 * Two independent call sites used to duplicate (and diverge from) this
 * sequence: `/session resume` (session-workflow.ts) and the session-browser
 * resume (bootstrap-hook-bridge.ts's `createResumeSessionHandler`).
 * Divergences found by audit:
 *   - the session-browser seam skipped `restoreTurnAnchors` (message-anchored
 *     /rewind silently had no anchors after a session-browser resume)
 *   - the session-browser seam skipped `conversation.resetAll()` before
 *     `fromJSON()`
 *   - the session-browser seam skipped the `selectModel` reselection fallback
 *     (it set `runtime.model` straight from the saved meta, never re-resolving
 *     through the live provider registry)
 *   - the session-browser seam reopened saved views without the modal
 *     redirect, so a saved view id could pop a modal mid-resume (saved views
 *     are no longer reopened at all)
 *
 * Both seams now call this module so those behaviors are guaranteed
 * identical by construction, not by copy-paste discipline between two files.
 *
 * Callers own everything ABOVE and AROUND this core sequence: printing or
 * logging the outcome in their own idiom (`ctx.print` vs `conversation.log`),
 * and any extra plumbing that only one seam performs (hookDispatcher.fire,
 * sessionSpine.reopen, sharedSessionBroker.reopenSession,
 * writeLastSessionPointer, all bootstrap-hook-bridge-only, pre-existing
 * asymmetries out of this module's scope).
 */
import type { SessionManager, SessionMeta } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { SessionSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { TerminalConversationManager as ConversationManager } from './terminal-conversation.js';
import { restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import { restoreWorkTreeFolds } from './work-tree-wiring.js';
import { replayJournalForSession, type ReplayIntoConversationResult } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
export interface SessionResumeRuntime {
  sessionId: string;
  model: string;
  provider: string;
}
export interface SessionResumeDeps {
  readonly sessionManager: Pick<SessionManager, 'load' | 'save'>;
  readonly conversation: ConversationManager;
  readonly runtime: SessionResumeRuntime;
  /**
   * The app's declare-once session-storage handle. Both resume seams pass the
   * SAME one the runtime writes through, so the anchor sidecar and the
   * transcript journal this routine reads are guaranteed to be the files the
   * live session actually wrote, the scope can no longer be re-guessed per
   * seam.
   */
  readonly surface: SessionSurface;
  /**
   * Reselects the saved model through the live provider registry, falling
   * back to the raw saved id on failure (a saved model may no longer exist
   * locally). Omit to use the saved id directly without reselection.
   */
  readonly selectModel?:
    | ((model: string) => Promise<{
        readonly registryKey: string;
        readonly providerId: string;
      }>)
    | undefined;
  readonly hydrateSessionUsage?: (() => void) | undefined;
  readonly canResume?: (() => boolean) | undefined;
}
export interface SessionResumeOutcome {
  readonly meta: SessionMeta;
  readonly resumedMessageCount: number;
  readonly restoredAnchorCount: number;
  readonly journalReplay: ReplayIntoConversationResult;
}
/**
 * The canonical resume sequence: load, reset + restore the conversation,
 * restore rewind anchors, replay any post-snapshot journal records, hydrate
 * footer usage and reselect the model.
 *
 * Sessions saved by an older TUI can carry a legacy pane list in their
 * return context (`returnContext.openPanels` plus an "Open panels: ..."
 * line). The platform's session loader (`loadedReturnContext`) drops both, so
 * `meta.returnContext` here never has them, and the journal-replay rewrite
 * below writes the session back without them.
 */
export async function resumeSessionCore(sessionId: string, deps: SessionResumeDeps): Promise<SessionResumeOutcome> {
  const sourceSessionId = deps.runtime.sessionId;
  if (deps.canResume?.() === false) throw new Error('A turn is still running. Wait before resuming a session.');
  const { meta, messages } = deps.sessionManager.load(sessionId);
  let model = meta.model;
  let provider = meta.provider;
  if (model && deps.selectModel) {
    try {
      const selected = await deps.selectModel(model);
      model = selected.registryKey;
      provider = selected.providerId;
    } catch {
      /* A saved model may no longer exist locally. */
    }
  }
  // Model lookup may yield to a new turn or another resume. Commit the
  // transcript and its identity together only while the source is still idle.
  if (deps.runtime.sessionId !== sourceSessionId || deps.canResume?.() === false) {
    throw new Error('The active session changed or a turn started while resuming. Try again when idle.');
  }
  restoreSessionConversation(sessionId, { meta, messages }, deps.conversation, deps.runtime, deps.surface);
  // Restore this session's message-anchored rewind anchors from its sidecar
  // so /rewind works identically before and after the resume, the in-memory
  // registry is process-local, so a fresh process starts with none for the
  // loaded session.
  const restoredAnchorCount = restoreTurnAnchors(sessionId, deps.surface);
  // Journal replay: recover turns that post-date the loaded snapshot.
  const journalReplay = replayJournalForSession({
    surface: deps.surface,
    sessionId,
    snapshotTimestamp: meta.timestamp ?? 0,
    conversation: deps.conversation,
    persistSnapshot: (replayedMessages) => {
      deps.sessionManager.save(sessionId, replayedMessages as never[], {
        title: deps.conversation.title || meta.title,
        model: meta.model,
        provider: meta.provider,
        timestamp: Date.now(),
        titleSource: meta.titleSource,
        returnContext: meta.returnContext,
        // Machinery: this write exists only to durably close the journal gap
        // the replay just filled. The user's own save/fork/rename acts stamp
        // 'user' at their own call sites (session-workflow.ts).
        saveSource: 'auto',
      });
    },
  });
  // Hydrate the footer's token counters from the resumed (+ journal-replayed)
  // history now, before the caller renders.
  deps.hydrateSessionUsage?.();
  if (provider) deps.runtime.provider = provider;
  if (model) deps.runtime.model = model;
  return {
    meta,
    resumedMessageCount: deps.conversation.getMessageCount(),
    restoredAnchorCount,
    journalReplay,
  };
}
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { saveWorkTreeFolds } from './work-tree-fold-store.js';
import { readConversationMessageSnapshots } from './conversation-message-snapshot.js';
/** Restore both resume entry points from the same clean conversation boundary. */
export function restoreLoadedSession(
  sessionId: string,
  loaded: {
    messages: readonly object[];
    meta: SessionMeta;
  },
  deps: {
    conversation: ConversationManager;
    surface?: SessionSurface | undefined;
    runtime: {
      sessionId: string;
      model: string;
      provider: string;
    };
    restoreTurnAnchors?: ((sessionId: string) => number) | undefined;
  },
): number {
  restoreSessionConversation(sessionId, loaded, deps.conversation, deps.runtime, deps.surface);
  if (loaded.meta.model) deps.runtime.model = loaded.meta.model;
  if (loaded.meta.provider) deps.runtime.provider = loaded.meta.provider;
  return deps.restoreTurnAnchors?.(sessionId) ?? 0;
}
export function copySessionSidecars(
  source: string,
  destination: string,
  conversation: ConversationManager,
  surface?: SessionSurface | undefined,
): void {
  if (source === destination) return;
  clearTurnAnchors(destination);
  for (const anchor of getTurnAnchors(source)) recordTurnAnchor(destination, anchor);
  if (!surface) return;
  if (getTurnAnchors(destination).length === 0) rmSync(join(surface.sessionsDir, `${destination}.anchors.json`), { force: true });
  else persistTurnAnchors(destination, surface);
  saveWorkTreeFolds(surface.sessionsDir, destination, conversation.workTree.foldState(), conversation.workTree.turnOutcomes());
}
function restoreSessionConversation(
  sessionId: string,
  loaded: {
    readonly messages: readonly object[];
    readonly meta: SessionMeta;
  },
  conversation: ConversationManager,
  runtime: Pick<SessionResumeRuntime, 'sessionId'>,
  surface?: SessionSurface | undefined,
): void {
  conversation.resetAll();
  conversation.fromJSON({
    messages: readConversationMessageSnapshots(loaded.messages),
    title: loaded.meta.title,
    titleSource: loaded.meta.titleSource,
  });
  if (surface) restoreWorkTreeFolds(conversation, surface.sessionsDir, sessionId);
  conversation.rebuildHistory();
  runtime.sessionId = sessionId;
}
