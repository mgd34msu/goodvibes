import type { SQLiteStore } from '../state/sqlite-store.js';
import { knowledgeRawRepresentation } from './store-record-representation.js';
import { selectRecords } from './store-row-table.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

/**
 * The store internals needed to cascade a single-record hard delete. Both node and
 * source deletes cascade edges, issues, usage records, consolidation candidates and
 * refinement tasks; node delete also
 * purges revision history and source delete purges derived extraction/enrichment
 * rows. Honest hard delete, no soft-hide. Each cascade is one indexed or
 * filtered DELETE, and a node a source delete keeps is rebound by one UPDATE of
 * its row; the tables read the database, so nothing else is updated.
 */
export interface KnowledgeRecordDeleteView {
  readonly sqlite: SQLiteStore;
  readonly sources: ReadonlyMap<string, KnowledgeSourceRecord>;
  readonly nodes: ReadonlyMap<string, KnowledgeNodeRecord>;
}

/** The statements of one delete, applied together or not at all. */
interface DeletePlan {
  readonly statements: Array<readonly [string, readonly string[]]>;
  readonly planned: Set<string>;
}

function newPlan(): DeletePlan {
  return { statements: [], planned: new Set() };
}

function planDelete(plan: DeletePlan, sql: string, params: readonly string[]): void {
  const key = `${sql}\u0000${params.join('\u0000')}`;
  if (plan.planned.has(key)) return;
  plan.planned.add(key);
  plan.statements.push([sql, params]);
}

function runPlan(view: KnowledgeRecordDeleteView, plan: DeletePlan): void {
  view.sqlite.run('SAVEPOINT knowledge_record_delete');
  try {
    for (const [sql, params] of plan.statements) view.sqlite.run(sql, [...params]);
    view.sqlite.run('RELEASE SAVEPOINT knowledge_record_delete');
  } catch (error) {
    view.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_record_delete');
    view.sqlite.run('RELEASE SAVEPOINT knowledge_record_delete');
    throw error;
  }
}

function planNodeDelete(plan: DeletePlan, id: string): void {
  planDelete(plan, "DELETE FROM knowledge_edges WHERE (from_kind = 'node' AND from_id = ?) OR (to_kind = 'node' AND to_id = ?)", [id, id]);
  planDelete(plan, 'DELETE FROM knowledge_issues WHERE node_id = ?', [id]);
  planDelete(plan, "DELETE FROM knowledge_usage_records WHERE target_kind = 'node' AND target_id = ?", [id]);
  planDelete(plan, "DELETE FROM knowledge_consolidation_candidates WHERE subject_kind = 'node' AND subject_id = ?", [id]);
  planDelete(plan, "DELETE FROM knowledge_refinement_tasks WHERE (subject_kind = 'node' AND subject_id = ?) OR gap_id = ?", [id, id]);
  planDelete(plan, 'DELETE FROM knowledge_node_revisions WHERE node_id = ?', [id]);
  planDelete(plan, 'DELETE FROM knowledge_nodes WHERE id = ?', [id]);
}

/** Source ids a node records as supporting it, besides its owning `sourceId`. */
function otherSupportingSourceIds(node: KnowledgeNodeRecord, deletedSourceId: string): string[] {
  const metadata = node.metadata;
  const claimed = [metadata.sourceId, metadata.compiledFrom, ...(Array.isArray(metadata.sourceIds) ? metadata.sourceIds : [])];
  return claimed.filter((value): value is string => typeof value === 'string' && value.length > 0 && value !== deletedSourceId);
}

/**
 * Sources joined to a node by an edge, either way, besides `deletedSourceId`:
 * an edge between a node and a source is evidence that source supports it,
 * whether or not a writer also listed the source in the node's metadata.
 */
