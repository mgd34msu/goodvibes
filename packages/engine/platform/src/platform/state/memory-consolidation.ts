/**
 * memory-consolidation.ts, idle-time memory consolidation policy (HOISTED to the platform).
 *
 * PROVENANCE. Promoted verbatim (semantics-preserving) from the agent surface
 * (`src/agent/memory-consolidation.ts`) so every consumer shares ONE
 * consolidation contract with injectable I/O, rather than each re-deriving it.
 * The only surface-coupled part, the record writes, is expressed as an
 * injected `MemoryConsolidationRegistry` seam; `MemoryRegistry` satisfies it
 * structurally.
 *
 * Whether two records are duplicates, a contradiction or unrelated, and which
 * of two contradicting records is a later correction of the other, is read by
 * Jev (batteries/memory-alignment.ts); which pairs are compared, which record
 * survives a merge, the review-rank guard and every write stay code.
 *
 * The pass performs only REVERSIBLE operations on existing records: it merges
 * duplicate records into a survivor and marks the losers stale (never deletes),
 * and it decays never-referenced, aged records (lowering confidence, then marking
 * stale once the confidence floor is crossed). Anything that would require a NEW
 * standing memory or a destructive delete is emitted as a PROPOSAL routed to the
 * existing confirmation-gated path, this pass never silently writes a new memory
 * or deletes a record. Every run returns a RECEIPT describing exactly what it
 * merged, archived, decayed, and newly proposed.
 *
 * The pass remembers its own work: a cursor in the memory store's meta table
 * says up to when records were compared, so a pass compares only records
 * changed since (each against its nearest records of the same class, capped)
 * and asks nothing when nothing changed. Each pair is applied as its reading
 * settles, so a failed request loses that pair only. Proposals are kept in
 * the store once each (keyed by kind and record ids), so they survive a
 * restart and a pass that finds one again does not report it again.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { agreementContent, alignmentContent, memoryAgreement, memoryAlignment, type MemoryReplacement } from './batteries/memory-alignment.js';
import type { MemoryRecord, MemoryReviewPatch, MemoryScope, MemorySearchFilter, MemorySemanticSearchResult } from './memory-store.js';
import type { MemoryOperationOptions } from './memory-operation.js';
import type { ResolvedMemoryConsolidationConfig } from './memory-consolidation-config.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Honest per-memory usage signal consumed by the decay ordering. */
export interface MemoryConsolidationUsageSignal {
  readonly injectedCount: number;
  readonly referencedCount: number;
  readonly lastReferencedAt: number | null;
}

/** Lookup of the usage signal for a memory id; undefined when never instrumented. */
export type MemoryConsolidationUsageLookup = (memoryId: string) => MemoryConsolidationUsageSignal | undefined;

export type MemoryConsolidationTrigger = 'idle' | 'schedule' | 'manual';

/**
 * The record-mutation seam the pass writes through. Structural, so a concrete
 * MemoryRegistry (or any equivalent wrapper) satisfies it and the policy stays
 * decoupled from the store implementation. Only reversible writes are used:
 * `review` (mark stale / lower confidence) and `update` (merge tag unions).
 */
export interface MemoryConsolidationRegistry {
  getAll(): readonly MemoryRecord[];
  review(id: string, patch: MemoryReviewPatch, options?: MemoryOperationOptions): MemoryRecord | null;
  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null;
  /** Vector neighbours of a record, nearest first; without it a changed record is compared with the newest of its class. */
  semanticCandidates?(filter: MemorySearchFilter): readonly MemorySemanticSearchResult[] | Promise<readonly MemorySemanticSearchResult[]>;
  /** The store's meta table, which holds the pass's cursor; without it every pass compares every active record. */
  readStoreMeta?(key: string): string | null;
  writeStoreMeta?(key: string, value: string): void;
  /** The store's standing proposals; returns the ones not already standing. Without it every proposal is reported each run. */
  addConsolidationProposals?(proposals: readonly MemoryConsolidationProposal[], at?: number): MemoryConsolidationProposal[];
  listConsolidationProposals?(): MemoryConsolidationProposal[];
}

