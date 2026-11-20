/**
 * MemoryStore, project memory substrate.
 *
 * Durable, provenance-rich memory for decisions, constraints, incidents, and
 * patterns. Backed by SQLite via SQLiteStore. Survives process restarts and is
 * queryable by runtime/panel/context enrichment consumers.
 *
 * Provenance links can reference: session, turn, task, event, or file.
 */

import { captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
import { rankReviewQueue, rankSemanticSearch, rerankRetrieved } from './memory-search-ranking.js';
import { MEMORY_ID_SHAPE, newMemoryId } from './memory-id.js';
import { SQLiteStore } from './sqlite-store.js';
import {
  SqliteVecMemoryIndex,
  type MemoryVectorStats,
  resolveMemoryVectorDbPath,
  type MemoryVectorEntry,
} from './memory-vector-store.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingDoctorReport,
} from './memory-embeddings.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { MemoryUsageChange, MemoryUsageEntry, MemoryUsageTopEntry } from './memory-usage-stats.js';
import type { MemoryConsolidationProposal } from './memory-consolidation.js';
import { MEMORY_SNAPSHOT_TABLES, MemorySnapshotError, writeMemoryCopy, type MemorySnapshotImage } from './memory-snapshots.js';
import {
  assertValidMemoryBundle,
  assertValidMemoryFields,
  clampConfidence,
  compareByTrust,
  createSchema,
  isReviewFlagged,
  normalizeReviewState,
  normalizeScope,
  recordMatchesPostSqlFilter,
  rowToRecord,
  MEMORY_SCHEMA_VERSION,
  validateMemoryRowRevisions,
} from './memory-store-helpers.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Native score for a fresh record, independent of any model judgment. */
const FRESH_MEMORY_CONFIDENCE = 60;

export type MemoryClass =
  | 'decision'
  | 'constraint'
  | 'incident'
  | 'pattern'
  | 'fact'
  | 'risk'
  | 'runbook'
  | 'architecture'
  | 'ownership';

export type MemoryScope = 'session' | 'project' | 'team';

export type MemoryReviewState = 'fresh' | 'reviewed' | 'stale' | 'contradicted';

export type ProvenanceLinkKind = 'session' | 'turn' | 'task' | 'event' | 'file';

export interface ProvenanceLink {
  kind: ProvenanceLinkKind;
  /** The referenced identifier (session ID, turn number, task ID, event ID, or file path). */
  ref: string;
  /** Optional human-readable label. */
  label?: string | undefined;
}

export interface MemoryRecord {
  /** Auto-assigned, unique within the store. */
  id: string;
  /** Scope of the record for retrieval and sharing workflows. */
  scope: MemoryScope;
  /** Memory class, governs retrieval priority and display grouping. */
  cls: MemoryClass;
  /** Brief summary (one sentence). */
  summary: string;
  /** Optional expanded detail. */
  detail?: string | undefined;
  /** Tags for search and grouping. */
  tags: string[];
  /** Provenance links back to the source context. */
  provenance: ProvenanceLink[];
  /** Operator/state review signal. */
  reviewState: MemoryReviewState;
  /** Confidence score from 0-100. Higher means the record is more trusted for retrieval. */
  confidence: number;
  /** Last explicit review timestamp, if any. */
  reviewedAt?: number | undefined;
  /** Reviewer identity, if recorded. */
  reviewedBy?: string | undefined;
  /** If stale/contradicted, why. */
  staleReason?: string | undefined;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last updated timestamp (epoch ms). */
  updatedAt: number;
  /**
   * Temporal validity window, start. Epoch ms. When set, the record is NOT
   * injected before this time (it is "pending"). Undefined means valid from
   * creation. Consulted at injection time; see memory-recall-contract.ts.
   */
  validFrom?: number | undefined;
  /**
   * Temporal validity window, end. Epoch ms. When set, the record stops being
   * injected at/after this time (it is "expired"), but it is NOT deleted, and
   * read/list surfaces label it expired rather than silently dropping it.
   * Undefined means no expiry.
   */
  validUntil?: number | undefined;
}

export type { MemoryTemporalStatus } from './memory-temporal.js';
export { memoryRecordTemporalStatus, isMemoryTemporallyActive } from './memory-temporal.js';

export interface MemoryLink {
  /** ID of the source record. */
  fromId: string;
  /** ID of the target record. */
  toId: string;
  /** Human-readable relationship label, e.g. "caused", "supersedes". */
  relation: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
}

export interface MemorySearchFilter {
  scope?: MemoryScope | undefined;
  cls?: MemoryClass | undefined;
  tags?: string[] | undefined;
  /** Full-text substring match on summary and detail; the matches are ordered by the memory-search rerank. */
  query?: string | undefined;
  /** Use the sqlite-vec semantic index for query ranking when available. */
  semantic?: boolean | undefined;
  /** Return records created after this timestamp. */
  since?: number | undefined;
  /** Match a specific review state or a small set of states. */
  reviewState?: MemoryReviewState | MemoryReviewState[] | undefined;
  /** Minimum confidence threshold, 0-100. */
  minConfidence?: number | undefined;
  /** Restrict to records with at least one matching provenance kind. */
  provenanceKinds?: ProvenanceLinkKind[] | undefined;
  /** Convenience flag for review queue retrieval. */
  staleOnly?: boolean | undefined;
  limit?: number | undefined;
}

export interface MemoryAddOptions {
  /**
   * An id the caller generated (`mem_<base36 time>_<8 hex>`), which makes the add
   * safe to resend: the same id with the same record returns the stored row
   * instead of adding a second one; the same id with a different record is refused.
   * Absent: the store generates one.
   */
  id?: string | undefined;
  scope?: MemoryScope | undefined;
  cls: MemoryClass;
  summary: string;
  detail?: string | undefined;
  tags?: string[] | undefined;
  provenance?: ProvenanceLink[] | undefined;
  /** Temporal validity window start (epoch ms). Undefined = valid from creation. */
  validFrom?: number | undefined;
  /** Temporal validity window end (epoch ms). Undefined = no expiry. */
  validUntil?: number | undefined;
  review?: {
    state?: MemoryReviewState | undefined;
    confidence?: number | undefined;
    reviewedAt?: number | undefined;
    reviewedBy?: string | undefined;
    staleReason?: string | undefined;
  };
}

