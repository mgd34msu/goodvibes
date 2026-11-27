/**
 * Whether a message is the user's own, read with the ONE definition of the user (daemon/method-owner-decision.ts
 * `ownerHimself`): a sign-in under any name, any paired device, the operator token from any process. Read from what the
 * daemon established for the request (its principal), never from a label a request sends.
 *
 * - `ownerHimselfOf`: the web chat's message, edit and steer (companion-chat-routes.ts `isOwnerRequest`).
 * - `ownerTypedAtProgram`: a message sent into a session the daemon hosts (daemon-api runtime-session-routes.ts
 *   `OWNER_TYPED_METADATA_KEY`): the session runs it as the user's own turn in its project.
 */
import type { RequestPrincipal } from '../http-policy.js';
import { makesOwnerOnlyAct, ownerHimself } from '../method-owner-decision.js';

/** {@link ownerHimself} for a request's principal and the program registration the router checked for it. */
export function ownerHimselfOf(principal: RequestPrincipal | null | undefined, registration: string | undefined): boolean {
  return principal !== null && principal !== undefined
    && ownerHimself({ actor: principal.actor, credentialKind: principal.credentialKind, registration });
}

/**
 * The owner in person ({@link ownerHimself}) or the owner's own verified command line (`do`, method-owner-decision.ts `ownersCommandLine`),
 * for a request's principal and the program registration the router checked for it: who makes an act only the owner makes
 * at a route (method-owner-decision.ts `makesOwnerOnlyAct`, without the daemon's own in-process calls).
 */
export function makesOwnerOnlyActOf(principal: RequestPrincipal | null | undefined, registration: string | undefined): boolean {
  if (principal === null || principal === undefined) return false;
  // A request's principal is never the daemon's own in-process caller, so this is exactly the one test.
  return makesOwnerOnlyAct({ actor: principal.actor, credentialKind: principal.credentialKind, registration });
}

/**
 * Input sent into a hosted session from any credential of the user is the user's own: no program label, registration or
 * person's claim is asked for (the daemon's input-origin rules for guests, channels and webhooks are not decided here).
 */
export function ownerTypedAtProgram(principal: RequestPrincipal | null | undefined, _headers: Headers, registration: string | undefined): boolean {
  return ownerHimselfOf(principal, registration);
}