export interface MemoryConsolidationInput {
  readonly memoryRegistry: MemoryConsolidationRegistry;
  readonly config: ResolvedMemoryConsolidationConfig;
  readonly now: number;
  readonly trigger: MemoryConsolidationTrigger;
  readonly idle: boolean;
  /** Optional usage instrumentation. Records decay only when it reports them never referenced; without it nothing decays. */
  readonly usageLookup?: MemoryConsolidationUsageLookup;
  /**
   * Optional deterministic random-suffix seam for the receipt `runId`. Defaults
   * to `Math.random()`-derived. Injected only so tests can assert a stable id;
   * production leaves it unset for the same behavior as the agent original.
   */
  readonly randomSuffix?: () => string;
}

export interface MemoryConsolidationMergeEntry {
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly scope: string;
  readonly cls: string;
}

export interface MemoryConsolidationArchiveEntry {
  readonly id: string;
  readonly reason: string;
  readonly previousConfidence: number;
}

export interface MemoryConsolidationDecayEntry {
  readonly id: string;
  readonly fromConfidence: number;
  readonly toConfidence: number;
  readonly referencedCount: number;
}

export interface MemoryConsolidationProposal {
  readonly kind: 'contradiction' | 'cross-scope-duplicate' | 'stale-delete';
  readonly ids: readonly string[];
  readonly route: string;
  readonly reason: string;
}

export interface MemoryConsolidationRunReceipt {
  readonly provenance?: 'classic';
  readonly disposition?: 'skipped';
  readonly runId: string;
  readonly ranAt: string;
  readonly trigger: MemoryConsolidationTrigger;
  readonly idle: boolean;
  readonly scanned: number;
  readonly merged: readonly MemoryConsolidationMergeEntry[];
  readonly archived: readonly MemoryConsolidationArchiveEntry[];
  readonly decayed: readonly MemoryConsolidationDecayEntry[];
  /** Proposals this run added; ones already standing from earlier runs are not repeated. */
  readonly proposed: readonly MemoryConsolidationProposal[];
  /** Record pairs read this run (one or two decision-model requests each). */
  readonly pairsRead?: number;
  readonly usageSignalAvailable: boolean;
  readonly note: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DELETE_PROPOSAL_AGE_DAYS = 90;

const SITE = 'state.memory-consolidation';

/**
 * Most record pairs one pass reads. Every pair costs one or two requests. A
 * pass reads only pairs with a record changed since the cursor; when more than
 * this many are due, the cursor stops before the first record not compared,
 * so the next pass carries on from there.
 */
const MAX_PAIR_READINGS_PER_RUN = 200;

/**
 * A changed record is compared with at most this many records of its class,
 * nearest by vector similarity first (a new record is the likeliest duplicate
 * of a close old one). Also the pair readings in flight at once.
 */
const PAIRS_PER_CHANGED_RECORD = 8;

/** Meta key of the pass's cursor in the memory store. */
const CURSOR_KEY = 'consolidation.cursor';

/**
 * Up to when records were compared (`at`, epoch ms), and the records the pass
 * itself last wrote with the updatedAt it left them at (`own`), so its own
 * merges and decays do not count as changes for the next pass.
 */
export interface MemoryConsolidationCursor {
  readonly at: number;
  readonly own: Readonly<Record<string, number>>;
}

/** The stored cursor, or null when no pass has completed (or the registry has no meta table). */
export function readMemoryConsolidationCursor(registry: Pick<MemoryConsolidationRegistry, 'readStoreMeta'>): MemoryConsolidationCursor | null {
  const raw = registry.readStoreMeta?.(CURSOR_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; own?: unknown };
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    const own: Record<string, number> = {};
    if (parsed.own && typeof parsed.own === 'object') {
      for (const [id, stamp] of Object.entries(parsed.own as Record<string, unknown>)) if (typeof stamp === 'number') own[id] = stamp;
    }
    return { at: parsed.at, own };
  } catch {
    return null;
  }
}

function changedSince(record: MemoryRecord, cursor: MemoryConsolidationCursor | null): boolean {
  return cursor === null || (record.updatedAt > cursor.at && cursor.own[record.id] !== record.updatedAt);
}

function verifiedRank(record: MemoryRecord): number {
  if (record.reviewState === 'reviewed') return 2;
  if (record.reviewState === 'fresh') return 1;
  return 0;
}