/**
 * Pins an add to a record the caller staged ({@link planMemoryRecord}) and
 * runs a callback at the insert. The Agent's learning promotion stages its own
 * transition with the record before the write and completes it at the insert.
 */
export interface MemoryAddInsert {
  /** The staged id; the row is stored under it, and an id already in use is refused. */
  readonly id?: string | undefined;
  /** The staged creation time, so the stored row is the staged record. */
  readonly createdAt?: number | undefined;
  /** Runs synchronously after the row is inserted and before it is saved; a throw removes the row and fails the add. */
  readonly onInserted?: ((record: MemoryRecord) => void) | undefined;
}

const ADD_RECORD_COLUMNS = ['id', 'scope', 'cls', 'summary', 'detail', 'tags', 'provenance', 'review_state', 'confidence',
  'reviewed_at', 'reviewed_by', 'stale_reason', 'created_at', 'updated_at', 'valid_from', 'valid_until'];

/** Whether a stored row is what an add of `opts` would have stored: a resend of the same add. */
function isSameAdd(stored: MemoryRecord, opts: MemoryAddOptions): boolean {
  const tags = opts.tags ?? [];
  return stored.cls === opts.cls && stored.summary === opts.summary && stored.scope === (opts.scope ?? 'project')
    && (stored.detail ?? undefined) === (opts.detail ?? undefined)
    && stored.tags.length === tags.length && stored.tags.every((tag, index) => tag === tags[index]);
}

function addRecordParameters(record: MemoryRecord): Array<string | number | null> {
  return [record.id, record.scope, record.cls, record.summary, record.detail ?? null,
    JSON.stringify(record.tags), JSON.stringify(record.provenance), record.reviewState, record.confidence,
    record.reviewedAt ?? null, record.reviewedBy ?? null, record.staleReason ?? null,
    record.createdAt, record.updatedAt, record.validFrom ?? null, record.validUntil ?? null];
}

function authoredRecord(opts: MemoryAddOptions, id: string, at: number): MemoryRecord {
  return {
    id,
    scope: opts.scope ?? 'project',
    cls: opts.cls,
    summary: opts.summary,
    detail: opts.detail,
    tags: opts.tags ?? [],
    provenance: opts.provenance ?? [],
    reviewState: opts.review?.state ?? 'fresh',
    confidence: clampConfidence(opts.review?.confidence ?? FRESH_MEMORY_CONFIDENCE),
    reviewedAt: opts.review?.reviewedAt,
    reviewedBy: opts.review?.reviewedBy,
    staleReason: opts.review?.staleReason,
    createdAt: at,
    updatedAt: at,
    validFrom: opts.validFrom,
    validUntil: opts.validUntil,
  };
}

/**
 * The record an add of `opts` stores, exactly as a read returns it, without
 * writing anything: pass its `id` and `createdAt` to {@link MemoryStore.add}
 * to store this record.
 */
export function planMemoryRecord(opts: MemoryAddOptions, at: number = Date.now()): MemoryRecord {
  assertValidMemoryFields(opts);
  return rowToRecord(ADD_RECORD_COLUMNS, addRecordParameters(authoredRecord(opts, newMemoryId(at), at)));
}

export interface MemoryReviewPatch {
  state?: MemoryReviewState | undefined;
  confidence?: number | undefined;
  reviewedBy?: string | undefined;
  staleReason?: string | undefined;
}

export interface MemoryBundle {
  schemaVersion: 'v1';
  exportedAt: number;
  scope: MemoryScope | 'all';
  recordCount: number;
  linkCount: number;
  records: MemoryRecord[];
  links: MemoryLink[];
}

export interface MemoryImportResult {
  importedRecords: number;
  skippedRecords: number;
  importedLinks: number;
}

export interface MemorySemanticSearchResult {
  /** Classic scores describe retrieval only, never independent semantic confidence. */
  readonly provenance?: 'classic';
  readonly scoreSource?: 'literal-overlap' | 'vector-similarity';
  record: MemoryRecord;
  distance: number;
  similarity: number;
  /** Decision rerank probability on 0 to 100, or the explicitly named Classic retrieval score. */
  score: number;
}

export interface MemoryStoreOptions {
  embeddingRegistry: MemoryEmbeddingProviderRegistry;
  enableVectorIndex?: boolean | undefined;
  vectorDbPath?: string | undefined;
}

export interface MemoryDoctorReport {
  readonly vector: MemoryVectorStats;
  readonly embeddings: MemoryEmbeddingDoctorReport;
  readonly checkedAt: number;
}

