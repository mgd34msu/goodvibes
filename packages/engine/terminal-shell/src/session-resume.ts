/**
 * The one way a saved session replaces the live conversation.
 *
 * `resumeSessionCore` is the routine: every command that opens a saved session
 * (`/session resume`, `/load`, Enter in `/sessions`, the session picker and
 * browser, the start-up resume flags) runs it, so the turns that exist only in
 * the transcript journal come back, the saved model is re-resolved through the
 * live provider registry, rewind anchors and footer usage are restored and the
 * session's agent records replace the live list, whichever command was typed.
 * `loadSavedSessionIntoLive` is the same routine behind the refusals a command
 * needs (a running turn, a session another terminal holds open).
 *
 * Callers own what is theirs alone: printing the outcome, and the publication
 * of the resumed session (last-session pointer, shared session, hooks).
 *
 * What waits for a session (the owner's answers to questions it asked while it
 * was closed) is handed to it at the end of the routine, through the listener
 * the app registered for its conversation with {@link whenSessionOpens}, so a
 * headless run has it before its first request.
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
/** Runs when a saved session becomes the live one in `conversation`; awaited by the resume routine. */
export type SessionOpenedListener = (sessionId: string) => Promise<unknown>;

const sessionOpenedListeners = new WeakMap<object, SessionOpenedListener>();

/**
 * Register what to do when a saved session is opened into `conversation`
 * (every resume path: `/session resume`, `/load`, the pickers, start-up and
 * headless resume flags). One listener per conversation; registering again
 * replaces it. Returns the unregister function.
 */
