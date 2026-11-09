/** Exact detached identity for delegated review. A bearer token is never retained. */
import { isDeepStrictEqual } from 'node:util';
import type { NativePairedSnapshot } from '../security/http-auth.js';
import { delegatedReviewOwnerSchema, type DelegatedReviewOwner } from '../control-plane/delegated-inbound-wire.js';
import { savedDelegatedOwnerMatcher } from './saved-delegated-owner-digest.js';

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
export function delegatedReviewOwnership(current: DelegatedReviewOwner): (record: { readonly ownerRevision: string; readonly owner?: DelegatedReviewOwner }) => boolean {
  const matchesSavedOwner = savedDelegatedOwnerMatcher(current);
  // Old receipts lack an owner field. Only those actual saved rows use compatibility hashing.
  return record => record.owner !== undefined ? isDeepStrictEqual(record.owner, current) : matchesSavedOwner(record.ownerRevision);
}
