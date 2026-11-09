/** Persisted planning identity, independent of a source's historical ID format. */
export interface PlanningSourceIdentity {
  readonly spaceId: string;
  readonly kind: 'state' | 'decision' | 'language' | 'work-plan';
  readonly artifactId: string;
}

/** Closed SQL shared by private persisted reads and the owned write transaction.
 * Metadata finds older rows whose canonical URI was never saved. Two matches
 * are retained so callers refuse ambiguity instead of choosing an arbitrary row. */
const planningSpaceExpression = "CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.knowledgeSpaceId'), json_extract(metadata, '$.spaceId'), json_extract(metadata, '$.namespace')) END";
const planningKindExpression = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.planningArtifactKind') END";
const planningArtifactExpression = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.planningArtifactId') END";

/** A nonunique lookup index: preexisting ambiguous rows are not destroyed or
 * blessed by migration; the selector below still refuses them. */
export const planningSourceIdentityIndexSql = `CREATE INDEX IF NOT EXISTS idx_knowledge_sources_planning_identity
  ON knowledge_sources (${planningSpaceExpression}, ${planningKindExpression}, ${planningArtifactExpression})
  WHERE connector_id = 'goodvibes-project-planning'`;

// Separate branches retain the canonical-URI index and the planning tuple
// index. The second excludes the same row, including SQL NULL correctly.
export const planningSourceIdentitySql = `SELECT * FROM knowledge_sources
  WHERE connector_id = 'goodvibes-project-planning' AND canonical_uri = ?
  UNION ALL SELECT * FROM knowledge_sources
  WHERE connector_id = 'goodvibes-project-planning'
    AND ${planningSpaceExpression} = ? AND ${planningKindExpression} = ? AND ${planningArtifactExpression} = ?
    AND canonical_uri IS NOT ? LIMIT 2`;

export function planningSourceIdentityParams(identity: PlanningSourceIdentity): string[] {
  const { spaceId, kind, artifactId } = identity;
  if (typeof spaceId !== 'string' || !spaceId || typeof artifactId !== 'string' || !artifactId
    || !['state', 'decision', 'language', 'work-plan'].includes(kind)) {
    throw new TypeError('Invalid persisted planning source identity');
  }
  const canonicalUri = `goodvibes://planning/${encodeURIComponent(spaceId)}/${kind}/${encodeURIComponent(artifactId)}`;
  return [canonicalUri, spaceId, kind, artifactId, canonicalUri];
}
