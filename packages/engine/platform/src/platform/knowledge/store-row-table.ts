/**
 * A knowledge table read through SQL, with the Map surface the store's helpers
 * are written against.
 *
 * The SQLite file is the one owner of the rows: every answer comes from it.
 * What a table keeps is a decode memo per row, checked against the row's stamp
 * (its `gv_revision` where the table has one, otherwise its stored values), so
 * an unchanged row returns the same object on every read. That identity is
 * what the store's staleness checks compare (`store.getNode(id) !== record`).
 * A row another process committed, a write that rolled back, or a write that
 * never told the table reads as what is stored, never as something remembered.
 *
 * Cost: while nothing was written (by this process, or by another one, which
 * is noticed once per turn through `PRAGMA data_version`), a read is a map
 * lookup. After a write, the first read of a row is one indexed statement, and
 * a scan is one statement over keys and stamps that decodes only changed rows.
 *
 * `set` writes nothing: the caller wrote the row. It binds the caller's record
 * to the row as now stored, so the object a writer returns is the object later
 * reads return. `delete` and `clear` only forget.
 */
import type { SQLiteStore } from '../state/sqlite-store.js';
import { IndexedRecordMap } from './store-indexed-map.js';
import type { KnowledgeNodeRevisionRecord } from './types.js';

type SqlParam = string | number;

export interface KnowledgeRowKey {
  /** SQL expression giving a row's key (a column name for a plain id). */
  readonly select: string;
  /** WHERE clause selecting one row by key. */
  readonly where: string;
  readonly params: (key: string) => SqlParam[];
  /**
   * WHERE clause selecting the rows whose keys are in one JSON array parameter,
   * when `select` is an expression an index cannot serve.
   */
  readonly whereIn?: string | undefined;
}

/** The key of a table whose rows are keyed by one column. */
export function keyColumn(column: string): KnowledgeRowKey {
  return { select: column, where: `${column} = ?`, params: (key) => [key] };
}

export interface KnowledgeRowLookup<T> {
  /** A record's secondary key, as the staging copy indexes it. */
  readonly keyOf: (record: T) => string | undefined;
  /** WHERE clause selecting the rows with one secondary key. */
  readonly where: string;
  readonly params: (key: string) => SqlParam[];
  /**
   * The column holding the secondary key, when the key is that column's value
   * as `where` compares it and a unique index allows at most one row per key;
   * lets many keys be answered in one statement.
   */
  readonly uniqueColumn?: string | undefined;
}

export interface KnowledgeRowTableSpec<T> {
  readonly table: string;
  readonly key: KnowledgeRowKey;
  /** Column SQLite rewrites on every write of a row; without one the stored values are compared. */
  readonly revisionColumn?: string | undefined;
  readonly decode: (columns: string[], values: unknown[]) => T;
  readonly lookup?: KnowledgeRowLookup<T> | undefined;
}

interface MemoEntry<T> {
  /** The row's revision, or its stored values for a table without one. */
  stamp: unknown;
  /** The read epoch this entry was last checked against the row. */
  epoch: number;
  record: T;
}

const KEY_COLUMN = 'gv_row_key';
/** Per-epoch negative and secondary-key answers kept at most. */
const ANSWER_BOUND = 10_000;
/** Changed rows a scan fetches one by one; above this one statement reads them all. */
const SINGLE_FETCH_LIMIT = 32;

function sameValues(stamp: unknown, values: readonly unknown[], length: number): boolean {
  if (!Array.isArray(stamp) || stamp.length !== length) return false;
  for (let index = 0; index < length; index++) if (stamp[index] !== values[index]) return false;
  return true;
}

/** A SQL LIMIT with the meaning `slice(0, Math.max(1, limit))` has. */
export function sqlLimit(limit: number): number {
  const bounded = Math.max(1, limit);
  if (Number.isNaN(bounded)) return 0;
  return Number.isFinite(bounded) ? Math.trunc(bounded) : -1;
}

