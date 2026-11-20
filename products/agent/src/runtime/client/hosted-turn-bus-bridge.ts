/**
 * hosted-turn-bus-bridge.ts, putting a daemon-hosted turn's frames back onto
 * this process's own runtime bus.
 *
 * hosted-frame-render.ts already establishes that a hosted session's loop is
 * the ordinary Orchestrator, so its frames ARE exactly the events a local turn
 * emits, TURN_SUBMITTED, STREAM_DELTA, TURN_COMPLETED, and so on, with the
 * hosted session's id stamped on each one. That file only reads them to update
 * the conversation transcript; nothing re-emits them onto THIS process's
 * runtimeBus. So a hosted turn is invisible to anything that only watches
 * `events.turns`, which is exactly how the spoken-turn wiring decides when to
 * speak (see audio/spoken-turn-wiring.ts). Without this bridge, turning on
 * always-speak mode produces speech for a turn run locally and silence for a
 * turn the daemon ran instead, with nothing in either path to say why.
 *
 * This does not invent new information: it reads the same frame the renderer
 * already reads and republishes it through the platform's typed turn emitters
 * (platform/runtime/emitters, the platform's own doc comment on RuntimeEventBus.emit
 * says these, not a raw emit, are how a caller is supposed to put a turn event
 * on the bus). So anything already listening to the local turn domain, spoken
 * output today, anything else tomorrow, sees a hosted turn exactly as it
 * would see one this process ran itself.
 *
 * Scope is deliberately the exact event set the spoken-turn wiring subscribes
 * to (TURN_SUBMITTED, PREFLIGHT_FAIL, STREAM_DELTA, DRAFT_WITHDRAWN, STREAM_END, TURN_COMPLETED,
 * TURN_ERROR, TURN_CANCEL), the frame types this file has no mapping for are
 * ignored, the same "no guessing" stance hosted-frame-render.ts takes on its
 * own unmapped frames.
 */
import type { RuntimeEventBus } from '@/runtime/index.ts';
import {
  emitDraftWithdrawn,
  emitPreflightFail,
  emitStreamDelta,
  emitStreamEnd,
  emitTurnCancel,
  emitTurnCompleted,
  emitTurnError,
  emitTurnSubmitted,
} from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import { readTurnSettlement, type TurnSettlement } from '@goodvibes-jev/engine/transport-core/turn-settlement';
import type { HostedSessionFrame } from './hosted-frame-render.ts';

/** The stop reasons `emitTurnError` accepts, read from its own signature. */
type EmittableTurnErrorStopReason = Parameters<typeof emitTurnError>[2]['stopReason'];

/** The turn-domain stop reasons emitTurnError accepts, mirrored here for the fallback below. */
const TURN_ERROR_STOP_REASONS = [
  'preflight_failed',
  'context_overflow',
  'provider_exhausted',
  'provider_error',
  'hook_denied',
  'tool_loop_circuit_breaker',
  'unexpected_error',
] as const satisfies readonly EmittableTurnErrorStopReason[];
type TurnErrorStopReason = (typeof TURN_ERROR_STOP_REASONS)[number];

// A reason the emitter accepts but this list lacks would be rewritten to
// 'unexpected_error' below. This line stops compiling when the two drift apart.
const turnErrorStopReasonsAreComplete: [Exclude<EmittableTurnErrorStopReason, TurnErrorStopReason>] extends [never]
  ? true
  : never = true;
void turnErrorStopReasonsAreComplete;

function isTurnErrorStopReason(value: string | undefined): value is TurnErrorStopReason {
  return value !== undefined && (TURN_ERROR_STOP_REASONS as readonly string[]).includes(value);
}

export interface HostedTurnBusBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  /** This surface's own session id, the envelope's context, not the hosted session's. */
  readonly sessionId: string;
  /** Attribution stamped on every re-emitted event, e.g. 'goodvibes-agent'. */
  readonly source: string;
}

function readString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Feed one raw hosted frame through the bridge.
 *
 * Safe to call with every frame the router applies: a frame with no turnId, or
 * a type this bridge has no mapping for, is ignored rather than guessed at.
 * `traceId` is derived from the turnId rather than generated fresh per call,
 * every frame belonging to one turn should read as one trace.
 */
export function bridgeHostedFrameOntoRuntimeBus(frame: HostedSessionFrame, options: HostedTurnBusBridgeOptions): void {
  const payload = frame.payload;
  const turnId = readString(payload, 'turnId');
  if (!turnId) return;
  const ctx = { sessionId: options.sessionId, source: options.source, traceId: `hosted-${turnId}`, turnId };

  switch (frame.type) {
    case 'TURN_SUBMITTED': {
      const prompt = readString(payload, 'prompt');
      if (prompt === undefined) return;
      emitTurnSubmitted(options.runtimeBus, ctx, { turnId, prompt });
      return;
    }
    case 'STREAM_DELTA': {
      const content = readString(payload, 'content') ?? '';
      const accumulated = readString(payload, 'accumulated') ?? content;
      emitStreamDelta(options.runtimeBus, ctx, { turnId, content, accumulated });
      return;
    }
    case 'DRAFT_WITHDRAWN': {
      emitDraftWithdrawn(options.runtimeBus, ctx, { turnId, reason: readString(payload, 'reason') ?? '' });
      return;
    }
    case 'STREAM_END': {
      emitStreamEnd(options.runtimeBus, ctx, { turnId });
      return;
    }
    case 'TURN_COMPLETED':
    case 'TURN_ERROR':
    case 'TURN_CANCEL':
    case 'PREFLIGHT_FAIL': {
      // How the turn ended, from the one settlement reader every surface uses.
      const settlement = readTurnSettlement({ type: frame.type, payload });
      if (settlement) emitSettlement(settlement, turnId, ctx, options.runtimeBus);
      return;
    }
    default:
      return;
  }
}

function emitSettlement(settlement: TurnSettlement, turnId: string, ctx: Parameters<typeof emitTurnCompleted>[1], bus: RuntimeEventBus): void {
  switch (settlement.kind) {
    case 'answered':
      emitTurnCompleted(bus, ctx, { turnId, response: settlement.response, stopReason: 'completed' });
      return;
    case 'empty':
      emitTurnCompleted(bus, ctx, { turnId, response: '', stopReason: 'empty_response' });
      return;
    case 'refused':
      emitPreflightFail(bus, ctx, { turnId, reason: settlement.reason, stopReason: settlement.stopReason });
      return;
    case 'failed':
      emitTurnError(bus, ctx, {
        turnId,
        error: settlement.error,
        stopReason: isTurnErrorStopReason(settlement.stopReason) ? settlement.stopReason : 'unexpected_error',
      });
      return;
    case 'cancelled':
      emitTurnCancel(bus, ctx, { turnId, reason: settlement.reason, stopReason: 'cancelled' });
      return;
  }
}
