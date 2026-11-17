/**
 * Whether a terminal session that asked the owner a question is open now, can
 * be opened again, or is gone: open is the asker lock every running asker
 * holds (owner-asker-liveness.ts, passed in as `running`), and the session's
 * saved file tells closed from deleted. In the daemon the session broker is read too:
 * a terminal on another machine registers its session there, and the broker
 * routes a steer to a live surface by the same test, so "open" means one thing
 * everywhere. Nothing is polled and nothing is written; it is read when a
 * question is answered and when a list shows an answer still waiting.
 */
import { existsSync } from 'node:fs';
import type { OwnerAskerPresence, OwnerAskerPresenceProbe } from './owner-inbox.js';
import type { SharedSessionRecord } from './session-types.js';
import { SURFACE_ROUTE_FRESHNESS_MS, shouldRouteInputToSurface } from './session-broker-sessions.js';

export function terminalSessionPresence(
  broker?: { getSession(sessionId: string): SharedSessionRecord | null },
  now: () => number = Date.now,
): OwnerAskerPresenceProbe {
  return (asker, running): OwnerAskerPresence | undefined => {
    const sessionId = asker.session;
    if (sessionId === undefined || asker.host !== undefined) return undefined;
    const record = broker?.getSession(sessionId) ?? null;
    const title = record?.title.trim() || undefined;
    const withTitle = title !== undefined ? { title } : {};
    if (running) return { state: 'attached', ...withTitle };
    if (record && record.status === 'active' && shouldRouteInputToSurface(record, now(), SURFACE_ROUTE_FRESHNESS_MS)) return { state: 'attached', ...withTitle };
    if (asker.sessionFile === undefined || existsSync(asker.sessionFile)) return { state: 'closed', ...withTitle };
    // Asked from another machine: its saved file is not on this one, and the broker still holds the session.
    if (record) return { state: 'closed', ...withTitle };
    return { state: 'gone', reason: `Session ${sessionId} was deleted, so it cannot be opened again.` };
  };
}