export class KnowledgeRowTable<T extends object> implements Map<string, T> {
  readonly [Symbol.toStringTag] = 'KnowledgeRowTable';
  readonly #sqlite: () => SQLiteStore;
  readonly #spec: KnowledgeRowTableSpec<T>;
  readonly #memo = new Map<string, MemoEntry<T>>();
  readonly #absent = new Set<string>();
  #absentEpoch = -1;
  readonly #lookups = new Map<string, string | null>();
  #lookupEpoch = -1;
  #scan: Map<string, T> | undefined;
  #scanEpoch = -1;
  /** The scan's records by secondary key, built when primeLookups() reads every row. */
  #scanLookups: Map<string, T> | undefined;
  #scanLookupsEpoch = -1;
  #size = 0;
  #sizeEpoch = -1;

  constructor(sqlite: () => SQLiteStore, spec: KnowledgeRowTableSpec<T>) {
    this.#sqlite = sqlite;
    this.#spec = spec;
  }

  /** Decoded records held for reuse (not the row count). */
  get retainedCount(): number {
    return this.#memo.size;
  }

  get size(): number {
    const sqlite = this.#open();
    if (!sqlite) return 0;
    const epoch = sqlite.readEpoch();
    if (this.#sizeEpoch !== epoch) {
      this.#size = Number(sqlite.exec(`SELECT COUNT(*) FROM ${this.#spec.table}`)[0]?.values[0]?.[0] ?? 0);
      this.#sizeEpoch = epoch;
    }
    return this.#size;
  }

