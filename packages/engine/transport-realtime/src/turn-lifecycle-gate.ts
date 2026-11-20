/**
 * turn-lifecycle-gate.ts, which turn a frame belongs to, and whether this
 * consumer is the one rendering it.
 *
 * The defect this exists for: a client that opens a fresh event stream per
 * turn and presents no position is replayed the tail of the PREVIOUS turn,
 * terminal frames included. The prior turn's `TURN_COMPLETED` lands in the new
 * turn's consumer, which has never seen that frame, so it finishes, and every
 * real frame of the turn actually running is then dropped as post-terminal
 * noise. The turn that was cut off had already been billed for.
 *
 * Resuming the stream (`Last-Event-ID`) stops the replay at the source. This is
 * the second line: turn frames carry a `turnId`, so a consumer never has to
 * guess. A terminal frame may only finish the turn this consumer is actually
 * rendering; one addressed to any other turn is not this consumer's to act on.
 *
 * The rules, in the order they apply to a frame:
 *
 *  1. No `turnId` ⇒ not a turn frame. Accepted untouched. Session, provider,
 *     agent and ops frames pass straight through.
 *  2. Constructed WITH a `turnId` (a consumer that submitted the turn and knows
 *     its id): accept that turn's frames, ignore every other turn's. Nothing
 *     rebinds, the caller stated which turn it is rendering.
 *  3. Constructed with NOTHING, the default, and the reason a consumer that
 *     passes no options is still protected. The gate binds per session:
 *       - `TURN_SUBMITTED` binds this session to that turn and is accepted. A
 *         turn STARTING is never foreign; it is the turn now being rendered,
 *         and it replaces whichever turn came before.
 *       - While bound to a turn that is still running, a frame is accepted
 *         only if its `turnId` matches.
 *       - While UNBOUND, or bound to a turn that has ended, a terminal frame
 *         (`TURN_COMPLETED`, `TURN_ERROR`, `TURN_CANCEL`, `PREFLIGHT_FAIL`) of
 *         another turn is ignored and does not bind: a consumer that never saw
 *         that turn run has no turn to finish, and this is exactly the
 *         replayed tail.
 *       - In the same state, a NON-terminal frame of a turn not seen complete
 *         binds and is accepted, so a client that attaches to a session
 *         mid-turn still renders it, and so does a client whose copy of the
 *         next turn's `TURN_SUBMITTED` was lost (a relay overflow, a reconnect
 *         past the replay window).
 *
 *  4. A turn this gate has already seen COMPLETE is finished for good: a
 *     replayed `TURN_SUBMITTED` for it does not rebind the session, and a
 *     second `TURN_COMPLETED` for it is dropped. This is what keeps a reconnect
 *     (or a new stream on the same connector) from handing back the tail it
 *     already delivered. Only COMPLETED counts: a failed or cancelled turn may
 *     be submitted again under the same id.
 *
 * What the gate cannot do: a fresh gate that has never seen the previous turn
 * cannot tell its replayed `TURN_SUBMITTED` from a live one, frames carry no
 * ordering. A consumer that waits for one specific turn pins it with `turnId`.
 *
 * Binding is per session because one connection carries every session's
 * frames; a single global binding would drop other sessions' turns wholesale.
 * Frames with no session id share one binding slot, which is the right answer
 * for a stream that only ever carries one session.
 */

import { TURN_SETTLING_EVENTS } from '@goodvibes-jev/engine/transport-core/turn-settlement';

/** Turn frames that END a turn, the ones a replay must never be allowed to deliver (the one settling set). */
export const TERMINAL_TURN_EVENT_TYPES: readonly string[] = TURN_SETTLING_EVENTS;

/** The frame that starts a turn and (re)binds the session to it. */
export const TURN_START_EVENT_TYPE = 'TURN_SUBMITTED';

/**
 * How many sessions one gate remembers a binding for.
 *
 * A gate lives as long as its connection, and a long-lived daemon connection
 * sees every session the host ever runs, so the map is capped and evicts by
 * insertion order. An evicted session is not broken, it is merely unbound
 * again, which its next `TURN_SUBMITTED` fixes.
 */
const DEFAULT_MAX_TRACKED_SESSIONS = 128;

/** Completed turns remembered (all sessions together) before the oldest is forgotten. */
const MAX_FINISHED_TURNS = 512;

const UNSCOPED_SESSION_KEY = '\u0000no-session';

