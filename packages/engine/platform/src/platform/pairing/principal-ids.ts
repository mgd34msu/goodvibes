/**
 * pairing/principal-ids.ts, how the principals a credential authenticates as
 * are named: the owner's own operator token, and one principal per paired
 * device (`pairing:<id>`). Every place that builds or reads one of these ids
 * uses these; nothing else spells the format. No imports, so any listener,
 * store or terminal can read it without loading the pairing store.
 */

/** The principal the owner's own machine authenticates as: the one its operator token already is. */
export const LOCAL_OWNER_PRINCIPAL = 'shared-token';

const PAIRING_PRINCIPAL_PREFIX = 'pairing:';

/** The `pairing:<id>` principal id a pairing-token request authenticates as. */
export function pairingPrincipalId(tokenId: string): string {
  return `${PAIRING_PRINCIPAL_PREFIX}${tokenId}`;
}

/** The pairing id behind a `pairing:<id>` principal, or undefined for any other principal. */
export function pairingTokenIdOfPrincipal(principalId: string | undefined): string | undefined {
  return principalId?.startsWith(PAIRING_PRINCIPAL_PREFIX) ? principalId.slice(PAIRING_PRINCIPAL_PREFIX.length) : undefined;
}
