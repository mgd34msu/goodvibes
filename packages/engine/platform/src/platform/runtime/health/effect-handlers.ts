/**
 * Health Error Propagation, Effect Handlers
 *
 * Publishes the cascades the CascadeEngine produces. A cascade is a report:
 * see handleCascadeEffect.
 *
 * Callers (e.g. HealthStoreWiring) are responsible for iterating over
 * CascadeResult arrays and invoking this function for each result.
 *
 * @module health/effect-handlers
 */

import type { CascadeEffect, CascadeResult } from './types.js';
import { createCascadeAppliedEvent } from './types.js';
import type { RuntimeHealthAggregator } from './aggregator.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../events/index.js';
import { createEventEnvelope } from '../events/index.js';
import type { AnyRuntimeEvent, RuntimeEventDomain } from '../events/index.js';

/**
 * Emits a synthetic health event on the bus.
 *
 * Health events (e.g. CASCADE_APPLIED) are not part of AnyRuntimeEvent, they live
 * outside the typed domain-event union. This helper centralises the necessary
 * cross-domain cast in a single, documented location rather than duplicating it
 * at each call site.
 */
function emitHealthEvent(
  bus: RuntimeEventBus,
  envelope: RuntimeEventEnvelope<string, unknown>,
): void {
  // CASCADE_APPLIED and synthetic health events live outside the AnyRuntimeEvent typed union
  // by design. Keep the cross-domain cast isolated here so standard domain events can continue
  // using typed emitters.
  bus.emit(
    // Health events use 'session' as the routing domain, it is the most general
    // domain and health cascades originate from session-level failures.
    'session' as RuntimeEventDomain,
    envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  );
}

/** Context injected into each effect handler. */
export interface EffectHandlerContext {
  /** The health aggregator. Effects never write another domain's status; it is passed for hosts that read it. */
  readonly aggregator: RuntimeHealthAggregator;
  /** The event bus, used to emit CASCADE_APPLIED and domain events. */
  readonly eventBus: RuntimeEventBus;
}

/**
 * Publishes one cascade. A cascade reports what a failing domain affects; it
 * cancels, blocks and deregisters nothing, and it leaves every other domain's
 * status to that domain's own entities (a failed agent does not make `tasks`
 * failed). So every CASCADE_APPLIED carries `enforced: false`. An EMIT_EVENT
 * effect also publishes its named event.
 *
 * @param effect - The CascadeEffect of the rule that fired.
 * @param result - The CascadeResult that produced this effect (carries ruleId, source, etc.).
 * @param context - The aggregator and eventBus.
 */
export function handleCascadeEffect(
  effect: CascadeEffect,
  result: CascadeResult,
  context: EffectHandlerContext,
): void {
  const { eventBus } = context;
  const sessionId = result.sourceContext?.['sessionId'] ?? 'runtime';
  if (effect.type === 'EMIT_EVENT') {
    emitHealthEvent(eventBus, createEventEnvelope(
      effect.eventType,
      {
        type: effect.eventType,
        ruleId: result.ruleId,
        source: result.source,
        target: result.target,
        timestamp: result.timestamp,
        sourceContext: result.sourceContext,
      },
      { sessionId, source: 'health/effect-handlers' },
    ));
  }
  emitHealthEvent(eventBus, createEventEnvelope(
    'CASCADE_APPLIED',
    createCascadeAppliedEvent(result, false),
    { sessionId, source: 'health/effect-handlers' },
  ));
}
