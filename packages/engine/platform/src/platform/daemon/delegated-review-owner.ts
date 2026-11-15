/** Exact detached identity for delegated review. A bearer token is never retained. */
import { isDeepStrictEqual } from 'node:util';
import type { NativePairedSnapshot } from '../security/http-auth.js';
import { delegatedReviewOwnerSchema, type DelegatedReviewOwner } from '../control-plane/delegated-inbound-wire.js';

export function captureDelegatedOwner(owner: NativePairedSnapshot): DelegatedReviewOwner {
  if (owner.authorityId !== owner.principalId || owner.authorityRevision !== owner.tokenId) throw new Error('Delegated review requires the original paired authority');
  const captured = delegatedReviewOwnerSchema.parse({ kind: owner.kind, principalId: owner.principalId,
    tokenId: owner.tokenId, authorityId: owner.authorityId, authorityRevision: owner.authorityRevision,
    scopes: [...owner.scopes].sort() });
  Object.freeze(captured.scopes); return Object.freeze(captured);
}
export function sameDelegatedOwner(current: NativePairedSnapshot | null, expected: DelegatedReviewOwner): boolean {
  if (current === null) return false;
  try { return isDeepStrictEqual(captureDelegatedOwner(current), expected); } catch { return false; }
}
/** A row saved before rows named their owner belongs to no one; it grants nothing and waits out its expiry. */
export function delegatedReviewOwnership(current: DelegatedReviewOwner): (record: { readonly owner?: DelegatedReviewOwner }) => boolean {
  return record => record.owner !== undefined && isDeepStrictEqual(record.owner, current);
}
