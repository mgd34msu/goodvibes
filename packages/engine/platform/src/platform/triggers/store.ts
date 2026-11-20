/**
 * store.ts, persistence for the trigger family, with recovery housekeeping.
 *
 * One SQLite file per surface. Each trigger is one row: its definition is
 * written once when the trigger is created, and its state (rule bookkeeping,
 * the bounded observation ring, the bounded run history) is replaced as one
 * row when it changes, so a check costs one small write whatever the number
 * of triggers. Grants are one row each, the shared correlation log is one
 * appended row per fire, and the last fifty recovery reports are kept.
 *
 * One process supervises a surface's triggers: it holds a lock the kernel
 * releases when the process dies (`<file>.writer.sqlite`). Any other process
 * reads the same file and sees the owner's commits.
 *
 * Housekeeping, unchanged in meaning:
 *   1. Reap on recovery: triggers whose owning session is gone are removed,
 *      and a one-shot on-exit trigger that already fired retires itself.
 *   2. Bound everything: count cap AND age TTL on run history, observations
 *      and the shared event log.
 *   3. Validate every row read back; a row that does not read is left in
 *      place, skipped and named in the recovery report.
 *   4. Reap periodically: the supervisor runs the same sweep on a timer.
 *   5. Disclose what was reaped: every sweep that removed something keeps
 *      its report.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { openSqliteFile, type SqliteFile } from '../state/sqlite-file.js';
import { holdProcessLock, type HeldProcessLock } from '../utils/process-lock.js';
import { summarizeError } from '../utils/error-display.js';
import { isTriggerEvent, isTriggerGrant, isTriggerRecord, isTriggerReport } from './snapshot-validation.js';
import type { TriggerActionGrant, TriggerEventLogEntry, TriggerRecord, TriggerRecoveryReport } from './types.js';

/** A read or write of the trigger store failed. Names the file, what was being done and why. */
export class TriggerStoreError extends Error {
  override readonly name = 'TriggerStoreError';
  constructor(readonly path: string, readonly operation: string, cause: unknown, readonly dataError = false) {
    super(`Trigger store could not ${operation} (${path}): ${summarizeError(cause)}`, { cause });
  }
}

/** Another process supervises these triggers; this one may read them but not change them. */
export class TriggerStoreOwnershipError extends RefusalError {
  constructor() {
    super(refusal({
      code: 'TRIGGER_OTHER_PROCESS',
      state: 'another GoodVibes process supervises the triggers of this surface',
      reason: 'This process can read these triggers but not change them',
      next: ['Make the change from the GoodVibes process that runs them, or close that process: this one takes over on its next supervision tick'],
      status: 409,
    }));
  }
}

export interface TriggerRetentionPolicy {
  readonly observationRingSize: number;
  readonly runHistoryLimit: number;
  readonly runHistoryTtlMs: number;
  readonly eventLogLimit: number;
  readonly eventLogTtlMs: number;
}

export const DEFAULT_RETENTION: TriggerRetentionPolicy = {
  observationRingSize: 200,
  runHistoryLimit: 50,
  runHistoryTtlMs: 168 * 60 * 60 * 1000,
  eventLogLimit: 500,
  eventLogTtlMs: 24 * 60 * 60 * 1000,
};

const REPORT_HISTORY = 50;

function encodeState(record: TriggerRecord): string {
  const { definition: _definition, ...state } = record;
  return JSON.stringify(state);
}

