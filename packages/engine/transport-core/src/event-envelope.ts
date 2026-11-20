import { isTurnSettlingEvent } from './turn-settlement.js';

export interface EventEnvelope<TType extends string, TPayload> {
  readonly type: TType;
  readonly ts: number;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly source?: string | undefined;
  readonly payload: TPayload;
}

export interface EventEnvelopeContext {
  readonly sessionId: string;
  readonly source: string;
  readonly traceId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly taskId?: string | undefined;
}

export function createEventEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  context: EventEnvelopeContext,
): EventEnvelope<TType, TPayload> {
  return Object.freeze({
    type,
    ts: Date.now(),
    // Callers that want multiple fan-out envelopes correlated under one trace
    // must provide a shared traceId.
    // default to undefined instead of generating entropy on every envelope.
    // High-volume callers (telemetry, streaming deltas) should provide a shared
    // traceId in context to correlate fan-out envelopes under one trace.
    traceId: context.traceId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentId: context.agentId,
    taskId: context.taskId,
    source: context.source,
    payload,
  });
}

/**
 * Rebuilds a turn's running text from the `STREAM_DELTA` frames a daemon
 * stream delivers.
 *
 * On the wire a delta carries `accumulated` (the turn's text so far) only at a
 * resync point: the first delta a connection receives for a turn, a restart of
 * the text (a retried or redrafted request streams again from empty), and
 * whenever the text has about doubled since the last frame that carried it, so
 * a reader that missed frames is whole again soon and the bytes sent stay
 * linear in the answer's length. Every other delta carries only its new
 * `content`. A reader keeps one assembler per connection and passes every
 * turn payload through `complete`, which hands back the payload with
 * `accumulated` present (the same object when it already was).
 */
export interface StreamTextAssembler {
  complete<TPayload>(payload: TPayload): TPayload;
  /** Forget every held turn (the connection was replaced). */
  clear(): void;
}

/** Turns held at once; a reader watching more interleaved turns than this drops the oldest. */
const STREAM_TEXT_TURNS_HELD = 64;

export function createStreamTextAssembler(): StreamTextAssembler {
  const texts = new Map<string, string>();
  const hold = (turnId: string, text: string): void => {
    texts.delete(turnId);
    texts.set(turnId, text);
    if (texts.size > STREAM_TEXT_TURNS_HELD) {
      const oldest = texts.keys().next().value;
      if (oldest !== undefined) texts.delete(oldest);
    }
  };
  return {
    complete<TPayload>(payload: TPayload): TPayload {
      if (payload === null || typeof payload !== 'object') return payload;
      const record = payload as Record<string, unknown>;
      const turnId = record['turnId'];
      if (typeof turnId !== 'string') return payload;
      if (record['type'] === 'STREAM_DELTA') {
        const accumulated = record['accumulated'];
        if (typeof accumulated === 'string') {
          hold(turnId, accumulated);
          return payload;
        }
        const content = record['content'];
        const text = (texts.get(turnId) ?? '') + (typeof content === 'string' ? content : '');
        hold(turnId, text);
        return { ...record, accumulated: text } as TPayload;
      }
      if (isTurnSettlingEvent(record['type'])) texts.delete(turnId);
      return payload;
    },
    clear(): void {
      texts.clear();
    },
  };
}
