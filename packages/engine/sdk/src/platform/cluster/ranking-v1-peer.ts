/** Exact deployed v1 peer ordering, selected only by a real incoming peer
 * without the signed ranking feature declaration. This is wire compatibility,
 * not a local identity, cache key, or default ranking algorithm. */
import { createHash } from 'node:crypto';
const ranks = new Map<string, string>();
const maximumRanks = 256;
export function existingV1PeerSurfaceRank(nodeId: string, surfaceId: string): string {
  const key = JSON.stringify([nodeId, surfaceId]), known = ranks.get(key);
  if (known !== undefined) return known;
  const rank = createHash('sha256').update('goodvibes/cluster/spread/v1').update('\u0000').update(nodeId).update('\u0000').update(surfaceId).digest('hex');
  // Actual v1 fields are bounded by the codec. Do not retain arbitrary oversized
  // caller strings if an embedded host directly supplies its own rank input.
  if (key.length <= 1024) {
    if (ranks.size >= maximumRanks) { const oldest = ranks.keys().next().value; if (oldest !== undefined) ranks.delete(oldest); }
    ranks.set(key, rank);
  }
  return rank;
}
