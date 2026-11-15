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
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { retainOwnedJson } from '../gate/judgment-input.js';
import { rankReviewQueue, rankSemanticSearch, rerankRetrieved } from './memory-search-ranking.js';
import { SQLiteStore } from './sqlite-store.js';
import {
  SqliteVecMemoryIndex,
  type MemoryVectorStats,
  resolveMemoryVectorDbPath,
  memoryVectorInput,
  type MemoryVectorSourceRevision,
} from './memory-vector-store.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingDoctorReport,
} from './memory-embeddings.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
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

/** Native publication proof; only the matching prepared add can validate it. */
export type MemoryAddPublication = object;

export interface MemoryPreparedAddCommitOptions extends MemoryOperationOptions {
  readonly onPublished?: ((publication: MemoryAddPublication) => void) | undefined;
}

export interface MemoryPreparedAdd {
  /** Exact canonical row getAll/get will expose after this add, allocated before effects. */
  readonly record: Readonly<Omit<MemoryRecord, 'tags' | 'provenance'>> & {
    readonly tags: readonly string[];
    readonly provenance: readonly Readonly<ProvenanceLink>[];
  };
  assertCurrent(): void;
  /** Valid only synchronously inside this plan's actual SQL publication callback. */
  assertPublication(publication: MemoryAddPublication): void;
  commit(options?: MemoryPreparedAddCommitOptions): Promise<MemoryRecord>;
}

const memoryOwnerMapGet = WeakMap.prototype.get;
const memoryOwnerMapHas = WeakMap.prototype.has;
const memoryOwnerMapSet = WeakMap.prototype.set;
const memoryOwnerMapApply = Reflect.apply;
function ownerMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return memoryOwnerMapApply(memoryOwnerMapGet, map, [key]);
}
function ownerMapHas<K extends object, V>(map: WeakMap<K, V>, key: K): boolean {
  return memoryOwnerMapApply(memoryOwnerMapHas, map, [key]);
}
function ownerMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  memoryOwnerMapApply(memoryOwnerMapSet, map, [key, value]);
}

const ownedMemoryStores = new WeakMap<MemoryStore, { readonly sqlite: SQLiteStore; readonly vector: SqliteVecMemoryIndex | null; readonly embeddings: MemoryEmbeddingProviderRegistry }>();

/** Internal retained data-method binding. Replacement accessors are never invoked. */
export function retainMemoryAddBinding(subject: object, keys: readonly PropertyKey[]): () => void {
  const holders: Array<{ subject: object; prototype: unknown; key: PropertyKey; descriptor: PropertyDescriptor | undefined }> = [];
  for (const key of keys) {
    let holder: object | null = subject;
    let depth = 0;
    while (holder) {
      if (nodeTypes.isProxy(holder) || ++depth > 64) throw new Error('Memory prepared add binding unavailable');
      const prototype: unknown = Object.getPrototypeOf(holder);
      const descriptor = Object.getOwnPropertyDescriptor(holder, key);
      if (descriptor && !('value' in descriptor)) throw new Error('Memory prepared add binding unavailable');
      holders.push({ subject: holder, prototype, key, descriptor });
      if (descriptor) break;
      if (prototype !== null && typeof prototype !== 'object') throw new Error('Memory prepared add binding unavailable');
      holder = prototype;
    }
  }
  return () => {
    for (const saved of holders) {
      const current = Object.getOwnPropertyDescriptor(saved.subject, saved.key), previous = saved.descriptor;
      if (Object.getPrototypeOf(saved.subject) !== saved.prototype || Boolean(current) !== Boolean(previous)
        || (current && previous && (!('value' in current) || !Object.is(current.value, previous.value)
          || current.enumerable !== previous.enumerable || current.configurable !== previous.configurable
          || current.writable !== previous.writable))) throw new Error('Memory prepared add binding changed');
    }
  };
}

const preparedOptionBindings = new WeakMap<MemoryPreparedAddCommitOptions, () => void>();

