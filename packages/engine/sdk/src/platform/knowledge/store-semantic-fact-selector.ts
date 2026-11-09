/** Exact semantic claim lookup uses already stored claim fields. IDs are opaque
 * labels; neither this selector nor its metadata supplies support/activation. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import type { KnowledgeNodeRecord } from './types.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from './spaces.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';

export interface SemanticFactSelector {
  readonly spaceId: string; readonly factKind: string; readonly title: string;
  readonly summary: string | null; readonly value: string | null;
  readonly scope: { readonly kind: 'subjects'; readonly subjectIds: readonly string[] } | { readonly kind: 'source'; readonly sourceId: string };
}
export class SemanticIdentityHeldError extends Error {
  override readonly name = 'SemanticIdentityHeldError';
  constructor(readonly reason: 'ambiguous' | 'unsupported-format' | 'malformed' | 'stale') { super(`Semantic identity ${reason}; existing knowledge was preserved.`); }
}
export const exactSemanticIds = (ids: readonly string[]): string[] => {
  if (ids.some(id => typeof id !== 'string' || id.length === 0)) throw new SemanticIdentityHeldError('malformed');
  return [...new Set(ids)].sort();
};
/** Relationship identifiers are exact saved values, never display-normalized. */
export function readExactSemanticIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const captured = captureStrictJudgmentJson(value);
  if (!Array.isArray(captured) || captured.some(id => typeof id !== 'string' || !id)) throw new SemanticIdentityHeldError('malformed');
  return [...new Set(captured as string[])];
}
export function readExactSemanticId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new SemanticIdentityHeldError('malformed');
  return value;
}
export function semanticFactSelector(input: { readonly spaceId: string; readonly kind: string; readonly title: string;
  readonly summary?: string | undefined; readonly value?: string | undefined; readonly subjectIds?: readonly string[] | undefined; readonly fallbackScope?: string | undefined }): SemanticFactSelector {
  const value = captureStrictJudgmentJson(input), subjectIds = exactSemanticIds(value.subjectIds ?? []);
  if (typeof value.kind !== 'string' || !value.kind || typeof value.title !== 'string' || !value.title.trim()
    || value.summary !== undefined && typeof value.summary !== 'string' || value.value !== undefined && typeof value.value !== 'string') throw new SemanticIdentityHeldError('malformed');
  if (!subjectIds.length && (typeof value.fallbackScope !== 'string' || !value.fallbackScope)) throw new SemanticIdentityHeldError('malformed');
  return Object.freeze({ spaceId: normalizeKnowledgeSpaceId(value.spaceId), factKind: value.kind, title: value.title.trim(),
    summary: value.summary?.trim() || null, value: value.value ?? null,
    scope: subjectIds.length ? Object.freeze({ kind: 'subjects' as const, subjectIds: Object.freeze(subjectIds) }) : Object.freeze({ kind: 'source' as const, sourceId: value.fallbackScope! }) });
}
export function semanticFactIdentityMetadata(selector: SemanticFactSelector): Record<string, unknown> {
  return { semanticIdentityVersion: 1, semanticIdentityScope: selector.scope.kind,
    ...(selector.scope.kind === 'source' ? { semanticIdentitySourceId: selector.scope.sourceId } : {}),
    ...(selector.scope.kind === 'subjects' ? { subjectIds: [...selector.scope.subjectIds] } : {}) };
}
export function semanticFactScopeMatches(record: KnowledgeNodeRecord, selector: SemanticFactSelector): boolean {
  if (record.kind !== 'fact' || getKnowledgeSpaceId(record) !== selector.spaceId || record.metadata.semanticKind !== 'fact'
    || record.metadata.factKind !== selector.factKind || record.title !== selector.title || (record.summary ?? null) !== selector.summary
    || (record.metadata.value ?? null) !== selector.value) return false;
  const metadata = record.metadata, version = metadata.semanticIdentityVersion;
  if (version !== undefined && version !== 1) throw new SemanticIdentityHeldError('unsupported-format');
  const subjects = metadata.subjectIds;
  if (subjects !== undefined && (!Array.isArray(subjects) || subjects.some(id => typeof id !== 'string' || !id))) throw new SemanticIdentityHeldError('malformed');
  const subjectIds = exactSemanticIds((subjects ?? []) as string[]);
  if (version === 1) {
    if (metadata.semanticIdentityScope !== 'subjects' && metadata.semanticIdentityScope !== 'source') throw new SemanticIdentityHeldError('malformed');
    if (metadata.semanticIdentityScope === 'subjects') {
      if (!subjectIds.length || JSON.stringify(subjects) !== JSON.stringify(subjectIds) || Object.hasOwn(metadata, 'semanticIdentitySourceId')) throw new SemanticIdentityHeldError('malformed');
      return selector.scope.kind === 'subjects' && JSON.stringify(subjectIds) === JSON.stringify(selector.scope.subjectIds);
    }
    if (subjectIds.length || typeof metadata.semanticIdentitySourceId !== 'string' || !metadata.semanticIdentitySourceId) throw new SemanticIdentityHeldError('malformed');
    return selector.scope.kind === 'source' && metadata.semanticIdentitySourceId === selector.scope.sourceId;
  }
  // Actual old rows retain their existing ID only after complete exact claim
  // comparison. Their lossy ASCII/hash recipe never selects a different claim.
  if (subjectIds.length) return selector.scope.kind === 'subjects' && JSON.stringify(subjectIds) === JSON.stringify(selector.scope.subjectIds);
  if (selector.scope.kind !== 'source') return false;
  const sources = metadata.sourceIds;
  const candidates = sources === undefined ? [metadata.sourceId, record.sourceId].filter((id): id is string => typeof id === 'string' && !!id)
    : Array.isArray(sources) && sources.every(id => typeof id === 'string' && !!id) ? sources as string[] : undefined;
  if (!candidates) throw new SemanticIdentityHeldError('malformed');
  const origins = exactSemanticIds(candidates);
  if (origins.length !== 1) throw new SemanticIdentityHeldError('ambiguous');
  return origins[0] === selector.scope.sourceId;
}

