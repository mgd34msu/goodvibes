import { createHomeGraphSourceIdentityIndexes, type HomeGraphSourceSelector } from './store-homegraph-source-selector.js';
import { createHomeGraphNodeIdentityIndexes, HomeGraphIdentityHeldError, type HomeGraphNodeSelector } from './store-homegraph-node-selector.js';
import { createSemanticNodeIdentityIndex, type SemanticNodeSelector, type SemanticIssueSelector } from './store-semantic-node-selector.js';
import { createSemanticFactIdentityIndex, SemanticIdentityHeldError, type SemanticFactSelector } from './store-semantic-fact-selector.js';
import { savedGeneratedProjectionIdentity, projectionIdentityParams, KnowledgeProjectionIdentityHeldError, type GeneratedProjectionIdentity } from './store-generated-projection-selector.js';
import { createKnowledgeRowRevisions } from './store-row-revisions.js';
import { withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { KnowledgeRecordAdmissionHeldError, knowledgeEdgeSnapshotFromRows, knowledgeRecordGenerationFromRows, knowledgeRecordSnapshotFromRows, type KnowledgeRecordSnapshot } from './store-record-snapshot.js';
import { sameKnowledgeRecord, captureKnowledgeStoreInput, copyKnowledgeRepresentation, prepareKnowledgeOwnedClocks } from './store-record-representation.js';
import { JudgmentInputError, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { validateCurrentKnowledgeSchema, validateKnowledgeSchemaV12, validateKnowledgeSchemaV13, validateKnowledgeSchemaV14, validateKnowledgeSchemaV15, validateKnowledgeSchemaV16 } from './store-current-schema-validation.js';
import { createKnowledgeNodeContentRevisions } from './store-node-content-revisions.js';
import { createKnowledgeNodeActivationCache } from './store-node-activation-cache.js';
import { createGeneratedProjectionIdentityIndex } from './store-generated-projection-selector.js';
import { createArtifactReferenceIndexes } from './store-artifact-references.js';
import { createNativeCiContinuationTable, validateNativeCiContinuationTable } from './store-native-ci-continuation.js';
import { pruneSettledNativeWork, validateNativeWorkRows } from './store-native-work-tables.js';
import { createNativeConversationStorage, validateNativeConversationCaptureTable, migrateNativeConversationCaptureTable } from './store-native-intake.js';
import type { NativeConversationStorage } from '../workflow/work-ledger/native-intake-types.js';
import { migrateNativeWorkSettlementTable, validateNativeWorkSettlementTable, createNativeWorkSettlementTargetIndex, createNativeWorkExecutionStorage, createNativeWorkExecutionTable, validateNativeWorkExecutionTable, createNativeWorkExecutionIntentTable, validateNativeWorkExecutionIntentTable } from './store-native-work-execution.js';
import type { NativeWorkExecutionStorage } from '../workflow/work-ledger/native-execution-types.js';
import { createKnowledgeWorkLedgerStorage, createWorkLedgerTable, validateWorkLedgerTable, migrateWorkLedgerTableToVersion2, type KnowledgeWorkLedgerStorage } from './store-work-ledger.js';
import type { ArtifactOriginalObservation } from '../artifacts/types.js';
import { cleanupKnowledgeArtifact, retireKnowledgeArtifactCleanup, type ArtifactCleanupResult } from './artifact-reference-ensemble.js';
import type { KnowledgeArtifactReferenceOwner } from './artifact-reference-owner.js';
import { KnowledgeSourcePublicationHeldError, knowledgeSourceSnapshotFromRows, planningSourceSnapshotFromRows, readPlanningSourceSnapshot, readKnowledgeSourceSnapshot, type KnowledgeSourceSnapshot, type KnowledgeSourceWriteResult } from './store-source-generation.js';
import type { PlanningSourceIdentity } from './store-planning-source-selector.js';
import { countWorkPlanTasksInSpace, listWorkPlanTaskRecordIds, readWorkPlanStatusCounts, readWorkPlanTaskImportRecord, workPlanTaskView, writeWorkPlanCommit, type WorkPlanTaskCommit, type WorkPlanTaskCommitResult, type WorkPlanTaskView } from './store-work-plan-tasks.js';
import { applyKnowledgeImport, assertKnowledgeImportRecordSizes, type KnowledgeImportInput, type KnowledgeImportReceipt, type PrepareKnowledgeImportGraph } from './store-import.js';
import { prepareKnowledgeEdgeRecord, writeKnowledgeEdgeRow, findKnowledgeEdge } from './store-edge-writes.js';
import { createKnowledgeTables } from './store-table-specs.js';
import { createKnowledgeEdgeChanges, validateKnowledgeEdgeChanges, trimKnowledgeEdgeChanges, type KnowledgeEdgeGenerationSnapshot } from './store-edge-generations.js';
import {
  ensureKnowledgeScopeVerdictTable,
  pruneOrphanScopeVerdicts,
  splitScopeVerdictKey,
  writeKnowledgeScopeVerdict,
  type KnowledgeScopeVerdict,
} from './store-scope-verdicts.js';
import { snapshotNodeInput } from './activation/projection.js';
import { KnowledgeNodeActivationHeldError, type KnowledgeNodeActivationOptions } from './activation/types.js';
import { prepareHomeGraphSnapshotGroupAcknowledgment, resolveKnowledgeNodeObservation, retainKnowledgeNodeObservation } from './store-node-observation.js';
import { knowledgeNodeRestorationGuard, prepareNodeActivationPass, assertPreparedNodeWrites, preparedNodeWrite, preparedNodeWrites, stagePreparedNodeWrites, type NodeMutationDraft, type KnowledgePreparedNodeWrites } from './store-node-activation.js';
export type { KnowledgePreparedNodeWrites } from './store-node-activation.js';
import { commitGuardedKnowledgeIssueReplacement, operatorReviewed } from './store-issue-replacement.js';
import { prepareKnowledgeIssueRecord, writeKnowledgeIssueRow, commitKnowledgeNodeIssueWrites, type KnowledgeGuardedNodeIssueWrites } from './store-node-issue-writes.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { SQLiteStore, SQLiteObservationRetiredError, captureSQLiteActivationPublication, type PersistedKnowledgeRecordSelector, type ExpectedKnowledgeRecordReadsetInput } from '../state/sqlite-store.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationCandidateUpsertInput,
  KnowledgeConsolidationReportRecord,
  KnowledgeConsolidationReportUpsertInput,
  KnowledgeEdgeRecord,
  KnowledgeEdgeUpsertInput,
  KnowledgeExtractionRecord,
  KnowledgeExtractionUpsertInput,
  KnowledgeIssueRecord,
  KnowledgeIssueUpsertInput,
  KnowledgeItemView,
  KnowledgeJobRunRecord,
  KnowledgeJobRunUpsertInput,
  KnowledgeRefinementTaskFilter,
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskUpsertInput,
  KnowledgeNodeRecord,
  KnowledgeNodeRevisionRecord,
  KnowledgeNodeUpsertInput,
  KnowledgeScheduleRecord,
  KnowledgeScheduleUpsertInput,
  KnowledgeSemanticEnrichmentStateRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceUpsertInput,
  KnowledgeStatus,
  KnowledgeUsageRecord,
  KnowledgeUsageUpsertInput,
} from './types.js';
import { knowledgeJobRunLifecycle } from './types.js';
import {
  createSchema,
  KNOWLEDGE_SCHEMA_VERSION,
  mapSemanticEnrichmentStateRow,
  mapNodeRow,
  mapNodeRevisionRow,
  mapIssueRow,
  mapRefinementTaskRow,
  nowMs,
  stableText,
  uniq,
} from './store-schema.js';
import {
  resolveKnowledgeDbPath,
  type KnowledgeStoreConfig,
  type KnowledgeStoreFamily,
} from './store-config.js';
import { prepareKnowledgeIssueUpsert, type KnowledgeIssueOperatorMutation } from './store-lifecycle-authority.js';
import { prepareKnowledgeSourceRecord, writeKnowledgeSourceRow, prepareKnowledgeExtractionRecord, writeKnowledgeExtractionRow } from './store-evidence-writes.js';
import {
  clampConfidence,
  listKnowledgeNodeRevisions,
  mergeKnowledgeNodes,
  recordKnowledgeNodeRevisions,
  resolveNodeActivation,
  upsertKnowledgeSemanticEnrichmentState,
  writeKnowledgeNodeRow,
} from './store-node-history.js';
import {
  mergeKnowledgeNodeMetadata, prepareKnowledgeNodeReplacement,
  retainKnowledgeNodeRecord, type KnowledgeNodeMutationContext,
} from './store-node-authority.js';
import {
  deleteKnowledgeNodeRecord,
  deleteKnowledgeSourceRecord,
  type KnowledgeRecordDeleteView,
} from './store-record-delete.js';
import { inferRecordReferenceSpaceId, preferRelatedNonDefaultSpace } from './store-record-space.js';
import { upsertKnowledgeRefinementTask } from './store-refinement.js';
import {
  deleteKnowledgeSpaceRows,
  planKnowledgeSpaceDeleteRows,
  type KnowledgeSpaceDeleteResult,
} from './store-space-delete.js';
import {
  deleteKnowledgeSchedule,
  upsertKnowledgeSchedule,
} from './store-schedules.js';
import {
  edgesForKnowledgeStore,
  getKnowledgeConsolidationCandidate,
  getKnowledgeConsolidationCandidateBySubject,
  getKnowledgeConsolidationReport,
  getKnowledgeExtraction,
  getKnowledgeExtractionBySourceId,
  getKnowledgeIssue,
  getKnowledgeItem,
  getKnowledgeJobRun,
  getKnowledgeRefinementTask,
  getKnowledgeNode,
  getKnowledgeNodeByKindAndSlug,
  getKnowledgeSchedule,
  getKnowledgeSource,
  getKnowledgeSourceByCanonicalUri,
  getKnowledgeStoreStatus,
  getKnowledgeUsageRecord,
  listKnowledgeConsolidationCandidates,
  listKnowledgeConsolidationReports,
  listKnowledgeEdges,
  listKnowledgeExtractions,
  listKnowledgeExtractionsForSources,
  listKnowledgeExtractionsInSpace,
  listKnowledgeIssues,
  listKnowledgeIssuesInSpace,
  listKnowledgeJobRuns,
  listKnowledgeRefinementTasks,
  listKnowledgeNodes,
  listKnowledgeNodesInSpace,
  listKnowledgeSchedules,
  listKnowledgeSources,
  listKnowledgeSourcesInSpace,
  pageKnowledgeSources,
  pageKnowledgeNodes,
  listKnowledgeUsageRecords,
  type KnowledgeStoreReadView,
} from './store-read.js';
import {
  ensureKnowledgeSpaceMetadata,
  getExplicitKnowledgeSpaceId,
  getKnowledgeSpaceId,
  knowledgeIssueFamily,
  projectKnowledgeSpaceId,
} from './spaces.js';

/**
 * Retained job-run history cap (stored rows). Runs are
 * append-per-execution; without a cap the history accretes one record per run
 * for the daemon's whole life and survives restarts (the incident's ~1,400
 * zero-result self-improvement objects were this class).
 */
export const MAX_RETAINED_JOB_RUNS = 500;

/**
 * Retained usage-record cap. Every `recordUsage` call adds a row and nothing but
 * deleting the target removed one. The readers that score from usage (packet
 * counts, consolidation stats) read at most the newest 10,000 rows inside a
 * 30-day window, so older rows beyond that can never change a result. Pruning
 * waits for a tenth of slack so the oldest-first sort is not paid on every write.
 */
const MAX_RETAINED_USAGE_RECORDS = 10_000;
const USAGE_RETENTION_SLACK = MAX_RETAINED_USAGE_RECORDS / 10;

/**
 * Retained consolidation-report cap. A daily light and a weekly deep run each
 * add one report; 100 keeps about three months of both and nothing else reads
 * older ones.
 */
export const MAX_RETAINED_CONSOLIDATION_REPORTS = 100;

function assertKnowledgeWriteCurrent(assertCurrent: (() => void) | undefined): void {
  assertSynchronousJudgmentGuard(assertCurrent, () => new KnowledgeNodeActivationHeldError('stale'));
}

/**
 * A store's SQL handle, path and node map for the module functions below that
 * act on one store. Only a constructed store has an entry, so a copied object
 * presenting the same path gets nothing.
 */
interface NativeArtifactReferenceStore {
  readonly sqlite: SQLiteStore;
  readonly path: string;
  readonly nodes: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly closed: () => boolean;
}
const nativeArtifactReferenceStores = new WeakMap<KnowledgeStore, NativeArtifactReferenceStore>();
const homeGraphSnapshotGroupWriters = new WeakMap<KnowledgeStore,
  (original: KnowledgeNodeRecord, groups: readonly string[], assertCurrent: () => void) => Promise<KnowledgeNodeRecord>>();

interface NativeNodePublication {
  readonly store: KnowledgeStore;
  readonly previous: WeakRef<KnowledgeNodeRecord> | undefined;
  readonly snapshot: KnowledgeRecordSnapshot;
  /** Original row writer's restriction, captured before its save await. */
  readonly current?: (() => 'pending' | 'published') | undefined;
}
const nativeNodePublicationOwners = new WeakSet<KnowledgeStore>();
const nativeNodePublications = new WeakMap<KnowledgeNodeRecord, NativeNodePublication>();
/** Only actual native commits populate this registry; no serialized receipt can do so. */
export function hasKnowledgeNodePublication(store: KnowledgeStore, record: KnowledgeNodeRecord,
  previous: KnowledgeNodeRecord | undefined): boolean {
  const publication: NativeNodePublication | undefined = nativeNodePublications.get(record);
  if (!publication || publication.store !== store) return false;
  return publication.previous === undefined ? previous === undefined
    : previous !== undefined && publication.previous.deref() === previous;
}

/** The actual native SQL publication image, including a pending batch write.
 * This is an expected row only; semantic admission still requires that exact
 * complete row to be present in the current persisted image. */
export function knowledgeNodePublicationGeneration(store: KnowledgeStore, record: KnowledgeNodeRecord,
  previous: KnowledgeNodeRecord | undefined): string | null {
  if (!hasKnowledgeNodePublication(store, record, previous)) return null;
  const publication: NativeNodePublication | undefined = nativeNodePublications.get(record);
  const snapshot = publication?.snapshot;
  return snapshot?.raw && snapshot.record && sameKnowledgeRecord(record, snapshot.record) ? snapshot.generation : null;
}

/** The stored issue already says what the input says (clocks and space stamps aside). */
function issueSays(existing: KnowledgeIssueRecord, input: KnowledgeIssueUpsertInput): boolean {
  if (existing.severity !== input.severity || existing.code !== input.code || existing.message !== input.message.trim()
    || existing.status !== (input.status ?? existing.status)
    || (existing.sourceId ?? undefined) !== (input.sourceId?.trim() || undefined)
    || (existing.nodeId ?? undefined) !== (input.nodeId?.trim() || undefined)) return false;
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (JSON.stringify(existing.metadata[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

export class KnowledgeStore {
  private readonly sqlite: SQLiteStore;
  readonly #revisionSource = revisionSource('knowledge store', () => this.sqlite.contentRevision());
  private readonly dbPath: string;
  private readonly nodeActivationScope = Object.freeze({});
  private readonly nodeActivationConfidenceFloor: number | undefined;
  private ready = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly nativeConversationStorage = new Map<string, NativeConversationStorage>();
  private readonly declareNativeConversationFormat: (() => void) | undefined;
  private readonly declareNativeSettledFormat: (() => void) | undefined;
  private readonly declareNativeExplicitSourceFormat: ((version?: 3 | 4) => void) | undefined;
  private readonly declareHistoricalImportFormat: ((version?: 2 | 3) => void) | undefined;
  private readonly declareNativeExecutionFormat: (() => void) | undefined;
  private readonly declareNativeCiFormat: (() => void) | undefined;
  private readonly declareNativeSettlementFormat: (() => void) | undefined;
  private readonly beforeIssueWrite: (record: KnowledgeIssueRecord) => void;
  private readonly beforeSemanticNodeWrite: (record: KnowledgeNodeRecord) => void;
  private readonly declareSemanticSourceFormat: (() => void) | undefined;
  private readonly ledgerStorage = new Map<string, KnowledgeWorkLedgerStorage>();
  private initPromise: Promise<void> | null = null;
  /** SQLite's count of other connections' commits at the last refreshIfChanged(). */
  private seenDataVersion = -1;
  // The SQLite file is the one owner of every row. Each table reads it and
  // keeps only a decode memo checked against the stored row, so a row another
  // process committed or a write that rolled back reads as stored
  // (store-row-table.ts). Writers write rows; `set` only binds the written
  // record to its row so later reads return that same object.
  readonly #tables = createKnowledgeTables(() => this.sqlite);
  private readonly sources = this.#tables.sources;
  private readonly nodes = this.#tables.nodes;
  private readonly edges = this.#tables.edges;
  private readonly issues = this.#tables.issues;
  private readonly extractions = this.#tables.extractions;
  private readonly jobRuns = this.#tables.jobRuns;
  private readonly refinementTasks = this.#tables.refinementTasks;
  private readonly usageRecords = this.#tables.usageRecords;
  private readonly consolidationCandidates = this.#tables.consolidationCandidates;
  private readonly consolidationReports = this.#tables.consolidationReports;
  private readonly schedules = this.#tables.schedules;
  private readonly nodeRevisions = this.#tables.nodeRevisions;
  private readonly semanticEnrichmentStates = this.#tables.semanticEnrichmentStates;
  /** Stored ordinary-view readings by `kind:id`; see getScopeVerdict. */
  private readonly scopeVerdicts = this.#tables.scopeVerdicts;

  /**
   * The construction every production site uses: the family is required here, so
   * a site that forgets to declare it fails to compile instead of opening a
   * store that nothing checks against the family's database file.
   */
  static forFamily(config: KnowledgeStoreConfig & { readonly family: KnowledgeStoreFamily }): KnowledgeStore {
    return new KnowledgeStore(config);
  }

  constructor(config: KnowledgeStoreConfig) {
    this.dbPath = resolveKnowledgeDbPath(config);
    if (config.nodeAutoAcceptConfidence !== undefined && (!Number.isFinite(config.nodeAutoAcceptConfidence) || config.nodeAutoAcceptConfidence < 0 || config.nodeAutoAcceptConfidence > 100)) {
      throw new RangeError('nodeAutoAcceptConfidence must be a finite 0-100 owner restriction.');
    }
    this.nodeActivationConfidenceFloor = config.nodeAutoAcceptConfidence;
    // Every writer, including ordinary saves and batches, shares this boundary.
    // Configuration supplied by a caller cannot turn coordination off.
    const nativeDataWriter = config.nativeDataWriter ?? config.configManager?.getNativeDataWriter?.();
    const declareNativeData = nativeDataWriter?.declare.bind(nativeDataWriter);
    const beforeInitialRead = config.beforeInitialRead?.bind(config);
    this.declareNativeConversationFormat = declareNativeData ? () => declareNativeData('native-conversation-captures-v2') : undefined;
    this.declareNativeSettledFormat = declareNativeData ? () => declareNativeData('native-conversation-settled-v1') : undefined;
    this.declareNativeExplicitSourceFormat = declareNativeData ? version => declareNativeData(version === 4 ? 'native-explicit-source-revisions-v4' : 'native-explicit-sources-v3') : undefined;
    this.declareHistoricalImportFormat = declareNativeData ? version => declareNativeData(version === 3 ? 'native-historical-import-revisions-v3' : 'native-historical-import-manifests-v2') : undefined;
    this.declareNativeExecutionFormat = declareNativeData ? () => declareNativeData('native-execution-bindings-v2') : undefined;
    this.declareNativeCiFormat = declareNativeData ? () => declareNativeData('native-ci-continuations-v2') : undefined;
    this.declareNativeSettlementFormat = declareNativeData ? () => declareNativeData('native-settlements-v2') : undefined;
    this.beforeIssueWrite = record => {
      if (record.metadata.homeGraphQualityIdentityVersion === 1) assertKnowledgeWriteCurrent(() => declareNativeData?.('homegraph-quality-identities-v1'));
      if (record.metadata.homeGraphQualityRevisionVersion === 1) assertKnowledgeWriteCurrent(() => declareNativeData?.('homegraph-quality-revisions-v1'));
    };
    this.beforeSemanticNodeWrite = record => {
      if (record.metadata.semanticIdentityVersion === 1) assertKnowledgeWriteCurrent(() => declareNativeData?.('knowledge-semantic-identities-v1'));
      if (record.metadata.homeGraphIdentityVersion === 1) assertKnowledgeWriteCurrent(() => declareNativeData?.('homegraph-object-identities-v1'));
    };
    this.declareSemanticSourceFormat = declareNativeData ? () => declareNativeData('knowledge-semantic-source-revisions-v2') : undefined;
    this.sqlite = new SQLiteStore(this.dbPath, { beforePersist: () => declareNativeData?.('knowledge-schema-v17'), ...(beforeInitialRead ? { beforeInitialRead } : {}) });
    nativeArtifactReferenceStores.set(this, Object.freeze({ sqlite: this.sqlite, path: this.dbPath, nodes: this.nodes, closed: () => this.closed }));
    homeGraphSnapshotGroupWriters.set(this,
      (original: KnowledgeNodeRecord, groups: readonly string[], assertCurrent: () => void) => this.#updateHomeGraphSnapshotGroups(original, groups, assertCurrent));
    nativeNodePublicationOwners.add(this);
    void this.init().catch((error: unknown) => {
      logger.error('[knowledge-store] initialization failed', {
        path: this.dbPath,
        error: summarizeError(error),
      });
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  get storagePath(): string {
    return this.dbPath;
  }

  private asReadView(): KnowledgeStoreReadView {
    return this as unknown as KnowledgeStoreReadView;
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('KnowledgeStore is closed');
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private readonly nativeExecutionStorage = new Map<string, NativeWorkExecutionStorage>();

  /** Trusted native host only. The runtime must not expose this storage capability. */
  async openNativeWorkExecutionStorage(projectId: string): Promise<NativeWorkExecutionStorage> {
    await this.init();
    if (this.closed) throw new Error('KnowledgeStore is closed');
    let storage = this.nativeExecutionStorage.get(projectId);
    if (!storage) {
      storage = createNativeWorkExecutionStorage(this.sqlite, projectId, () => {}, this.declareNativeExecutionFormat, this.declareNativeCiFormat, this.declareNativeSettlementFormat);
      this.nativeExecutionStorage.set(projectId, storage);
    }
    return storage;
  }

  /** Host-owned conversation capture shares the ledger's coordinated database. */
  async openNativeConversationStorage(projectId: string): Promise<NativeConversationStorage> {
    await this.init();
    if (this.closed) throw new Error('KnowledgeStore is closed');
    let storage = this.nativeConversationStorage.get(projectId);
    if (!storage) {
      storage = createNativeConversationStorage(this.sqlite, projectId, () => {}, this.declareNativeConversationFormat, this.declareNativeSettledFormat);
      this.nativeConversationStorage.set(projectId, storage);
    }
    return storage;
  }

  /** Trusted host seam: reuses this owner's coordinated database. */
  async openWorkLedgerStorage(projectId: string): Promise<KnowledgeWorkLedgerStorage> {
    await this.init();
    if (this.closed) throw new Error('KnowledgeStore is closed');
    let storage = this.ledgerStorage.get(projectId);
    if (!storage) {
      storage = createKnowledgeWorkLedgerStorage(this.sqlite, projectId, () => {}, undefined, this.declareNativeExplicitSourceFormat, this.declareHistoricalImportFormat);
      this.ledgerStorage.set(projectId, storage);
    }
    return storage;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const artifactCleanup = retireKnowledgeArtifactCleanup(this);
    const drains = [...this.ledgerStorage.values(), ...this.nativeExecutionStorage.values(), ...this.nativeConversationStorage.values()].map(storage => storage.close());
    this.closePromise = (async () => {
      await this.initPromise?.catch(() => {});
      await Promise.all(drains);
      await this.sqlite.settled();
      await artifactCleanup;
      // Work that passed init() before the close and touches SQL afterwards
      // is told what actually happened, not "not initialized".
      this.sqlite.close('KnowledgeStore is closed');
      this.ready = false;
    })();
    return this.closePromise;
  }

  /** Native snapshot bookkeeping only. No source/body/status is observed anew. */
  async #updateHomeGraphSnapshotGroups(original: KnowledgeNodeRecord, groups: readonly string[], assertMembershipCurrent: () => void): Promise<KnowledgeNodeRecord> {
    const assertOwner = () => {
      if (this.closed) throw new KnowledgeNodeActivationHeldError('stale');
    };
    assertOwner(); assertKnowledgeWriteCurrent(assertMembershipCurrent); assertOwner();
    await this.init();
    assertOwner();
    const captured = captureKnowledgeStoreInput(groups);
    if (!Array.isArray(captured) || captured.length < 1 || captured.length > 2
      || captured.some(group => group !== 'entities' && group !== 'helpers') || new Set(captured).size !== captured.length
      || original.kind !== 'ha_entity') throw new KnowledgeNodeActivationHeldError('malformed');
    const selectedGroups = Object.freeze([...captured].sort());
    let before: KnowledgeRecordSnapshot | undefined;
    this.assertRecordSnapshotFrame(() => {
      if (this.closed || this.nodes.get(original.id) !== original) throw new KnowledgeNodeActivationHeldError('stale');
      before = this.getRecordSnapshot('node', original.id);
      if (!before.raw || !before.generation || !sameKnowledgeRecord(original, before.record)) throw new KnowledgeNodeActivationHeldError('stale');
      return undefined;
    });
    if (!before?.raw || !before.generation || typeof before.raw.metadata !== 'string' || typeof before.raw.gv_revision !== 'string') throw new KnowledgeNodeActivationHeldError('stale');
    const snapshot = before, raw = before.raw;
    const home = original.metadata.homeAssistant;
    if (!home || typeof home !== 'object' || Array.isArray(home)) throw new KnowledgeNodeActivationHeldError('malformed');
    const oldGroups = (home as Record<string, unknown>).snapshotGroups;
    if (oldGroups !== undefined && (!Array.isArray(oldGroups) || oldGroups.some(group => group !== 'entities' && group !== 'helpers')
      || new Set(oldGroups).size !== oldGroups.length)) throw new KnowledgeNodeActivationHeldError('malformed');
    const assertOriginal = () => this.assertRecordSnapshotFrame(() => {
      assertKnowledgeWriteCurrent(assertMembershipCurrent); assertOwner();
      const actual = this.getRecordSnapshot('node', original.id);
      if (this.closed || this.nodes.get(original.id) !== original || actual.generation !== snapshot.generation
        || !sameKnowledgeRecord(original, actual.record)) throw new KnowledgeNodeActivationHeldError('stale');
      return undefined;
    });
    assertOriginal();
    if (Array.isArray(oldGroups) && oldGroups.length === selectedGroups.length && oldGroups.every((group, index) => group === selectedGroups[index])) return original;
    let candidate: KnowledgeNodeRecord | undefined, publication: KnowledgeRecordSnapshot | undefined;
    let acknowledgment: ReturnType<typeof prepareHomeGraphSnapshotGroupAcknowledgment> | undefined;
    const check = () => { assertOriginal(); acknowledgment?.assertCurrent(); };
    let publish: () => void = () => { throw new KnowledgeNodeActivationHeldError('stale'); };
    await this.sqlite.publishPrepared(db => {
      // JSON1 updates only this administrative field. A JS parse/stringify of
      // all metadata could round unrelated native JSON integers or decimals.
      db.run("UPDATE knowledge_nodes SET metadata = json_set(metadata, '$.homeAssistant.snapshotGroups', json(?)) WHERE id = ? AND gv_revision = ?",
        [JSON.stringify(selectedGroups), original.id, raw.gv_revision as string]);
      const rows = db.exec('SELECT * FROM knowledge_nodes WHERE id = ? LIMIT 1', [original.id]);
      publication = knowledgeRecordSnapshotFromRows('node', rows);
      const row = rows[0], values = row?.values[0];
      if (!row || !values || !publication.generation || publication.generation === snapshot.generation) throw new KnowledgeNodeActivationHeldError('stale');
      const mapped = mapNodeRow(row.columns, values);
      const retained = copyKnowledgeRepresentation(mapped, snapshotNodeInput(mapped));
      const preparedAcknowledgment = prepareHomeGraphSnapshotGroupAcknowledgment(original, retained);
      preparedAcknowledgment.assertCurrent();
      candidate = retained; acknowledgment = preparedAcknowledgment;
      publish = () => {
        this.nodes.set(retained.id, retained);
        preparedAcknowledgment.publish();
      };
    }, check, () => publish());
    assertKnowledgeWriteCurrent(assertMembershipCurrent); assertOwner();
    const committed = candidate;
    if (!committed) throw new KnowledgeNodeActivationHeldError('stale');
    this.assertRecordSnapshotFrame(() => {
      const current = this.getRecordSnapshot('node', committed.id);
      if (this.closed || this.nodes.get(committed.id) !== committed || current.generation !== publication?.generation
        || !sameKnowledgeRecord(committed, current.record)) throw new KnowledgeNodeActivationHeldError('stale');
      return undefined;
    });
    return committed;
  }

  /** Cleanup reads every configured native reference family under its original
   * owner; an incomplete ensemble preserves the artifact. */
  cleanupUnreferencedArtifact(observation: ArtifactOriginalObservation): Promise<ArtifactCleanupResult> {
    return cleanupKnowledgeArtifact(this, observation);
  }

  /**
   * Resolves true when another process committed to the knowledge file since
   * the previous call. Nothing is loaded: every read already asks the file, so
   * such a commit is seen by the next read anyway. One statement.
   */
  refreshIfChanged(): Promise<boolean> {
    if (!this.ready || this.closed) return Promise.resolve(false);
    const version = this.sqlite.dataVersion();
    const changed = this.seenDataVersion !== -1 && version !== this.seenDataVersion;
    this.seenDataVersion = version;
    return Promise.resolve(changed);
  }

  /**
   * Every change of the knowledge content as a revision source, whole store:
   * each row this process writes and each commit by another process.
   */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  status(): KnowledgeStatus {
    return getKnowledgeStoreStatus(this.asReadView());
  }

  /** Decoded records this process holds for reuse (the rows themselves live in the file), for MemoryGovernor cache visibility. */
  retainedEntryCount(): number {
    let total = 0;
    for (const table of Object.values(this.#tables)) total += table.retainedCount;
    return total;
  }

  async batch<T>(operation: () => Promise<T>): Promise<T> {
    await this.init();
    return this.sqlite.batch(operation);
  }

  /** Commits what the calling operation wrote (it is committed at the end of the turn in any case). */
  private async save(): Promise<void> {
    await this.sqlite.save();
  }

  listSources(limit = 100): KnowledgeSourceRecord[] {
    return listKnowledgeSources(this.asReadView(), limit);
  }

  listSourcesInSpace(spaceId: string): KnowledgeSourceRecord[] {
    return listKnowledgeSourcesInSpace(this.asReadView(), spaceId);
  }

  listNodes(limit = 100): KnowledgeNodeRecord[] {
    return listKnowledgeNodes(this.asReadView(), limit);
  }

  /** One bounded page of sources (insertion order, no full materialization). */
  listSourcesPage(offset: number, limit: number): KnowledgeSourceRecord[] {
    return pageKnowledgeSources(this.asReadView(), offset, limit);
  }

  /** One bounded page of nodes (insertion order, no full materialization). */
  listNodesPage(offset: number, limit: number): KnowledgeNodeRecord[] {
    return pageKnowledgeNodes(this.asReadView(), offset, limit);
  }

  /**
   * Single-pass cursor over the stored sources, in stored order, as read at
   * the first step; writes made while it runs do not disturb it. Offset
   * paging in a loop re-walks from zero per page (O(N²/page)).
   */
  iterateSources(): IterableIterator<KnowledgeSourceRecord> {
    return this.sources.values();
  }

  /** Single-pass cursor over nodes. See {@link iterateSources}. */
  iterateNodes(): IterableIterator<KnowledgeNodeRecord> {
    return this.nodes.values();
  }

  listNodesInSpace(spaceId: string): KnowledgeNodeRecord[] {
    return listKnowledgeNodesInSpace(this.asReadView(), spaceId);
  }

  listEdges(): KnowledgeEdgeRecord[] {
    return listKnowledgeEdges(this.asReadView());
  }

  listIssues(limit = 100): KnowledgeIssueRecord[] {
    return listKnowledgeIssues(this.asReadView(), limit);
  }

  listIssuesInSpace(spaceId: string): KnowledgeIssueRecord[] {
    return listKnowledgeIssuesInSpace(this.asReadView(), spaceId);
  }

  listExtractions(limit = 100): KnowledgeExtractionRecord[] {
    return listKnowledgeExtractions(this.asReadView(), limit);
  }

  listExtractionsInSpace(spaceId: string): KnowledgeExtractionRecord[] {
    return listKnowledgeExtractionsInSpace(this.asReadView(), spaceId);
  }

  listExtractionsForSources(sourceIds: ReadonlySet<string>): KnowledgeExtractionRecord[] {
    return listKnowledgeExtractionsForSources(this.asReadView(), sourceIds);
  }

  listJobRuns(limit = 100, jobId?: string): KnowledgeJobRunRecord[] {
    return listKnowledgeJobRuns(this.asReadView(), limit, jobId);
  }

  listRefinementTasks(limit = 100, input: KnowledgeRefinementTaskFilter = {}): KnowledgeRefinementTaskRecord[] {
    return listKnowledgeRefinementTasks(this.asReadView(), limit, input);
  }

  listUsageRecords(limit = 100, input: {
    readonly targetKind?: KnowledgeUsageRecord['targetKind'] | undefined;
    readonly targetId?: string | undefined;
    readonly usageKind?: KnowledgeUsageRecord['usageKind'] | undefined;
  } = {}): KnowledgeUsageRecord[] {
    return listKnowledgeUsageRecords(this.asReadView(), limit, input);
  }

  listConsolidationCandidates(limit = 100, input: {
    readonly status?: KnowledgeConsolidationCandidateRecord['status'] | undefined;
    readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'] | undefined;
    readonly subjectId?: string | undefined;
  } = {}): KnowledgeConsolidationCandidateRecord[] {
    return listKnowledgeConsolidationCandidates(this.asReadView(), limit, input);
  }

  listConsolidationReports(limit = 100): KnowledgeConsolidationReportRecord[] {
    return listKnowledgeConsolidationReports(this.asReadView(), limit);
  }

  listSchedules(limit = 100): KnowledgeScheduleRecord[] {
    return listKnowledgeSchedules(this.asReadView(), limit);
  }

  getSource(id: string): KnowledgeSourceRecord | null {
    return getKnowledgeSource(this.asReadView(), id);
  }

  getNode(id: string): KnowledgeNodeRecord | null {
    return getKnowledgeNode(this.asReadView(), id);
  }

  getIssue(id: string): KnowledgeIssueRecord | null {
    return getKnowledgeIssue(this.asReadView(), id);
  }

  getExtraction(id: string): KnowledgeExtractionRecord | null {
    return getKnowledgeExtraction(this.asReadView(), id);
  }

  getExtractionBySourceId(sourceId: string): KnowledgeExtractionRecord | null {
    return getKnowledgeExtractionBySourceId(this.asReadView(), sourceId);
  }

  getJobRun(id: string): KnowledgeJobRunRecord | null {
    return getKnowledgeJobRun(this.asReadView(), id);
  }

  getRefinementTask(id: string): KnowledgeRefinementTaskRecord | null {
    return getKnowledgeRefinementTask(this.asReadView(), id);
  }

  getUsageRecord(id: string): KnowledgeUsageRecord | null {
    return getKnowledgeUsageRecord(this.asReadView(), id);
  }

  getConsolidationCandidate(id: string): KnowledgeConsolidationCandidateRecord | null {
    return getKnowledgeConsolidationCandidate(this.asReadView(), id);
  }

  getConsolidationCandidateBySubject(
    subjectKind: KnowledgeConsolidationCandidateRecord['subjectKind'],
    subjectId: string,
    candidateType: KnowledgeConsolidationCandidateRecord['candidateType'],
  ): KnowledgeConsolidationCandidateRecord | null {
    return getKnowledgeConsolidationCandidateBySubject(this.asReadView(), subjectKind, subjectId, candidateType);
  }

  getConsolidationReport(id: string): KnowledgeConsolidationReportRecord | null {
    return getKnowledgeConsolidationReport(this.asReadView(), id);
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    return getKnowledgeSchedule(this.asReadView(), id);
  }

  getSourceByCanonicalUri(canonicalUri: string): KnowledgeSourceRecord | null {
    return getKnowledgeSourceByCanonicalUri(this.asReadView(), canonicalUri);
  }

  getNodeByKindAndSlug(kind: KnowledgeNodeRecord['kind'], slug: string): KnowledgeNodeRecord | null {
    return getKnowledgeNodeByKindAndSlug(this.asReadView(), kind, slug);
  }

  edgesFor(kind: KnowledgeEdgeRecord['fromKind'] | KnowledgeEdgeRecord['toKind'], id: string): KnowledgeEdgeRecord[] {
    return edgesForKnowledgeStore(this.asReadView(), kind, id);
  }

  getItem(id: string): KnowledgeItemView | null {
    return getKnowledgeItem(this.asReadView(), id);
  }

  /** Call init() before reading a detached snapshot of the actual stored row. */
  getSourceSnapshot(selector: { readonly id: string } | { readonly canonicalUri: string }): KnowledgeSourceSnapshot {
    return knowledgeSourceSnapshotFromRows('id' in selector
      ? this.sqlite.readPersistedRow('knowledge_sources', 'id', selector.id)
      : this.sqlite.readPersistedRow('knowledge_sources', 'canonical_uri', selector.canonicalUri));
  }

  /** Resolve current or historical planning IDs from the actual persisted tuple.
   * Use this instead of computing a historical projectPlanningSourceId. */
  getPlanningSourceSnapshot(identity: PlanningSourceIdentity): KnowledgeSourceSnapshot {
    return planningSourceSnapshotFromRows(this.sqlite.readPersistedPlanningSource(identity));
  }

  /** One consistent read of a work plan's rows (see store-work-plan-tasks.ts). */
  async readWorkPlan<T>(spaceId: string, workPlanId: string, read: (view: WorkPlanTaskView) => T): Promise<T> {
    await this.init();
    let value!: T;
    this.sqlite.assertPersistedReadFrame(() => {
      const legacy = readPlanningSourceSnapshot(this.sqlite, { spaceId, kind: 'work-plan', artifactId: workPlanId }).source;
      value = read(workPlanTaskView(this.sqlite, spaceId, workPlanId, legacy));
      return undefined;
    });
    return value;
  }

  /**
   * The same read without waiting: for a caller that cannot await (a modal
   * frame, a synchronous capture). Throws when the store has not opened yet.
   */
  readWorkPlanNow<T>(spaceId: string, workPlanId: string, read: (view: WorkPlanTaskView) => T): T {
    if (this.closed) throw new Error('KnowledgeStore is closed');
    if (!this.ready) throw new Error('The knowledge store is still opening; the work plan can be read in a moment.');
    let value!: T;
    this.sqlite.assertPersistedReadFrame(() => {
      const legacy = readPlanningSourceSnapshot(this.sqlite, { spaceId, kind: 'work-plan', artifactId: workPlanId }).source;
      value = read(workPlanTaskView(this.sqlite, spaceId, workPlanId, legacy));
      return undefined;
    });
    return value;
  }

  /**
   * Read and change a work plan in one immediate transaction: `decide` sees the
   * stored rows (no other writer can commit in between) and names the rows to
   * write. A plan still stored as one knowledge source is moved out of it by the
   * first commit that writes: `decide` puts its tasks as rows, and the source row
   * and what was derived from it are deleted in the same transaction.
   */
  async commitWorkPlan<T>(spaceId: string, workPlanId: string, decide: (view: WorkPlanTaskView) => WorkPlanTaskCommit<T>): Promise<WorkPlanTaskCommitResult<T>> {
    await this.init();
    const result = await this.sqlite.transactPersisted<WorkPlanTaskCommitResult<T>>((db) => {
      const legacy = readPlanningSourceSnapshot(db, { spaceId, kind: 'work-plan', artifactId: workPlanId }).source;
      const view = workPlanTaskView(db, spaceId, workPlanId, legacy);
      const decision = decide(view);
      if (decision.put.length === 0 && decision.remove.length === 0) return { changed: false, value: { value: decision.value, changed: false, head: view.head } };
      const revision = writeWorkPlanCommit(db, spaceId, workPlanId, decision.put, decision.remove, decision.at);
      if (legacy) deleteKnowledgeSourceRecord(this.asRecordDeleteView(), legacy.id);
      // The plan as this commit left it, by status: one aggregate in the same transaction.
      const statusCounts = readWorkPlanStatusCounts(db, spaceId, workPlanId);
      return { changed: true, value: { value: decision.value, changed: true, head: { revision, updatedAt: decision.at }, statusCounts } };
    }, () => {});
    if (result.kind !== 'completed') throw new KnowledgeSourcePublicationHeldError('pending-local-changes');
    return result.value;
  }

  /** Live work-plan task rows and the plans that hold them, in one space. */
  async countWorkPlanTasks(spaceId: string): Promise<{ readonly workPlans: number; readonly tasks: number }> {
    await this.init();
    return countWorkPlanTasksInSpace(this.sqlite, spaceId);
  }

  /** The legacy-import record ids of a project's work-plan tasks. */
  listWorkPlanTaskImportIds(projectId: string): readonly string[] {
    return listWorkPlanTaskRecordIds(this.sqlite, projectKnowledgeSpaceId(projectId));
  }

  /**
   * A record the work-ledger legacy import captures by id: a knowledge source,
   * or a work-plan task row under the kind `work-plan-task`.
   */
  getLegacyImportRecord(id: string): { readonly source: unknown; readonly generation: string | null } {
    const source = this.getSourceSnapshot({ id });
    if (source.source) return source;
    return readWorkPlanTaskImportRecord(this.sqlite, id);
  }

  /** Current native tuple/ID bookkeeping, including original pending rows.
   * This lookup cannot issue persisted support or record-admission evidence. */
  getSemanticFactIdentityCandidates(selector: SemanticFactSelector): readonly KnowledgeNodeRecord[] {
    const check = () => { if (this.closed) throw new SemanticIdentityHeldError('stale'); };
    check(); const result = this.sqlite.readSemanticFactIdentityCandidates(selector)[0];
    const candidates: KnowledgeNodeRecord[] = [];
    for (const values of result?.values ?? []) {
      if (!result) throw new SemanticIdentityHeldError('stale');
      const snapshot = knowledgeRecordSnapshotFromRows('node', [{ columns: result.columns, values: [values] }]);
      const record = snapshot.record ? this.nodes.get(snapshot.record.id) : undefined;
      if (!record || !snapshot.record || snapshot.generation === null || !sameKnowledgeRecord(record, snapshot.record)) throw new SemanticIdentityHeldError('stale');
      candidates.push(record);
    }
    check(); return Object.freeze(candidates);
  }

  /** Closed indexed lookup returns only original cached rows whose complete
   * persisted representation still matches this native store's read frame. */
  getSemanticFactCandidates(selector: SemanticFactSelector): readonly KnowledgeNodeRecord[] {
    const candidates: KnowledgeNodeRecord[] = [];
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedSemanticFactCandidates(selector)[0];
      for (const values of result?.values ?? []) {
        if (!result) throw new SemanticIdentityHeldError('stale');
        const snapshot = knowledgeRecordSnapshotFromRows('node', [{ columns: result.columns, values: [values] }]);
        const record = snapshot.record ? this.nodes.get(snapshot.record.id) : undefined;
        if (!record || !snapshot.record || snapshot.generation === null || !sameKnowledgeRecord(record, snapshot.record)) throw new SemanticIdentityHeldError('stale');
        candidates.push(record);
      }
      return undefined;
    });
    return Object.freeze(candidates);
  }

  /** Actual current owned tuples for mutation bookkeeping, including pending
   * native writes. It cannot issue persisted semantic evidence or permissions. */
  getHomeGraphNodeCandidates(selector: HomeGraphNodeSelector): readonly KnowledgeNodeRecord[] {
    const check = () => { if (this.closed) throw new HomeGraphIdentityHeldError('stale'); };
    check(); const result = this.sqlite.readHomeGraphNodeCandidates(selector)[0];
    const candidates: KnowledgeNodeRecord[] = [];
    for (const values of result?.values ?? []) {
      if (!result) throw new HomeGraphIdentityHeldError('stale');
      const snapshot = knowledgeRecordSnapshotFromRows('node', [{ columns: result.columns, values: [values] }]);
      const record = snapshot.record ? this.nodes.get(snapshot.record.id) : undefined;
      if (!record || !snapshot.record || !snapshot.generation || !sameKnowledgeRecord(record, snapshot.record)) throw new HomeGraphIdentityHeldError('stale');
      candidates.push(record);
    }
    check(); return Object.freeze(candidates);
  }

  /** Actual owned prefix source tuples, including pending native writes.
   * This cannot mint persisted semantic/execution evidence or permissions. */
  getHomeGraphSourceCandidates(selector: HomeGraphSourceSelector): readonly KnowledgeSourceRecord[] {
    const check = () => { if (this.closed) throw new HomeGraphIdentityHeldError('stale'); };
    check(); const result = this.sqlite.readHomeGraphSourceCandidates(selector)[0];
    const candidates: KnowledgeSourceRecord[] = [];
    for (const values of result?.values ?? []) {
      if (!result) throw new HomeGraphIdentityHeldError('stale');
      const snapshot = knowledgeSourceSnapshotFromRows([{ columns: result.columns, values: [values] }]);
      const record = snapshot.source ? this.sources.get(snapshot.source.id) : undefined;
      if (!record || !snapshot.source || !snapshot.generation || !sameKnowledgeRecord(record, snapshot.source)) throw new HomeGraphIdentityHeldError('stale');
      candidates.push(record);
    }
    check(); return Object.freeze(candidates);
  }

  getSemanticNodeCandidates(selector: SemanticNodeSelector): readonly KnowledgeNodeRecord[] {
    const candidates: KnowledgeNodeRecord[] = [];
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedSemanticNodeCandidates(selector)[0];
      for (const values of result?.values ?? []) {
        if (!result) throw new SemanticIdentityHeldError('stale');
        const snapshot = knowledgeRecordSnapshotFromRows('node', [{ columns: result.columns, values: [values] }]);
        const record = snapshot.record ? this.nodes.get(snapshot.record.id) : undefined;
        if (!record || !snapshot.record || snapshot.generation === null || !sameKnowledgeRecord(record, snapshot.record)) throw new SemanticIdentityHeldError('stale');
        candidates.push(record);
      }
      return undefined;
    });
    return Object.freeze(candidates);
  }

  getSemanticIssueCandidates(selector: SemanticIssueSelector): readonly KnowledgeIssueRecord[] {
    const candidates: KnowledgeIssueRecord[] = [];
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedSemanticIssueCandidates(selector)[0];
      for (const values of result?.values ?? []) {
        if (!result) throw new SemanticIdentityHeldError('stale');
        const saved = mapIssueRow(result.columns, values), original = this.issues.get(saved.id);
        if (!original || !sameKnowledgeRecord(original, saved)) throw new SemanticIdentityHeldError('stale');
        if (getKnowledgeSpaceId(original) === selector.spaceId && knowledgeIssueFamily(original) === selector.namespace) candidates.push(original);
      }
      return undefined;
    });
    return Object.freeze(candidates);
  }

  getSemanticRefinementTaskCandidates(spaceId: string, gapId: string): readonly KnowledgeRefinementTaskRecord[] {
    const candidates: KnowledgeRefinementTaskRecord[] = [];
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedSemanticRefinementTaskCandidates(spaceId, gapId)[0];
      for (const values of result?.values ?? []) {
        if (!result) throw new SemanticIdentityHeldError('stale');
        const saved = mapRefinementTaskRow(result.columns, values), original = this.refinementTasks.get(saved.id);
        if (!original || !sameKnowledgeRecord(original, saved)) throw new SemanticIdentityHeldError('stale');
        candidates.push(original);
      }
      return undefined;
    });
    return Object.freeze(candidates);
  }

  getGeneratedProjectionSourceSnapshot(identity: GeneratedProjectionIdentity): KnowledgeSourceSnapshot {
    const rows = this.sqlite.readPersistedGeneratedProjectionSource(identity);
    if ((rows[0]?.values.length ?? 0) > 1) throw new KnowledgeProjectionIdentityHeldError('ambiguous');
    const snapshot = knowledgeSourceSnapshotFromRows(rows);
    if (snapshot.source) {
      const saved = savedGeneratedProjectionIdentity(snapshot.source);
      const expected = projectionIdentityParams(identity);
      if (!saved || projectionIdentityParams(saved).some((value, index) => value !== expected[index])) {
        throw new KnowledgeProjectionIdentityHeldError('malformed');
      }
    }
    return snapshot;
  }

  /** Batch only synchronous guard reads, never evidence across an await/write. */
  assertRecordSnapshotFrame(assertion: () => undefined): void {
    try { this.sqlite.assertPersistedReadFrame(assertion); }
    catch (error) {
      if (error instanceof SQLiteObservationRetiredError) throw new KnowledgeRecordAdmissionHeldError('stale');
      throw error;
    }
  }

  /** Detached complete SQL row for semantic admission; numeric views confer no authority. */
  getRecordSnapshot(kind: 'node' | 'extraction', id: string): KnowledgeRecordSnapshot {
    return knowledgeRecordSnapshotFromRows(kind, this.sqlite.readPersistedRow(kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions', 'id', id));
  }

  getEdgeSnapshot(id: string): KnowledgeRecordSnapshot<KnowledgeEdgeRecord> {
    let result: KnowledgeRecordSnapshot<KnowledgeEdgeRecord> = { record: null, raw: null, generation: null };
    this.assertRecordSnapshotFrame(() => {
      result = knowledgeEdgeSnapshotFromRows(this.sqlite.readPersistedRow('knowledge_edges', 'id', id));
    });
    return result;
  }

  getEdgeSnapshots(): readonly KnowledgeRecordSnapshot<KnowledgeEdgeRecord>[] {
    let snapshots: readonly KnowledgeRecordSnapshot<KnowledgeEdgeRecord>[] = [];
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedEdgeRows()[0];
      snapshots = result ? result.values.map(values => {
        return knowledgeEdgeSnapshotFromRows([{ columns: result.columns, values: [values] }]);
      }) : [];
    });
    return snapshots;
  }

  /** All physical endpoints and complete raw generations, without semantic views. */
  getEdgeGenerationSnapshots(): readonly KnowledgeEdgeGenerationSnapshot[] {
    let snapshots: readonly KnowledgeEdgeGenerationSnapshot[] = [];
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedEdgeRows()[0];
      if (!result) return;
      const positions = ['id', 'from_kind', 'from_id', 'to_kind', 'to_id'].map(column => result.columns.indexOf(column));
      snapshots = result.values.map(values => {
        const [id, fromKind, fromId, toKind, toId] = positions.map(position => values[position]);
        if (typeof id !== 'string' || typeof fromKind !== 'string' || typeof fromId !== 'string'
          || typeof toKind !== 'string' || typeof toId !== 'string') throw new KnowledgeRecordAdmissionHeldError('malformed');
        const generation = knowledgeRecordGenerationFromRows([{ columns: result.columns, values: [values] }]);
        if (generation === null) throw new KnowledgeRecordAdmissionHeldError('malformed');
        return { id, fromKind, fromId, toKind, toId, generation };
      });
    });
    return snapshots;
  }

  getEdgeWindowGeneration(keys: readonly string[], incidentKeys?: readonly string[], includeUnselectedEndpoints = false): string {
    const generation = this.sqlite.readPersistedEdgeWindowGeneration(keys, incidentKeys, includeUnselectedEndpoints)[0]?.values[0]?.[0];
    if (typeof generation !== 'string' || !/^(0|[1-9][0-9]*)$/.test(generation)) throw new KnowledgeRecordAdmissionHeldError('malformed');
    return generation;
  }

  /** Opaque full-row entity fingerprint. Possessing it does not grant authority. */
  getSourceGeneration(id: string): string | null {
    return this.sqlite.readPersistedRowGeneration('knowledge_sources', 'id', id);
  }

  getRecordGeneration(kind: 'node' | 'extraction', id: string): string | null {
    return this.sqlite.readPersistedRowGeneration(kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions', 'id', id);
  }

  getRecordGenerations(selectors: readonly PersistedKnowledgeRecordSelector[]): readonly (string | null)[] {
    return this.sqlite.readPersistedRecordGenerations(selectors);
  }

  getEdgeGenerations(ids: readonly string[]): readonly (string | null)[] {
    return this.sqlite.readPersistedEdgeGenerations(ids);
  }

  getNodeActivationCache(nodeId: string) {
    return this.sqlite.readPersistedNodeActivationCache(nodeId);
  }

  /** Native activation reuse compares only actual persisted row versions.
   * The receipt reference is descriptive, never an admission capability. */
  getNodeActivationState(nodeId: string, selectors: readonly PersistedKnowledgeRecordSelector[], observation: string | null) {
    return this.sqlite.readPersistedNodeActivationState(nodeId, selectors, observation);
  }

  captureExpectedRecordReadset(selectors: readonly PersistedKnowledgeRecordSelector[]) {
    return this.sqlite.captureExpectedRecordReadset(selectors);
  }

  captureExpectedRecordReadsets(groups: readonly (readonly PersistedKnowledgeRecordSelector[])[]) {
    return this.sqlite.captureExpectedRecordReadsets(groups);
  }

  matchesExpectedRecordReadsets(inputs: readonly ExpectedKnowledgeRecordReadsetInput[]): readonly boolean[] {
    return this.sqlite.matchesExpectedRecordReadsets(inputs);
  }

  /** Compare and write synchronously after init; a hold has no durable effects. */
  async upsertSourceIfCurrent(input: KnowledgeSourceUpsertInput, expectedGeneration: string | null): Promise<KnowledgeSourceWriteResult> {
    if (expectedGeneration !== null && (typeof expectedGeneration !== 'string' || !expectedGeneration || expectedGeneration.length > 256)) {
      throw new TypeError('Invalid source generation precondition');
    }
    let capturedInput: KnowledgeSourceUpsertInput;
    try { capturedInput = structuredClone(input); } catch { throw new TypeError('Source mutation input must be structured data'); }
    await this.init();
    const selector = capturedInput.id ? { id: capturedInput.id }
      : capturedInput.canonicalUri ? { canonicalUri: capturedInput.canonicalUri } : null;
    const result = await this.sqlite.transactPersisted<KnowledgeSourceWriteResult>((db) => {
      const snapshot = selector ? readKnowledgeSourceSnapshot(db, selector) : { source: null, generation: null };
      if (snapshot.generation !== expectedGeneration) {
        return { changed: false, value: { kind: 'held', reason: 'source-changed', current: snapshot.source, generation: snapshot.generation } };
      }
      const record = prepareKnowledgeSourceRecord(capturedInput, snapshot.source);
      // No await between the persisted comparison, mutation, and publication.
      writeKnowledgeSourceRow(db, record);
      const written = readKnowledgeSourceSnapshot(db, { id: record.id });
      return { changed: true, value: { kind: 'written', source: written.source!, generation: written.generation! } };
    }, () => {});
    if (result.kind === 'completed') {
      if (result.value.kind === 'written') this.sources.set(result.value.source.id, result.value.source);
      return result.value;
    }
    const current = selector ? this.getSourceSnapshot(selector) : { source: null, generation: null };
    return { kind: 'held', reason: current.generation === expectedGeneration ? 'pending-local-changes' : 'source-changed', current: current.source, generation: current.generation };
  }

  /** Internal semantic-publication restriction; not an execution permission. */
  captureSourcePublication(): () => void { return this.sqlite.captureObservation(); }

  /**
   * Publish a bounded owner-selected source set in one existing coordinated
   * transaction. Every row and the reader remain current at the commit boundary.
   * The caller admits its input once, where it enters; rows already stored were
   * admitted when they were written, so a write is not a second admission of
   * either (a work-plan mark no longer re-scans the whole plan three times).
   */
  async upsertOwnedCanonicalSources(
    writes: readonly { readonly input: KnowledgeSourceUpsertInput; readonly generation: string | null }[],
    assertCurrent: () => void,
    published: (sources: readonly KnowledgeSourceSnapshot[], successor: () => void) => void,
  ): Promise<readonly KnowledgeSourceSnapshot[]> {
    const captured = writes;
    await this.init();
    assertCurrent();
    const result = await this.sqlite.transactPersisted<readonly KnowledgeSourceSnapshot[]>((db) => {
      assertCurrent();
      const selectedIds = new Set<string>(), selectedPlanningTuples = new Set<string>();
      const prepared = captured.map((write) => {
        const { input, generation } = write;
        if (!input.id) throw new TypeError('Owned source publication requires an exact identity');
        if (selectedIds.has(input.id)) throw new KnowledgeSourcePublicationHeldError('state-changed');
        selectedIds.add(input.id);
        if (input.connectorId !== 'goodvibes-project-planning') throw new TypeError('Canonical source clocks require a planning artifact');
        const metadata = input.metadata;
        const spaceId = metadata?.['knowledgeSpaceId'], kind = metadata?.['planningArtifactKind'], artifactId = metadata?.['planningArtifactId'];
        if (typeof spaceId === 'string' && typeof artifactId === 'string'
          && (kind === 'state' || kind === 'decision' || kind === 'language' || kind === 'work-plan')) {
          // All candidates are prepared before any row is written. Two writes
          // in this same batch must not both observe an absent tuple and then
          // publish separate identities for it.
          const tuple = JSON.stringify([spaceId, kind, artifactId]);
          if (selectedPlanningTuples.has(tuple)) throw new KnowledgeSourcePublicationHeldError('state-changed');
          selectedPlanningTuples.add(tuple);
          const selected = readPlanningSourceSnapshot(db, { spaceId, kind, artifactId });
          // A competing publisher may have created this tuple with a different
          // opaque ID since our absent-row observation. Never create a duplicate
          // or replace a historical ID selected from metadata. Older generic
          // callers without an artifact tuple keep their exact-ID CAS below.
          if ((selected.source && selected.source.id !== input.id) || selected.generation !== generation) {
            throw new KnowledgeSourcePublicationHeldError('state-changed');
          }
        }
        const current = readKnowledgeSourceSnapshot(db, { id: input.id });
        if (current.generation !== generation) throw new KnowledgeSourcePublicationHeldError('state-changed');
        // Generic metadata and caller lastCrawledAt are not rewritten; a legacy
        // clock is migrated only when it reads as a valid time.
        if (current.raw) for (const key of ['created_at', 'updated_at'] as const) {
          const value = current.raw[key];
          const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
          if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > 8.64e15
            || (typeof value === 'string' && new Date(timestamp).toISOString() !== value)) throw new JudgmentInputError('unsupported-input');
        }
        const record = prepareKnowledgeSourceRecord(input, current.source);
        const now = new Date(Date.now()).toISOString();
        const inherited = current.raw?.created_at;
        let createdAt = now;
        if (inherited !== undefined) {
          const timestamp = typeof inherited === 'number' ? inherited : typeof inherited === 'string' ? Date.parse(inherited) : NaN;
          if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > 8.64e15
            || (typeof inherited === 'string' && new Date(timestamp).toISOString() !== inherited)) throw new JudgmentInputError('unsupported-input');
          createdAt = new Date(timestamp).toISOString();
        }
        return { ...record, createdAt, updatedAt: now };
      });
      assertCurrent();
      for (const record of prepared) writeKnowledgeSourceRow(db, record);
      assertCurrent();
      return { changed: prepared.length > 0, value: prepared.map(record => readKnowledgeSourceSnapshot(db, { id: record.id })) };
    }, () => {}, (sources) => {
      for (const written of sources) if (written.source) this.sources.set(written.source.id, written.source);
      // Capture only our exact committed successor while still owning the lock.
      published(sources, this.captureSourcePublication());
    });
    if (result.kind !== 'completed') throw new KnowledgeSourcePublicationHeldError('pending-local-changes');
    assertCurrent();
    return result.value;
  }

  /** Canonical source-clock storage for planning artifacts, with numeric read
   * compatibility. This accepts no trust flag: all original input and existing
   * persisted values are admitted before any legacy clock representation change. */
  async upsertCanonicalSource(input: KnowledgeSourceUpsertInput): Promise<KnowledgeSourceRecord> {
    const captured = snapshotJudgmentInput(input) as KnowledgeSourceUpsertInput;
    await this.init();
    const observation = this.captureSourcePublication();
    const selector = captured.id ? { id: captured.id } : captured.canonicalUri ? { canonicalUri: captured.canonicalUri } : null;
    if (!selector) throw new TypeError('Canonical source publication requires an exact identity');
    const previous = this.getSourceSnapshot(selector);
    const id = previous.source?.id ?? captured.id;
    if (!id) throw new TypeError('Canonical source publication requires an exact identity');
    let current = observation;
    const written = await this.upsertOwnedCanonicalSources([{ input: { ...captured, id }, generation: previous.generation }],
      () => current(), (_sources, successor) => { current = successor; });
    return written[0]!.source!;
  }

  async upsertSource(input: KnowledgeSourceUpsertInput, assertCurrent?: () => void): Promise<KnowledgeSourceRecord> {
    assertKnowledgeWriteCurrent(assertCurrent);
    await this.init();
    assertKnowledgeWriteCurrent(assertCurrent);
    const existing = input.id
      ? this.sources.get(input.id)
      : input.canonicalUri
        ? this.getSourceByCanonicalUri(input.canonicalUri)
        : null;
    const record = prepareKnowledgeSourceRecord(input, existing);
    assertKnowledgeWriteCurrent(assertCurrent);
    writeKnowledgeSourceRow(this.sqlite, record);
    this.sources.set(record.id, record);
    await this.save();
    return record;
  }

  async deleteSource(id: string): Promise<boolean> {
    await this.init();
    const deleted = deleteKnowledgeSourceRecord(this.asRecordDeleteView(), id);
    if (deleted) await this.save();
    return deleted;
  }

  private asRecordDeleteView(): KnowledgeRecordDeleteView {
    return this as unknown as KnowledgeRecordDeleteView;
  }

  async replaceSourceRecord(record: KnowledgeSourceRecord): Promise<void> {
    // A restored value is a new observation; never revive an earlier row identity.
    record = copyKnowledgeRepresentation(record, snapshotNodeInput(record));
    await this.init();
    writeKnowledgeSourceRow(this.sqlite, record);
    this.sources.set(record.id, record);
    await this.save();
  }

  /** Read-only preflight; upsertNode independently rechecks at the final write. */
  async assertNodeMutation(input: KnowledgeNodeUpsertInput): Promise<void> {
    await this.init();
    this.prepareNodeMutation(input);
  }

  private prepareNodeMutation(input: KnowledgeNodeUpsertInput, mutation?: KnowledgeNodeMutationContext, observationInput = input): NodeMutationDraft {
    const existing = (input.id
      ? this.nodes.get(input.id)
      : this.getNodeByKindAndSlug(input.kind, input.slug)) ?? undefined;
    const sameSlug = this.getNodeByKindAndSlug(input.kind, input.slug);
    if (input.id && sameSlug && sameSlug.id !== input.id) throw new KnowledgeNodeActivationHeldError('stale');
    const now = nowMs();
    const _summary = stableText(input.summary);
    const _sourceId = stableText(input.sourceId);
    const mergedNodeMetadata = mergeKnowledgeNodeMetadata(existing?.metadata, input.metadata);
    const explicitNodeSpaceId = getExplicitKnowledgeSpaceId({ metadata: mergedNodeMetadata });
    const relatedNodeSpaceId = inferRecordReferenceSpaceId({
      sourceId: _sourceId ?? existing?.sourceId,
      metadata: mergedNodeMetadata,
      sources: this.sources,
      nodes: this.nodes,
    });
    const nodeSpaceId = preferRelatedNonDefaultSpace(explicitNodeSpaceId, relatedNodeSpaceId);
    const nodeMetadata = nodeSpaceId
      ? ensureKnowledgeSpaceMetadata(mergedNodeMetadata, nodeSpaceId)
      : mergedNodeMetadata;
    // Existing confidence normalization is independent of operator authority.
    const confidence = clampConfidence(input.confidence ?? existing?.confidence ?? 0);
    const candidate: KnowledgeNodeRecord = {
      id: existing?.id ?? input.id ?? `node-${crypto.randomUUID()}`,
      kind: input.kind,
      slug: input.slug,
      title: input.title.trim(),
      ...(_summary !== null ? { summary: _summary } : existing?.summary ? { summary: existing.summary } : {}),
      aliases: uniq(input.aliases ?? existing?.aliases),
      status: input.status ?? existing?.status ?? 'draft',
      confidence,
      ...(_sourceId !== null ? { sourceId: _sourceId } : existing?.sourceId ? { sourceId: existing.sourceId } : {}),
      metadata: nodeMetadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    prepareKnowledgeOwnedClocks(candidate, existing, now);
    // Authority is resolved before automatic activation or any persistence.
    const gated = resolveNodeActivation({ input, candidate, existing, mutation, now });
    const record = retainKnowledgeNodeRecord({ ...candidate, ...gated }, candidate);
    return { input, existing, record, now, authority: gated !== undefined, observation: resolveKnowledgeNodeObservation(observationInput, existing) };
  }

  /** Prepare a complete semantic write pass before any affected persistence. */
  async prepareNodeWrites(inputs: readonly KnowledgeNodeUpsertInput[], options: KnowledgeNodeActivationOptions = {}): Promise<KnowledgePreparedNodeWrites> {
    return withConfiguredDecisionModelPolicy(() => this.prepareNodeWritesOwned(inputs, options));
  }

  private async prepareNodeWritesOwned(inputs: readonly KnowledgeNodeUpsertInput[], options: KnowledgeNodeActivationOptions = {}): Promise<KnowledgePreparedNodeWrites> {
    const snapshots = inputs.map((input) => snapshotNodeInput(input));
    await this.init();
    const drafts = snapshots.map((input, index) => this.prepareNodeMutation(input, undefined, inputs[index]));
    return prepareNodeActivationPass(this, drafts, options, this.nodeActivationConfidenceFloor, this.nodeActivationScope);
  }

  /** Stage imported evidence and judgments before a guarded all-or-none SQL/cache commit. */
  async applyImport(input: KnowledgeImportInput, options: KnowledgeNodeActivationOptions = {}): Promise<void> {
    return withConfiguredDecisionModelPolicy(() => this.applyImportOwned(input, options));
  }

  private async applyImportOwned(input: KnowledgeImportInput, options: KnowledgeNodeActivationOptions = {}): Promise<void> {
    assertKnowledgeImportRecordSizes(input);
    input = captureKnowledgeStoreInput(input);
    await this.init();
    await applyKnowledgeImport(this, { sqlite: this.sqlite, sources: this.sources, extractions: this.extractions, nodes: this.nodes,
      nodeRevisions: this.nodeRevisions, edges: this.edges, issues: this.issues, beforeNodeWrite: this.beforeSemanticNodeWrite, beforeIssueWrite: this.beforeIssueWrite }, input,
    (node) => this.prepareNodeMutation(node), this.nodeActivationConfidenceFloor, this.nodeActivationScope, options);
  }

  /** Prepare a source-backed graph before committing evidence and nodes together. */
  async applyPreparedIngest(input: KnowledgeImportInput, prepareGraph: PrepareKnowledgeImportGraph, options: KnowledgeNodeActivationOptions = {}, onCommitted?: () => void): Promise<KnowledgeImportReceipt> {
    return withConfiguredDecisionModelPolicy(() => this.applyPreparedIngestOwned(input, prepareGraph, options, onCommitted));
  }

  private async applyPreparedIngestOwned(input: KnowledgeImportInput, prepareGraph: PrepareKnowledgeImportGraph,
    options: KnowledgeNodeActivationOptions = {}, onCommitted?: () => void): Promise<KnowledgeImportReceipt> {
    if (!nativeNodePublicationOwners.has(this)) throw new KnowledgeNodeActivationHeldError('stale');
    input = copyKnowledgeRepresentation(input, captureKnowledgeStoreInput(input));
    await this.init();
    return applyKnowledgeImport(this, { sqlite: this.sqlite, sources: this.sources, extractions: this.extractions, nodes: this.nodes,
      nodeRevisions: this.nodeRevisions, edges: this.edges, issues: this.issues, beforeNodeWrite: this.beforeSemanticNodeWrite, beforeIssueWrite: this.beforeIssueWrite,
      nodePublished: (record, previous, snapshot) => {
        nativeNodePublications.set(record, Object.freeze({ store: this, previous: previous ? new WeakRef(previous) : undefined, snapshot }));
      } }, input,
    (node, original) => this.prepareNodeMutation(node, undefined, original),
    this.nodeActivationConfidenceFloor, this.nodeActivationScope, options, prepareGraph, onCommitted);
  }

  assertPreparedNodeWrites(prepared: KnowledgePreparedNodeWrites): void { assertPreparedNodeWrites(this, prepared, this.nodeActivationScope); }

  async upsertPreparedNode(prepared: KnowledgePreparedNodeWrites, index: number): Promise<KnowledgeNodeRecord> {
    if (!nativeNodePublicationOwners.has(this)) throw new KnowledgeNodeActivationHeldError('stale');
    await this.init();
    const { existing, record, now, observationEvidence } = preparedNodeWrite(this, prepared, index, this.nodeActivationScope);
    if (record === existing) {
      let staged: ReturnType<typeof stagePreparedNodeWrites>, snapshot: KnowledgeRecordSnapshot;
      let current: ReturnType<typeof captureSQLiteActivationPublication>;
      this.sqlite.run('SAVEPOINT knowledge_unchanged_node_activation');
      try {
        snapshot = knowledgeRecordSnapshotFromRows('node', this.sqlite.exec('SELECT * FROM knowledge_nodes WHERE id = ? LIMIT 1', [record.id]));
        if (!snapshot.generation) throw new KnowledgeNodeActivationHeldError('stale');
        current = captureSQLiteActivationPublication(this.sqlite, record.id, snapshot.generation);
        staged = stagePreparedNodeWrites(prepared, [index], this.sqlite);
        this.sqlite.run('RELEASE SAVEPOINT knowledge_unchanged_node_activation');
      } catch (error) {
        this.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_unchanged_node_activation');
        this.sqlite.run('RELEASE SAVEPOINT knowledge_unchanged_node_activation');
        throw error;
      }
      retainKnowledgeNodeObservation(existing, record, observationEvidence);
      staged.commit();
      if (staged.cacheChanged) await this.save();
      nativeNodePublications.set(record, Object.freeze({ store: this, previous: existing ? new WeakRef(existing) : undefined, snapshot, current }));
      return record;
    }
    // Everything after the final guard and before save is synchronous.
    this.beforeSemanticNodeWrite(record);
    const revisions = new Map([[record.id, [...(this.nodeRevisions.get(record.id) ?? [])]]]);
    let snapshot: KnowledgeRecordSnapshot, staged: ReturnType<typeof stagePreparedNodeWrites>;
    let current: ReturnType<typeof captureSQLiteActivationPublication>;
    // A refused history append must not leave the candidate node in the live
    // SQL image for a later, unrelated save to persist.
    this.sqlite.run('SAVEPOINT knowledge_node_with_history');
    try {
      snapshot = knowledgeRecordSnapshotFromRows('node', writeKnowledgeNodeRow(this.sqlite, record));
      recordKnowledgeNodeRevisions(this.sqlite, revisions, record, existing, now);
      if (!snapshot.generation) throw new KnowledgeNodeActivationHeldError('stale');
      current = captureSQLiteActivationPublication(this.sqlite, record.id, snapshot.generation);
      staged = stagePreparedNodeWrites(prepared, [index], this.sqlite);
      this.sqlite.run('RELEASE SAVEPOINT knowledge_node_with_history');
    } catch (error) {
      this.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_node_with_history');
      this.sqlite.run('RELEASE SAVEPOINT knowledge_node_with_history');
      throw error;
    }
    this.nodeRevisions.set(record.id, revisions.get(record.id)!);
    retainKnowledgeNodeObservation(existing, record, observationEvidence);
    this.nodes.set(record.id, record);
    staged.commit();
    await this.save();
    nativeNodePublications.set(record, Object.freeze({ store: this, previous: existing ? new WeakRef(existing) : undefined, snapshot, current }));
    return record;
  }

  async upsertNode(input: KnowledgeNodeUpsertInput, mutation?: KnowledgeNodeMutationContext): Promise<KnowledgeNodeRecord> {
    return withConfiguredDecisionModelPolicy(() => this.upsertNodeOwned(input, mutation));
  }

  private async upsertNodeOwned(input: KnowledgeNodeUpsertInput, mutation?: KnowledgeNodeMutationContext): Promise<KnowledgeNodeRecord> {
    const snapshot = snapshotNodeInput(input);
    await this.init();
    const prepared = await prepareNodeActivationPass(this, [this.prepareNodeMutation(snapshot, mutation, input)], {}, this.nodeActivationConfidenceFloor, this.nodeActivationScope);
    return this.upsertPreparedNode(prepared, 0);
  }

  /** Read append-only node revisions, oldest first. */
  listNodeRevisions(nodeId: string): KnowledgeNodeRevisionRecord[] {
    return listKnowledgeNodeRevisions(this.nodeRevisions, nodeId);
  }

  /** Closed native history selectors share the original SQL snapshot frame. */
  getNodeHistorySnapshot(nodeId: string, revisionId: string | null = null): {
    readonly firstId: string | null;
    readonly latestId: string | null;
    readonly selected: KnowledgeNodeRevisionRecord | null;
  } {
    let result: { firstId: string | null; latestId: string | null; selected: KnowledgeNodeRevisionRecord | null } | undefined;
    this.assertRecordSnapshotFrame(() => {
      const rows = this.sqlite.readPersistedNodeHistorySelection(nodeId, revisionId);
      const label = (results: typeof rows.first): string | null => {
        const value: unknown = results[0]?.values[0]?.[0];
        if (value === undefined) return null;
        if (typeof value !== 'string' || value.length === 0) throw new KnowledgeRecordAdmissionHeldError('malformed');
        return value;
      };
      const map = (results: typeof rows.first): KnowledgeNodeRevisionRecord | null => {
        const row = results[0], values = row?.values[0];
        if (row && values) for (const key of ['metadata', 'aliases']) {
          const raw: unknown = values[row.columns.indexOf(key)];
          if (typeof raw !== 'string') throw new KnowledgeRecordAdmissionHeldError('malformed');
          let value: unknown;
          try { value = JSON.parse(raw); } catch { throw new KnowledgeRecordAdmissionHeldError('malformed'); }
          if (key === 'metadata' ? !value || typeof value !== 'object' || Array.isArray(value)
            : !Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new KnowledgeRecordAdmissionHeldError('malformed');
        }
        return row && values ? mapNodeRevisionRow(row.columns, values) : null;
      };
      result = { firstId: label(rows.first), latestId: label(rows.latest), selected: map(rows.selected) };
      return undefined;
    });
    if (!result) throw new KnowledgeRecordAdmissionHeldError('stale');
    return result;
  }

  async deleteNode(id: string): Promise<boolean> {
    await this.init();
    const deleted = deleteKnowledgeNodeRecord(this.asRecordDeleteView(), id);
    if (deleted) await this.save();
    return deleted;
  }

  async replaceNodeRecord(record: KnowledgeNodeRecord, mutation?: KnowledgeNodeMutationContext): Promise<void> {
    return withConfiguredDecisionModelPolicy(() => this.replaceNodeRecordOwned(record, mutation));
  }

  private async replaceNodeRecordOwned(record: KnowledgeNodeRecord, mutation?: KnowledgeNodeMutationContext): Promise<void> {
    const restoration = mutation === undefined ? knowledgeNodeRestorationGuard(this, record, this.nodeActivationScope) : undefined;
    record = snapshotNodeInput(record);
    await this.init();
    const existing = this.nodes.get(record.id);
    const sameSlug = this.getNodeByKindAndSlug(record.kind, record.slug);
    if (sameSlug && sameSlug.id !== record.id) throw new KnowledgeNodeActivationHeldError('stale');
    const now = nowMs();
    const replacement = prepareKnowledgeNodeReplacement(record, existing, mutation, now, restoration !== undefined);
    const authority = mutation !== undefined || replacement === existing;
    const prepared = await prepareNodeActivationPass(this, [{ input: record, existing, record: replacement, now, authority, restoration }], {}, this.nodeActivationConfidenceFloor, this.nodeActivationScope);
    const guarded = preparedNodeWrite(this, prepared, 0, this.nodeActivationScope).record;
    this.beforeSemanticNodeWrite(guarded);
    const revisions = new Map([[guarded.id, [...(this.nodeRevisions.get(guarded.id) ?? [])]]]);
    let staged: ReturnType<typeof stagePreparedNodeWrites>;
    this.sqlite.run('SAVEPOINT knowledge_node_replacement_with_history');
    try {
      writeKnowledgeNodeRow(this.sqlite, guarded);
      if (mutation) recordKnowledgeNodeRevisions(this.sqlite, revisions, guarded, existing, now);
      staged = stagePreparedNodeWrites(prepared, [0], this.sqlite);
      this.sqlite.run('RELEASE SAVEPOINT knowledge_node_replacement_with_history');
    } catch (error) {
      this.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_node_replacement_with_history');
      this.sqlite.run('RELEASE SAVEPOINT knowledge_node_replacement_with_history');
      throw error;
    }
    if (mutation) this.nodeRevisions.set(guarded.id, revisions.get(guarded.id)!);
    retainKnowledgeNodeObservation(existing, guarded);
    this.nodes.set(guarded.id, guarded);
    staged.commit();
    await this.save();
  }

  /** Merge one node into another, re-pointing cross-reference edges. (Invariant 7.) */
  async mergeNodes(loserId: string, winnerId: string): Promise<{ merged: boolean; repointedEdges: number }> {
    await this.init();
    return mergeKnowledgeNodes(this, loserId, winnerId, {
      sqlite: this.sqlite, nodes: this.nodes, edges: this.edges,
      nodeRevisions: this.nodeRevisions, nodeActivationScope: this.nodeActivationScope, beforeNodeWrite: this.beforeSemanticNodeWrite,
    });
  }

  getSemanticEnrichmentState(sourceId: string): KnowledgeSemanticEnrichmentStateRecord | null {
    return this.semanticEnrichmentStates.get(sourceId) ?? null;
  }

  /** Saved enrichment metadata can skip work only when its complete native
   * SQL row still matches the original cached record. */
  getSemanticEnrichmentStateSnapshot(sourceId: string): KnowledgeSemanticEnrichmentStateRecord | null {
    let current: KnowledgeSemanticEnrichmentStateRecord | null = null;
    this.assertRecordSnapshotFrame(() => {
      const result = this.sqlite.readPersistedSemanticEnrichmentState(sourceId)[0];
      const values = result?.values[0];
      const cached = this.semanticEnrichmentStates.get(sourceId) ?? null;
      const saved = result && values ? mapSemanticEnrichmentStateRow(result.columns, values) : null;
      if (!sameKnowledgeRecord(cached, saved)) throw new SemanticIdentityHeldError('stale');
      current = cached;
      return undefined;
    });
    return current;
  }

  async upsertSemanticEnrichmentState(input: {
    readonly sourceId: string;
    readonly textHash?: string | undefined;
    readonly enrichedAt?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<KnowledgeSemanticEnrichmentStateRecord> {
    await this.init();
    if (input.metadata?.semanticSourceVersion === 2) assertKnowledgeWriteCurrent(this.declareSemanticSourceFormat);
    const record = upsertKnowledgeSemanticEnrichmentState(this.sqlite, this.semanticEnrichmentStates, input);
    await this.save();
    return record;
  }

  /**
   * The stored ordinary-view reading for a record (`source:<id>`, `node:<id>`,
   * `issue:<id>`), or undefined when none was stored. It is current only while
   * its `version` equals the record's content version; see scope-verdicts.ts.
   */
  getScopeVerdict(key: string): KnowledgeScopeVerdict | undefined {
    return this.scopeVerdicts.get(key);
  }

  /** Stores ordinary-view readings in one save; a reading of a record that is gone is dropped. */
  async recordScopeVerdicts(verdicts: readonly KnowledgeScopeVerdict[]): Promise<void> {
    await this.init();
    const live = verdicts.filter((verdict) => {
      const [kind, id] = splitScopeVerdictKey(verdict.key);
      return kind === 'source' ? this.sources.has(id) : kind === 'node' ? this.nodes.has(id) : kind === 'issue' ? this.issues.has(id) : false;
    });
    if (live.length === 0) return;
    for (const verdict of live) writeKnowledgeScopeVerdict(this.sqlite, verdict);
    for (const verdict of live) this.scopeVerdicts.set(verdict.key, verdict);
    await this.save();
  }

  async upsertEdge(input: KnowledgeEdgeUpsertInput, assertCurrent?: () => void): Promise<KnowledgeEdgeRecord> {
    assertKnowledgeWriteCurrent(assertCurrent);
    await this.init();
    assertKnowledgeWriteCurrent(assertCurrent);
    const existing = findKnowledgeEdge(this.edges, input);
    const record = prepareKnowledgeEdgeRecord(input, existing);
    // An edge that already says this writes nothing: no row, no change-journal entry, no save.
    if (existing && existing.weight === record.weight && JSON.stringify(existing.metadata) === JSON.stringify(record.metadata)) return existing;
    assertKnowledgeWriteCurrent(assertCurrent);
    writeKnowledgeEdgeRow(this.sqlite, record);
    this.edges.set(record.id, record);
    await this.save();
    return record;
  }

  async deleteEdge(id: string): Promise<boolean> {
    await this.init();
    if (!this.edges.has(id)) return false;
    this.sqlite.run('DELETE FROM knowledge_edges WHERE id = ?', [id]);
    this.edges.delete(id);
    await this.save();
    return true;
  }

  async replaceEdgeRecord(record: KnowledgeEdgeRecord): Promise<void> {
    await this.init();
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_edges (
        id, from_kind, from_id, to_kind, to_id, relation, weight, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.fromKind,
      record.fromId,
      record.toKind,
      record.toId,
      record.relation,
      record.weight,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    // The unique endpoint-tuple index makes SQL replace any other row for these endpoints.
    this.edges.set(record.id, record);
    await this.save();
  }

  /**
   * Replaces one producer family's issues with `inputs`. An issue whose content is
   * what the input says is not rewritten, and the family's other issues are removed
   * (only those about `scope.sourceIds` when given, so a pass over one source leaves
   * the rest alone). Resolved and operator-reviewed issues stay. All of it is one
   * save, and none when nothing changed.
   */
  async replaceIssues(
    inputs: readonly KnowledgeIssueUpsertInput[],
    family?: string,
    scope?: { readonly sourceIds: ReadonlySet<string> },
  ): Promise<KnowledgeIssueRecord[]> {
    return this.batch(async () => {
      const current: KnowledgeIssueRecord[] = [];
      const activeIds = new Set<string>();
      for (const input of inputs) {
        const existing = input.id ? this.issues.get(input.id) : undefined;
        if (existing && issueSays(existing, input)) {
          activeIds.add(existing.id);
          current.push(existing);
          continue;
        }
        const record = await this.upsertIssue(input);
        activeIds.add(record.id);
        current.push(record);
      }
      if (family) {
        let removed = false;
        for (const issue of [...this.issues.values()]) {
          if (knowledgeIssueFamily(issue) !== family) continue;
          if (scope && !(issue.sourceId !== undefined && scope.sourceIds.has(issue.sourceId))) continue;
          if (activeIds.has(issue.id) || issue.status === 'resolved' || operatorReviewed(issue)) continue;
          this.sqlite.run('DELETE FROM knowledge_issues WHERE id = ?', [issue.id]);
          this.issues.delete(issue.id);
          removed = true;
        }
        if (removed) await this.save();
      }
      return current;
    });
  }

  /** Whole-pass ordinary replacement; preserves terminal and operator-reviewed issues. */
  async replaceIssuesGuarded(inputs: readonly KnowledgeIssueUpsertInput[], namespace: string, beforeWrite: () => void, legacyHomeGraphIssues: readonly KnowledgeIssueRecord[] = []): Promise<KnowledgeIssueRecord[]> {
    await this.init();
    const records = commitGuardedKnowledgeIssueReplacement({ sqlite: this.sqlite, issues: this.issues, sources: this.sources, nodes: this.nodes, beforeIssueWrite: this.beforeIssueWrite }, inputs, namespace, beforeWrite, legacyHomeGraphIssues);
    await this.save();
    return records;
  }

  async upsertIssue(input: KnowledgeIssueUpsertInput, mutation?: KnowledgeIssueOperatorMutation): Promise<KnowledgeIssueRecord> {
    await this.init();
    const { record, preserve } = prepareKnowledgeIssueRecord({ issues: this.issues, sources: this.sources, nodes: this.nodes }, input, mutation);
    if (preserve) return record;
    this.beforeIssueWrite(record);
    writeKnowledgeIssueRow(this.sqlite, record);
    this.issues.set(record.id, record);
    await this.save();
    return record;
  }

  /** Bounded ordinary writes with a synchronous guard at the all-or-none commit point. */
  async applyGuardedNodeIssueWrites(input: KnowledgeGuardedNodeIssueWrites, beforeWrite: () => void): Promise<void> {
    input = snapshotNodeInput(input);
    await this.init();
    if (input.nodes.length > 100 || input.issues.length > 100
      || new Set(input.nodes.map((node) => node.id)).size !== input.nodes.length
      || new Set(input.issues.map((issue) => issue.id)).size !== input.issues.length
      || input.nodes.some((node) => !node.id || !this.nodes.has(node.id))
      || input.issues.some((issue) => !issue.id || !this.issues.has(issue.id))) {
      throw new Error('Guarded knowledge writes require at most 100 distinct existing nodes and issues.');
    }
    const prepared = await this.prepareNodeWrites(input.nodes);
    const nodes = preparedNodeWrites(this, prepared, this.nodeActivationScope);
    const nodeView = new Map(this.nodes);
    for (const { record } of nodes) nodeView.set(record.id, record);
    const issues = input.issues.map((issue) => prepareKnowledgeIssueRecord({ issues: this.issues, sources: this.sources, nodes: nodeView }, issue));
    for (const issue of issues) if (!issue.preserve) this.beforeIssueWrite(issue.record);
    beforeWrite();
    assertPreparedNodeWrites(this, prepared, this.nodeActivationScope);
    let staged: ReturnType<typeof stagePreparedNodeWrites> | undefined;
    commitKnowledgeNodeIssueWrites({ sqlite: this.sqlite, nodes: this.nodes, issues: this.issues, nodeRevisions: this.nodeRevisions, beforeNodeWrite: this.beforeSemanticNodeWrite,
      beforePublication: () => { staged = stagePreparedNodeWrites(prepared, nodes.map((_, index) => index), this.sqlite); } },
      nodes, issues.filter((issue) => !issue.preserve).map((issue) => issue.record));
    nodes.forEach(({ existing, record, observationEvidence }) => { retainKnowledgeNodeObservation(existing, record, observationEvidence); });
    staged!.commit();
    await this.save();
  }

  async replaceIssueRecord(record: KnowledgeIssueRecord): Promise<void> {
    await this.init();
    const lifecycle = prepareKnowledgeIssueUpsert(this.issues.get(record.id), record, undefined, true);
    if (lifecycle.preserve) return;
    record = { ...record, status: lifecycle.status, metadata: lifecycle.metadata };
    this.beforeIssueWrite(record);
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_issues (
        id, severity, code, message, status, source_id, node_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.severity,
      record.code,
      record.message,
      record.status,
      record.sourceId ?? null,
      record.nodeId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.issues.set(record.id, record);
    await this.save();
  }

  async upsertExtraction(input: KnowledgeExtractionUpsertInput, assertCurrent?: () => void): Promise<KnowledgeExtractionRecord> {
    assertKnowledgeWriteCurrent(assertCurrent);
    await this.init();
    assertKnowledgeWriteCurrent(assertCurrent);
    const existing = input.id
      ? this.extractions.get(input.id)
      : this.getExtractionBySourceId(input.sourceId);
    const record = prepareKnowledgeExtractionRecord(input, existing, this.sources.get(input.sourceId));
    assertKnowledgeWriteCurrent(assertCurrent);
    writeKnowledgeExtractionRow(this.sqlite, record);
    // The unique source_id index makes SQL replace any other row for this source.
    this.extractions.set(record.id, record);
    await this.save();
    return record;
  }

  async upsertJobRun(input: KnowledgeJobRunUpsertInput): Promise<KnowledgeJobRunRecord> {
    await this.init();
    const existing = input.id ? this.jobRuns.get(input.id) : null;
    if (existing && input.status !== existing.status) {
      // A late or duplicate writer must not move a settled run back to queued/running.
      const move = knowledgeJobRunLifecycle.check(existing.status, input.status);
      if (!move.ok) {
        logger.warn('[knowledge-store] job run left as is', { runId: existing.id, reason: move.reason });
        return existing;
      }
    }
    const now = nowMs();
    const _error = stableText(input.error);
    const record: KnowledgeJobRunRecord = {
      id: existing?.id ?? input.id ?? `kjr-${crypto.randomUUID()}`,
      jobId: input.jobId,
      status: input.status,
      mode: input.mode,
      requestedAt: input.requestedAt ?? existing?.requestedAt ?? now,
      ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      ...(typeof input.completedAt === 'number' ? { completedAt: input.completedAt } : existing?.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(_error !== null ? { error: _error } : existing?.error ? { error: existing.error } : {}),
      result: {
        ...(existing?.result ?? {}),
        ...(input.result ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_job_runs (
        id, job_id, status, mode, requested_at, started_at, completed_at, error, result, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.jobId,
      record.status,
      record.mode,
      record.requestedAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.error ?? null,
      JSON.stringify(record.result),
      JSON.stringify(record.metadata),
      record.createdAt,
      now,
    ]);
    this.jobRuns.set(record.id, record);
    // Retention on write: keep the stored run history bounded.
    this.pruneJobRuns(MAX_RETAINED_JOB_RUNS);
    await this.save();
    return record;
  }

  /**
   * Bound the retained job-run history to `keep` records. Active (queued /
   * running) runs are never pruned; settled runs beyond the cap are deleted
   * oldest-first, so the history cannot accrete without bound across uptime
   * or restarts. Also the MemoryGovernor's trim hook for this store (a real
   * reclaim: the rows and their decoded records go). Two counting statements
   * when nothing is over the cap.
   */
  pruneJobRuns(keep: number): number {
    const cap = Math.max(0, Math.trunc(keep));
    if (!this.sqlite.isReady || !(this.jobRuns.size > cap)) return 0;
    const counts = this.sqlite.exec("SELECT COUNT(*), COALESCE(SUM(status IN ('queued', 'running')), 0) FROM knowledge_job_runs")[0]?.values[0];
    const drop = Number(counts?.[0] ?? 0) - Math.max(cap, Number(counts?.[1] ?? 0));
    if (!(drop > 0)) return 0;
    const ids = this.sqlite.exec("SELECT id FROM knowledge_job_runs WHERE status NOT IN ('queued', 'running') ORDER BY updated_at ASC LIMIT ?", [drop])[0]?.values ?? [];
    for (const [id] of ids) {
      this.sqlite.run('DELETE FROM knowledge_job_runs WHERE id = ?', [String(id)]);
      this.jobRuns.delete(String(id));
    }
    return ids.length;
  }

  /** Drops one settled run; an active run is kept. Returns whether a row was removed. */
  async deleteJobRun(id: string): Promise<boolean> {
    await this.init();
    const run = this.jobRuns.get(id);
    if (!run || run.status === 'queued' || run.status === 'running') return false;
    this.jobRuns.delete(id);
    this.sqlite.run('DELETE FROM knowledge_job_runs WHERE id = ?', [id]);
    await this.save();
    return true;
  }

  async upsertRefinementTask(input: KnowledgeRefinementTaskUpsertInput): Promise<KnowledgeRefinementTaskRecord> {
    await this.init();
    return upsertKnowledgeRefinementTask(this.sqlite, this.refinementTasks, input, () => `kref-${crypto.randomUUID()}`);
  }

  async upsertUsageRecord(input: KnowledgeUsageUpsertInput, assertCurrent?: () => void): Promise<KnowledgeUsageRecord> {
    await this.init();
    assertCurrent?.();
    const _task = stableText(input.task);
    const _sessionId = stableText(input.sessionId);
    const record: KnowledgeUsageRecord = {
      id: input.id ?? `kuse-${crypto.randomUUID()}`,
      targetKind: input.targetKind,
      targetId: input.targetId,
      usageKind: input.usageKind,
      ...(_task !== null ? { task: _task } : {}),
      ...(_sessionId !== null ? { sessionId: _sessionId } : {}),
      ...(typeof input.score === 'number' && Number.isFinite(input.score) ? { score: Number(input.score) } : {}),
      metadata: { ...(input.metadata ?? {}) },
      createdAt: nowMs(),
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_usage_records (
        id, target_kind, target_id, usage_kind, task, session_id, score, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.targetKind,
      record.targetId,
      record.usageKind,
      record.task ?? null,
      record.sessionId ?? null,
      record.score ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
    ]);
    this.usageRecords.set(record.id, record);
    if (this.usageRecords.size > MAX_RETAINED_USAGE_RECORDS + USAGE_RETENTION_SLACK) this.pruneUsageRecords(MAX_RETAINED_USAGE_RECORDS);
    await this.save();
    return record;
  }

  /** Delete the oldest usage records beyond `keep`: one ordered read over the created_at index and one DELETE. */
  pruneUsageRecords(keep: number): number {
    const drop = this.usageRecords.size - Math.max(0, Math.trunc(keep));
    if (!this.sqlite.isReady || !(drop > 0)) return 0;
    const oldest = 'SELECT id FROM knowledge_usage_records ORDER BY created_at ASC LIMIT ?';
    const ids = this.sqlite.exec(oldest, [drop])[0]?.values ?? [];
    this.sqlite.run(`DELETE FROM knowledge_usage_records WHERE id IN (${oldest})`, [drop]);
    for (const [id] of ids) this.usageRecords.delete(String(id));
    return ids.length;
  }

  async upsertConsolidationCandidate(
    input: KnowledgeConsolidationCandidateUpsertInput,
  ): Promise<KnowledgeConsolidationCandidateRecord> {
    await this.init();
    const existing = input.id
      ? this.consolidationCandidates.get(input.id)
      : this.getConsolidationCandidateBySubject(input.subjectKind, input.subjectId, input.candidateType);
    const now = nowMs();
    const _summary = stableText(input.summary);
    const _suggestedMemoryClass = stableText(input.suggestedMemoryClass);
    const _suggestedScope = stableText(input.suggestedScope);
    const _decidedBy = stableText(input.decidedBy);
    const record: KnowledgeConsolidationCandidateRecord = {
      id: existing?.id ?? input.id ?? `kcand-${crypto.randomUUID()}`,
      candidateType: input.candidateType,
      status: input.status ?? existing?.status ?? 'open',
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      title: input.title.trim(),
      ...(_summary !== null ? { summary: _summary } : existing?.summary ? { summary: existing.summary } : {}),
      score: Number(input.score),
      evidence: uniq(input.evidence ?? existing?.evidence),
      ...(_suggestedMemoryClass !== null ? { suggestedMemoryClass: _suggestedMemoryClass } : existing?.suggestedMemoryClass ? { suggestedMemoryClass: existing.suggestedMemoryClass } : {}),
      ...(_suggestedScope !== null ? { suggestedScope: _suggestedScope } : existing?.suggestedScope ? { suggestedScope: existing.suggestedScope } : {}),
      ...(typeof input.decidedAt === 'number' ? { decidedAt: input.decidedAt } : existing?.decidedAt ? { decidedAt: existing.decidedAt } : {}),
      ...(_decidedBy !== null ? { decidedBy: _decidedBy } : existing?.decidedBy ? { decidedBy: existing.decidedBy } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_consolidation_candidates (
        id, candidate_type, status, subject_kind, subject_id, title, summary, score,
        evidence, suggested_memory_class, suggested_scope, decided_at, decided_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.candidateType,
      record.status,
      record.subjectKind,
      record.subjectId,
      record.title,
      record.summary ?? null,
      record.score,
      JSON.stringify([...record.evidence]),
      record.suggestedMemoryClass ?? null,
      record.suggestedScope ?? null,
      record.decidedAt ?? null,
      record.decidedBy ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.consolidationCandidates.set(record.id, record);
    await this.save();
    return record;
  }

  async upsertConsolidationReport(
    input: KnowledgeConsolidationReportUpsertInput,
  ): Promise<KnowledgeConsolidationReportRecord> {
    await this.init();
    const existing = input.id ? this.consolidationReports.get(input.id) : null;
    const now = nowMs();
    const record: KnowledgeConsolidationReportRecord = {
      id: existing?.id ?? input.id ?? `krep-${crypto.randomUUID()}`,
      kind: input.kind,
      title: input.title.trim(),
      summary: input.summary.trim(),
      highlights: uniq(input.highlights ?? existing?.highlights),
      metrics: {
        ...(existing?.metrics ?? {}),
        ...(input.metrics ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_consolidation_reports (
        id, kind, title, summary, highlights, metrics, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.kind,
      record.title,
      record.summary,
      JSON.stringify([...record.highlights]),
      JSON.stringify(record.metrics),
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.consolidationReports.set(record.id, record);
    this.pruneConsolidationReports(MAX_RETAINED_CONSOLIDATION_REPORTS);
    await this.save();
    return record;
  }

  /** Delete the oldest consolidation reports beyond `keep`. */
  pruneConsolidationReports(keep: number): number {
    const cap = Math.max(0, Math.trunc(keep));
    if (this.consolidationReports.size <= cap) return 0;
    const oldest = [...this.consolidationReports.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, this.consolidationReports.size - cap);
    for (const record of oldest) {
      this.sqlite.run('DELETE FROM knowledge_consolidation_reports WHERE id = ?', [record.id]);
      this.consolidationReports.delete(record.id);
    }
    return oldest.length;
  }

  async upsertSchedule(input: KnowledgeScheduleUpsertInput): Promise<KnowledgeScheduleRecord> {
    await this.init();
    return upsertKnowledgeSchedule(this.sqlite, this.schedules, input, () => `ksched-${crypto.randomUUID()}`);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    await this.init();
    return deleteKnowledgeSchedule(this.sqlite, this.schedules, id);
  }

  async planKnowledgeSpaceDelete(spaceId: string): Promise<KnowledgeSpaceDeleteResult> {
    await this.init();
    return planKnowledgeSpaceDeleteRows(this.knowledgeSpaceRowStores(), spaceId);
  }

  async deleteKnowledgeSpace(spaceId: string, input: { readonly dryRun?: boolean } = {}): Promise<KnowledgeSpaceDeleteResult> {
    await this.init();
    if (input.dryRun) return this.planKnowledgeSpaceDelete(spaceId);
    const deleted = deleteKnowledgeSpaceRows(this.sqlite, this.knowledgeSpaceRowStores(), spaceId);
    await this.save();
    return deleted;
  }

  private knowledgeSpaceRowStores(): Parameters<typeof planKnowledgeSpaceDeleteRows>[0] {
    return {
      nodeRevisions: this.nodeRevisions,
      semanticEnrichmentStates: this.semanticEnrichmentStates,
      sources: this.sources,
      nodes: this.nodes,
      edges: this.edges,
      issues: this.issues,
      extractions: this.extractions,
      jobRuns: this.jobRuns,
      refinementTasks: this.refinementTasks,
      usageRecords: this.usageRecords,
      consolidationCandidates: this.consolidationCandidates,
      consolidationReports: this.consolidationReports,
      schedules: this.schedules,
    };
  }

  private async initialize(): Promise<void> {
    await this.sqlite.init(createSchema, {
      storeName: 'knowledge store', schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      initializeFreshSchema: true,
      validateCurrentSchema: validateCurrentKnowledgeSchema,
      migrations: [
        { toVersion: 1, migrate: createSchema },
        { toVersion: 2, migrate: createWorkLedgerTable },
        { toVersion: 3, migrate: db => { validateWorkLedgerTable(db); createNativeWorkExecutionTable(db); } },
        { toVersion: 4, migrate: db => { validateWorkLedgerTable(db); validateNativeWorkExecutionTable(db); createNativeWorkExecutionIntentTable(db); } },
        { toVersion: 5, migrate: db => { validateNativeWorkExecutionTable(db); validateNativeWorkExecutionIntentTable(db); migrateWorkLedgerTableToVersion2(db); } },
        { toVersion: 6, migrate: db => { validateWorkLedgerTable(db); validateNativeWorkExecutionTable(db); validateNativeWorkExecutionIntentTable(db); migrateNativeConversationCaptureTable(db); } },
        { toVersion: 7, migrate: db => { validateNativeConversationCaptureTable(db); migrateNativeWorkSettlementTable(db); } },
        { toVersion: 8, migrate: db => { validateWorkLedgerTable(db); validateNativeWorkSettlementTable(db); createNativeCiContinuationTable(db); validateNativeCiContinuationTable(db); } },
        // Format barrier: owned knowledge clocks may now be canonical ISO TEXT.
        // The existing version opener snapshots v8 before this marker and older
        // targets refuse v9. Do not rewrite or bless any legacy numeric rows.
        { toVersion: 9, migrate: db => {
          // Established v8 data must validate BEFORE the version stamp and the
          // idempotent base-schema pass, which would recreate missing tables.
          validateWorkLedgerTable(db); validateNativeWorkExecutionTable(db);
          validateNativeWorkExecutionIntentTable(db); validateNativeConversationCaptureTable(db);
          validateNativeWorkSettlementTable(db); validateNativeCiContinuationTable(db);
        } },
        { toVersion: 10, migrate: db => { createKnowledgeEdgeChanges(db); } },
        { toVersion: 11, migrate: db => { createKnowledgeRowRevisions(db); validateKnowledgeEdgeChanges(db); } },
        // Writer semantic barrier only: preserve every source ID, original row
        // and SQLite-issued revision. Old hash-ID planning writers refuse v12
        // before the version opener invokes their schema or migration callbacks.
        { toVersion: 12, migrate: db => { validateKnowledgeSchemaV12(db); } },
        // Keep every saved project/source ID. Older default-ID writers cannot
        // recreate namespaces after explicit registration, and older activation
        // writers cannot bypass the new native dependency bookkeeping.
        { toVersion: 13, migrate: db => {
          validateKnowledgeSchemaV12(db);
          createKnowledgeNodeContentRevisions(db);
          createKnowledgeNodeActivationCache(db);
          createNativeWorkSettlementTargetIndex(db);
          validateKnowledgeSchemaV13(db);
        } },
        // A separate version lets existing v13 images pass their original
        // validator before installing scoped projection identity constraints.
        // Earlier writers must not publish unscoped pages over these records.
        { toVersion: 14, migrate: db => {
          validateKnowledgeSchemaV13(db);
          createGeneratedProjectionIdentityIndex(db);
          createArtifactReferenceIndexes(db);
          createSemanticFactIdentityIndex(db);
          validateKnowledgeSchemaV14(db);
        } },
        { toVersion: 15, migrate: db => {
          validateKnowledgeSchemaV14(db);
          createSemanticNodeIdentityIndex(db);
          validateKnowledgeSchemaV15(db);
        } },
        { toVersion: 16, migrate: db => {
          validateKnowledgeSchemaV15(db);
          createHomeGraphNodeIdentityIndexes(db);
          validateKnowledgeSchemaV16(db);
        } },
        { toVersion: 17, migrate: db => {
          validateKnowledgeSchemaV16(db);
          createHomeGraphSourceIdentityIndexes(db);
          validateCurrentKnowledgeSchema(db);
        } },
      ],
    });
    try {
      const verdictTableCreated = ensureKnowledgeScopeVerdictTable(this.sqlite);
      // Retention is an initialization mutation, never a side effect of adopting
      // another writer's current image during a guarded source action. Publish
      // it through the same baseline check before admitting caller mutations.
      validateNativeWorkRows(this.sqlite);
      const pruned = this.pruneJobRuns(MAX_RETAINED_JOB_RUNS) + this.pruneConsolidationReports(MAX_RETAINED_CONSOLIDATION_REPORTS) + trimKnowledgeEdgeChanges(this.sqlite) + pruneOrphanScopeVerdicts(this.sqlite)
        + pruneSettledNativeWork(this.sqlite);
      if (pruned > 0 || verdictTableCreated) await this.sqlite.save();
      this.ready = true;
    } catch (error) {
      // No caller mutation can pass init yet. A failed initialization must not
      // leave its internal retention edits looking ready on the next attempt.
      this.sqlite.close();
      throw error;
    }
  }
}


/** Preparing another write may consume an original pending row, but this
 * restriction never admits that row as persisted semantic evidence. */
export function captureKnowledgePendingNode(store: KnowledgeStore, record: KnowledgeNodeRecord): {
  readonly generation: string; readonly state: () => 'pending' | 'published';
} | undefined {
  const core = nativeArtifactReferenceStores.get(store);
  const publication: NativeNodePublication | undefined = nativeNodePublications.get(record);
  if (!core || !publication?.current || publication.store !== store || !publication.snapshot.generation
    || !publication.snapshot.record || !sameKnowledgeRecord(record, publication.snapshot.record)) return undefined;
  const check = () => {
    if (core.closed() || core.nodes.get(record.id) !== record
      || !sameKnowledgeRecord(record, publication.snapshot.record)) throw new KnowledgeNodeActivationHeldError('stale');
    return publication.current!();
  };
  if (check() !== 'pending') return undefined;
  return Object.freeze({ generation: publication.snapshot.generation, state: check });
}

/** A constructed store only: a copied object cannot acquire a reference-reader
 * capability by presenting an equal filesystem path. */
export function captureKnowledgeArtifactReferenceOwner(store: KnowledgeStore): KnowledgeArtifactReferenceOwner {
  const core = nativeArtifactReferenceStores.get(store);
  if (!core) throw new Error('Knowledge artifact reference owner is unavailable.');
  const current = () => {
    if (core.closed()) throw new Error('Knowledge artifact reference owner is closed.');
  };
  current();
  return Object.freeze({
    path: core.path,
    subscribeClean(listener: () => void): () => void {
      current();
      return core.sqlite.subscribeArtifactReferenceClean(listener);
    },
    async withReads<T>(ids: readonly string[], operation: (referenced: readonly string[], assertCurrent: () => void) => Promise<T>) {
      current(); await store.init(); current();
      const result = await core.sqlite.withArtifactReferenceReads(ids, async (referenced: readonly string[], sqliteCurrent: () => void) => {
        const assertCurrent = () => { current(); sqliteCurrent(); };
        assertCurrent(); const value = await operation(referenced, assertCurrent); assertCurrent(); return value;
      });
      current(); return result;
    },
  });
}


/** Internal native collector seam; deliberately absent from public knowledge
 * exports and operator methods. Caller-built store objects cannot issue it. */
export function updateHomeGraphSnapshotGroups(store: KnowledgeStore, original: KnowledgeNodeRecord,
  groups: readonly string[], assertCurrent: () => void): Promise<KnowledgeNodeRecord> {
  const write = homeGraphSnapshotGroupWriters.get(store);
  if (!write) throw new KnowledgeNodeActivationHeldError('stale');
  return write(original, groups, assertCurrent);
}