function createSchema(db: Database): void {
  db.run('CREATE TABLE triggers (id TEXT PRIMARY KEY, definition TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  db.run('CREATE TABLE grants (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  db.run('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)');
  db.run('CREATE TABLE reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)');
}

export interface TriggerStoreContents {
  readonly records: readonly TriggerRecord[];
  readonly grants: readonly TriggerActionGrant[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  /** Rows that did not read back, named so the recovery report can say so. */
  readonly skipped: readonly string[];
}

/** The trigger family's rows and the lock that makes one process their supervisor. */
export class TriggerStore {
  readonly path: string;
  private file: SqliteFile | null = null;
  private lock: HeldProcessLock | null = null;

  constructor(storePath: string) {
    this.path = storePath;
  }

  /** True when anything is stored: the database exists. */
  hasData(): boolean {
    return existsSync(this.path);
  }

  /** Whether this process holds the supervisor lock. */
  get owned(): boolean { return this.lock !== null; }

  /** Takes the supervisor lock; false when another process holds it. */
  claim(): boolean {
    if (this.lock) return true;
    this.lock = holdProcessLock(`${this.path}.writer.sqlite`);
    return this.lock !== null;
  }

  /** Gives up the lock and closes the file. */
  release(): void {
    const lock = this.lock;
    this.lock = null;
    try { this.file?.close(); } finally { this.file = null; lock?.release(); }
  }

  private db(): SqliteFile {
    if (this.file) return this.file;
    try {
      this.file = openSqliteFile(this.path, {
        name: `trigger store (${basename(this.path)})`,
        migrations: [{ toVersion: 1, up: createSchema }],
      });
    } catch (error) {
      throw new TriggerStoreError(this.path, 'open', error);
    }
    return this.file;
  }

  private write(operation: string, work: (db: Database) => void): void {
    const file = this.db();
    try { file.tx(() => { work(file.db); }); }
    catch (error) { throw new TriggerStoreError(this.path, operation, error); }
  }

  /** Every row, each validated. The newest `eventLimit` correlation entries are returned. */
  read(eventLimit: number = DEFAULT_RETENTION.eventLogLimit): TriggerStoreContents {
    const db = this.db().db;
    try {
      const skipped: string[] = [];
      const records: TriggerRecord[] = [];
      for (const row of db.query<{ id: string; definition: string; state: string }, []>('SELECT id, definition, state FROM triggers ORDER BY id').all()) {
        let record: unknown;
        try { record = { ...(JSON.parse(row.state) as object), definition: JSON.parse(row.definition) as unknown }; }
        catch { record = undefined; }
        if (isTriggerRecord(record) && record.definition.id === row.id) records.push(record);
        else skipped.push(row.id);
      }
      const grants: TriggerActionGrant[] = [];
      for (const row of db.query<{ id: string; body: string }, []>('SELECT id, body FROM grants ORDER BY id').all()) {
        let grant: unknown;
        try { grant = JSON.parse(row.body) as unknown; } catch { grant = undefined; }
        if (isTriggerGrant(grant)) grants.push(grant);
        else skipped.push(`grant ${row.id}`);
      }
      const eventLog = db.query<{ body: string }, [number]>('SELECT body FROM (SELECT seq, body FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(Math.max(0, eventLimit))
        .map((row) => { try { return JSON.parse(row.body) as unknown; } catch { return undefined; } })
        .filter(isTriggerEvent);
      return { records, grants, eventLog, skipped };
    } catch (error) {
      throw new TriggerStoreError(this.path, 'read the stored triggers', error);
    }
  }

  /** Writes a new trigger: its definition, once, and its first state. */
  insert(record: TriggerRecord): void {
    let definition: string, state: string;
    try { definition = JSON.stringify(record.definition); state = encodeState(record); }
    catch (error) { throw new TriggerStoreError(this.path, `encode trigger ${record.definition.id}`, error, true); }
    this.write(`save trigger ${record.definition.id}`, (db) => {
      db.query('INSERT INTO triggers (id, definition, state, updated_at) VALUES (?, ?, ?, ?)').run(record.definition.id, definition, state, record.updatedAt);
    });
  }

  /** Replaces one trigger's state; the definition is not written again. */
  update(record: TriggerRecord): void {
    let state: string;
    try { state = encodeState(record); }
    catch (error) { throw new TriggerStoreError(this.path, `encode trigger ${record.definition.id}`, error, true); }
    this.write(`save trigger ${record.definition.id}`, (db) => {
      const changed = db.query('UPDATE triggers SET state = ?, updated_at = ? WHERE id = ?').run(state, record.updatedAt, record.definition.id).changes;
      if (changed === 0) throw new Error('the trigger is not in the store');
    });
  }

  remove(id: string): void {
    this.write(`remove trigger ${id}`, (db) => { db.query('DELETE FROM triggers WHERE id = ?').run(id); });
  }

  saveGrant(grant: TriggerActionGrant): void {
    this.write(`save grant ${grant.id}`, (db) => { db.query('INSERT OR REPLACE INTO grants (id, body) VALUES (?, ?)').run(grant.id, JSON.stringify(grant)); });
  }

  appendEvent(entry: TriggerEventLogEntry): void {
    this.write('record a fire for correlation', (db) => { db.query('INSERT INTO events (at, body) VALUES (?, ?)').run(entry.at, JSON.stringify(entry)); });
  }

  /** Drops correlation entries older than the cutoff and beyond the newest `limit`. Returns how many went. */
  trimEvents(cutoff: number, limit: number): number {
    let removed = 0;
    this.write('trim the correlation log', (db) => {
      removed += db.query('DELETE FROM events WHERE at < ?').run(cutoff).changes;
      removed += db.query('DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)').run(Math.max(0, limit)).changes;
    });
    return removed;
  }

  /** Keeps a recovery report that removed or skipped something; an empty one is not written. */
  appendReport(report: TriggerRecoveryReport): void {
    if (!report.triggersReaped && !report.runsReaped && !report.observationsReaped && !report.eventsReaped && !report.orphanedProcesses.length && !report.quarantined) return;
    this.write('keep the recovery report', (db) => {
      db.query('INSERT INTO reports (body) VALUES (?)').run(JSON.stringify(report));
      db.query('DELETE FROM reports WHERE seq NOT IN (SELECT seq FROM reports ORDER BY seq DESC LIMIT ?)').run(REPORT_HISTORY);
    });
  }

  /** The kept recovery reports, oldest first. */
  reports(): readonly TriggerRecoveryReport[] {
    if (!existsSync(this.path)) return [];
    return this.db().db.query<{ body: string }, []>('SELECT body FROM reports ORDER BY seq').all()
      .map((row) => { try { return JSON.parse(row.body) as unknown; } catch { return undefined; } })
      .filter(isTriggerReport);
  }
}

// ─── Bounding ─────────────────────────────────────────────────────────────────

export interface BoundResult {
  readonly record: TriggerRecord;
  readonly runsReaped: number;
  readonly observationsReaped: number;
}

/** Applies the count cap AND the age TTL to one record's retained state. */
export function boundRecord(record: TriggerRecord, policy: TriggerRetentionPolicy, now: number): BoundResult {
  const runCutoff = now - policy.runHistoryTtlMs;
  const keptRuns = record.runs
    .filter((run) => run.at >= runCutoff)
    .slice(-policy.runHistoryLimit);
  const keptObservations = record.observations.slice(-policy.observationRingSize);
  const runsReaped = record.runs.length - keptRuns.length;
  const observationsReaped = record.observations.length - keptObservations.length;
  if (runsReaped === 0 && observationsReaped === 0) {
    return { record, runsReaped: 0, observationsReaped: 0 };
  }
  return {
    record: { ...record, runs: keptRuns, observations: keptObservations },
    runsReaped,
    observationsReaped,
  };
}

export function boundEventLog(
  eventLog: readonly TriggerEventLogEntry[],
  policy: TriggerRetentionPolicy,
  now: number,
): { readonly eventLog: readonly TriggerEventLogEntry[]; readonly reaped: number } {
  const cutoff = now - policy.eventLogTtlMs;
  const kept = eventLog.filter((entry) => entry.at >= cutoff).slice(-policy.eventLogLimit);
  return { eventLog: kept, reaped: eventLog.length - kept.length };
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

export interface SweepInput {
  readonly triggers: readonly TriggerRecord[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly policy: TriggerRetentionPolicy;
  readonly now: number;
  readonly reason: 'startup' | 'sweep';
  /** Returns false when the session that created a trigger no longer exists. */
  readonly sessionIsLive?: ((sessionId: string) => boolean) | undefined;
  /** Returns false when a tracked child process is no longer running. */
  readonly processIsLive?: ((pid: number, startedAt: number) => boolean) | undefined;
  readonly quarantined?: string | undefined;
}

export interface SweepResult {
  readonly triggers: readonly TriggerRecord[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly report: TriggerRecoveryReport;
}

/**
 * The recovery sweep. Idempotent: it only ever removes records that are
 * already terminal or whose owner is provably gone, and running it twice
 * produces the same result.
 */
export function sweepTriggers(input: SweepInput): SweepResult {
  const { policy, now } = input;
  const kept: TriggerRecord[] = [];
  const reapedIds: string[] = [];
  const orphanedProcesses: string[] = [];
  let runsReaped = 0;
  let observationsReaped = 0;

  for (const record of input.triggers) {
    const owner = record.definition.ownerSessionId;
    if (owner && input.sessionIsLive && !input.sessionIsLive(owner)) {
      reapedIds.push(record.definition.id);
      continue;
    }
    // A one-shot on-exit trigger retires once its action was delivered (or it
    // was cancelled). One whose action is still owed is never reaped.
    if (record.definition.spec.kind === 'on-exit' && (record.state === 'fired' || record.state === 'cancelled') && record.pendingExit === undefined) {
      reapedIds.push(record.definition.id);
      continue;
    }
    if (record.process && record.state === 'running' && input.processIsLive && !input.processIsLive(record.process.pid, record.process.startedAt)) {
      orphanedProcesses.push(record.process.processId);
    }
    const bounded = boundRecord(record, policy, now);
    runsReaped += bounded.runsReaped;
    observationsReaped += bounded.observationsReaped;
    kept.push(bounded.record);
  }

  const boundedLog = boundEventLog(input.eventLog, policy, now);

  return {
    triggers: kept,
    eventLog: boundedLog.eventLog,
    report: {
      at: now,
      reason: input.reason,
      triggersLoaded: input.triggers.length,
      triggersReaped: reapedIds.length,
      reapedIds,
      runsReaped,
      observationsReaped,
      eventsReaped: boundedLog.reaped,
      orphanedProcesses,
      ...(input.quarantined ? { quarantined: input.quarantined } : {}),
    },
  };
}
