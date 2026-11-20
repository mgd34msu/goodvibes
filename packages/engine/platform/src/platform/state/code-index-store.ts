import { DirectoryWalk } from '../utils/walk-dir.js';
/**
 * CodeIndexStore, an incremental, tree-sitter-chunked, embedding-backed index
 * of a repo's source tree (see CHANGELOG 0.38.0).
 *
 * Deliberately MIRRORS MemoryStore + SqliteVecMemoryIndex (state/memory-store.ts,
 * state/memory-vector-store.ts) rather than reusing them: those classes are
 * hard-keyed to MemoryRecord (schema columns, native memory row revisions,
 * buildMemoryEmbeddingText, record-shaped search filters). Code chunks are a
 * different record shape entirely, so this module is a parallel, independent
 * implementation that reuses only:
 *   - the sqlite-vec native extension loader (sqlite-vec-loader.ts)
 *   - MEMORY_VECTOR_DIMS / the shared MemoryEmbeddingProviderRegistry instance,
 *     so code and memory embeddings share one provider and one dimensionality.
 *   - CodeIntelligence.getSymbols (tree-sitter-backed chunking; the chunking
 *     itself lives in code-index-chunking.ts)
 *   - the file-walk helpers already shipped for the `find` tool
 *     (tools/find/shared.ts: createNestedIgnoreMatcher, collectGlobFiles,
 *     hasBinaryPrefix on the bytes of the one read), no new ignore-file
 *     parsing or directory-walk logic. Ignore
 *     rules: every .gitignore between the root and a file, each applied
 *     relative to its own directory and read where it lives, with no cap; an
 *     ignored file is never read or sent to an embedding provider.
 *
 * Unchanged files: a file's revision is the SHA-256 of its bytes, so a build
 * skips every file whose text it already embedded, whatever happened to its
 * permissions, owner, links or mount (code-file-observation.ts).
 *
 * Storage: a single bun:sqlite database (schema + all table ops live in
 * code-index-db.ts), `code_chunks` (chunk metadata), `code_vectors` (vec0
 * virtual table), and `code_index_meta` (build provenance: the embedding
 * provider id the index was last fully built with). When the current default
 * embedding provider differs from the stored one, search() refuses to run the
 * vector path, a query embedded in provider-Y space compared against
 * provider-X vectors is meaningless, and degrades to an honestly-labeled
 * lexical search (symbol/path recall, ordered by the `engine.state.code-search`
 * rerank) until a rebuild re-embeds (buildFull() detects the mismatch and
 * forces a full re-embed).
 *
 * Incremental reindex is LAZY, never a watcher: a recursive fs.watch over a
 * repo tree is a per-file-descriptor liability and races the agent's own
 * writes. `reindexFile()` re-chunks and re-embeds a single path on demand.
 * `buildFull()` walks the whole tree once; concurrent calls coalesce through a
 * single-flight promise guard, mirroring MemoryStore.rebuildVectorIndexAsync.
 *
 * Lifecycle honesty: `close()` bumps an epoch counter; an in-flight build
 * re-checks the epoch after every await and aborts cleanly when stale
 * (per-file writes are atomic, all of a file's chunks are embedded before any
 * row is written, so an aborted build never writes into a database opened
 * again later). Aborted builds return stats carrying
 * `abortReason: 'build aborted by close'` and never become `lastBuild`.
 *
 * The index never blocks a turn: buildFull() embeds a file's chunks in
 * batches (one provider request per EMBED_BATCH_SIZE chunks; a rate limit is
 * waited out inside the provider adapter) with periodic event-loop yields, and
 * every read (`search`, `stats`) returns whatever is currently indexed, it
 * never waits on an in-flight build.
 */
