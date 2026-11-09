/** Compatibility reader ONLY for already-saved pre-owner-field review receipts.
 * These receipts retained SHA-256 rather than their original paired identity.
 * Matching their existing bytes is unavoidable; live grants and guards never use it.
 * Do not use this digest to issue new receipts or as an authority revision. */
import { createHash } from 'node:crypto';
import type { DelegatedReviewOwner } from '../control-plane/delegated-inbound-wire.js';
export function savedDelegatedOwnerMatcher(current: DelegatedReviewOwner): (saved: string) => boolean {
  let expected: string | undefined;
  return saved => {
    if (!/^[0-9a-f]{64}$/.test(saved)) return false;
    // One computation per read/list/cancel operation, only upon an actual old row.
    expected ??= createHash('sha256').update(JSON.stringify([current.principalId, current.tokenId, current.scopes])).digest('hex');
    return expected === saved;
  };
}
