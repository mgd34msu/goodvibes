import { z } from 'zod/v4';

/**
 * Schema for the SSE / WebSocket serialized event envelope that wraps all
 * realtime domain events.
 *
 * Matches `SerializedEventEnvelope<unknown>` from transport-realtime. Unknown
 * keys are accepted and dropped, so a field a newer daemon adds does not fail
 * an older reader.
 */
export const SerializedEventEnvelopeSchema = z.object({
  type: z.string(),
  ts: z.number().optional(),
  traceId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().optional(),
  payload: z.unknown(),
});

export type SerializedEventEnvelopeShape = z.infer<typeof SerializedEventEnvelopeSchema>;

/**
 * Schema for a typed SSE / WS event envelope where the payload is a known
 * runtime event record (has a `type` discriminant string). Event-specific
 * payload validation happens at each domain boundary; this base schema keeps
 * the discriminant plus the event fields that belong to that domain event.
 */
export const RuntimeEventRecordSchema = z.object({
  type: z.string(),
}).catchall(z.unknown());

export const TypedSerializedEventEnvelopeSchema = SerializedEventEnvelopeSchema.extend({
  payload: RuntimeEventRecordSchema,
});

export type TypedSerializedEventEnvelopeShape = z.infer<typeof TypedSerializedEventEnvelopeSchema>;