/** Active for consolidation purposes: fresh or reviewed only. Stale/contradicted are already resolved. */
function isActive(record: MemoryRecord): boolean {
  return record.reviewState === 'fresh' || record.reviewState === 'reviewed';
}

/** Prefer the newer, more-verified, higher-confidence record as the survivor. */
function chooseSurvivor(records: readonly MemoryRecord[]): MemoryRecord {
  return [...records].sort((left, right) => {
    if (verifiedRank(right) !== verifiedRank(left)) return verifiedRank(right) - verifiedRank(left);
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.updatedAt - left.updatedAt;
  })[0]!;
}

/** Why an automated write was or was not applied. */
type AutomatedWriteOutcome = 'applied' | 'changed' | 'person-reviewed';

/**
 * Who may write over whom. The pass reads a snapshot, then awaits model
 * readings for every pair, so a person (or another writer) can change a
 * record in between. Every write the pass makes goes through here: it
 * re-reads the record and skips it when it no longer matches what the pass
 * last saw, and it never moves a record a person reviewed (`reviewed` by
 * anyone but consolidation itself) except to update its tags.
 */
class AutomatedReviewGuard {
  private readonly known: Map<string, MemoryRecord>;
  private current: Map<string, MemoryRecord>;
  /** The first write error of the pass; once set the pass writes nothing more. */
  failure: string | undefined;

  constructor(private readonly registry: MemoryConsolidationRegistry, snapshot: readonly MemoryRecord[]) {
    this.known = new Map(snapshot.map((record) => [record.id, record]));
    this.current = this.known;
  }

  /** Re-read the store after an await; writes after this are synchronous, so nothing interleaves. */
  refresh(): void {
    this.current = new Map(this.registry.getAll().map((record) => [record.id, record]));
  }

  /** The record as the store holds it now, when the pass may still act on it. */
  unchanged(id: string): MemoryRecord | undefined {
    const known = this.known.get(id), current = this.current.get(id);
    if (!known || !current) return undefined;
    if (current.updatedAt !== known.updatedAt || current.reviewState !== known.reviewState
      || current.confidence !== known.confidence) return undefined;
    return current;
  }

  applyAutomatedReview(id: string, patch: (current: MemoryRecord) => MemoryReviewPatch): AutomatedWriteOutcome {
    const current = this.unchanged(id);
    if (!current || this.failure !== undefined) return 'changed';
    if (isPersonReviewed(current)) return 'person-reviewed';
    return this.write(id, () => this.registry.review(id, patch(current), { automatedReview: true }));
  }

  applyAutomatedTagUpdate(id: string, tags: string[]): AutomatedWriteOutcome {
    if (!this.unchanged(id) || this.failure !== undefined) return 'changed';
    return this.write(id, () => this.registry.update(id, { tags }));
  }

  /** A refused write (another process saved the file, a full disk) ends the pass cleanly instead of throwing through it. */
  private write(id: string, perform: () => MemoryRecord | null): AutomatedWriteOutcome {
    try {
      return this.adopt(id, perform());
    } catch (error) {
      this.failure = summarizeError(error);
      logger.warn('[memory] consolidation write failed; stopping the pass', { id, error: this.failure });
      return 'changed';
    }
  }

  private adopt(id: string, written: MemoryRecord | null): AutomatedWriteOutcome {
    if (!written) return 'changed';
    this.known.set(id, written);
    if (this.current !== this.known) this.current.set(id, written);
    this.written.set(id, written.updatedAt);
    return 'applied';
  }

  /** Records this pass wrote, with the updatedAt each write left. */
  readonly written = new Map<string, number>();
}

function isPersonReviewed(record: MemoryRecord): boolean {
  return record.reviewState === 'reviewed' && record.reviewedBy !== 'consolidation';
}

interface MergePlanResult {
  readonly merged: MemoryConsolidationMergeEntry[];
  readonly proposals: MemoryConsolidationProposal[];
  /** Ids consumed by a merge/contradiction this run, excluded from decay. */
  readonly touched: Set<string>;
  readonly pairsRead: number;
  /** The oldest updatedAt among changed records whose comparisons did not all complete; undefined when every one did. */
  readonly incompleteFrom: number | undefined;
  /** Changed records whose comparisons all completed, with the updatedAt they were compared at. */
  readonly compared: ReadonlyMap<string, number>;
  /** Why the pass stopped reading pairs early, when every reading of a record failed. */
  readonly readFailure: string | undefined;
}

