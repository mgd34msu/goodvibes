/**
 * memory-route-author.ts, who writes a memory record over the daemon's memory REST routes (daemon-api
 * integration-routes.ts: add, update, import), read from the credential the daemon authenticated and never from a body
 * field (state/memory-author.ts):
 *   - the owner himself: his signed-in session (every request on it is his), or the person's claim on this machine's
 *     operator token (`local`), sent by one of his terminal programs (its own registration key,
 *     pairing/terminal-program-registration.ts);
 *   - his model: a terminal program's own call with no person's claim (the operator token with that program's key, or
 *     the Agent's own credential with the Agent's key), as its memory spine writes what its model learned in his
 *     conversation;
 *   - someone else, named: a paired device, a member, an admin pairing, an outside agent, a script or `mcp serve`
 *     holding the operator token with no program's key.
 * And whether the caller registered a session it names as a record's origin (session-broker-sessions.ts).
 */
import { EXPLICIT_USER_REQUEST_HEADER, readDaemonHosted, readProgramRegistration } from '@goodvibes/engine/daemon-api/control-routes';
import type { RequestPrincipal } from '../http-policy.js';
import { isTerminalProgramRegistration } from '../../pairing/terminal-program-registration.js';
import { callerKey } from '../../pairing/principal-ids.js';
import { registrantMayName } from '../../control-plane/session-broker-sessions.js';
import type { MemoryAuthor } from '../../state/memory-author.js';
import { ownersAgentProgram, ownersOwnSession } from '../method-owner-decision.js';

/** Who writes a memory record over a REST route (see the module header). */
export function memoryAuthorOfRequest(req: Request, principal: RequestPrincipal | null, homeDirectory: string | null): MemoryAuthor {
  if (!principal) return { kind: 'other', who: 'a caller the daemon did not name' };
  const actor = principal.actor;
  const kind = principal.credentialKind;
  // The owner's own Agent program (its credential with its registration, or a turn the daemon hosts): his model. The
  // Agent's credential alone is a script, named as someone else below.
  if (ownersAgentProgram({ actor, credentialKind: kind ?? undefined, registration: readProgramRegistration(req), daemonHosted: readDaemonHosted(req) })) return { kind: 'owner-model' };
  // His own signed-in session (the ONE definition of the owner himself, daemon/method-owner-decision.ts): his writing.
  if (ownersOwnSession({ actor, credentialKind: kind })) return { kind: 'owner' };
  const program = homeDirectory !== null && isTerminalProgramRegistration(homeDirectory, readProgramRegistration(req));
  const loopback = principal.transport === undefined || principal.transport === 'loopback';
  if (kind === 'local' && loopback && program && actor.class === 'owner' && actor.agentFor === undefined) {
    const claim = req.headers.get(EXPLICIT_USER_REQUEST_HEADER)?.trim().toLowerCase() === 'true';
    return claim ? { kind: 'owner' } : { kind: 'owner-model' };
  }
  return { kind: 'other', who: `a caller that is not the owner himself (${actor.class} ${actor.id})` };
}

/** Whether the caller of `req` registered `sessionId` (its own conversation). */
export function requestMayNameSession(req: Request, principal: RequestPrincipal | null, registrantOf: (sessionId: string) => string | undefined, sessionId: string): boolean {
  if (!principal) return false;
  return registrantMayName(registrantOf(sessionId), { key: callerKey(principal), registration: readProgramRegistration(req) });
}
