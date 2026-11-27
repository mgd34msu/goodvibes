/**
 * stored-credentials.ts, who a tool may sign in as with the owner's stored credentials.
 *
 * A tool that adds one of the owner's stored secrets, tokens or sign-ins to an outgoing request (the `fetch` tool's
 * `service`: a registered service's credential, config/service-registry.ts) acts as the owner at that service. The
 * user's own turns do that, from every credential of theirs (a sign-in, a device, the machine's token: all of them are
 * the user's turns, security/turn-input-party.ts). A turn on someone else's input (a channel stranger, a guest, a
 * webhook) is refused, with a sentence, unless
 * the owner gave the caller that turn runs for the service's shared kind (control-plane/shared-kinds.ts: the owner's gift,
 * given in Devices and network; nothing is asked to get it). A service of no shared kind is the owner's alone.
 */
import { turnInputParty, type TurnInputParty } from './turn-input-party.js';
import { sharedKindOfService, sharedKindReached, SHARED_KIND_WORDS } from '../control-plane/shared-kinds.js';

/** Why this turn may not send the stored credential of `service`, or undefined when it may (the owner's own turn). */
export function storedCredentialRefusal(service: string, party: TurnInputParty = turnInputParty()): string | undefined {
  if (party.party === 'owner') return undefined;
  const kind = sharedKindOfService(service);
  if (kind !== undefined && party.madeFor !== undefined
    && sharedKindReached({ ownersOwn: false, daemonTurn: true, othersInput: true, othersInputFor: party.madeFor }, kind)) return undefined;
  return `service "${service}" signs in with the owner's stored credential, and this turn acts on someone else's input (${party.who}): `
    + 'only the owner\'s own turns send the owner\'s stored credentials'
    + (kind !== undefined ? `, and the caller it runs for was not given the owner's ${kind} (to ${SHARED_KIND_WORDS[kind]})` : '')
    + '. Nothing was sent for this entry; fetch it without the service, or ask the owner to fetch it.';
}