export type MemoryPairRelation = 'duplicate' | 'contradiction' | 'unrelated';

/**
 * A pair's reading: how the records relate, and which one, if either, the
 * `replaces` reading names as a later correction of the other. `replacement`
 * is 'neither' unless that reading's outcome is act.
 */
export interface MemoryPairReading {
  readonly relation: MemoryPairRelation;
  readonly replacement: MemoryReplacement;
}

/**
 * The records a changed record is compared with: same class (any scope, so
 * cross-scope collisions surface), nearest by the vector index first, then
 * the newest of the class, at most PAIRS_PER_CHANGED_RECORD.
 */
async function comparisonPartners(
  registry: MemoryConsolidationRegistry,
  record: MemoryRecord,
  sameClass: readonly MemoryRecord[],
): Promise<MemoryRecord[]> {
  const byId = new Map(sameClass.filter((other) => other.id !== record.id).map((other) => [other.id, other]));
  const partners: MemoryRecord[] = [];
  if (registry.semanticCandidates && byId.size > PAIRS_PER_CHANGED_RECORD) {
    try {
      const neighbours = await registry.semanticCandidates({ query: record.summary, cls: record.cls, limit: PAIRS_PER_CHANGED_RECORD * 2 });
      for (const { record: neighbour } of neighbours) {
        const other = byId.get(neighbour.id);
        if (!other || partners.includes(other)) continue;
        partners.push(other);
        if (partners.length >= PAIRS_PER_CHANGED_RECORD) return partners;
      }
    } catch (error) {
      logger.debug('[memory] consolidation neighbour lookup failed; comparing with the newest records of the class', { error: summarizeError(error) });
    }
  }
  for (const other of [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt)) {
    if (partners.length >= PAIRS_PER_CHANGED_RECORD) break;
    if (!partners.includes(other)) partners.push(other);
  }
  return partners;
}

/**
 * How two records relate, composed from two readings (see
 * batteries/memory-alignment.ts for the mapping): the aligner rules distinct
 * pairs out, then the agreement reading, in one request, tells a duplicate
 * from a contradiction and names which record, if either, is a later
 * correction of the other. Code acts on a yes or a choice only when the
 * reading's outcome is act; a conflict wins over a restatement. The action
 * recorded here is the relation; planAndApplyMerges records nothing further,
 * and what it did with the pair is in the run receipt.
 */
export async function classifyMemoryPair(a: MemoryRecord, b: MemoryRecord): Promise<MemoryPairReading> {
  const port = judgmentPort(SITE);
  const aligned = await memoryAlignment.align(port, alignmentContent(a), alignmentContent(b), { site: SITE });
  if (aligned.alignment === 'distinct') {
    aligned.recordAction('unrelated');
    return { relation: 'unrelated', replacement: 'neither' };
  }
  const run = await memoryAgreement.run(port, { record_a: agreementContent(a), record_b: agreementContent(b) }, { site: SITE });
  const { restates, conflicts, replaces } = run.readings;
  const relation: MemoryPairRelation = conflicts.verdict === 'yes' && conflicts.outcome === 'act'
    ? 'contradiction'
    : restates.verdict === 'yes' && restates.outcome === 'act' ? 'duplicate' : 'unrelated';
  const replacement: MemoryReplacement = replaces.outcome === 'act' ? replaces.choice : 'neither';
  aligned.recordAction(relation);
  run.recordAction(relation === 'contradiction' && replacement !== 'neither' ? `${relation}:${replacement}` : relation);
  return { relation, replacement };
}

const CURATOR_ROUTE = 'memory action:"curator" query:"consolidation"';

/**
 * Read candidate pairs and act on them: a same-scope duplicate is merged into
 * a survivor; a same-scope contradiction where the reading names one record a
 * later correction of the other, and that record is at least as reviewed, is
 * resolved by marking the replaced record stale; any other contradiction
 * flags both records contradicted and proposes them for a person; any pair
 * that spans scopes is only proposed, never merged automatically.
 */