/** Restrictive option capture, including the native publication callback identity. */
export function captureMemoryPreparedAddOptions(options: MemoryPreparedAddCommitOptions = {}): MemoryPreparedAddCommitOptions {
  const binding = retainMemoryAddBinding(options, ['signal', 'assertCurrent', 'onPublished']);
  const lifecycle = captureMemoryOperation(options), onPublished = options.onPublished;
  if (onPublished !== undefined && typeof onPublished !== 'function') throw new Error('Memory publication callback unavailable');
  const captured: MemoryPreparedAddCommitOptions = Object.freeze({ signal: lifecycle.signal, onPublished, assertCurrent: () => {
    binding(); assertMemoryOperationCurrent(lifecycle); binding();
  } });
  ownerMapSet(preparedOptionBindings, captured, binding);
  return captured;
}

/** Identity/cancellation fence usable before the exact source callback adopts its native publication. */
export function assertMemoryPreparedAddOptionsBinding(options: MemoryPreparedAddCommitOptions): void {
  const current = ownerMapGet(preparedOptionBindings, options);
  if (!current) throw new Error('Memory prepared options are not captured');
  current(); options.signal?.throwIfAborted(); current();
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

/**
 * A write was refused because the memory file on disk is no longer the image
 * this process loaded: another process (the daemon, another surface, the
 * memory CLI) saved it since. Writing would put the old image back over that
 * process's records, so nothing was written. Retryable: the store reloads the
 * file, and the same call succeeds once it has.
 */
export class MemoryStoreChangedOnDiskError extends Error {
  readonly retryable = true;
  constructor(readonly path: string, phase: 'reloaded' | 'reloading' | 'save') {
    super(phase === 'save'
      ? `Memory file ${path} changed on disk after this change was made; it was not saved, so the other process's records are intact. This process reloads the file before its next write.`
      : `Memory file ${path} was changed by another process since this process loaded it; nothing was written. ${phase === 'reloaded' ? 'The store has reloaded the file' : 'The store is reloading the file'}; retry the operation.`);
    this.name = 'MemoryStoreChangedOnDiskError';
  }
}

/** Identity of the file as last loaded or saved here; any other process's save changes it. */
function memoryFileIdentity(path: string): string {
  try {
    const info = statSync(path, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

function isFileBackedPath(path: string | null): path is string {
  return Boolean(path) && path !== ':memory:' && !/^file:.*(?:^|[?&])mode=memory(?:&|$)/.test(path!);
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private sqlite: SQLiteStore;
  private vectorIndex: SqliteVecMemoryIndex | null;
  private ready = false;
  private rebuildVectorIndexPromise: Promise<MemoryVectorStats> | null = null;
  private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry;
  private mutationRevision = 0;
  private backendEpoch = 0;
  private readonly operations = new WeakMap<MemoryOperationOptions, { revision: number }>();
  /** File identity as this process last loaded or saved it; undefined while loading or for an in-memory store. */
  private diskIdentity: string | undefined;
  private saveAdmitted = false;
  private reloading: Promise<void> | null = null;
  /** Writes applied to the image whose save failed and has not been followed by a successful one. */
  private unsavedChanges = 0;

  constructor(dbPath: string | undefined, options: MemoryStoreOptions) {
    this.sqlite = this.openBackend(dbPath);
    this.embeddingRegistry = options.embeddingRegistry;
    this.vectorIndex = options.enableVectorIndex === false
      ? null
      : new SqliteVecMemoryIndex(
          options.vectorDbPath ?? resolveMemoryVectorDbPath(dbPath),
          undefined,
          this.embeddingRegistry,
          record => this.captureVectorSourceRevision(record),
        );
    ownerMapSet(ownedMemoryStores, this, { sqlite: this.sqlite, vector: this.vectorIndex, embeddings: this.embeddingRegistry });
  }

  async init(): Promise<void> {
    if (this.ready) return;
    this.backendEpoch++;
    this.diskIdentity = undefined;
    await this.initBackend(this.sqlite);
    this.diskIdentity = this.currentDiskIdentity(this.sqlite);
    this.ready = true;
    await this.vectorIndex?.init();
    this.rebuildVectorIndex();
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
   * A write binds to the mutation revision: any other write in between makes
   * it refuse. A read binds only to the backend incarnation, so a search that
   * awaits ranking still answers when an unrelated write lands meanwhile.
   */
  private captureOperation(options?: MemoryOperationOptions, mode: 'write' | 'read' = 'write'): MemoryOperationOptions {
    if (options && this.operations.has(options)) return options;
    const lifecycle = captureMemoryOperation(options), scope = this.captureOperationScope();
    const state = { revision: this.mutationRevision };
    const operation = captureMemoryOperation({ signal: lifecycle.signal, assertCurrent: () => {
      assertMemoryOperationCurrent(lifecycle); scope();
      if (mode === 'write' && this.mutationRevision !== state.revision) throw new Error('Memory operation source changed');
    } });
    this.operations.set(operation, state);
    return operation;
  }

  /** Add a new memory record. Returns the created record. */
  async add(opts: MemoryAddOptions, options?: MemoryOperationOptions): Promise<MemoryRecord> {
    // Checked without yielding, so an unchanged file keeps the write synchronous.
    if (this.imageIsStale()) await this.refuseStaleImage();
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) throw new Error('MemoryStore: not initialized');
    assertValidMemoryFields(opts);

    const now = Date.now();
    const id = `mem_${now.toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const record: MemoryRecord = {
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
      createdAt: now,
      updatedAt: now,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
    };

    this.runMutation(
      `INSERT INTO memory_records
         (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.scope,
        record.cls,
        record.summary,
        record.detail ?? null,
        JSON.stringify(record.tags),
        JSON.stringify(record.provenance),
        record.reviewState,
        record.confidence,
        record.reviewedAt ?? null,
        record.reviewedBy ?? null,
        record.staleReason ?? null,
        record.createdAt,
        record.updatedAt,
        record.validFrom ?? null,
        record.validUntil ?? null,
      ],
      operation,
    );

    this.vectorIndex?.upsert(record, operation);
    await this.persistNow(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: record added', { id, cls: opts.cls });
    return record;
  }

  /** Prepare a fixed native add. Preparation itself writes nothing and grants no permission. */
  prepareAdd(opts: MemoryAddOptions, options: MemoryOperationOptions = {}): MemoryPreparedAdd {
    if (!ownerMapHas(ownedMemoryStores, this)) throw new Error('Memory prepared add owner unavailable');
    const binding = retainMemoryAddBinding(this, ['prepareAdd', 'captureOperationScope', 'captureOperation',
      'runMutation', 'createAddRecord', 'addRecordParameters', 'insertAddRecord', 'get', 'retrieve', 'save', 'sqlite', 'vectorIndex', 'embeddingRegistry', 'ready', 'backendEpoch']);
    assertNativeMemoryAddMethods(this);
    const owner = ownerMapGet(ownedMemoryStores, this);
    if (!owner || owner.sqlite !== this.sqlite || owner.vector !== this.vectorIndex || owner.embeddings !== this.embeddingRegistry) {
      throw new Error('Memory prepared add native backend unavailable');
    }
    const providerBinding = retainMemoryAddBinding(this.embeddingRegistry, ['getDefaultProviderOrNull']);
    const sqliteBinding = retainMemoryAddBinding(this.sqlite, ['run', 'exec', 'save', 'close']);
    const vectorBinding = this.vectorIndex ? retainMemoryAddBinding(this.vectorIndex, ['upsert']) : () => {};
    const lifecycle = captureMemoryPreparedAddOptions(options), input = retainOwnedJson(opts, nodeTypes.isProxy);
    const assertBindings = () => { binding(); providerBinding(); sqliteBinding(); vectorBinding(); };
    assertBindings();
    const scope = this.captureOperationScope();
    assertBindings();
    let expectedRevision = this.mutationRevision, consumed = false, publishing = false;
    let publication: MemoryAddPublication | undefined;
    let commitLifecycle: MemoryPreparedAddCommitOptions | undefined;
    const assertCurrent = () => {
      assertBindings(); assertMemoryOperationCurrent(lifecycle); assertBindings();
      input.assertCurrent(); assertBindings(); scope(); assertBindings();
      if (this.mutationRevision !== expectedRevision) throw new Error('Memory prepared add source changed');
      if (commitLifecycle) { assertMemoryOperationCurrent(commitLifecycle); assertBindings(); }
      input.assertCurrent(); assertBindings(); scope(); assertBindings();
      if (this.mutationRevision !== expectedRevision) throw new Error('Memory prepared add source changed');
    };
    assertCurrent();
    if (!this.ready) throw new Error('MemoryStore: not initialized');
    const authored = this.createAddRecord(opts);
    const canonical = rowToRecord(
      ['id', 'scope', 'cls', 'summary', 'detail', 'tags', 'provenance', 'review_state', 'confidence',
        'reviewed_at', 'reviewed_by', 'stale_reason', 'created_at', 'updated_at', 'valid_from', 'valid_until'],
      this.addRecordParameters(authored),
    );
    const record = Object.freeze({ ...canonical,
      tags: Object.freeze([...canonical.tags]),
      provenance: Object.freeze(canonical.provenance.map(link => Object.freeze({ ...link }))),
    });
    freezeNewMemoryData(record);
    // Internal writer/vector input is detached too; callers only receive the immutable plan row.
    const written: MemoryRecord = { ...authored, tags: [...canonical.tags],
      provenance: canonical.provenance.map(link => ({ ...link })) };
    const expectedRow = JSON.stringify(canonical);
    assertCurrent();
    const store = this;
    const prepared: MemoryPreparedAdd = Object.freeze({
      record,
      assertCurrent,
      assertPublication(receipt: MemoryAddPublication) {
        if (this !== prepared || !publishing || receipt !== publication) throw new Error('Memory publication is not owned by this plan');
        assertBindings(); scope(); assertBindings(); assertMemoryOperationCurrent(lifecycle); assertBindings();
        input.assertCurrent();
        if (commitLifecycle) assertMemoryPreparedAddOptionsBinding(commitLifecycle);
        assertBindings();
        if (store.mutationRevision !== expectedRevision || JSON.stringify(store.get(written.id)) !== expectedRow) {
          throw new Error('Memory prepared publication changed');
        }
        assertBindings();
      },
      async commit(commitOptions: MemoryPreparedAddCommitOptions = {}): Promise<MemoryRecord> {
        if (this !== prepared || consumed) throw new Error('Memory prepared add is not available');
        consumed = true;
        commitLifecycle = captureMemoryPreparedAddOptions(commitOptions);
        assertCurrent();
        const signals = [lifecycle.signal, commitLifecycle.signal].filter((signal): signal is AbortSignal => signal !== undefined);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        const operation = store.captureOperation({ signal, assertCurrent });
        store.insertAddRecord(written, operation, () => {
          expectedRevision = store.mutationRevision;
          assertBindings(); scope(); assertBindings(); assertMemoryOperationCurrent(lifecycle); assertBindings();
          input.assertCurrent();
          if (commitLifecycle) assertMemoryPreparedAddOptionsBinding(commitLifecycle);
          assertBindings();
          if (JSON.stringify(store.get(written.id)) !== expectedRow) throw new Error('Memory prepared publication changed');
          assertBindings();
          publication = Object.freeze({}); publishing = true;
          try {
            const outcome: unknown = commitLifecycle?.onPublished?.(publication);
            if (outcome !== undefined) {
              if (outcome instanceof Promise) void outcome.catch(() => {});
              throw new TypeError('Memory publication callbacks must be synchronous');
            }
          } finally { publishing = false; }
        });
        store.vectorIndex?.upsert(written, operation);
        // The row is published. Only the caller's lifecycle can still retire
        // the result; an unrelated write landing during the save cannot, or
        // the caller would retry a row that already exists into a duplicate.
        const published = store.captureOperation({ signal, assertCurrent: () => {
          assertBindings(); scope(); assertBindings(); assertMemoryOperationCurrent(lifecycle);
          if (commitLifecycle) assertMemoryOperationCurrent(commitLifecycle);
          assertBindings();
        } }, 'read');
        await store.save(published);
        assertMemoryOperationCurrent(published);
        logger.info('MemoryStore: prepared record added', { id: written.id, cls: written.cls });
        return { ...canonical, tags: [...canonical.tags], provenance: canonical.provenance.map(link => ({ ...link })) };
      },
    });
    return prepared;
  }

  /** Retrieve a single record by ID. */
  get(id: string, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options, 'read');
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
    const operation = this.captureOperation(options, 'read');
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
    const operation = this.captureOperation(options, 'read');
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
   * nothing. `score` is the similarity on a 0 to 100 scale.
   */
  semanticCandidates(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemorySemanticSearchResult[] {
    const operation = this.captureOperation(options, 'read');
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
    for (const candidate of this.vectorIndex?.search(query, vectorFilter, operation) ?? []) {
      const record = this.get(candidate.id, operation);
      if (!record) continue;
      if (!recordMatchesPostSqlFilter(record, filter)) continue;
      results.push({ record, distance: candidate.distance, similarity: candidate.similarity, score: candidate.similarity * 100 });
    }
    return results.sort((a, b) => a.distance - b.distance || b.record.updatedAt - a.record.updatedAt);
  }

  /** Semantic search: the vector index builds the shortlist, the rerank orders it (memory-search-ranking.ts). */
  async searchSemantic(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
    const operation = this.captureOperation(options, 'read');
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    return awaitMemoryOperation(() => rankSemanticSearch(this, filter, operation), operation);
  }

  /** Records to review: the least trusted records, ordered by the memory-review-priority reading. */
  async reviewQueue(limit = 10, scope?: MemoryScope, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    const operation = this.captureOperation(options, 'read');
    assertMemoryOperationCurrent(operation);
    const leastTrustedFirst = this.retrieve(scope ? { scope } : {}, operation).reverse();
    return awaitMemoryOperation(() => rankReviewQueue(leastTrustedFirst.slice(0, Math.max(limit * 4, 25)), limit, operation), operation);
  }

  /** Exports the records the filter selects; a query here filters, it does not rank. */
  exportBundle(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryBundle {
    const operation = this.captureOperation(options, 'read');
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
    // Checked without yielding, so an unchanged file keeps the write synchronous.
    if (this.imageIsStale()) await this.refuseStaleImage();
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
        if (stored) this.vectorIndex?.upsert(stored, operation);
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

    await this.persistNow(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: bundle imported', { importedRecords, skippedRecords, importedLinks });
    return { importedRecords, skippedRecords, importedLinks };
  }

  /** Create a directed link between two records. */
  async link(fromId: string, toId: string, relation: string, options?: MemoryOperationOptions): Promise<MemoryLink | null> {
    // Checked without yielding, so an unchanged file keeps the write synchronous.
    if (this.imageIsStale()) await this.refuseStaleImage();
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

    await this.persistNow(operation);
    return { fromId, toId, relation, createdAt: now };
  }

  /** Get all links where this record is either source or target. */
  linksFor(id: string, options?: MemoryOperationOptions): MemoryLink[] {
    const operation = this.captureOperation(options, 'read');
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
    this.vectorIndex?.upsert(updated, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
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
    this.vectorIndex?.upsert(reviewed, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
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
    this.vectorIndex?.delete(id, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: record deleted', { id });
    return true;
  }

  rebuildVectorIndex(): MemoryVectorStats {
    if (!this.ready) return this.vectorStats();
    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
         FROM memory_records
         ORDER BY updated_at DESC, created_at DESC`,
    );
    const records = rows.length ? (rows[0]?.values ?? []).map((value) => rowToRecord(rows[0]?.columns ?? [], value)) : [];
    this.vectorIndex?.sync(records);
    return this.vectorStats();
  }

  async rebuildVectorIndexAsync(): Promise<MemoryVectorStats> {
    if (!this.ready) return this.vectorStats();
    if (!this.rebuildVectorIndexPromise) {
      this.rebuildVectorIndexPromise = (async () => {
        try {
          const rows = this.sqlite.exec(
            `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
               FROM memory_records
               ORDER BY updated_at DESC, created_at DESC`,
          );
          const records = rows.length ? (rows[0]?.values ?? []).map((value) => rowToRecord(rows[0]?.columns ?? [], value)) : [];
          if (this.vectorIndex?.syncAsync) {
            await this.vectorIndex.syncAsync(records, { force: true });
          } else {
            this.vectorIndex?.sync(records);
          }
          return this.vectorStats();
        } finally {
          this.rebuildVectorIndexPromise = null;
        }
      })();
    }
    return this.rebuildVectorIndexPromise;
  }

  vectorStats(options?: MemoryOperationOptions): MemoryVectorStats {
    const operation = this.captureOperation(options, 'read');
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
      error: 'memory vector index disabled',
    };
  }

  async doctor(options?: MemoryOperationOptions): Promise<MemoryDoctorReport> {
    const operation = this.captureOperation(options, 'read');
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
   * Reload the file when another process saved it since this process loaded
   * it, so later reads see that process's records and later writes do not
   * erase them. The current image keeps serving reads until the new one is
   * loaded; writes are refused meanwhile. A no-op when the file is unchanged.
   */
  reloadIfChanged(): Promise<void> {
    if (this.reloading) return this.reloading;
    const sqlite = this.sqlite, path = sqlite.databasePath;
    if (!this.ready || this.diskIdentity === undefined || !isFileBackedPath(path)
      || this.currentDiskIdentity(sqlite) === this.diskIdentity) return Promise.resolve();
    const epoch = this.backendEpoch;
    const reload = (async () => {
      const next = this.openBackend(path);
      try {
        await this.initBackend(next);
      } catch (error) {
        next.close();
        throw error;
      }
      // A close or re-root while loading owns the store now; drop this image.
      if (this.sqlite !== sqlite || this.backendEpoch !== epoch || !this.ready) {
        next.close();
        return;
      }
      if (this.unsavedChanges > 0) {
        logger.warn('MemoryStore: reloading the changed memory file drops changes that were never saved', { path, unsavedChanges: this.unsavedChanges });
        this.unsavedChanges = 0;
      }
      this.backendEpoch++;
      this.sqlite = next;
      this.diskIdentity = this.currentDiskIdentity(next);
      ownerMapSet(ownedMemoryStores, this, { sqlite: this.sqlite, vector: this.vectorIndex, embeddings: this.embeddingRegistry });
      sqlite.close();
      this.rebuildVectorIndex();
      logger.info('MemoryStore: reloaded the memory file after another process saved it', { path });
    })().finally(() => { this.reloading = null; });
    this.reloading = reload;
    return reload;
  }

  close(): void {
    this.backendEpoch++;
    this.diskIdentity = undefined;
    this.sqlite.close();
    this.vectorIndex?.close();
    this.ready = false;
  }

  /**
   * Re-root the store to a new SQLite database path.
   *
   * Closes the existing SQLite handle and vector index, then re-opens both at
   * the new path. The caller is responsible for ensuring no writes are in-flight
   * when this is called (WorkspaceSwapManager enforces this via the busy-session
   * guard).
   *
   * @throws if the new SQLite store or vector index cannot be opened.
   */
  async reroot(newDbPath: string): Promise<void> {
    this.backendEpoch++;
    this.sqlite.close();
    this.vectorIndex?.close();
    this.ready = false;
    this.rebuildVectorIndexPromise = null;
    this.diskIdentity = undefined;
    this.sqlite = this.openBackend(newDbPath);
    this.vectorIndex = new SqliteVecMemoryIndex(
      resolveMemoryVectorDbPath(newDbPath),
      undefined,
      this.embeddingRegistry,
      record => this.captureVectorSourceRevision(record),
    );
    ownerMapSet(ownedMemoryStores, this, { sqlite: this.sqlite, vector: this.vectorIndex, embeddings: this.embeddingRegistry });
    await this.init();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private openBackend(dbPath: string | undefined): SQLiteStore {
    const store: SQLiteStore = new SQLiteStore(dbPath, { beforePersist: () => this.admitSave(store) });
    return store;
  }

  private initBackend(sqlite: SQLiteStore): Promise<void> {
    return sqlite.init(createSchema as Parameters<SQLiteStore['init']>[0], {
      storeName: 'memory store', schemaVersion: MEMORY_SCHEMA_VERSION,
      validateCurrentSchema: validateMemoryRowRevisions,
    });
  }

  private currentDiskIdentity(sqlite: SQLiteStore): string | undefined {
    const path = sqlite.databasePath;
    return isFileBackedPath(path) ? memoryFileIdentity(path) : undefined;
  }

  /** Whether the file on disk is no longer the image this process holds. */
  private imageIsStale(): boolean {
    if (this.diskIdentity === undefined) return false;
    return this.reloading !== null || this.currentDiskIdentity(this.sqlite) !== this.diskIdentity;
  }

  /** Called synchronously by SQLiteStore right before it writes the file. */
  private admitSave(sqlite: SQLiteStore): void {
    // Saves made while loading (a schema stamp) and saves of a retired image
    // are not this store's current image; they need no identity check.
    if (sqlite !== this.sqlite || this.diskIdentity === undefined) return;
    if (this.currentDiskIdentity(sqlite) !== this.diskIdentity) {
      throw new MemoryStoreChangedOnDiskError(sqlite.databasePath ?? '', 'save');
    }
    this.saveAdmitted = true;
  }

  /** Save the image and adopt the identity of the file this process just wrote. */
  private saveImage(): Promise<boolean> {
    const sqlite = this.sqlite;
    this.saveAdmitted = false;
    // A non-coordinated SQLiteStore writes synchronously inside save(), so
    // the file stat right after is this process's own write.
    const pending = sqlite.save();
    if (this.saveAdmitted && sqlite === this.sqlite) this.diskIdentity = this.currentDiskIdentity(sqlite);
    this.saveAdmitted = false;
    return pending;
  }

  /** Async writes: when the image is stale, finish reloading first, then refuse so the caller retries on the fresh image. */
  private async refuseStaleImage(): Promise<void> {
    if (!this.imageIsStale()) return;
    const path = this.sqlite.databasePath ?? '';
    try {
      await this.reloadIfChanged();
    } catch (error) {
      logger.warn('MemoryStore: reloading the changed memory file failed', { path, error: summarizeError(error) });
      throw new MemoryStoreChangedOnDiskError(path, 'reloading');
    }
    throw new MemoryStoreChangedOnDiskError(path, 'reloaded');
  }

  /** Synchronous writes cannot wait for the reload: start it and refuse. */
  private refuseStaleImageSync(): void {
    if (!this.imageIsStale()) return;
    const path = this.sqlite.databasePath ?? '';
    void this.reloadIfChanged().catch((error: unknown) => {
      logger.warn('MemoryStore: reloading the changed memory file failed', { path, error: summarizeError(error) });
    });
    throw new MemoryStoreChangedOnDiskError(path, 'reloading');
  }

  private captureVectorSourceRevision(record: MemoryRecord): MemoryVectorSourceRevision {
    const sqlite = this.sqlite, epoch = this.backendEpoch;
    // Read this connection: a mutation can have committed locally before the
    // autosave publishes its image to disk. A disk read would bind the old row.
    const selected = sqlite.exec('SELECT * FROM memory_records WHERE id = ? LIMIT 1', [record.id])[0];
    const values = selected?.values[0];
    if (!selected || !values || !isDeepStrictEqual(memoryVectorInput(record), memoryVectorInput(rowToRecord(selected.columns, values)))) {
      throw new Error('Memory vector record source changed');
    }
    const revision = values[selected.columns.indexOf('gv_revision')];
    if (typeof revision !== 'string' || !/^[0-9a-f]{32}$/.test(revision)) {
      throw new Error('Memory vector record revision unavailable');
    }
    return {
      revision,
      assertCurrent: () => {
        if (!this.ready || this.sqlite !== sqlite || this.backendEpoch !== epoch
          || sqlite.exec('SELECT gv_revision FROM memory_records WHERE id = ? LIMIT 1', [record.id])[0]?.values[0]?.[0] !== revision) {
          throw new Error('Memory vector record source changed');
        }
      },
    };
  }

  private createAddRecord(opts: MemoryAddOptions): MemoryRecord {
    assertValidMemoryFields(opts);
    const now = Date.now();
    const id = `mem_${now.toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const record: MemoryRecord = {
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
      createdAt: now,
      updatedAt: now,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
    };

    return record;
  }

  private addRecordParameters(record: MemoryRecord): Array<string | number | null> {
    return [record.id, record.scope, record.cls, record.summary, record.detail ?? null,
      JSON.stringify(record.tags), JSON.stringify(record.provenance), record.reviewState, record.confidence,
      record.reviewedAt ?? null, record.reviewedBy ?? null, record.staleReason ?? null,
      record.createdAt, record.updatedAt, record.validFrom ?? null, record.validUntil ?? null];
  }

  private insertAddRecord(record: MemoryRecord, operation: MemoryOperationOptions, onPublished?: () => void): void {
    this.runMutation(
      `INSERT INTO memory_records
         (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.addRecordParameters(record), operation, onPublished,
    );
  }

  private runMutation(sql: Parameters<SQLiteStore['run']>[0], params: Parameters<SQLiteStore['run']>[1], operation: MemoryOperationOptions, onPublished?: () => void): void {
    assertMemoryOperationCurrent(operation);
    this.refuseStaleImageSync();
    const state = this.operations.get(operation);
    if (!state) throw new Error('Memory operation is not owned by this store');
    const revision = ++this.mutationRevision;
    try {
      this.sqlite.run(sql, params);
      if (this.mutationRevision !== revision) throw new Error('Memory operation source changed');
      state.revision = revision;
      onPublished?.();
    }
    finally {
      if (this.mutationRevision !== revision) throw new Error('Memory operation source changed');
      state.revision = revision;
      assertMemoryOperationCurrent(operation);
    }
  }

  /**
   * Save in the background, for the synchronous writes (update, review,
   * delete) that cannot wait. A failed save is counted: the change is in this
   * process's image only, and the next successful save writes it, but a reload
   * of a changed file would drop it, which is logged when it happens.
   */
  private persist(operation: MemoryOperationOptions): void {
    assertMemoryOperationCurrent(operation);
    void this.save(operation).then(() => { this.unsavedChanges = 0; }, (err: unknown) => {
      try { assertMemoryOperationCurrent(operation); } catch { return; }
      this.unsavedChanges += 1;
      logger.warn('MemoryStore: autosave failed', { error: summarizeError(err), unsavedChanges: this.unsavedChanges });
    });
  }

  /**
   * Save and wait, for the async writes (add, import, link): a save that did
   * not happen is reported to the caller instead of returning the record as
   * remembered. A refusal because another process saved the file keeps its own
   * error, which already says to retry.
   */
  private async persistNow(operation: MemoryOperationOptions): Promise<void> {
    assertMemoryOperationCurrent(operation);
    try {
      await this.save(operation);
      this.unsavedChanges = 0;
    } catch (err) {
      assertMemoryOperationCurrent(operation);
      this.unsavedChanges += 1;
      if (err instanceof MemoryStoreChangedOnDiskError) throw err;
      throw new Error(`MemoryStore: the change was applied in memory but could not be saved to disk, so it may be lost when the store reloads: ${summarizeError(err)}`, { cause: err });
    }
  }
}

function freezeNewMemoryData(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeNewMemoryData(child);
  Object.freeze(value);
}

const nativePrepareAdd = MemoryStore.prototype.prepareAdd;
const nativeAddMethods = ['prepareAdd', 'captureOperationScope', 'captureOperation', 'runMutation',
  'createAddRecord', 'addRecordParameters', 'insertAddRecord', 'get', 'retrieve', 'save']
  .map(key => ({ key, value: Object.getOwnPropertyDescriptor(MemoryStore.prototype, key)?.value }));
function assertNativeMemoryAddMethods(store: MemoryStore): void {
  for (const original of nativeAddMethods) {
    let holder: object | null = store;
    while (holder) {
      const slot = Object.getOwnPropertyDescriptor(holder, original.key);
      if (slot) {
        if (!('value' in slot) || slot.value !== original.value) throw new Error('Memory prepared add native method changed');
        break;
      }
      holder = Object.getPrototypeOf(holder);
    }
    if (!holder) throw new Error('Memory prepared add native method unavailable');
  }
}
/** Internal native bridge. A copied/constructed store cannot issue a prepared add. */
export function prepareMemoryStoreAdd(store: MemoryStore, input: MemoryAddOptions, options?: MemoryOperationOptions): MemoryPreparedAdd {
  if (!ownerMapHas(ownedMemoryStores, store)) throw new Error('Memory prepared add owner unavailable');
  const current = retainMemoryAddBinding(store, ['prepareAdd']);
  if (store.prepareAdd !== nativePrepareAdd) throw new Error('Memory prepared add owner changed');
  current();
  const prepared = nativePrepareAdd.call(store, input, options);
  current();
  return prepared;
}
