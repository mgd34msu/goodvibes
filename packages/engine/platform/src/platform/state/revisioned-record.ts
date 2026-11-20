/**
 * Revisioned records: compare-and-set writes and durable claims with an owner epoch.
 *
 * Every record more than one writer can change carries a `revision` that starts
 * at 1 and moves up by one on every applied write. A writer that read before an
 * await presents the revision it read; the write applies only while the record
 * still holds it, and the compare is part of the same SQL statement or the same
 * store lock that applies the write. A lost race is an answer (`applied: false`
 * with the current record), never an exception and never a silent overwrite.
 *
 * A claim says who owns a piece of work, under which epoch, until when. The
 * epoch is the claim record's revision at claim time; a newer claim of the same
 * key moves it, so an older owner's `settle` is refused in the statement that
 * would have applied it.
 *
 * Cost: a SQLite CAS adds a predicate to the UPDATE that already runs (0 extra
 * statements); a refused write costs one SELECT to return `current`, only on
 * conflict. The JSON form compares inside the lock the store already holds.
 */
import type { Database } from 'bun:sqlite';

/** Every record that more than one writer can change carries this. */
export interface Revisioned { readonly revision: number }

/** Outcome of a conditional write. A lost race is an answer, never an exception and never a silent overwrite. */
export type CasOutcome<T> =
  | { readonly applied: true; readonly record: T & Revisioned }
  | { readonly applied: false; readonly reason: 'changed' | 'missing'; readonly current: (T & Revisioned) | null };

/** A durable claim: who owns a piece of work, under which epoch, until when. */
export interface ClaimToken {
  /** What is owned: "contract:c-1", "input:s-1/i-9", "idem:k". */
  readonly key: string;
  /** Process/run identity, e.g. `${nodeId}:${pid}:${runId}`. */
  readonly owner: string;
  /** The claim record's revision at claim time. */
  readonly epoch: number;
  readonly expiresAt: number;
}

/** Claim and settle helpers built on the two forms. */
export interface ClaimTable {
  /** Take `key` for `owner`, or report the live claim another owner holds. Re-claiming one's own key moves the epoch. */
  claim(key: string, owner: string, ttlMs: number, now: number): { readonly token: ClaimToken } | { readonly held: ClaimToken };
  /** Extend the claim by its ttl. null: superseded or expired. */
  renew(token: ClaimToken, now: number): ClaimToken | null;
  /** Runs `write` only while `token` is still the record's epoch; the epoch compare is part of the same statement or lock. */
  settle<T>(token: ClaimToken, write: () => T): { readonly applied: true; readonly value: T } | { readonly applied: false; readonly current: ClaimToken | null };
  /** Give the claim up. False when it was no longer this token's. Moves the epoch, so the released token settles nothing. */
  release(token: ClaimToken): boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new TypeError(`Not a SQL identifier: ${JSON.stringify(name)}`);
  return name;
}

/**
 * SQLite form: the table has `revision INTEGER NOT NULL DEFAULT 1`, and this builds the conditional UPDATE.
 * Bind the set values in order, then the id, then the expected revision; `changes === 0` means refused.
 */
export function casUpdateSql(table: string, setColumns: readonly string[]): string {
  if (setColumns.length === 0) throw new TypeError('casUpdateSql needs at least one column to set.');
  const sets = setColumns.map(column => `${identifier(column)} = ?`);
  return `UPDATE ${identifier(table)} SET ${sets.join(', ')}, revision = revision + 1 WHERE id = ? AND revision = ?`;
}

/**
 * JSON-file form: call inside the store's existing process lock. Reads the
 * current record, compares its revision with `expected`, and writes the next
 * record with `revision + 1`. `write` must finish before the lock is released.
 */
export function casInLock<T extends Revisioned>(
  read: () => T | null,
  expected: number,
  write: (next: T) => void,
  next: (current: T) => Omit<T, 'revision'>,
): CasOutcome<T> {
  const current = read();
  if (current === null) return { applied: false, reason: 'missing', current: null };
  if (current.revision !== expected) return { applied: false, reason: 'changed', current };
  const record = { ...next(current), revision: current.revision + 1 } as T;
  write(record);
  return { applied: true, record };
}

interface ClaimRow { readonly owner: string; readonly revision: number; readonly expires_at: number; readonly ttl_ms: number }

