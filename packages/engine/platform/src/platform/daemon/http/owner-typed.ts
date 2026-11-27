/**
 * Whether a message is the owner's own, typed by him, read with the ONE definition of the owner himself
 * (daemon/method-owner-decision.ts `ownerHimself`): his signed-in session, a device he paired, or his own terminal
 * program the daemon registered (the operator token alone is a script, wherever it is held). Read from what the daemon
 * established for the request (its principal, the registration it checked and bound), never from a label a request
 * sends.
 *
 * - `ownerHimselfOf`: the web chat's message, edit and steer (companion-chat-routes.ts `isOwnerRequest`): the owner's
 *   turn, or someone else's input.
 * - `ownerTypedAtProgram`: a message sent into a session the daemon hosts (daemon-api runtime-session-routes.ts
 *   `OWNER_TYPED_METADATA_KEY`): the owner himself, naming itself a terminal app or the Agent, with a person's claim.
 *   Only then does the session run it as his own turn in its project; anything else stays an input-only instruction.
 */
import type { RequestPrincipal } from '../http-policy.js';
import { ownerHimself } from '../method-owner-decision.js';

/** {@link ownerHimself} for a request's principal and the program registration the router checked for it. */
export function ownerHimselfOf(principal: RequestPrincipal | null | undefined, registration: string | undefined): boolean {
  return principal !== null && principal !== undefined
    && ownerHimself({ actor: principal.actor, credentialKind: principal.credentialKind, registration });
}

export function ownerTypedAtProgram(principal: RequestPrincipal | null | undefined, headers: Headers, registration: string | undefined): boolean {
  if (!ownerHimselfOf(principal, registration)) return false;
  const program = headers.get('x-goodvibes-client')?.trim().toLowerCase();
  if (program !== 'tui' && program !== 'agent') return false;
  return headers.get('x-goodvibes-explicit-user-request')?.trim().toLowerCase() === 'true';
}
