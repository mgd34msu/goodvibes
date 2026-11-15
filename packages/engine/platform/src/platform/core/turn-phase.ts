/**
 * What an orchestrator is doing for the turn that occupies it, as one value.
 *
 * Every question the product asks ("is it thinking", "does a turn own it",
 * "is a stream block open", "is it compacting") is derived from this single
 * phase, so a turn's end resets all of them with one assignment and no
 * combination of separately stored flags can be left behind.
 *
 * A cancelled turn is still in flight until it settles: it is no longer
 * thinking, but a stream block or a compaction it had open stays open until
 * the code that opened it closes it, so those survive as `settling-*` phases.
 */
export type TurnPhase =
  /** Nothing occupies the orchestrator. */
  | 'idle'
  /** A hosted turn's indicator holds the thinking state; nothing executes here. */
  | 'indicating'
  /** A native turn's permit is held and its body has not started. */
  | 'admitting'
  /** The turn runs: preflight, tool rounds, post-turn work. */
  | 'thinking'
  /** The turn runs and a stream block is open. */
  | 'streaming'
  /** The turn runs and context compaction is in progress. */
  | 'compacting'
  /** In flight but no longer thinking: cancelled, or finishing. */
  | 'settling'
  /** Cancelled with the stream block still open. */
  | 'settling-streaming'
  /** Cancelled with compaction still running. */
  | 'settling-compacting';

/** The product-facing thinking state: a running turn, or a hosted turn's indicator. */
export function phaseIsThinking(phase: TurnPhase): boolean {
  return phase === 'thinking' || phase === 'streaming' || phase === 'compacting' || phase === 'indicating';
}

/** Execution is owned here: a native admission or a turn, including its cancellation and clean-up. */
export function phaseIsInFlight(phase: TurnPhase): boolean {
  return phase !== 'idle' && phase !== 'indicating';
}

/** Anything occupies the orchestrator, so a new turn cannot start now. */
export function phaseIsOccupied(phase: TurnPhase): boolean {
  return phase !== 'idle';
}

export function phaseIsStreaming(phase: TurnPhase): boolean {
  return phase === 'streaming' || phase === 'settling-streaming';
}

export function phaseIsCompacting(phase: TurnPhase): boolean {
  return phase === 'compacting' || phase === 'settling-compacting';
}

/** The thinking state turns on: an idle orchestrator only shows the indicator, an executing one is thinking again. */
export function phaseWithThinking(phase: TurnPhase): TurnPhase {
  switch (phase) {
    case 'idle': return 'indicating';
    case 'admitting':
    case 'settling': return 'thinking';
    case 'settling-streaming': return 'streaming';
    case 'settling-compacting': return 'compacting';
    default: return phase;
  }
}

/** The thinking state turns off (a stop, a cancel, a finished indicator); an open stream or compaction stays open. */
export function phaseWithoutThinking(phase: TurnPhase): TurnPhase {
  switch (phase) {
    case 'indicating': return 'idle';
    case 'thinking': return 'settling';
    case 'streaming': return 'settling-streaming';
    case 'compacting': return 'settling-compacting';
    default: return phase;
  }
}

/** A stream block opens or closes. It cannot open on an idle orchestrator or during compaction, which are never concurrent with a stream. */
export function phaseWithStreaming(phase: TurnPhase, open: boolean): TurnPhase {
  if (open) {
    if (phase === 'thinking') return 'streaming';
    if (phase === 'settling' || phase === 'admitting') return 'settling-streaming';
    return phase;
  }
  if (phase === 'streaming') return 'thinking';
  if (phase === 'settling-streaming') return 'settling';
  return phase;
}

/** Compaction starts or ends. It runs inside a turn, never concurrently with a stream. */
export function phaseWithCompacting(phase: TurnPhase, active: boolean): TurnPhase {
  if (active) {
    if (phase === 'thinking') return 'compacting';
    if (phase === 'settling' || phase === 'admitting') return 'settling-compacting';
    return phase;
  }
  if (phase === 'compacting') return 'thinking';
  if (phase === 'settling-compacting') return 'settling';
  return phase;
}
