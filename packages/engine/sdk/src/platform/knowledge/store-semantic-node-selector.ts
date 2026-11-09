/** Select native semantic roles from fields already present in their saved row.
 * The narrow index contains kind and scope, never another complete text body. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import type { KnowledgeNodeRecord } from './types.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from './spaces.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { SemanticIdentityHeldError as Held, readExactSemanticIds } from './store-semantic-fact-selector.js';
export type SemanticNodeSelector =
  | { readonly role: 'entity' | 'gap'; readonly spaceId: string; readonly sourceId: string; readonly title: string }
  | { readonly role: 'wiki'; readonly spaceId: string; readonly sourceId: string }
  | { readonly role: 'intrinsic-gap'; readonly spaceId: string; readonly subjectId: string };
export function semanticNodeSelector(input: SemanticNodeSelector): SemanticNodeSelector {
  const value = captureStrictJudgmentJson(input);
  if (!['entity', 'gap', 'wiki', 'intrinsic-gap'].includes(value.role)) throw new Held('malformed');
  const scope = value.role === 'intrinsic-gap' ? value.subjectId : value.sourceId;
  if (typeof scope !== 'string' || !scope || ('title' in value && (typeof value.title !== 'string' || !value.title.trim()))) throw new Held('malformed');
  const spaceId = normalizeKnowledgeSpaceId(value.spaceId);
  return Object.freeze(value.role === 'intrinsic-gap' ? { role: value.role, spaceId, subjectId: value.subjectId }
    : value.role === 'wiki' ? { role: value.role, spaceId, sourceId: value.sourceId }
    : { role: value.role, spaceId, sourceId: value.sourceId, title: value.title.trim() });
}
export function semanticNodeScopeMatches(record: KnowledgeNodeRecord, selector: SemanticNodeSelector): boolean {
  const kind = selector.role === 'entity' ? 'knowledge_entity' : selector.role === 'wiki' ? 'wiki_page' : 'knowledge_gap';
  const expectedRole = selector.role === 'entity' ? 'entity' : selector.role === 'wiki' ? 'wiki_page' : 'gap';
  if (record.kind !== kind || getKnowledgeSpaceId(record) !== selector.spaceId || record.metadata.semanticKind !== expectedRole) return false;
  if (selector.role === 'intrinsic-gap') {
    if (record.metadata.gapKind !== 'intrinsic_features') return false;
    const ids = readExactSemanticIds(record.metadata.linkedObjectIds);
    if (ids.length !== 1) throw new Held('ambiguous');
    if (ids[0] !== selector.subjectId) return false;
  } else {
    if (record.metadata.gapKind === 'intrinsic_features' || record.sourceId !== selector.sourceId
      || ('title' in selector && record.title !== selector.title)) return false;
  }
  const version = record.metadata.semanticIdentityVersion;
  if (version !== undefined && version !== 1) throw new Held('unsupported-format');
  return true;
}
const intrinsic = "json_extract(metadata, '$.gapKind') = 'intrinsic_features'";
const scopeKind = `CASE WHEN ${intrinsic} THEN 'subject' ELSE 'source' END`;
const scopeId = `CASE WHEN ${intrinsic} THEN json_extract(metadata, '$.linkedObjectIds[0]') ELSE source_id END`;
const predicate = "json_valid(metadata) AND kind IN ('knowledge_entity', 'knowledge_gap', 'wiki_page')";
/** Prefix lookup costs log(all nodes) plus the chosen source/subject role rows.
 * Exact title/space/known format checks stay on actual returned original rows. */
export const semanticNodeIdentityIndexSql = `CREATE INDEX idx_knowledge_nodes_semantic_role_scope ON knowledge_nodes (kind, ${scopeKind}, ${scopeId}) WHERE ${predicate}`;
export const semanticNodeCandidateSql = `SELECT * FROM knowledge_nodes WHERE ${predicate} AND kind = ? AND ${scopeKind} = ? AND ${scopeId} = ?`;
export function semanticNodeCandidateParams(selector: SemanticNodeSelector): string[] {
  return [selector.role === 'entity' ? 'knowledge_entity' : selector.role === 'wiki' ? 'wiki_page' : 'knowledge_gap',
    selector.role === 'intrinsic-gap' ? 'subject' : 'source', selector.role === 'intrinsic-gap' ? selector.subjectId : selector.sourceId];
}
export function createSemanticNodeIdentityIndex(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  if (!db.exec("SELECT type,sql FROM sqlite_master WHERE name='idx_knowledge_nodes_semantic_role_scope'")[0]?.values[0]) db.run(semanticNodeIdentityIndexSql);
  validateSemanticNodeIdentityIndex(db);
}
export function validateSemanticNodeIdentityIndex(db: Pick<SqlDatabase, 'exec'>): void {
  const installed = db.exec("SELECT type,sql FROM sqlite_master WHERE name='idx_knowledge_nodes_semantic_role_scope'")[0]?.values[0];
  if (!installed || installed[0] !== 'index' || installed[1] !== semanticNodeIdentityIndexSql) throw new Held('malformed');
}

export interface SemanticIssueSelector { readonly spaceId: string; readonly nodeId: string; readonly code: string; readonly namespace: string }
/** Reuse existing code/gap Btrees; these auxiliary selectors run only at the
 * actual corresponding write boundary, never for each unrelated gate await. */
export const semanticIssueCandidateSql = 'SELECT * FROM knowledge_issues WHERE code = ? AND node_id = ?';
export const semanticRefinementTaskCandidateSql = 'SELECT * FROM knowledge_refinement_tasks WHERE gap_id = ? AND space_id = ?';
export function semanticIssueCandidateParams(input: SemanticIssueSelector): string[] {
  const value = captureStrictJudgmentJson(input);
  if ([value.spaceId, value.nodeId, value.code, value.namespace].some(part => typeof part !== 'string' || !part)) throw new Held('malformed');
  return [value.code, value.nodeId];
}
export function semanticRefinementTaskCandidateParams(spaceId: string, gapId: string): string[] {
  if (typeof spaceId !== 'string' || !spaceId || typeof gapId !== 'string' || !gapId) throw new Held('malformed');
  return [gapId, spaceId];
}
