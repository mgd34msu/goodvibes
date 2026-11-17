/**
 * How each knowledge table is read through SQL (store-row-table.ts): its key,
 * the column SQLite rewrites on every write (where there is one), the decoder,
 * and the secondary key ingest and scope selection look records up by.
 */
import type { SQLiteStore } from '../state/sqlite-store.js';
import { KnowledgeNodeRevisionRows, KnowledgeRowTable, keyColumn, type KnowledgeRowTableSpec } from './store-row-table.js';
import { edgeEndpointKey, extractionSourceKey, nodeSlugKey, sourceUriKey } from './store-indexed-map.js';
import { retainKnowledgeNodeRecord } from './store-node-authority.js';
import { mapScopeVerdictRow, splitScopeVerdictKey, type KnowledgeScopeVerdict } from './store-scope-verdicts.js';
import {
  mapCandidateRow, mapEdgeRow, mapExtractionRow, mapIssueRow, mapJobRunRow, mapNodeRevisionRow, mapNodeRow,
  mapRefinementTaskRow, mapReportRow, mapScheduleRow, mapSemanticEnrichmentStateRow, mapSourceRow, mapUsageRow,
} from './store-schema.js';
import type {
  KnowledgeConsolidationCandidateRecord, KnowledgeConsolidationReportRecord, KnowledgeEdgeRecord, KnowledgeExtractionRecord,
  KnowledgeIssueRecord, KnowledgeJobRunRecord, KnowledgeNodeRecord, KnowledgeRefinementTaskRecord, KnowledgeScheduleRecord,
  KnowledgeSemanticEnrichmentStateRecord, KnowledgeSourceRecord, KnowledgeUsageRecord,
} from './types.js';

const ID = keyColumn('id');
const REVISION = 'gv_revision';

/** The parts of a `\u0000`-joined secondary key, always `count` of them. */
function keyParts(key: string, count: number): string[] {
  const parts = key.split('\u0000');
  if (parts.length > count) parts.splice(count - 1, parts.length - count + 1, parts.slice(count - 1).join('\u0000'));
  while (parts.length < count) parts.push('');
  return parts;
}

const sources: KnowledgeRowTableSpec<KnowledgeSourceRecord> = {
  table: 'knowledge_sources', key: ID, revisionColumn: REVISION, decode: mapSourceRow,
  lookup: {
    keyOf: (record) => record.canonicalUri ? sourceUriKey(record.canonicalUri) : undefined,
    // A blank stored URI decodes to no canonicalUri, so it is never a match.
    where: "canonical_uri = ? AND trim(canonical_uri) <> ''",
    params: (key) => [key],
  },
};

const nodes: KnowledgeRowTableSpec<KnowledgeNodeRecord> = {
  table: 'knowledge_nodes', key: ID, revisionColumn: REVISION,
  decode: (columns, values) => retainKnowledgeNodeRecord(mapNodeRow(columns, values)),
  lookup: {
    keyOf: (record) => nodeSlugKey(record.kind, record.slug),
    where: 'kind = ? AND slug = ?',
    params: (key) => keyParts(key, 2),
  },
};

const edges: KnowledgeRowTableSpec<KnowledgeEdgeRecord> = {
  table: 'knowledge_edges', key: ID, revisionColumn: REVISION, decode: mapEdgeRow,
  lookup: {
    keyOf: edgeEndpointKey,
    where: 'from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ? AND relation = ?',
    params: (key) => keyParts(key, 5),
  },
};

const extractions: KnowledgeRowTableSpec<KnowledgeExtractionRecord> = {
  table: 'knowledge_extractions', key: ID, revisionColumn: REVISION, decode: mapExtractionRow,
  lookup: { keyOf: (record) => extractionSourceKey(record.sourceId), where: 'source_id = ?', params: (key) => [key] },
};

const scopeVerdicts: KnowledgeRowTableSpec<KnowledgeScopeVerdict> = {
  table: 'knowledge_scope_verdicts',
  key: { select: "record_kind || ':' || record_id", where: 'record_kind = ? AND record_id = ?', params: (key) => [...splitScopeVerdictKey(key)] },
  decode: mapScopeVerdictRow,
};

function table<T extends object>(sqlite: () => SQLiteStore, spec: KnowledgeRowTableSpec<T>): KnowledgeRowTable<T> {
  return new KnowledgeRowTable(sqlite, spec);
}

/** Every table the knowledge store reads, over one database. */
export function createKnowledgeTables(sqlite: () => SQLiteStore) {
  return {
    sources: table(sqlite, sources),
    nodes: table(sqlite, nodes),
    edges: table(sqlite, edges),
    issues: table<KnowledgeIssueRecord>(sqlite, { table: 'knowledge_issues', key: ID, decode: mapIssueRow }),
    extractions: table(sqlite, extractions),
    jobRuns: table<KnowledgeJobRunRecord>(sqlite, { table: 'knowledge_job_runs', key: ID, decode: mapJobRunRow }),
    refinementTasks: table<KnowledgeRefinementTaskRecord>(sqlite, { table: 'knowledge_refinement_tasks', key: ID, decode: mapRefinementTaskRow }),
    usageRecords: table<KnowledgeUsageRecord>(sqlite, { table: 'knowledge_usage_records', key: ID, decode: mapUsageRow }),
    consolidationCandidates: table<KnowledgeConsolidationCandidateRecord>(sqlite, { table: 'knowledge_consolidation_candidates', key: ID, decode: mapCandidateRow }),
    consolidationReports: table<KnowledgeConsolidationReportRecord>(sqlite, { table: 'knowledge_consolidation_reports', key: ID, decode: mapReportRow }),
    schedules: table<KnowledgeScheduleRecord>(sqlite, { table: 'knowledge_schedules', key: ID, decode: mapScheduleRow }),
    nodeRevisions: new KnowledgeNodeRevisionRows(sqlite, mapNodeRevisionRow),
    semanticEnrichmentStates: table<KnowledgeSemanticEnrichmentStateRecord>(sqlite, {
      table: 'knowledge_semantic_enrichment_state', key: keyColumn('source_id'), decode: mapSemanticEnrichmentStateRow,
    }),
    scopeVerdicts: table(sqlite, scopeVerdicts),
  };
}

export type KnowledgeTables = ReturnType<typeof createKnowledgeTables>;
