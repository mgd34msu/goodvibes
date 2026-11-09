/** Materialized projection identity is an exact saved scope/target tuple.
 * IDs are opaque labels; scope remains a separate deterministic boundary. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import type { KnowledgeProjectionTargetKind, KnowledgeSourceRecord } from './types.js';
import { resolveKnowledgeSpaceScope, type KnowledgeSpaceScopeInput } from './spaces.js';

export const ALL_SPACES_PROJECTION_NAMESPACE = 'goodvibes:projection:all-spaces';
export interface GeneratedProjectionIdentity {
  readonly scopeKind: 'space' | 'all';
  readonly spaceId: string;
  readonly targetKind: KnowledgeProjectionTargetKind;
  readonly targetId: string;
}
const targetKinds = new Set(['overview', 'bundle', 'source', 'node', 'issue', 'dashboard', 'rollup']);
export class KnowledgeProjectionIdentityHeldError extends Error {
  override readonly name = 'KnowledgeProjectionIdentityHeldError';
  constructor(readonly reason: 'ambiguous' | 'unsupported-format' | 'malformed' | 'concurrent-update') {
    super(reason === 'concurrent-update' ? 'Shared projection data changed. Reload the project or knowledge store before retrying.'
      : `Saved projection identity is ${reason}; existing projection data was preserved.`);
  }
}
export function generatedProjectionIdentity(scope: KnowledgeSpaceScopeInput, targetKind: KnowledgeProjectionTargetKind,
  targetId: string): GeneratedProjectionIdentity {
  const space = resolveKnowledgeSpaceScope(scope);
  const identity: GeneratedProjectionIdentity = { scopeKind: space === null ? 'all' : 'space',
    spaceId: space ?? ALL_SPACES_PROJECTION_NAMESPACE, targetKind, targetId };
  projectionIdentityParams(identity);
  return Object.freeze(identity);
}
export function generatedProjectionIdentityMetadata(identity: GeneratedProjectionIdentity): Record<string, unknown> {
  projectionIdentityParams(identity);
  return { projectionIdentityVersion: 1, projectionScopeKind: identity.scopeKind, projectionSpaceId: identity.spaceId,
    targetKind: identity.targetKind, targetId: identity.targetId,
    knowledgeSpaceId: identity.spaceId, namespace: identity.spaceId,
    includeAllSpaces: identity.scopeKind === 'all' };
}
export function savedGeneratedProjectionIdentity(source: KnowledgeSourceRecord): GeneratedProjectionIdentity | null {
  if (source.connectorId !== 'knowledge-projection') return null;
  const metadata = source.metadata;
  if (!Object.hasOwn(metadata, 'projectionIdentityVersion')) return null;
  if (metadata.projectionIdentityVersion !== 1) throw new KnowledgeProjectionIdentityHeldError('unsupported-format');
  if (metadata.generatedProjection !== true || metadata.generatedKnowledgePage !== true) throw new KnowledgeProjectionIdentityHeldError('malformed');
  const { projectionScopeKind: scopeKind, projectionSpaceId: spaceId, targetKind, targetId } = metadata;
  if ((scopeKind !== 'space' && scopeKind !== 'all') || typeof spaceId !== 'string' || typeof targetKind !== 'string'
    || !targetKinds.has(targetKind) || typeof targetId !== 'string') throw new KnowledgeProjectionIdentityHeldError('malformed');
  const identity = { scopeKind, spaceId, targetKind: targetKind as KnowledgeProjectionTargetKind, targetId };
  projectionIdentityParams(identity);
  if (metadata.knowledgeSpaceId !== spaceId || metadata.namespace !== spaceId
    || metadata.includeAllSpaces !== (scopeKind === 'all') || metadata.projectionKind !== `knowledge-${targetKind}`) throw new KnowledgeProjectionIdentityHeldError('malformed');
  const suffix = /^kg-gen-([a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12})$/.exec(source.id)?.[1];
  if (!suffix || source.canonicalUri !== `knowledge://generated/${suffix}` || source.sourceUri !== source.canonicalUri) throw new KnowledgeProjectionIdentityHeldError('malformed');
  return identity;
}
/** Unknown old scope and all-space aggregates never enter a specific space.
 * All-space/manual inspection retains the original source, including its IDs. */