import { dirname, relative } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { createRequire } from 'node:module';
import { loadSqliteVecExtension, SqliteVecPlatformUnsupportedError } from './sqlite-vec-loader.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  normalizeMemoryEmbeddingVector,
} from './memory-embeddings.js';
import { MEMORY_VECTOR_DIMS } from './embedding-dims.js';
import { CodeIntelligence } from '../intelligence/facade.js';
import {
  chunkFileContent,
  type CodeChunk,
  type CodeChunkMode,
} from './code-index-chunking.js';
import {
  CHUNK_ROW_COLUMNS,
  EMBEDDING_PROVIDER_META_KEY,
  CODE_INDEX_SCHEMA_VERSION,
  createCodeIndexSchema,
  migrateCodeIndexSchema,
  countChunksForPath,
  countIndexedChunks,
  countIndexedFiles,
  deleteChunksForPath,
  getChunkByRowId,
  getCodeIndexMeta,
  getFileRevision,
  listIndexedPaths,
  rowToChunk,
  setCodeIndexMeta,
  replaceFileChunks,
  type ChunkRow,
  type VectorRow,
} from './code-index-db.js';
import {
  collectGlobFiles,
  createFindDiagnostics,
  createNestedIgnoreMatcher,
} from '../tools/find/shared.js';
import { adoptSqliteDatabase } from './sqlite-file.js';
import { CodeSourceChangedError, readCodeIndexFile, type CodeFileObservation } from './code-file-observation.js';
import { rankLiveCodeInjection } from './code-injection-live.js';
import type { CodeInjectionAuthorityOptions } from './code-injection-ranking.js';
import { rankLexicalChunks } from './code-index-lexical.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { prepareAuthorizedCodeSnapshots, type AuthorizedCodePrepareInput, type AuthorizedCodeIndex } from './code-index-authorized.js';
export type { AuthorizedCodePrepareInput, AuthorizedCodeSnapshot, AuthorizedIndexBoundary } from './code-index-authorized.js';
// bun:sqlite is a Bun-only builtin; a static import makes this module unloadable
// under Node (breaks the release install-smoke check). Lazily require the ctor so
// the `bun:` specifier stays off the static graph, only pulled on the Bun-only
// path that opens a database.
let bunDatabaseCtor: typeof import('bun:sqlite').Database | null = null;
function bunSqliteDatabase(): typeof import('bun:sqlite').Database {
  return (bunDatabaseCtor ??= createRequire(import.meta.url)('bun:sqlite').Database);
}
export type { CodeChunk, CodeChunkMode } from './code-index-chunking.js';
export type {
  CodeContextResult,
  CodeIndexBuildProgress,
  CodeIndexBuildStats,
  CodeIndexOptions,
  CodeIndexSkipReport,
  CodeIndexStats,
} from './code-index-types.js';
import type {
  CodeContextResult,
  CodeIndexBuildProgress,
  CodeIndexBuildStats,
  CodeIndexOptions,
  CodeIndexStats,
} from './code-index-types.js';
const DEFAULT_MAX_FILES = Infinity;
const DEFAULT_MAX_FILE_BYTES = Infinity;
const DEFAULT_MAX_TOTAL_BYTES = Infinity;
const BUILD_ABORTED_BY_CLOSE = 'build aborted by close';
/** Consecutive failures (provider down, bad key, full disk) after which a build stops instead of failing every remaining file. */
const MAX_CONSECUTIVE_INDEX_FAILURES = 5;
/** Chunks per embedding request during a build: one request per batch instead of one per chunk. */
const EMBED_BATCH_SIZE = 64;
/** How long a second process holding the database may block a statement before it fails. */
const SQLITE_BUSY_TIMEOUT_MS = 5000;
function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    timer.unref?.();
  });
}

type MutableSkipReport = {
  tooLarge: number;
  overFileCap: number;
  overTotalBytes: number;
  binary: number;
  ignoredByGitignore: number;
  readErrors: number;
  chunkedByWindow: number;
};

function emptySkipReport(): MutableSkipReport {
  return { tooLarge: 0, overFileCap: 0, overTotalBytes: 0, binary: 0, ignoredByGitignore: 0, readErrors: 0, chunkedByWindow: 0 };
}


export class CodeIndexStore {
  private db: Database | null = null;
  private available = false;
  private error: string | undefined;
  private platformLimitReason: string | undefined;
  /** The open in flight, so concurrent init calls share it. */
  private opening: Promise<void> | null = null;
  private building = false;
  private buildStartedAtMs: number | null = null;
  private buildPromise: Promise<CodeIndexBuildStats> | null = null;
  private lastBuild: CodeIndexBuildStats | null = null;
  /** Why the latest build did not run or did not finish; cleared when a build completes. */
  private lastBuildError: string | undefined;
  /** Paths reindexed by reindexFile() while a full build runs; exempt from that build's sweep. */
  private readonly touchedDuringBuild = new Set<string>();
  private progress: CodeIndexBuildProgress | null = null;
  private readonly intelligence: CodeIntelligence;
  private intelligenceReadyPromise: Promise<void> | null = null;
  /**
   * Lifecycle generation counter. Bumped by close(); an in-flight runBuild()
   * captures the value at start and re-checks it after EVERY await, aborting
   * cleanly when stale so a build never writes into a database opened again.
   */
  private epoch = 0;
  private lastSearchError: string | undefined;
  private authorizedRunUsed = false;
  private authorizedIndex: AuthorizedCodeIndex | null = null;

  private rootDir: string;
  private dbPath: string;

  constructor(
    rootDir: string,
    dbPath: string,
    private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry,
    private readonly options: CodeIndexOptions = {},
  ) {
    this.rootDir = rootDir;
    this.dbPath = dbPath;
    this.intelligence = new CodeIntelligence();
  }


