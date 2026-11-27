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

/**
 * The pairing id of a caller that authenticated with a device token, told by the kind of credential first: a sign-in
 * user's name is its principal id, so a user named like `pairing:<id>` (one made before such names were refused) is
 * never taken for that device. Undefined for a sign-in or any other principal.
 */
export function pairingTokenIdOfCaller(caller: { readonly principalId?: string | undefined; readonly principalKind?: string | undefined; readonly credentialKind?: string | undefined }): string | undefined {
  if (caller.principalKind === 'user' || caller.credentialKind === 'user-session') return undefined;
  return pairingTokenIdOfPrincipal(caller.principalId);
}

/** A caller as an authenticated request names it: the principal and the kinds the listener set. */
export interface CallerIdentity {
  readonly principalId?: string | undefined;
  readonly principalKind?: string | undefined;
  readonly credentialKind?: string | undefined;
}

/** A sign-in user, told by the kind of credential, never by its name. */
function isSignInCaller(caller: CallerIdentity): boolean {
  return caller.principalKind === 'user' || caller.credentialKind === 'user-session';
}

/**
 * Whether a caller is this machine's own operator token (or the in-process caller), told by the kind of credential
 * first: a sign-in user whose name is `shared-token` or `local` (one made before such names were refused) is never it.
 */
export function isLocalOwnerCaller(caller: CallerIdentity): boolean {
  if (isSignInCaller(caller)) return false;
  return caller.principalId === undefined || caller.principalId === LOCAL_OWNER_PRINCIPAL || caller.principalId === 'local';
}

const SIGN_IN_KEY_PREFIX = 'user:';

/**
 * The key a caller is kept and compared under where a record names who made something (a session's registrant): a
 * sign-in user is `user:<name>`, apart from every other credential's id; this machine's own credential is the operator
 * token's principal; any other is its principal id.
 */
export function callerKey(caller: CallerIdentity): string {
  if (isSignInCaller(caller)) return `${SIGN_IN_KEY_PREFIX}${caller.principalId ?? ''}`;
  return isLocalOwnerCaller(caller) ? LOCAL_OWNER_PRINCIPAL : caller.principalId!;
}

/**
 * A kept caller key read back (`callerKey`). One kept before keys had a kind (a bare principal id) is read by its
 * form: a reserved id or prefix is that credential's (`local` the operator token's), any other bare name a sign-in's.
 */
export function keptCallerKey(kept: string | undefined): string {
  if (kept === undefined || kept === 'local') return LOCAL_OWNER_PRINCIPAL;
  if (kept.startsWith(SIGN_IN_KEY_PREFIX)) return kept;
  return reservedPrincipalForm(kept) !== undefined ? kept : `${SIGN_IN_KEY_PREFIX}${kept}`;
}

/**
 * A sign-in user's name as records of what it did name it: `user:<name>` when the name is another credential's id
 * (`shared-token`, `pairing:<id>`), as daemon-api actor.ts gives its actor id; the name itself otherwise.
 */
export function signInActorId(name: string): string {
  return reservedPrincipalForm(name) !== undefined ? `${SIGN_IN_KEY_PREFIX}${name}` : name;
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