const field = (key: string) => `json_extract(metadata, '$.${key}')`;
const space = `coalesce(nullif(trim(${field('knowledgeSpaceId')}), ''), nullif(trim(${field('spaceId')}), ''), nullif(trim(${field('namespace')}), ''), 'default')`;
const prefix = [space, field('factKind'), 'title', 'json_array(summary)', `json_array(${field('value')})`];
const predicate = "kind = 'fact' AND json_valid(metadata)";
// Last NULL makes historical/future rows searchable without asserting their
// uniqueness. Every fresh scope component is non-NULL, including unset values.
export const semanticFactIdentityIndexSql = `CREATE UNIQUE INDEX idx_knowledge_nodes_semantic_fact_identity ON knowledge_nodes (${[...prefix,
  `coalesce(${field('semanticIdentityScope')}, '')`, `coalesce(${field('semanticIdentitySourceId')}, '')`,
  `coalesce(${field('subjectIds')}, '[]')`, `CASE WHEN ${field('semanticIdentityVersion')} = 1 THEN 1 END`].join(', ')}) WHERE ${predicate}`;
export const semanticFactCandidateSql = `SELECT * FROM knowledge_nodes WHERE ${predicate} AND ${prefix.map(part => `${part} = ?`).join(' AND ')}`;
export function semanticFactCandidateParams(selector: SemanticFactSelector): string[] {
  return [selector.spaceId, selector.factKind, selector.title, JSON.stringify([selector.summary]), JSON.stringify([selector.value])];
}
export function createSemanticFactIdentityIndex(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  const installed = db.exec("SELECT type,sql FROM sqlite_master WHERE name='idx_knowledge_nodes_semantic_fact_identity'")[0]?.values[0];
  if (!installed) db.run(semanticFactIdentityIndexSql);
  validateSemanticFactIdentityIndex(db);
}
export function validateSemanticFactIdentityIndex(db: Pick<SqlDatabase, 'exec'>): void {
  const installed = db.exec("SELECT type,sql FROM sqlite_master WHERE name='idx_knowledge_nodes_semantic_fact_identity'")[0]?.values[0];
  if (!installed || installed[0] !== 'index' || installed[1] !== semanticFactIdentityIndexSql) throw new SemanticIdentityHeldError('malformed');
}
