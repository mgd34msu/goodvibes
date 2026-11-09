/** Saved Home Assistant object identity. Hashes, slugs and model-provided titles
 * do not choose a native row. The node prefix index contains existing facts. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import type { KnowledgeNodeRecord } from './types.js';
import { HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX, getKnowledgeSpaceId, normalizeKnowledgeSpaceId, normalizeSpaceComponent } from './spaces.js';
import { HOME_GRAPH_NODE_KINDS, type HomeGraphNodeKind } from './home-graph/types.js';
export class HomeGraphIdentityHeldError extends Error {
  override readonly name = 'HomeGraphIdentityHeldError';
  constructor(readonly reason: 'malformed' | 'ambiguous' | 'unsupported-format' | 'stale') { super(`Home Graph saved identity is ${reason}; existing records were preserved.`); }
}
export interface HomeGraphNodeSelector {
  readonly spaceId: string;
  readonly kind: HomeGraphNodeKind;
  readonly objectId: string;
  /** Actual known historical references for one resolved object, not guessed
   * spellings. Multiple saved matching rows remain ambiguous and are preserved. */
  readonly aliases?: readonly string[] | undefined;
}
/** Existing Home Graph reads already recognize these installation aliases.
 * This key records that actual equivalence for a new row's unique index; it is
 * never a permission token, opaque revision or replacement for original scope. */
export function homeGraphIdentitySpace(spaceId: string): string {
  const space = normalizeKnowledgeSpaceId(spaceId);
  return space.toLowerCase().startsWith(HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX)
    ? `${HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX}${normalizeSpaceComponent(space.slice(HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX.length))}` : space;
}
export function homeGraphNodeSelector(input: HomeGraphNodeSelector): HomeGraphNodeSelector {
  const value = captureStrictJudgmentJson(input);
  if (typeof value.spaceId !== 'string' || !value.spaceId.trim() || !HOME_GRAPH_NODE_KINDS.includes(value.kind) || typeof value.objectId !== 'string' || !value.objectId.trim()
    || value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.length > 4 || value.aliases.some(id => typeof id !== 'string' || !id.trim()))) throw new HomeGraphIdentityHeldError('malformed');
  return Object.freeze({ kind: value.kind, spaceId: homeGraphIdentitySpace(value.spaceId), objectId: value.objectId,
    aliases: Object.freeze([...new Set(value.aliases ?? [])].filter(id => id !== value.objectId).sort()) });
}
export function homeGraphNodeMatches(record: Pick<KnowledgeNodeRecord, 'kind' | 'metadata'>, input: HomeGraphNodeSelector): boolean {
  const selector = homeGraphNodeSelector(input);
  if (record.kind !== selector.kind || homeGraphIdentitySpace(getKnowledgeSpaceId(record)) !== selector.spaceId) return false;
  const homeAssistant = record.metadata.homeAssistant;
  if (!homeAssistant || typeof homeAssistant !== 'object' || Array.isArray(homeAssistant)) return false;
  const id = (homeAssistant as Record<string, unknown>).objectId;
  if (typeof id !== 'string' || id !== selector.objectId && !selector.aliases?.includes(id)) return false;
  const version = record.metadata.homeGraphIdentityVersion;
  if (version !== undefined && version !== 1) throw new HomeGraphIdentityHeldError('unsupported-format');
  if (version === 1 && record.metadata.homeGraphIdentitySpace !== selector.spaceId) throw new HomeGraphIdentityHeldError('malformed');
  return true;
}
const objectId = "json_extract(metadata, '$.homeAssistant.objectId')";
const predicate = "json_valid(metadata) AND json_type(metadata, '$.homeAssistant.objectId') = 'text'";
export const homeGraphNodeIdentityIndexes = Object.freeze([
  Object.freeze({ name: 'idx_knowledge_nodes_homegraph_object', sql: `CREATE INDEX idx_knowledge_nodes_homegraph_object ON knowledge_nodes (kind, ${objectId}) WHERE ${predicate}` }),
  Object.freeze({ name: 'idx_knowledge_nodes_homegraph_object_v1', sql: `CREATE UNIQUE INDEX idx_knowledge_nodes_homegraph_object_v1 ON knowledge_nodes (kind, json_extract(metadata, '$.homeGraphIdentitySpace'), ${objectId}) WHERE ${predicate} AND json_extract(metadata, '$.homeGraphIdentityVersion') = 1 AND json_type(metadata, '$.homeGraphIdentitySpace') = 'text'` }),
]);
export function homeGraphNodeCandidateQuery(input: HomeGraphNodeSelector): { readonly sql: string; readonly params: string[] } {
  const selector = homeGraphNodeSelector(input), ids = [selector.objectId, ...selector.aliases ?? []];
  return { sql: `SELECT * FROM knowledge_nodes WHERE ${predicate} AND kind = ? AND ${objectId} IN (${ids.map(() => '?').join(',')})`, params: [selector.kind, ...ids] };
}
export function createHomeGraphNodeIdentityIndexes(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const index of homeGraphNodeIdentityIndexes) {
    const row = db.exec('SELECT type,sql FROM sqlite_master WHERE name = ?', [index.name])[0]?.values[0];
    if (!row) db.run(index.sql); else if (row[0] !== 'index' || row[1] !== index.sql) throw new HomeGraphIdentityHeldError('malformed');
  }
  validateHomeGraphNodeIdentityIndexes(db);
}
export function validateHomeGraphNodeIdentityIndexes(db: Pick<SqlDatabase, 'exec'>): void {
  for (const index of homeGraphNodeIdentityIndexes) {
    const row = db.exec('SELECT type,sql FROM sqlite_master WHERE name = ?', [index.name])[0]?.values[0];
    if (!row || row[0] !== 'index' || row[1] !== index.sql) throw new HomeGraphIdentityHeldError('malformed');
  }
}

