/** Ranking negotiation rides inside the existing authenticated nodeVersion.
 * Older v1 peers already ignore SemVer build metadata for version precedence,
 * while preserving these exact bytes in their signed canonical message. */
export const CLUSTER_RANK_FEATURE = 'gv-rank-fnv1a32-v1';
export const CLUSTER_V1_PEER_RANK_FEATURE = 'gv-rank-sha256-v1';
const maximumWireVersionLength = 64;
/** Producer-owned feature declaration; never infer support from release age. */
export function clusterRankingWireVersion(version: string, v1PeerCompatibility = false): string {
  const product = clusterProductVersion(version), feature = v1PeerCompatibility ? CLUSTER_V1_PEER_RANK_FEATURE : CLUSTER_RANK_FEATURE;
  const declared = `${product}${product.includes('+') ? '.' : '+'}${feature}`;
  if (!version || declared.length > maximumWireVersionLength) throw new Error('Cluster ranking declaration exceeds its wire version limit');
  return declared;
}
export function hasCurrentClusterRanking(version: string): boolean {
  const metadata = version.indexOf('+');
  return metadata >= 0 && version.slice(metadata + 1).split('.').at(-1) === CLUSTER_RANK_FEATURE;
}
/** Remove only this producer's final reserved feature tag for product display.
 * Pre-release and unrelated existing build metadata are preserved exactly. */
export function clusterProductVersion(version: string): string {
  const metadata = version.indexOf('+');
  if (metadata < 0) return version;
  const build = version.slice(metadata + 1).split('.'), feature = build.at(-1);
  if (feature !== CLUSTER_RANK_FEATURE && feature !== CLUSTER_V1_PEER_RANK_FEATURE) return version;
  build.pop(); return version.slice(0, metadata) + (build.length ? '+' + build.join('.') : '');
}