  get(key: string): T | undefined {
    const sqlite = this.#open();
    if (!sqlite || typeof key !== 'string') return undefined;
    const epoch = sqlite.readEpoch();
    const entry = this.#memo.get(key);
    if (entry && entry.epoch === epoch) return entry.record;
    // A whole-table read at this epoch knows every row: a key it lacks is not stored.
    if (this.#scanEpoch === epoch) return this.#scan?.get(key);
    if (this.#absentEpoch === epoch && this.#absent.has(key)) return undefined;
    const { table, key: rowKey, revisionColumn } = this.#spec;
    if (revisionColumn && entry) {
      const stamp = sqlite.exec(`SELECT ${revisionColumn} FROM ${table} WHERE ${rowKey.where} LIMIT 1`, rowKey.params(key))[0]?.values[0];
      if (!stamp) return this.#missing(key, epoch);
      if (stamp[0] === entry.stamp) { entry.epoch = epoch; return entry.record; }
    }
    return this.#fetch(sqlite, key, epoch);
  }

  has(key: string): boolean {
    const sqlite = this.#open();
    if (!sqlite || typeof key !== 'string') return false;
    const epoch = sqlite.readEpoch();
    if (this.#memo.get(key)?.epoch === epoch) return true;
    if (this.#absentEpoch === epoch && this.#absent.has(key)) return false;
    const { table, key: rowKey } = this.#spec;
    if (sqlite.exec(`SELECT 1 FROM ${table} WHERE ${rowKey.where} LIMIT 1`, rowKey.params(key))[0]?.values[0]) return true;
    this.#missing(key, epoch);
    return false;
  }

  /** Binds `record` (just written by the caller) to the stored row; writes nothing. */
  set(key: string, record: T): this {
    const sqlite = this.#open();
    if (!sqlite) return this;
    const epoch = sqlite.readEpoch();
    const { table, key: rowKey, revisionColumn } = this.#spec;
    const values = sqlite.exec(`SELECT ${revisionColumn ?? '*'} FROM ${table} WHERE ${rowKey.where} LIMIT 1`, rowKey.params(key))[0]?.values[0];
    this.#scanEpoch = -1;
    this.#lookupEpoch = -1;
    if (!values) { this.#missing(key, epoch); return this; }
    this.#memo.set(key, { stamp: revisionColumn ? values[0] : values, epoch, record });
    this.#absent.delete(key);
    return this;
  }

  /** The stored record, or `value` bound as `set` binds it (nothing is written). */
  getOrInsert(key: string, value: T): T {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    this.set(key, value);
    return value;
  }

  /** The stored record, or the computed one bound as `set` binds it (nothing is written). */
  getOrInsertComputed(key: string, compute: (key: string) => T): T {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = compute(key);
    this.set(key, value);
    return value;
  }

  /** Forgets the decoded record; the caller deleted the row. */
  delete(key: string): boolean {
    this.#scanEpoch = -1;
    this.#lookupEpoch = -1;
    return this.#memo.delete(key);
  }

  /** Forgets every decoded record; nothing is deleted. */
  clear(): void {
    this.#memo.clear();
    this.#absent.clear();
    this.#lookups.clear();
    this.#scan = undefined;
    this.#scanEpoch = -1;
    this.#lookupEpoch = -1;
    this.#sizeEpoch = -1;
  }

  /**
   * Drops what is derived from the decoded records (the whole-table read, the
   * secondary-key and absent-key answers), rebuilt by the next read that needs
   * them. The decoded records stay: their identity is what staleness checks compare.
   */
  releaseDerived(): void {
    this.#absent.clear();
    this.#lookups.clear();
    this.#scan = undefined;
    this.#scanLookups = undefined;
    this.#absentEpoch = -1;
    this.#lookupEpoch = -1;
    this.#scanEpoch = -1;
    this.#scanLookupsEpoch = -1;
  }

  /** The record whose secondary key is `key` (first stored, when several share it). */
  lookup(key: string): T | undefined {
    const lookup = this.#spec.lookup;
    const sqlite = this.#open();
    if (!lookup || !sqlite) return undefined;
    const epoch = sqlite.readEpoch();
    if (this.#scanLookupsEpoch === epoch && this.#scanEpoch === epoch) return this.#scanLookups?.get(key);
    if (this.#lookupEpoch !== epoch) { this.#lookups.clear(); this.#lookupEpoch = epoch; }
    let id = this.#lookups.get(key);
    if (id === undefined) {
      const row = sqlite.exec(`SELECT ${this.#spec.key.select} FROM ${this.#spec.table} WHERE ${lookup.where} ORDER BY rowid LIMIT 1`, lookup.params(key))[0]?.values[0];
      id = row ? String(row[0]) : null;
      if (this.#lookups.size < ANSWER_BOUND) this.#lookups.set(key, id);
    }
    return id === null ? undefined : this.get(id);
  }

  /**
   * Reads ahead so that each later get() is a map lookup until something is
   * written. Without `keys` every row is read (one statement, two for a table
   * with a revision column; nothing while the last whole read is current).
   * With `keys`, the rows of those not yet read since the last change are read
   * in one statement (two with a revision column).
   */
  prime(keys?: Iterable<string>): void {
    const sqlite = this.#open();
    if (!sqlite) return;
    if (!keys) { this.#all(); return; }
    const epoch = sqlite.readEpoch();
    if (this.#scanEpoch === epoch) return;
    if (this.#absentEpoch !== epoch) { this.#absent.clear(); this.#absentEpoch = epoch; }
    const pending: string[] = [];
    for (const key of keys) {
      if (typeof key !== 'string' || this.#memo.get(key)?.epoch === epoch || this.#absent.has(key)) continue;
      pending.push(key);
    }
    if (pending.length === 0) return;
    const found = this.#select(sqlite, epoch, this.#spec.key.whereIn ?? `${this.#spec.key.select} IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(pending)], '', 0);
    for (const key of pending) if (!found.has(key)) this.#missing(key, epoch);
  }

  /**
   * Reads ahead so that each later lookup() is a map lookup until something is
   * written, for a table whose lookup has a unique key column (otherwise
   * nothing is read ahead and lookup() answers one key at a time). Without
   * `keys` every row is read, as prime() does; with `keys`, those not yet
   * answered since the last change are answered in one statement and the rows
   * found are primed.
   */
  primeLookups(keys?: Iterable<string>): void {
    const lookup = this.#spec.lookup;
    const sqlite = this.#open();
    if (!lookup?.uniqueColumn || !sqlite) return;
    const epoch = sqlite.readEpoch();
    if (this.#scanLookupsEpoch === epoch && this.#scanEpoch === epoch) return;
    if (!keys) {
      const scan = this.#all();
      const index = new Map<string, T>();
      for (const record of scan.values()) {
        const key = lookup.keyOf(record);
        if (key !== undefined && !index.has(key)) index.set(key, record);
      }
      this.#scanLookups = index;
      this.#scanLookupsEpoch = this.#scanEpoch;
      return;
    }
    if (this.#lookupEpoch !== epoch) { this.#lookups.clear(); this.#lookupEpoch = epoch; }
    const wanted: string[] = [];
    const pending: string[] = [];
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      wanted.push(key);
      if (!this.#lookups.has(key)) pending.push(key);
    }
    if (pending.length > 0) {
      const rows = sqlite.exec(`SELECT ${lookup.uniqueColumn}, ${this.#spec.key.select} FROM ${this.#spec.table}
        WHERE ${lookup.uniqueColumn} IN (SELECT value FROM json_each(?))`, [JSON.stringify(pending)])[0]?.values ?? [];
      const answers = new Map<string, string>();
      for (const [lookupKey, id] of rows) answers.set(String(lookupKey), String(id));
      for (const key of pending) {
        if (this.#lookups.size >= ANSWER_BOUND) break;
        this.#lookups.set(key, answers.get(key) ?? null);
      }
    }
    const ids: string[] = [];
    for (const key of wanted) { const id = this.#lookups.get(key); if (typeof id === 'string') ids.push(id); }
    if (ids.length > 0) this.prime(ids);
  }

  /** A staging copy with the same secondary index, for a change built before it is written. */
  copy(): IndexedRecordMap<T> {
    return new IndexedRecordMap<T>(this.#spec.lookup?.keyOf ?? (() => undefined), this.#all());
  }

  /**
   * The records whose rows match `where` (SQL over this table's columns), in
   * the order `suffix` (`ORDER BY ... LIMIT ?`) gives; `params` binds both.
   */
  select(where: string, params: SqlParam[] = [], suffix = ''): T[] {
    const sqlite = this.#open();
    if (!sqlite) return [];
    return [...this.#select(sqlite, sqlite.readEpoch(), where, params, suffix).values()];
  }

  values(): MapIterator<T> { return this.#all().values(); }
  keys(): MapIterator<string> { return this.#all().keys(); }
  entries(): MapIterator<[string, T]> { return this.#all().entries(); }
  [Symbol.iterator](): MapIterator<[string, T]> { return this.#all()[Symbol.iterator](); }

  forEach(callback: (value: T, key: string, map: Map<string, T>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#all()) callback.call(thisArg, value, key, this);
  }

  /** The table reads as empty while its database is not open (before init, after close). */
  #open(): SQLiteStore | null {
    const sqlite = this.#sqlite();
    return sqlite.isReady ? sqlite : null;
  }

  #missing(key: string, epoch: number): undefined {
    this.#memo.delete(key);
    if (this.#absentEpoch !== epoch) { this.#absent.clear(); this.#absentEpoch = epoch; }
    if (this.#absent.size < ANSWER_BOUND) this.#absent.add(key);
    return undefined;
  }

  /** Reads the whole row; reuses the remembered record when the row is unchanged. */
  #fetch(sqlite: SQLiteStore, key: string, epoch: number): T | undefined {
    const { table, key: rowKey } = this.#spec;
    const rows = sqlite.exec(`SELECT * FROM ${table} WHERE ${rowKey.where} LIMIT 1`, rowKey.params(key))[0];
    const values = rows?.values[0];
    if (!rows || !values) return this.#missing(key, epoch);
    return this.#remember(key, rows.columns, values, values.length, epoch);
  }

  #remember(key: string, columns: string[], values: unknown[], length: number, epoch: number): T {
    const revisionColumn = this.#spec.revisionColumn;
    const stamp = revisionColumn ? values[columns.indexOf(revisionColumn)] : values.slice(0, length);
    const entry = this.#memo.get(key);
    if (entry && (revisionColumn ? entry.stamp === stamp : sameValues(entry.stamp, values, length))) {
      entry.epoch = epoch;
      return entry.record;
    }
    const record = this.#spec.decode(length === columns.length ? columns : columns.slice(0, length), length === values.length ? values : values.slice(0, length));
    this.#memo.set(key, { stamp, epoch, record });
    this.#absent.delete(key);
    return record;
  }

  #all(): Map<string, T> {
    const sqlite = this.#open();
    if (!sqlite) return new Map();
    const epoch = sqlite.readEpoch();
    if (this.#scan && this.#scanEpoch === epoch) return this.#scan;
    const scan = this.#select(sqlite, epoch, '', [], '');
    // Rows that are gone since the last scan leave the memo.
    for (const key of this.#memo.keys()) if (!scan.has(key)) this.#memo.delete(key);
    this.#scan = scan;
    this.#scanEpoch = epoch;
    return scan;
  }

  #select(sqlite: SQLiteStore, epoch: number, where: string, params: SqlParam[], suffix: string,
    singleFetchLimit = SINGLE_FETCH_LIMIT): Map<string, T> {
    const { table, key, revisionColumn } = this.#spec;
    const clause = where ? ` WHERE ${where}` : '';
    const out = new Map<string, T>();
    if (!revisionColumn) {
      const rows = sqlite.exec(`SELECT *, ${key.select} AS ${KEY_COLUMN} FROM ${table}${clause}${suffix}`, params)[0];
      if (!rows) return out;
      const length = rows.columns.length - 1;
      for (const values of rows.values) {
        const id = String(values[length]);
        out.set(id, this.#remember(id, rows.columns, values, length, epoch));
      }
      return out;
    }
    const stamps = sqlite.exec(`SELECT ${key.select} AS ${KEY_COLUMN}, ${revisionColumn} FROM ${table}${clause}${suffix}`, params)[0]?.values ?? [];
    const order: string[] = [];
    const changed = new Set<string>();
    for (const [rawKey, stamp] of stamps) {
      const id = String(rawKey);
      order.push(id);
      const entry = this.#memo.get(id);
      if (entry && entry.stamp === stamp) entry.epoch = epoch;
      else changed.add(id);
    }
    if (changed.size > singleFetchLimit) {
      const rows = sqlite.exec(`SELECT *, ${key.select} AS ${KEY_COLUMN} FROM ${table}${clause}${suffix}`, params)[0];
      if (rows) {
        const length = rows.columns.length - 1;
        for (const values of rows.values) {
          const id = String(values[length]);
          if (changed.has(id)) this.#remember(id, rows.columns, values, length, epoch);
        }
      }
    } else {
      for (const id of changed) this.#fetch(sqlite, id, epoch);
    }
    for (const id of order) {
      const entry = this.#memo.get(id);
      if (entry && entry.epoch === epoch) out.set(id, entry.record);
    }
    return out;
  }
}

/** Records of a row table matching `where`, or of a plain map matching `matches`. */
export function selectRecords<T extends object>(records: ReadonlyMap<string, T>, where: string, params: SqlParam[], suffix: string,
  matches: (record: T) => boolean): T[] {
  if (records instanceof KnowledgeRowTable) return records.select(where, params, suffix);
  return [...records.values()].filter(matches);
}

/**
 * A node's revision history, read through SQL as one list per node (oldest
 * first). Rows are only appended, and deleted with their node; a list is
 * reused while its count and newest row id are unchanged. `set` writes
 * nothing: revisions are written as rows by the node writers.
 */
export class KnowledgeNodeRevisionRows implements Map<string, KnowledgeNodeRevisionRecord[]> {
  readonly [Symbol.toStringTag] = 'KnowledgeNodeRevisionRows';
  readonly #sqlite: () => SQLiteStore;
  readonly #decode: (columns: string[], values: unknown[]) => KnowledgeNodeRevisionRecord;
  readonly #memo = new Map<string, { stamp: string; epoch: number; records: readonly KnowledgeNodeRevisionRecord[] }>();

  constructor(sqlite: () => SQLiteStore, decode: (columns: string[], values: unknown[]) => KnowledgeNodeRevisionRecord) {
    this.#sqlite = sqlite;
    this.#decode = decode;
  }

  get retainedCount(): number {
    return this.#memo.size;
  }

  get size(): number {
    const sqlite = this.#open();
    return sqlite ? Number(sqlite.exec('SELECT COUNT(DISTINCT node_id) FROM knowledge_node_revisions')[0]?.values[0]?.[0] ?? 0) : 0;
  }

  /** A fresh array of the node's revisions, oldest first; undefined when it has none. */
  get(nodeId: string): KnowledgeNodeRevisionRecord[] | undefined {
    const sqlite = this.#open();
    if (!sqlite || typeof nodeId !== 'string') return undefined;
    const epoch = sqlite.readEpoch();
    const entry = this.#memo.get(nodeId);
    if (entry && entry.epoch === epoch) return [...entry.records];
    const head = sqlite.exec(`SELECT COUNT(*), (SELECT id FROM knowledge_node_revisions WHERE node_id = ? ORDER BY revision DESC LIMIT 1)
      FROM knowledge_node_revisions WHERE node_id = ?`, [nodeId, nodeId])[0]?.values[0];
    const count = Number(head?.[0] ?? 0);
    if (count === 0) { this.#memo.delete(nodeId); return undefined; }
    const stamp = `${count}:${String(head?.[1])}`;
    if (entry && entry.stamp === stamp) { entry.epoch = epoch; return [...entry.records]; }
    const rows = sqlite.exec('SELECT * FROM knowledge_node_revisions WHERE node_id = ? ORDER BY revision', [nodeId])[0];
    const records = rows ? rows.values.map((values) => this.#decode(rows.columns, values)) : [];
    if (this.#memo.size >= 1_000) this.#memo.clear();
    this.#memo.set(nodeId, { stamp, epoch, records });
    return [...records];
  }

  has(nodeId: string): boolean {
    return this.get(nodeId) !== undefined;
  }

  /** Revisions are written as rows by the node writers; nothing to do here. */
  set(_nodeId: string, _records: KnowledgeNodeRevisionRecord[]): this {
    return this;
  }

  /** The node's revisions, or `records` when it has none (revisions are written by the node writers). */
  getOrInsert(nodeId: string, records: KnowledgeNodeRevisionRecord[]): KnowledgeNodeRevisionRecord[] {
    return this.get(nodeId) ?? records;
  }

  /** The node's revisions, or the computed list when it has none (nothing is written). */
  getOrInsertComputed(nodeId: string, compute: (nodeId: string) => KnowledgeNodeRevisionRecord[]): KnowledgeNodeRevisionRecord[] {
    return this.get(nodeId) ?? compute(nodeId);
  }

  delete(nodeId: string): boolean {
    return this.#memo.delete(nodeId);
  }

  clear(): void {
    this.#memo.clear();
  }

  /** Every read hands out a fresh list, so the remembered lists can all go; the next read decodes again. */
  releaseDerived(): void {
    this.#memo.clear();
  }

  values(): MapIterator<KnowledgeNodeRevisionRecord[]> { return this.#all().values(); }
  keys(): MapIterator<string> { return this.#all().keys(); }
  entries(): MapIterator<[string, KnowledgeNodeRevisionRecord[]]> { return this.#all().entries(); }
  [Symbol.iterator](): MapIterator<[string, KnowledgeNodeRevisionRecord[]]> { return this.#all()[Symbol.iterator](); }

  forEach(callback: (value: KnowledgeNodeRevisionRecord[], key: string, map: Map<string, KnowledgeNodeRevisionRecord[]>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#all()) callback.call(thisArg, value, key, this);
  }

  #open(): SQLiteStore | null {
    const sqlite = this.#sqlite();
    return sqlite.isReady ? sqlite : null;
  }

  #all(): Map<string, KnowledgeNodeRevisionRecord[]> {
    const out = new Map<string, KnowledgeNodeRevisionRecord[]>();
    const sqlite = this.#open();
    const rows = sqlite?.exec('SELECT * FROM knowledge_node_revisions ORDER BY node_id, revision')[0];
    if (!rows) return out;
    for (const values of rows.values) {
      const record = this.#decode(rows.columns, values);
      const list = out.get(record.nodeId);
      if (list) list.push(record);
      else out.set(record.nodeId, [record]);
    }
    return out;
  }
}
