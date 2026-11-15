import { RuntimeEventBus, createEventEnvelope } from '@goodvibes-jev/engine/platform/platform/runtime/state';

/**
 * Resolves once every event emitted on `bus` before this call has reached its
 * listeners.
 *
 * The bus delivers each emit in its own microtask, in emit order, so an event
 * emitted last is delivered last. The sentinel rides the `ops` domain, which
 * none of the notification bridges that tests wire to the bus subscribe to
 * except the memory-pressure one; do not use this with that bridge wired.
 */
export function busDrained(bus: RuntimeEventBus): Promise<void> {
  const delivered = Promise.withResolvers<void>();
  const payload = { type: 'OPS_MEMORY_PRESSURE' as const, tier: 'normal' as const, previousTier: 'normal' as const, rssMb: 0, heapMb: 0, budgetMb: -1, usedPct: 0 };
  const unsubscribe = bus.onDomain('ops', (envelope) => {
    const event = envelope.payload;
    if (event.type === 'OPS_MEMORY_PRESSURE' && event.budgetMb === -1) delivered.resolve();
  });
  bus.emit('ops', createEventEnvelope(payload.type, payload, { sessionId: 'bus-drained', source: 'bus-drained' }));
  return delivered.promise.finally(unsubscribe);
}
