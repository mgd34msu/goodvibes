/**
 * records-carry.ts, carrying records kept under one folder's `.goodvibes/` into another's, once, without dropping any
 * and without touching the old files (a release put back reads them as it left them).
 *
 * One rule for every carry of this kind (the daemon's own records into its home, daemon-records.ts; a program's records
 * kept under the subfolder it was opened in into its project's, project-folder-records.ts): a record the target does not
 * hold is copied (a SQLite store with its write-ahead files); one it holds already is merged: SQLite row by row (a row
 * already there kept), JSON lines by line, JSON by key and by id (the target's value kept where both set one), a text log
 * by appending the lines it does not have (counted: a line held twice is carried twice; a last line cut off mid-write is
 * not a line); any other single value is kept as the target holds it and the other named. A record is copied or
 * rewritten whole (a temporary file, then a rename), and the worktrees register only under its own writer lock, so a
 * carry cut off half way leaves what the next start completes. The caller holds one lock for the whole carry.
 * Process locks and SQLite side files are never carried as files of their own. A waiting approval is carried as one
 * nothing waits for (the process that asked is gone), so it is never listed as waiting for the owner.
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { summarizeError } from '../utils/error-display.js';
import { withProcessLockSync } from '../utils/process-lock.js';

export type CarriedJson = null | boolean | number | string | CarriedJson[] | { [key: string]: CarriedJson };

/** What one carry did, each entry a path under `.goodvibes/` (and where it came from). */
export interface RecordsCarryResult {
  readonly copied: string[];
  readonly merged: string[];
  readonly singleValues: string[];
  readonly failed: string[];
}

/** Process locks and SQLite side files are never carried as files of their own. */
export function isRecordSideFile(name: string): boolean {
  return /\.(lock|held|owner-lock)$/.test(name) || name.endsWith('.writer.sqlite') || name.endsWith('-wal') || name.endsWith('-shm')
    || name.includes('.writer.lock') || /\.unreadable-\d+/.test(name) || /\.carry-\d+$/.test(name);
}

function isSqlite(name: string): boolean {
  return name.endsWith('.sqlite') || name.endsWith('.db');
}

/** Every file under `path` (itself when it is a file). */
export function recordFilesUnder(path: string): string[] {
  let stat;
  try { stat = statSync(path); } catch { return []; }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => recordFilesUnder(join(path, name)));
}

function isObject(value: CarriedJson | undefined): value is { [key: string]: CarriedJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The key an array item is known by: its id (or sessionId, key, name), else its whole text. */
function itemKey(item: CarriedJson): string {
  if (isObject(item)) {
    for (const field of ['id', 'sessionId', 'key', 'name']) {
      const value = item[field];
      if (typeof value === 'string' || typeof value === 'number') return `${field}:${value}`;
    }
  }
  return `json:${JSON.stringify(item)}`;
}

/** `kept` merged with `other`: nothing either holds is dropped; where both set a value, `kept`'s stays. */
export function mergeCarriedJson(kept: CarriedJson, other: CarriedJson): CarriedJson {
  if (isObject(kept) && isObject(other)) {
    const out: { [key: string]: CarriedJson } = { ...kept };
    for (const [key, value] of Object.entries(other)) out[key] = key in kept ? mergeCarriedJson(kept[key]!, value) : value;
    return out;
  }
  if (Array.isArray(kept) && Array.isArray(other)) {
    const seen = new Set(kept.map(itemKey));
    return [...kept, ...other.filter((item) => !seen.has(itemKey(item)))];
  }
  return kept;
}

/**
 * An approval left waiting by a process that is gone: nothing waits for its answer now. Carried as an in-process ask,
 * which the approvals broker settles at load as cancelled ("the process that asked restarted"); its record and audit
 * stay. Any other line is carried as it is.
 */
export function carriedApprovalLine(line: string): string {
  let record: CarriedJson;
  try { record = JSON.parse(line) as CarriedJson; } catch { return line; }
  if (!isObject(record) || (record['status'] !== 'pending' && record['status'] !== 'claimed')) return line;
  return JSON.stringify({ ...record, requester: { kind: 'in-process' } });
}

/** Write `text` at `to` whole or not at all (a temporary file beside it, then a rename). */
function writeWhole(to: string, text: string | Buffer): void {
  const temporary = `${to}.carry-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, to);
}

/**
 * Copy `from` to `to` whole or not at all: the side files first, the record itself last by a rename, so a carry cut off
 * half way leaves no record at `to` (the next start copies it again) and never a half-copied one it would merge into.
 */
function copyWithSideFiles(from: string, to: string, transform?: (text: string) => string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  for (const suffix of ['-wal', '-shm']) if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
  const temporary = `${to}.carry-${process.pid}`;
  if (transform) writeFileSync(temporary, transform(readFileSync(from, 'utf-8')), { mode: 0o600 });
  else copyFileSync(from, temporary);
  renameSync(temporary, to);
}

/** The lines of a log: a last line with no line end that is no whole JSON line (a write cut off) is not one. */
function logLines(text: string, jsonLines: boolean): string[] {
  const lines = text.split('\n');
  const last = lines.pop() ?? '';
  if (last) {
    let whole = !jsonLines;
    if (jsonLines) { try { JSON.parse(last); whole = true; } catch { /* cut off: not a line */ } }
    if (whole) lines.push(last);
  }
  return lines.filter(Boolean);
}

/**
 * The lines of `theirs` that `have` does not hold, counted: a line a log holds twice is carried twice unless the target
 * holds it twice already, so a line repeated on purpose is never merged away and a carry run again adds nothing.
 */
function linesMissing(have: readonly string[], theirs: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of have) left.set(line, (left.get(line) ?? 0) + 1);
  const missing: string[] = [];
  for (const line of theirs) {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else missing.push(line);
  }
  return missing;
}

/** A record with a writer lock of its own (the worktrees register): merged only while holding it. */
function withRecordWriterLock<T>(to: string, write: () => T): T {
  return to.endsWith(`${sep}worktrees.json`) ? withProcessLockSync(`${to}.writer.sqlite`, write, { waitMs: 2_000 }) : write();
}

/** Every row of `other` added to `target` where a table of that name exists in both; a row already there is kept. */
export function mergeSqliteRows(target: string, other: string): void {
  const db = new Database(target);
  try {
    db.run('PRAGMA busy_timeout = 5000');
    db.query('ATTACH DATABASE ? AS other').run(other);
    const tables = db.query<{ name: string }, []>("SELECT name FROM other.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const mine = new Set(db.query<{ name: string }, []>("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    db.transaction(() => {
      for (const { name } of tables) {
        if (!mine.has(name)) continue;
        const quoted = `"${name.replace(/"/g, '""')}"`;
        const columns = db.query<{ name: string }, []>(`PRAGMA main.table_info(${quoted})`).all().map((row) => `"${row.name.replace(/"/g, '""')}"`);
        const theirs = new Set(db.query<{ name: string }, []>(`PRAGMA other.table_info(${quoted})`).all().map((row) => `"${row.name.replace(/"/g, '""')}"`));
        const shared = columns.filter((column) => theirs.has(column));
        if (shared.length === 0) continue;
        db.run(`INSERT OR IGNORE INTO main.${quoted} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM other.${quoted}`);
      }
    })();
    db.run('DETACH DATABASE other');
  } finally {
    db.close();
  }
}