export function whenSessionOpens(conversation: object, listener: SessionOpenedListener): () => void {
  sessionOpenedListeners.set(conversation, listener);
  return () => {
    if (sessionOpenedListeners.get(conversation) === listener) sessionOpenedListeners.delete(conversation);
  };
}

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
   * seam. A shell with no session storage (a test harness) omits it; nothing
   * is read from sidecars or the journal then.
   */
  readonly surface?: SessionSurface | undefined;
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
  /**
   * The live agent list. When given, the session's saved agent records replace
   * it once the transcript is committed, so every command that opens a session
   * brings its agents back the same way.
   */
  readonly agents?: SessionAgentRecordSink | undefined;
}
/** The agent records saved with a session. */
export type SavedAgentRecords = ReturnType<SessionManager['load']>['agentRecords'];
/** What the resume needs from the agent manager to restore a session's agent records. */
export interface SessionAgentRecordSink {
  clear(): void;
  importState(records: SavedAgentRecords): void;
}
export interface SessionResumeOutcome {
  readonly meta: SessionMeta;
  /** Messages in the saved snapshot, before any journal replay. */
  readonly savedMessageCount: number;
  /** The agent records saved with the session. */
  readonly agentRecords: SavedAgentRecords;
  /** How many of them replaced the live agent list (0 when no agent list was given). */
  readonly agentRecordsRestored: number;
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
 * restore rewind anchors and agent records, replay any post-snapshot journal
 * records, reselect the model and hydrate footer usage.
 *
 * Sessions saved by an older TUI can carry a legacy pane list in their
 * return context (`returnContext.openPanels` plus an "Open panels: ..."
 * line). The platform's session loader (`loadedReturnContext`) drops both, so
 * `meta.returnContext` here never has them, and the journal-replay rewrite
 * below writes the session back without them.
 */
export async function resumeSessionCore(sessionId: string, deps: SessionResumeDeps): Promise<SessionResumeOutcome> {
  if (deps.canResume?.() === false) throw new Error('A turn is still running. Wait before resuming a session.');
  const { meta, messages, branches, agentRecords } = deps.sessionManager.load(sessionId);
  // Nothing below yields until the transcript and its identity are committed,
  // so no turn or other resume can slip in between the check and the commit.
  deps.beforeRestore?.();
  const leftOut = restoreSessionConversation(sessionId, { meta, messages, ...(branches ? { branches } : {}) }, deps.conversation, deps.runtime, deps.surface);
  // The model and provider move with the committed transcript; the sidecar
  // steps below are recoveries that must not leave it running on the old model.
  if (meta.provider) deps.runtime.provider = meta.provider;
  if (meta.model) deps.runtime.model = meta.model;
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
  const surface = deps.surface;
  const restoredAnchorCount = surface ? attempt('restoring rewind anchors', () => restoreTurnAnchors(sessionId, surface), () => 0) : 0;
  // The session's agent records replace the live list with the transcript.
  const agentRecordsRestored = deps.agents
    ? attempt('restoring agent records', () => {
        deps.agents?.clear();
        if (agentRecords.length > 0) deps.agents?.importState(agentRecords);
        return agentRecords.length;
      }, () => 0)
    : 0;
  // Journal replay: recover turns that post-date the loaded snapshot.
  const journalReplay: ReplayIntoConversationResult = !surface ? { replayed: 0, hadCorruptTail: false } : attempt(
    'replaying the transcript journal',
    () =>
      replayJournalForSession({
        surface,
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
  // The saved model is re-resolved through the live provider registry only now:
  // selecting it changes the registry's current model, which a refused resume
  // must never do. It applies only while the resumed session is still the live one.
  if (meta.model && deps.selectModel) {
    try {
      const selected = await deps.selectModel(meta.model);
      if (deps.runtime.sessionId === sessionId) {
        deps.runtime.model = selected.registryKey;
        deps.runtime.provider = selected.providerId;
      }
    } catch {
      /* A saved model may no longer exist locally; the saved id stands. */
    }
  }
  // Hydrate the footer's token counters from the resumed (+ journal-replayed)
  // history now, before the caller renders.
  attempt('restoring footer usage', () => deps.hydrateSessionUsage?.(), () => undefined);
  // What waited for this session while it was closed goes into its conversation
  // now, before the next request; a failure leaves it waiting for the next open.
  const opened = sessionOpenedListeners.get(deps.conversation);
  if (opened && deps.runtime.sessionId === sessionId) {
    try {
      await opened(sessionId);
    } catch (error) {
      logger.warn('session resume: handing over what waited for the session failed', { sessionId, error: summarizeError(error) });
    }
  }
  return {
    meta,
    savedMessageCount: messages.length,
    agentRecords,
    agentRecordsRestored,
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

/**
 * What a resume left out or could not recover, one line each, worded the same
 * in every command that opens a saved session: damaged side branches, recovery
 * steps that failed after the transcript was committed, and journal turns that
 * could not be put back. Empty when the resume restored everything.
 */
export function describeResumeShortfalls(outcome: Pick<SessionResumeOutcome, 'notices' | 'warnings' | 'journalReplay'>): string[] {
  return [
    ...outcome.notices,
    ...(outcome.warnings ?? []).map((warning) => `${warning}; the loaded conversation stands.`),
    ...(outcome.journalReplay.failed !== undefined
      ? [`The turns written since the last save could not be put back (${outcome.journalReplay.failed}); the journal file was kept and is read again at the next resume.`]
      : []),
  ];
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
  // Read before the live conversation is cleared: a saved message this build
  // cannot read refuses the restore with the live conversation untouched.
  const messages = readConversationMessageSnapshots(loaded.messages);
  conversation.resetAll();
  conversation.fromJSON({
    messages,
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
  /** Re-resolves the saved model through the live provider registry; see {@link SessionResumeDeps.selectModel}. */
  readonly selectModel?: SessionResumeDeps['selectModel'];
  readonly hydrateSessionUsage?: (() => void) | undefined;
  /** The live agent list the session's saved agent records replace. */
  readonly agents?: SessionAgentRecordSink | undefined;
  /** True while a turn is still appending to the live conversation; a load is refused then. */
  readonly isGenerating?: (() => boolean) | undefined;
  /** Runs after the live conversation and identity moved to the loaded session. */
  readonly afterSwitch?: ((sessionId: string) => void) | undefined;
  /**
   * Runs when the load passed its refusal checks and then failed to read or
   * restore the saved session (the error is rethrown after it). Refusals do not call it.
   */
  readonly recoveryFailed?: ((sessionId: string, error: unknown) => void) | undefined;
}

export interface LoadedSavedSession extends SessionResumeOutcome {
  readonly name: string;
  /** Messages now in the conversation: the saved snapshot plus any turns recovered from the journal. */
  readonly messageCount: number;
}

/** Options of {@link loadSavedSessionIntoLive}. */
export interface LoadSavedSessionOptions {
  /** Take over a session another running terminal has marked open (`/session resume <id> --force`). */
  readonly force?: boolean | undefined;
}

/**
 * `resumeSessionCore` behind the refusals a command needs (`/session resume`, `/load`,
 * the `/sessions` list, the session picker). It refuses while a turn runs and refuses a
 * session another running terminal has marked open (`/session resume <name> --force` is
 * the explicit way to take it over); the routine then reads and validates the saved
 * messages before touching the live conversation and switches the session identity, so
 * later autosaves go to the loaded session. The liveness marker moves with the identity
 * (moveLiveSessionArtifacts) so a second terminal sees the new session as open right away.
 * Throws with the reason when the load does not happen; the live conversation is
 * untouched then.
 */
export async function loadSavedSessionIntoLive(
  deps: LoadSavedSessionDeps,
  sessionManager: Pick<SessionManager, 'load' | 'save'>,
  name: string,
  options: LoadSavedSessionOptions = {},
): Promise<LoadedSavedSession> {
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
  let outcome: SessionResumeOutcome;
  try {
    outcome = await resumeSessionCore(name, {
      sessionManager,
      conversation: deps.conversation,
      runtime: deps.runtime,
      surface,
      selectModel: deps.selectModel,
      hydrateSessionUsage: deps.hydrateSessionUsage,
      canResume: () => !deps.isGenerating?.(),
      agents: deps.agents,
    });
  } catch (error) {
    deps.recoveryFailed?.(name, error);
    throw error;
  }
  deps.afterSwitch?.(name);
  return { ...outcome, name, messageCount: outcome.resumedMessageCount };
}
