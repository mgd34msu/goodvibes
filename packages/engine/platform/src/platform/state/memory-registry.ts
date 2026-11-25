import { captureMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
import type { MemoryClass, MemoryAddInsert, MemoryAddOptions, MemoryBundle, MemoryDoctorReport, MemoryLink, MemoryRecord, MemoryReviewPatch, MemoryScope, MemorySearchFilter, MemorySemanticSearchResult, MemoryStore } from './memory-store.js';
import type { MemoryVectorStats } from './memory-vector-store.js';
import type { MemoryImportResult } from './memory-store.js';
import type { MemoryUsageChange, MemoryUsageEntry, MemoryUsageTopEntry } from './memory-usage-stats.js';
import {
  MEMORY_CONSOLIDATION_ACTIONS,
  type MemoryConsolidationAction,
  type MemoryConsolidationDecision,
  type MemoryConsolidationProposal,
} from './memory-consolidation.js';

/** Store meta key: ids of proposals the owner decided should stand as they are. */
const STANDING_DECISIONS_META = 'consolidation.proposals.decided-standing';
const STANDING_DECISIONS_LIMIT = 2_000;

/** One proposal per kind and set of records, whatever order a pass found them in (the store's key). */
function consolidationProposalId(proposal: Pick<MemoryConsolidationProposal, 'kind' | 'ids'>): string {
  return `${proposal.kind}:${[...proposal.ids].sort().join(',')}`;
}
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { newStoreSnapshotPath } from './store-snapshots.js';
import { listMemorySnapshots, MemorySnapshotError, readMemorySnapshotImage, resolveMemorySnapshot, type MemoryRestoreResult, type MemorySnapshotInfo } from './memory-snapshots.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { runHonestMemorySearch, type HonestMemorySearchOptions, type HonestMemorySearchResult } from './memory-recall-contract.js';

/**
 * MemoryRegistry, thin observable wrapper around the MemoryStore.
 * Panels subscribe via listeners; commands push/retrieve through this.
 */
export class MemoryRegistry {
  private store: MemoryStore;
  private listeners: Array<() => void> = [];

  constructor(store: MemoryStore) {
    this.store = store;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  captureOperationScope(): () => void {
    const store = this.store, current = store.captureOperationScope();
    return () => {
      if (this.store !== store) throw new Error('Memory operation registry changed');
      current();
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  /**
   * Tell every listener after a write the store committed. The write is
   * already published, so nothing here can make it look failed (a retry would
   * store the memory twice): not the caller's lifecycle ending meanwhile, not a
   * panel that throws, and every listener is told.
   */
  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch (error) { logger.warn('MemoryRegistry: a listener threw', { error: summarizeError(error) }); }
    }
  }

  /** `insert` pins the row to a staged record and runs a callback at the insert (see MemoryStore.add). */
  async add(opts: MemoryAddOptions, options?: MemoryOperationOptions, insert?: MemoryAddInsert): Promise<MemoryRecord> {
    const operation = captureMemoryOperation(options);
    // A new record may not claim the reserved consolidation reviewer either (see review()).
    const claimsAutomation = options?.automatedReview !== true && opts.review?.reviewedBy?.trim().toLowerCase() === 'consolidation';
    if (claimsAutomation) logger.warn('MemoryRegistry: add claimed the reserved consolidation reviewer; recorded as operator');
    const safeOpts = claimsAutomation ? { ...opts, review: { ...opts.review, reviewedBy: 'operator' } } : opts;
    // Not raced against the signal: the store checks it before the row is
    // published and then lets the write finish, so an aborted add either
    // stores nothing or resolves with the stored record.
    const record = await this.store.add(safeOpts, operation, insert);
    this.notify();
    return record;
  }

  /** Search; a query in the filter is ranked by the memory-search rerank (see MemoryStore.search). */
  search(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    return this.store.search(filter, options);
  }

  searchSemantic(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
    return this.store.searchSemantic(filter, options);
  }

  /** The vector index's candidates in similarity order, retrieval only (see MemoryStore.semanticCandidates). */
  semanticCandidates(filter: MemorySearchFilter = {}): Promise<MemorySemanticSearchResult[]> {
    return this.store.semanticCandidates(filter);
  }

  /**
   * Search honoring the recall-honesty contract: semantic-or-literal with a stated
   * fallback reason when the index is unavailable, and (with `options.recall`) the
   * flagged/confidence-floor exclusion. This is the method a wire client and an
   * offline surface both route through, so the honesty is identical either way.
   */
  honestSearch(filter: MemorySearchFilter = {}, options: HonestMemorySearchOptions = {}, lifecycle?: MemoryOperationOptions): Promise<HonestMemorySearchResult> {
    return runHonestMemorySearch(this.store, filter, options, lifecycle);
  }

  rebuildVectors(): MemoryVectorStats {
    return this.store.rebuildVectorIndex();
  }

  async rebuildVectorsAsync(): Promise<MemoryVectorStats> {
    return this.store.rebuildVectorIndexAsync();
  }

  vectorStats(options?: MemoryOperationOptions): MemoryVectorStats {
    return this.store.vectorStats(options);
  }

  async doctor(options?: MemoryOperationOptions): Promise<MemoryDoctorReport> {
    return this.store.doctor(options);
  }

  reviewQueue(limit = 10, scope?: MemoryScope, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    return this.store.reviewQueue(limit, scope, options);
  }

  exportBundle(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryBundle {
    return this.store.exportBundle(filter, options);
  }

  async importBundle(bundle: MemoryBundle, options?: MemoryOperationOptions, intoProject?: string): Promise<MemoryImportResult> {
    const operation = captureMemoryOperation(options);
    const result = await this.store.importBundle(bundle, operation, intoProject);
    this.notify();
    return result;
  }

  get(id: string, options?: MemoryOperationOptions): MemoryRecord | null {
    return this.store.get(id, options);
  }

  async link(fromId: string, toId: string, relation: string, options?: MemoryOperationOptions): Promise<MemoryLink | null> {
    const operation = captureMemoryOperation(options);
    const link = await this.store.link(fromId, toId, relation, operation);
    if (link) this.notify();
    return link;
  }

  linksFor(id: string, options?: MemoryOperationOptions): MemoryLink[] {
    return this.store.linksFor(id, options);
  }

  update(id: string, patch: { cls?: MemoryClass; scope?: MemoryScope; project?: string | undefined; summary?: string; detail?: string; tags?: string[]; validFrom?: number | null; validUntil?: number | null; resetReview?: true }, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = captureMemoryOperation(options);
    const record = this.store.update(id, patch, operation);
    if (record) this.notify();
    return record;
  }

  review(id: string, patch: MemoryReviewPatch, options?: MemoryOperationOptions): MemoryRecord | null {
    // Consolidation treats `reviewedBy: 'consolidation'` as automation that a person's review overrides, so
    // no other caller may claim it; the review still applies, under the neutral operator name.
    const claimsAutomation = options?.automatedReview !== true && patch.reviewedBy?.trim().toLowerCase() === 'consolidation';
    if (claimsAutomation) logger.warn('MemoryRegistry: review claimed the reserved consolidation reviewer; recorded as operator', { id });
    const operation = captureMemoryOperation(options);
    const record = this.store.review(id, claimsAutomation ? { ...patch, reviewedBy: 'operator' } : patch, operation);
    if (record) this.notify();
    return record;
  }

  delete(id: string, options?: MemoryOperationOptions): boolean {
    const operation = captureMemoryOperation(options);
    const removed = this.store.delete(id, operation);
    if (removed) this.notify();
    return removed;
  }

  /** Resolves once the last update, review or delete is on disk; rejects with why when its commit failed. */
  saved(): Promise<void> {
    return this.store.saved();
  }

  /** The store's point-in-time copies, newest first (daily, before a migration, before a restore). */
  listSnapshots(): MemorySnapshotInfo[] {
    return listMemorySnapshots(this.store.dbPath);
  }

  /**
   * Put the records of one copy back (see MemoryStore.replaceFromSnapshot).
   * The copy is read and checked first; then, under one write lock, the
   * records being replaced are copied to a `pre-restore` copy and replaced,
   * so the restore can itself be undone by restoring that copy and no other
   * writer's change falls between the two. Nothing is changed when any step
   * fails. The owner's act only: callers reach it through a confirmed command
   * or the confirmed operator verb.
   */
  async restoreSnapshot(selector: string, options?: MemoryOperationOptions): Promise<MemoryRestoreResult> {
    const store = this.store, dbPath = store.dbPath;
    const chosen = resolveMemorySnapshot(dbPath, selector);
    const image = readMemorySnapshotImage(chosen);
    if (!dbPath) throw new MemorySnapshotError('MEMORY_SNAPSHOT_UNAVAILABLE', 'This memory store lives in memory only, so it keeps no copies; nothing was changed.');
    // The undo copy keeps the store's own permissions (memory is private to its owner).
    const undo = { path: newStoreSnapshotPath(dbPath, 'pre-restore'), mode: statSync(dbPath).mode & 0o777 };
    const replaced = await store.replaceFromSnapshot(image, undo, options);
    this.notify();
    return {
      restored: image.name,
      restoredReason: image.reason,
      restoredCreatedAt: image.createdAt,
      recordsBefore: replaced.recordsBefore,
      recordsAfter: replaced.recordsAfter,
      linksAfter: replaced.linksAfter,
      undoSnapshot: basename(undo.path),
      vectorIndex: replaced.vectorIndex,
    };
  }

  getAll(): MemoryRecord[] {
    return this.store.retrieve({});
  }

  /** One turn's usage counts, one store update (see MemoryStore.recordUsage). Counters are not record edits, so listeners are not told. */
  recordUsage(change: MemoryUsageChange, at?: number): Promise<void> {
    return this.store.recordUsage(change, at);
  }

  usage(id: string): MemoryUsageEntry | null {
    return this.store.usage(id);
  }

  usageEntries(): MemoryUsageTopEntry[] {
    return this.store.usageEntries();
  }

  readStoreMeta(key: string): string | null {
    return this.store.readMeta(key);
  }

  writeStoreMeta(key: string, value: string): void {
    this.store.writeMeta(key, value);
  }

  /** Once per store: 3.5.0 "this project" records given the project they were saved in (MemoryStore.attributeOldProjectRecords). */
  attributeOldProjectRecords(attribute: (record: MemoryRecord) => string | undefined): ReturnType<MemoryStore['attributeOldProjectRecords']> {
    const done = this.store.attributeOldProjectRecords(attribute);
    if (done && done.attributed.size > 0) this.notify();
    return done;
  }

  /** Keeps consolidation proposals once each; returns the ones that were not already standing. */
  addConsolidationProposals(proposals: readonly MemoryConsolidationProposal[], at?: number): MemoryConsolidationProposal[] {
    return this.store.addConsolidationProposals(proposals, at);
  }

  /**
   * The proposals that still need a person, each with its `id`. A proposal is
   * gone once decided: the records it named were changed so it no longer holds,
   * or the owner decided they stand as they are (kept in store meta).
   */
  listConsolidationProposals(): MemoryConsolidationProposal[] {
    const standing = this.standingDecisions();
    return this.store.listConsolidationProposals()
      .map((proposal) => ({ ...proposal, id: consolidationProposalId(proposal) }))
      .filter((proposal) => !standing.has(proposal.id));
  }

  /**
   * Apply the owner's answer to one proposal. One write per record changed;
   * nothing is changed when the proposal is gone or the action does not fit
   * its kind.
   */
  decideConsolidationProposal(proposalId: string, action: MemoryConsolidationAction): MemoryConsolidationDecision {
    const proposal = this.listConsolidationProposals().find((entry) => entry.id === proposalId);
    if (!proposal) {
      return { decided: false, proposalId, refusal: { code: 'PROPOSAL_NOT_FOUND', state: 'the proposal is no longer pending',
        reason: 'No pending consolidation proposal has that id: it was decided already, or a record it named changed so it no longer holds; nothing was changed',
        next: ['Refresh the review list'] } };
    }
    const allowed = MEMORY_CONSOLIDATION_ACTIONS[proposal.kind];
    if (!allowed.includes(action)) {
      return { decided: false, proposalId, refusal: { code: 'ACTION_NOT_ALLOWED', state: `a ${proposal.kind} proposal`,
        reason: `A ${proposal.kind} proposal accepts ${allowed.join(', ')}; nothing was changed`, next: [`Answer with one of: ${allowed.join(', ')}`] } };
    }
    const [first, second] = proposal.ids;
    const changed: string[] = [];
    const removed: string[] = [];
    const reviewed = (id: string | undefined): void => {
      if (id && this.review(id, { state: 'reviewed', reviewedBy: 'operator' })) changed.push(id);
    };
    const superseded = (loser: string | undefined, winner: string | undefined): void => {
      if (!loser) return;
      const reason = proposal.kind === 'contradiction' ? `Contradicted by ${winner ?? 'another record'}; the owner kept that one.`
        : `Duplicate of ${winner ?? 'another record'} in another scope; the owner kept that one.`;
      if (this.review(loser, { state: 'stale', staleReason: reason, reviewedBy: 'operator' })) changed.push(loser);
      reviewed(winner);
    };
    if (action === 'delete') { if (first && this.delete(first)) removed.push(first); }
    else if (action === 'keep') reviewed(first);
    else if (action === 'keep-first') superseded(second, first);
    else if (action === 'keep-second') superseded(first, second);
    else {
      for (const id of proposal.ids) reviewed(id);
      const standing = [...this.standingDecisions(), proposalId].slice(-STANDING_DECISIONS_LIMIT);
      this.writeStoreMeta(STANDING_DECISIONS_META, JSON.stringify(standing));
    }
    return { decided: true, proposalId, action, changed, removed };
  }

  private standingDecisions(): Set<string> {
    try {
      const raw = this.readStoreMeta(STANDING_DECISIONS_META);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []);
    } catch { return new Set(); }
  }

  /**
   * Tells listeners when another process committed to the memory file since
   * the last look (see MemoryStore.reloadIfChanged), so panels show that
   * process's records.
   */
  async reloadIfChanged(): Promise<void> {
    const store = this.store, before = store.externalRevision;
    await store.reloadIfChanged();
    if (store.externalRevision !== before) this.notify();
  }
}