export { MemoryRegistry } from './memory-registry.js';

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private sqlite: SQLiteStore;
  private vectorIndex: SqliteVecMemoryIndex | null;
  private ready = false;
  private rebuildVectorIndexPromise: Promise<MemoryVectorStats> | null = null;
  /** A pass asked for while one ran: null when none, else whether it re-embeds every row. */
  private rebuildVectorIndexAgain: boolean | null = null;
  private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry;
  private backendEpoch = 0;
  /** Operations this store captured; a write runs only under one of them. */
  private readonly operations = new WeakSet<MemoryOperationOptions>();
  /** SQLite's data_version as of the last look; another connection's commit changes it. */
  private seenDataVersion = 0;
  /** Counts the times another process was seen to have committed to the memory file. */
  private foreignCommits = 0;
  /** Writes applied to the image whose save failed and has not been followed by a successful one. */
  private unsavedChanges = 0;
  /** The commit persist() started last; a burst of writes in one turn shares it. */
  private lastSave: Promise<void> = Promise.resolve();

  constructor(dbPath: string | undefined, options: MemoryStoreOptions) {
    this.sqlite = this.openBackend(dbPath);
    this.embeddingRegistry = options.embeddingRegistry;
    this.vectorIndex = options.enableVectorIndex === false
      ? null
      : new SqliteVecMemoryIndex(
          options.vectorDbPath ?? resolveMemoryVectorDbPath(dbPath),
          undefined,
          this.embeddingRegistry,
          id => this.rowRevision(id),
        );
  }

  async init(): Promise<void> {
    if (this.ready) return;
    this.backendEpoch++;
    await this.initBackend(this.sqlite);
    this.seenDataVersion = this.sqlite.dataVersion();
    this.ready = true;
    await this.vectorIndex?.init();
    this.syncVectorIndexInBackground();
    logger.info('MemoryStore: initialized', { ready: true });
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** The on-disk database path backing this store, or null when ephemeral. */
  get dbPath(): string | null {
    return this.sqlite.databasePath;
  }

  /** Backend incarnation only; ordinary writes do not change this binding. */
  captureOperationScope(): () => void {
    const sqlite = this.sqlite, vector = this.vectorIndex, ready = this.ready, epoch = this.backendEpoch;
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    return () => {
      if (this.sqlite !== sqlite || this.vectorIndex !== vector || this.ready !== ready || this.backendEpoch !== epoch
        || this.embeddingRegistry.getDefaultProviderOrNull() !== provider) {
        throw new Error('Memory operation store changed');
      }
    };
  }

  /**
   * An operation binds to the caller's lifecycle and the backend incarnation.
   * Writes need nothing more: each one reads and writes its rows in one
   * synchronous step on the current rows, so one write landing beside another
   * cannot be built on stale rows, and neither is refused for it.
   */
  private captureOperation(options?: MemoryOperationOptions): MemoryOperationOptions {
    if (options && this.operations.has(options)) return options;
    const lifecycle = captureMemoryOperation(options), scope = this.captureOperationScope();
    const operation = captureMemoryOperation({ signal: lifecycle.signal, assertCurrent: () => {
      assertMemoryOperationCurrent(lifecycle); scope();
    } });
    this.operations.add(operation);
    return operation;
  }

  /**
   * Add a new memory record. Returns the created record. `insert` pins the
   * row to a staged id and creation time and runs `onInserted` at the insert
   * (see {@link MemoryAddInsert}); a staged add returns the record as a read does.
   */
  async add(opts: MemoryAddOptions, options?: MemoryOperationOptions, insert: MemoryAddInsert = {}): Promise<MemoryRecord> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) throw new Error('MemoryStore: not initialized');
    assertValidMemoryFields(opts);

    const now = insert.createdAt ?? Date.now();
    if (!Number.isFinite(now)) throw new Error('MemoryStore: the staged creation time is not a time; nothing was stored.');
    if (insert.id === undefined && opts.id !== undefined) {
      if (!MEMORY_ID_SHAPE.test(opts.id)) {
        throw new Error(`MemoryStore: ${opts.id} is not a memory id (mem_<base36 time>_<8 hex>); nothing was stored.`);
      }
      const existing = this.get(opts.id);
      if (existing) {
        // A resend of an add that already landed (its reply was lost): the stored row is the answer.
        if (isSameAdd(existing, opts)) return existing;
        throw new Error(`MemoryStore: ${opts.id} already holds a different memory; nothing was stored. Add it without an id, or with a new one.`);
      }
    }
    const id = insert.id ?? opts.id ?? newMemoryId(now);
    if (insert.id !== undefined && (!MEMORY_ID_SHAPE.test(insert.id) || this.get(insert.id) !== null)) {
      throw new Error(`MemoryStore: ${insert.id} is not a new memory id; nothing was stored. Plan the record again and retry.`);
    }
    const record = authoredRecord(opts, id, now);
    const parameters = addRecordParameters(record);
    const stored = rowToRecord(ADD_RECORD_COLUMNS, parameters);

    let inserted = false;
    try {
      this.runMutation(
        `INSERT INTO memory_records
           (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        parameters,
        operation,
        () => { inserted = true; insert.onInserted?.(stored); },
      );
    } catch (error) {
      // The insert callback refused the row: it is taken out again, so nothing was stored.
      if (inserted) this.withdrawUnsavedAdd(id);
      throw error;
    }

    // The row is published: from here only a failed save can make this add
    // fail, never the caller's lifecycle or another write landing meanwhile, or
    // the caller would retry a row that already exists into a duplicate. The
    // index follows the committed row whatever happened to the caller.
    this.indexRow(record);
    try {
      await this.persistNow();
    } catch (error) {
      this.withdrawUnsavedAdd(id);
      const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
      throw new Error(`MemoryStore: the memory could not be saved to disk (${summarizeError(cause)}); nothing was stored. Retry once the disk can be written.`, { cause });
    }
    logger.info('MemoryStore: record added', { id, cls: opts.cls });
    return insert.id !== undefined ? stored : record;
  }

  /** Retrieve a single record by ID. */
  get(id: string, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
         FROM memory_records WHERE id = ? LIMIT 1`,
      [id],
    );

    if (!rows.length || !(rows[0]?.values.length)) return null;
    return rowToRecord(rows[0]?.columns ?? [], rows[0]?.values[0] ?? []);
  }

  /**
   * Search records with an optional filter. Retrieval is code (the SQL filter,
   * or the vector index when `semantic` is set); when the filter carries a
   * query, the `engine.state.memory-search` rerank orders what retrieval found.
   */
  async search(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    if (filter.semantic) {
      return (await awaitMemoryOperation(() => this.searchSemantic(filter, operation), operation)).map((entry) => entry.record);
    }
    const query = filter.query?.trim();
    if (!query) return this.retrieve(filter, operation);
    const ranked = await awaitMemoryOperation(() => rerankRetrieved(query, this.retrieve({ ...filter, limit: undefined }, operation), filter.limit, operation), operation);
    const records = ranked.map((entry) => entry.record);
    return filter.limit !== undefined ? records.slice(0, filter.limit) : records;
  }

  /**
   * Retrieval only, no relevance ranking: the filter's records in
   * compareByTrust order. Bulk reads (getAll, review queue, export) use it.
   */
  retrieve(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryRecord[] {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.scope) {
      conditions.push('scope = ?');
      params.push(filter.scope);
    }

    if (filter.cls) {
      conditions.push('cls = ?');
      params.push(filter.cls);
    }

    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    if (filter.reviewState) {
      if (Array.isArray(filter.reviewState)) {
        conditions.push(`review_state IN (${filter.reviewState.map(() => '?').join(', ')})`);
        params.push(...filter.reviewState);
      } else {
        conditions.push('review_state = ?');
        params.push(filter.reviewState);
      }
    }

    if (filter.query) {
      const escaped = filter.query.replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push("(summary LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    if (filter.tags?.length) {
      for (const tag of filter.tags) {
        const escapedTag = tag.replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapedTag}"%`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
         FROM memory_records ${where}
         ORDER BY updated_at DESC, created_at DESC`,
      params,
    );

    if (!rows.length) return [];

    let records = (rows[0]?.values ?? []).map(v => rowToRecord(rows[0]?.columns ?? [], v));

    if (filter.minConfidence !== undefined) {
      records = records.filter((record) => record.confidence >= filter.minConfidence!);
    }

    if (filter.provenanceKinds?.length) {
      const allowed = new Set(filter.provenanceKinds);
      records = records.filter((record) => record.provenance.some((link) => allowed.has(link.kind)));
    }

    if (filter.staleOnly) {
      records = records.filter((record) => isReviewFlagged(record));
    }

    records = records.sort(compareByTrust);

    if (filter.limit !== undefined) {
      records = records.slice(0, filter.limit);
    }

    return records;
  }

  /**
   * The vector index's candidates for the filter's query, in similarity order,
   * with the filter's post-SQL conditions applied. Retrieval only: nothing here
   * judges relevance. Empty when there is no query or the index returns
   * nothing (a failed query embed is on `vectorStats().error`). The query is
   * embedded through the asynchronous embed, so every embedding provider
   * answers. `score` is the similarity on a 0 to 100 scale.
   */
  async semanticCandidates(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    const query = filter.query?.trim();
    if (!query) return [];
    const requestedLimit = Math.max(1, filter.limit ?? 10);
    const vectorFilter = {
      ...filter,
      limit: Math.max(requestedLimit * 8, 50),
    };
    const results: MemorySemanticSearchResult[] = [];
    for (const candidate of await this.vectorIndex?.search(query, vectorFilter, operation) ?? []) {
      const record = this.get(candidate.id, operation);
      if (!record) continue;
      if (!recordMatchesPostSqlFilter(record, filter)) continue;
      results.push({ record, distance: candidate.distance, similarity: candidate.similarity, score: candidate.similarity * 100 });
    }
    return results.sort((a, b) => a.distance - b.distance || b.record.updatedAt - a.record.updatedAt);
  }

  /** Semantic search: the vector index builds the shortlist, the rerank orders it (memory-search-ranking.ts). */
  async searchSemantic(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    return awaitMemoryOperation(() => rankSemanticSearch(this, filter, operation), operation);
  }

  /** Records to review, most in need of a person first (compareReviewNeed: stored fields only, no model request). */
  async reviewQueue(limit = 10, scope?: MemoryScope, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return rankReviewQueue(this.retrieve(scope ? { scope } : {}, operation), limit);
  }

  /** Exports the records the filter selects; a query here filters, it does not rank. */
  exportBundle(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryBundle {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    const records = this.retrieve(filter, operation);
    const recordIds = new Set(records.map((record) => record.id));
    const links: MemoryLink[] = [];
    for (const record of records) {
      for (const link of this.linksFor(record.id, operation)) {
        if (!recordIds.has(link.fromId) || !recordIds.has(link.toId)) continue;
        const duplicate = links.some((existing) => (
          existing.fromId === link.fromId
          && existing.toId === link.toId
          && existing.relation === link.relation
        ));
        if (!duplicate) links.push(link);
      }
    }

    return {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: filter.scope ?? 'all',
      recordCount: records.length,
      linkCount: links.length,
      records,
      links,
    };
  }

  /**
   * Import a bundle. The whole bundle is checked first (shape, sizes, counts),
   * so a malformed or oversized file imports nothing, and a failure while
   * writing removes the rows already inserted, so an import is all or nothing.
   *
   * Imported text is outside this store's own review: a record arrives
   * unreviewed (`fresh`) at no more than the baseline confidence, whatever the
   * bundle claims, so a bundle cannot place itself above the recall floors.
   * `stale` and `contradicted` flags are kept, they only make a record less
   * trusted.
   */
  async importBundle(bundle: MemoryBundle, options?: MemoryOperationOptions): Promise<MemoryImportResult> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) throw new Error('MemoryStore: not initialized');
    assertValidMemoryBundle(bundle);

    let importedRecords = 0;
    let skippedRecords = 0;
    let importedLinks = 0;
    const insertedIds: string[] = [];
    const insertedLinks: Array<readonly [string, string, string]> = [];

    try {
      for (const record of bundle.records) {
        if (this.get(record.id)) {
          skippedRecords++;
          continue;
        }
        const state = normalizeReviewState(record.reviewState);
        const flagged = state === 'stale' || state === 'contradicted';
        this.runMutation(
          `INSERT INTO memory_records
             (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            normalizeScope(record.scope),
            record.cls,
            record.summary,
            record.detail ?? null,
            JSON.stringify(record.tags ?? []),
            JSON.stringify(record.provenance ?? []),
            flagged ? state : 'fresh',
            flagged ? clampConfidence(record.confidence) : Math.min(clampConfidence(record.confidence), FRESH_MEMORY_CONFIDENCE),
            flagged ? record.reviewedAt ?? null : null,
            flagged ? record.reviewedBy ?? null : null,
            flagged ? record.staleReason ?? null : null,
            record.createdAt,
            record.updatedAt,
            record.validFrom ?? null,
            record.validUntil ?? null,
          ],
          operation,
        );
        insertedIds.push(record.id);
        importedRecords++;
        // Index the row as stored (normalised), not the bundle's raw values.
        const stored = this.get(record.id, operation);
        if (stored) this.indexRow(stored);
      }

      for (const link of bundle.links) {
        if (!this.get(link.fromId) || !this.get(link.toId)) continue;
        const existed = (this.sqlite.exec(
          'SELECT 1 FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ? LIMIT 1',
          [link.fromId, link.toId, link.relation],
        )[0]?.values.length ?? 0) > 0;
        this.runMutation(
          `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at)
           VALUES (?, ?, ?, ?)`,
          [link.fromId, link.toId, link.relation, link.createdAt],
          operation,
        );
        if (!existed) insertedLinks.push([link.fromId, link.toId, link.relation]);
        importedLinks++;
      }
    } catch (error) {
      try {
        for (const [fromId, toId, relation] of insertedLinks) {
          this.runMutation('DELETE FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?', [fromId, toId, relation], operation);
        }
        for (const id of insertedIds) {
          this.runMutation('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', [id, id], operation);
          this.runMutation('DELETE FROM memory_records WHERE id = ?', [id], operation);
          this.vectorIndex?.delete(id, operation);
        }
      } catch (rollbackError) {
        logger.error('MemoryStore: bundle import failed and could not be fully undone', {
          importedRecords, importedLinks, error: summarizeError(error), rollbackError: summarizeError(rollbackError),
        });
        void this.saveImage().catch((err: unknown) => logger.warn('MemoryStore: autosave failed', { error: summarizeError(err) }));
        throw new Error(`MemoryStore: bundle import failed (${summarizeError(error)}) and could not be fully undone; ${importedRecords} record(s) and ${importedLinks} link(s) may remain.`, { cause: error });
      }
      throw error;
    }

    // Published: only a failed save can still fail the import (see add).
    await this.persistNow();
    logger.info('MemoryStore: bundle imported', { importedRecords, skippedRecords, importedLinks });
    return { importedRecords, skippedRecords, importedLinks };
  }

  /**
   * Make the store hold exactly the copy's records, links, proposals and store
   * facts, in one immediate write transaction. Under that lock, first the
   * store as it stands is written to `undo.path` (a complete copy, read through
   * this same connection), then it is cleared and filled from the image, then
   * the transaction commits. A writer in another process therefore either
   * committed before the lock (and is in the undo copy) or waits for it and
   * lands after the restore (and is in the store), never in neither. A failure
   * at any step rolls the whole restore back; a failed undo copy changes
   * nothing. Each record keeps the revision it had in the copy, so the vector
   * index re-embeds only the records whose text differs from what it holds.
   * Other processes see the restored rows on their next read (SQLite
   * `data_version`); nothing is reopened.
   */
  async replaceFromSnapshot(image: MemorySnapshotImage, undo: { readonly path: string; readonly mode: number }, options?: MemoryOperationOptions): Promise<{ readonly recordsBefore: number; readonly recordsAfter: number; readonly linksAfter: number; readonly vectorIndex: 'updating' | 'off' }> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) throw new Error('MemoryStore: not initialized');
    const cell = (value: unknown): string | number | Uint8Array | null => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string' || typeof value === 'number' || value instanceof Uint8Array) return value;
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      return String(value);
    };
    const outcome = await this.sqlite.transactPersisted((db) => {
      const count = (table: string): number => {
        const value = db.exec(`SELECT count(*) FROM ${table}`)[0]?.values[0]?.[0];
        return typeof value === 'number' ? value : 0;
      };
      try {
        writeMemoryCopy(db, undo.path, undo.mode);
      } catch (error) {
        throw new MemorySnapshotError('MEMORY_SNAPSHOT_UNAVAILABLE',
          `A copy of the current records could not be written first (${summarizeError(error)}), so the restore was not started; nothing was changed.`);
      }
      const recordsBefore = count('memory_records');
      // Links first: they name records (foreign keys are on).
      for (const table of [...MEMORY_SNAPSHOT_TABLES].reverse()) db.run(`DELETE FROM ${table}`);
      for (const table of MEMORY_SNAPSHOT_TABLES) {
        const source = image.tables.get(table);
        if (!source || source.rows.length === 0) continue;
        const live = new Set((db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((row) => String(row[1])));
        // The revision is stamped by the insert trigger and set back below; an
        // older copy without a newer column gets that column's default.
        const kept = source.columns.flatMap((column, index) => live.has(column) && column !== 'gv_revision' ? [{ column, index }] : []);
        if (kept.length === 0) continue;
        const sql = `INSERT INTO ${table} (${kept.map((entry) => entry.column).join(', ')}) VALUES (${kept.map(() => '?').join(', ')})`;
        for (const row of source.rows) db.run(sql, kept.map((entry) => cell(row[entry.index])));
      }
      const records = image.tables.get('memory_records');
      const idAt = records?.columns.indexOf('id') ?? -1, revisionAt = records?.columns.indexOf('gv_revision') ?? -1;
      if (records && idAt >= 0 && revisionAt >= 0) {
        // A revision-only update does not fire the revision trigger (it lists the content columns).
        for (const row of records.rows) {
          const revision = row[revisionAt];
          if (typeof revision === 'string' && revision !== '') db.run('UPDATE memory_records SET gv_revision = ? WHERE id = ?', [revision, cell(row[idAt])]);
        }
      }
      return { changed: true, value: { recordsBefore, recordsAfter: count('memory_records'), linksAfter: count('memory_links') } };
    }, () => {});
    if (outcome.kind !== 'completed') throw new Error('MemoryStore: the restore did not complete; the store is as it was.');
    logger.info('MemoryStore: records restored from a copy', { copy: image.name, recordsBefore: outcome.value.recordsBefore, recordsAfter: outcome.value.recordsAfter });
    // Re-embed what differs and drop what is gone, off the caller's path.
    this.syncVectorIndexInBackground();
    return { ...outcome.value, vectorIndex: this.vectorIndex ? 'updating' : 'off' };
  }

  /** Create a directed link between two records. */
  async link(fromId: string, toId: string, relation: string, options?: MemoryOperationOptions): Promise<MemoryLink | null> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const from = this.get(fromId);
    const to = this.get(toId);

    if (!from) {
      logger.warn('MemoryStore: link source not found', { fromId });
      return null;
    }
    if (!to) {
      logger.warn('MemoryStore: link target not found', { toId });
      return null;
    }

    const now = Date.now();

    try {
      this.runMutation(
        `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
        [fromId, toId, relation, now],
        operation,
      );
    } catch (err) {
      assertMemoryOperationCurrent(operation);
      logger.error('MemoryStore: link insert failed', {
        error: summarizeError(err),
      });
      return null;
    }

    await this.persistNow();
    return { fromId, toId, relation, createdAt: now };
  }

  /** Get all links where this record is either source or target. */
  linksFor(id: string, options?: MemoryOperationOptions): MemoryLink[] {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];

    const rows = this.sqlite.exec(
      `SELECT from_id, to_id, relation, created_at
         FROM memory_links
         WHERE from_id = ? OR to_id = ?
         ORDER BY created_at DESC`,
      [id, id],
    );

    if (!rows.length) return [];

    return (rows[0]?.values ?? []).map(v => {
      const col = rows[0]?.columns ?? [];
      return {
        fromId:    String(v[col.indexOf('from_id')]),
        toId:      String(v[col.indexOf('to_id')]),
        relation:  String(v[col.indexOf('relation')]),
        createdAt: Number(v[col.indexOf('created_at')]),
      };
    });
  }

  /**
   * Update mutable fields of an existing record. For the temporal window,
   * `undefined` leaves the current bound unchanged while an explicit `null`
   * clears it (so the projection round-trip can both set and remove a window).
   */
  update(id: string, patch: {
    cls?: MemoryClass;
    scope?: MemoryScope;
    summary?: string;
    detail?: string;
    tags?: string[];
    validFrom?: number | null;
    validUntil?: number | null;
    /** Replacing unverified source content must not inherit the old review. */
    resetReview?: true;
  }, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;
    assertValidMemoryFields({ scope: patch.scope, cls: patch.cls, summary: patch.summary, detail: patch.detail, tags: patch.tags }, 'memory update');

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: update target not found', { id });
      return null;
    }

    const now = Date.now();
    const newClass = patch.cls ?? existing.cls;
    const newScope   = patch.scope   ?? existing.scope;
    const newSummary = patch.summary ?? existing.summary;
    const newDetail  = patch.detail  !== undefined ? patch.detail : existing.detail;
    const newTags    = patch.tags    ?? existing.tags;
    const newValidFrom  = patch.validFrom  === undefined ? existing.validFrom  : (patch.validFrom  ?? undefined);
    const newValidUntil = patch.validUntil === undefined ? existing.validUntil : (patch.validUntil ?? undefined);
    const resetReview = patch.resetReview === true;

    this.runMutation(
      `UPDATE memory_records
         SET cls = ?, scope = ?, summary = ?, detail = ?, tags = ?, valid_from = ?, valid_until = ?, updated_at = ?
         ${resetReview ? ", review_state = 'fresh', confidence = " + FRESH_MEMORY_CONFIDENCE + ', reviewed_at = NULL, reviewed_by = NULL, stale_reason = NULL' : ''}
         WHERE id = ?`,
      [newClass, newScope, newSummary, newDetail ?? null, JSON.stringify(newTags), newValidFrom ?? null, newValidUntil ?? null, now, id],
      operation,
    );

    const updated: MemoryRecord = { ...existing, cls: newClass, scope: newScope, summary: newSummary, detail: newDetail, tags: newTags, validFrom: newValidFrom, validUntil: newValidUntil, updatedAt: now,
      ...(resetReview ? { reviewState: 'fresh', confidence: FRESH_MEMORY_CONFIDENCE, reviewedAt: undefined, reviewedBy: undefined, staleReason: undefined } : {}) };
    this.indexRow(updated);
    this.persist();
    logger.info('MemoryStore: record updated', { id });
    return updated;
  }

  review(id: string, patch: MemoryReviewPatch, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: review target not found', { id });
      return null;
    }

    const now = Date.now();
    const reviewState = patch.state ?? existing.reviewState;
    const confidence = clampConfidence(patch.confidence ?? existing.confidence);
    // A record back in `fresh` is unreviewed, the same as after a content edit
    // (see update()), so it carries no reviewer stamp.
    const unreviewed = reviewState === 'fresh';
    const reviewedAt = unreviewed ? undefined : now;
    const reviewedBy = unreviewed ? undefined : patch.reviewedBy ?? existing.reviewedBy;
    const staleReason = reviewState === 'stale' || reviewState === 'contradicted'
      ? (patch.staleReason ?? existing.staleReason ?? `marked ${reviewState} by ${reviewedBy ?? 'operator'}`)
      : undefined;

    this.runMutation(
      `UPDATE memory_records
         SET review_state = ?, confidence = ?, reviewed_at = ?, reviewed_by = ?, stale_reason = ?, updated_at = ?
         WHERE id = ?`,
      [
        reviewState,
        confidence,
        reviewedAt ?? null,
        reviewedBy ?? null,
        staleReason ?? null,
        now,
        id,
      ],
      operation,
    );

    const reviewed = { ...existing, reviewState, confidence, reviewedAt, reviewedBy, staleReason, updatedAt: now };
    this.indexRow(reviewed);
    this.persist();
    logger.info('MemoryStore: record reviewed', { id, reviewState, confidence });
    return reviewed;
  }

  /** Delete a record and all its links. */
  delete(id: string, options?: MemoryOperationOptions): boolean {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return false;

    const existing = this.get(id);
    if (!existing) return false;

    // Delete links explicitly as well as via FK cascade; sql.js may load older
    // stores with FK enforcement disabled for a connection.
    this.runMutation('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', [id, id], operation);
    this.runMutation('DELETE FROM memory_records WHERE id = ?', [id], operation);
    this.indexCommitted(() => this.vectorIndex?.delete(id));
    this.persist();
    logger.info('MemoryStore: record deleted', { id });
    return true;
  }

  // ── Usage counters, store meta, consolidation proposals ──────────────────────
  //
  // None of these is a record field another write computes from, so they are
  // written straight to the image (a usage count landing mid-way must never
  // make a memory write refuse), and saved in
  // the background like update/review/delete.

  /**
   * Count one turn's use of memories in one step: every id in `injected` was in
   * the prompt, every id in `assessed` had its use read, every id in
   * `referenced` was read as used. Unknown ids are ignored; a deleted record
   * takes its counts with it.
   */
  async recordUsage(change: MemoryUsageChange, at: number = Date.now()): Promise<void> {
    if (!this.ready) return;
    const apply = (ids: readonly string[] | undefined, assignments: string, params: (string | number)[]): boolean => {
      const unique = [...new Set((ids ?? []).filter((id) => id.trim()))];
      if (unique.length === 0) return false;
      this.sqlite.run(`UPDATE memory_records SET ${assignments} WHERE id IN (${unique.map(() => '?').join(', ')})`, [...params, ...unique]);
      return true;
    };
    const injected = apply(change.injected, 'injected_count = injected_count + 1, last_injected_at = ?', [at]);
    const assessed = apply(change.assessed, 'assessed_count = assessed_count + 1', []);
    const referenced = apply(change.referenced, 'referenced_count = referenced_count + 1, last_referenced_at = ?', [at]);
    if (injected || assessed || referenced) this.persist();
  }

  /** One record's usage counters, or null when there is no such record. */
  usage(id: string): MemoryUsageEntry | null {
    if (!this.ready) return null;
    const row = this.sqlite.exec(
      'SELECT injected_count, assessed_count, referenced_count, last_injected_at, last_referenced_at FROM memory_records WHERE id = ? LIMIT 1',
      [id],
    )[0]?.values[0];
    return row ? usageFromRow(row) : null;
  }

  /** Every record that was ever injected, with its counters. */
  usageEntries(): MemoryUsageTopEntry[] {
    if (!this.ready) return [];
    const rows = this.sqlite.exec(
      'SELECT injected_count, assessed_count, referenced_count, last_injected_at, last_referenced_at, id FROM memory_records WHERE injected_count > 0',
    )[0]?.values ?? [];
    return rows.map((row) => ({ id: String(row[5]), ...usageFromRow(row) }));
  }

  /** A store-owned fact by key (the consolidation cursor), or null. */
  readMeta(key: string): string | null {
    if (!this.ready) return null;
    const value = this.sqlite.exec('SELECT value FROM memory_meta WHERE key = ? LIMIT 1', [key])[0]?.values[0]?.[0];
    return typeof value === 'string' ? value : null;
  }

  writeMeta(key: string, value: string): void {
    if (!this.ready) return;
    this.sqlite.run('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)', [key, value]);
    this.persist();
  }

  /**
   * Keep consolidation proposals, one row per kind and set of record ids.
   * Returns the proposals that were not already standing, so a pass reports a
   * proposal once however many passes find it again.
   */
  addConsolidationProposals(proposals: readonly MemoryConsolidationProposal[], at: number = Date.now()): MemoryConsolidationProposal[] {
    if (!this.ready || proposals.length === 0) return [];
    const added: MemoryConsolidationProposal[] = [];
    for (const proposal of proposals) {
      const key = consolidationProposalKey(proposal);
      if ((this.sqlite.exec('SELECT 1 FROM memory_proposals WHERE key = ? LIMIT 1', [key])[0]?.values.length ?? 0) > 0) continue;
      this.sqlite.run(
        'INSERT INTO memory_proposals (key, kind, ids, route, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [key, proposal.kind, JSON.stringify(proposal.ids), proposal.route, proposal.reason, at],
      );
      added.push(proposal);
    }
    if (added.length > 0) this.persist();
    return added;
  }

  /**
   * The standing consolidation proposals, oldest first. A proposal whose
   * records are gone, or that no longer holds (a stale-delete whose record is
   * no longer stale, a contradiction one of whose records a person marked
   * stale, a cross-scope duplicate one of whose records is no longer active),
   * is dropped here, so the list only shows what still needs a person.
   */
  listConsolidationProposals(): MemoryConsolidationProposal[] {
    if (!this.ready) return [];
    const rows = this.sqlite.exec('SELECT key, kind, ids, route, reason FROM memory_proposals ORDER BY created_at, key')[0]?.values ?? [];
    const standing: MemoryConsolidationProposal[] = [];
    const settled: string[] = [];
    for (const [key, kind, rawIds, route, reason] of rows) {
      let ids: string[];
      try { ids = (JSON.parse(String(rawIds)) as unknown[]).map(String); } catch { settled.push(String(key)); continue; }
      const records = ids.map((id) => this.get(id));
      const holds = records.every((record) => record !== null) && (
        kind === 'stale-delete' ? records[0]?.reviewState === 'stale'
          : kind === 'contradiction' ? records.every((record) => record?.reviewState !== 'stale')
            : records.every((record) => record?.reviewState === 'fresh' || record?.reviewState === 'reviewed'));
      if (!holds) { settled.push(String(key)); continue; }
      standing.push({ kind: kind as MemoryConsolidationProposal['kind'], ids, route: String(route), reason: String(reason) });
    }
    if (settled.length > 0) {
      for (const key of settled) this.sqlite.run('DELETE FROM memory_proposals WHERE key = ?', [key]);
      this.persist();
    }
    return standing;
  }

  /** Bring the vector index in step with the rows now (a provider that only embeds over the network continues in the background). */
  rebuildVectorIndex(): MemoryVectorStats {
    if (!this.ready) return this.vectorStats();
    this.vectorIndex?.sync(this.vectorEntries());
    return this.vectorStats();
  }

  /**
   * Embed the rows through the asynchronous embed: every row when `force` is
   * set (the default, an explicit rebuild), else only rows the index does not
   * hold at their revision. Calls made while a pass runs share it and start
   * one more pass after it, so rows loaded meanwhile are covered.
   */
  async rebuildVectorIndexAsync(options: { readonly force?: boolean } = {}): Promise<MemoryVectorStats> {
    if (!this.ready) return this.vectorStats();
    const force = options.force ?? true;
    if (this.rebuildVectorIndexPromise) {
      this.rebuildVectorIndexAgain = (this.rebuildVectorIndexAgain ?? false) || force;
      return this.rebuildVectorIndexPromise;
    }
    const pass = (async () => {
      try {
        await this.vectorIndex?.syncAsync(this.vectorEntries(), { force });
        return this.vectorStats();
      } finally {
        this.rebuildVectorIndexPromise = null;
        const again = this.rebuildVectorIndexAgain;
        this.rebuildVectorIndexAgain = null;
        if (again !== null && this.ready) this.syncVectorIndexInBackground(again);
      }
    })();
    this.rebuildVectorIndexPromise = pass;
    return pass;
  }

  /** Start-up and reload: index the rows the index does not hold yet, off the caller's path. */
  private syncVectorIndexInBackground(force = false): void {
    if (!this.vectorIndex) return;
    void this.rebuildVectorIndexAsync({ force }).catch((error: unknown) => {
      logger.warn('MemoryStore: the vector index could not be brought up to date', { error: summarizeError(error) });
    });
  }

  /** Every row with the revision its trigger stamped, in one query. */
  private vectorEntries(): MemoryVectorEntry[] {
    const result = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until, gv_revision
         FROM memory_records
         ORDER BY updated_at DESC, created_at DESC`,
    )[0];
    if (!result) return [];
    const revisionAt = result.columns.indexOf('gv_revision');
    return result.values.map((values) => ({ record: rowToRecord(result.columns, values), revision: String(values[revisionAt] ?? '') }));
  }

  vectorStats(options?: MemoryOperationOptions): MemoryVectorStats {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return this.vectorIndex?.stats() ?? {
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: HASHED_MEMORY_EMBEDDING_PROVIDER.id,
      embeddingProviderLabel: HASHED_MEMORY_EMBEDDING_PROVIDER.label,
      embeddingSpace: '',
      awaitingReembed: 0,
      error: 'memory vector index disabled',
    };
  }

  async doctor(options?: MemoryOperationOptions): Promise<MemoryDoctorReport> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return {
      vector: this.vectorStats(),
      embeddings: await awaitMemoryOperation(() => this.embeddingRegistry.doctor(), operation),
      checkedAt: Date.now(),
    };
  }

  async save(options?: MemoryOperationOptions): Promise<boolean> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return awaitMemoryOperation(() => this.saveImage(), operation);
  }

  /**
   * How many times this store has seen another process commit to the memory
   * file (the daemon beside a terminal, the memory CLI). Reads already see
   * those rows, since every read is a statement on the shared file; the count
   * is for panels that show a listing and need to know when to read it again.
   */
  get externalRevision(): number { return this.foreignCommits; }

  /**
   * Notices another process's commits since the last look (one PRAGMA) and
   * brings the vector index up to the rows. Nothing is reloaded: the SQLite
   * file is shared, and a write by either process lands on the current rows.
   */
  reloadIfChanged(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    const version = this.sqlite.dataVersion();
    if (version === this.seenDataVersion) return Promise.resolve();
    this.seenDataVersion = version;
    this.foreignCommits += 1;
    this.syncVectorIndexInBackground();
    return Promise.resolve();
  }

  close(): void {
    this.backendEpoch++;
    this.sqlite.close();
    this.vectorIndex?.close();
    this.ready = false;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private openBackend(dbPath: string | undefined): SQLiteStore {
    return new SQLiteStore(dbPath);
  }

  private initBackend(sqlite: SQLiteStore): Promise<void> {
    return sqlite.init(createSchema as Parameters<SQLiteStore['init']>[0], {
      storeName: 'memory store', schemaVersion: MEMORY_SCHEMA_VERSION,
      validateCurrentSchema: validateMemoryRowRevisions,
    });
  }

  /** Commit what this turn wrote to the shared file. */
  private saveImage(): Promise<boolean> {
    return this.sqlite.save();
  }

  /** The row's revision as its trigger stamped it, read on this connection: a committed write may not be saved to disk yet. */
  private rowRevision(id: string): string | undefined {
    const value = this.sqlite.exec('SELECT gv_revision FROM memory_records WHERE id = ? LIMIT 1', [id])[0]?.values[0]?.[0];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Keep the index in step with a committed row: the write hands the index
   * the row and the revision it just produced (one read), and nothing is
   * checked after. A refusal here is logged; the row stays stored.
   */
  private indexRow(record: MemoryRecord): void {
    this.indexCommitted(() => this.vectorIndex?.upsert(record, { revision: this.rowRevision(record.id) }));
  }

  /**
   * The commit point. The caller's lifecycle is checked before the statement
   * runs and nowhere after: once the row is in the image it is published, and
   * a check after it could only report a write that happened as failed.
   */
  private runMutation(sql: Parameters<SQLiteStore['run']>[0], params: Parameters<SQLiteStore['run']>[1], operation: MemoryOperationOptions, onPublished?: () => void): void {
    assertMemoryOperationCurrent(operation);
    if (!this.operations.has(operation)) throw new Error('Memory operation is not owned by this store');
    this.sqlite.run(sql, params);
    onPublished?.();
  }


  /**
   * Keep the index in step with a committed row. A refusal here (a later write
   * already replaced the row and indexes it itself, or the index cannot be
   * written) is logged; it never turns the committed write into a failure.
   */
  private indexCommitted(work: () => void): void {
    try {
      work();
    } catch (error) {
      logger.debug('MemoryStore: the index entry of a committed write was not written; the row is stored', { error: summarizeError(error) });
    }
  }

  /** Starts the image save; a synchronous refusal becomes a rejected promise. */
  private startSave(): Promise<boolean> {
    try {
      return this.saveImage();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Commit what this call wrote, for the synchronous writes (update, review,
   * delete) that cannot wait. Statements run in one turn share one SQLite
   * transaction, so a burst of writes is one commit and nothing is exported
   * or copied. A failed commit is logged and counted in `unsavedChanges`; the
   * write it carried is not on disk.
   */
  private persist(): void {
    const save = this.startSave().then(() => { this.unsavedChanges = 0; }, (err: unknown) => {
      this.unsavedChanges += 1;
      logger.warn('MemoryStore: autosave failed', { error: summarizeError(err), unsavedChanges: this.unsavedChanges });
      throw new Error(`MemoryStore: the change could not be saved to disk: ${summarizeError(err)}`, { cause: err });
    });
    // Held for saved(); a caller that answers a person awaits it, so the rejection is not left unheard.
    save.catch(() => {});
    this.lastSave = save;
  }

  /**
   * Resolves once the commit carrying this turn's synchronous writes (update,
   * review, delete) is on disk; rejects with why when it failed. A route that
   * answers "updated" or "deleted" awaits it first. Costs the caller the
   * commit that was already running, nothing more.
   */
  async saved(): Promise<void> {
    await this.lastSave;
  }

  /**
   * Save and wait, for the async writes (add, import, link): a save that did
   * not happen is reported to the caller instead of returning the record as
   * remembered. The caller's lifecycle is not consulted:
   * the write is published, so only the save's own outcome counts.
   */
  private async persistNow(): Promise<void> {
    try {
      await this.startSave();
      this.unsavedChanges = 0;
    } catch (err) {
      this.unsavedChanges += 1;
      throw new Error(`MemoryStore: the change could not be saved to disk: ${summarizeError(err)}`, { cause: err });
    }
  }

  /**
   * An add whose save failed is taken back out of the image, so the error the
   * caller gets means nothing was stored and a retry stores the record once.
   * Runs outside runMutation: it takes back a row, it is not a caller's write.
   */
  private withdrawUnsavedAdd(id: string): void {
    try {
      this.sqlite.run('DELETE FROM memory_records WHERE id = ?', [id]);
      this.vectorIndex?.delete(id);
    } catch (error) {
      logger.warn('MemoryStore: could not withdraw an add whose save failed', { id, error: summarizeError(error) });
    }
  }
}

function usageFromRow(row: readonly unknown[]): MemoryUsageEntry {
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    injectedCount: count(row[0]),
    assessedCount: count(row[1]),
    referencedCount: count(row[2]),
    lastInjectedAt: time(row[3]),
    lastReferencedAt: time(row[4]),
  };
}

/** One proposal per kind and set of records, whatever order a pass found them in. */
function consolidationProposalKey(proposal: Pick<MemoryConsolidationProposal, 'kind' | 'ids'>): string {
  return `${proposal.kind}:${[...proposal.ids].sort().join(',')}`;
}