/** The table a SQLite claim table needs; run it in the store's migration. */
export function claimTableSchemaSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${identifier(table)} (
    key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL
  )`;
}

function tokenOf(key: string, row: ClaimRow): ClaimToken {
  return Object.freeze({ key, owner: row.owner, epoch: row.revision, expiresAt: row.expires_at });
}

/**
 * Claims in a SQLite table (schema from {@link claimTableSchemaSql}), for work
 * several processes may race for. Every operation is one immediate transaction
 * through `file.tx`, so the compare and the write it guards are one unit. A
 * released key keeps its row (expired, epoch moved) so an old token can never
 * match a later claim's epoch.
 */
export function sqliteClaimTable(file: { readonly db: Database; tx<T>(fn: () => T): T }, table: string): ClaimTable {
  const name = identifier(table);
  const { db } = file;
  const select = db.query<ClaimRow, [string]>(`SELECT owner, revision, expires_at, ttl_ms FROM ${name} WHERE key = ?`);
  const insert = db.query(`INSERT INTO ${name} (key, owner, revision, expires_at, ttl_ms) VALUES (?, ?, 1, ?, ?)`);
  const take = db.query(`UPDATE ${name} SET owner = ?, revision = revision + 1, expires_at = ?, ttl_ms = ? WHERE key = ?`);
  const extend = db.query(`UPDATE ${name} SET expires_at = ? + ttl_ms WHERE key = ? AND owner = ? AND revision = ? AND expires_at > ?`);
  const drop = db.query(`UPDATE ${name} SET revision = revision + 1, expires_at = 0 WHERE key = ? AND owner = ? AND revision = ?`);
  return {
    claim(key, owner, ttlMs, now) {
      return file.tx(() => {
        const row = select.get(key);
        if (row && row.expires_at > now && row.owner !== owner) return { held: tokenOf(key, row) };
        const expiresAt = now + ttlMs;
        if (row) take.run(owner, expiresAt, ttlMs, key);
        else insert.run(key, owner, expiresAt, ttlMs);
        return { token: tokenOf(key, select.get(key)!) };
      });
    },
    renew(token, now) {
      return file.tx(() => {
        if (extend.run(now, token.key, token.owner, token.epoch, now).changes === 0) return null;
        return tokenOf(token.key, select.get(token.key)!);
      });
    },
    settle(token, write) {
      return file.tx(() => {
        const row = select.get(token.key);
        if (!row || row.owner !== token.owner || row.revision !== token.epoch) {
          return { applied: false as const, current: row ? tokenOf(token.key, row) : null };
        }
        return { applied: true as const, value: write() };
      });
    },
    release(token) {
      return file.tx(() => drop.run(token.key, token.owner, token.epoch).changes > 0);
    },
  };
}

/**
 * Claims held in this process only (idempotency records, in-memory leases):
 * one integer per record. `settle`'s `write` must be synchronous for the
 * compare and the write to be one unit.
 */
export function memoryClaimTable(): ClaimTable {
  const rows = new Map<string, ClaimRow>();
  const live = (token: ClaimToken): ClaimRow | undefined => {
    const row = rows.get(token.key);
    return row && row.owner === token.owner && row.revision === token.epoch ? row : undefined;
  };
  return {
    claim(key, owner, ttlMs, now) {
      const row = rows.get(key);
      if (row && row.expires_at > now && row.owner !== owner) return { held: tokenOf(key, row) };
      const next: ClaimRow = { owner, revision: (row?.revision ?? 0) + 1, expires_at: now + ttlMs, ttl_ms: ttlMs };
      rows.set(key, next);
      return { token: tokenOf(key, next) };
    },
    renew(token, now) {
      const row = live(token);
      if (!row || row.expires_at <= now) return null;
      const next: ClaimRow = { ...row, expires_at: now + row.ttl_ms };
      rows.set(token.key, next);
      return tokenOf(token.key, next);
    },
    settle(token, write) {
      if (!live(token)) {
        const row = rows.get(token.key);
        return { applied: false, current: row ? tokenOf(token.key, row) : null };
      }
      return { applied: true, value: write() };
    },
    release(token) {
      const row = live(token);
      if (!row) return false;
      rows.set(token.key, { ...row, revision: row.revision + 1, expires_at: 0 });
      return true;
    },
  };
}
