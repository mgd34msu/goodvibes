/**
 * user-turn.ts, the one owner of "one user turn".
 *
 * A user turn starts at a TURN_SUBMITTED and ends once: completed, failed,
 * cancelled, or superseded (a new prompt or a session switch replaced it
 * before it ended). A provider failure inside the turn is moved along the
 * fallback order by the engine's turn loop (providers/failover.ts), so a turn
 * that reaches TURN_ERROR has failed for good. This module is the only
 * subscriber that decides that state. The stream wiring shows a failure through
 * `onFailure`, synchronously inside the one TURN_ERROR handler, so nothing
 * depends on which wiring subscribed first, on a microtask, or on a grace
 * timer. The turn-end notice and the retry affordance read `onEnd`.
 */
import type { TurnEvent } from '@goodvibes-jev/engine/platform/events';
import type { UiRuntimeEvents } from '@/runtime/index.ts';
import { defineLifecycle, logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

type TurnErrorEvent = Extract<TurnEvent, { type: 'TURN_ERROR' }>;

/** The phases of one user turn. */
export type UserTurnPhase = 'running' | 'ended';
/** The owner's state: `idle` before the first turn of this shell. */
export type UserTurnState = 'idle' | UserTurnPhase;

export const USER_TURN_LIFECYCLE = defineLifecycle<UserTurnPhase>('user turn', {
  running: ['ended'],
  ended: [],
});

/** How a user turn ended. `superseded` is not told to the user: a new prompt or session replaced it. */
export type UserTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'superseded';

export interface UserTurnStart {
  /** The attempt's turn id, undefined for an event that carried none. */
  readonly turnId: string | undefined;
  readonly prompt: string | null;
}

export interface UserTurnEnd {
  readonly outcome: UserTurnOutcome;
  /** The failure or cancellation text as the event carried it, null when there is none. */
  readonly reason: string | null;
  /** The last attempt's turn id, undefined for an event that carried none. */
  readonly turnId: string | undefined;
  /** When the user turn started, null when its TURN_SUBMITTED was not seen. */
  readonly startedAt: number | null;
}

/** The failed turn, handed to the failure handler inside the TURN_ERROR handler. */
export interface TurnFailure {
  readonly event: TurnErrorEvent;
  /** This user turn is still the latest one in the same session (a late line about it may still be added). */
  readonly isCurrent: () => boolean;
}

export interface UserTurnOwner {
  readonly state: () => UserTurnState;
  /** What a failed attempt does. One handler; a later call replaces it. Without one, the turn ends failed. */
  readonly onFailure: (handler: (failure: TurnFailure) => void) => () => void;
  readonly onStart: (listener: (start: UserTurnStart) => void) => () => void;
  readonly onEnd: (listener: (end: UserTurnEnd) => void) => () => void;
  /** A new prompt is about to be submitted: a turn that has not ended is replaced, not told. */
  readonly supersede: () => void;
  readonly dispose: () => void;
}

export interface UserTurnOwnerOptions {
  readonly turns: Pick<UiRuntimeEvents['turns'], 'on'>;
  readonly sessionId: () => string;
  readonly clock?: () => number;
}

interface Turn {
  phase: UserTurnPhase;
  attemptId: string | undefined;
  /** When its TURN_SUBMITTED was seen; null for a turn first seen at its terminal event. */
  readonly startedAt: number | null;
  readonly sessionId: string;
  readonly generation: number;
}

export function createUserTurnOwner(options: UserTurnOwnerOptions): UserTurnOwner {
  const clock = options.clock ?? Date.now;
  const startListeners = new Set<(start: UserTurnStart) => void>();
  const endListeners = new Set<(end: UserTurnEnd) => void>();
  let failureHandler: ((failure: TurnFailure) => void) | undefined;
  let turn: Turn | undefined;
  // Bumped when a turn starts or is superseded, so a late line for an older turn is dropped.
  let generation = 0;
  let disposed = false;

  const safely = (what: string, work: () => void): void => {
    try { work(); } catch (error) { logger.debug(`user turn: ${what} failed`, { error: summarizeError(error) }); }
  };
  const move = (current: Turn, to: UserTurnPhase): void => {
    USER_TURN_LIFECYCLE.assert(current.phase, to);
    current.phase = to;
  };

  const end = (current: Turn, outcome: UserTurnOutcome, reason: string | null): void => {
    if (current.phase === 'ended') return;
    move(current, 'ended');
    const told: UserTurnEnd = { outcome, reason, turnId: current.attemptId, startedAt: current.startedAt };
    for (const listener of [...endListeners]) safely('end listener', () => listener(told));
  };

  const begin = (attemptId: string | undefined, startedAt: number | null): Turn => {
    generation++;
    turn = { phase: 'running', attemptId, startedAt, sessionId: options.sessionId(), generation };
    return turn;
  };

  /**
   * The live turn a terminal event belongs to, or undefined for a stale or
   * settled one. The attempt id decides; an event whose TURN_SUBMITTED was not
   * seen (an emitter that sends none) is attributed by the same rule.
   */
  const owning = (turnId: string | undefined): Turn | undefined => {
    if (turn === undefined) return begin(turnId, null);
    const known = turn.attemptId;
    const sameAttempt = turnId !== undefined && turnId === known;
    if (turn.phase === 'ended') {
      // A late duplicate, or an older attempt after a seen submission, is stale.
      if (sameAttempt || turn.startedAt !== null) return undefined;
      return begin(turnId, null);
    }
    if (turnId !== undefined && known !== undefined && !sameAttempt) return undefined;
    // An attempt that ends after the session moved on was replaced, not finished.
    if (turn.sessionId !== options.sessionId()) {
      end(turn, 'superseded', null);
      return undefined;
    }
    return turn;
  };

  // Handlers read `event?.` because a bare test feed may emit an event with no payload.
  const unsubs = [
    options.turns.on('TURN_SUBMITTED', (event) => {
      const turnId = event?.turnId;
      const prompt = typeof event?.prompt === 'string' ? event.prompt : null;
      if (turn !== undefined) end(turn, 'superseded', null);
      begin(turnId, clock());
      const started: UserTurnStart = { turnId, prompt };
      for (const listener of [...startListeners]) safely('start listener', () => listener(started));
    }),
    options.turns.on('TURN_ERROR', (event) => {
      const current = owning(event?.turnId);
      if (current === undefined) return;
      const isCurrent = (): boolean => !disposed && current.generation === generation && current.sessionId === options.sessionId();
      const failure: TurnFailure = { event, isCurrent };
      if (failureHandler) safely('failure handler', () => failureHandler!(failure));
      end(current, 'failed', event.error);
    }),
    options.turns.on('TURN_COMPLETED', (event) => {
      const current = owning(event?.turnId);
      if (current === undefined) return;
      const completed = event?.stopReason === 'completed';
      end(current, completed ? 'completed' : 'failed', completed ? null : 'The model returned an empty response');
    }),
    options.turns.on('TURN_CANCEL', (event) => {
      const current = owning(event?.turnId);
      if (current !== undefined) end(current, 'cancelled', event?.reason ?? null);
    }),
    options.turns.on('PREFLIGHT_FAIL', (event) => {
      const current = owning(event?.turnId);
      if (current !== undefined) end(current, 'failed', event?.reason ?? null);
    }),
  ];

  return {
    state: () => turn?.phase ?? 'idle',
    onFailure(handler) {
      failureHandler = handler;
      return () => { if (failureHandler === handler) failureHandler = undefined; };
    },
    onStart(listener) {
      startListeners.add(listener);
      return () => { startListeners.delete(listener); };
    },
    onEnd(listener) {
      endListeners.add(listener);
      return () => { endListeners.delete(listener); };
    },
    supersede() {
      generation++;
      if (turn !== undefined) end(turn, 'superseded', null);
    },
    dispose() {
      disposed = true;
      for (const unsub of unsubs) unsub();
      startListeners.clear();
      endListeners.clear();
      failureHandler = undefined;
    },
  };
}
