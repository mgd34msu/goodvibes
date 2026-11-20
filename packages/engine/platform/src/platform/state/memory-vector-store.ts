import { assertMemoryOperationCurrent, awaitMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { createRequire } from 'node:module';
import type { MemoryClass, MemoryRecord, MemoryReviewState, MemoryScope } from './memory-store.js';
import {
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingResult,
  embedMemoryText,
  normalizeMemoryEmbeddingVector,
} from './memory-embeddings.js';
import { MEMORY_VECTOR_DIMS } from './embedding-dims.js';
import { loadSqliteVecExtension, SqliteVecPlatformUnsupportedError } from './sqlite-vec-loader.js';
import { openVersionedBunSqliteStore } from './store-versioning.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// Lifted to sqlite-vec-loader.ts (see CHANGELOG 0.38.0) so code-index-store.ts can load
// the exact same native extension the exact same way. Re-exported here so
// existing callers that import resolveSqliteVecPath from this module keep working.
export { resolveSqliteVecPath } from './sqlite-vec-loader.js';

// bun:sqlite is a Bun-only builtin; a static import makes this module unloadable
// under any non-Bun runtime (Node's ESM linker rejects the `bun:` scheme at link
// time, breaking the release install-smoke check and any Node import of the
// surfaces that transitively reach this module). Resolve the Database constructor
// lazily via require so the `bun:` specifier stays off the static import graph,
// it is only pulled on the Bun-only code path that opens a database. Real Bun
// behavior is unchanged.
let bunDatabaseCtor: typeof import('bun:sqlite').Database | null = null;
function bunSqliteDatabase(): typeof import('bun:sqlite').Database {
  return (bunDatabaseCtor ??= createRequire(import.meta.url)('bun:sqlite').Database);
}

export { MEMORY_VECTOR_DIMS };

/**
 * Target `PRAGMA user_version` for the memory vector index. Bump it whenever
 * the stored vector width (embedding-dims.ts) or the row layout changes: the
 * index is a derived cache, the migration drops it and it is rebuilt.
 */
export const MEMORY_VECTOR_SCHEMA_VERSION = 4;
export { embedMemoryText } from './memory-embeddings.js';

export interface MemoryVectorSearchFilter {
  scope?: MemoryScope | undefined;
  cls?: MemoryClass | undefined;
  since?: number | undefined;
  reviewState?: MemoryReviewState | MemoryReviewState[] | undefined;
  minConfidence?: number | undefined;
  staleOnly?: boolean | undefined;
  limit?: number | undefined;
}

export interface MemoryVectorCandidate {
  id: string;
  distance: number;
  similarity: number;
}

export interface MemoryVectorStats {
  backend: 'sqlite-vec';
  enabled: boolean;
  available: boolean;
  path: string;
  dimensions: number;
  indexedRecords: number;
  embeddingProviderId: string;
  embeddingProviderLabel: string;
  /** The space searches filter on now (`<provider>:<model>:<dimensions>`). */
  embeddingSpace: string;
  /**
   * Rows embedded in another space (an earlier provider or model): searches
   * leave them out until a rebuild re-embeds them, rather than scoring them
   * against a query from a different space.
   */
  awaitingReembed: number;
  error?: string | undefined;
  /**
   * Set when the vector index is unavailable because the RUNTIME PLATFORM
   * cannot load SQLite extensions (a permanent capability limit, e.g. a
   * macOS-compiled binary on Apple's system SQLite). Deliberately NOT the
   * `error` field: a capability limit is not a fault, and fault monitors
   * must not fire on it. Semantic search degrades to literal matching.
   */
  platformLimitReason?: string | undefined;
}

type VectorRow = {
  rowid: number;
  record_id: string;
  distance: number;
};

type CountRow = {
  count: number;
};

type RecordIdRow = {
  rowid: number;
};

export function resolveMemoryVectorDbPath(dbPath?: string): string {
  if (!dbPath || dbPath === ':memory:') return ':memory:';
  if (dbPath.endsWith('.sqlite')) return dbPath.slice(0, -'.sqlite'.length) + '.vec.sqlite';
  if (dbPath.endsWith('.db')) return dbPath.slice(0, -'.db'.length) + '.vec.db';
  return `${dbPath}.vec.sqlite`;
}

/**
 * A memory row as the store holds it, with the revision the store's trigger
 * stamped on that row (`gv_revision`). The index records the revision with the
 * vector, so an unchanged row is recognised by comparing two strings.
 */
export interface MemoryVectorEntry {
  readonly record: MemoryRecord;
  readonly revision: string;
}

/** A write's lifecycle, plus the revision of the row being indexed when the caller has it. */
export type MemoryVectorWriteOptions = MemoryOperationOptions & { readonly revision?: string | undefined };

export function buildMemoryEmbeddingText(record: MemoryRecord): string {
  return [
    record.cls,
    record.scope,
    record.summary,
    record.detail ?? '',
    record.tags.join(' '),
    record.provenance.map((entry) => `${entry.kind}:${entry.ref} ${entry.label ?? ''}`).join(' '),
  ].filter(Boolean).join('\n');
}

type StoredVectorRow = { record_id: string; source_revision: string; space_id: string };

/**
 * The memory store's vector index. A synchronous write has no `await` between
 * its entry and its last statement, so it checks the caller once at entry and
 * nothing after. An asynchronous write (an embedding provider that only embeds
 * over the network) checks once after the embed resolves, immediately before
 * the transaction: the caller's lifecycle, that the index was not closed or
 * reopened, and, through `currentRevision`, that the row still has the
 * revision that was embedded. A row that moved on meanwhile is skipped; the
 * write that moved it indexes it.
 */
export class SqliteVecMemoryIndex {
  private db: Database | null = null;
  private enabled = false;
  private available = false;
  private error: string | undefined;
  /** Whether `error` is an embedding failure, which a later successful embed clears. */
  private errorIsEmbedding = false;
  private platformLimitReason: string | undefined;
  /** The open in flight, so concurrent init calls share it. */
  private opening: Promise<void> | null = null;
  private static readonly rebuildBatchSize = 25;

  constructor(
    private readonly dbPath: string,
    private readonly dimensions = MEMORY_VECTOR_DIMS,
    private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry,
    /** The row's current revision in the owning store, undefined when the row is gone. */
    private readonly currentRevision?: (recordId: string) => string | undefined,
  ) {}

  /**
   * Opens the index. Never rejects: a failure leaves the index unavailable
   * with platformLimitReason or error set (sqlite-vec-loader.ts decides which,
   * in code). Idempotent: a later call waits for an open still in flight, so a
   * holder that did not start the open can await it.
   */
  init(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.db) return Promise.resolve();
    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    // A reason from an earlier failed open describes that attempt, not this one.
    this.error = undefined;
    this.errorIsEmbedding = false;
    this.platformLimitReason = undefined;
    try {
      if (this.dbPath !== ':memory:') {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      this.db = new (bunSqliteDatabase())(this.dbPath);
      const opened = this.db;
      // Another process may hold a write on this file (a rebuild batch): wait
      // briefly rather than failing the write as soon as it is refused.
      opened.run('PRAGMA busy_timeout = 5000');
      loadSqliteVecExtension(opened);
      this.available = true;
      this.enabled = true;
      // Schema versioning: one consistent pre-migration copy, auto-restore on
      // failure, and a downgrade guard (an older binary refuses a newer schema).
      openVersionedBunSqliteStore({
        storeName: 'memory vector index',
        dbPath: this.dbPath,
        db: this.db,
        targetVersion: MEMORY_VECTOR_SCHEMA_VERSION,
        migrations: [{ toVersion: MEMORY_VECTOR_SCHEMA_VERSION, migrate: () => {
          // v1 only stored content digests, which cannot establish a native row
          // revision; v2 did not record which provider made each vector; v3
          // recorded the provider but not its model, and kept it out of the
          // vector table, so a search could not filter on it in its statement.
          // Snapshot first (above), then rebuild this derived cache.
          // Primary memories live in the separate memory store and stay intact.
          this.db?.transaction(() => {
            this.db?.run('DROP TABLE IF EXISTS memory_vectors');
            this.db?.run('DROP TABLE IF EXISTS memory_vector_ids');
            this.createSchema();
          })();
        } }],
        closeDb: () => {
          this.db?.close();
          this.db = null;
        },
      });
      this.createSchema();
    } catch (err) {
      this.close();
      this.available = false;
      this.enabled = false;
      if (err instanceof SqliteVecPlatformUnsupportedError) {
        // A platform capability limit, not a fault: report it as a reason,
        // never through the error field (fault monitors and release smokes
        // treat `error` as a defect signal, and this is not one).
        this.platformLimitReason = err.message;
        logger.warn('Memory vector index unavailable on this platform, memory search uses literal matching', {
          backend: 'sqlite-vec',
          reason: err.message,
        });
      } else {
        this.error = summarizeError(err);
        logger.warn('Memory vector index unavailable', { backend: 'sqlite-vec', error: this.error });
      }
    }
  }

  stats(): MemoryVectorStats {
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    const error = this.error
      ?? (!provider && !this.platformLimitReason ? `Active memory embedding provider '${this.embeddingRegistry.getDefaultProviderId()}' is not registered.` : undefined);
    return {
      backend: 'sqlite-vec',
      enabled: this.enabled,
      available: this.available,
      path: this.dbPath,
      dimensions: this.dimensions,
      indexedRecords: this.countIndexedRecords(),
      embeddingProviderId: provider?.id ?? this.embeddingRegistry.getDefaultProviderId(),
      embeddingProviderLabel: provider?.label ?? `Unregistered (${this.embeddingRegistry.getDefaultProviderId()})`,
      embeddingSpace: this.space(),
      awaitingReembed: this.countOutsideSpace(),
      ...(this.platformLimitReason ? { platformLimitReason: this.platformLimitReason } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Index one row. With a provider that embeds synchronously this runs to the
   * end with no `await`, so the caller is checked once, here. A provider that
   * only embeds over the network indexes the row in the background.
   */
  upsert(record: MemoryRecord, options: MemoryVectorWriteOptions = {}): void {
    assertMemoryOperationCurrent(options);
    if (!this.db || !this.enabled) return;
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    if (provider && !provider.embedSync && provider.embed) {
      void this.upsertAsync(record, { revision: options.revision }).catch((err: unknown) => this.markEmbeddingUnavailable(err));
      return;
    }
    let embedding: Float32Array;
    const space = this.space();
    try {
      const result = this.embeddingRegistry.embedSync({
        text: buildMemoryEmbeddingText(record), dimensions: this.dimensions, usage: 'record', recordId: record.id,
      });
      embedding = normalizeMemoryEmbeddingVector(result.vector, this.dimensions);
    } catch (err) {
      this.markEmbeddingUnavailable(err);
      return;
    }
    try {
      this.writeEntries([{ record, revision: options.revision ?? this.revisionOf(record.id) ?? standaloneRevision(), embedding }], [], space);
    } catch (err) {
      this.markStoreFailure(err);
    }
  }

  /**
   * Index one row through the asynchronous embed. The one check that protects
   * the write runs after the embed resolves and before the transaction.
   */
  async upsertAsync(record: MemoryRecord, options: MemoryVectorWriteOptions = {}): Promise<void> {
    assertMemoryOperationCurrent(options);
    const db = this.db;
    if (!db || !this.enabled) return;
    const revision = options.revision ?? this.revisionOf(record.id);
    if (this.currentRevision && revision === undefined) return;
    const space = this.space();
    // A provider that ignores the signal cannot hold the caller past a cancellation.
    const result = await awaitMemoryOperation(() => this.embeddingRegistry.embedAsync({
      text: buildMemoryEmbeddingText(record),
      dimensions: this.dimensions,
      usage: 'record',
      recordId: record.id,
      signal: options.signal, beforeAttempt: () => assertMemoryOperationCurrent(options),
    }), options);
    if (!this.stillCurrent(db, space, record.id, revision)) return;
    this.clearEmbeddingError();
    try {
      this.writeEntries([{ record, revision: revision ?? standaloneRevision(), embedding: normalizeMemoryEmbeddingVector(result.vector, this.dimensions) }], [], space);
    } catch (err) {
      this.markStoreFailure(err);
    }
  }

  delete(recordId: string, options: MemoryOperationOptions = {}): void {
    assertMemoryOperationCurrent(options);
    if (!this.db || !this.enabled) return;
    try {
      this.deleteIds([recordId]);
    } catch (err) {
      this.markStoreFailure(err);
    }
  }

  /**
   * Bring the index in step with the store's rows, synchronously. One query
   * reads what the index holds; a row whose revision and provider match is
   * left alone. A provider that only embeds over the network cannot embed
   * here, so the pass runs in the background through `syncAsync`.
   */
  sync(entries: readonly MemoryVectorEntry[]): void {
    if (!this.db || !this.enabled) return;
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    if (provider && !provider.embedSync && provider.embed) {
      void this.syncAsync(entries).catch((err: unknown) => this.markEmbeddingUnavailable(err));
      return;
    }
    const space = this.space();
    const stored = this.storedRows();
    const changed: Array<{ record: MemoryRecord; revision: string; embedding: Float32Array }> = [];
    try {
      for (const entry of entries) {
        if (isIndexed(stored.get(entry.record.id), entry.revision, space)) continue;
        const result = this.embeddingRegistry.embedSync({
          text: buildMemoryEmbeddingText(entry.record), dimensions: this.dimensions, usage: 'record', recordId: entry.record.id,
        });
        changed.push({ ...entry, embedding: normalizeMemoryEmbeddingVector(result.vector, this.dimensions) });
      }
    } catch (err) {
      this.markEmbeddingUnavailable(err);
      return;
    }
    const live = new Set(entries.map((entry) => entry.record.id));
    try {
      this.writeEntries(changed, [...stored.keys()].filter((id) => !live.has(id)), space);
    } catch (err) {
      this.markStoreFailure(err);
    }
  }

  /**
   * The same pass through the asynchronous embed, in batches: one request per
   * batch of rows where the provider takes a list. Rows the index already
   * holds at their revision are skipped unless `force` is set. Each batch is
   * checked once after its embed resolves; a row that changed meanwhile is
   * left to the write that changed it. An embedding failure stops the pass and
   * is reported through `stats().error`.
   */
  async syncAsync(entries: readonly MemoryVectorEntry[], options: MemoryOperationOptions & { force?: boolean } = {}): Promise<void> {
    assertMemoryOperationCurrent(options);
    const db = this.db;
    if (!db || !this.enabled) return;
    const space = this.space();
    const stored = this.storedRows();
    const pending = entries.filter((entry) => options.force || !isIndexed(stored.get(entry.record.id), entry.revision, space));
    const live = new Set(entries.map((entry) => entry.record.id));
    const gone = [...stored.keys()].filter((id) => !live.has(id));
    for (let start = 0; start < pending.length; start += SqliteVecMemoryIndex.rebuildBatchSize) {
      const batch = pending.slice(start, start + SqliteVecMemoryIndex.rebuildBatchSize);
      let results: MemoryEmbeddingResult[];
      try {
        results = await awaitMemoryOperation(() => this.embeddingRegistry.embedManyAsync({
          texts: batch.map((entry) => buildMemoryEmbeddingText(entry.record)),
          dimensions: this.dimensions,
          usage: 'record',
          signal: options.signal, beforeAttempt: () => assertMemoryOperationCurrent(options),
        }), options);
      } catch (err) {
        assertMemoryOperationCurrent(options);
        this.markEmbeddingUnavailable(err);
        return;
      }
      if (this.db !== db || this.space() !== space) return;
      this.clearEmbeddingError();
      const current = batch.flatMap((entry, index) => this.stillCurrent(db, space, entry.record.id, entry.revision)
        ? [{ ...entry, embedding: normalizeMemoryEmbeddingVector(results[index]!.vector, this.dimensions) }] : []);
      try {
        this.writeEntries(current, [], space);
      } catch (err) {
        this.markStoreFailure(err);
        return;
      }
    }
    if (this.db !== db || gone.length === 0) return;
    try {
      this.deleteIds(gone);
    } catch (err) {
      this.markStoreFailure(err);
    }
  }

  /**
   * The rows nearest the query. The query is embedded through the
   * asynchronous embed, which also serves a provider that embeds
   * synchronously, so every shipped provider can answer. A failed embed is
   * recorded on `stats().error` and the search returns nothing, so the caller
   * falls back to its lexical path and can say so.
   */
  async search(query: string, filter: MemoryVectorSearchFilter = {}, options: MemoryOperationOptions = {}): Promise<MemoryVectorCandidate[]> {
    assertMemoryOperationCurrent(options);
    const db = this.db;
    if (!db || !this.enabled) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const requestedLimit = normalizeLimit(filter.limit, 10);
    const vectorLimit = Math.max(requestedLimit, 1);
    let embedding: Float32Array;
    // The space the query is embedded in; rows of any other space are left out in the same statement.
    const space = this.space();
    try {
      const result = await awaitMemoryOperation(() => this.embeddingRegistry.embedAsync({
        text: trimmed, dimensions: this.dimensions, usage: 'query',
        signal: options.signal, beforeAttempt: () => assertMemoryOperationCurrent(options),
      }), options);
      embedding = normalizeMemoryEmbeddingVector(result.vector, this.dimensions);
    } catch (err) {
      assertMemoryOperationCurrent(options);
      this.markEmbeddingUnavailable(err);
      return [];
    }
    if (this.db !== db || this.space() !== space) return [];
    this.clearEmbeddingError();
    const where: string[] = ['embedding MATCH ?', 'k = ?', 'space = ?'];
    const params: SQLQueryBindings[] = [embedding, vectorLimit, space];

    if (filter.scope) {
      where.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.cls) {
      where.push('cls = ?');
      params.push(filter.cls);
    }
    const requestedStates = filter.reviewState ? (Array.isArray(filter.reviewState) ? filter.reviewState : [filter.reviewState]) : [];
    if (requestedStates.length === 1) {
      where.push('review_state = ?');
      params.push(requestedStates[0]!);
    }
    // A hint only: the row's confidence here is a copy; the store re-checks the live row.
    if (filter.minConfidence !== undefined) {
      where.push('confidence >= ?');
      params.push(filter.minConfidence);
    }
    if (filter.staleOnly) {
      where.push("(review_state = 'stale' OR review_state = 'contradicted')");
    } else if (!requestedStates.includes('contradicted')) {
      // Contradicted records stay out unless the caller asked for them by state.
      where.push("review_state != 'contradicted'");
    }

    const rows = db.query<VectorRow, SQLQueryBindings[]>(
      `SELECT rowid, record_id, distance
         FROM memory_vectors
        WHERE ${where.join(' AND ')}
        ORDER BY distance`,
    ).all(...params) as VectorRow[];

    return rows.map((row) => ({
      id: row.record_id,
      distance: Number(row.distance),
      similarity: distanceToSimilarity(Number(row.distance)),
    }));
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.enabled = false;
    this.available = false;
  }

  private createSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_vector_ids (
        rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id   TEXT NOT NULL UNIQUE,
        source_revision TEXT NOT NULL DEFAULT '',
        space_id    TEXT NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0,
        indexed_at  INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        embedding float[${this.dimensions}],
        space text,
        scope text,
        cls text,
        review_state text,
        confidence integer,
        +record_id text,
        +updated_at integer,
        +created_at integer
      )
    `);
  }

  private countIndexedRecords(): number {
    if (!this.db || !this.enabled) return 0;
    const row = this.db.query<CountRow, []>(
      'SELECT count(*) AS count FROM memory_vector_ids',
    ).get();
    return Number(row?.count ?? 0);
  }

  /** What the index holds, in one query: revision and space per record. */
  private storedRows(): Map<string, StoredVectorRow> {
    const rows = this.db?.query<StoredVectorRow, []>('SELECT record_id, source_revision, space_id FROM memory_vector_ids').all() ?? [];
    return new Map(rows.map((row) => [row.record_id, row]));
  }

  /** The space the active provider embeds in at this index's width. */
  private space(): string {
    return this.embeddingRegistry.currentSpace(this.dimensions).id;
  }

  /** Rows embedded in another space than the current one. */
  private countOutsideSpace(): number {
    if (!this.db || !this.enabled) return 0;
    const row = this.db.query<CountRow, [string]>('SELECT count(*) AS count FROM memory_vector_ids WHERE space_id != ?').get(this.space());
    return Number(row?.count ?? 0);
  }

  private revisionOf(recordId: string): string | undefined {
    return this.currentRevision?.(recordId);
  }

  /** After an awaited embed: same open index, same space, and the row still at the embedded revision. */
  private stillCurrent(db: Database, space: string, recordId: string, revision: string | undefined): boolean {
    if (this.db !== db || !this.enabled || this.space() !== space) return false;
    return !this.currentRevision || this.currentRevision(recordId) === revision;
  }

  private markEmbeddingUnavailable(error: unknown): void {
    this.error = summarizeError(error);
    this.errorIsEmbedding = true;
    logger.warn('Memory vector index could not embed text with the active embedding provider', {
      providerId: this.embeddingRegistry.getDefaultProviderId(),
      error: this.error,
    });
  }

  private clearEmbeddingError(): void {
    if (!this.errorIsEmbedding) return;
    this.error = undefined;
    this.errorIsEmbedding = false;
  }

  /** The vector file refused a write (locked by another process, full disk): say that, not that the provider failed. */
  private markStoreFailure(error: unknown): void {
    this.error = `the vector index file could not be written: ${summarizeError(error)}`;
    this.errorIsEmbedding = false;
    logger.warn('Memory vector index write failed', { path: this.dbPath, error: this.error });
  }

  /**
   * One transaction: a refused write part-way (a lock held by another process)
   * rolls back, so a previous vector stays instead of being deleted without a
   * replacement.
   */
  private writeEntries(
    entries: ReadonlyArray<{ readonly record: MemoryRecord; readonly revision: string; readonly embedding: Float32Array }>,
    removed: readonly string[] = [],
    /** The space the entries were embedded in, read before their embed. */
    space: string = this.space(),
  ): void {
    const db = this.db;
    if (!db || (entries.length === 0 && removed.length === 0)) return;
    const ensureId = db.query('INSERT OR IGNORE INTO memory_vector_ids (record_id) VALUES (?)');
    const selectId = db.query<RecordIdRow, [string]>('SELECT rowid FROM memory_vector_ids WHERE record_id = ? LIMIT 1');
    const dropVector = db.query('DELETE FROM memory_vectors WHERE rowid = ?');
    const insertVector = db.query(
      `INSERT INTO memory_vectors
         (rowid, embedding, space, scope, cls, review_state, confidence, record_id, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const stamp = db.query(
      `UPDATE memory_vector_ids
         SET source_revision = ?, space_id = ?, updated_at = ?, indexed_at = ?
       WHERE rowid = ?`,
    );
    db.transaction(() => {
      for (const { record, revision, embedding } of entries) {
        ensureId.run(record.id);
        const row = selectId.get(record.id);
        if (!row) throw new Error(`Memory vector row id not found for ${record.id}`);
        const rowid = Number(row.rowid);
        dropVector.run(rowid);
        insertVector.run(rowid, embedding, space, record.scope, record.cls, record.reviewState,
          record.confidence, record.id, record.updatedAt, record.createdAt);
        stamp.run(revision, space, record.updatedAt, Date.now(), rowid);
      }
      this.deleteIdsIn(db, removed);
    })();
    if (!this.errorIsEmbedding) this.error = undefined;
  }

  private deleteIds(recordIds: readonly string[]): void {
    const db = this.db;
    if (!db || recordIds.length === 0) return;
    db.transaction(() => this.deleteIdsIn(db, recordIds))();
  }

  private deleteIdsIn(db: Database, recordIds: readonly string[]): void {
    if (recordIds.length === 0) return;
    const selectId = db.query<RecordIdRow, [string]>('SELECT rowid FROM memory_vector_ids WHERE record_id = ? LIMIT 1');
    const dropVector = db.query('DELETE FROM memory_vectors WHERE rowid = ?');
    const dropId = db.query('DELETE FROM memory_vector_ids WHERE rowid = ?');
    for (const recordId of recordIds) {
      const row = selectId.get(recordId);
      if (!row) continue;
      dropVector.run(row.rowid);
      dropId.run(row.rowid);
    }
  }
}

/** Whether the index already holds this row at this revision, embedded in this space. */
function isIndexed(row: StoredVectorRow | undefined, revision: string, space: string): boolean {
  // Unchanged text embedded by another provider or model is stale: its vector is in a different space.
  return row !== undefined && row.source_revision === revision && row.space_id === space;
}

/** An index used without a store has no row revision; each write is its own. */
function standaloneRevision(): string {
  return `memory-index-${randomUUID()}`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.round(value!)));
}

function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - (distance / 2)));
}
