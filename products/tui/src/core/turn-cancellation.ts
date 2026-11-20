import type { Orchestrator } from '@goodvibes/engine/platform/platform/core';
import type { SpokenTurnRuntime } from '../audio/spoken-turn-wiring.ts';

/**
 * Stop spoken output and cancel the active turn, including its admission.
 * Returns whether speech was stopped, so that keypress does not also quit.
 */
export function createCancelGeneration(
  orchestrator: Orchestrator,
  spokenTurns: Pick<SpokenTurnRuntime, 'stop'>,
): () => boolean {
  return () => {
    const stoppedSpeech = spokenTurns.stop('Spoken output stopped.');
    if (orchestrator.isThinking || orchestrator.isTurnInFlight) {
      orchestrator.abort();
    }
    return stoppedSpeech;
  };
}

/** The narrow orchestrator surface the per-tool cancel needs. */
export interface ToolCancelOrchestrator {
  /** Cancel ONE in-flight tool call; false when no such call is running. */
  cancelToolCall(callId: string): boolean;
  /** The callIds of tool calls currently in flight. */
  listRunningToolCalls(): readonly string[];
}

/**
 * Builds the "cancel the running tool call" action: stops JUST the currently-
 * running tool call, leaving the turn to continue. The in-process orchestrator
 * holds the per-call AbortController, this is the local-session equivalent of
 * the sessions.toolCalls.cancel wire verb. The cancelled call settles as a
 * structured "cancelled by user" result (partial output preserved) the model
 * adapts to in the same turn.
 *
 * Target selection is honest: the tracked active callId (the live transcript
 * row) when known, else the sole in-flight call when exactly one is running,
 * else nothing (returns false, never guesses which of several to stop).
 * `onCancelled` fires only on a real cancellation, with the callId stopped.
 */
export function createCancelToolCall(
  orchestrator: ToolCancelOrchestrator,
  getActiveToolCallId: () => string | undefined,
  onCancelled: (callId: string) => void,
): () => boolean {
  return () => {
    let target = getActiveToolCallId();
    if (target === undefined) {
      const running = orchestrator.listRunningToolCalls();
      if (running.length === 1) target = running[0];
    }
    if (target === undefined) return false;
    const cancelled = orchestrator.cancelToolCall(target);
    if (cancelled) onCancelled(target);
    return cancelled;
  };
}


/**
 * A retry in two steps: `prepare` (memory refresh), then `submit`, which is the
 * replacement turn's own admission and run. A cancellation or a newer action
 * while it prepares (`signal`, `isCurrent`) stops it before anything is
 * submitted; nothing is aborted, since no turn of this retry runs yet and the
 * running turn, if any, is someone else's. Once submitted, the turn is the
 * platform's and its own cancellation applies. `prepare` failing rejects
 * before `submit`, so what the retry would replace is still there.
 */
export async function runOwnedTurnRetry(options: {
  readonly prepare: () => Promise<unknown>;
  readonly submit: () => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal | undefined;
}): Promise<boolean> {
  if (!options.isCurrent() || options.signal?.aborted) return false;
  await options.prepare();
  if (!options.isCurrent() || options.signal?.aborted) return false;
  await options.submit();
  return true;
}
