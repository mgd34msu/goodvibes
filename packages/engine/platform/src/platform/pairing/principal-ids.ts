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

/** Principal ids a credential other than a sign-in user authenticates as (the in-process caller is `local`, one with no principal `unknown`). */
const RESERVED_PRINCIPAL_IDS: readonly string[] = [LOCAL_OWNER_PRINCIPAL, 'local', 'unknown'];
/** Prefixes of the principal ids of paired devices, chat senders, peers and the program itself. */
const RESERVED_PRINCIPAL_PREFIXES: readonly string[] = [PAIRING_PRINCIPAL_PREFIX, 'channel:', 'peer:', 'system:'];

/**
 * The reserved principal-id form a sign-in user name would take (`shared-token`,
 * `pairing:<id>`), or undefined when the name is free. A user name is the
 * user's principal id, in the same namespace as these, so one that equals
 * another credential's id would be taken for it.
 */
export function reservedPrincipalForm(name: string): string | undefined {
  const lowered = name.toLowerCase();
  const exact = RESERVED_PRINCIPAL_IDS.find((id) => lowered === id);
  if (exact !== undefined) return `"${exact}"`;
  const prefix = RESERVED_PRINCIPAL_PREFIXES.find((start) => lowered.startsWith(start));
  return prefix === undefined ? undefined : `"${prefix}<id>"`;
}