async function planAndApplyMerges(
  input: MemoryConsolidationInput,
  active: readonly MemoryRecord[],
  changed: readonly MemoryRecord[],
  guard: AutomatedReviewGuard,
): Promise<MergePlanResult> {
  const proposals: MemoryConsolidationProposal[] = [];
  const touched = new Set<string>();
  /** Records marked stale or contradicted this run; they take part in no further pair. */
  const resolved = new Set<string>();
  const merges = new Map<string, { survivor: MemoryRecord; tags: Set<string>; duplicateIds: string[] }>();
  const byClass = new Map<string, MemoryRecord[]>();
  for (const record of active) {
    const bucket = byClass.get(record.cls) ?? [];
    bucket.push(record);
    byClass.set(record.cls, bucket);
  }
  const readPairs = new Set<string>();
  const compared = new Map<string, number>();
  let pairsRead = 0;
  let incompleteFrom: number | undefined;
  let readFailure: string | undefined;
  let stopped = false;
  const incomplete = (record: MemoryRecord): void => {
    incompleteFrom = incompleteFrom === undefined ? record.updatedAt : Math.min(incompleteFrom, record.updatedAt);
  };

  for (const record of changed) {
    if (stopped) { incomplete(record); continue; }
    if (resolved.has(record.id)) continue;
    const partners = (await comparisonPartners(input.memoryRegistry, record, byClass.get(record.cls) ?? []))
      .filter((other) => !resolved.has(other.id) && !readPairs.has(pairKey(record, other)));
    if (partners.length === 0) { compared.set(record.id, record.updatedAt); continue; }
    if (pairsRead + partners.length > MAX_PAIR_READINGS_PER_RUN) { stopped = true; incomplete(record); continue; }
    for (const other of partners) readPairs.add(pairKey(record, other));
    pairsRead += partners.length;
    // Each pair is applied as its reading settles: a failed request loses that pair, not the pass.
    const settled = await Promise.allSettled(partners.map((other) => classifyMemoryPair(record, other)));
    guard.refresh();
    const failures = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length > 0) {
      incomplete(record);
      logger.warn('[memory] consolidation pair readings failed', { id: record.id, failed: failures.length, of: partners.length, error: summarizeError(failures[0]!.reason) });
      // Every reading of this record failed: the decision model is unavailable, so stop instead of paying for the rest.
      if (failures.length === partners.length) { stopped = true; readFailure = summarizeError(failures[0]!.reason); }
    } else {
      compared.set(record.id, record.updatedAt);
    }
    for (const [index, other] of partners.entries()) {
      const outcome = settled[index]!;
      if (outcome.status !== 'fulfilled') continue;
      applyPairReading(input, record, other, outcome.value, { proposals, touched, resolved, merges }, guard);
    }
    // A failed write stops the pass; this record's pairs are compared again next time.
    if (guard.failure !== undefined) { compared.delete(record.id); incomplete(record); stopped = true; }
  }

  const merged: MemoryConsolidationMergeEntry[] = [];
  for (const { survivor, duplicateIds } of merges.values()) {
    merged.push({ survivorId: survivor.id, duplicateIds, scope: survivor.scope, cls: survivor.cls });
  }
  return { merged, proposals, touched, pairsRead, incompleteFrom, compared, readFailure };
}

function pairKey(a: MemoryRecord, b: MemoryRecord): string {
  return a.id < b.id ? `${a.id}\0${b.id}` : `${b.id}\0${a.id}`;
}

interface PairState {
  readonly proposals: MemoryConsolidationProposal[];
  readonly touched: Set<string>;
  readonly resolved: Set<string>;
  readonly merges: Map<string, { survivor: MemoryRecord; tags: Set<string>; duplicateIds: string[] }>;
}

