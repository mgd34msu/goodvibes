import type { SQLiteStore } from '../state/sqlite-store.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeNodeRevisionRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeSemanticEnrichmentStateRecord,
  KnowledgeSourceRecord,
  KnowledgeUsageRecord,
} from './types.js';

/**
 * The store internals needed to cascade a single-record hard delete. Both node and
 * source deletes cascade edges, issues, usage records, consolidation candidates and
 * refinement tasks; node delete also
 * purges revision history and source delete purges derived extraction/enrichment
 * rows. Honest hard delete, no soft-hide.
 */
export interface KnowledgeRecordDeleteView {
  readonly sqlite: SQLiteStore;
  readonly sources: Map<string, KnowledgeSourceRecord>;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly issues: Map<string, KnowledgeIssueRecord>;
  readonly extractions: Map<string, KnowledgeExtractionRecord>;
  readonly usageRecords: Map<string, KnowledgeUsageRecord>;
  readonly consolidationCandidates: Map<string, KnowledgeConsolidationCandidateRecord>;
  readonly refinementTasks: Map<string, KnowledgeRefinementTaskRecord>;
  readonly nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>;
  readonly semanticEnrichmentStates: Map<string, KnowledgeSemanticEnrichmentStateRecord>;
}

/** Statements and map removals of one delete, applied together or not at all. */
interface DeletePlan {
  readonly statements: Array<readonly [string, string]>;
  readonly commit: Array<() => void>;
  readonly planned: Set<string>;
}

function newPlan(): DeletePlan {
  return { statements: [], commit: [], planned: new Set() };
}

function planDelete(plan: DeletePlan, table: string, column: string, id: string, forget: () => void): void {
  const key = `${table}:${column}:${id}`;
  if (plan.planned.has(key)) return;
  plan.planned.add(key);
  plan.statements.push([`DELETE FROM ${table} WHERE ${column} = ?`, id]);
  plan.commit.push(forget);
}

function runPlan(view: KnowledgeRecordDeleteView, plan: DeletePlan): void {
  view.sqlite.run('SAVEPOINT knowledge_record_delete');
  try {
    for (const [sql, id] of plan.statements) view.sqlite.run(sql, [id]);
    view.sqlite.run('RELEASE SAVEPOINT knowledge_record_delete');
  } catch (error) {
    view.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_record_delete');
    view.sqlite.run('RELEASE SAVEPOINT knowledge_record_delete');
    throw error;
  }
  for (const forget of plan.commit) forget();
}

function planNodeDelete(view: KnowledgeRecordDeleteView, plan: DeletePlan, id: string): void {
  for (const [edgeId, edge] of view.edges) {
    if ((edge.fromKind === 'node' && edge.fromId === id) || (edge.toKind === 'node' && edge.toId === id)) {
      planDelete(plan, 'knowledge_edges', 'id', edgeId, () => { view.edges.delete(edgeId); });
    }
  }
  for (const [issueId, issue] of view.issues) {
    if (issue.nodeId === id) planDelete(plan, 'knowledge_issues', 'id', issueId, () => { view.issues.delete(issueId); });
  }
  for (const [usageId, usage] of view.usageRecords) {
    if (usage.targetKind === 'node' && usage.targetId === id) {
      planDelete(plan, 'knowledge_usage_records', 'id', usageId, () => { view.usageRecords.delete(usageId); });
    }
  }
  for (const [candidateId, candidate] of view.consolidationCandidates) {
    if (candidate.subjectKind === 'node' && candidate.subjectId === id) {
      planDelete(plan, 'knowledge_consolidation_candidates', 'id', candidateId, () => { view.consolidationCandidates.delete(candidateId); });
    }
  }
  for (const [taskId, task] of view.refinementTasks) {
    if ((task.subjectKind === 'node' && task.subjectId === id) || task.gapId === id) {
      planDelete(plan, 'knowledge_refinement_tasks', 'id', taskId, () => { view.refinementTasks.delete(taskId); });
    }
  }
  planDelete(plan, 'knowledge_node_revisions', 'node_id', id, () => { view.nodeRevisions.delete(id); });
  planDelete(plan, 'knowledge_nodes', 'id', id, () => { view.nodes.delete(id); });
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
  planNodeDelete(view, plan, id);
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
  for (const [nodeId, node] of view.nodes) {
    if (node.sourceId !== id) continue;
    if (otherSupportingSourceIds(node, id).some((other) => view.sources.has(other))) continue;
    planNodeDelete(view, plan, nodeId);
  }
  for (const [edgeId, edge] of view.edges) {
    if ((edge.fromKind === 'source' && edge.fromId === id) || (edge.toKind === 'source' && edge.toId === id)) {
      planDelete(plan, 'knowledge_edges', 'id', edgeId, () => { view.edges.delete(edgeId); });
    }
  }
  for (const [extractionId, extraction] of view.extractions) {
    if (extraction.sourceId === id) planDelete(plan, 'knowledge_extractions', 'id', extractionId, () => { view.extractions.delete(extractionId); });
  }
  for (const [issueId, issue] of view.issues) {
    if (issue.sourceId === id) planDelete(plan, 'knowledge_issues', 'id', issueId, () => { view.issues.delete(issueId); });
  }
  for (const [usageId, usage] of view.usageRecords) {
    if (usage.targetKind === 'source' && usage.targetId === id) {
      planDelete(plan, 'knowledge_usage_records', 'id', usageId, () => { view.usageRecords.delete(usageId); });
    }
  }
  for (const [candidateId, candidate] of view.consolidationCandidates) {
    if (candidate.subjectKind === 'source' && candidate.subjectId === id) {
      planDelete(plan, 'knowledge_consolidation_candidates', 'id', candidateId, () => { view.consolidationCandidates.delete(candidateId); });
    }
  }
  for (const [taskId, task] of view.refinementTasks) {
    if (task.subjectKind === 'source' && task.subjectId === id) {
      planDelete(plan, 'knowledge_refinement_tasks', 'id', taskId, () => { view.refinementTasks.delete(taskId); });
    }
  }
  planDelete(plan, 'knowledge_semantic_enrichment_state', 'source_id', id, () => { view.semanticEnrichmentStates.delete(id); });
  planDelete(plan, 'knowledge_sources', 'id', id, () => { view.sources.delete(id); });
  runPlan(view, plan);
  return true;
}
