/**
 * Restoring a session's crash snapshot into the live conversation: the one
 * routine every terminal app runs, whichever way the snapshot was found (the
 * start-up offer, a session opened later with `/load`, `/sessions`, the picker
 * or `/session resume`, a headless `run --resume` / `--continue`).
 *
 * The snapshot is the conversation as it stood at the last turn moment (prompt
 * accepted, each tool batch done), and records that moment and whether a reply
 * was still arriving. When the process stopped inside a turn, the snapshot ends
 * inside it; that turn is recorded as interrupted and never run again on its
 * own: its prompt is marked cancelled (as Esc marks a prompt), the tool results
 * it already had stay as they were, a reply that was still arriving keeps its
 * text with a line saying it was cut off, and a tool call the model made whose
 * result never reached disk gets a result that says it was interrupted and that
 * its effect is unknown, never a success. The next prompt continues from there.
 *
 * Also here: what a headless run does so a turn killed mid-flight can be
 * recovered (the same turn-moment snapshot the apps write, and the session lock
 * held while the run has its session open).
 */
import type { SessionBranches, SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/platform/platform/core';
import type { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import type { ToolEvent, TurnEvent } from '@goodvibes-jev/engine/platform/events';
import {
  applyRecoverySnapshot,
  closeSessionHere,
  crashSnapshotTurn,
  deleteRecoveryFile,
  openSessionHere,
  writeCrashSnapshotAtTurnMoments,
  writeLastSessionPointer,
  writeRecoveryFile,
  type CrashSnapshotTurn,
  type RecoveryApplyRefusal,
  type RecoveryFileInfo,
  type RecoveryRestoreConfirmation,
  type SessionSnapshot,
  type SessionSurface,
} from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { TerminalConversationManager } from './terminal-conversation.js';
import { describeLeftOutBranches, markConversationDurable, moveLiveSessionArtifacts, readSavedBranches } from './session-resume.js';

export { whenCrashSnapshotFound, type CrashSnapshotHandler, type CrashSnapshotHandling } from './session-crash-offer.js';

/** A tool call the model made whose result never reached disk. */
export interface InterruptedToolCall {
  readonly callId: string;
  readonly tool: string;
}

/** The turn that was running when the process stopped. */
export interface InterruptedTurn {
  /** The prompt of that turn, as typed. */
  readonly prompt: string;
  /** Tool results the turn had already obtained; kept as they were. */
  readonly toolResults: number;
  /** Tool calls with no result on disk; each now has a result recorded as interrupted. */
  readonly interruptedToolCalls: readonly InterruptedToolCall[];
  /** The model's reply was still arriving: its text is kept and marked cut off. */
  readonly partialReply: boolean;
}

/** What restoring a crash snapshot did, in facts a surface can show as they are. */
export interface CrashRecoveryReport {
  readonly sessionId: string;
  /** True when the conversation now holds the recovered messages. */
  readonly applied: boolean;
  /** Why nothing was applied, when `applied` is false. */
  readonly refusal?: RecoveryApplyRefusal | undefined;
  /** True once the snapshot file is gone; false while it is still on disk. */
  readonly retired: boolean;
  /** When the snapshot was written (ms since the epoch). */
  readonly snapshotAt: number;
  /** Messages in the conversation after the restore (0 when nothing was applied). */
  readonly messageCount: number;
  /** Prompts in the recovered conversation. */
  readonly turns: number;
  /** Set when the snapshot ends inside a turn. */
  readonly interruptedTurn?: InterruptedTurn | undefined;
  /** What could not be brought back, one line each; empty when nothing was lost. */
  readonly lost: readonly string[];
}

/** The live objects a restore works on. */
export interface CrashRecoveryInput {
  readonly surface: SessionSurface;
  /** The snapshot to restore, as the check that found it read it. */
  readonly info: RecoveryFileInfo;
  readonly sessionManager: Pick<SessionManager, 'save'> & Partial<Pick<SessionManager, 'load'>>;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly conversation: TerminalConversationManager;
  /** The person's yes (`confirmRecoveryRestore`), or for a headless resume the run's own resume flag. */
  readonly confirmation: RecoveryRestoreConfirmation;
  /** Records the recovered session as the last one; defaults to the surface's pointer. */
  readonly writeLastSessionPointer?: ((sessionId: string) => void) | undefined;
  readonly hydrateSessionUsage?: (() => void) | undefined;
  /** Runs once the live session moved to the recovered one (the daemon spine hand-over). */
  readonly afterSwitch?: ((previousSessionId: string, sessionId: string) => void) | undefined;
}

const INTERRUPTED_TOOL_RESULT = 'Interrupted: the process stopped before this tool call returned. Whether it took effect is unknown; check before relying on it or running it again.';
const CUT_OFF_REPLY = '[Reply cut off: the process stopped while this reply was still arriving. It is incomplete.]';

function promptText(message: Extract<ConversationMessageSnapshot, { role: 'user' }>): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
}

/**
 * Record the turn the snapshot ends inside as interrupted: the prompt marked
 * cancelled, a reply that was still arriving marked cut off, and a result
 * saying "interrupted" for each tool call that has none, placed after the
 * results its message already has. What the snapshot recorded about its turn
 * (`turn`) decides; a snapshot that recorded nothing is judged by its shape (a
 * last assistant message without tool calls reads as finished). Returns the
 * messages unchanged and no turn when the snapshot ends on a finished reply.
 */
export function settleInterruptedTurn(messages: readonly ConversationMessageSnapshot[], turn?: CrashSnapshotTurn): {
  readonly messages: ConversationMessageSnapshot[];
  readonly interrupted?: InterruptedTurn | undefined;
} {
  const lastPrompt = messages.findLastIndex((message) => message.role === 'user');
  const tail = messages.slice(lastPrompt + 1).filter((message) => message.role !== 'system');
  const last = tail.at(-1);
  const finished = turn?.inFlight !== true && last?.role === 'assistant' && !(last.toolCalls?.length);
  if (lastPrompt < 0 || finished) return { messages: [...messages] };
  // The reply still arriving is the last assistant message of the turn.
  const partialAt = turn?.partialReply === true ? messages.findLastIndex((message, index) => index > lastPrompt && message.role === 'assistant') : -1;
  const answered = new Set(tail.flatMap((message) => (message.role === 'tool' ? [message.callId] : [])));
  const interruptedToolCalls: InterruptedToolCall[] = [];
  const settled: ConversationMessageSnapshot[] = [];
  let open: { readonly calls: readonly InterruptedToolCall[] } | null = null;
  const closeOpen = (): void => {
    if (!open) return;
    for (const call of open.calls) {
      settled.push({ role: 'tool', callId: call.callId, toolName: call.tool, content: INTERRUPTED_TOOL_RESULT, outcome: 'cancelled' });
      interruptedToolCalls.push(call);
    }
    open = null;
  };
  messages.forEach((message, index) => {
    if (index > lastPrompt && message.role !== 'tool') closeOpen();
    if (index === lastPrompt && message.role === 'user') {
      settled.push({ ...message, cancelled: true });
      return;
    }
    if (index === partialAt && message.role === 'assistant') {
      settled.push({ ...message, content: message.content ? `${message.content}\n\n${CUT_OFF_REPLY}` : CUT_OFF_REPLY });
    } else {
      settled.push(message);
    }
    if (index > lastPrompt && message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls.filter((call) => !answered.has(call.id)).map((call) => ({ callId: call.id, tool: call.name }));
      open = calls.length > 0 ? { calls } : null;
    }
  });
  closeOpen();
  const prompt = messages[lastPrompt] as Extract<ConversationMessageSnapshot, { role: 'user' }>;
  return {
    messages: settled,
    interrupted: {
      prompt: promptText(prompt),
      toolResults: tail.filter((message) => message.role === 'tool').length,
      interruptedToolCalls,
      partialReply: partialAt >= 0,
    },
  };
}

function refusalLine(refusal: RecoveryApplyRefusal | undefined): string {
  return refusal === 'unusable-snapshot'
    ? 'The snapshot was damaged and held no conversation, so it was discarded; nothing was restored.'
    : refusal === 'apply-failed'
      ? 'The conversation refused the snapshot; it was left on disk and the conversation was put back as it was.'
      : 'The snapshot could not be read; it was left on disk.';
}

/**
 * Restore `info`'s snapshot into the live conversation, move the live session
 * to it, record an interrupted turn as interrupted, save the result to the
 * session store and retire the snapshot. Never throws; the report says what
 * happened.
 */
export function restoreCrashSnapshot(input: CrashRecoveryInput): CrashRecoveryReport {
  const { surface, info, conversation, runtime } = input;
  const sessionId = info.sessionId;
  const lost: string[] = [];
  // Saving over a session replaces the whole file, so side branches made with
  // /branch are carried across: the live conversation's, or else the saved ones.
  const carriedBranches = (): SessionBranches | undefined => {
    const live = conversation.branchState();
    if (Object.keys(live.branches).length > 0 || live.currentBranch !== 'main') return live;
    try {
      return input.sessionManager.load?.(sessionId).branches;
    } catch {
      return undefined;
    }
  };
  const persist = (messages: ConversationMessageSnapshot[]): void => {
    input.sessionManager.save(sessionId, messages as never[], {
      title: conversation.title || '',
      model: runtime.model,
      provider: runtime.provider,
      timestamp: Date.now(),
      titleSource: conversation.getTitleSource(),
      // Recovered on purpose; a retention sweep must not expire it.
      saveSource: 'user',
    }, undefined, undefined, carriedBranches());
  };
  const result = applyRecoverySnapshot({ sessionId, conversation, surface, persistSnapshot: persist, confirmation: input.confirmation });
  if (!result.applied) {
    return { sessionId, applied: false, refusal: result.refusal, retired: result.retired, snapshotAt: info.timestamp, messageCount: 0, turns: 0, lost: [refusalLine(result.refusal)] };
  }
  // Every later snapshot and save keys off runtime.sessionId, so it moves only
  // once the restore really happened, and the session lock moves with it.
  const previousSessionId = runtime.sessionId;
  runtime.sessionId = sessionId;
  try {
    moveLiveSessionArtifacts(surface, previousSessionId, sessionId);
    input.afterSwitch?.(previousSessionId, sessionId);
  } catch (error) {
    logger.warn('[Recovery] Moving to the recovered session left a step undone', { sessionId, error: summarizeError(error) });
  }
  const settled = settleInterruptedTurn(conversation.getMessageSnapshot(), info.turn);
  // The restore reset the live conversation, which dropped the side branches;
  // without them back in memory the next save rewrites the session without them.
  const branches = carriedBranches();
  const readable = branches ? readSavedBranches(sessionId, branches) : undefined;
  let settledInMemory = true;
  if (settled.interrupted || readable) {
    try {
      conversation.fromJSON({
        messages: settled.messages,
        title: conversation.title,
        titleSource: conversation.getTitleSource(),
        ...(readable && branches ? { branches: readable.branches, currentBranch: branches.currentBranch } : {}),
      });
      conversation.rebuildHistory();
    } catch (error) {
      settledInMemory = false;
      logger.warn('[Recovery] Recording the interrupted turn or the side branches failed', { sessionId, error: summarizeError(error) });
      lost.push('The interrupted turn and the side branches could not be added to the restored conversation; it holds the snapshot as it was.');
    }
  }
  if (readable && settledInMemory) lost.push(...describeLeftOutBranches(readable.leftOut));
  if (settled.interrupted) {
    lost.push(`Anything after ${new Date(info.timestamp).toISOString()} was not on disk: model output still arriving then, and tool calls started after it, are not recovered.`);
  }
  let saved = true;
  try {
    persist(conversation.getMessageSnapshot());
    markConversationDurable(conversation, sessionId, 'store');
  } catch (error) {
    saved = false;
    logger.warn('[Recovery] The recovered session could not be saved', { sessionId, error: summarizeError(error) });
    lost.push('The recovered conversation could not be saved to the session store; it is in memory and is saved again after the next turn.');
  }
  try {
    (input.writeLastSessionPointer ?? ((id: string) => writeLastSessionPointer(id, { surface })))(sessionId);
    input.hydrateSessionUsage?.();
  } catch (error) {
    logger.warn('[Recovery] Recording the recovered session failed', { sessionId, error: summarizeError(error) });
  }
  if (!result.retired && saved) lost.push('The snapshot file could not be removed; it is superseded by the saved session and is not offered again.');
  const messages = conversation.getMessageSnapshot();
  return {
    sessionId,
    applied: true,
    retired: result.retired,
    snapshotAt: info.timestamp,
    messageCount: messages.length,
    turns: messages.filter((message) => message.role === 'user').length,
    ...(settled.interrupted && settledInMemory ? { interruptedTurn: settled.interrupted } : {}),
    lost,
  };
}

/** One line for the person: what a restore brought back and what it could not. */
export function describeCrashRecovery(report: CrashRecoveryReport): string {
  if (!report.applied) return `[Recovery] Session ${report.sessionId}: crash snapshot not restored. ${report.lost.join(' ')}`;
  const parts = [`[Recovery] Restored session ${report.sessionId} from its crash snapshot of ${new Date(report.snapshotAt).toISOString()}: ${report.messageCount} message(s), ${report.turns} prompt(s).`];
  const turn = report.interruptedTurn;
  if (turn) {
    const calls = turn.interruptedToolCalls;
    parts.push(`The interrupted prompt was kept, marked cancelled, with ${turn.toolResults} tool result(s) it had already obtained`
      + (turn.partialReply ? '; the reply that was still arriving is kept, marked cut off' : '')
      + (calls.length > 0 ? `; ${calls.length} tool call(s) recorded as interrupted (${calls.map((call) => call.tool).join(', ')}), outcome unknown.` : '.'));
  }
  if (report.lost.length > 0) parts.push(report.lost.join(' '));
  return parts.join(' ');
}

/** What a headless run keeps so a turn killed mid-flight can be recovered. */
export interface HeadlessRecoverability {
  /** The run's session was saved: its snapshot holds nothing the store does not, so it is removed. */
  saved(): void;
  /** Stop writing snapshots and let the session go. */
  dispose(): void;
}

/**
 * Write the crash snapshot at the same turn moments as the apps
 * (`writeCrashSnapshotAtTurnMoments`) and hold the session's lock while the
 * run has its session open. The first snapshot also records the session as the
 * last one, so `run --continue` after a killed run reaches it.
 *
 * Cost per turn: one atomic write (temp file and rename) of the whole
 * conversation when the prompt is accepted and after tool batches (at most one
 * per five seconds, the last batch written when the window ends), each
 * the size of the session's messages as JSON lines; one pointer write per run;
 * one unlink after the run's session is saved.
 */
export function keepHeadlessSessionRecoverable(input: {
  readonly bus: Pick<RuntimeEventBus, 'on'>;
  readonly surface: SessionSurface;
  readonly runtime: { readonly sessionId: string };
  /** Says whether a reply is still arriving, recorded in each snapshot. */
  readonly conversation: { hasPartialReply(): boolean };
  readonly snapshot: () => SessionSnapshot;
  readonly title: () => string;
  readonly writeSessionPointer: (sessionId: string) => void;
}): HeadlessRecoverability {
  const { surface, runtime } = input;
  // A resume moves the hold to the resumed session (moveLiveSessionArtifacts).
  const started = runtime.sessionId;
  openSessionHere(surface, started);
  let pointed: string | undefined;
  const stop = writeCrashSnapshotAtTurnMoments({
    subscribe: (moment, handler) => input.bus.on<TurnEvent>(moment, () => handler()),
    subscribeToolStart: (handler) => input.bus.on<ToolEvent>('TOOL_EXECUTING', () => handler()),
    write: (moment) => {
      const sessionId = runtime.sessionId;
      // The session lock's backstop: a hold that another process had (a forced resume) is taken once it left.
      openSessionHere(surface, sessionId);
      const snapshot = { ...input.snapshot(), turn: crashSnapshotTurn(moment, input.conversation) };
      if (!writeRecoveryFile(snapshot, sessionId, input.title(), { surface })) return;
      if (pointed === sessionId) return;
      pointed = sessionId;
      input.writeSessionPointer(sessionId);
    },
  });
  return {
    saved: () => deleteRecoveryFile({ surface }, runtime.sessionId),
    dispose: () => {
      stop();
      closeSessionHere(surface, runtime.sessionId);
      closeSessionHere(surface, started);
    },
  };
}