export function generatedProjectionMatchesSpecificScope(source: KnowledgeSourceRecord, scope: KnowledgeSpaceScopeInput): boolean {
  if (source.connectorId !== 'knowledge-projection' || resolveKnowledgeSpaceScope(scope) === null) return true;
  try { const identity = savedGeneratedProjectionIdentity(source); return identity?.scopeKind === 'space'; }
  catch { return false; }
}
export function preservedUnscopedProjectionIds(sources: readonly KnowledgeSourceRecord[]): readonly string[] {
  return sources.filter(source => {
    if (source.connectorId !== 'knowledge-projection') return false;
    try { return savedGeneratedProjectionIdentity(source) === null; } catch { return true; }
  }).map(source => source.id);
}
/** A source_for view points back to its canonical target. It does not relocate
 * that target or supply namespace provenance. Other source associations remain
 * ordinary canonical data, including HomeGraph's separate generated sources. */
export function isGeneratedProjectionViewEdge(source: KnowledgeSourceRecord | null | undefined,
  edge: { readonly fromKind: string; readonly fromId: string; readonly toKind: string; readonly toId: string; readonly relation: string }): boolean {
  return source?.connectorId === 'knowledge-projection' && source.metadata.generatedProjection === true
    && source.metadata.generatedKnowledgePage === true && edge.fromKind === 'source' && edge.fromId === source.id
    && edge.relation === 'source_for' && (edge.toKind === 'node' || edge.toKind === 'source')
    && source.metadata.targetKind === edge.toKind && source.metadata.targetId === `${edge.toKind}:${edge.toId}`
    && source.metadata.projectionKind === `knowledge-${edge.toKind}`;
}

const expression = (key: string): string => `CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.${key}') END`;
const tuple = ['projectionScopeKind', 'projectionSpaceId', 'targetKind', 'targetId'].map(expression);
const predicate = "connector_id = 'knowledge-projection' AND json_valid(metadata)";
// Missing old scope fields stay NULL, so all historical rows remain untouched.
// Version is deliberately absent: the same index locates future/malformed
// matching tuples so they can be preserved before any artifact is created.
export const generatedProjectionIdentityIndexSql = `CREATE UNIQUE INDEX idx_knowledge_sources_generated_projection_identity
  ON knowledge_sources (${tuple.join(', ')}) WHERE ${predicate}`;
export const generatedProjectionIdentitySql = `SELECT * FROM knowledge_sources WHERE ${predicate}
  AND ${tuple.map(part => `${part} = ?`).join(' AND ')} LIMIT 2`;
export function projectionIdentityParams(identity: GeneratedProjectionIdentity): string[] {
  const { scopeKind, spaceId, targetKind, targetId } = identity;
  if ((scopeKind !== 'space' && scopeKind !== 'all') || typeof spaceId !== 'string' || !spaceId || spaceId.trim() !== spaceId
    || (scopeKind === 'all' && spaceId !== ALL_SPACES_PROJECTION_NAMESPACE)
    || (scopeKind === 'space' && spaceId === ALL_SPACES_PROJECTION_NAMESPACE) || !targetKinds.has(targetKind)
    || typeof targetId !== 'string' || !targetId) throw new KnowledgeProjectionIdentityHeldError('malformed');
  return [scopeKind, spaceId, targetKind, targetId];
}
export function createGeneratedProjectionIdentityIndex(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  const installed = db.exec("SELECT type,sql FROM sqlite_master WHERE name='idx_knowledge_sources_generated_projection_identity'")[0]?.values[0];
  if (!installed) db.run(generatedProjectionIdentityIndexSql);
  else if (installed[0] !== 'index' || installed[1] !== generatedProjectionIdentityIndexSql) throw new KnowledgeProjectionIdentityHeldError('malformed');
  validateGeneratedProjectionIdentityIndex(db);
}
export function validateGeneratedProjectionIdentityIndex(db: Pick<SqlDatabase, 'exec'>): void {
  const installed = db.exec("SELECT type,sql FROM sqlite_master WHERE name='idx_knowledge_sources_generated_projection_identity'")[0]?.values[0];
  if (!installed || installed[0] !== 'index' || installed[1] !== generatedProjectionIdentityIndexSql) throw new KnowledgeProjectionIdentityHeldError('malformed');
}