/** Final local/staged SQL-prefix check before a current-format node write.
 * Existing rows retain their actual object key, so an ordinary update cannot
 * silently rebind a chosen ID to another tuple. Earlier rows are not rewritten. */
export function assertHomeGraphNodeIdentityWrite(db: Pick<SqlDatabase, 'exec'>, record: KnowledgeNodeRecord): void {
  if (record.metadata.homeGraphIdentityVersion === undefined) return;
  const homeAssistant = record.metadata.homeAssistant;
  if (record.metadata.homeGraphIdentityVersion !== 1 || !homeAssistant || typeof homeAssistant !== 'object' || Array.isArray(homeAssistant)
    || typeof (homeAssistant as Record<string, unknown>).objectId !== 'string') throw new HomeGraphIdentityHeldError('malformed');
  const selector = homeGraphNodeSelector({ spaceId: getKnowledgeSpaceId(record), kind: record.kind as HomeGraphNodeKind, objectId: (homeAssistant as { objectId: string }).objectId });
  if (record.metadata.homeGraphIdentitySpace !== selector.spaceId) throw new HomeGraphIdentityHeldError('malformed');
  const current = db.exec('SELECT kind,metadata FROM knowledge_nodes WHERE id = ? LIMIT 1', [record.id])[0]?.values[0];
  const matchesRow = (kind: unknown, rawMetadata: unknown): boolean => {
    if (typeof kind !== 'string' || typeof rawMetadata !== 'string') throw new HomeGraphIdentityHeldError('malformed');
    const metadata: unknown = JSON.parse(rawMetadata);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HomeGraphIdentityHeldError('malformed');
    return homeGraphNodeMatches({ kind: kind as KnowledgeNodeRecord['kind'], metadata: metadata as Record<string, unknown> }, selector);
  };
  if (current && !matchesRow(current[0], current[1])) throw new HomeGraphIdentityHeldError('stale');
  const query = homeGraphNodeCandidateQuery(selector), rows = db.exec(query.sql, query.params)[0];
  if (!rows) return;
  const idColumn = rows.columns.indexOf('id'), kindColumn = rows.columns.indexOf('kind'), metadataColumn = rows.columns.indexOf('metadata');
  if (idColumn < 0 || kindColumn < 0 || metadataColumn < 0) throw new HomeGraphIdentityHeldError('malformed');
  for (const row of rows.values) if (matchesRow(row[kindColumn], row[metadataColumn]) && row[idColumn] !== record.id) throw new HomeGraphIdentityHeldError('ambiguous');
}