/**
 * Carry each entry (a path under `.goodvibes/`, a file or a directory with everything in it) from `source` (a folder's
 * `.goodvibes/`) into `target`, by the rule in the file's comment. `from` names the source folder in the result.
 * `firstFrom` (shared across several sources) says which source a copied record came from, for the single values.
 */
export function carryRecordsBetween(source: string, target: string, entries: readonly string[], from: string,
  result: RecordsCarryResult, firstFrom: Map<string, string> = new Map()): void {
  for (const entry of entries) {
    for (const file of recordFilesUnder(join(source, entry))) {
      const rel = relative(source, file);
      const name = file.split('/').pop() ?? file;
      if (isRecordSideFile(name)) continue;
      const to = join(target, rel);
      try {
        const approvals = name === 'approvals.jsonl';
        if (!existsSync(to)) {
          copyWithSideFiles(file, to, approvals ? (text) => text.split('\n').map((line) => (line ? carriedApprovalLine(line) : line)).join('\n') : undefined);
          firstFrom.set(rel, from);
          result.copied.push(`${rel} (from ${from})`);
        } else if (isSqlite(name)) {
          mergeSqliteRows(to, file);
          if (!result.merged.includes(rel)) result.merged.push(rel);
        } else if (name.endsWith('.jsonl') || name.endsWith('.md') || name.endsWith('.log')) {
          // Appended, never rewritten: a writer may hold the file open for appending.
          const jsonLines = name.endsWith('.jsonl');
          const ends = readFileSync(to, 'utf-8');
          const added = linesMissing(logLines(ends, jsonLines), logLines(readFileSync(file, 'utf-8'), jsonLines).map((line) => (approvals ? carriedApprovalLine(line) : line)));
          if (added.length > 0) appendFileSync(to, `${ends === '' || ends.endsWith('\n') ? '' : '\n'}${added.join('\n')}\n`, { mode: 0o600 });
          if (!result.merged.includes(rel)) result.merged.push(rel);
        } else if (name.endsWith('.json')) {
          withRecordWriterLock(to, () => {
            const kept = JSON.parse(readFileSync(to, 'utf-8')) as CarriedJson;
            const other = JSON.parse(readFileSync(file, 'utf-8')) as CarriedJson;
            writeWhole(to, `${JSON.stringify(mergeCarriedJson(kept, other), null, 2)}\n`);
          });
          if (!result.merged.includes(rel)) result.merged.push(rel);
        } else if (!readFileSync(to).equals(readFileSync(file))) {
          result.singleValues.push(`${rel}: kept the one from ${firstFrom.get(rel) ?? 'where it was'}; the one in ${from} was not used (it is still there)`);
        }
      } catch (error) {
        result.failed.push(`${rel} from ${from}: ${summarizeError(error)}`);
      }
    }
  }
}