  /**
   * Opens the store. Never rejects: a failure leaves the store unavailable
   * with platformLimitReason or error set (sqlite-vec-loader.ts decides
   * which, in code).
   * Idempotent: a later call waits for an open still in flight, so a holder
   * that did not start the open can await it.
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
    // A failure from an earlier open (or an earlier root) no longer describes this one.
    this.error = undefined;
    this.platformLimitReason = undefined;
    try {
      if (this.dbPath !== ':memory:') {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      this.db = new (bunSqliteDatabase())(this.dbPath);
      const opened = this.db;
      loadSqliteVecExtension(opened);
      this.available = true;
      // WAL so two windows on one workspace read while the other writes, a
      // busy wait for the other writer instead of failing mid-file, and the
      // schema brought forward in one transaction after one consistent copy.
      // A newer file than this build is refused untouched.
      adoptSqliteDatabase(opened, this.dbPath, {
        name: 'code index store',
        busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
        foreignKeys: false,
        migrations: [{ toVersion: CODE_INDEX_SCHEMA_VERSION, up: migrateCodeIndexSchema }],
      });
      createCodeIndexSchema(opened);
    } catch (err) {
      this.close();
      this.available = false;
      // Platform capability limit vs genuine fault (see sqlite-vec-loader.ts).
      const limit = err instanceof SqliteVecPlatformUnsupportedError;
      if (limit) this.platformLimitReason = (err as Error).message;
      else this.error = summarizeError(err);
      logger.warn(limit ? 'Code index unavailable on this platform' : 'Code index unavailable', {
        backend: 'sqlite-vec',
        ...(limit ? { reason: (err as Error).message } : { error: this.error }),
      });
    }
  }

  close(): void {
    this.authorizedIndex = null;
    if (!this.db) return;
    this.epoch++;
    this.db.close();
    this.db = null;
    this.available = false;
    // The epoch bump retires an in-flight build, whose own cleanup then skips
    // these; without the reset a later init() would read as building forever.
    this.buildPromise = null;
    this.building = false;
    this.buildStartedAtMs = null;
    this.progress = null;
  }

  isBuilding(): boolean {
    return this.building;
  }

  buildProgress(): CodeIndexBuildProgress | null {
    return this.building ? this.progress : null;
  }

  /** Wall-clock start time of the in-flight build, or null when idle. */
  buildStartedAt(): number | null {
    return this.building ? this.buildStartedAtMs : null;
  }

  /** True unless the only active embedding provider is the deterministic hashed fallback. */
  hasSemanticProvider(): boolean {
    if (this.authorizedRunUsed) throw new Error('Use guarded authorized code index access');
    return this.embeddingRegistry.getDefaultProviderId() !== HASHED_MEMORY_EMBEDDING_PROVIDER.id;
  }

  /** Stated once, honest: why code auto-retrieval would be absent right now. Null when a real provider is active. */
  describeDegradation(): string | null {
    return this.hasSemanticProvider()
      ? null
      : 'code auto-retrieval disabled: no semantic embedding provider configured';
  }

