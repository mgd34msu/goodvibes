/**
 * hosted-sessions.ts, the sessions THIS process is running, and whether one of
 * them is mid-turn.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Four call sites used to ask the persisting `SharedSessionBroker` a question
 * the agent could already answer about itself:
 *
 *   - inbound continuation dispatch: "which sessions should I poll for work?"
 *   - conversation rewind: "am I holding this session's conversation?"
 *   - the trigger family's `sessionIsLive`
 *   - memory consolidation and the periodic self-update: "is anything busy?"
 *
 * The broker answered them from a cross-surface register this process writes
 * into. As a client it does not own that register, the daemon does, and every
 * one of those questions is about THIS process. So they are answered from what
 * this process actually knows: the set of session ids it is running, and
 * whether a turn is in flight.
 *
 * ── Busy is turn-scoped, deliberately ─────────────────────────────────────
 *
 * `TURN_SUBMITTED` marks a session busy; `TURN_COMPLETED` / `TURN_ERROR` /
 * `TURN_CANCEL` mark it idle again, and so does `PREFLIGHT_FAIL` for a turn
 * this registry saw submitted (a context-window failure ends a turn with no
 * other event). Those are the same terminal events the platform's own power
 * work-signals use, so a cancelled or failed turn releases the busy flag rather
 * than pinning it until the next successful one. A `PREFLIGHT_FAIL` for a turn
 * id never seen submitted is ignored: a rejected duplicate submission reports a
 * fresh id while the real turn is still running. A turn that never reports a
 * terminal event would leave a session busy forever, which errs toward "do not
 * consolidate memory / do not restart the binary", the safe direction for both
 * consumers.
 */
import type { RuntimeEventBus } from '@goodvibes/engine/platform/platform/runtime/state';
import type { TurnEvent } from '@goodvibes/engine/platform/events';
export interface HostedSessionRegistry {
  /** Start counting this session id as hosted here. Idempotent. */
  adopt(sessionId: string): void;
  /** Stop counting it (session closed, or handed to another surface). Idempotent. */
  release(sessionId: string): void;
  /** The hosted set, for the inbound dispatch poller. */
  ids(): readonly string[];
  /** Whether this process is holding that session right now. */
  hosts(sessionId: string): boolean;
  /** How many hosted sessions have a turn in flight. */
  countBusySessions(): number;
  /** Stop listening to the runtime bus. Idempotent. */
  dispose(): void;
}
/** The narrow bus slice this registry subscribes to. */
type TurnBus = Pick<RuntimeEventBus, 'on'>;
/** The turn types that open and close a busy window. */
type TurnStart = Extract<
  TurnEvent,
  {
    type: 'TURN_SUBMITTED';
  }
>;
type TurnEnd = Extract<
  TurnEvent,
  {
    type: 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
  }
>;
type TurnPreflightFail = Extract<
  TurnEvent,
  {
    type: 'PREFLIGHT_FAIL';
  }
>;
/**
 * Build the registry.
 *
 * `bus` is optional so a composition that has no runtime bus (a one-shot CLI
 * subcommand, a narrow test double) still gets a working hosted set, it simply
 * never reports anything busy, which is the honest answer for a process that
 * runs no turns.
 */
export function createHostedSessionRegistry(bus?: TurnBus | undefined): HostedSessionRegistry {
  const hosted = new Set<string>();
  const busy = new Set<string>();
  /** Turn ids submitted and not yet ended, per session, and the session each belongs to. */
  const openTurns = new Map<string, Set<string>>();
  const turnOwner = new Map<string, string>();
  const closeTurns = (sessionId: string): void => {
    for (const turnId of openTurns.get(sessionId) ?? []) turnOwner.delete(turnId);
    openTurns.delete(sessionId);
  };
  const unsubscribes: Array<() => void> = [];
  /** The turn an event is about; a bare envelope without a payload names none. */
  const turnIdOf = (envelope: { readonly payload?: { readonly turnId?: unknown } | undefined }): string | undefined => {
    const turnId = envelope.payload?.turnId;
    return typeof turnId === 'string' ? turnId : undefined;
  };
  /**
   * The session a turn belongs to.
   *
   * The envelope carries the id when the emitter had one; a turn emitted before
   * the session id was final does not. In that case the turn belongs to
   * whichever session this process is holding, an agent process runs one
   * interactive session, so the single hosted id is used rather than the signal
   * being dropped.
   */
  const sessionForTurn = (envelopeSessionId: string | undefined): string | null => {
    if (typeof envelopeSessionId === 'string' && envelopeSessionId.length > 0) return envelopeSessionId;
    const only = hosted.size === 1 ? [...hosted][0] : undefined;
    return only ?? null;
  };
  if (bus) {
    unsubscribes.push(
      bus.on<TurnStart>('TURN_SUBMITTED', (envelope) => {
        const sessionId = sessionForTurn(envelope.sessionId);
        if (!sessionId) return;
        busy.add(sessionId);
        const turnId = turnIdOf(envelope);
        if (turnId === undefined) return;
        let turns = openTurns.get(sessionId);
        if (!turns) { turns = new Set(); openTurns.set(sessionId, turns); }
        turns.add(turnId);
        turnOwner.set(turnId, sessionId);
      }),
    );
    for (const terminal of ['TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL'] as const) {
      unsubscribes.push(
        bus.on<TurnEnd>(terminal, (envelope) => {
          const turnId = turnIdOf(envelope);
          const sessionId = sessionForTurn(envelope.sessionId) ?? (turnId === undefined ? undefined : turnOwner.get(turnId));
          // With several sessions hosted, an event that names neither session
          // nor a turn seen here cannot say whose turn ended; leaving every
          // session busy is the safe answer, clearing them all would not be.
          if (!sessionId) return;
          busy.delete(sessionId);
          closeTurns(sessionId);
        }),
      );
    }
    unsubscribes.push(
      bus.on<TurnPreflightFail>('PREFLIGHT_FAIL', (envelope) => {
        const turnId = turnIdOf(envelope);
        const sessionId = envelope.sessionId || (turnId === undefined ? undefined : turnOwner.get(turnId));
        const turns = sessionId ? openTurns.get(sessionId) : undefined;
        if (!sessionId || turnId === undefined || !turns?.has(turnId)) return;
        turns.delete(turnId);
        turnOwner.delete(turnId);
        if (turns.size > 0) return;
        openTurns.delete(sessionId);
        busy.delete(sessionId);
      }),
    );
  }
  return {
    adopt(sessionId: string): void {
      if (sessionId) hosted.add(sessionId);
    },
    release(sessionId: string): void {
      hosted.delete(sessionId);
      busy.delete(sessionId);
      closeTurns(sessionId);
    },
    ids(): readonly string[] {
      return [...hosted];
    },
    hosts(sessionId: string): boolean {
      return hosted.has(sessionId);
    },
    countBusySessions(): number {
      let count = 0;
      for (const sessionId of busy) if (hosted.has(sessionId)) count += 1;
      return count;
    },
    dispose(): void {
      while (unsubscribes.length > 0) {
        try {
          unsubscribes.pop()?.();
        } catch {
          // A bus already torn down is the normal shutdown ordering, not a fault.
        }
      }
    },
  };
}
