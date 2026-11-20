/**
 * The one reader of how a turn ended.
 *
 * Four runtime events end a turn: `TURN_COMPLETED`, `TURN_ERROR`,
 * `TURN_CANCEL` and `PREFLIGHT_FAIL` (a turn refused before it started).
 * Every surface that needs to know how a turn ended (the headless `run`, the
 * work tree, the Agent's hosted-turn bridge and renderer, the web UI) reads
 * them through {@link readTurnSettlement}, so they cannot disagree about which
 * events settle a turn, what an empty answer is, or what exit code it earns.
 *
 * It works on `{ type, payload }` frames (a bus envelope, or a decoded daemon
 * SSE frame), so the browser can use it: no Node imports.
 */

export type TurnSettlement =
  /** The model answered with text. */
  | { readonly kind: 'answered'; readonly turnId: string; readonly response: string; readonly stopReason: string }
  /** The turn completed with no answer (`empty_response`, or a blank response). */
  | { readonly kind: 'empty'; readonly turnId: string }
  /**
   * Refused before it started (`PREFLIGHT_FAIL`): `context_overflow` when the
   * conversation is too large for the model's context window,
   * `preflight_failed` when an equivalent turn is already in flight (the
   * refused turn is a duplicate under its own fresh id; the running turn goes on).
   */
  | {
    readonly kind: 'refused'; readonly turnId: string; readonly reason: string;
    readonly stopReason: 'preflight_failed' | 'context_overflow';
  }
  | { readonly kind: 'failed'; readonly turnId: string; readonly error: string; readonly stopReason: string }
  | { readonly kind: 'cancelled'; readonly turnId: string; readonly reason: string; readonly stopReason: string };

export const TURN_SETTLING_EVENTS = ['TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL', 'PREFLIGHT_FAIL'] as const;
export type TurnSettlingEvent = (typeof TURN_SETTLING_EVENTS)[number];

const SETTLING: ReadonlySet<string> = new Set(TURN_SETTLING_EVENTS);

/** Whether an event type ends a turn. */
export function isTurnSettlingEvent(type: unknown): type is TurnSettlingEvent {
  return typeof type === 'string' && SETTLING.has(type);
}

function field(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The settlement a frame carries, or null when the frame does not end a turn. */
export function readTurnSettlement(frame: { readonly type: string; readonly payload: unknown }): TurnSettlement | null {
  const { type, payload } = frame;
  if (!isTurnSettlingEvent(type)) return null;
  const turnId = field(payload, 'turnId') ?? '';
  switch (type) {
    case 'TURN_COMPLETED': {
      const response = field(payload, 'response') ?? '';
      const stopReason = field(payload, 'stopReason') ?? 'completed';
      if (stopReason === 'empty_response' || response.trim().length === 0) return { kind: 'empty', turnId };
      return { kind: 'answered', turnId, response, stopReason };
    }
    case 'TURN_ERROR':
      return {
        kind: 'failed', turnId,
        error: field(payload, 'error') ?? 'The turn failed without a reason.',
        stopReason: field(payload, 'stopReason') ?? 'unexpected_error',
      };
    case 'TURN_CANCEL':
      return {
        kind: 'cancelled', turnId,
        reason: field(payload, 'reason') ?? 'cancelled',
        stopReason: field(payload, 'stopReason') ?? 'cancelled',
      };
    case 'PREFLIGHT_FAIL': {
      const stopReason = field(payload, 'stopReason') === 'context_overflow' ? 'context_overflow' : 'preflight_failed';
      return {
        kind: 'refused', turnId, stopReason,
        reason: field(payload, 'reason')
          ?? (stopReason === 'context_overflow'
            ? 'The conversation is too large for the model\'s context window.'
            : 'An equivalent turn is already in flight.'),
      };
    }
    default:
      return assertNeverSettlingEvent(type);
  }
}

function assertNeverSettlingEvent(type: never): never {
  throw new TypeError(`Unhandled turn-settling event: ${String(type)}`);
}

/** The `stopReason` a settlement reports (`empty_response` for an empty answer). */
export function stopReasonOfSettlement(s: TurnSettlement): string {
  return s.kind === 'empty' ? 'empty_response' : s.stopReason;
}

/**
 * Whether the settlement ends the turn that is running, as opposed to a
 * duplicate submission refused under its own fresh id while the running turn
 * goes on (`refused` with `preflight_failed`). A surface that tracks one live
 * turn clears its live text and tool calls only when this is true.
 */
export function settlesRunningTurn(s: TurnSettlement): boolean {
  return !(s.kind === 'refused' && s.stopReason === 'preflight_failed');
}

/** `run`'s exit code: answered 0; empty, refused, failed 1; cancelled 130. */
export function exitCodeOfSettlement(s: TurnSettlement): 0 | 1 | 130 {
  switch (s.kind) {
    case 'answered': return 0;
    case 'empty':
    case 'refused':
    case 'failed': return 1;
    case 'cancelled': return 130;
    default: return assertNeverSettlement(s);
  }
}

function assertNeverSettlement(s: never): never {
  throw new TypeError(`Unhandled turn settlement: ${JSON.stringify(s)}`);
}
