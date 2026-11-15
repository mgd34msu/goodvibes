import { unlinkSync } from 'node:fs';
import { knowledgeSchemaColumns } from './store-schema-validation-data.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { readKnowledgeSourceSnapshot } from './store-source-generation.js';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { createEmptyWorkLedgerState, migrateLegacyWorkLedgerState } from '../workflow/work-ledger/service.js';
import { workLedgerStateSchema, type WorkLedgerDecision, type WorkLedgerState, type WorkLedgerStorage, type WorkLedgerTransactionContext } from '../workflow/work-ledger/types.js';

export interface KnowledgeWorkLedgerStorage extends WorkLedgerStorage {
  /** Stop observations/admissions and drain admitted storage work. Does not close KnowledgeStore. */
  close(): Promise<void>;
}

const WORK_LEDGER_EVENTS_TABLE = 'CREATE TABLE IF NOT EXISTS work_ledger_events (project_id TEXT NOT NULL, sequence INTEGER NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (project_id, sequence))';

export function createWorkLedgerTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS work_ledgers (project_id TEXT PRIMARY KEY NOT NULL, format_version INTEGER NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)');
  db.run(WORK_LEDGER_EVENTS_TABLE);
}

/**
 * Format 3 keeps the ledger's current records (works, attempts, evidence) in its
 * `work_ledgers` row and each history event once, as its own `work_ledger_events`
 * row with the receipt fields beside it. A command appends its events and replaces
 * the small row; nothing it writes grows with the length of the history. Format 2
 * (the whole ledger, every event twice, in one row) is still read and becomes
 * format 3 on its next write.
 */
const WORK_LEDGER_FORMAT = 3;

/** The stored ledger as written, history and receipts included, before any validation. */
export function readKnowledgeWorkLedgerImage(db: Pick<SqlDatabase, 'exec'>, projectId: string, format: unknown, image: unknown): unknown {
  if (typeof image !== 'string') throw new Error('Work ledger persisted format is invalid');
  if (format === 2) return JSON.parse(image);
  if (format !== WORK_LEDGER_FORMAT) throw new Error('Work ledger persisted format is invalid');
  const head: unknown = JSON.parse(image);
  if (!head || typeof head !== 'object' || Array.isArray(head)) throw new Error('Work ledger persisted format is invalid');
  const history: unknown[] = [];
  const receipts: unknown[] = [];
  for (const row of db.exec('SELECT actor_id, request_id, signature, event_json FROM work_ledger_events WHERE project_id = ? ORDER BY sequence', [projectId])[0]?.values ?? []) {
    if (typeof row[3] !== 'string') throw new Error('Work ledger persisted format is invalid');
    const event: unknown = JSON.parse(row[3]);
    history.push(event);
    receipts.push({ actorId: row[0], requestId: row[1], signature: row[2], event });
  }
  return { ...head, history, receipts };
}

/**
 * Write `next`, which extends the stored ledger: the events after the stored
 * revision are appended and the ledger row is replaced. A format 2 row is
 * rewritten as format 3 once, all its events included.
 */
