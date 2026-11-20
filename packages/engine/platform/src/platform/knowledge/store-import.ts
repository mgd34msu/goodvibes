import { notifyKnowledgeCommitted } from './commit-notification.js';
import { knowledgeRecordSnapshotFromRows, type KnowledgeRecordSnapshot } from './store-record-snapshot.js';
import { captureKnowledgeStoreInput, copyKnowledgeRepresentation } from './store-record-representation.js';
import type { SQLiteStore } from '../state/sqlite-store.js';
import { activationSourceIds } from './activation/projection.js';
import { KnowledgeNodeActivationHeldError as Held, type KnowledgeNodeActivationOptions } from './activation/types.js';
import { observeKnowledgeValue } from './local-value-observation.js';
import { findKnowledgeEdge, prepareKnowledgeEdgeRecord, writeKnowledgeEdgeRow } from './store-edge-writes.js';
import { copyRecordMap, extractionSourceKey, lookupRecord, sourceUriKey } from './store-indexed-map.js';
import { prepareKnowledgeExtractionRecord, prepareKnowledgeSourceRecord, writeKnowledgeExtractionRow, writeKnowledgeSourceRow } from './store-evidence-writes.js';
import { assertPreparedNodeWrites, markPreparedNodeWritten, preparedNodeWrites, prepareNodeActivationPass, writePreparedNodeActivationCache, type NodeMutationDraft } from './store-node-activation.js';
import { recordKnowledgeNodeRevisions, writeKnowledgeNodeRow } from './store-node-history.js';
import { prepareKnowledgeIssueRecord, writeKnowledgeIssueRow } from './store-node-issue-writes.js';
import { retainKnowledgeNodeObservation } from './store-node-observation.js';
import type { KnowledgeStore } from './store.js';
import type { OwnerStamp } from '../utils/owner-stamp.js';
import type { KnowledgeEdgeRecord, KnowledgeEdgeUpsertInput, KnowledgeExtractionRecord, KnowledgeExtractionUpsertInput,
  KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord, KnowledgeNodeRevisionRecord, KnowledgeNodeUpsertInput,
  KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from './types.js';

/** Largest one imported record may be, in JSON characters. An import of any size is
 * applied in batches; only a single record over this is refused, by name. */
export const KNOWLEDGE_IMPORT_RECORD_MAX_CHARS = 1_000_000;

export class KnowledgeImportRecordTooLargeError extends Error {
  override readonly name = 'KnowledgeImportRecordTooLargeError';
  constructor(readonly kind: string, readonly index: number, readonly id: string | undefined, readonly chars: number) {
    super(`Import ${kind} record ${index + 1}${id ? ` (${id})` : ''} has ${chars} characters; the limit is ${KNOWLEDGE_IMPORT_RECORD_MAX_CHARS}. Nothing was imported; shorten or drop that record and import again.`);
  }
}

/** Refuses the import before any write when one record is over the limit. One JSON pass per record. */
export function assertKnowledgeImportRecordSizes(input: KnowledgeImportInput): void {
  const kinds = [['source', input.sources], ['extraction', input.extractions], ['node', input.nodes], ['edge', input.edges], ['issue', input.issues]] as const;
  for (const [kind, records] of kinds) {
    for (const [index, record] of records.entries()) {
      const chars = JSON.stringify(record)?.length ?? 0;
      if (chars > KNOWLEDGE_IMPORT_RECORD_MAX_CHARS) throw new KnowledgeImportRecordTooLargeError(kind, index, (record as { readonly id?: string }).id, chars);
    }
  }
}

/** Exact physically published identities; immutable arrays retain the committed rows. */
export interface KnowledgeImportReceipt {
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}
export interface KnowledgeImportInput {
  readonly sources: readonly KnowledgeSourceUpsertInput[];
  readonly extractions: readonly KnowledgeExtractionUpsertInput[];
  readonly nodes: readonly KnowledgeNodeUpsertInput[];
  readonly edges: readonly KnowledgeEdgeUpsertInput[];
  readonly issues: readonly KnowledgeIssueUpsertInput[];
}
/** Internal producer preparation receives exact normalized, detached proposed evidence. */
export interface KnowledgeImportStage {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractions: readonly KnowledgeExtractionRecord[];
  readonly assertCurrent: () => void;
}
export interface KnowledgeImportGraph {
  readonly nodes: readonly KnowledgeNodeUpsertInput[];
  readonly edges: readonly KnowledgeEdgeUpsertInput[];
  readonly issues: readonly KnowledgeIssueUpsertInput[];
  readonly assertCurrent?: (() => void) | undefined;
  /**
   * The graph is the whole of what one owner (a source's compilation) produces
   * at `revision`: every edge that owner stamped at another revision and this
   * graph does not write again is removed in the same transaction. Edges the
   * owner did not stamp (authored links, enrichment) are never touched.
   */
  readonly supersedes?: OwnerStamp | undefined;
}

/** Where a generated edge came from: written into its metadata as `compiledFrom`. */
export const KNOWLEDGE_EDGE_STAMP_KEY = 'compiledFrom';
export type PrepareKnowledgeImportGraph = (stage: KnowledgeImportStage) => Promise<KnowledgeImportGraph>;
const NativePublicationMap = Map;
const nativePublicationApply = Reflect.apply;
const nativePublicationMapGet = Map.prototype.get, nativePublicationMapSet = Map.prototype.set;

export interface KnowledgeImportView {
  readonly sqlite: SQLiteStore;
  readonly sources: Map<string, KnowledgeSourceRecord>;
  readonly extractions: Map<string, KnowledgeExtractionRecord>;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly issues: Map<string, KnowledgeIssueRecord>;
  /** Native store closure; invoked only alongside the actual committed cache rows. */
  readonly beforeIssueWrite?: ((record: KnowledgeIssueRecord) => void) | undefined;
  readonly beforeNodeWrite?: ((record: KnowledgeNodeRecord) => void) | undefined;
  readonly nodePublished?: ((record: KnowledgeNodeRecord, previous: KnowledgeNodeRecord | undefined, snapshot: KnowledgeRecordSnapshot) => void) | undefined;
}
function extractionFor(extractions: ReadonlyMap<string, KnowledgeExtractionRecord>, sourceId: string): KnowledgeExtractionRecord | null {
  return lookupRecord(extractions, extractionSourceKey(sourceId), (record) => record.sourceId === sourceId) ?? null;
}

/** Stage complete ordinary records and judgments without changing the live store or SQL. */
export async function applyKnowledgeImport(store: KnowledgeStore, view: KnowledgeImportView, input: KnowledgeImportInput,
  prepareNode: (input: KnowledgeNodeUpsertInput, original: KnowledgeNodeUpsertInput) => NodeMutationDraft, floor: number | undefined, scope: object,
  options: KnowledgeNodeActivationOptions, prepareGraph?: PrepareKnowledgeImportGraph, onCommitted?: () => void): Promise<KnowledgeImportReceipt> {
  const checks: (() => void)[] = [];
  function watch(read: () => unknown): void {
    const expected = observeKnowledgeValue(read() ?? null);
    checks.push(() => { if (!expected.matches(read() ?? null)) throw new Held('stale'); });
  }
  function assertEvidenceCurrent(): void {
    if (options.signal?.aborted) throw new Held('aborted');
    for (const check of checks) check();
  }
  let graphCheck: (() => void) | undefined;
  function assertCurrent(): void { assertEvidenceCurrent(); graphCheck?.(); }
  const sources = copyRecordMap(view.sources), extractions = copyRecordMap(view.extractions), edges = copyRecordMap(view.edges), issues = new Map(view.issues);
  const sourceWrites: KnowledgeSourceRecord[] = [], extractionWrites: KnowledgeExtractionRecord[] = [];
  const edgeWrites: KnowledgeEdgeRecord[] = [], issueWrites: KnowledgeIssueRecord[] = [];
  const removedExtractions = new Set<string>();
  for (const source of input.sources) {
    watch(() => source.id ? view.sources.get(source.id) : source.canonicalUri ? store.getSourceByCanonicalUri(source.canonicalUri) : null);
    const canonicalUri = source.canonicalUri;
    const existing = source.id ? sources.get(source.id) : canonicalUri
      ? lookupRecord(sources, sourceUriKey(canonicalUri), (record) => record.canonicalUri === canonicalUri) : undefined;
    const preparedSource = prepareKnowledgeSourceRecord(source, existing);
    const record = copyKnowledgeRepresentation(preparedSource, captureKnowledgeStoreInput(preparedSource));
    sources.set(record.id, record); sourceWrites.push(record);
  }
  for (const extraction of input.extractions) {
    watch(() => extraction.id ? view.extractions.get(extraction.id) : extractionFor(view.extractions, extraction.sourceId));
    watch(() => extractionFor(view.extractions, extraction.sourceId));
    const existing = extraction.id ? extractions.get(extraction.id) : extractionFor(extractions, extraction.sourceId);
    const preparedExtraction = prepareKnowledgeExtractionRecord(extraction, existing, sources.get(extraction.sourceId));
    const record = copyKnowledgeRepresentation(preparedExtraction, captureKnowledgeStoreInput(preparedExtraction));
    const displaced = extractionFor(extractions, record.sourceId);
    if (displaced && displaced.id !== record.id) { extractions.delete(displaced.id); removedExtractions.add(displaced.id); }
    extractions.set(record.id, record); extractionWrites.push(record);
  }
  const graph: KnowledgeImportGraph = prepareGraph ? await prepareGraph({ sources: Object.freeze([...sourceWrites]), extractions: Object.freeze([...extractionWrites]), assertCurrent: assertEvidenceCurrent }) : input;
  graphCheck = graph.assertCurrent;
  assertCurrent();
  const drafts = graph.nodes.map((node) => prepareNode(captureKnowledgeStoreInput(node), node));
  if (new Set(drafts.map(({ record }) => record.id)).size !== drafts.length) throw new Held('stale');
  for (const { record } of drafts) for (const id of activationSourceIds(record)) {
    watch(() => store.getSource(id)); watch(() => store.getExtractionBySourceId(id));
  }
  for (const edge of captureKnowledgeStoreInput(graph.edges)) {
    watch(() => findKnowledgeEdge(view.edges, edge));
    const record = captureKnowledgeStoreInput(prepareKnowledgeEdgeRecord(edge, findKnowledgeEdge(edges, edge)));
    edges.set(record.id, record); edgeWrites.push(record);
  }
  const nodeView = new Map(view.nodes);
  for (const { record } of drafts) nodeView.set(record.id, record);
  for (const issue of captureKnowledgeStoreInput(graph.issues)) {
    if (issue.id) watch(() => view.issues.get(issue.id!));
    const prepared = prepareKnowledgeIssueRecord({ issues, sources, nodes: nodeView }, issue);
    const record = captureKnowledgeStoreInput(prepared.record);
    issues.set(record.id, record);
    if (!prepared.preserve) issueWrites.push(record);
  }
  // A retained observation may close over a source absent from the node's source IDs.
  // Imported JSON cannot prove that hidden dependency survived changed evidence.
  const invalidatesRetainedObservations = sourceWrites.some((record) => !observeKnowledgeValue(record).matches(view.sources.get(record.id) ?? null))
    || extractionWrites.some((record) => !observeKnowledgeValue(record).matches(view.extractions.get(record.id) ?? null));
  const stage = { assertCurrent, invalidatesRetainedObservations, evidenceFor: (record: KnowledgeNodeRecord) => activationSourceIds(record).map((id) => ({ id,
    source: sources.get(id) ?? null, extraction: extractionFor(extractions, id) })) };
  const prepared = await prepareNodeActivationPass(store, drafts, options, floor, scope, stage);
  const nodes = preparedNodeWrites(store, prepared, scope);
  const revisions = new Map<string, KnowledgeNodeRevisionRecord[]>();
  for (const { record } of nodes) revisions.set(record.id, [...(view.nodeRevisions.get(record.id) ?? [])]);
  const nodePublicationSnapshots = new NativePublicationMap<KnowledgeNodeRecord, KnowledgeRecordSnapshot>();
  for (const { record, existing } of nodes) if (record !== existing) view.beforeNodeWrite?.(record);
  for (const record of issueWrites) view.beforeIssueWrite?.(record);
  const supersedes = graph.supersedes;
  const supersededEdgeIds: string[] = [];
  await view.sqlite.publishPrepared((sqlite) => {
    if (supersedes) {
      // The owner's edges at any other revision that this graph does not write again: one indexed read, then their deletes.
      const rewritten = new Set(edgeWrites.map((record) => record.id));
      const rows = sqlite.exec(`SELECT id FROM knowledge_edges WHERE from_kind = 'source' AND from_id = ?
        AND json_extract(metadata, '$.${KNOWLEDGE_EDGE_STAMP_KEY}.owner') = ? AND json_extract(metadata, '$.${KNOWLEDGE_EDGE_STAMP_KEY}.revision') IS NOT ?`,
      [supersedesSourceId(supersedes), supersedes.owner, supersedes.revision])[0]?.values ?? [];
      for (const [id] of rows) {
        if (typeof id !== 'string' || rewritten.has(id)) continue;
        sqlite.run('DELETE FROM knowledge_edges WHERE id = ?', [id]);
        supersededEdgeIds.push(id);
      }
    }
    for (const record of sourceWrites) writeKnowledgeSourceRow(sqlite, record);
    for (const record of extractionWrites) writeKnowledgeExtractionRow(sqlite, record);
    for (const { record, existing, now } of nodes) {
      if (record === existing) { nativePublicationApply(nativePublicationMapSet, nodePublicationSnapshots, [record, knowledgeRecordSnapshotFromRows('node', sqlite.exec('SELECT * FROM knowledge_nodes WHERE id = ? LIMIT 1', [record.id]))]); continue; }
      nativePublicationApply(nativePublicationMapSet, nodePublicationSnapshots, [record, knowledgeRecordSnapshotFromRows('node', writeKnowledgeNodeRow(sqlite, record))]);
      recordKnowledgeNodeRevisions(sqlite, revisions, record, existing, now);
    }
    for (const record of edgeWrites) writeKnowledgeEdgeRow(sqlite, record);
    for (const record of issueWrites) writeKnowledgeIssueRow(sqlite, record);
    writePreparedNodeActivationCache(prepared, sqlite);
  }, () => assertPreparedNodeWrites(store, prepared, scope), () => {
    for (const record of sourceWrites) view.sources.set(record.id, record);
    for (const id of removedExtractions) view.extractions.delete(id);
    for (const record of extractionWrites) {
      // A later import row may have replaced this extraction's source-unique identity.
      if (extractions.get(record.id) === record) view.extractions.set(record.id, record);
    }
    for (const { record } of nodes) view.nodes.set(record.id, record);
    for (const [id, records] of revisions) view.nodeRevisions.set(id, records);
    for (const id of supersededEdgeIds) view.edges.delete(id);
    for (const record of edgeWrites) view.edges.set(record.id, record);
    for (const record of issueWrites) view.issues.set(record.id, record);
    nodes.forEach(({ existing, record, observationEvidence, preserveObservation }, index) => {
      retainKnowledgeNodeObservation(preserveObservation ? existing : undefined, record, observationEvidence); markPreparedNodeWritten(prepared, index);
      if (view.nodePublished) {
        const snapshot: KnowledgeRecordSnapshot | undefined = nativePublicationApply(nativePublicationMapGet, nodePublicationSnapshots, [record]);
        if (!snapshot) throw new Error('Missing native node publication image');
        view.nodePublished(record, existing, snapshot);
      }
    });
  });
  const receipt = Object.freeze({ nodes: Object.freeze(nodes.map(({ record }) => record)), sources: Object.freeze([...sourceWrites]), edges: Object.freeze([...edgeWrites]) });
  // A visible but indeterminate publication retains its internal mirror and
  // artifact references; only a durable acknowledgment reaches this callback.
  notifyKnowledgeCommitted(onCommitted);
  return receipt;
}

/** The owner of a source's compiled edges is `knowledge-source:<id>`. */
export function knowledgeSourceCompileOwner(sourceId: string): string {
  return `knowledge-source:${sourceId}`;
}

function supersedesSourceId(stamp: OwnerStamp): string {
  const prefix = 'knowledge-source:';
  if (!stamp.owner.startsWith(prefix)) throw new Error(`Knowledge import cannot supersede edges of owner ${stamp.owner}`);
  return stamp.owner.slice(prefix.length);
}
