/**
 * principals/types.ts
 *
 * The cross-channel principal identity model. A principal is one named actor
 * (a person or a bot) that can appear under several channel-specific sender
 * identities, a Slack user id, an email address, a phone number, so that
 * attribution and session continuity survive a channel hop (the same person
 * writing from Slack today and email tomorrow resolves to one principal).
 *
 * HONESTY: a sender identity that is not mapped to any principal resolves to
 * the shared UNKNOWN principal (see {@link unknownPrincipal}), never to a
 * guessed match. The registry answers "I do not know who this is" plainly
 * rather than inventing a name.
 */

/**
 * The kind vocabulary is deliberately the same union the transport-auth
 * principal already uses (daemon/http-policy.ts AuthenticatedPrincipalKind), so
 * an attributed session and the caller that created it speak one vocabulary.
 */
export type PrincipalKind = 'user' | 'bot' | 'service' | 'token';

export const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'bot', 'service', 'token'];

/**
 * One channel-specific sender identity. `channel` is the surface/medium the
 * identity belongs to (e.g. 'slack', 'email', 'phone', 'telegram'); `value` is
 * the opaque identifier within that channel (a Slack user id, an address, an
 * E.164 number). The pair is globally unique across the registry, a given
 * identity maps to at most one principal.
 */
export interface PrincipalIdentity {
  readonly channel: string;
  readonly value: string;
}

/** A named principal and the set of channel identities that resolve to it. */
export interface PrincipalRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: PrincipalKind;
  readonly identities: readonly PrincipalIdentity[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** The id of the shared unknown principal every unmapped sender resolves to. */
export const UNKNOWN_PRINCIPAL_ID = 'principal:unknown';

/**
 * What every surface calls a sender no one has named: who is asking, as a
 * person says it. The one source for the words; never "unknown principal".
 */
export const UNKNOWN_SENDER_LABEL = 'someone you have not added yet';

/**
 * The honest fallback for an unmapped sender: a principal record that names
 * itself "unknown" and carries the exact identity that failed to resolve, so a
 * caller sees WHAT was unmapped rather than a fabricated actor. `createdAt` /
 * `updatedAt` are 0 to mark it as a non-persisted sentinel, never a stored row.
 */
export function unknownPrincipal(identity?: PrincipalIdentity): PrincipalRecord {
  return {
    id: UNKNOWN_PRINCIPAL_ID,
    name: UNKNOWN_SENDER_LABEL,
    kind: 'user',
    identities: identity ? [identity] : [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Whether a record is the unknown-principal sentinel (id match, not name match). */
export function isUnknownPrincipal(record: Pick<PrincipalRecord, 'id'>): boolean {
  return record.id === UNKNOWN_PRINCIPAL_ID;
}

/**
 * The id of the shared OWNER principal, the single-owner system's one actor,
 * used when a sender is not in the named-principal registry but IS the
 * channel's authorized owner (the per-surface allowlist a channel's ingress
 * policy self-seeds from whoever pairs the channel first, see
 * `ChannelPolicyManager`). Distinct from a mapped `PrincipalRegistry` record:
 * this is the honest "it's the owner, by policy authorization" answer for a
 * surface that has never had an explicit named-principal identity attached.
 */
export const OWNER_PRINCIPAL_ID = 'principal:owner';

/**
 * The fallback for a sender who is not a named principal but whom channel
 * policy already authorized as this surface's owner: never a guess, never
 * `unknown`, the honest single owner this platform is scoped to (see
 * "no multi-tenancy"). `createdAt`/`updatedAt` are 0, matching
 * {@link unknownPrincipal}: a non-persisted sentinel, never a stored row.
 */
export function ownerPrincipal(identity?: PrincipalIdentity): PrincipalRecord {
  return {
    id: OWNER_PRINCIPAL_ID,
    name: 'owner',
    kind: 'user',
    identities: identity ? [identity] : [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Whether a record is the owner-principal sentinel (id match, not name match). */
export function isOwnerPrincipal(record: Pick<PrincipalRecord, 'id'>): boolean {
  return record.id === OWNER_PRINCIPAL_ID;
}

/** Normalize an identity for storage/lookup: trim, and lowercase the channel. */
export function normalizeIdentity(identity: PrincipalIdentity): PrincipalIdentity {
  return {
    channel: identity.channel.trim().toLowerCase(),
    value: identity.value.trim(),
  };
}

/** A stable lookup key for an identity pair. */
export function identityKey(identity: PrincipalIdentity): string {
  const normalized = normalizeIdentity(identity);
  // JSON keeps the pair unambiguous even when a channel or value contains the separator.
  return JSON.stringify([normalized.channel, normalized.value]);
}

/** The error codes the registry raises; mapped to wire status by the gateway route. */
export type PrincipalRegistryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CONFLICT';

export class PrincipalRegistryError extends Error {
  readonly code: PrincipalRegistryErrorCode;
  constructor(message: string, code: PrincipalRegistryErrorCode) {
    super(message);
    this.name = 'PrincipalRegistryError';
    this.code = code;
  }
}