/** Act on one pair's reading (see planAndApplyMerges). */
function applyPairReading(
  input: MemoryConsolidationInput,
  a: MemoryRecord,
  b: MemoryRecord,
  reading: MemoryPairReading,
  state: PairState,
  guard: AutomatedReviewGuard,
): void {
  const { proposals, touched, resolved, merges } = state;
  if (guard.failure !== undefined) return;
  const { relation, replacement } = reading;
  if (relation === 'unrelated' || resolved.has(a.id) || resolved.has(b.id)) return;

  if (a.scope !== b.scope && relation === 'duplicate') {
    // These records do not disagree, so they stay as they are and stay
    // injectable; the proposal is what reaches a person. Touched so decay
    // leaves them alone this run.
    proposals.push({
      kind: 'cross-scope-duplicate',
      ids: [a.id, b.id],
      route: CURATOR_ROUTE,
      reason: 'Records in different scopes state the same fact; merging across scope needs review.',
    });
    touched.add(a.id);
    touched.add(b.id);
    return;
  }

  // A duplicate keeps the more trusted record; a contradiction the reading
  // settles keeps the record it names as the later correction.
  const replacer = replacement === 'a_replaces_b' ? a : replacement === 'b_replaces_a' ? b : undefined;
  const survivor = relation === 'contradiction' && replacer ? replacer : chooseSurvivor([a, b]);
  const loser = survivor.id === a.id ? b : a;
  // A record that already absorbed others this run stays their survivor.
  if (merges.has(loser.id)) return;
  const sameScope = a.scope === b.scope;
  // The replacing record must be at least as reviewed as the one it
  // replaces; the guard additionally refuses to move a person's review.
  const supersedes = relation === 'contradiction' && sameScope && replacer !== undefined
    && verifiedRank(survivor) >= verifiedRank(loser);

  if (relation === 'contradiction' && !supersedes) {
    const reason = sameScope
      ? 'Records disagree about the same fact and neither is a later correction at least as reviewed as the other.'
      : 'Records in different scopes disagree about the same fact; resolving across scope needs review.';
    proposals.push({ kind: 'contradiction', ids: [survivor.id, loser.id], route: CURATOR_ROUTE, reason });
    // The proposal REACHES the review machinery: each disagreeing record
    // the guard lets automation move is marked contradicted, which
    // prioritises it in the review queue and excludes it from injection
    // until a human resolves it. A record a person reviewed keeps that
    // review. Nothing is deleted; the resolution stays the human's.
    for (const id of [survivor.id, loser.id]) {
      guard.applyAutomatedReview(id, () => ({ state: 'contradicted', staleReason: reason, reviewedBy: 'consolidation' }));
      touched.add(id);
      resolved.add(id);
    }
    return;
  }

  const entry = merges.get(survivor.id);
  if (!entry && merges.size >= input.config.maxMergesPerRun) return;
  const survivorNow = guard.unchanged(survivor.id);
  const loserNow = guard.unchanged(loser.id);
  const tags = new Set(entry?.tags ?? survivor.tags);
  if (relation === 'duplicate') for (const tag of loser.tags) tags.add(tag);
  let outcome: AutomatedWriteOutcome;
  if (!survivorNow || !loserNow) outcome = 'changed';
  else if (isPersonReviewed(loserNow)) outcome = 'person-reviewed';
  // The survivor takes the loser's tags first, so a stopped pass never
  // leaves a loser marked stale whose tags nobody kept.
  else if (tags.size !== survivorNow.tags.length && guard.applyAutomatedTagUpdate(survivor.id, [...tags]) !== 'applied') outcome = 'changed';
  else {
    outcome = guard.applyAutomatedReview(loser.id, () => ({
      state: 'stale',
      staleReason: relation === 'duplicate'
        ? `Duplicate of ${survivor.id}; merged by idle consolidation.`
        : `Superseded by ${survivor.id}, a later correction or update of it; resolved by idle consolidation.`,
      reviewedBy: 'consolidation',
    }));
  }
  touched.add(loser.id);
  touched.add(survivor.id);
  resolved.add(loser.id);
  if (outcome !== 'applied') {
    if (outcome === 'person-reviewed' && relation === 'contradiction') {
      proposals.push({
        kind: 'contradiction',
        ids: [survivor.id, loser.id],
        route: CURATOR_ROUTE,
        reason: `The reading names ${survivor.id} a later correction of ${loser.id}, but a person reviewed ${loser.id}; resolving it needs review.`,
      });
    }
    return;
  }
  const merge = entry ?? { survivor, tags, duplicateIds: [] };
  merge.tags = tags;
  merges.set(survivor.id, merge);
  merge.duplicateIds.push(loser.id);
}

/**
 * Decay never-referenced, aged records, never-referenced first (that is what the
 * usage instrumentation feeds). A record's confidence drops by decayConfidenceStep;
 * once it would fall to/below archiveConfidenceFloor it is marked stale (archived).
 */
