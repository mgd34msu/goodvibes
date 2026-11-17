/**
 * Whether a session that asked the owner a question is open in a terminal now,
 * read from the daemon's session broker: the record a terminal registers for
 * its session, its open/closed status, and the participant times its existing
 * keepalive already moves. The same test routes a steer to a live surface
 * (shouldRouteInputToSurface), so "open" means one thing everywhere. Nothing is
 * polled and nothing is written; it is read when a question is answered and
 * when a list shows an answer still waiting.
 */
import type { OwnerSessionPresence, OwnerSessionPresenceProbe } from './owner-inbox.js';
import type { SharedSessionRecord } from './session-types.js';
import { SURFACE_ROUTE_FRESHNESS_MS, shouldRouteInputToSurface } from './session-broker-sessions.js';

export function sessionBrokerPresence(
  broker: { getSession(sessionId: string): SharedSessionRecord | null },
  now: () => number = Date.now,
): OwnerSessionPresenceProbe {
  return (sessionId): OwnerSessionPresence => {
    const session = broker.getSession(sessionId);
    if (!session) return { state: 'gone' };
    const title = session.title.trim() || undefined;
    const attached = session.status === 'active' && shouldRouteInputToSurface(session, now(), SURFACE_ROUTE_FRESHNESS_MS);
    return { state: attached ? 'attached' : 'closed', ...(title !== undefined ? { title } : {}) };
  };
}
