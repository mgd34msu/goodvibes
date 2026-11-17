import type { SQLiteStore } from '../state/sqlite-store.js';
import { selectRecords } from './store-row-table.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

/**
 * The store internals needed to cascade a single-record hard delete. Both node and
 * source deletes cascade edges, issues, usage records, consolidation candidates and
 * refinement tasks; node delete also
 * purges revision history and source delete purges derived extraction/enrichment
 * rows. Honest hard delete, no soft-hide. Each cascade is one indexed or
 * filtered DELETE; the tables read the database, so nothing else is updated.
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

export function deleteKnowledgeNodeRecord(view: KnowledgeRecordDeleteView, id: string): boolean {
  if (!view.nodes.has(id)) return false;
  const plan = newPlan();
  planNodeDelete(plan, id);
  runPlan(view, plan);
  return true;
}

/**
 * Removes the source, what was derived from it, and the nodes it owns. A node
 * that names another source that still exists as support is kept: deleting it
 * would lose knowledge the surviving source still backs.
 */
export function deleteKnowledgeSourceRecord(view: KnowledgeRecordDeleteView, id: string): boolean {
  if (!view.sources.has(id)) return false;
  const plan = newPlan();
  for (const node of selectRecords(view.nodes, 'source_id = ?', [id], '', (record) => record.sourceId === id)) {
    if (otherSupportingSourceIds(node, id).some((other) => view.sources.has(other))) continue;
    planNodeDelete(plan, node.id);
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