function applyDecay(
  input: MemoryConsolidationInput,
  active: readonly MemoryRecord[],
  touched: ReadonlySet<string>,
  guard: AutomatedReviewGuard,
): { decayed: MemoryConsolidationDecayEntry[]; archived: MemoryConsolidationArchiveEntry[] } {
  const decayed: MemoryConsolidationDecayEntry[] = [];
  const archived: MemoryConsolidationArchiveEntry[] = [];
  const ageCutoff = input.now - input.config.decayAgeDays * DAY_MS;

  const candidates = active
    .filter((record) => !touched.has(record.id))
    .filter((record) => record.updatedAt <= ageCutoff)
    .flatMap((record) => {
      // Decay is for records known never to have been referenced. A record the
      // usage lookup has no entry for, or a pass with no lookup at all, is not
      // known to be unused, so it keeps its confidence.
      const usage = input.usageLookup?.(record.id);
      return usage ? [{ record, usage }] : [];
    })
    .filter((entry) => entry.usage.referencedCount === 0)
    .sort((left, right) => {
      const leftLast = left.usage.lastReferencedAt ?? 0;
      const rightLast = right.usage.lastReferencedAt ?? 0;
      if (leftLast !== rightLast) return leftLast - rightLast;
      return left.record.updatedAt - right.record.updatedAt;
    });

  for (const { record, usage } of candidates) {
    if (decayed.length + archived.length >= input.config.maxDecaysPerRun || guard.failure !== undefined) break;
    const current = guard.unchanged(record.id);
    if (!current) continue;
    const nextConfidence = current.confidence - input.config.decayConfidenceStep;
    if (nextConfidence <= input.config.archiveConfidenceFloor) {
      const outcome = guard.applyAutomatedReview(record.id, () => ({
        state: 'stale',
        staleReason: `Never referenced since injection and aged past ${input.config.decayAgeDays}d; archived by idle consolidation.`,
        reviewedBy: 'consolidation',
      }));
      if (outcome === 'applied') archived.push({ id: record.id, reason: 'never-referenced-aged', previousConfidence: current.confidence });
    } else {
      // Only the confidence moves: the state and the reviewer stay whatever
      // the store holds now.
      const outcome = guard.applyAutomatedReview(record.id, () => ({ confidence: nextConfidence }));
      if (outcome === 'applied') {
        decayed.push({
          id: record.id,
          fromConfidence: current.confidence,
          toConfidence: nextConfidence,
          referencedCount: usage.referencedCount,
        });
      }
    }
  }

  return { decayed, archived };
}

/**
 * Propose (never perform) deletion of long-stale records through the gated
 * memory route. Every candidate is offered to the store, which keeps each
 * once; the run's cap applies to what the receipt reports, so a long list is
 * worked through instead of the same first few being found every time.
 */
function planStaleDeleteProposals(
  input: MemoryConsolidationInput,
  records: readonly MemoryRecord[],
): MemoryConsolidationProposal[] {
  const proposals: MemoryConsolidationProposal[] = [];
  const cutoff = input.now - STALE_DELETE_PROPOSAL_AGE_DAYS * DAY_MS;
  for (const record of records) {
    if (record.reviewState !== 'stale') continue;
    if (record.updatedAt > cutoff) continue;
    proposals.push({
      kind: 'stale-delete',
      ids: [record.id],
      route: `memory action:"delete" id:"${record.id}" explicitUserRequest:"..."`,
      reason: `Stale for over ${STALE_DELETE_PROPOSAL_AGE_DAYS}d; propose removal through the confirmed delete route.`,
    });
  }
  return proposals;
}

/** The proposals not already standing in the store; all of them when the store cannot keep them. */
function keepProposals(registry: MemoryConsolidationRegistry, found: readonly MemoryConsolidationProposal[], now: number): readonly MemoryConsolidationProposal[] {
  if (!registry.addConsolidationProposals) return found;
  try {
    return registry.addConsolidationProposals(found, now);
  } catch (error) {
    logger.warn('[memory] consolidation proposals were not kept; this run reports all it found', { error: summarizeError(error) });
    return found;
  }
}

/**
 * Move the cursor to `at` and remember the records newer than it that need no
 * comparison next time: those this pass compared or wrote, and earlier entries
 * whose record still carries the stamp they name.
 */
