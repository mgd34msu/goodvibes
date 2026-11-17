/**
 * A SQLite store on a real database file (bun:sqlite), opened once per store.
 *
 * The file is the truth. It runs in WAL mode (sqlite-file.ts), so a reader
 * never waits for a writer and a commit is one append to the WAL; another
 * process's commit is visible to the next statement and is noticed through
 * `PRAGMA data_version`. Nothing is rendered, copied or compared whole: a row
 * read is one indexed statement, a write is one transaction, and the cost of
 * either does not depend on how much the store holds.
 *
 * Writes made with `run()` (or a writing `exec()`) open a transaction that
 * commits when the current synchronous turn ends, or earlier at `save()`.
 * Statements a store method runs back to back therefore land together or not
 * at all, and no lock is held across an `await`. A guarded write
 * (`transactPersisted`, `publishPrepared`) is one immediate transaction: its
 * compare and its write see the same committed rows, whoever wrote them.
 *
 * Existing stores need no conversion: the earlier whole-image files are
 * ordinary SQLite files, and the first open switches them to WAL.
 */
import { createRequire } from 'node:module';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { homeGraphSourceCandidateQuery, type HomeGraphSourceSelector } from '../knowledge/store-homegraph-source-selector.js';
import { homeGraphNodeCandidateQuery, type HomeGraphNodeSelector } from '../knowledge/store-homegraph-node-selector.js';
import { semanticNodeCandidateSql, semanticNodeCandidateParams, semanticIssueCandidateSql, semanticIssueCandidateParams, semanticRefinementTaskCandidateSql, semanticRefinementTaskCandidateParams, type SemanticNodeSelector, type SemanticIssueSelector } from '../knowledge/store-semantic-node-selector.js';
import { semanticFactCandidateSql, semanticFactCandidateParams, type SemanticFactSelector } from '../knowledge/store-semantic-fact-selector.js';
import { inspectPersistedArtifactReferences } from '../knowledge/store-artifact-references.js';
import { generatedProjectionIdentitySql, projectionIdentityParams, type GeneratedProjectionIdentity } from '../knowledge/store-generated-projection-selector.js';
import { activationCacheRowSql, readKnowledgeActivationDependencies, parseKnowledgeActivationCacheRow, type KnowledgeActivationDependencies, type KnowledgeActivationCacheRow } from '../knowledge/store-node-activation-cache.js';
import { queryPersistedPlanningProjects } from '../knowledge/project-planning/persisted-project-query.js';
import { planningSourceIdentityParams, planningSourceIdentitySql, type PlanningSourceIdentity } from '../knowledge/store-planning-source-selector.js';
import { knowledgeRowGenerationFromRows } from '../knowledge/store-row-revisions.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { acquireArtifactReferenceLock } from './artifact-reference-lock.js';
import { adoptSqliteDatabase, type SqliteFile, type SqliteMigration } from './sqlite-file.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// bun:sqlite is a Bun-only builtin; a static import would make every importer
// of this module unloadable under Node. The constructor is resolved on first open.
let databaseCtor: typeof Database | null = null;
function bunDatabase(): typeof Database {
  return (databaseCtor ??= (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database);
}

// The sql.js engine is still used by the inbox retention sweep, which reads
// inactive inbox images without opening them as stores. It loads once per
// process; a failed load clears the memo so the next caller can retry.
let sqlJsEnginePromise: Promise<SqlJsStatic> | null = null;
interface SqlJsStatic { Database: { new (data?: Uint8Array): SqlDatabase; readonly prototype: SqlDatabase } }
export function loadSqlJsEngine(): Promise<SqlJsStatic> {
  sqlJsEnginePromise ??= import('sql.js')
    .then((mod) => mod.default() as Promise<SqlJsStatic>)
    .catch((err: unknown) => { sqlJsEnginePromise = null; throw err; });
  return sqlJsEnginePromise;
}

/** The statement surface every store schema, migration and reader is written against. */
export interface SqlDatabase {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  /** Runs every statement in `sql`; one entry per statement that returned rows. */
  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}
type SqlRows = ReturnType<SqlDatabase['exec']>;

export interface PersistedKnowledgeRecordSelector {
  readonly kind: 'source' | 'node' | 'extraction';
  readonly id: string;
}

const expectedReadsetBrand: unique symbol = Symbol('expected-native-record-readset');
export interface ExpectedKnowledgeRecordReadset { readonly [expectedReadsetBrand]: true }
export interface ExpectedKnowledgeRecordReadsetInput {
  readonly expected: ExpectedKnowledgeRecordReadset;
  readonly selectors: readonly PersistedKnowledgeRecordSelector[];
}
/** What a readset token stands for: the row revisions read when it was issued. */
const expectedReadsets = new WeakMap<ExpectedKnowledgeRecordReadset, {
  readonly store: SQLiteStore;
  readonly selectors: readonly PersistedKnowledgeRecordSelector[];
  readonly generations: readonly (string | null)[];
}>();

/** Why a read or guarded step stopped. Set where it is thrown. */
export type SQLiteObservationRetiredReason =
  /** This process wrote to the store after the step read it. */
  | 'superseded-by-local-write'
  /** Another writer committed, or the rows the step read changed. */
  | 'superseded'
  /** The database could not be read; the cause is attached. */
  | 'read-failed'
  /** A stored row or argument had a shape this build does not read. */
  | 'unsupported-shape'
  /** The store was closed or used outside its contract. */
  | 'invariant';

const RETIRED_MESSAGES: Readonly<Record<SQLiteObservationRetiredReason, string>> = {
  'superseded-by-local-write': 'the store was written by this process after the step read it; read again and retry the step',
  superseded: 'the rows the step read have changed since; read again and retry the step',
  'read-failed': 'the store could not be read; retrying can succeed once the cause is fixed',
  'unsupported-shape': 'a stored row or a selector has a shape this build does not read; retrying will not help',
  invariant: 'the store was closed or used outside its contract; retrying will not help',
};

export class SQLiteObservationRetiredError extends Error {
  readonly reason: SQLiteObservationRetiredReason;
  /** True when reading again and retrying can succeed. */
  readonly retryable: boolean;
  constructor(reason: SQLiteObservationRetiredReason = 'superseded', options?: { readonly cause?: unknown }) {
    super(`SQLiteStore: ${RETIRED_MESSAGES[reason]}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SQLiteObservationRetiredError';
    this.reason = reason;
    this.retryable = reason === 'superseded' || reason === 'superseded-by-local-write' || reason === 'read-failed';
  }
}

/** A guarded write committed, but the caller's follow-up (mirroring the rows) failed. Retrying would repeat the write. */
export class SQLitePublishedButFencedError extends Error {
  constructor(cause: unknown) {
    super('SQLiteStore: the change was committed, but updating this process\'s view of it failed; reopen the store to see it', { cause });
    this.name = 'SQLitePublishedButFencedError';
  }
}

export interface SqliteStoreInitOptions {
  /** Opt in only when `schema` creates the complete target version. Applies to a store with no tables yet. */
  readonly initializeFreshSchema?: boolean | undefined;
  /** Validate an already-current schema before the idempotent base-schema pass, and again after it. */
  readonly validateCurrentSchema?: ((db: SqlDatabase) => void) | undefined;
  /** Human store name for versioning messages. */
  readonly storeName?: string | undefined;
  /** Target `PRAGMA user_version` for this store (default 1). */
  readonly schemaVersion?: number | undefined;
  /**
   * Ordered migrations to the target version, run in one transaction after a
   * consistent copy of the file is taken. When omitted, the base schema
   * function doubles as the single migration (every base schema here is
   * IF NOT EXISTS-idempotent).
   */
  readonly migrations?: ReadonlyArray<{
    readonly toVersion: number;
    readonly migrate: (db: SqlDatabase) => void;
  }> | undefined;
}

export interface SQLiteStoreOptions {
  /** Runs synchronously before each write transaction of a file-backed store; a throw refuses the write. */
  readonly beforePersist?: (() => void) | undefined;
  /** Runs synchronously once, before the store first reads its file. */
  readonly beforeInitialRead?: (() => void) | undefined;
}

type BunStatement = Statement<unknown, SQLQueryBindings[]>;
// The knowledge tables alone prepare about a hundred statements (store-row-table.ts).
const STATEMENT_CACHE_LIMIT = 512;
const SPLIT_CACHE_LIMIT = 256;
const splitCache = new Map<string, readonly string[]>();

function isEphemeralDbPath(path: string | null | undefined): boolean {
  if (!path) return true;
  if (path === ':memory:') return true;
  return /^file:.*(?:^|[?&])mode=memory(?:&|$)/.test(path);
}

/**
 * Split SQL into its statements the way SQLite reads them: a `;` inside a
 * quoted string, an identifier, a comment or a trigger body does not end one.
 */
export function splitSqlStatements(sql: string): readonly string[] {
  const cached = splitCache.get(sql);
  if (cached) return cached;
  const statements: string[] = [];
  let start = 0, words = 0, trigger = false, depth = 0, opened = false, content = false;
  const leading: string[] = [];
  const flush = (end: number) => {
    if (content) statements.push(sql.slice(start, end).trim());
    start = end + 1; words = 0; trigger = false; depth = 0; opened = false; content = false; leading.length = 0;
  };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; continue; }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      content = true;
      for (i++; i < sql.length; i++) {
        if (sql[i] === close) { if (close !== ']' && sql[i + 1] === close) { i++; continue; } break; }
      }
      continue;
    }
    if (ch === ';') {
      if (!trigger || (opened && depth === 0)) flush(i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end++;
      const word = sql.slice(i, end).toUpperCase();
      content = true;
      if (words < 3) {
        leading.push(word); words++;
        if (leading[0] === 'CREATE' && (leading[1] === 'TRIGGER' || ((leading[1] === 'TEMP' || leading[1] === 'TEMPORARY') && leading[2] === 'TRIGGER'))) trigger = true;
      }
      if (trigger) {
        if (word === 'BEGIN') { depth++; opened = true; }
        else if (word === 'CASE') depth++;
        else if (word === 'END') depth--;
      }
      i = end - 1;
      continue;
    }
    if (!/\s/.test(ch)) content = true;
  }
  flush(sql.length);
  const result = Object.freeze(statements);
  if (splitCache.size >= SPLIT_CACHE_LIMIT) splitCache.delete(splitCache.keys().next().value!);
  splitCache.set(sql, result);
  return result;
}

/** A statement that cannot change the database: it needs no write transaction. */
function isReadOnlySql(sql: string): boolean {
  const head = sql.trimStart().slice(0, 16).toUpperCase();
  if (head.startsWith('SELECT') || head.startsWith('EXPLAIN')) return true;
  if (head.startsWith('PRAGMA')) return !sql.includes('=');
  if (head.startsWith('WITH')) return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
  return false;
}

function bindings(params: readonly unknown[] | undefined): SQLQueryBindings[] {
  if (!params?.length) return [];
  return params.map((value) => (value === undefined ? null : value)) as SQLQueryBindings[];
}

function assertSynchronous(check: () => unknown, message: string): void {
  assertSynchronousJudgmentGuard(check, () => new TypeError(message));
}

const KNOWLEDGE_ROW_TABLES = Object.freeze(['knowledge_sources', 'knowledge_nodes', 'knowledge_extractions', 'knowledge_edges'] as const);
type KnowledgeRowTable = typeof KNOWLEDGE_ROW_TABLES[number];

function recordTable(kind: PersistedKnowledgeRecordSelector['kind']): KnowledgeRowTable {
  return kind === 'source' ? 'knowledge_sources' : kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions';
}

function captureSelectors(selectors: readonly PersistedKnowledgeRecordSelector[]): readonly PersistedKnowledgeRecordSelector[] {
  if (!Array.isArray(selectors)) throw new SQLiteObservationRetiredError('unsupported-shape');
  return Object.freeze(selectors.map((selector) => {
    if (!selector || (selector.kind !== 'source' && selector.kind !== 'node' && selector.kind !== 'extraction') || typeof selector.id !== 'string') {
      throw new SQLiteObservationRetiredError('unsupported-shape');
    }
    return Object.freeze({ kind: selector.kind, id: selector.id });
  }));
}

/**
 * Activation bookkeeping: a check that the node row this process wrote is
 * still the one stored. Every read sees this process's own writes, so a row
 * that is still stored is never "pending" to a reader.
 */
export function captureSQLiteActivationPublication(store: SQLiteStore, nodeId: string, generation: string): () => 'pending' | 'published' {
  const check = (): 'published' => {
    if (store.readPersistedRowGeneration('knowledge_nodes', 'id', nodeId) !== generation) throw new SQLiteObservationRetiredError('superseded');
    return 'published';
  };
  check();
  return check;
}

/** Project ids recorded in a knowledge database image (a byte copy of the file). */
export function inspectNativePlanningProjectImage(data: Uint8Array, assertCurrent: () => void): Promise<readonly string[]> {
  assertSynchronous(assertCurrent, 'SQLiteStore: the owner check must be synchronous');
  const image = bunDatabase().deserialize(data, true);
  try {
    const ids = queryPersistedPlanningProjects(statementDatabase(image));
    assertSynchronous(assertCurrent, 'SQLiteStore: the owner check must be synchronous');
    return Promise.resolve(ids);
  } catch (error) { return Promise.reject(error); }
  finally { image.close(); }
}

/**
 * Artifact references in a byte copy of a knowledge file. A byte copy cannot
 * include commits still in the file's WAL, so it cannot prove an artifact is
 * unreferenced: every requested id is reported referenced, which keeps the
 * artifact. Read through the file (`inspectArtifactReferencesFile`) instead.
 */
export function inspectNativeArtifactReferenceImage(_data: Uint8Array, ids: readonly string[], assertCurrent: () => void): Promise<readonly string[]> {
  assertSynchronous(assertCurrent, 'SQLiteStore: the owner check must be synchronous');
  return Promise.resolve(Object.freeze([...ids]));
}

/** Open a knowledge file that no store in this process holds, read from it, close it. Never creates the file. */
function withFileDatabase<T>(path: string, read: (db: SqlDatabase) => T): T {
  const db = new (bunDatabase())(path, { create: false });
  try {
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA query_only = 1');
    return read(statementDatabase(db));
  } finally { db.close(); }
}

/** Project ids recorded in the knowledge file at `path`, committed WAL content included. */
export function inspectPlanningProjectsFile(path: string): readonly string[] {
  return withFileDatabase(path, queryPersistedPlanningProjects);
}

/** Which of `ids` the knowledge file at `path` references, committed WAL content included. */
export function inspectArtifactReferencesFile(path: string, ids: readonly string[]): readonly string[] {
  return withFileDatabase(path, (db) => inspectPersistedArtifactReferences(db, ids));
}

/** A plain statement surface over a handle: each write commits on its own. */
function statementDatabase(db: Database): SqlDatabase {
  return {
    run(sql, params) {
      if (!params?.length) { db.run(sql); return; }
      const statement = db.prepare(sql) as unknown as BunStatement;
      try { statement.run(...bindings(params)); } finally { statement.finalize(); }
    },
    exec(sql, params) {
      const results: SqlRows = [];
      for (const text of splitSqlStatements(sql)) {
        const statement = db.prepare(text) as unknown as BunStatement;
        try {
          const values = (statement.values(...bindings(params)) ?? []) as unknown[][];
          if (values.length) results.push({ columns: [...statement.columnNames], values });
        } finally { statement.finalize(); }
      }
      return results;
    },
    export() { return db.serialize(); },
    close() { db.close(); },
  };
}

export class SQLiteStore {
  #file: SqliteFile | null = null;
  #db: Database | null = null;
  readonly #statements = new Map<string, BunStatement>();
  #dataVersion: BunStatement | null = null;
  #implicit = false;
  #commitFailure: unknown;
  #closedMessage: string | undefined;
  #readEpoch = 0;
  #epochDataVersion = -1;
  #epochTurnChecked = false;
  readonly #adapter: SqlDatabase;
  private readonly dbPath: string | null;
  private initPromise: Promise<void> | null = null;
  private saveBatchDepth = 0;
  private readonly activeBatches = new Set<Promise<void>>();
  private readonly beforePersist: (() => void) | undefined;
  private readonly beforeInitialRead: (() => void) | undefined;
  private readonly artifactReferenceCleanListeners = new Set<() => void>();

  constructor(dbPath?: string, options: SQLiteStoreOptions = {}) {
    this.beforePersist = options.beforePersist?.bind(options);
    this.beforeInitialRead = options.beforeInitialRead?.bind(options);
    this.dbPath = dbPath ?? null;
    this.#adapter = {
      run: (sql, params) => this.run(sql, params),
      exec: (sql, params) => this.exec(sql, params),
      export: () => this.getDb().serialize(),
      close: () => { throw new TypeError('SQLiteStore: close the store, not the statement surface'); },
    };
  }

  get isReady(): boolean {
    return this.#db !== null;
  }

  /** The on-disk database path, or null for an ephemeral/in-memory store. */
  get databasePath(): string | null {
    return this.dbPath;
  }

  async init(schema: (db: SqlDatabase) => void, options: SqliteStoreInitOptions = {}): Promise<void> {
    if (this.#db) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = Promise.resolve().then(() => this.initialize(schema, options));
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    const db = this.getDb();
    this.#readEpoch += 1;
    this.#beginWrite();
    if (params?.length) this.#statement(sql).run(...bindings(params));
    else db.run(sql);
  }

  exec(sql: string, params?: (string | number)[]): SqlRows {
    this.getDb();
    const statements = splitSqlStatements(sql);
    if (statements.some((text) => !isReadOnlySql(text))) {
      this.#readEpoch += 1;
      this.#beginWrite();
    }
    const results: SqlRows = [];
    for (const text of statements) {
      const statement = this.#statement(text);
      const values = (statement.values(...bindings(params)) ?? []) as unknown[][];
      if (values.length) results.push({ columns: [...statement.columnNames], values });
    }
    return results;
  }

  /**
   * Moves on every change of the stored content: each row this process
   * changes, and each commit by another process (seen through
   * `data_version`). It only moves up.
   */
  contentRevision(): number {
    return this.#file?.revision() ?? 0;
  }

  /**
   * A number that moves whenever a row this connection reads may differ from
   * the last read: every write or rollback by this process, and another
   * process's commit. The commit check (`PRAGMA data_version`, one statement)
   * runs once per turn that asks, so within one synchronous turn the rows
   * other processes committed are read as of the turn's first ask.
   */
  readEpoch(): number {
    if (!this.#epochTurnChecked && this.#db) {
      this.#epochTurnChecked = true;
      queueMicrotask(() => { this.#epochTurnChecked = false; });
      const version = this.dataVersion();
      if (version !== this.#epochDataVersion) {
        this.#epochDataVersion = version;
        this.#readEpoch += 1;
      }
    }
    return this.#readEpoch;
  }

  /** SQLite's count of commits by other connections, as this connection last saw it. */
  dataVersion(): number {
    if (!this.#db) return 0;
    this.#dataVersion ??= this.#db.prepare('PRAGMA data_version') as unknown as BunStatement;
    const value = (this.#dataVersion.values() ?? [])[0]?.[0];
    return typeof value === 'number' ? value : 0;
  }

  /**
   * A check that throws once anything in the store changed: a row this process
   * wrote, or another process's commit. Conservative: an unrelated change also
   * retires it.
   */
  captureObservation(): () => void {
    const db = this.getDb();
    const changes = this.#totalChanges(), version = this.dataVersion();
    return () => {
      if (this.#db !== db) throw new SQLiteObservationRetiredError('invariant');
      if (this.#totalChanges() !== changes) throw new SQLiteObservationRetiredError('superseded-by-local-write');
      if (this.dataVersion() !== version) throw new SQLiteObservationRetiredError('superseded');
    };
  }

  /** Read the stored rows through the statement surface. */
  readPersisted<T>(read: (db: SqlDatabase) => T): T {
    this.getDb();
    return read(this.#adapter);
  }

  readPersistedRow(table: KnowledgeRowTable, column: 'id' | 'canonical_uri', value: string): SqlRows {
    this.#assertRowSelector(table, column, value);
    return this.#read(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`, [value]);
  }

  readPersistedPlanningSource(identity: PlanningSourceIdentity): SqlRows {
    return this.#read(planningSourceIdentitySql, planningSourceIdentityParams(identity));
  }

  readHomeGraphNodeCandidates(selector: HomeGraphNodeSelector): SqlRows {
    const query = homeGraphNodeCandidateQuery(selector);
    return this.#read(query.sql, query.params);
  }

  readHomeGraphSourceCandidates(selector: HomeGraphSourceSelector): SqlRows {
    const query = homeGraphSourceCandidateQuery(selector);
    return this.#read(query.sql, query.params);
  }

  readPersistedSemanticNodeCandidates(selector: SemanticNodeSelector): SqlRows {
    return this.#read(semanticNodeCandidateSql, semanticNodeCandidateParams(selector));
  }

  readPersistedSemanticIssueCandidates(selector: SemanticIssueSelector): SqlRows {
    return this.#read(semanticIssueCandidateSql, semanticIssueCandidateParams(selector));
  }

  readPersistedSemanticRefinementTaskCandidates(spaceId: string, gapId: string): SqlRows {
    return this.#read(semanticRefinementTaskCandidateSql, semanticRefinementTaskCandidateParams(spaceId, gapId));
  }

  readPersistedSemanticEnrichmentState(sourceId: string): SqlRows {
    if (typeof sourceId !== 'string' || !sourceId) throw new SQLiteObservationRetiredError('unsupported-shape');
    return this.#read('SELECT * FROM knowledge_semantic_enrichment_state WHERE source_id = ? LIMIT 1', [sourceId]);
  }

  readPersistedSemanticFactCandidates(selector: SemanticFactSelector): SqlRows {
    return this.#read(semanticFactCandidateSql, semanticFactCandidateParams(selector));
  }

  readSemanticFactIdentityCandidates(selector: SemanticFactSelector): SqlRows {
    return this.#read(semanticFactCandidateSql, semanticFactCandidateParams(selector));
  }

  readPersistedGeneratedProjectionSource(identity: GeneratedProjectionIdentity): SqlRows {
    return this.#read(generatedProjectionIdentitySql, projectionIdentityParams(identity));
  }

  /** The row's revision (`gv_revision`), or null when the row does not exist. */
  readPersistedRowGeneration(table: KnowledgeRowTable, column: 'id' | 'canonical_uri', value: string): string | null {
    this.#assertRowSelector(table, column, value);
    return knowledgeRowGenerationFromRows(this.#read(`SELECT gv_revision FROM ${table} WHERE ${column} = ? LIMIT 1`, [value]));
  }

  readPersistedNodeHistorySelection(nodeId: string, revisionId: string | null): {
    readonly first: SqlRows;
    readonly latest: SqlRows;
    readonly selected: SqlRows;
  } {
    if (typeof nodeId !== 'string' || (revisionId !== null && typeof revisionId !== 'string')) throw new SQLiteObservationRetiredError('unsupported-shape');
    let result: { first: SqlRows; latest: SqlRows; selected: SqlRows } | undefined;
    this.assertPersistedReadFrame(() => {
      result = {
        first: this.#read('SELECT id FROM knowledge_node_revisions WHERE node_id = ? ORDER BY revision ASC LIMIT 1', [nodeId]),
        latest: this.#read('SELECT id FROM knowledge_node_revisions WHERE node_id = ? ORDER BY revision DESC LIMIT 1', [nodeId]),
        selected: revisionId === null ? [] : this.#read('SELECT * FROM knowledge_node_revisions WHERE id = ? AND node_id = ? LIMIT 1', [revisionId, nodeId]),
      };
      return undefined;
    });
    return result!;
  }

  readPersistedNodeActivationCache(nodeId: string): KnowledgeActivationCacheRow | null {
    if (typeof nodeId !== 'string') throw new SQLiteObservationRetiredError('unsupported-shape');
    return parseKnowledgeActivationCacheRow(this.#read(activationCacheRowSql, [nodeId]));
  }

  /** A node's stored activation dependencies and cache row, read in one snapshot. */
  readPersistedNodeActivationState(nodeId: string, selectors: readonly PersistedKnowledgeRecordSelector[], observation: string | null): {
    readonly dependencies: KnowledgeActivationDependencies; readonly cache: KnowledgeActivationCacheRow | null;
  } {
    if (typeof nodeId !== 'string' || (observation !== null && typeof observation !== 'string')) throw new SQLiteObservationRetiredError('unsupported-shape');
    const captured = captureSelectors(selectors);
    if (captured.some((selector) => selector.kind === 'extraction')) throw new SQLiteObservationRetiredError('unsupported-shape');
    let state: { dependencies: KnowledgeActivationDependencies; cache: KnowledgeActivationCacheRow | null } | undefined;
    this.assertPersistedReadFrame(() => {
      const reader = { exec: (sql: string, parameters: (string | number)[] = []) => this.#read(sql, parameters) };
      state = {
        dependencies: readKnowledgeActivationDependencies(reader, nodeId,
          captured.filter((selector) => selector.kind === 'source').map((selector) => selector.id),
          captured.filter((selector) => selector.kind === 'node').map((selector) => selector.id), observation),
        cache: parseKnowledgeActivationCacheRow(this.#read(activationCacheRowSql, [nodeId])),
      };
      return undefined;
    });
    return state!;
  }

  /** Row revisions for each selector, in selector order, read in one snapshot. */
  readPersistedRecordGenerations(selectors: readonly PersistedKnowledgeRecordSelector[]): readonly (string | null)[] {
    const captured = captureSelectors(selectors);
    let generations: readonly (string | null)[] = [];
    this.assertPersistedReadFrame(() => {
      generations = Object.freeze(captured.map((selector) => this.readPersistedRowGeneration(recordTable(selector.kind), 'id', selector.id)));
      return undefined;
    });
    return generations;
  }

  /** Edge row revisions, in id order, read in one snapshot. */
  readPersistedEdgeGenerations(ids: readonly string[]): readonly (string | null)[] {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new SQLiteObservationRetiredError('unsupported-shape');
    let generations: readonly (string | null)[] = [];
    this.assertPersistedReadFrame(() => {
      generations = Object.freeze(ids.map((id) => this.readPersistedRowGeneration('knowledge_edges', 'id', id)));
      return undefined;
    });
    return generations;
  }

  /** Issue a token for the current revisions of these rows; `matchesExpectedRecordReadsets` compares against it later. */
  captureExpectedRecordReadset(selectors: readonly PersistedKnowledgeRecordSelector[]): {
    readonly expected: ExpectedKnowledgeRecordReadset;
    readonly originalGenerations: readonly (string | null)[];
  } {
    return this.captureExpectedRecordReadsets([selectors])[0]!;
  }

  captureExpectedRecordReadsets(groups: readonly (readonly PersistedKnowledgeRecordSelector[])[]): readonly ReturnType<SQLiteStore['captureExpectedRecordReadset']>[] {
    if (!Array.isArray(groups)) throw new SQLiteObservationRetiredError('unsupported-shape');
    const captured = groups.map(captureSelectors);
    let result: readonly ReturnType<SQLiteStore['captureExpectedRecordReadset']>[] = [];
    this.assertPersistedReadFrame(() => {
      result = Object.freeze(captured.map((selectors) => {
        const generations = this.readPersistedRecordGenerations(selectors);
        const expected = Object.freeze<ExpectedKnowledgeRecordReadset>({ [expectedReadsetBrand]: true });
        expectedReadsets.set(expected, Object.freeze({ store: this, selectors, generations }));
        return Object.freeze({ expected, originalGenerations: generations });
      }));
      return undefined;
    });
    return result;
  }

  /** For each input, whether every row still has the revision it had when the token was issued. */
  matchesExpectedRecordReadsets(inputs: readonly ExpectedKnowledgeRecordReadsetInput[]): readonly boolean[] {
    if (!Array.isArray(inputs)) throw new SQLiteObservationRetiredError('unsupported-shape');
    const retained = inputs.map((input) => {
      const entry = input && expectedReadsets.get(input.expected);
      const selectors = input ? captureSelectors(input.selectors) : [];
      if (!entry || entry.store !== this || entry.selectors.length !== selectors.length
        || entry.selectors.some((selector: PersistedKnowledgeRecordSelector, index: number) => selector.kind !== selectors[index]?.kind || selector.id !== selectors[index]?.id)) {
        throw new TypeError('SQLiteStore: expected readset does not belong to this selection');
      }
      return entry;
    });
    let matches: readonly boolean[] = [];
    this.assertPersistedReadFrame(() => {
      matches = Object.freeze(retained.map((entry) => {
        const current = this.readPersistedRecordGenerations(entry.selectors);
        return current.every((generation, index) => generation === entry.generations[index]);
      }));
      return undefined;
    });
    return matches;
  }

  readPersistedEdgeRows(): SqlRows {
    return this.#read('SELECT * FROM knowledge_edges', []);
  }

  readPersistedEdgeWindowGeneration(keys: readonly string[], incidentKeys?: readonly string[], includeUnselectedEndpoints = false): SqlRows {
    if ([...keys, ...(incidentKeys ?? [])].some((key) => typeof key !== 'string' || (!key.startsWith('source:') && !key.startsWith('node:')))) {
      throw new SQLiteObservationRetiredError('unsupported-shape');
    }
    if (typeof includeUnselectedEndpoints !== 'boolean' || (includeUnselectedEndpoints && !incidentKeys?.length)) throw new SQLiteObservationRetiredError('unsupported-shape');
    const slots = (values: readonly string[]) => values.map(() => '?').join(',');
    const from = "(from_kind || ':' || from_id)", to = "(to_kind || ':' || to_id)";
    const endpoints = includeUnselectedEndpoints ? '1' : keys.length ? `${from} IN (${slots(keys)}) AND ${to} IN (${slots(keys)})` : '0';
    const incident = incidentKeys ? incidentKeys.length
      ? ` AND (${from} IN (${slots(incidentKeys)}) OR ${to} IN (${slots(incidentKeys)}))` : ' AND 0' : '';
    return this.#read(`SELECT CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM knowledge_edge_changes WHERE ${endpoints}${incident}`,
      [...(includeUnselectedEndpoints ? [] : [...keys, ...keys]), ...(incidentKeys ?? []), ...(incidentKeys ?? [])]);
  }

  /**
   * Run synchronous reads against one consistent snapshot of the committed
   * rows. Nested frames, and frames inside a write, share the enclosing one.
   */
  assertPersistedReadFrame(assertion: () => undefined): void {
    const db = this.getDb();
    const invoke = () => assertSynchronous(assertion, 'SQLiteStore: persisted read assertions must be synchronous and return no value');
    if (db.inTransaction) { invoke(); return; }
    db.run('BEGIN');
    try { invoke(); }
    finally { if (db.inTransaction) db.run('COMMIT'); }
  }

  /**
   * Compare and write in one immediate transaction: `operation` reads the
   * committed rows (another process cannot commit in between) and writes.
   * `onCommit` mirrors the change after it committed; `afterDurable` runs
   * after that, in the same turn.
   */
  transactPersisted<T>(
    operation: (db: SqlDatabase) => { readonly changed: boolean; readonly value: T },
    onCommit: () => void,
    afterDurable?: ((value: T, db: SqlDatabase) => void) | undefined,
  ): Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: T; readonly fenced?: true }> {
    let decision: { readonly changed: boolean; readonly value: T } | undefined;
    try {
      this.#writeTransaction(() => {
        const result: unknown = operation(this.#adapter);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          if (result instanceof Promise) void result.catch(() => {});
          throw new TypeError('SQLiteStore: decision must be synchronous');
        }
        if (!result || typeof (result as { changed?: unknown }).changed !== 'boolean') throw new TypeError('SQLiteStore: invalid decision');
        decision = result as { readonly changed: boolean; readonly value: T };
      });
    } catch (error) { return Promise.reject(error); }
    const settled = decision!;
    let fenced = false;
    if (settled.changed) {
      try { onCommit(); } catch (error) {
        fenced = true;
        logger.warn('SQLiteStore: a committed change could not be mirrored', { path: this.dbPath, error: summarizeError(error) });
      }
    }
    if (afterDurable) {
      try { assertSynchronous(() => afterDurable(settled.value, this.#adapter), 'SQLiteStore: durable boundary must be synchronous'); }
      catch (error) { return Promise.reject(error); }
    }
    this.notifyArtifactReferenceClean();
    return Promise.resolve(fenced ? { kind: 'completed' as const, value: settled.value, fenced: true as const } : { kind: 'completed' as const, value: settled.value });
  }

  /** Host lifecycle notification only: listeners run after a change committed outside a batch. */
  subscribeArtifactReferenceClean(listener: () => void): () => void {
    this.artifactReferenceCleanListeners.add(listener);
    return () => { this.artifactReferenceCleanListeners.delete(listener); };
  }

  private notifyArtifactReferenceClean(): void {
    if (this.saveBatchDepth > 0) return;
    for (const listener of this.artifactReferenceCleanListeners) {
      try { assertSynchronous(listener, 'Artifact cleanup listener must be synchronous.'); }
      catch { logger.warn('Artifact cleanup notification was not accepted.'); }
    }
  }

  /**
   * Read which of `ids` this store references and run `operation` while the
   * artifact reference lock is held (it excludes other cleaners, in this
   * process and others). `assertCurrent` throws once anything in the store
   * changed since the references were read; call it before the step that
   * cannot be undone.
   */
  withArtifactReferenceReads<T>(ids: readonly string[], operation: (referenced: readonly string[], assertCurrent: () => void) => Promise<T>): Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: T }> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      throw new TypeError('SQLiteStore: invalid artifact reference batch');
    }
    const selected = Object.freeze([...ids]);
    if (this.saveBatchDepth > 0) return Promise.resolve({ kind: 'local-changes' as const });
    return (async () => {
      const path = isEphemeralDbPath(this.dbPath) ? null : this.dbPath;
      const lock = path ? await acquireArtifactReferenceLock(path, () => {}) : { assertCurrent() {}, release() {} };
      if (!lock) return { kind: 'local-changes' as const };
      try {
        this.#commitPending();
        const observation = this.captureObservation();
        const assertCurrent = () => {
          lock.assertCurrent();
          if (this.saveBatchDepth > 0) throw new SQLiteObservationRetiredError('superseded-by-local-write');
          observation();
        };
        const referenced = inspectPersistedArtifactReferences(this.#adapter, selected);
        assertCurrent();
        const value = await operation(referenced, assertCurrent);
        assertCurrent();
        return { kind: 'completed' as const, value };
      } finally { lock.release(); }
    })();
  }

  /**
   * Write `operation` in one immediate transaction, after `assertCurrent`
   * passed inside it; then `onCommit` mirrors the change. A throw anywhere
   * before the commit leaves the store as it was.
   */
  publishPrepared(operation: (db: SqlDatabase) => void, assertCurrent: () => void, onCommit: () => void): Promise<void> {
    try {
      assertSynchronous(assertCurrent, 'SQLiteStore: the currency check must be synchronous');
      this.#writeTransaction(() => {
        assertSynchronous(assertCurrent, 'SQLiteStore: the currency check must be synchronous');
        assertSynchronous(() => operation(this.#adapter), 'SQLiteStore: prepared operation must be synchronous and return no value');
        assertSynchronous(assertCurrent, 'SQLiteStore: the currency check must be synchronous');
      });
    } catch (error) { return Promise.reject(error); }
    try { onCommit(); } catch (error) { return Promise.reject(new SQLitePublishedButFencedError(error)); }
    this.notifyArtifactReferenceClean();
    return Promise.resolve();
  }

  /**
   * The rows are always read from the file, so there is nothing to reload in
   * SQL; `onReload` rebuilds whatever the caller keeps beside it.
   */
  reloadFromDisk(onReload: () => void = () => {}): Promise<boolean> {
    if (!this.#db) return Promise.resolve(false);
    try { this.#commitPending(); onReload(); } catch (error) { return Promise.reject(error); }
    return Promise.resolve(true);
  }

  /** Drain running batches before owner teardown. */
  async settled(): Promise<void> {
    while (this.activeBatches.size > 0) await Promise.all([...this.activeBatches]);
  }

  /**
   * Run `operation`; artifact cleanup waits until it ends. Every write inside
   * commits as it is made (see the module comment); a batch adds no lock.
   */
  async batch<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const owned = new Promise<void>((resolve) => { release = resolve; });
    this.activeBatches.add(owned);
    this.saveBatchDepth += 1;
    try {
      return await operation();
    } finally {
      this.saveBatchDepth -= 1;
      this.activeBatches.delete(owned);
      release();
      if (this.saveBatchDepth === 0) {
        try { this.#commitPending(); } catch (error) { logger.warn('SQLiteStore: a write could not be committed', { path: this.dbPath, error: summarizeError(error) }); }
        this.notifyArtifactReferenceClean();
      }
    }
  }

  /**
   * Commit what this turn wrote. Resolves true for a file-backed store; throws
   * when the commit (here or at the end of an earlier turn) failed, so the
   * write that was lost is reported by the call that saves it.
   */
  async save(): Promise<boolean> {
    if (!this.#db) return false;
    this.#commitPending();
    const failure = this.#commitFailure;
    if (failure !== undefined) {
      this.#commitFailure = undefined;
      throw failure;
    }
    this.notifyArtifactReferenceClean();
    return !isEphemeralDbPath(this.dbPath);
  }

  close(reason?: string): void {
    if (!this.#db) { if (reason) this.#closedMessage = reason; return; }
    try { this.#commitPending(); } catch (error) { logger.warn('SQLiteStore: the last write could not be committed at close', { path: this.dbPath, error: summarizeError(error) }); }
    for (const statement of this.#statements.values()) { try { statement.finalize(); } catch { /* the handle closes below */ } }
    this.#statements.clear();
    try { this.#dataVersion?.finalize(); } catch { /* the handle closes below */ }
    this.#dataVersion = null;
    const file = this.#file;
    this.#file = null;
    this.#db = null;
    this.#closedMessage = reason;
    this.#readEpoch += 1;
    file?.close();
  }

  private async initialize(schema: (db: SqlDatabase) => void, options: SqliteStoreInitOptions): Promise<void> {
    const path = this.dbPath;
    const persistent = !isEphemeralDbPath(path);
    const target = options.schemaVersion ?? 1;
    const storeName = options.storeName ?? 'sqlite store';
    assertSynchronous(() => this.beforeInitialRead?.(), 'SQLiteStore: initial read owner must complete synchronously');
    if (persistent) mkdirSync(dirname(path!), { recursive: true });
    const existed = persistent && existsSync(path!);
    // The store holds user content: a new file is private to its owner, and
    // SQLite gives its WAL and shared-memory files the same mode.
    if (persistent && !existed) closeSync(openSync(path!, 'a', 0o600));
    const db = new (bunDatabase())(persistent ? path! : ':memory:', { create: true });
    try {
      const plain = statementDatabase(db);
      const scalar = (sql: string) => Number(plain.exec(sql)[0]?.values[0]?.[0] ?? 0);
      let tables: number;
      try { tables = scalar('SELECT count(*) FROM sqlite_master'); }
      catch (error) { throw new Error(`${storeName}: ${path} is not a readable SQLite database (${summarizeError(error)}). Move it aside to start an empty store.`, { cause: error }); }
      const version = scalar('PRAGMA user_version');
      const steps: SqliteMigration[] = tables === 0 && options.initializeFreshSchema === true
        ? [{ toVersion: target, up: () => schema(plain) }]
        : options.migrations?.length
          ? options.migrations.map((step) => ({ toVersion: step.toVersion, up: () => step.migrate(plain) }))
          : [{ toVersion: target, up: () => schema(plain) }];
      if (!steps.some((step) => step.toVersion === target)) steps.push({ toVersion: target, up: () => {} });
      // An already-current file is checked as it is, before the base schema
      // pass could recreate something that should have been there.
      if (tables > 0 && version === target) options.validateCurrentSchema?.(plain);
      const file = adoptSqliteDatabase(db, persistent ? path! : ':memory:', { migrations: steps, name: storeName, foreignKeys: false });
      schema(plain);
      options.validateCurrentSchema?.(plain);
      this.#file = file;
      this.#db = db;
      this.#closedMessage = undefined;
      logger.info(existed ? 'SQLiteStore: opened' : 'SQLiteStore: created', { path: persistent ? path : ':memory:' });
    } catch (error) {
      try { db.close(); } catch { /* already failing */ }
      logger.error('SQLiteStore: failed to initialize', { path, error: summarizeError(error) });
      throw error;
    }
  }

  private getDb(): Database {
    if (!this.#db) throw new Error(this.#closedMessage ?? 'SQLiteStore: not initialized, call init() first');
    return this.#db;
  }

  #statement(sql: string): BunStatement {
    let statement = this.#statements.get(sql);
    if (statement) {
      this.#statements.delete(sql);
      this.#statements.set(sql, statement);
      return statement;
    }
    statement = this.getDb().prepare(sql) as unknown as BunStatement;
    if (this.#statements.size >= STATEMENT_CACHE_LIMIT) {
      const [oldest, evicted] = this.#statements.entries().next().value!;
      this.#statements.delete(oldest);
      try { evicted.finalize(); } catch { /* finalized with the handle */ }
    }
    this.#statements.set(sql, statement);
    return statement;
  }

  #read(sql: string, params: readonly (string | number)[]): SqlRows {
    try {
      const statement = this.#statement(sql);
      const values = (statement.values(...bindings(params)) ?? []) as unknown[][];
      return values.length ? [{ columns: [...statement.columnNames], values }] : [];
    } catch (error) {
      if (!this.#db) throw new SQLiteObservationRetiredError('invariant', { cause: error });
      throw new SQLiteObservationRetiredError('read-failed', { cause: error });
    }
  }

  #assertRowSelector(table: string, column: string, value: unknown): void {
    if (!KNOWLEDGE_ROW_TABLES.includes(table as KnowledgeRowTable)
      || (column !== 'id' && !(table === 'knowledge_sources' && column === 'canonical_uri'))
      || typeof value !== 'string') throw new SQLiteObservationRetiredError('unsupported-shape');
  }

  #totalChanges(): number {
    const value = (this.#statement('SELECT total_changes()').values() ?? [])[0]?.[0];
    return typeof value === 'number' ? value : 0;
  }

  /** Open this turn's write transaction unless one is open; it commits when the turn ends. */
  #beginWrite(): void {
    const db = this.getDb();
    if (db.inTransaction) return;
    if (!isEphemeralDbPath(this.dbPath)) assertSynchronous(() => this.beforePersist?.(), 'SQLiteStore: persistence owner must complete synchronously');
    db.run('BEGIN IMMEDIATE');
    this.#implicit = true;
    queueMicrotask(() => {
      try { this.#commitPending(); }
      catch (error) {
        this.#commitFailure = error;
        logger.error('SQLiteStore: a write could not be committed', { path: this.dbPath, error: summarizeError(error) });
      }
    });
  }

  #commitPending(): void {
    if (!this.#implicit) return;
    this.#implicit = false;
    const db = this.#db;
    if (!db?.inTransaction) return;
    try { db.run('COMMIT'); }
    catch (error) {
      this.#readEpoch += 1;
      try { if (db.inTransaction) db.run('ROLLBACK'); } catch { /* the failure below is what matters */ }
      throw error;
    }
  }

  /** One immediate transaction for a guarded write; this turn's pending writes commit first. */
  #writeTransaction(body: () => void): void {
    this.#commitPending();
    const db = this.getDb();
    if (!isEphemeralDbPath(this.dbPath)) assertSynchronous(() => this.beforePersist?.(), 'SQLiteStore: persistence owner must complete synchronously');
    // A body that throws rolls back what it wrote; the epoch moves either way.
    try {
      if (db.inTransaction) { body(); return; }
      db.transaction(body).immediate();
    } finally { this.#readEpoch += 1; }
  }
}