/** The parts of a frame the gate reads. Deliberately structural, envelopes differ by transport. */
export interface TurnLifecycleFrame {
  readonly sessionId?: string | undefined;
  readonly type: string;
  readonly turnId?: string | undefined;
}

export interface TurnLifecycleGateOptions {
  /**
   * The turn this consumer initiated. Omitted ⇒ the gate binds to whichever
   * turn each session is seen to start, which is what protects a consumer that
   * passes nothing.
   */
  readonly turnId?: string | undefined;
  /** Sessions remembered before the oldest binding is evicted. Default 128. */
  readonly maxTrackedSessions?: number | undefined;
}

export interface TurnLifecycleGate {
  /** True when this frame belongs to the turn this consumer is rendering. */
  accepts(frame: TurnLifecycleFrame): boolean;
  /** The turn currently bound for a session, or undefined while unbound. */
  boundTurnId(sessionId?: string | undefined): string | undefined;
  /** Forget every binding. The next `TURN_SUBMITTED` per session rebinds. */
  reset(): void;
}

function readFrameTurnId(frame: TurnLifecycleFrame): string | undefined {
  const turnId = frame.turnId;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined;
}

/** Read the turn identity off an arbitrary payload without trusting its shape. */
export function readTurnLifecycleFrame(
  envelopeSessionId: string | undefined,
  payload: unknown,
): TurnLifecycleFrame | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string') return null;
  const turnId = record.turnId;
  return {
    sessionId: envelopeSessionId,
    type,
    ...(typeof turnId === 'string' ? { turnId } : {}),
  };
}

export function createTurnLifecycleGate(options: TurnLifecycleGateOptions = {}): TurnLifecycleGate {
  const pinnedTurnId = options.turnId;
  const maxTracked = Math.max(1, options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS);
  const boundBySession = new Map<string, { readonly turnId: string; ended: boolean }>();
  const finishedTurns = new Set<string>();

  const keyFor = (sessionId: string | undefined): string => sessionId ?? UNSCOPED_SESSION_KEY;

  const bind = (key: string, turnId: string): void => {
    // Re-insert so the most recently active session is the last to be evicted.
    boundBySession.delete(key);
    boundBySession.set(key, { turnId, ended: false });
    while (boundBySession.size > maxTracked) {
      const oldest = boundBySession.keys().next();
      if (oldest.done) break;
      boundBySession.delete(oldest.value);
    }
  };

  const finishedKey = (sessionKey: string, turnId: string): string => `${sessionKey}\u0000${turnId}`;

  const markFinished = (sessionKey: string, turnId: string): void => {
    finishedTurns.add(finishedKey(sessionKey, turnId));
    if (finishedTurns.size > MAX_FINISHED_TURNS) {
      const oldest = finishedTurns.values().next();
      if (!oldest.done) finishedTurns.delete(oldest.value);
    }
  };

  return {
    accepts(frame: TurnLifecycleFrame): boolean {
      const turnId = readFrameTurnId(frame);
      if (turnId === undefined) return true;
      if (pinnedTurnId !== undefined) return turnId === pinnedTurnId;

      const key = keyFor(frame.sessionId);
      const finished = finishedTurns.has(finishedKey(key, turnId));
      if (frame.type === TURN_START_EVENT_TYPE) {
        if (finished) return false;
        bind(key, turnId);
        return true;
      }
      const bound = boundBySession.get(key);
      const terminal = TERMINAL_TURN_EVENT_TYPES.includes(frame.type);
      if (bound !== undefined && bound.turnId === turnId) {
        if (frame.type === 'TURN_COMPLETED') {
          if (finished) return false;
          markFinished(key, turnId);
        }
        if (terminal) bound.ended = true;
        return true;
      }
      // Another turn's frame. While the bound turn runs it is not this
      // consumer's. Once the bound turn has ended, the session is as good as
      // unbound: the next turn's start frame may have been lost (a relay
      // overflow, a reconnect past the replay window), and its other frames
      // must still bind, or that turn never appears and never finishes.
      if (bound !== undefined && !bound.ended) return false;
      if (terminal || finished) return false;
      bind(key, turnId);
      return true;
    },
    boundTurnId(sessionId?: string | undefined): string | undefined {
      return pinnedTurnId ?? boundBySession.get(keyFor(sessionId))?.turnId;
    },
    reset(): void {
      boundBySession.clear();
      finishedTurns.clear();
    },
  };
}