export function writeKnowledgeWorkLedger(db: Pick<SqlDatabase, 'exec' | 'run'>, next: WorkLedgerState): void {
  if ((db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_ledger_events'")[0]?.values.length ?? 0) === 0) db.run(WORK_LEDGER_EVENTS_TABLE);
  const head = db.exec('SELECT format_version, revision FROM work_ledgers WHERE project_id = ?', [next.projectId])[0]?.values[0];
  const appended = head?.[0] === WORK_LEDGER_FORMAT ? Number(head[1]) : 0;
  if (appended > next.revision || next.history.length !== next.revision || next.receipts.length !== next.revision) throw new Error('Work ledger commit does not extend the current history');
  if (appended === 0) db.run('DELETE FROM work_ledger_events WHERE project_id = ?', [next.projectId]);
  for (let index = appended; index < next.revision; index++) {
    const event = next.history[index]!;
    const receipt = next.receipts[index]!;
    db.run('INSERT INTO work_ledger_events(project_id, sequence, actor_id, request_id, signature, event_json) VALUES (?, ?, ?, ?, ?, ?)',
      [next.projectId, event.sequence, receipt.actorId, receipt.requestId, receipt.signature, JSON.stringify(event)]);
  }
  const { history: _history, receipts: _receipts, ...current } = next;
  db.run('INSERT INTO work_ledgers(project_id, format_version, revision, state_json) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET format_version=excluded.format_version, revision=excluded.revision, state_json=excluded.state_json',
    [next.projectId, WORK_LEDGER_FORMAT, next.revision, JSON.stringify(current)]);
}

/** A current-version file must never be "repaired" into an empty authority. */
export function validateWorkLedgerTable(db: Pick<SqlDatabase, 'exec'>): void {
  const rows = db.exec('PRAGMA table_info(work_ledgers)')[0]?.values;
  const expected = knowledgeSchemaColumns.workLedger;
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name);
    return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new Error('KnowledgeStore: current work ledger schema is missing or corrupt; refusing repair');
}

/** Sidecar an earlier build kept beside the database; removed when a ledger opens. */
const RETIRED_MARKS_FILE_SUFFIX = '.work-ledger-revisions.json';

/** Runs inside the existing schema transaction; no legacy authority is invented. */
export function migrateWorkLedgerTableToVersion2(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  validateWorkLedgerTable(db);
  const upgrades = (db.exec('SELECT project_id, format_version, revision, state_json FROM work_ledgers')[0]?.values ?? []).map(row => {
    if (typeof row[0] !== 'string' || row[1] !== 1 || typeof row[3] !== 'string') throw new Error('Work ledger legacy persisted format is invalid');
    const state = migrateLegacyWorkLedgerState(JSON.parse(row[3]), row[0]);
    if (state.revision !== row[2]) throw new Error('Work ledger legacy persisted revision is invalid');
    return state;
  });
  // Validate every row before changing any row, even in the private migration image.
  for (const state of upgrades) db.run('UPDATE work_ledgers SET format_version = ?, state_json = ? WHERE project_id = ?', [2, JSON.stringify(state), state.projectId]);
}

export function readKnowledgeWorkLedger(db: Pick<SqlDatabase, 'exec'>, projectId: string): WorkLedgerState {
  const row = db.exec('SELECT format_version, revision, state_json FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0];
  if (!row) return createEmptyWorkLedgerState(projectId);
  const state = workLedgerStateSchema.parse(readKnowledgeWorkLedgerImage(db, projectId, row[0], row[2]));
  if (state.projectId !== projectId || state.revision !== row[1]) throw new Error('Work ledger persisted identity is invalid');
  return state;
}

/** Internal adapter composed exclusively by the existing KnowledgeStore owner. */
export function createKnowledgeWorkLedgerStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void, hooks?: {
  beforeDecision(db: SqlDatabase): void;
  beforeCommit(db: SqlDatabase, current: WorkLedgerState, next: WorkLedgerState): void;
}, beforeExplicitSourceWrite?: (version?: 3 | 4) => void, beforeHistoricalImportWrite?: (version?: 2 | 3) => void): KnowledgeWorkLedgerStorage {
  createEmptyWorkLedgerState(projectId); // Validate even before the first row exists.
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const databasePath = sqlite.databasePath;
  if (databasePath) {
    try { unlinkSync(`${databasePath}${RETIRED_MARKS_FILE_SUFFIX}`); } catch { /* absent, or not ours to remove */ }
  }
  // The ledger as last read, at its stored revision. A read whose row still
  // has that revision costs one indexed lookup instead of a parse of the ledger.
  let cached: WorkLedgerState | undefined;
  function currentState(db: Pick<SqlDatabase, 'exec'>): WorkLedgerState {
    const stored = db.exec('SELECT revision FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0]?.[0] ?? 0;
    if (cached && cached.revision === stored) return cached;
    cached = readKnowledgeWorkLedger(db, projectId);
    return cached;
  }
  // The store's revision when the subscribers were last brought up to date:
  // an idle poll compares it and reads nothing else.
  let observedRevision: number | undefined;
  const pending = new Set<Promise<unknown>>();
  const listeners = new Map<(state: WorkLedgerState) => void, number>();
  let poll: ReturnType<typeof setInterval> | undefined;
  // The poll repeats every 100 ms, so a persistent failure is logged once per distinct message,
  // and again if the feed recovers and then fails anew. Observers still never fail a commit.
  let unavailable: string | undefined;
  // Each subscriber that asked is told once per distinct failure, including one that subscribed after it began.
  const unavailableHandlers = new Map<(state: WorkLedgerState) => void, { readonly notify: (reason: string) => void; told?: string }>();
  function observe(): void {
    if (closed || listeners.size === 0) return;
    let state: WorkLedgerState;
    try {
      const revision = sqlite.contentRevision();
      if (revision === observedRevision && [...listeners.values()].every(seen => seen >= 0)) return;
      state = sqlite.readPersisted(currentState);
      observedRevision = revision;
    } catch (error) {
      observedRevision = undefined;
      const reason = summarizeError(error);
      if (reason !== unavailable) {
        unavailable = reason;
        logger.warn('[knowledge-store] work ledger updates are unavailable; subscribers will receive no changes until the ledger can be read again', { projectId, error: reason });
      }
      for (const handler of unavailableHandlers.values()) {
        if (handler.told === reason) continue;
        handler.told = reason;
        try { handler.notify(reason); } catch { /* Observers cannot fail commits. */ }
      }
      return;
    }
    if (unavailable !== undefined) {
      unavailable = undefined;
      logger.info('[knowledge-store] work ledger updates resumed', { projectId });
      for (const handler of unavailableHandlers.values()) delete handler.told;
    }
    for (const [listener, revision] of listeners) {
      if (state.revision <= revision) continue;
      listeners.set(listener, state.revision);
      try { void Promise.resolve(listener(structuredClone(state))).catch(() => {}); } catch { /* Observers cannot fail commits. */ }
    }
  }
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  return {
    read() {
      if (closed) return Promise.reject(new Error('Work ledger storage is closed'));
      return track(Promise.resolve().then(() => sqlite.readPersisted(currentState)));
    },
    transaction<T>(decide: (current: unknown, context?: WorkLedgerTransactionContext) => WorkLedgerDecision<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Work ledger storage is closed'));
      return track(sqlite.transactPersisted(db => {
        hooks?.beforeDecision(db);
        const current = currentState(db);
        // Parsing copies mutable ledger records while retaining only genuinely
        // validated immutable manifest originals. A blanket structuredClone
        // destroys that private provenance and rehashes every historical import.
        const decision = decide(workLedgerStateSchema.parse(current), { readSource: id => readKnowledgeSourceSnapshot(db, { id }) });
        if (decision && typeof (decision as unknown as { then?: unknown }).then === 'function') {
          if (decision instanceof Promise) void decision.catch(() => {});
          throw new TypeError('Work ledger decision must be synchronous');
        }
        if (!decision || !('next' in decision)) throw new TypeError('Invalid work ledger decision');
        if (decision.next !== null) {
          // The service's reducer produced `next` from the validated `current`;
          // it owns that fact, so only the identity and the append are checked here.
          const next = decision.next;
          if (next.projectId !== projectId) throw new Error('Work ledger project mismatch');
          if (next.revision <= current.revision || next.history.length !== next.revision || next.receipts.length !== next.revision) throw new Error('Work ledger commit does not extend the current history');
          if (next.history.slice(current.history.length).some(event => event.type === 'submit_native' && event.work.source?.version === 2) && !hooks) {
            throw new Error('Extracted conversation sources require atomic capture publication');
          }
          hooks?.beforeCommit(db, current, next);
          const explicitVersions = new Set<3 | 4>();
          for (const event of next.history.slice(current.history.length)) {
            const version = event.type === 'submit_native' ? event.work.source?.version : undefined;
            if (version === 3 || version === 4) explicitVersions.add(version);
          }
          for (const version of explicitVersions) {
            const declared: unknown = beforeExplicitSourceWrite?.(version);
            if (declared !== undefined) { drainOwned(declared); throw new Error('Explicit source publication requires a synchronous native owner'); }
          }
          const importVersions = new Set<2 | 3>();
          for (const event of next.history.slice(current.history.length)) {
            if (event.type === 'import_legacy' && (event.manifest.version === 2 || event.manifest.version === 3)) importVersions.add(event.manifest.version);
          }
          for (const version of importVersions) {
            const declared: unknown = beforeHistoricalImportWrite?.(version);
            if (declared !== undefined) { drainOwned(declared); throw new Error('Historical import publication requires a synchronous native owner'); }
          }
          cached = undefined;
          writeKnowledgeWorkLedger(db, next);
        }
        return { changed: decision.next !== null, value: decision.value };
      }, refresh).then(result => {
        if (result.kind === 'local-changes') throw new Error('Work ledger admission blocked by pending local changes or active batch; decision was not called');
        // No observer runs between decision and durable publication acceptance.
        queueMicrotask(observe);
        return result.value;
      }));
    },
    subscribe(listener, onUnavailable) {
      if (closed) throw new Error('Work ledger storage is closed');
      listeners.set(listener, -1);
      if (onUnavailable) unavailableHandlers.set(listener, { notify: onUnavailable });
      if (!poll) { poll = setInterval(observe, 100); poll.unref?.(); }
      queueMicrotask(observe);
      return () => {
        listeners.delete(listener);
        unavailableHandlers.delete(listener);
        if (listeners.size === 0 && poll) { clearInterval(poll); poll = undefined; }
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      listeners.clear();
      unavailableHandlers.clear();
      if (poll) clearInterval(poll);
      poll = undefined;
      closePromise = Promise.allSettled([...pending]).then(() => {});
      return closePromise;
    },
  };
}
