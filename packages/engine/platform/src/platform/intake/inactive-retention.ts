/** Workspace-owned deletion of expired local previews. No adapter, credentials,
 * source projection, judgment port, or scope-derived authorization is involved. */
import { lstatSync, opendirSync, realpathSync, type Dir } from 'node:fs';
import { join } from 'node:path';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { capturePrivateSqliteDirectory, readPrivateSqliteImage } from '../state/private-sqlite-path.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { writeFileAtomic } from '../state/durable-file-io.js';
import { loadSqlJsEngine, type SqlDatabase } from '../state/sqlite-store.js';
import { createSqlJsDatabase } from '../state/sqljs-database.js';
import { OwnedWork } from '../utils/owned-work.js';
import { INBOX_SWEEP_INTERVAL_MS, isInboxRetentionPolicy, type InboxRetentionPolicy } from './cursor-store.js';
import { isActiveInboxStore } from './active-stores.js';

export interface InactiveInboxSweep {
  readonly examined: number; readonly expired: number; readonly capped: number; readonly busy: number;
  readonly unknownPolicy: number; readonly unavailable: number; readonly more: boolean;
}
export interface InactiveInboxRetentionOwner {
  readonly ready: Promise<void>;
  sweep(): Promise<InactiveInboxSweep>;
  close(): Promise<void>;
}
export interface InactiveInboxRetentionOptions {
  readonly workingDirectory: string;
  /** Original native workspace lifetime, never an account ID or settings flag. */
  readonly assertCurrent: () => void;
  /** Explicit native host attestation for its pre-policy provider mirrors.
   * Omitted for custom stores whose historical policy has not been established. */
  readonly historicalNativePolicy?: InboxRetentionPolicy;
  readonly intervalMs?: number;
  readonly maxFilesPerPass?: number;
  readonly now?: () => number;
  readonly onSweep?: (result: InactiveInboxSweep) => void;
}
const unavailable = () => new Error('Inactive inbox retention storage is unavailable');
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function synchronous(check: () => void): void {
  let result: unknown;
  try { result = check(); }
  catch (error) { drainOwned(error); throw error; }
  if (result !== undefined) { drainOwned(result); throw unavailable(); }
}
function rootStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
function selectedStore(name: string): { provider?: string; lockName: string; historicalNative: boolean } | null {
  const provider = /^inbox-(discord|slack|email)-([0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.sqlite$/.exec(name);
  if (provider) return { provider: provider[1]!, lockName: `${name}.owner.lock`, historicalNative: true };
  // New generic defaults own this exact mirror mutex through both mirror-read
  // and independent triage drainage; the receipt UUID cannot be inferred here.
  if (/^inbox-owned-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.sqlite$/.test(name)) {
    return { lockName: `${name}.owner.lock`, historicalNative: false };
  }
  const owned = /^inbox-owned-([0-9a-f]{64})\.sqlite$/.exec(name);
  return owned ? { lockName: `inbox-triage-${owned[1]!}.sqlite.owner.lock`, historicalNative: false } : null;
}
function scalar(db: SqlDatabase, sql: string, params?: (string | number)[]): number {
  const value = db.exec(sql, params)[0]?.values[0]?.[0]; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable(); return value;
}
function knownSchema(db: SqlDatabase): void {
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0]?.values.map(row => row[0]);
  if (!tables || !['items', 'cursors', 'imap_checkpoints'].every(table => tables.includes(table))
    || tables.some(table => !['items', 'cursors', 'imap_checkpoints', 'inbox_retention_policy', 'inbox_source_revision_policy'].includes(String(table)))
    || scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('trigger', 'view')") !== 0) throw unavailable();
  const itemColumns = db.exec('PRAGMA table_info(items)')[0]?.values;
  const columns = itemColumns?.map(row => row[1]);
  const expected = ['id', 'provider', 'kind', 'fromDigest', 'subjectPreview', 'bodyPreview', 'routeId', 'receivedAt', 'unread'];
  if (!columns || expected.some((name, index) => columns[index] !== name)) throw unavailable();
  const sourcePolicy = tables.includes('inbox_source_revision_policy');
  if (columns.length === expected.length) {
    // Original nine-column mirrors predate mutation-issued source revisions.
    if (sourcePolicy) throw unavailable();
  } else {
    if (columns.length !== expected.length + 1 || columns[expected.length] !== 'triage_revision' || !sourcePolicy) throw unavailable();
    const revisionColumn = itemColumns?.[expected.length];
    if (revisionColumn?.[2] !== 'TEXT' || revisionColumn[3] !== 0 || revisionColumn[4] !== null || revisionColumn[5] !== 0) throw unavailable();
    const policyInfo = db.exec('PRAGMA table_info(inbox_source_revision_policy)')[0]?.values;
    const policyColumns = policyInfo?.map(row => row[1]);
    const policy = db.exec('SELECT singleton, version FROM inbox_source_revision_policy')[0]?.values;
    if (!policyColumns || policyColumns.length !== 2 || policyColumns[0] !== 'singleton' || policyColumns[1] !== 'version'
      || policyInfo?.[0]?.[2] !== 'INTEGER' || policyInfo[0]?.[5] !== 1
      || policyInfo[1]?.[2] !== 'INTEGER' || policyInfo[1]?.[3] !== 1 || policyInfo[1]?.[5] !== 0
      || !policy || policy.length !== 1 || policy[0]?.[0] !== 1 || policy[0]?.[1] !== 1) throw unavailable();
    if (scalar(db, "SELECT COUNT(*) FROM items WHERE triage_revision IS NULL OR typeof(triage_revision) != 'text' OR length(triage_revision) != 35 OR length(CAST(triage_revision AS BLOB)) != 35 OR substr(triage_revision, 1, 3) != 'ir-' OR substr(triage_revision, 4) GLOB '*[^0-9a-f]*'") !== 0) throw unavailable();
  }
  if (scalar(db, "SELECT COUNT(*) FROM items WHERE typeof(id) != 'text' OR typeof(provider) != 'text' OR typeof(receivedAt) != 'integer'") !== 0) throw unavailable();
}
function policyFor(db: SqlDatabase, historical: InboxRetentionPolicy | undefined): InboxRetentionPolicy | null {
  const hasPolicy = scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'inbox_retention_policy'") !== 0;
  if (!hasPolicy) return historical ?? null;
  const rows = db.exec('SELECT singleton, version, itemTtlMs, itemCap FROM inbox_retention_policy')[0]?.values;
  if (!rows || rows.length !== 1 || rows[0]?.[0] !== 1 || rows[0]?.[1] !== 1) return null;
  const policy = { itemTtlMs: rows[0]?.[2], itemCap: rows[0]?.[3] };
  return isInboxRetentionPolicy(policy) ? policy : null;
}

export function createInactiveInboxRetentionOwner(input: InactiveInboxRetentionOptions): InactiveInboxRetentionOwner {
  const options = Object.freeze({ ...input, assertCurrent: input.assertCurrent.bind(input), now: input.now?.bind(input), onSweep: input.onSweep?.bind(input),
    ...(input.historicalNativePolicy ? { historicalNativePolicy: Object.freeze({ ...input.historicalNativePolicy }) } : {}) });
  if (options.historicalNativePolicy && !isInboxRetentionPolicy(options.historicalNativePolicy)) throw unavailable();
  const limit = options.maxFilesPerPass ?? 8, interval = options.intervalMs ?? INBOX_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || !Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647) throw unavailable();
  const root = realpathSync(options.workingDirectory), workspace = rootStamp(root);
  const work = new OwnedWork(); let closed = false, directory: Dir | undefined;
  let storage: ReturnType<typeof capturePrivateSqliteDirectory> | undefined;
  let sweeping: Promise<InactiveInboxSweep> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const assertWorkspace = () => {
    if (closed) throw unavailable(); synchronous(options.assertCurrent);
    if (realpathSync(options.workingDirectory) !== root || rootStamp(root) !== workspace) throw unavailable();
  };
  const current = () => { assertWorkspace(); storage?.assertCurrent(); };
  const sweep = (): Promise<InactiveInboxSweep> => {
    if (sweeping) return sweeping;
    const pending = work.run(async () => {
      current();
      const result = { examined: 0, expired: 0, capped: 0, busy: 0, unknownPolicy: 0, unavailable: 0, more: false };
      if (!storage) {
        try { storage = capturePrivateSqliteDirectory(root, { create: false, assertCurrent: assertWorkspace }); }
        catch (error) { if (missing(error)) return result; throw error; }
      }
      current();
      const SQL = await loadSqlJsEngine(); current();
      directory ??= opendirSync(storage.directory); current();
      let visited = 0;
      while (result.examined < limit && visited < 256) {
        current(); const entry = directory.readSync(); visited++;
        if (!entry) { directory.closeSync(); directory = undefined; return result; }
        const selected = selectedStore(entry.name); if (!selected) continue;
        result.examined++;
        const path = join(storage.directory, entry.name), lock = join(storage.directory, selected.lockName);
        if (isActiveInboxStore(path)) { result.busy++; continue; }
        const release = tryAcquireCrossProcessLock(lock); if (!release) { result.busy++; continue; }
        let db: SqlDatabase | undefined;
        try {
          const lease = fileObservationIdentity(lock);
          const assertOwner = () => { current(); if (isActiveInboxStore(path) || fileObservationIdentity(lock) !== lease) throw unavailable(); };
          assertOwner(); const stat = lstatSync(path);
          if (stat.size > 64 * 1024 * 1024) throw unavailable();
          const original = readPrivateSqliteImage(path, assertOwner); if (!original) continue;
          const assertOriginal = () => { assertOwner(); if (fileObservationIdentity(path) !== original.physical) throw unavailable(); };
          assertOriginal(); db = createSqlJsDatabase(SQL.Database, original.bytes);
          if (db.exec('PRAGMA quick_check')[0]?.values[0]?.[0] !== 'ok') throw unavailable();
          knownSchema(db);
          if (selected.provider && scalar(db, 'SELECT COUNT(*) FROM items WHERE provider != ? OR id NOT LIKE ?', [selected.provider, `${selected.provider}:%`]) !== 0) throw unavailable();
          const policy = policyFor(db, selected.historicalNative ? options.historicalNativePolicy : undefined);
          if (!policy) { result.unknownPolicy++; continue; }
          const now = options.now?.() ?? Date.now(); if (!Number.isSafeInteger(now)) throw unavailable();
          assertOriginal(); db.run('DELETE FROM items WHERE receivedAt < ?', [now - policy.itemTtlMs]);
          const expired = scalar(db, 'SELECT changes()');
          db.run('DELETE FROM items WHERE id NOT IN (SELECT id FROM items ORDER BY receivedAt DESC, id ASC LIMIT ?)', [policy.itemCap]);
          const capped = scalar(db, 'SELECT changes()');
          if (expired || capped) {
            // Only expiration/cap deletion is authorized. No source interpretation,
            // cursor change, receipt fabrication, or reconstruction is performed.
            assertOriginal(); writeFileAtomic(path, db.export(), { durable: true, mode: 0o600, cleanupStaleTemps: false, assertCurrent: assertOriginal });
            result.expired += expired; result.capped += capped;
          }
        } catch { result.unavailable++; }
        finally { try { db?.close(); } finally { release(); } }
      }
      result.more = true; return result;
    });
    sweeping = pending; void pending.then(() => { if (sweeping === pending) sweeping = undefined; }, () => { if (sweeping === pending) sweeping = undefined; });
    return pending;
  };
  const schedule = (delay: number) => { if (!closed) { timer = setTimeout(() => { timer = undefined; void tick(); }, delay); timer.unref(); } };
  const report = (result: InactiveInboxSweep) => { try { const observed: unknown = options.onSweep?.(result); if (observed !== undefined) drainOwned(observed); } catch { /* Reporting cannot change local cleanup ownership. */ } };
  const tick = async () => {
    try { const result = await sweep(); if (!closed) report(result); schedule(result.more ? 10 : interval); }
    catch { if (!closed) { report({ examined: 0, expired: 0, capped: 0, busy: 0, unknownPolicy: 0, unavailable: 1, more: false }); schedule(interval); } }
  };
  const ready = tick();
  return { ready, sweep, async close() { closed = true; if (timer) clearTimeout(timer); await work.join(); if (directory) { directory.closeSync(); directory = undefined; } } };
}
