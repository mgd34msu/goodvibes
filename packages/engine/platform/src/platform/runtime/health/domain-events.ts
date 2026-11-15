/**
 * Health Error Propagation, domain event bridge
 *
 * Turns the runtime events that mean a subsystem failed, degraded or came
 * back into `HealthStoreWiring.evaluateDomain()` calls, so the health
 * aggregator and the cascade rules follow what the runtime actually does.
 *
 * @module health/domain-events
 */

import type { AnyRuntimeEvent, RuntimeEventBus } from '../events/index.js';
import type { HealthDomain, HealthStatus } from './types.js';
import type { HealthStoreWiring } from './wiring.js';

/** Runtime event type -> the health state of its domain after that event. */
const DOMAIN_EVENT_HEALTH: Readonly<Partial<Record<AnyRuntimeEvent['type'], { readonly domain: HealthDomain; readonly status: HealthStatus }>>> = {
  MCP_CONNECTED: { domain: 'mcp', status: 'healthy' },
  MCP_DEGRADED: { domain: 'mcp', status: 'degraded' },
  MCP_DISCONNECTED: { domain: 'mcp', status: 'failed' },
  TRANSPORT_CONNECTED: { domain: 'transport', status: 'healthy' },
  TRANSPORT_DEGRADED: { domain: 'transport', status: 'degraded' },
  TRANSPORT_TERMINAL_FAILURE: { domain: 'transport', status: 'failed' },
  COMPACTION_DONE: { domain: 'compaction', status: 'healthy' },
  COMPACTION_FAILED: { domain: 'compaction', status: 'failed' },
  TURN_COMPLETED: { domain: 'turn', status: 'healthy' },
  TURN_ERROR: { domain: 'turn', status: 'failed' },
  AGENT_COMPLETED: { domain: 'agents', status: 'healthy' },
  AGENT_FAILED: { domain: 'agents', status: 'failed' },
};

/**
 * Subscribe the wiring to the domain events above and start it.
 * The returned function unsubscribes and stops the wiring.
 */
export function bindHealthDomainEvents(bus: RuntimeEventBus, wiring: HealthStoreWiring): () => void {
  wiring.start();
  const unsubscribers = (Object.keys(DOMAIN_EVENT_HEALTH) as AnyRuntimeEvent['type'][]).map((eventType) => {
    const health = DOMAIN_EVENT_HEALTH[eventType]!;
    return bus.on(eventType, (envelope) => {
      const sessionId = envelope.sessionId;
      wiring.evaluateDomain(health.domain, health.status, sessionId ? { sessionId } : undefined);
    });
  });
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    wiring.stop();
  };
}
