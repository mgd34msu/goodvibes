import { createRequire } from 'node:module';
import { types as nodeTypes } from 'node:util';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { captureExistingDirectory } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import { array, boolean, enum as enumSchema, literal, number, strictObject, string, union } from 'zod/v4';
import { drainOwned, parseJevDecision, type JevDecision } from '@goodvibes-jev/judgment/decisions';
import { ledgerEventSchema, workLedgerCommandSchema, type WorkLedgerCommand, type WorkLedgerResult } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';

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
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'; }
function privateStamp(stat: BigIntStats): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n || (stat.mode & 0o400n) === 0n
    || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) throw new Error('Import journal requires private owner-only regular files');
  // SQLite changes clocks/size while committing. This retains its actual native
  // file generation; row/command consistency is independently checked in SQL.
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
const incarnation = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.birthtimeNs].join(':');
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function invoke(callback: (() => void) | undefined): void {
  const result: unknown = callback?.();
  if (result !== undefined) { drainOwned(result); throw new Error('Import journal ownership callbacks must complete synchronously'); }
}
interface Row { binding: string; command: string; state: LegacyImportEntry['state']; attempts: number; actor: string | null; result: string | null; decisions: string }
export interface LegacyImportJournalOptions {
  readonly layout?: 'historical-v1' | 'shared-v2';
  /** Real installed native owner declares its format before persistent mutation. */
  readonly beforeWrite?: (() => void) | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

/** Durable exact-command recovery. Readonly status creates no DB, directory or
 * DDL. Native SQLite supplies transactional row ordering; retained original
 * parents/file fence later callbacks and opens, independently of row equality.
 */
export class LegacyImportJournal {
  private db: DatabasePort | undefined;
  private descriptor: number | undefined;
  private original: string | undefined;
  private writable = false;
  private closed = false;
  private hasDecisions = true;
  private schemaRevision: number | undefined;
  private readonly path: string;
  private readonly parents: ReturnType<typeof captureExistingDirectory>[];
  private readonly missingParents: string[] = [];
  private readonly layout: 'historical-v1' | 'shared-v2';
  private readonly beforeWrite: (() => void) | undefined;
  private readonly ownerCurrent: (() => void) | undefined;
  constructor(path: string, private readonly directorySync: (path: string) => void = syncDirectory, options: LegacyImportJournalOptions = {}) {
    this.path = resolve(path); this.layout = options.layout ?? 'historical-v1';
    this.beforeWrite = options.beforeWrite?.bind(options); this.ownerCurrent = options.assertCurrent?.bind(options);
    if (this.layout !== 'historical-v1' && this.layout !== 'shared-v2') throw new Error('Unsupported import journal layout');
    let parent = dirname(this.path);
    while (!lstatSync(parent, { throwIfNoEntry: false })) { this.missingParents.unshift(parent); const next = dirname(parent); if (next === parent) throw new Error('Import journal parent is unavailable'); parent = next; }
    this.parents = [captureExistingDirectory(parent)]; this.current();
    try { if (this.missingParents.length === 0 && lstatSync(this.path, { throwIfNoEntry: false })) { this.retainFile(); this.header(); } }
    catch (error) { this.close(); throw error; }
  }
  private current(): void {
    if (this.closed) throw new Error('Import journal is closed');
    invoke(this.ownerCurrent); for (const parent of this.parents) parent.assertCurrent();
    if (this.descriptor !== undefined && (privateStamp(fstatSync(this.descriptor, { bigint: true })) !== this.original
      || privateStamp(lstatSync(this.path, { bigint: true })) !== this.original)) throw new Error('Original import journal file changed; preserve its saved request');
    if (this.db && (this.db.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version !== (this.layout === 'shared-v2' ? 2 : 0)
      || this.db.query<{ schema_version: number }>('PRAGMA schema_version').get()?.schema_version !== this.schemaRevision)) throw new Error('Original import journal format changed; preserve its saved request');
  }
  private slot(binding: LegacyImportBinding): Value {
    bindingKey(binding);
    if (this.layout === 'historical-v1') return 1;
    if (resolve(binding.workspaceId) !== binding.workspaceId) throw new Error('Shared import journal requires the canonical workspace');
    return JSON.stringify([binding.workspaceId, binding.projectId]);
  }
  private get table(): string { return this.layout === 'shared-v2' ? 'shared_legacy_import' : 'legacy_import'; }
  private get archive(): string { return this.layout === 'shared-v2' ? 'shared_legacy_import_archive' : 'legacy_import_archive'; }
  private retainFile(): void {
    this.current(); if (this.descriptor !== undefined) return;
    const selected = privateStamp(lstatSync(this.path, { bigint: true }));
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (privateStamp(fstatSync(fd, { bigint: true })) !== selected || privateStamp(lstatSync(this.path, { bigint: true })) !== selected) throw new Error('Import journal changed while opening');
      this.original = selected; this.descriptor = fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  private header(): void {
    const header = Buffer.alloc(100); this.current();
    if (readSync(this.descriptor!, header, 0, header.length, 0) !== header.length || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000'
      || header[18] !== 1 || header[19] !== 1) throw new Error('Import journal requires its original rollback-journal SQLite format');
    if (header.readUInt32BE(60) !== (this.layout === 'shared-v2' ? 2 : 0)) throw new Error('Unsupported import journal version; preserve existing data');
    this.current();
  }
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
    this.current();
    const parent = lstatSync(dirname(this.path), { bigint: true });
    if (!parent.isDirectory() || (parent.mode & 0o022n) !== 0n || (process.geteuid && parent.uid !== BigInt(process.geteuid()))) throw new Error('Import journal requires an owner-controlled directory');
    this.retainFile();
    this.current();
    if (!created) {
      this.header();
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privateStamp(lstatSync(this.path + suffix, { bigint: true })); } catch (error) { if (!missing(error)) throw error; }
    }
    const Database = databaseConstructor();
    const db = new Database(this.path, { strict: true, readonly: !writable });
    try {
      this.current(); db.exec('PRAGMA busy_timeout=5000;');
      const version = db.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version;
      if (this.layout === 'shared-v2' ? (!created && version !== 2) || (created && version !== 0) : version !== 0) throw new Error('Unsupported import journal version; preserve existing data');
      if (!created) this.schema(db);
      if (writable) {
        this.current(); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;');
        if (db.query<{ synchronous: number }>('PRAGMA synchronous').get()?.synchronous !== 3 || db.query<{ journal_mode: string }>('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new Error('Import journal requires EXTRA/DELETE durability');
      }
      if (this.layout === 'shared-v2') {
        if ((!created && version !== 2) || (created && version !== 0)) throw new Error('Unsupported shared import journal version; preserve existing data');
        if (created) db.transaction(() => {
          this.current();
          db.exec("CREATE TABLE shared_legacy_import (slot TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, result TEXT, actor TEXT, decisions TEXT NOT NULL DEFAULT '[]'); CREATE TABLE shared_legacy_import_archive (slot TEXT NOT NULL, request_id TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(slot,request_id)); PRAGMA user_version=2;");
          this.current();
        }).immediate();
      } else {
        if (version !== 0) throw new Error('Unsupported historical import journal version; preserve existing data');
        if (created) db.exec("CREATE TABLE legacy_import (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, result TEXT, actor TEXT, decisions TEXT NOT NULL DEFAULT '[]'); CREATE TABLE legacy_import_archive (request_id TEXT PRIMARY KEY, entry TEXT NOT NULL)");
      }
      this.schema(db);
      if (this.layout === 'shared-v2' && !this.hasDecisions) throw new Error('Shared import journal schema is invalid');
      if (writable && !this.hasDecisions) {
        db.transaction(() => { this.current(); db.exec("ALTER TABLE legacy_import ADD COLUMN decisions TEXT NOT NULL DEFAULT '[]'"); this.current(); }).immediate();
        this.hasDecisions = true;
      }
      if (writable && this.layout === 'historical-v1') {
        db.transaction(() => { this.current(); db.exec('CREATE TABLE IF NOT EXISTS legacy_import_archive (request_id TEXT PRIMARY KEY, entry TEXT NOT NULL)'); this.current(); }).immediate();
      }
      this.current(); this.schemaRevision = db.query<{ schema_version: number }>('PRAGMA schema_version').get()?.schema_version;
      this.db = db; this.writable = writable; this.current();
    } catch (error) { if (this.db === db) { this.db = undefined; this.writable = false; } db.close(); throw error; }
  }
  private ensureWritable(): DatabasePort {
    this.current(); invoke(this.beforeWrite); this.current();
    while (this.missingParents.length > 0) {
      const path = this.missingParents[0]!; this.current();
      if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('Import journal parent appeared; retry against its actual saved state');
      mkdirSync(path, { mode: 0o700 });
      const original = lstatSync(path, { bigint: true });
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!original.isDirectory() || original.isSymbolicLink() || incarnation(fstatSync(fd, { bigint: true })) !== incarnation(original)) throw new Error('Created import parent changed');
        fchmodSync(fd, 0o700);
        if (incarnation(lstatSync(path, { bigint: true })) !== incarnation(original)) throw new Error('Created import parent changed');
        this.parents.push(captureExistingDirectory(path)); this.missingParents.shift(); this.current();
      }
      finally { closeSync(fd); }
    }
    const parent = lstatSync(dirname(this.path), { bigint: true });
    if (!parent.isDirectory() || (parent.mode & 0o022n) !== 0n || (process.geteuid && parent.uid !== BigInt(process.geteuid()))) throw new Error('Import journal requires an owner-controlled directory');
    let created = false;
    if (this.descriptor === undefined) {
      const fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600); fsyncSync(fd);
        this.original = privateStamp(fstatSync(fd, { bigint: true })); this.descriptor = fd;
        this.current(); created = true;
      } catch (error) { if (this.descriptor === undefined) closeSync(fd); throw error; }
    }
    if (!this.writable) {
      this.db?.close(); this.db = undefined;
      this.open(true, created);
      this.current();
      if (created) {
        let ancestor = dirname(this.path);
        while (true) { this.current(); invoke(() => this.directorySync(ancestor)); this.current(); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
      }
    }
    this.current(); return this.db!;
  }
  private mutate<T>(body: (db: DatabasePort) => T): T {
    const db = this.ensureWritable();
    return db.transaction(() => { this.current(); const result = body(db); this.current(); return result; }).immediate();
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    try { this.db?.close(); } finally { if (this.descriptor !== undefined) closeSync(this.descriptor); this.db = undefined; this.descriptor = undefined; }
  }
  private readable(): DatabasePort | undefined {
    this.current();
    if (!this.db) {
      if (this.missingParents.length > 0) {
        if (this.missingParents.some(path => lstatSync(path, { throwIfNoEntry: false }))) throw new Error('Import journal parent appeared; retry against its actual saved state');
        return undefined;
      }
      if (!lstatSync(this.path, { throwIfNoEntry: false })) return undefined;
      this.open(false, false);
    }
    return this.db;
  }
  /** Local namespace conflict detection only; grants no access or authority. */
  hasScope(workspace: string, projectId: string): boolean {
    if (this.layout !== 'shared-v2' || resolve(workspace) !== workspace || !projectId.trim()) throw new Error('Invalid shared import journal scope');
    const db = this.readable(); if (!db) return false;
    const present = db.query('SELECT slot FROM shared_legacy_import WHERE slot=?').get(JSON.stringify([workspace, projectId])) !== null;
    this.current(); return present;
  }
  read(binding: LegacyImportBinding): LegacyImportEntry | null {
    const key = bindingKey(binding), slot = this.slot(binding), db = this.readable(); if (!db) return null;
    const row = db.query<Row>(`SELECT binding, command, state, attempts, result, actor, ${this.hasDecisions ? 'decisions' : "'[]' AS decisions"} FROM ${this.table} WHERE slot=?`).get(slot);
    this.current();
    if (!row) return null;
    if (row.binding !== key) throw new Error('Import journal belongs to another endpoint, project, workspace or principal');
    const command = workLedgerCommandSchema.parse(JSON.parse(row.command));
    if (command.type !== 'import_legacy' || command.manifest.projectId !== binding.projectId) throw new Error('Invalid import journal command');
    if (!['pending', 'unknown', 'accepted', 'rejected', 'cancelled'].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Error('Invalid import journal state');
    const decisions = array(strictObject({}).passthrough()).parse(JSON.parse(row.decisions)).map(parseJevDecision);
    if (new Set(decisions.map(item => item.decisionId)).size !== decisions.length) throw new Error('Duplicate decision identity');
    return { binding: { endpoint: binding.endpoint, projectId: binding.projectId, workspaceId: binding.workspaceId, principalId: binding.principalId, principalKind: binding.principalKind }, command, state: row.state, attempts: row.attempts, receiptActorId: row.actor, result: row.result === null ? null : legacyImportResultSchema.parse(JSON.parse(row.result)), decisions };
  }
  /** Explicit local mutation intent may recover an original hot SQLite journal
   * after declaring its reader floor. This never dispatches or remints a request.
   */
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
      // No SQL write precedes borrowed command construction. If it retires the
      // original path/owner, rollback has no newly created sidecar to resolve.
      const made: unknown = makeCommand();
      if (nodeTypes.isPromise(made)) { drainOwned(made); this.current(); throw new Error('Import command construction must be synchronous'); }
      this.current();
      const command = workLedgerCommandSchema.parse(made); this.current();
      if (command.type !== 'import_legacy' || command.manifest.projectId !== binding.projectId || bindingKey(binding) !== key || this.slot(binding) !== slot) throw new Error('Invalid or changed import target');
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
    const expected = workLedgerCommandSchema.parse(command); this.current();
    if (expected.type !== 'import_legacy' || expected.manifest.projectId !== binding.projectId) throw new Error('Invalid import target');
    const current = this.read(binding);
    if (current && JSON.stringify(current.command) !== JSON.stringify(expected)) throw new Error('Import command changed');
    return current;
  }
  cancel(binding: LegacyImportBinding, command: LegacyImportCommand): LegacyImportEntry | null {
    const slot = this.slot(binding);
    return this.mutate(db => { if (this.readExpected(binding, command)?.state === 'pending') db.query(`UPDATE ${this.table} SET state='cancelled' WHERE slot=?`).run(slot); return this.read(binding); });
  }
  /** Only call at the authenticated host transport boundary, after real gate admission of this exact command. */
  dispatch(binding: LegacyImportBinding, command: LegacyImportCommand, expected?: Pick<LegacyImportEntry, 'state' | 'attempts'>): LegacyImportEntry {
    const slot = this.slot(binding);
    return this.mutate(db => {
      const current = this.readExpected(binding, command);
      if (expected && (!current || current.state !== expected.state || current.attempts !== expected.attempts)) throw new Error('Import dispatch state changed');
      if (!current || !['pending', 'unknown'].includes(current.state)) throw new Error('Import cannot be dispatched');
      this.current();
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