function edgeSupportingSourceIds(view: KnowledgeRecordDeleteView, nodeId: string, deletedSourceId: string): string[] {
  const rows = view.sqlite.exec(
    "SELECT from_kind, from_id, to_kind, to_id FROM knowledge_edges WHERE (from_kind = 'node' AND from_id = ?) OR (to_kind = 'node' AND to_id = ?)",
    [nodeId, nodeId],
  )[0]?.values ?? [];
  const ids: string[] = [];
  for (const [fromKind, fromId, toKind, toId] of rows) {
    if (fromKind === 'source' && typeof fromId === 'string' && fromId !== deletedSourceId) ids.push(fromId);
    if (toKind === 'source' && typeof toId === 'string' && toId !== deletedSourceId) ids.push(toId);
  }
  return ids;
}

export function deleteKnowledgeNodeRecord(view: KnowledgeRecordDeleteView, id: string): boolean {
  if (!view.nodes.has(id)) return false;
  const plan = newPlan();
  planNodeDelete(plan, id);
  runPlan(view, plan);
  return true;
}

/**
 * Rebinds a kept node to the surviving source that supports it: the row's
 * `source_id` becomes that source, `metadata.sourceId` names it when it named
 * the deleted source, and the deleted id leaves `metadata.compiledFrom` and
 * `metadata.sourceIds`. The metadata is written as the node row writer writes
 * it (its stored representation as JSON).
 */
function planNodeRebind(plan: DeletePlan, node: KnowledgeNodeRecord, ownerId: string, deletedSourceId: string): void {
  const metadata: Record<string, unknown> = { ...knowledgeRawRepresentation(node).metadata };
  if (metadata.sourceId === deletedSourceId) metadata.sourceId = ownerId;
  if (metadata.compiledFrom === deletedSourceId) delete metadata.compiledFrom;
  if (Array.isArray(metadata.sourceIds)) metadata.sourceIds = metadata.sourceIds.filter((entry) => entry !== deletedSourceId);
  planDelete(plan, 'UPDATE knowledge_nodes SET source_id = ?, metadata = ? WHERE id = ?', [ownerId, JSON.stringify(metadata), node.id]);
}

/**
 * Removes the source, what was derived from it, and the nodes it owns. A node
 * that another source that still exists supports is kept, whether the support
 * is named in its metadata or is an edge between them: deleting it would lose
 * knowledge the surviving source still backs. The kept node is rebound to its
 * surviving source (the first one its metadata names, else the first joined
 * by an edge), so its owner and recorded evidence no longer name the deleted source.
 */
export function deleteKnowledgeSourceRecord(view: KnowledgeRecordDeleteView, id: string): boolean {
  if (!view.sources.has(id)) return false;
  const plan = newPlan();
  for (const node of selectRecords(view.nodes, 'source_id = ?', [id], '', (record) => record.sourceId === id)) {
    const survivor = otherSupportingSourceIds(node, id).find((other) => view.sources.has(other))
      ?? edgeSupportingSourceIds(view, node.id, id).find((other) => view.sources.has(other));
    if (survivor !== undefined) planNodeRebind(plan, node, survivor, id);
    else planNodeDelete(plan, node.id);
  }
  planDelete(plan, "DELETE FROM knowledge_edges WHERE (from_kind = 'source' AND from_id = ?) OR (to_kind = 'source' AND to_id = ?)", [id, id]);
  planDelete(plan, 'DELETE FROM knowledge_extractions WHERE source_id = ?', [id]);
  planDelete(plan, 'DELETE FROM knowledge_issues WHERE source_id = ?', [id]);
  planDelete(plan, "DELETE FROM knowledge_usage_records WHERE target_kind = 'source' AND target_id = ?", [id]);
  planDelete(plan, "DELETE FROM knowledge_consolidation_candidates WHERE subject_kind = 'source' AND subject_id = ?", [id]);
  planDelete(plan, "DELETE FROM knowledge_refinement_tasks WHERE subject_kind = 'source' AND subject_id = ?", [id]);
  planDelete(plan, 'DELETE FROM knowledge_semantic_enrichment_state WHERE source_id = ?', [id]);
  planDelete(plan, 'DELETE FROM knowledge_sources WHERE id = ?', [id]);
  runPlan(view, plan);
  return true;
}
