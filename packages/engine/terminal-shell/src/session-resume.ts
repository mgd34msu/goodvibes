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
import type { SessionBranches, SessionManager, SessionMeta } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { SessionSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { TerminalConversationManager as ConversationManager } from './terminal-conversation.js';
import { restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import { restoreWorkTreeFolds } from './work-tree-wiring.js';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  checkSessionLiveness,
  removeLivenessMarker,
  replayJournalForSession,
  writeLivenessMarker,
  type ReplayIntoConversationResult,
} from '@goodvibes-jev/engine/platform/platform/runtime/operations';
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
  /**
   * Runs once the resume can no longer be refused, immediately before the
   * transcript is replaced: the place for side effects that must not happen
   * when the resume is refused (revoking a pending offer, for example).
   */
  readonly beforeRestore?: (() => void) | undefined;
}
export interface SessionResumeOutcome {
  readonly meta: SessionMeta;
  readonly resumedMessageCount: number;
  readonly restoredAnchorCount: number;
  readonly journalReplay: ReplayIntoConversationResult;
  /** Steps after the transcript was committed that failed; the resume itself stands. */
  readonly warnings?: readonly string[] | undefined;
  /** Lines for the person about what the resume left out (a damaged side branch); empty when nothing was. */
  readonly notices: readonly string[];
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
  const { meta, messages, branches } = deps.sessionManager.load(sessionId);
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
  deps.beforeRestore?.();
  const leftOut = restoreSessionConversation(sessionId, { meta, messages, ...(branches ? { branches } : {}) }, deps.conversation, deps.runtime, deps.surface);
  // The transcript and its identity are committed above, so the model and
  // provider move with them; the sidecar steps below are recoveries that must
  // not leave the new transcript running on the old model.
  if (provider) deps.runtime.provider = provider;
  if (model) deps.runtime.model = model;
  const warnings: string[] = [];
  const attempt = <Result>(what: string, run: () => Result, fallback: (message: string) => Result): Result => {
    try {
      return run();
    } catch (error) {
      logger.warn(`session resume: ${what} failed`, { sessionId, error: summarizeError(error) });
      const message = summarizeError(error);
      warnings.push(`${what} failed: ${message}`);
      return fallback(message);
    }
  };
  // Restore this session's message-anchored rewind anchors from its sidecar
  // so /rewind works identically before and after the resume, the in-memory
  // registry is process-local, so a fresh process starts with none for the
  // loaded session.
  const restoredAnchorCount = attempt('restoring rewind anchors', () => restoreTurnAnchors(sessionId, deps.surface), () => 0);
  // Journal replay: recover turns that post-date the loaded snapshot.
  const journalReplay = attempt(
    'replaying the transcript journal',
    () =>
      replayJournalForSession({
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
          }, undefined, undefined, deps.conversation.branchState());
          markConversationDurable(deps.conversation, sessionId, 'store');
        },
      }),
    (failed): ReplayIntoConversationResult => ({ replayed: 0, hadCorruptTail: false, failed }),
  );
  // Hydrate the footer's token counters from the resumed (+ journal-replayed)
  // history now, before the caller renders.
  attempt('restoring footer usage', () => deps.hydrateSessionUsage?.(), () => undefined);
  return {
    meta,
    resumedMessageCount: deps.conversation.getMessageCount(),
    restoredAnchorCount,
    journalReplay,
    ...(warnings.length ? { warnings } : {}),
    notices: describeLeftOutBranches(leftOut),
  };
}
import { rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { saveWorkTreeFolds } from './work-tree-fold-store.js';
import { readConversationMessageSnapshots } from './conversation-message-snapshot.js';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/platform/platform/core';
/** Restore both resume entry points from the same clean conversation boundary. */
export function restoreLoadedSession(
  sessionId: string,
  loaded: {
    messages: readonly object[];
    meta: SessionMeta;
    branches?: SessionBranches | undefined;
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
): { readonly restoredAnchorCount: number; readonly leftOutBranches: readonly LeftOutBranch[] } {
  const leftOutBranches = restoreSessionConversation(sessionId, loaded, deps.conversation, deps.runtime, deps.surface);
  if (loaded.meta.model) deps.runtime.model = loaded.meta.model;
  if (loaded.meta.provider) deps.runtime.provider = loaded.meta.provider;
  return { restoredAnchorCount: deps.restoreTurnAnchors?.(sessionId) ?? 0, leftOutBranches };
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
/** A saved side branch a restore could not read, and why. */
export interface LeftOutBranch {
  readonly name: string;
  readonly reason: string;
}

/**
 * The saved side branches this build can read. A damaged one is left out and
 * named in `leftOut`; it must not stop the session's own transcript from
 * resuming. Show `leftOut` with {@link describeLeftOutBranches}.
 */
export function readSavedBranches(
  sessionId: string,
  saved: SessionBranches,
): { readonly branches: Record<string, ConversationMessageSnapshot[]>; readonly leftOut: readonly LeftOutBranch[] } {
  const branches: Record<string, ConversationMessageSnapshot[]> = {};
  const leftOut: LeftOutBranch[] = [];
  for (const [name, messages] of Object.entries(saved.branches)) {
    try {
      branches[name] = readConversationMessageSnapshots(messages);
    } catch (error) {
      const reason = summarizeError(error);
      logger.warn('session resume: a saved branch could not be read and was left out', { sessionId, branch: name, error: reason });
      leftOut.push({ name, reason });
    }
  }
  return { branches, leftOut };
}

/** One line per left-out branch, worded the same in every terminal app. */
export function describeLeftOutBranches(leftOut: readonly LeftOutBranch[]): string[] {
  return leftOut.map(({ name, reason }) =>
    `Side branch "${name}" was left out of the restore because it could not be read (${reason}). `
      + 'The rest of the session was restored; the next save of this session is written without that branch.');
}
function restoreSessionConversation(
  sessionId: string,
  loaded: {
    readonly messages: readonly object[];
    readonly meta: SessionMeta;
    readonly branches?: SessionBranches | undefined;
  },
  conversation: ConversationManager,
  runtime: Pick<SessionResumeRuntime, 'sessionId'>,
  surface?: SessionSurface | undefined,
): readonly LeftOutBranch[] {
  const saved = loaded.branches ? readSavedBranches(sessionId, loaded.branches) : undefined;
  conversation.resetAll();
  conversation.fromJSON({
    messages: readConversationMessageSnapshots(loaded.messages),
    title: loaded.meta.title,
    titleSource: loaded.meta.titleSource,
    ...(saved && loaded.branches ? { branches: saved.branches, currentBranch: loaded.branches.currentBranch } : {}),
  });
  if (surface) restoreWorkTreeFolds(conversation, surface.sessionsDir, sessionId);
  conversation.rebuildHistory();
  const previousSessionId = runtime.sessionId;
  runtime.sessionId = sessionId;
  // What is in memory now is what the store holds, so no crash snapshot is due.
  markConversationDurable(conversation, sessionId, 'store');
  if (surface) moveLiveSessionArtifacts(surface, previousSessionId, sessionId);
  return saved?.leftOut ?? [];
}

// ─── The live session's crash snapshot and identity ─────────────────────────
//
// A crash snapshot is written only while the conversation holds something its
// session's store does not; the conversation's revision counter is how a writer
// tells (one integer compare). Every write of the conversation, a store save or
// a snapshot, records the revision it wrote here, keyed by the conversation
// object, so the turn wiring, the minute timer and the exit path of one terminal
// share one answer without being wired to each other.

/** A conversation that counts its own changes. */
export interface RevisionedConversation {
  readonly revisionSource: { revision(): number };
}

/** Where the conversation was last written: its session's store, or a crash snapshot. */
export type DurableCopy = 'store' | 'snapshot';

const durableCopies = new WeakMap<object, { readonly revision: number; readonly sessionId: string; readonly copy: DurableCopy }>();

/** Record that `conversation`, as it is now, is on disk for `sessionId` (`copy` says where). */
export function markConversationDurable(conversation: RevisionedConversation, sessionId: string, copy: DurableCopy): void {
  durableCopies.set(conversation, { revision: conversation.revisionSource.revision(), sessionId, copy });
}

/** True when `conversation` changed since it was last written for `sessionId`, or was never written. */
export function conversationChangedSinceDurable(conversation: RevisionedConversation, sessionId: string): boolean {
  const last = durableCopies.get(conversation);
  return last === undefined || last.sessionId !== sessionId || last.revision !== conversation.revisionSource.revision();
}

/**
 * Keep an unchanged crash snapshot looking live without rewriting it: one
 * `utimes` on the snapshot when it is the newest copy of the conversation. A
 * reader that judges liveness by the file's time (an older build) then does not
 * take this terminal's working state for a crash. Never touches a snapshot the
 * store has already superseded, which a newer time would bring back to life.
 */
export function keepCrashSnapshotFresh(surface: SessionSurface, conversation: RevisionedConversation, sessionId: string): void {
  const last = durableCopies.get(conversation);
  if (last?.copy !== 'snapshot' || conversationChangedSinceDurable(conversation, sessionId)) return;
  try {
    const now = new Date();
    utimesSync(surface.recoveryFile(sessionId), now, now);
  } catch {
    // No snapshot on disk: nothing to keep fresh.
  }
}

/**
 * The session-keyed liveness marker follows a change of the live session id (a
 * resume, a fork, `/session save <name>`, a recovery restore, `--continue`):
 * `to` is marked open here and `from`'s marker goes, so a second terminal
 * neither takes `from` for open nor `to` for closed. When another terminal has
 * taken `from` over, its marker is that terminal's and is left alone.
 *
 * `from`'s crash snapshot is not touched: the writers delete it at every
 * successful save, so one still on disk holds something `from`'s store does
 * not (a save that failed, a change made outside a turn) and is offered at the
 * next launch like any other unsaved work.
 */
export function moveLiveSessionArtifacts(surface: SessionSurface, from: string, to: string): void {
  if (from === to) return;
  writeLivenessMarker(surface, to);
  const holder = checkSessionLiveness(surface, from);
  if (holder.live && holder.pid !== process.pid) return;
  removeLivenessMarker(surface, from);
}

/** What `loadSavedSessionIntoLive` needs from the shell that runs it. */
export interface LoadSavedSessionDeps {
  readonly conversation: ConversationManager;
  readonly runtime: SessionResumeRuntime;
  readonly surface?: SessionSurface | undefined;
  readonly restoreTurnAnchors?: ((sessionId: string) => number) | undefined;
  /** True while a turn is still appending to the live conversation; a load is refused then. */
  readonly isGenerating?: (() => boolean) | undefined;
  /** Runs after the live conversation and identity moved to the loaded session. */
  readonly afterSwitch?: ((sessionId: string) => void) | undefined;
}

export interface LoadedSavedSession {
  readonly name: string;
  readonly meta: SessionMeta;
  readonly messageCount: number;
  readonly agentRecords: ReturnType<SessionManager['load']>['agentRecords'];
  readonly restoredAnchorCount: number;
  /** Lines for the person about what the load left out (a damaged side branch); empty when nothing was. */
  readonly notices: readonly string[];
}

/** Options of {@link loadSavedSessionIntoLive}. */
export interface LoadSavedSessionOptions {
  /** Take over a session another running terminal has marked open (`/session resume <id> --force`). */
  readonly force?: boolean | undefined;
}

/**
 * The one way a saved session replaces the live conversation (`/session resume`, `/load`,
 * the `/sessions` list, the session picker). It refuses while a turn runs, reads and
 * validates the saved messages before touching the live conversation, and then switches the
 * session identity the same way a resume does, so later autosaves go to the loaded session
 * instead of overwriting the one that was open. A session another running terminal has marked
 * open is refused (`/session resume <name> --force` is the explicit way to take it over), and
 * the liveness marker moves with the identity (moveLiveSessionArtifacts) so a second terminal
 * sees the new session as open right away. Throws with the reason when the load does not happen; the live conversation is
 * untouched then.
 */
export function loadSavedSessionIntoLive(
  deps: LoadSavedSessionDeps,
  sessionManager: Pick<SessionManager, 'load'>,
  name: string,
  options: LoadSavedSessionOptions = {},
): LoadedSavedSession {
  if (deps.isGenerating?.()) {
    throw new Error('A turn is still running. Stop it with Esc or let it finish, then load the session.');
  }
  const surface = deps.surface;
  // Two terminals saving one session overwrite each other's turns; one small marker read per load.
  if (surface && !options.force) {
    const liveness = checkSessionLiveness(surface, name);
    if (liveness.live && liveness.pid !== process.pid) {
      throw new Error(
        `Session ${name} appears open in another terminal (pid ${liveness.pid}): loading it here would fork its live state. `
          + `Run \`/session resume ${name} --force\` to take it over anyway.`,
      );
    }
  }
  const { meta, messages, agentRecords, branches } = sessionManager.load(name);
  readConversationMessageSnapshots(messages);
  const { restoredAnchorCount, leftOutBranches } = restoreLoadedSession(
    name,
    { meta, messages, ...(branches ? { branches } : {}) },
    { conversation: deps.conversation, runtime: deps.runtime, surface, restoreTurnAnchors: deps.restoreTurnAnchors },
  );
  deps.afterSwitch?.(name);
  return { name, meta, messageCount: messages.length, agentRecords, restoredAnchorCount, notices: describeLeftOutBranches(leftOutBranches) };
}
