/**
 * user-turn.ts, the one owner of "one user turn, possibly retried on another
 * provider".
 *
 * A user turn starts at a TURN_SUBMITTED, may fail over (its attempt failed and
 * a retry on another provider is on its way) any number of times, and ends
 * once: completed, failed, cancelled, or superseded (a new prompt or a session
 * switch replaced it before it ended). This module is the only subscriber that
 * decides that state. The stream wiring decides what a failed attempt does
 * (show the error, or start a failover retry) through `onFailure`, synchronously
 * inside the one TURN_ERROR handler, so nothing depends on which wiring
 * subscribed first, on a microtask, or on a grace timer. The turn-end notice,
 * the failover restore and the retry affordance read `onEnd`.
 */
import type { TurnEvent } from '@goodvibes-jev/engine/platform/events';
import type { UiRuntimeEvents } from '@/runtime/index.ts';
import { defineLifecycle, logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

type TurnErrorEvent = Extract<TurnEvent, { type: 'TURN_ERROR' }>;

/** The phases of one user turn. */
export type UserTurnPhase = 'running' | 'failing-over' | 'ended';
/** The owner's state: `idle` before the first turn of this shell. */
export type UserTurnState = 'idle' | UserTurnPhase;

export const USER_TURN_LIFECYCLE = defineLifecycle<UserTurnPhase>('user turn', {
  running: ['failing-over', 'ended'],
  'failing-over': ['running', 'ended'],
  ended: [],
});

/** How a user turn ended. `superseded` is not told to the user: a new prompt or session replaced it. */
export type UserTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'superseded';

export interface UserTurnStart {
  /** The attempt's turn id, undefined for an event that carried none. */
  readonly turnId: string | undefined;
  readonly prompt: string | null;
  /** True when this attempt is a failover retry of the same user turn. */
  readonly continued: boolean;
}

export interface UserTurnEnd {
  readonly outcome: UserTurnOutcome;
  /** The failure or cancellation text as the event carried it, null when there is none. */
  readonly reason: string | null;
  /** The last attempt's turn id, undefined for an event that carried none. */
  readonly turnId: string | undefined;
  /** When the user turn started, null when its TURN_SUBMITTED was not seen. */
  readonly startedAt: number | null;
  readonly attempts: number;
}

/** A failover retry on its way: what the retry path reads and reports. */
export interface FailoverRetry {
  /** Aborted when the turn ends, is cancelled or is superseded before the retry starts. */
  readonly signal: AbortSignal;
  /** Still this user turn, still failing over with this retry. */
  readonly isCurrent: () => boolean;
  /** The retry is submitting now: the next TURN_SUBMITTED continues this user turn. */
  readonly submitting: () => void;
  /** The retry did not start: the user turn ends failed with its original error. */
  readonly abandon: () => void;
}

/** One failed attempt, handed to the failure handler inside the TURN_ERROR handler. */
export interface TurnFailure {
  readonly event: TurnErrorEvent;
  /** Retry the user turn on another provider. Returns the same retry when called again. */
  readonly failOver: () => FailoverRetry;
  /** This user turn is still the latest one in the same session. */
  readonly isCurrent: () => boolean;
  /** No retry of this user turn has started since this attempt failed (a late line about it may still be added). */
  readonly isLatestAttempt: () => boolean;
}

export interface UserTurnOwner {
  readonly state: () => UserTurnState;
  /** What a failed attempt does. One handler; a later call replaces it. Without one, the turn ends failed. */
  readonly onFailure: (handler: (failure: TurnFailure) => void) => () => void;
  readonly onStart: (listener: (start: UserTurnStart) => void) => () => void;
  readonly onEnd: (listener: (end: UserTurnEnd) => void) => () => void;
  /** Cancel a turn that is failing over (no attempt is running, so no TURN_CANCEL will come). */
  readonly cancel: () => boolean;
  /** A new prompt is about to be submitted: a turn that has not ended is replaced, not told. */
  readonly supersede: () => void;
  readonly dispose: () => void;
}

export interface UserTurnOwnerOptions {
  readonly turns: Pick<UiRuntimeEvents['turns'], 'on'>;
  readonly sessionId: () => string;
  readonly clock?: () => number;
}

interface RetryRecord {
  readonly controller: AbortController;
  submitting: boolean;
}

interface Turn {
  phase: UserTurnPhase;
  attemptId: string | undefined;
  /** When its TURN_SUBMITTED was seen; null for a turn first seen at its terminal event. */
  readonly startedAt: number | null;
  readonly sessionId: string;
  readonly generation: number;
  attempts: number;
  retry: RetryRecord | undefined;
  failure: string | null;
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
    current.retry?.controller.abort();
    current.retry = undefined;
    const told: UserTurnEnd = { outcome, reason, turnId: current.attemptId, startedAt: current.startedAt, attempts: current.attempts };
    for (const listener of [...endListeners]) safely('end listener', () => listener(told));
  };

  const begin = (attemptId: string | undefined, startedAt: number | null): Turn => {
    generation++;
    turn = { phase: 'running', attemptId, startedAt, sessionId: options.sessionId(), generation, attempts: 1, retry: undefined, failure: null };
    return turn;
  };

  /** A failover retry's attempt: the same user turn runs again. */
  const continueWith = (current: Turn, attemptId: string | undefined, prompt: string | null): void => {
    move(current, 'running');
    current.retry = undefined;
    current.attemptId = attemptId;
    current.attempts++;
    const started: UserTurnStart = { turnId: attemptId, prompt, continued: true };
    for (const listener of [...startListeners]) safely('start listener', () => listener(started));
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
    if (turn.phase === 'failing-over') {
      // The failed attempt again is stale; any other attempt is the retry's.
      if (sameAttempt) return undefined;
      continueWith(turn, turnId, null);
    } else if (turnId !== undefined && known !== undefined && !sameAttempt) {
      return undefined;
    }
    // An attempt that ends after the session moved on was replaced, not finished.
    if (turn.sessionId !== options.sessionId()) {
      end(turn, 'superseded', null);
      return undefined;
    }
    return turn;
  };

  const retryFor = (current: Turn): FailoverRetry => {
    const record: RetryRecord = { controller: new AbortController(), submitting: false };
    current.retry = record;
    move(current, 'failing-over');
    const isCurrent = (): boolean => !disposed && turn === current && current.phase === 'failing-over' && current.retry === record
      && current.sessionId === options.sessionId();
    return {
      signal: record.controller.signal,
      isCurrent,
      submitting: () => { if (isCurrent()) record.submitting = true; },
      abandon: () => { if (current.retry === record && current.phase === 'failing-over') end(current, 'failed', current.failure); },
    };
  };

  // Handlers read `event?.` because a bare test feed may emit an event with no payload.
  const unsubs = [
    options.turns.on('TURN_SUBMITTED', (event) => {
      const turnId = event?.turnId;
      const prompt = typeof event?.prompt === 'string' ? event.prompt : null;
      if (turn !== undefined && turn.phase === 'failing-over' && turn.retry?.submitting === true && turn.sessionId === options.sessionId()) {
        continueWith(turn, turnId, prompt);
        return;
      }
      if (turn !== undefined) end(turn, 'superseded', null);
      begin(turnId, clock());
      const started: UserTurnStart = { turnId, prompt, continued: false };
      for (const listener of [...startListeners]) safely('start listener', () => listener(started));
    }),
    options.turns.on('TURN_ERROR', (event) => {
      const current = owning(event?.turnId);
      if (current === undefined) return;
      current.failure = event.error;
      let retry: FailoverRetry | undefined;
      const attempt = current.attempts;
      const isCurrent = (): boolean => !disposed && current.generation === generation && current.sessionId === options.sessionId();
      const failure: TurnFailure = {
        event,
        failOver: () => (retry ??= retryFor(current)),
        isCurrent,
        isLatestAttempt: () => isCurrent() && current.attempts === attempt,
      };
      if (failureHandler) safely('failure handler', () => failureHandler!(failure));
      // Without a failover the attempt's failure ends the user turn. With one,
      // the retry owns the ending (a synchronous retry may already be running).
      if (retry === undefined) end(current, 'failed', event.error);
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
    cancel() {
      if (turn === undefined || turn.phase !== 'failing-over') return false;
      end(turn, 'cancelled', 'User cancelled');
      return true;
    },
    supersede() {
      generation++;
      if (turn !== undefined) end(turn, 'superseded', null);
    },
    dispose() {
      disposed = true;
      for (const unsub of unsubs) unsub();
      turn?.retry?.controller.abort();
      startListeners.clear();
      endListeners.clear();
      failureHandler = undefined;
    },
  };
}
