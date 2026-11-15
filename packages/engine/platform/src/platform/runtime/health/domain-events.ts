/**
 * Health Error Propagation, domain event bridge
 *
 * Turns the runtime events that mean an entity failed, degraded or came back
 * into domain health. Each domain's status is derived from its own entities,
 * as their owners announce them: each MCP server, each transport, each
 * session's last turn and last compaction, each agent. One entity failing does
 * not make unrelated work look failed, and one entity succeeding does not hide
 * another that is still failing.
 *
 * A domain is `failed` when every entity it tracks is failing, `degraded` when
 * some are, and `healthy` when none are; the failure reason names the failing
 * entities.
 *
 * @module health/domain-events
 */

import type { AnyRuntimeEvent, RuntimeEventBus } from '../events/index.js';
import type { HealthDomain, HealthStatus } from './types.js';
import type { HealthStoreWiring } from './wiring.js';

/** How one runtime event sets the health of one entity of a domain. */
interface EntityHealthEvent {
  readonly domain: HealthDomain;
  /** The entity's status after the event; `ended` drops an entity that finished well. */
  readonly status: HealthStatus | 'ended';
  /** What the entities are called in a failure reason. */
  readonly noun: string;
  readonly entity: (payload: Record<string, unknown>, envelope: { readonly sessionId?: string | undefined }) => string | undefined;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const sessionOf = (payload: Record<string, unknown>, envelope: { readonly sessionId?: string | undefined }): string | undefined =>
  text(payload['sessionId']) ?? text(envelope.sessionId);

const mcp = (status: HealthStatus): EntityHealthEvent => ({ domain: 'mcp', status, noun: 'MCP servers', entity: (p) => text(p['serverId']) });
const transport = (status: HealthStatus): EntityHealthEvent => ({ domain: 'transport', status, noun: 'transports', entity: (p) => text(p['transportId']) });
const compaction = (status: HealthStatus): EntityHealthEvent => ({ domain: 'compaction', status, noun: 'sessions', entity: sessionOf });
const turn = (status: HealthStatus): EntityHealthEvent => ({ domain: 'turn', status, noun: 'sessions', entity: sessionOf });
const agent = (status: HealthStatus | 'ended'): EntityHealthEvent => ({ domain: 'agents', status, noun: 'agents', entity: (p) => text(p['agentId']) });

/** Runtime event type -> the entity it describes and that entity's health after it. */
const ENTITY_HEALTH_EVENTS: Readonly<Partial<Record<AnyRuntimeEvent['type'], EntityHealthEvent>>> = {
  MCP_CONNECTED: mcp('healthy'),
  MCP_DEGRADED: mcp('degraded'),
  MCP_DISCONNECTED: mcp('failed'),
  TRANSPORT_CONNECTED: transport('healthy'),
  TRANSPORT_TERMINAL_FAILURE: transport('failed'),
  COMPACTION_DONE: compaction('healthy'),
  COMPACTION_FAILED: compaction('failed'),
  TURN_COMPLETED: turn('healthy'),
  TURN_ERROR: turn('failed'),
  AGENT_COMPLETED: agent('ended'),
  AGENT_CANCELLED: agent('ended'),
  AGENT_FAILED: agent('failed'),
};

/** Entities remembered per domain; the oldest is forgotten past this. */
const MAX_ENTITIES_PER_DOMAIN = 256;

/** Live per-entity health of one domain. */
class DomainEntities {
  private readonly entities = new Map<string, HealthStatus>();

  set(entity: string, status: HealthStatus | 'ended'): void {
    this.entities.delete(entity);
    if (status === 'ended') return;
    this.entities.set(entity, status);
    if (this.entities.size > MAX_ENTITIES_PER_DOMAIN) {
      const oldest = this.entities.keys().next().value;
      if (oldest !== undefined) this.entities.delete(oldest);
    }
  }

  /** The domain status these entities add up to, and the reason when it is not healthy. */
  summarize(noun: string): { readonly status: HealthStatus; readonly reason?: string } {
    const failing = [...this.entities].filter(([, status]) => status === 'failed' || status === 'degraded');
    if (failing.length === 0) return { status: 'healthy' };
    const allFailed = failing.length === this.entities.size && failing.every(([, status]) => status === 'failed');
    const names = failing.map(([entity]) => entity);
    const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '');
    return {
      status: allFailed ? 'failed' : 'degraded',
      reason: `${failing.length} of ${this.entities.size} ${noun} failing: ${shown}`,
    };
  }
}

/**
 * Subscribe the wiring to the entity events above and start it.
 * The returned function unsubscribes and stops the wiring.
 */
export function bindHealthDomainEvents(bus: RuntimeEventBus, wiring: HealthStoreWiring): () => void {
  wiring.start();
  const domains = new Map<HealthDomain, DomainEntities>();
  const unsubscribers = (Object.keys(ENTITY_HEALTH_EVENTS) as AnyRuntimeEvent['type'][]).map((eventType) => {
    const rule = ENTITY_HEALTH_EVENTS[eventType]!;
    return bus.on(eventType, (envelope) => {
      const payload = (envelope.payload ?? {}) as unknown as Record<string, unknown>;
      const entity = rule.entity(payload, envelope) ?? 'runtime';
      let entities = domains.get(rule.domain);
      if (!entities) {
        entities = new DomainEntities();
        domains.set(rule.domain, entities);
      }
      entities.set(entity, rule.status);
      const summary = entities.summarize(rule.noun);
      const sessionId = sessionOf(payload, envelope);
      wiring.evaluateDomain(rule.domain, summary.status, {
        entity,
        ...(rule.domain === 'mcp' ? { serverId: entity } : {}),
        ...(rule.domain === 'agents' ? { agentId: entity } : {}),
        ...(sessionId ? { sessionId } : {}),
      }, summary.reason);
    });
  });
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    wiring.stop();
  };
}
