import { createRequire } from 'node:module';
import { types as nodeTypes } from 'node:util';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { array, boolean, enum as enumSchema, literal, number, strictObject, string, union } from 'zod/v4';
import { assertSynchronousJudgmentGuard, drainOwned, parseJevDecision, type JevDecision } from '@goodvibes/judgment/decisions';
import { ledgerEventSchema, workLedgerCommandSchema, type WorkLedgerCommand, type WorkLedgerResult } from '@goodvibes/engine/platform/platform/workflow/work-ledger';

export type LegacyImportCommand = Extract<WorkLedgerCommand, { type: 'import_legacy' }>;
export interface LegacyImportBinding {
  readonly endpoint: string; readonly projectId: string; readonly workspaceId: string;
  readonly principalId: string; readonly principalKind: string;
}
export interface LegacyImportEntry {
  readonly binding: LegacyImportBinding; readonly command: LegacyImportCommand;
  readonly state: 'pending' | 'unknown' | 'accepted' | 'rejected' | 'cancelled';
  readonly attempts: number; readonly receiptActorId: string | null;
  readonly result: WorkLedgerResult | null;
  /** Provenance only. A parsed receipt is not an execution grant. */
  readonly decisions: readonly JevDecision[];
}
export const legacyImportResultSchema = union([
  strictObject({ kind: literal('accepted'), replayed: boolean(), event: ledgerEventSchema }),
  strictObject({ kind: literal('rejected'), code: enumSchema(['invalid_command', 'forbidden', 'conflict', 'stale_evidence', 'stale_source', 'not_found', 'invalid_transition', 'request_conflict', 'cancelled', 'closed', 'invalid_state', 'host_error']), reason: string(), revision: number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }),
  strictObject({ kind: literal('indeterminate'), requestId: string().min(1).max(200), actorId: string().min(1).max(200), reason: string() }),
]);
type Value = string | number | null;
interface DatabasePort {
  exec(sql: string): void; close(): void;
  query<T = unknown>(sql: string): { get(...args: Value[]): T | null; all(...args: Value[]): T[]; run(...args: Value[]): unknown };
  transaction<T>(body: () => T): { immediate(): T };
}
type DatabaseConstructor = new (path: string, options: { strict: boolean; readonly?: boolean }) => DatabasePort;
function databaseConstructor(): DatabaseConstructor {
  // Importing this public module under Node must not eagerly load Bun builtins.
  let module: unknown;
  try { module = createRequire(import.meta.url)('bun:sqlite'); } catch { throw new Error('Import journal requires Bun with native SQLite'); }
  if (!module || typeof module !== 'object' || !('Database' in module) || typeof module.Database !== 'function') throw new Error('Native SQLite unavailable');
  return module.Database as DatabaseConstructor;
}
export function bindingKey(binding: LegacyImportBinding): string {
  const values = [binding.endpoint, binding.projectId, binding.workspaceId, binding.principalKind, binding.principalId];
  if (values.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Complete stable import binding required');
  const url = new URL(binding.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Import endpoint must exclude credentials, query and fragment');
  return JSON.stringify(values);
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function invoke(callback: (() => void) | undefined): void {
  assertSynchronousJudgmentGuard(callback, () => new Error('Import journal format declarations must complete synchronously'));
}
/** The journal holds a saved command, so only its owner may be able to change it. Checked once per open. */
function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.geteuid && stat.uid !== process.geteuid()))
    throw new Error(`Import journal ${path} must be a regular file only you can read and write (mode 0600); run chmod 600 ${path}`);
}
interface Row { binding: string; command: string; state: LegacyImportEntry['state']; attempts: number; actor: string | null; result: string | null; decisions: string }
export interface LegacyImportJournalOptions {
  readonly layout?: 'historical-v1' | 'shared-v2';
  /** Real installed native owner declares its format before persistent mutation. */
  readonly beforeWrite?: (() => void) | undefined;
  readonly beforeManifestWrite?: ((version: 1 | 2 | 3) => void) | undefined;
}

/**
 * The one saved import command per workspace and project, so a lost answer is
 * resent with the same request id and the host, which deduplicates by request
 * id, applies it once. A read creates no file. SQLite orders the writes; the
 * file is private to its owner.
 */