function writeCursor(
  registry: MemoryConsolidationRegistry,
  previous: MemoryConsolidationCursor | null,
  guard: AutomatedReviewGuard,
  compared: ReadonlyMap<string, number>,
  at: number,
): void {
  if (!registry.writeStoreMeta) return;
  const current = new Map(registry.getAll().map((record) => [record.id, record.updatedAt]));
  const own: Record<string, number> = {};
  for (const [id, stamp] of Object.entries(previous?.own ?? {})) if (current.get(id) === stamp && stamp > at) own[id] = stamp;
  for (const [id, stamp] of compared) if (current.get(id) === stamp && stamp > at) own[id] = stamp;
  for (const [id, stamp] of guard.written) if (current.get(id) === stamp && stamp > at) own[id] = stamp;
  try {
    registry.writeStoreMeta(CURSOR_KEY, JSON.stringify({ at: Math.max(previous?.at ?? 0, at), own }));
  } catch (error) {
    logger.warn('[memory] consolidation cursor was not saved; the next pass compares these records again', { error: summarizeError(error) });
  }
}

export async function runMemoryConsolidation(input: MemoryConsolidationInput): Promise<MemoryConsolidationRunReceipt> {
  return decisionOrClassic(() => runDecisionMemoryConsolidation(input), () => {
    const suffix = input.randomSuffix ? input.randomSuffix() : Math.random().toString(36).slice(2, 8);
    return {
      runId: `mcon-${input.now.toString(36)}-${suffix}`, ranAt: new Date(input.now).toISOString(),
      trigger: input.trigger, idle: input.idle, provenance: 'classic' as const, disposition: 'skipped' as const,
      scanned: 0, merged: [], archived: [], decayed: [], proposed: [], usageSignalAvailable: input.usageLookup !== undefined,
      note: 'Classic skipped semantic memory consolidation. No memories were merged, archived or decayed. Review and update individual memories explicitly.',
    };
  });
}
async function runDecisionMemoryConsolidation(input: MemoryConsolidationInput): Promise<MemoryConsolidationRunReceipt> {
  const registry = input.memoryRegistry;
  const all = registry.getAll();
  const active = all.filter(isActive);
  const cursor = readMemoryConsolidationCursor(registry);
  // Newest change first: a new record is the likeliest duplicate. Records
  // compared before the pass stopped are kept in the cursor's `own` list.
  const changed = active.filter((record) => changedSince(record, cursor))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));

  const guard = new AutomatedReviewGuard(registry, all);
  const mergeResult = await planAndApplyMerges(input, active, changed, guard);
  const decayResult = applyDecay(input, active, mergeResult.touched, guard);
  const found = [...mergeResult.proposals, ...planStaleDeleteProposals(input, all)];
  const proposals = keepProposals(registry, found, input.now).slice(0, input.config.maxProposalsPerRun);
  // One millisecond back, so a record stamped in the same millisecond the pass began is compared next time, not skipped.
  writeCursor(registry, cursor, guard, mergeResult.compared, Math.min(input.now - 1, mergeResult.incompleteFrom === undefined ? input.now : mergeResult.incompleteFrom - 1));

  const suffix = input.randomSuffix ? input.randomSuffix() : Math.random().toString(36).slice(2, 8);
  const runId = `mcon-${input.now.toString(36)}-${suffix}`;
  return {
    runId,
    ranAt: new Date(input.now).toISOString(),
    trigger: input.trigger,
    idle: input.idle,
    scanned: all.length,
    merged: mergeResult.merged,
    archived: decayResult.archived,
    decayed: decayResult.decayed,
    proposed: proposals,
    pairsRead: mergeResult.pairsRead,
    usageSignalAvailable: input.usageLookup !== undefined,
    note: guard.failure !== undefined
      ? `Idle consolidation stopped early because a memory write failed (${guard.failure}). The merges, archives and decays listed were applied; nothing else was changed.`
      : mergeResult.readFailure !== undefined
        ? `Idle consolidation stopped comparing records early because the decision model did not answer (${mergeResult.readFailure}). What is listed was applied; the records not compared are compared on the next pass.`
      : 'Idle consolidation performs only reversible merges (loser marked stale, not deleted) and decays only records known never to have been referenced. New memories and deletes are proposed through the existing confirmation-gated routes, never written silently.',
  };
}