  /**
   * Human-readable provider-space mismatch, or null when the stored vectors
   * were built with the current default provider (or provenance is unknown,
   * an index that predates provenance tracking keeps its legacy behavior
   * until the next build stamps it).
   */
  getProviderMismatch(): string | null {
    if (this.authorizedRunUsed) throw new Error('Use guarded authorized code index access');
    if (!this.db || !this.available) return null;
    const stored = getCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY);
    const current = this.currentSpace();
    if (stored === null || stored === current) return null;
    return `embeddings built in ${stored}, current embedding space ${current}, rebuild to re-embed`;
  }

  /** The space (`<provider>:<model>:<dimensions>`) the index is stamped with and a build embeds in now. */
  private currentSpace(): string {
    return this.embeddingRegistry.currentSpace(MEMORY_VECTOR_DIMS).id;
  }

  stats(): CodeIndexStats {
    if (this.authorizedRunUsed) throw new Error('Use guarded authorized code index access');
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    const mismatch = this.getProviderMismatch();
    return {
      backend: 'sqlite-vec',
      enabled: this.available,
      available: this.available,
      path: this.dbPath,
      dimensions: MEMORY_VECTOR_DIMS,
      indexedFiles: this.db && this.available ? countIndexedFiles(this.db) : 0,
      indexedChunks: this.db && this.available ? countIndexedChunks(this.db) : 0,
      embeddingProviderId: provider?.id ?? this.embeddingRegistry.getDefaultProviderId(),
      embeddingProviderLabel: provider?.label ?? `Unregistered (${this.embeddingRegistry.getDefaultProviderId()})`,
      semanticRetrievalAvailable: this.hasSemanticProvider(),
      ...(mismatch ? { embeddingProviderMismatch: mismatch } : {}),
      building: this.building,
      lastBuild: this.lastBuild,
      ...(this.error ? { error: this.error } : {}),
      ...(this.lastBuildError ? { lastBuildError: this.lastBuildError } : {}),
      ...(this.lastSearchError ? { lastSearchError: this.lastSearchError } : {}),
    };
  }


  async search(query: string, opts: { limit?: number } = {}): Promise<CodeContextResult[]> {
    if (this.authorizedRunUsed) throw new Error('Live-tree operations are disabled on an authorized code index');
    // Each search reports its own outcome; a failure from an earlier query must not outlive a search that did not embed.
    this.lastSearchError = undefined;
    if (!this.db || !this.available) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

    // Provider-space honesty: a query embedded under the CURRENT provider is
    // meaningless against vectors stored under a DIFFERENT one, skip the
    // vector path entirely and degrade to the lexical search.
    if (this.getProviderMismatch() !== null) {
      return this.searchLexical(trimmed, limit);
    }

    // The query is embedded the way the build embedded the chunks: every
    // shipped HTTP provider embeds asynchronously only.
    const db = this.db;
    let embedding: Float32Array;
    try {
      const result = await this.embeddingRegistry.embedAsync({
        text: trimmed,
        dimensions: MEMORY_VECTOR_DIMS,
        usage: 'query',
      });
      embedding = normalizeMemoryEmbeddingVector(result.vector, MEMORY_VECTOR_DIMS);
      this.lastSearchError = undefined;
    } catch (err) {
      // An empty answer here means "could not search", not "nothing matches"; stats().lastSearchError says which.
      this.lastSearchError = `code search unavailable: query embedding failed: ${summarizeError(err)}`;
      logger.warn('Code index query embedding failed', { error: summarizeError(err) });
      return [];
    }
    if (this.db !== db || !this.available) return [];

    const rows = db.query<VectorRow, SQLQueryBindings[]>(
      'SELECT rowid, distance FROM code_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance',
    ).all(embedding, limit) as VectorRow[];

    const label: CodeContextResult['label'] = this.hasSemanticProvider() ? 'semantic' : 'lexical';
    const results: CodeContextResult[] = [];
    for (const row of rows) {
      const chunk = getChunkByRowId(db, Number(row.rowid));
      if (!chunk) continue;
      results.push({
        chunk,
        distance: Number(row.distance),
        similarity: distanceToSimilarity(Number(row.distance)),
        label,
      });
    }
    return results;
  }

  /** Per-invocation live read authority; no session policy or reading is retained on this shared store. */
  async rankForInjection(query: string, hits: readonly CodeContextResult[], options: CodeInjectionAuthorityOptions = {}) {
    const epoch = this.epoch, root = this.rootDir, provider = this.embeddingRegistry.getDefaultProviderOrNull();
    const assertCurrent = (): void => {
      if (this.authorizedRunUsed || epoch !== this.epoch || root !== this.rootDir || !this.available
        || provider !== this.embeddingRegistry.getDefaultProviderOrNull() || !this.hasSemanticProvider() || this.getProviderMismatch()) {
        throw new Error('Code injection source is stale');
      }
    };
    assertCurrent();
    return rankLiveCodeInjection(root, query, hits, options, assertCurrent);
  }

  /** One-shot semantic retrieval over receipt-authorized snapshots in a fresh in-memory store. */
  async prepareAuthorizedSnapshots(input: AuthorizedCodePrepareInput): Promise<void> {
    if (this.dbPath !== ':memory:' || this.authorizedRunUsed || this.building) {
      throw new Error('Authorized code search requires a fresh per-run in-memory store');
    }
    this.authorizedRunUsed = true;
    const epoch = this.epoch;
    input = { ...input, snapshots: input.snapshots.map((snapshot) => ({ ...snapshot })) };
    input.signal.throwIfAborted();
    await this.init();
    if (this.epoch !== epoch || this.dbPath !== ':memory:') throw new Error('Authorized code index lifecycle changed');
    const db = this.db;
    if (!db || !this.available) throw new Error('Authorized code index storage is unavailable');
    const checkLifecycle = (): void => {
      if (this.epoch !== epoch || this.db !== db || !this.available) {
        throw new Error('Authorized code index lifecycle changed');
      }
    };
    input.signal.throwIfAborted();
    checkLifecycle();
    await this.ensureIntelligenceReady();
    checkLifecycle();
    const authorized = await prepareAuthorizedCodeSnapshots(input, this.embeddingRegistry, db, this.intelligence, checkLifecycle);
    input.signal.throwIfAborted();
    checkLifecycle();
    this.authorizedIndex = authorized;
  }

  async statsAuthorized(): Promise<CodeIndexStats> {
    if (!this.authorizedIndex) throw new Error('Authorized code index has not been prepared');
    return this.authorizedIndex.stats();
  }

  async searchAuthorized(query: string, options: { limit?: number } = {}): Promise<CodeContextResult[]> {
    if (!this.authorizedIndex) throw new Error('Authorized code index has not been prepared');
    return this.authorizedIndex.search(query, options);
  }

  /**
   * Lexical search used when the vector path is disabled by a provider
   * mismatch. Recall is code: chunks whose symbol or path contains a query
   * token (chunk text is not stored), up to five per requested result. The
   * order is the `engine.state.code-search` rerank's, read against each
   * chunk's code (code-index-lexical.ts); chunks it reads as not matching are
   * left out. Labeled 'lexical', never 'semantic'.
   */
  private async searchLexical(query: string, limit: number): Promise<CodeContextResult[]> {
    if (this.authorizedRunUsed) throw new Error('Live-tree operations are disabled on an authorized code index');
    if (!this.db) return [];
    const tokens = Array.from(new Set(
      query.toLowerCase().split(/[^a-z0-9_$]+/).filter((token) => token.length >= 2),
    ));
    if (tokens.length === 0) return [];

    const where = tokens.map(() => '(lower(symbol) LIKE ? OR lower(path) LIKE ?)').join(' OR ');
    const bindings: SQLQueryBindings[] = tokens.flatMap((token) => [`%${token}%`, `%${token}%`]);
    const rows = this.db.query<ChunkRow, SQLQueryBindings[]>(
      `SELECT ${CHUNK_ROW_COLUMNS} FROM code_chunks WHERE ${where} LIMIT ?`,
    ).all(...bindings, limit * 5) as ChunkRow[];
    return rankLexicalChunks(this.rootDir, query, rows.map(rowToChunk), limit);
  }


  /** Fire-and-forget kickoff; concurrent/repeated calls while a build is running are no-ops. Never awaited by the caller, never blocks a turn. */
  scheduleBuild(): void {
    if (this.authorizedRunUsed) throw new Error('Live-tree operations are disabled on an authorized code index');
    if (this.building) return;
    void this.buildFull().catch((err) => {
      logger.warn('Code index build failed', { error: summarizeError(err) });
    });
  }

  /** Full source-tree walk. Concurrent calls coalesce onto the same in-flight promise (mirrors MemoryStore.rebuildVectorIndexAsync). */
  async buildFull(): Promise<CodeIndexBuildStats> {
    if (this.authorizedRunUsed) throw new Error('Live-tree operations are disabled on an authorized code index');
    if (!this.db || !this.available) {
      this.lastBuildError = `build not started: the code index is not open${this.error ? ` (${this.error})` : this.platformLimitReason ? ` (${this.platformLimitReason})` : ''}`;
      // Not the previous build's stats: that would read as a build that ran just now.
      return { ...emptyBuildStats(), abortReason: this.lastBuildError };
    }
    if (!this.buildPromise) {
      const buildEpoch = this.epoch;
      this.building = true;
      this.buildStartedAtMs = Date.now();
      this.progress = { scanned: 0, total: 0 };
      this.lastBuildError = undefined;
      this.buildPromise = this.runBuild(buildEpoch).catch((error: unknown) => {
        if (this.epoch === buildEpoch) this.lastBuildError = `build failed: ${summarizeError(error)}`;
        throw error;
      }).finally(() => {
        // A close() already reset these for the NEW lifecycle; a stale
        // build's cleanup must not clobber state belonging to a newer epoch.
        if (this.epoch === buildEpoch) {
          this.building = false;
          this.buildStartedAtMs = null;
          this.buildPromise = null;
          this.progress = null;
        }
      });
    }
    return this.buildPromise;
  }

  /** Reindex one file. Missing or gitignored paths have their chunks removed.
   * Scheduler updates also honor directory selection and no-follow policy.
   */
  async reindexFile(absPath: string, options: { automatic?: boolean } = {}): Promise<{ indexed: boolean; mode: CodeChunkMode }> {
    if (this.authorizedRunUsed) throw new Error('Live-tree operations are disabled on an authorized code index');
    if (!this.db || !this.available) return { indexed: false, mode: 'empty' };
    const callEpoch = this.epoch;
    const rel = relative(this.rootDir, absPath);
    if (rel.startsWith('..')) return { indexed: false, mode: 'empty' };
    // A running full build's sweep works from the file list it scanned at its
    // start; a file written here after that scan must not be swept as gone.
    if (this.building) this.touchedDuringBuild.add(rel);

    const diagnostics = createFindDiagnostics();
    const assertCurrent = (): void => {
      if (this.epoch !== callEpoch) throw new Error('Code index reindex superseded during directory reading');
    };
    try {
      if (options.automatic && await new DirectoryWalk(this.rootDir).excludesFile(absPath, { beforeAttempt: assertCurrent, site: 'state.code-index.reindex.skip-directory' })) {
        assertCurrent();
        deleteChunksForPath(this.db, rel);
        return { indexed: false, mode: 'empty' };
      }
    } catch (error) {
      if (this.epoch !== callEpoch) return { indexed: false, mode: 'empty' };
      throw error;
    }
    if (this.epoch !== callEpoch || !this.db) return { indexed: false, mode: 'empty' };
    // One read attempt per ancestor directory's .gitignore; no walk of the tree.
    if (createNestedIgnoreMatcher(this.rootDir, diagnostics)(absPath)) {
      deleteChunksForPath(this.db, rel);
      return { indexed: false, mode: 'empty' };
    }

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      deleteChunksForPath(this.db, rel);
      return { indexed: false, mode: 'empty' };
    }

    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    // A file that is now too large or binary no longer has code to index; its old chunks
    // describe content it no longer has, which is what a full build would also drop.
    if (stat.size > maxFileBytes) {
      deleteChunksForPath(this.db, rel);
      return { indexed: false, mode: 'empty' };
    }

    // One read: the binary verdict comes from the bytes it returned.
    const source = await readCodeIndexFile(this.rootDir, absPath, diagnostics, maxFileBytes);
    if (this.epoch !== callEpoch || !this.db) return { indexed: false, mode: 'empty' };
    if (source === 'binary') {
      deleteChunksForPath(this.db, rel);
      return { indexed: false, mode: 'empty' };
    }
    if (source === null) return { indexed: false, mode: 'empty' };

    const outcome = await this.indexFileContent(rel, absPath, source, callEpoch, false);
    if (outcome === null) return { indexed: false, mode: 'empty' };
    return { indexed: outcome.indexed, mode: outcome.mode };
  }

  // ── Build internals ──────────────────────────────────────────────────────

  private async runBuild(buildEpoch: number): Promise<CodeIndexBuildStats> {
    const startedAt = Date.now();
    const diagnostics = createFindDiagnostics();
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTotalBytes = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const skip = emptySkipReport();
    this.touchedDuringBuild.clear();
    let changedDuringBuild = 0;
    let failedFiles = 0;
    let consecutiveFailures = 0;
    let firstFailure: string | undefined;

    // Provider-space honesty: if the stored vectors were embedded under a
    // different provider than the current default, the unchanged-file
    // shortcut would silently keep stale-space vectors, force a full
    // re-embed so a completed build always leaves a single-provider index.
    const currentProviderId = this.currentSpace();
    const storedProviderId = this.db ? getCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY) : null;
    // An index holding chunks but no stamp is one whose first build never finished: its
    // vectors cannot be vouched for either, so it is re-embedded and then stamped.
    const unstampedWithChunks = storedProviderId === null && this.db !== null && countIndexedChunks(this.db) > 0;
    const forceReembed = unstampedWithChunks || (storedProviderId !== null && storedProviderId !== currentProviderId);

    const walk = new DirectoryWalk(this.rootDir);
    const assertCurrent = (): void => {
      if (this.epoch !== buildEpoch) throw new Error('Code index build superseded during directory reading');
    };
    // Each directory's .gitignore is read once, when the first file below it is checked.
    const isIgnored = createNestedIgnoreMatcher(this.rootDir, diagnostics);
    let scanned: Set<string>;
    try {
      scanned = await collectGlobFiles(this.rootDir, ['**/*'], false, false, diagnostics, walk, { beforeAttempt: assertCurrent });
    } catch (error) {
      if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, 0, skip, this.abortReason());
      throw error;
    }
    if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, scanned.size, skip, this.abortReason());
    // Deterministic order so identical trees always chunk identically (chunking determinism test).
    const candidateFiles = Array.from(scanned).sort();

    const keepPaths = new Set<string>();
    /** Kept paths this build did not re-embed (a budget or an unreadable file): their chunks are from before the build. */
    const keptWithoutEmbedding = new Set<string>();
    let filesIndexed = 0;
    let filesUnchanged = 0;
    let chunksIndexed = 0;
    let chunksUnchanged = 0;
    let totalBytes = 0;
    let acceptedCount = 0;

    for (const absPath of candidateFiles) {
      const rel = relative(this.rootDir, absPath);
      if (isIgnored(absPath)) {
        skip.ignoredByGitignore++;
        continue;
      }

      if (acceptedCount >= maxFiles) {
        skip.overFileCap++;
        // Left out by a budget, not gone: its existing chunks are not a deletion.
        keepPaths.add(rel);
        keptWithoutEmbedding.add(rel);
        continue;
      }

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        skip.readErrors++;
        continue;
      }
      if (stat.size > maxFileBytes) {
        skip.tooLarge++;
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        skip.overTotalBytes++;
        keepPaths.add(rel);
        keptWithoutEmbedding.add(rel);
        continue;
      }
      // One read: the binary verdict comes from the bytes it returned.
      const source = await readCodeIndexFile(this.rootDir, absPath, diagnostics, Math.min(maxFileBytes, maxTotalBytes - totalBytes));
      if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, candidateFiles.length, skip, this.abortReason());
      if (source === 'binary') {
        skip.binary++;
        continue;
      }
      if (source === null) {
        skip.readErrors++;
        // An unreadable file still exists; keep what the index has until it reads again.
        keepPaths.add(rel);
        keptWithoutEmbedding.add(rel);
        continue;
      }

      acceptedCount++;
      totalBytes += source.size;
      keepPaths.add(rel);

      let outcome: { indexed: boolean; mode: CodeChunkMode; chunkCount: number } | null;
      try {
        outcome = await this.indexFileContent(rel, absPath, source, buildEpoch, forceReembed);
      } catch (error) {
        if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, candidateFiles.length, skip, this.abortReason());
        if (error instanceof CodeSourceChangedError) {
          // The file changed (or vanished) while it was being embedded. Its old
          // chunks stay (it is still in keepPaths) and the next edit reindexes
          // it; one busy file must not abandon the rest of the build.
          logger.debug('Code index build skipped a file that changed while indexing', { path: rel, error: summarizeError(error) });
          skip.readErrors++;
          changedDuringBuild++;
          continue;
        }
        // Anything else (embedding provider, storage) is a fault, not a busy file. It is
        // counted on its own and keeps the provider stamp from certifying the index; a run
        // of them means the cause is not this file, so the build stops and says why.
        const message = summarizeError(error);
        failedFiles++;
        consecutiveFailures++;
        firstFailure ??= message;
        logger.warn('Code index build could not index a file', { path: rel, error: message });
        if (consecutiveFailures >= MAX_CONSECUTIVE_INDEX_FAILURES) {
          throw new Error(`stopped after ${consecutiveFailures} files in a row could not be indexed; last error: ${message}`, { cause: error });
        }
        continue;
      }
      consecutiveFailures = 0;
      if (outcome === null) return abortedBuildStats(startedAt, candidateFiles.length, skip, this.abortReason());
      if (outcome.mode === 'window') skip.chunkedByWindow++;
      if (outcome.mode === 'unchanged') {
        filesUnchanged++;
        chunksUnchanged += outcome.chunkCount;
      } else {
        if (outcome.indexed) filesIndexed++;
        chunksIndexed += outcome.chunkCount;
      }

      this.progress = { scanned: acceptedCount, total: candidateFiles.length };
      if (acceptedCount % 20 === 0) {
        await yieldToEventLoop();
        if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, candidateFiles.length, skip, this.abortReason());
      }
    }

    // Final staleness check before the destructive sweep: a stale build's
    // keepPaths describes the OLD tree and must never delete the new one's rows.
    if (this.epoch !== buildEpoch || !this.db) {
      return abortedBuildStats(startedAt, candidateFiles.length, skip, this.abortReason());
    }

    // Sweep: a file that no longer exists (deleted, renamed, or newly gitignored) loses its chunks.
    let filesRemoved = 0;
    const indexedPaths = listIndexedPaths(this.db);
    for (const path of indexedPaths) {
      if (!keepPaths.has(path) && !this.touchedDuringBuild.has(path)) {
        deleteChunksForPath(this.db, path);
        filesRemoved++;
      }
    }
    // A re-embed that kept a file's chunks without embedding them (over a budget,
    // unreadable) leaves vectors of the earlier space: the index is not current.
    const oldSpaceLeft = forceReembed && indexedPaths.some((path) => keptWithoutEmbedding.has(path));
    // The space moved while the build embedded: what it wrote is not all of one space.
    const spaceMoved = this.currentSpace() !== currentProviderId;

    // Stamp provenance only on a COMPLETED build, every chunk that survives
    // to this point is either freshly embedded under currentProviderId or was
    // verified same-provider by the forceReembed logic above.
    // A file skipped mid-re-embed still holds vectors from the old provider,
    // so the stamp is withheld and the mismatch keeps asking for a rebuild.
    // A file that failed for a reason other than changing also still holds old-space vectors.
    if (!(forceReembed && changedDuringBuild > 0) && failedFiles === 0 && !oldSpaceLeft && !spaceMoved) setCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY, currentProviderId);
    this.touchedDuringBuild.clear();

    const completedAt = Date.now();
    const stats: CodeIndexBuildStats = {
      filesScanned: candidateFiles.length,
      filesIndexed,
      filesUnchanged,
      chunksIndexed,
      chunksUnchanged,
      filesRemoved,
      skip: Object.freeze({ ...skip }),
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      ...(failedFiles > 0 ? { filesFailed: failedFiles, firstFailure } : {}),
    };
    this.lastBuild = stats;
    if (failedFiles > 0) {
      this.lastBuildError = `build finished with ${failedFiles} file(s) not indexed; first error: ${firstFailure}`;
    }
    return stats;
  }

  /**
   * Index one file's content. Short-circuits on an unchanged file revision (no re-chunk or re-embed),
   * unless forceReembed is set because the embedding provider changed.
   *
   * Epoch honesty: all of a file's chunks are embedded (every await) BEFORE
   * any row is deleted or written, and the epoch is re-checked after each
   * await, so a close() mid-file aborts with the database untouched for
   * that file (returns null; the caller abandons the build).
   */
  private async indexFileContent(
    relPath: string,
    absPath: string,
    source: CodeFileObservation,
    callEpoch: number,
    forceReembed: boolean,
  ): Promise<{ indexed: boolean; mode: CodeChunkMode; chunkCount: number } | null> {
    const db = this.db;
    if (!db || this.epoch !== callEpoch) return null;
    source.assertCurrent();
    const { content, revision: fileRevision, mtimeMs } = source;
    // Empty files have no chunk row in which to retain a revision. Remove any
    // previous chunks directly, without initializing the parser.
    if (!content.trim()) {
      if (this.epoch !== callEpoch || this.db !== db) return null;
      deleteChunksForPath(db, relPath);
      return { indexed: true, mode: 'empty', chunkCount: 0 };
    }
    // Same bytes as the indexed copy: nothing to chunk or embed.
    const existingRevision = forceReembed ? null : getFileRevision(db, relPath);
    if (existingRevision === fileRevision) {
      source.assertCurrent();
      return { indexed: true, mode: 'unchanged', chunkCount: countChunksForPath(db, relPath) };
    }

    await this.ensureIntelligenceReady();
    if (this.epoch !== callEpoch || this.db !== db) return null;
    source.assertCurrent();
    const { drafts, mode } = await chunkFileContent({
      intelligence: this.intelligence,
      absPath,
      relPath,
      content,
      fileRevision,
      mtimeMs,
      windowLines: this.options.windowLines,
      windowOverlapLines: this.options.windowOverlapLines,
    });
    if (this.epoch !== callEpoch || this.db !== db) return null;
    source.assertCurrent();

    const embeddings: Float32Array[] = [];
    for (let start = 0; start < drafts.length; start += EMBED_BATCH_SIZE) {
      const batch = await this.embedChunksAsync(drafts.slice(start, start + EMBED_BATCH_SIZE).map((draft) => draft.embedText));
      if (this.epoch !== callEpoch || this.db !== db) return null;
      source.assertCurrent();
      embeddings.push(...batch);
    }

    // All awaits are done, the delete+write below is synchronous, so the
    // whole file lands atomically with respect to close().
    if (this.epoch !== callEpoch || this.db !== db) return null;
    source.assertCurrent();
    // One transaction: a failure or a kill here leaves the file's old chunks, never a
    // partial set already carrying the new revision (which a later build would skip as unchanged).
    // The first write into an index that was never stamped records its provider, so a build
    // cut short still knows which vector space it wrote.
    const stampProvider = getCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY) === null && countIndexedChunks(this.db) === 0
      ? this.currentSpace()
      : undefined;
    replaceFileChunks(this.db, relPath, drafts.map((draft, i) => ({ chunk: draft.chunk, embedding: embeddings[i]! })), { stampProvider });
    return { indexed: drafts.length > 0 || mode === 'empty', mode, chunkCount: drafts.length };
  }

  private abortReason(): string {
    return BUILD_ABORTED_BY_CLOSE;
  }

  private async ensureIntelligenceReady(): Promise<void> {
    if (!this.intelligenceReadyPromise) {
      this.intelligenceReadyPromise = this.intelligence.initialize().catch((err) => {
        logger.warn('CodeIndexStore: tree-sitter init failed', { error: summarizeError(err) });
      });
    }
    return this.intelligenceReadyPromise;
  }

  private async embedChunksAsync(texts: readonly string[]): Promise<Float32Array[]> {
    const results = await this.embeddingRegistry.embedManyAsync({
      texts,
      dimensions: MEMORY_VECTOR_DIMS,
      usage: 'record',
    });
    return results.map((result) => normalizeMemoryEmbeddingVector(result.vector, MEMORY_VECTOR_DIMS));
  }
}

function abortedBuildStats(startedAt: number, filesScanned: number, skip: MutableSkipReport, reason: string): CodeIndexBuildStats {
  const completedAt = Date.now();
  logger.warn(`Code index ${reason}`, { filesScanned });
  return {
    filesScanned,
    filesIndexed: 0,
    filesUnchanged: 0,
    chunksIndexed: 0,
    chunksUnchanged: 0,
    filesRemoved: 0,
    skip: Object.freeze({ ...skip }),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    abortReason: reason,
  };
}

function emptyBuildStats(): CodeIndexBuildStats {
  const now = Date.now();
  return {
    filesScanned: 0,
    filesIndexed: 0,
    filesUnchanged: 0,
    chunksIndexed: 0,
    chunksUnchanged: 0,
    filesRemoved: 0,
    skip: emptySkipReport(),
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  };
}