export class LegacyImportJournal {
  private db: DatabasePort | undefined;
  private writable = false;
  private closed = false;
  private hasDecisions = true;
  private readonly path: string;
  private readonly layout: 'historical-v1' | 'shared-v2';
  private readonly beforeWrite: (() => void) | undefined;
  private readonly beforeManifestWrite: ((version: 1 | 2 | 3) => void) | undefined;
  constructor(path: string, private readonly directorySync: (path: string) => void = syncDirectory, options: LegacyImportJournalOptions = {}) {
    this.path = resolve(path); this.layout = options.layout ?? 'historical-v1';
    this.beforeManifestWrite = options.beforeManifestWrite?.bind(options);
    this.beforeWrite = options.beforeWrite?.bind(options);
    if (this.layout !== 'historical-v1' && this.layout !== 'shared-v2') throw new Error('Unsupported import journal layout');
  }
  private slot(binding: LegacyImportBinding): Value {
    bindingKey(binding);
    if (this.layout === 'historical-v1') return 1;
    if (resolve(binding.workspaceId) !== binding.workspaceId) throw new Error('Shared import journal requires the canonical workspace');
    return JSON.stringify([binding.workspaceId, binding.projectId]);
  }
  private get table(): string { return this.layout === 'shared-v2' ? 'shared_legacy_import' : 'legacy_import'; }
  private get archive(): string { return this.layout === 'shared-v2' ? 'shared_legacy_import_archive' : 'legacy_import_archive'; }
  private schema(db: DatabasePort): void {
    const shared = this.layout === 'shared-v2';
    const fields = ['slot', 'binding', 'command', 'state', 'attempts', 'result', 'actor', 'decisions'];
    const columns = db.query<{ name: string; type: string; pk: number; required: number }>('SELECT name,type,pk,"notnull" AS required FROM pragma_table_info(?)').all(this.table);
    if ((!shared && columns.length !== 7 && columns.length !== 8) || (shared && columns.length !== 8)
      || columns.some((column, index) => column.name !== fields[index] || column.type !== (column.name === 'attempts' || column.name === 'slot' && !shared ? 'INTEGER' : 'TEXT')
        || column.pk !== (index === 0 ? 1 : 0) || shared && column.required !== (column.name === 'result' || column.name === 'actor' ? 0 : 1))) throw new Error('Import journal schema is unsupported; preserve existing data');
    this.hasDecisions = columns.length === 8;
    const archive = db.query<{ name: string; type: string; pk: number }>('SELECT name,type,pk FROM pragma_table_info(?)').all(this.archive);
    if (!shared && archive.length === 0) return; // Historical archive was created lazily by old owners.
    const expected = shared ? ['slot', 'request_id', 'entry'] : ['request_id', 'entry'];
    if (archive.length !== expected.length || archive.some((column, index) => column.name !== expected[index] || column.type !== 'TEXT'
      || column.pk !== (index === 0 ? 1 : shared && index === 1 ? 2 : 0))) throw new Error('Import journal archive schema is unsupported; preserve existing data');
  }
  private open(writable: boolean, created: boolean): void {
    assertPrivateFile(this.path);
    const Database = databaseConstructor();
    const db = new Database(this.path, { strict: true, readonly: !writable });
    try {
      db.exec('PRAGMA busy_timeout=5000;');
      const version = db.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version;
      const expectedVersion = this.layout === 'shared-v2' && !created ? 2 : 0;
      if (version !== expectedVersion) throw new Error('Unsupported import journal version; preserve existing data');
      if (writable) db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;');
      if (created && this.layout === 'shared-v2') {
        db.transaction(() => {
          db.exec("CREATE TABLE shared_legacy_import (slot TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, result TEXT, actor TEXT, decisions TEXT NOT NULL DEFAULT '[]'); CREATE TABLE shared_legacy_import_archive (slot TEXT NOT NULL, request_id TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(slot,request_id)); PRAGMA user_version=2;");
        }).immediate();
      } else if (created) {
        db.exec("CREATE TABLE legacy_import (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, result TEXT, actor TEXT, decisions TEXT NOT NULL DEFAULT '[]'); CREATE TABLE legacy_import_archive (request_id TEXT PRIMARY KEY, entry TEXT NOT NULL)");
      }
      this.schema(db);
      if (this.layout === 'shared-v2' && !this.hasDecisions) throw new Error('Shared import journal schema is invalid');
      if (writable && !this.hasDecisions) {
        db.exec("ALTER TABLE legacy_import ADD COLUMN decisions TEXT NOT NULL DEFAULT '[]'");
        this.hasDecisions = true;
      }
      if (writable && this.layout === 'historical-v1') db.exec('CREATE TABLE IF NOT EXISTS legacy_import_archive (request_id TEXT PRIMARY KEY, entry TEXT NOT NULL)');
      this.db = db; this.writable = writable;
    } catch (error) { db.close(); throw error; }
  }
  private ensureWritable(): DatabasePort {
    if (this.closed) throw new Error('Import journal is closed');
    if (this.writable && this.db) return this.db;
    invoke(this.beforeWrite);
    let created = false;
    if (!lstatSync(this.path, { throwIfNoEntry: false })) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      // The new name must survive a crash before a request id is saved under it.
      invoke(() => this.directorySync(dirname(this.path)));
      created = true;
    }
    this.db?.close(); this.db = undefined;
    this.open(true, created);
    return this.db!;
  }
  private mutate<T>(body: (db: DatabasePort) => T): T {
    const db = this.ensureWritable();
    return db.transaction(() => body(db)).immediate();
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    try { this.db?.close(); } finally { this.db = undefined; }
  }
  private readable(): DatabasePort | undefined {
    if (this.closed) throw new Error('Import journal is closed');
    if (!this.db) {
      if (!lstatSync(this.path, { throwIfNoEntry: false })) return undefined;
      this.open(false, false);
    }
    return this.db;
  }
  /** Local namespace conflict detection only; grants no access or authority. */
  hasScope(workspace: string, projectId: string): boolean {
    if (this.layout !== 'shared-v2' || resolve(workspace) !== workspace || !projectId.trim()) throw new Error('Invalid shared import journal scope');
    const db = this.readable(); if (!db) return false;
    return db.query('SELECT slot FROM shared_legacy_import WHERE slot=?').get(JSON.stringify([workspace, projectId])) !== null;
  }
  read(binding: LegacyImportBinding): LegacyImportEntry | null {
    const key = bindingKey(binding), slot = this.slot(binding), db = this.readable(); if (!db) return null;
    const row = db.query<Row>(`SELECT binding, command, state, attempts, result, actor, ${this.hasDecisions ? 'decisions' : "'[]' AS decisions"} FROM ${this.table} WHERE slot=?`).get(slot);
    if (!row) return null;
    if (row.binding !== key) throw new Error('Import journal belongs to another endpoint, project, workspace or principal');
    const command = workLedgerCommandSchema.parse(JSON.parse(row.command));
    if (command.type !== 'import_legacy' || command.manifest.projectId !== binding.projectId) throw new Error('Invalid import journal command');
    if (!['pending', 'unknown', 'accepted', 'rejected', 'cancelled'].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Error('Invalid import journal state');
    const decisions = array(strictObject({}).passthrough()).parse(JSON.parse(row.decisions)).map(parseJevDecision);
    if (new Set(decisions.map(item => item.decisionId)).size !== decisions.length) throw new Error('Duplicate decision identity');
    return { binding: { endpoint: binding.endpoint, projectId: binding.projectId, workspaceId: binding.workspaceId, principalId: binding.principalId, principalKind: binding.principalKind }, command, state: row.state, attempts: row.attempts, receiptActorId: row.actor, result: row.result === null ? null : legacyImportResultSchema.parse(JSON.parse(row.result)), decisions };
  }
  /** Opens for writing first, which rolls back a write an earlier process left half done, then reads. */
  readForUpdate(binding: LegacyImportBinding): LegacyImportEntry | null {
    this.slot(binding); this.ensureWritable(); return this.read(binding);
  }
  reserve(binding: LegacyImportBinding, makeCommand: () => LegacyImportCommand, replaceRequestId?: string): LegacyImportEntry {
    const slot = this.slot(binding), key = bindingKey(binding);
    return this.mutate(db => {
      const prior = this.read(binding);
      if (prior) {
        if (prior.command.requestId !== replaceRequestId) return prior;
        if (!['rejected', 'cancelled'].includes(prior.state)) throw new Error('Unresolved import cannot be replaced');
      } else if (replaceRequestId) throw new Error('Replacement does not match the journal');
      const made: unknown = makeCommand();
      if (nodeTypes.isPromise(made)) { drainOwned(made); throw new Error('Import command construction must be synchronous'); }
      const command = workLedgerCommandSchema.parse(made);
      if (command.type !== 'import_legacy' || command.manifest.projectId !== binding.projectId) throw new Error('Invalid import target');
      invoke(() => this.beforeManifestWrite?.(command.manifest.version));
      if (prior) {
        if (this.layout === 'shared-v2') db.query(`INSERT INTO ${this.archive}(slot,request_id,entry) VALUES (?,?,?)`).run(slot, prior.command.requestId, JSON.stringify(prior));
        else db.query(`INSERT INTO ${this.archive}(request_id,entry) VALUES (?,?)`).run(prior.command.requestId, JSON.stringify(prior));
        db.query(`DELETE FROM ${this.table} WHERE slot=?`).run(slot);
      }
      db.query(`INSERT INTO ${this.table}(slot,binding,command,state,attempts,result,actor,decisions) VALUES(?,?,?,'pending',0,NULL,NULL,'[]')`).run(slot, key, JSON.stringify(command));
      return this.read(binding)!;
    });
  }
  /** Call only inside an immediate transaction, before changing the current slot. */
  private readExpected(binding: LegacyImportBinding, command: LegacyImportCommand): LegacyImportEntry | null {
    const expected = workLedgerCommandSchema.parse(command);
    if (expected.type !== 'import_legacy' || expected.manifest.projectId !== binding.projectId) throw new Error('Invalid import target');
    const current = this.read(binding);
    if (current && JSON.stringify(current.command) !== JSON.stringify(expected)) throw new Error('Import command changed');
    return current;
  }
  cancel(binding: LegacyImportBinding, command: LegacyImportCommand): LegacyImportEntry | null {
    const slot = this.slot(binding);
    return this.mutate(db => { if (this.readExpected(binding, command)?.state === 'pending') db.query(`UPDATE ${this.table} SET state='cancelled' WHERE slot=?`).run(slot); return this.read(binding); });
  }
  /** Marks the saved command as sent (outcome unknown) before it goes out; only call right before the host request. */
  dispatch(binding: LegacyImportBinding, command: LegacyImportCommand, expected?: Pick<LegacyImportEntry, 'state' | 'attempts'>): LegacyImportEntry {
    const slot = this.slot(binding);
    return this.mutate(db => {
      const current = this.readExpected(binding, command);
      if (expected && (!current || current.state !== expected.state || current.attempts !== expected.attempts)) throw new Error('Import dispatch state changed');
      if (!current || !['pending', 'unknown'].includes(current.state)) throw new Error('Import cannot be dispatched');
      db.query(`UPDATE ${this.table} SET state='unknown', attempts=attempts+1 WHERE slot=?`).run(slot); return this.read(binding)!;
    });
  }
  recordDecision(binding: LegacyImportBinding, command: LegacyImportCommand, raw: unknown, settledAttempt?: number): LegacyImportEntry {
    const slot = this.slot(binding), decision = parseJevDecision(raw);
    return this.mutate(db => {
      const current = this.readExpected(binding, command);
      if (!current) throw new Error('Decision command mismatch');
      const prior = current.decisions.find(item => item.decisionId === decision.decisionId);
      if (prior) { if (JSON.stringify(prior) !== JSON.stringify(decision)) throw new Error('Decision identity changed'); return current; }
      db.query(`UPDATE ${this.table} SET decisions=? WHERE slot=?`).run(JSON.stringify([...current.decisions, decision]), slot);
      // Only the matching dispatch from a previously known pending state can
      // become reconsiderable. Another/earlier unresolved delivery stays unknown.
      if (settledAttempt !== undefined && decision.outcome !== 'act' && current.state === 'unknown' && current.attempts === settledAttempt) db.query(`UPDATE ${this.table} SET state='pending' WHERE slot=?`).run(slot);
      return this.read(binding)!;
    });
  }
  record(binding: LegacyImportBinding, command: LegacyImportCommand, raw: WorkLedgerResult, settledAttempt?: number): LegacyImportEntry {
    const slot = this.slot(binding), result = legacyImportResultSchema.parse(raw);
    return this.mutate(db => {
      const current = this.readExpected(binding, command);
      if (!current || current.attempts === 0) throw new Error('No dispatched import');
      if (result.kind === 'accepted' && (result.event.type !== 'import_legacy' || result.event.requestId !== current.command.requestId || JSON.stringify(result.event.manifest) !== JSON.stringify(current.command.manifest))) throw new Error('Receipt command mismatch');
      if (result.kind === 'indeterminate' && result.requestId !== current.command.requestId) throw new Error('Receipt request mismatch');
      if (current.state === 'accepted') return current;
      const actor = result.kind === 'accepted' ? result.event.actorId : result.kind === 'indeterminate' ? result.actorId : current.receiptActorId;
      if (current.receiptActorId && actor !== current.receiptActorId) throw new Error('Receipt actor changed');
      const state = result.kind === 'accepted' ? 'accepted' : result.kind === 'rejected' && current.attempts === (settledAttempt ?? 1) ? 'rejected' : 'unknown';
      db.query(`UPDATE ${this.table} SET state=?, result=?, actor=? WHERE slot=?`).run(state, JSON.stringify(result), actor, slot); return this.read(binding)!;
    });
  }
}
