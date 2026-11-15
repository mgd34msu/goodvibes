import type { EventLike } from '@goodvibes-jev/engine/transport-core';
import type { SerializedEventEnvelope } from './domain-events.js';

/**
 * The one reader of the daemon's event envelope, shared by the WebSocket and
 * SSE connectors and the scoped browser client.
 *
 * It requires a `payload` and a string `type` (the envelope's own, or the
 * payload's when the envelope has none). Every other field is read when it has
 * the right type and ignored otherwise, and keys it does not know are ignored,
 * so a field a newer daemon adds does not silence an older client. `timestamp`
 * is read as `ts` for older emitters. Returns null for a frame that is not an
 * envelope. The payload's own shape is checked by whoever consumes the domain.
 */
export function readEventEnvelope<TEvent extends EventLike = EventLike>(value: unknown): SerializedEventEnvelope<TEvent> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const payload = record['payload'];
  if (payload === undefined) return null;
  const payloadType = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)['type'] : undefined;
  const type = typeof record['type'] === 'string' ? record['type'] : typeof payloadType === 'string' ? payloadType : undefined;
  if (type === undefined) return null;
  const ts = typeof record['ts'] === 'number' ? record['ts'] : typeof record['timestamp'] === 'number' ? record['timestamp'] : undefined;
  const traceId = record['traceId'];
  const sessionId = record['sessionId'];
  const source = record['source'];
  return {
    type,
    ...(ts === undefined ? {} : { ts }),
    ...(typeof traceId === 'string' ? { traceId } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof source === 'string' ? { source } : {}),
    payload: payload as TEvent,
  };
}
