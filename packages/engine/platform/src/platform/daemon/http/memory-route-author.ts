/**
 * memory-route-author.ts, who writes a memory record over the daemon's memory REST routes (daemon-api
 * integration-routes.ts: add, update, import), read from the credential the daemon authenticated and never from a body
 * field (state/memory-author.ts):
 *   - the owner in person: their signed-in session (every request on it is theirs), or the person's claim on this machine's
 *     operator token (`local`), sent by one of their terminal programs (its own registration key,
 *     pairing/terminal-program-registration.ts);
 *   - the owner's model: a terminal program's own call with no person's claim (the operator token with that program's key, or
 *     the Agent's own credential with the Agent's key), as its memory spine writes what its model learned in the owner's
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
  // The owner's own Agent program (its credential with its registration, or a turn the daemon hosts): the owner's model. The
  // Agent's credential alone is a script, named as someone else below.
  if (ownersAgentProgram({ actor, credentialKind: kind ?? undefined, registration: readProgramRegistration(req), daemonHosted: readDaemonHosted(req) })) return { kind: 'owner-model' };
  // The owner's own signed-in session (the ONE definition of the owner in person, daemon/method-owner-decision.ts): their writing.
  if (ownersOwnSession({ actor, credentialKind: kind })) return { kind: 'owner' };
  const program = homeDirectory !== null && isTerminalProgramRegistration(homeDirectory, readProgramRegistration(req));
  const loopback = principal.transport === undefined || principal.transport === 'loopback';
  if (kind === 'local' && loopback && program && actor.class === 'owner' && actor.agentFor === undefined) {
    const claim = req.headers.get(EXPLICIT_USER_REQUEST_HEADER)?.trim().toLowerCase() === 'true';
    return claim ? { kind: 'owner' } : { kind: 'owner-model' };
  }
  // Kept with its principal: a caller below an admin changes the records it wrote, and no one else's (record-owners.ts).
  return { kind: 'other', who: `a caller that is not the owner in person (${actor.class} ${actor.id})`, madeBy: principal.principalId };
}

/** Whether the caller of `req` registered `sessionId` (its own conversation). */
export function requestMayNameSession(req: Request, principal: RequestPrincipal | null, registrantOf: (sessionId: string) => string | undefined, sessionId: string): boolean {
  if (!principal) return false;
  return registrantMayName(registrantOf(sessionId), { key: callerKey(principal), registration: readProgramRegistration(req) });
}
