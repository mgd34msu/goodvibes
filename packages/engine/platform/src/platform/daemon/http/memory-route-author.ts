/**
 * memory-route-author.ts, who writes a memory record over the daemon's memory REST routes (daemon-api
 * integration-routes.ts: add, update, import), read from the credential the daemon authenticated and never from a body
 * field (state/memory-author.ts):
 *   - the user in person: their signed-in session (every request on it is theirs), or the person's claim on any other
 *     credential of theirs (a device, the machine's token);
 *   - the user's model: the Agent's credential, or any credential of the user's with no person's claim, as its memory
 *     spine writes what its model learned in the user's conversation;
 *   - someone else, named: only a guest or a peer.
 * And whether the caller registered a session it names as a record's origin (session-broker-sessions.ts).
 */
import { EXPLICIT_USER_REQUEST_HEADER, readDaemonHosted, readProgramRegistration } from '@goodvibes/engine/daemon-api/control-routes';
import type { RequestPrincipal } from '../http-policy.js';
import { callerKey } from '../../pairing/principal-ids.js';
import { registrantMayName } from '../../control-plane/session-broker-sessions.js';
import type { MemoryAuthor } from '../../state/memory-author.js';
import { isTheUser, ownersAgentProgram, ownersOwnSession } from '../method-owner-decision.js';

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
  // Any credential of the user (a second sign-in, a device, the machine's token, a typed `do`) writes as the user's own
  // program does: their words with a person's claim, their model's without. Never someone else's.
  void homeDirectory;
  if (isTheUser(actor)) return { kind: 'owner' };
  // A guest or a peer (not the user): someone else's, kept with its principal.
  const other = actor as { readonly class: string; readonly id: string };
  return { kind: 'other', who: `a caller that is not the user (${other.class} ${other.id})`, madeBy: principal.principalId };
}

/** Whether the caller of `req` registered `sessionId` (its own conversation). */
export function requestMayNameSession(req: Request, principal: RequestPrincipal | null, registrantOf: (sessionId: string) => string | undefined, sessionId: string): boolean {
  if (!principal) return false;
  return registrantMayName(registrantOf(sessionId), { key: callerKey(principal), registration: readProgramRegistration(req) });
}
