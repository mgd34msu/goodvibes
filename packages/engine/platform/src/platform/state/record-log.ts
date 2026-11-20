/**
 * Record log: a store that only grows, one record per line, written by one
 * process.
 *
 * Use it for things that are appended and read back in order (session
 * messages, inbound mail, companion chat, contract progress, trigger
 * observations, permission decisions). Saving a record is one `write(2)` of
 * that record, whatever the log already holds; nothing is rewritten.
 *
 * - Durability: `fsync: 'each'` syncs the data before `append` returns (use it
 *   for a record that acknowledges something a person or another program was
 *   told is saved). `fsync: 'batch'` syncs once, off the event loop, for every
 *   record appended since the last sync; `flush()` waits for it.
 * - Memory: the log keeps the byte offset of each record and, with `key`, the
 *   position of the latest record per key. Records are read from the file when
 *   asked for, so a long history costs offsets, not objects. Opening reads only
 *   the end of the file; the offsets are built on the first read, so a process
 *   that only appends never reads the history.
 * - A torn last line (a crash in the middle of a write) is ignored by readers
 *   and cut off before this process's first append, so it can never merge with
 *   a new record. A damaged line elsewhere is skipped and logged on read.
 * - One writer: a second process may open the same log to read it and call
 *   `refresh()` to pick up records appended since (one `stat`). Logs written
 *   by several processes belong in a SQLite file instead.
 *
 * Cost per request: append = one write (plus one fdatasync for 'each'); get =
 * one positioned read; scan = sequential reads of the requested range;
 * revision() = an integer read.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fdatasync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import type { RevisionSource } from '../utils/revision.js';
import { createAtomicTempPath } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';

export interface RecordLogOptions<T> {
  readonly fsync: 'each' | 'batch';
  /** Names a record; `get(key)` returns the latest record appended under it. */
  readonly key?: ((record: T) => string) | undefined;
  /** One line for a record. Default `JSON.stringify`. The line must not contain a newline. */
  readonly encode?: ((record: T) => string) | undefined;
  /** A record from its line. Default `JSON.parse`. Throw to mark the line damaged. */
  readonly decode?: ((line: string) => T) | undefined;
  /** File mode for a new log. Default 0o600. */
  readonly mode?: number | undefined;
}

export interface RecordLog<T> extends RevisionSource {
  readonly path: string;
  /** Records in the log. */
  readonly size: number;
  /** Append one record. Throws when the record was not written. */
  append(record: T): void;
  /** The latest record appended under `key`. Needs the `key` option. */
  get(key: string): T | undefined;
  has(key: string): boolean;
  /** Records in order, from position `from` (default 0) to the end as of the call. */
  scan(from?: number): Iterable<T>;
  /** Rewrite the log with only the records `keep` accepts (one temp file, one rename). */
  compact(keep: (record: T) => boolean): Promise<void>;
  /** Index records another process appended since open or the last refresh. Returns how many were found. */
  refresh(): number;
  /** Resolves once every record appended so far is synced. */
  flush(): Promise<void>;
  close(): void;
}

/**
 * A log whose rewrite was published (renamed into place) but whose descriptor
 * could not be moved onto it. Appending through the old descriptor would write
 * into the replaced file, which no reader opens again, so the log refuses every
 * append and flush until the process opens it afresh.
 */
export class RecordLogBrokenError extends Error {
  readonly code = 'RECORD_LOG_BROKEN';
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`The log ${path} was rewritten but could not be reopened (${cause instanceof Error ? cause.message : String(cause)}); nothing more is written to it. Restart the daemon to open it again.`, { cause });
    this.name = 'RecordLogBrokenError';
    this.path = path;
  }
}

const READ_WINDOW = 1 << 20;
const NEWLINE = 0x0a;

class FileRecordLog<T> implements RecordLog<T> {
  readonly id: string;
  readonly path: string;
  readonly #options: RecordLogOptions<T>;
  readonly #encode: (record: T) => string;
  readonly #decode: (line: string) => T;
  #fd: number;
  #ino: number;
  /** Start offset of each complete record; a record ends one byte before the next start (its newline). */
  #starts: number[] = [];
  /** End of the last complete record (after its newline). */
  #end = 0;
  /** Bytes after #end at open that never got their newline. */
  #tornTail = 0;
  #keys = new Map<string, number>();
  /** False until the first read: until then only the end of the file is known. */
  #indexed = false;
  /** End of the history that existed at open, indexed on the first read. */
  #baseEnd = 0;
  /** Records appended before the first read, placed after the history when it is indexed. */
  #pendingStarts: number[] = [];
  #pendingKeys = new Map<string, number>();
  #revision = 0;
  #closed = false;
  /** Set when a rewrite was published but the log could not be reopened on it: appends and flushes refuse. */
  #broken: RecordLogBrokenError | null = null;
  #unsynced = false;
  #syncing: Promise<void> | null = null;
  #syncScheduled = false;

  constructor(path: string, options: RecordLogOptions<T>) {
    this.path = path;
    this.id = `record log ${basename(path)}`;
    this.#options = options;
    this.#encode = options.encode ?? ((record) => JSON.stringify(record));
    this.#decode = options.decode ?? ((line) => JSON.parse(line) as T);
    mkdirSync(dirname(path), { recursive: true });
    const mode = options.mode ?? 0o600;
    this.#fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, mode);
    try {
      const stat = fstatSync(this.#fd);
      this.#ino = stat.ino;
      this.#findEnd(stat.size);
    } catch (error) {
      closeSync(this.#fd);
      throw error;
    }
  }

  get size(): number {
    this.#ensureIndexed();
    return this.#starts.length;
  }

  revision(): number {
    return this.#revision;
  }

  append(record: T): void {
    this.#assertOpen();
    if (this.#broken) throw this.#broken;
    const line = this.#encode(record);
    if (line.includes('\n')) throw new Error(`${this.id}: an encoded record must be one line`);
    if (this.#tornTail > 0) this.#cutTornTail();
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    const start = this.#end;
    let written = 0;
    try {
      written = writeSync(this.#fd, bytes, 0, bytes.length);
      if (written !== bytes.length) throw new Error(`${this.id}: wrote ${written} of ${bytes.length} bytes`);
    } catch (error) {
      // Leave no partial line behind for the next append to merge with.
      if (written > 0) {
        try { ftruncateSync(this.#fd, start); } catch { this.#tornTail = written; }
      }
      throw error;
    }
    this.#end = start + bytes.length;
    const starts = this.#indexed ? this.#starts : this.#pendingStarts;
    const position = starts.push(start) - 1;
    if (this.#options.key) (this.#indexed ? this.#keys : this.#pendingKeys).set(this.#options.key(record), position);
    this.#revision += 1;
    if (this.#options.fsync === 'each') fdatasyncSync(this.#fd);
    else this.#scheduleSync();
  }

  get(key: string): T | undefined {
    if (!this.#options.key) throw new Error(`${this.id} was opened without a key`);
    this.#ensureIndexed();
    const position = this.#keys.get(key);
    return position === undefined ? undefined : this.#readAt(position);
  }

  has(key: string): boolean {
    this.#ensureIndexed();
    return this.#keys.has(key);
  }

  *scan(from = 0): Iterable<T> {
    this.#assertOpen();
    this.#ensureIndexed();
    const last = this.#starts.length;
    let window = Buffer.alloc(0);
    let windowStart = 0;
    for (let position = Math.max(0, from); position < last; position++) {
      const start = this.#starts[position]!;
      const end = this.#recordEnd(position);
      if (start < windowStart || end > windowStart + window.length) {
        const length = Math.max(READ_WINDOW, end - start);
        window = Buffer.allocUnsafe(Math.min(length, this.#end - start));
        const read = readSync(this.#fd, window, 0, window.length, start);
        window = window.subarray(0, read);
        windowStart = start;
      }
      const record = this.#decodeLine(window.toString('utf8', start - windowStart, end - windowStart), position);
      if (record !== undefined) yield record.value;
    }
  }

  async compact(keep: (record: T) => boolean): Promise<void> {
    this.#assertOpen();
    if (this.#broken) throw this.#broken;
    const temp = createAtomicTempPath(this.path);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, this.#options.mode ?? 0o600);
    const starts: number[] = [];
    const keys = new Map<string, number>();
    let end = 0;
    try {
      fchmodSync(fd, this.#options.mode ?? 0o600);
      for (const record of this.scan()) {
        if (!keep(record)) continue;
        const bytes = Buffer.from(`${this.#encode(record)}\n`, 'utf8');
        if (writeSync(fd, bytes, 0, bytes.length) !== bytes.length) throw new Error(`${this.id}: compaction write was short`);
        const position = starts.push(end) - 1;
        if (this.#options.key) keys.set(this.#options.key(record), position);
        end += bytes.length;
      }
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      try { unlinkSync(temp); } catch { /* nothing was published */ }
      throw error;
    }
    closeSync(fd);
    try { renameSync(temp, this.path); } catch (error) {
      try { unlinkSync(temp); } catch { /* nothing was published */ }
      throw error;
    }
    // From here the path names the new file. Until the descriptor is reopened on
    // it, an append would land in the replaced file, which nothing reads again:
    // a failure now leaves the log refusing appends instead of losing them.
    const previous = this.#fd;
    let next = -1;
    try {
      // The rename drops records; make it survive a power loss before saying so.
      const dirFd = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      next = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      this.#ino = fstatSync(next).ino;
    } catch (error) {
      if (next !== -1) { try { closeSync(next); } catch { /* already failing */ } }
      this.#broken = new RecordLogBrokenError(this.path, error);
      logger.error('[record-log] a rewritten log could not be reopened; it refuses appends until the daemon restarts', { path: this.path, error: error instanceof Error ? error.message : String(error) });
      throw this.#broken;
    }
    this.#fd = next;
    closeSync(previous);
    this.#starts = starts;
    this.#keys = keys;
    this.#end = end;
    this.#tornTail = 0;
    this.#indexed = true;
    this.#unsynced = false;
    this.#revision += 1;
  }

  refresh(): number {
    this.#assertOpen();
    this.#ensureIndexed();
    let stat;
    try { stat = statSync(this.path); } catch { return 0; }
    if (stat.ino !== this.#ino || stat.size < this.#end) {
      // Another process compacted or replaced the log: read it from the start.
      const next = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      closeSync(this.#fd);
      this.#fd = next;
      this.#ino = stat.ino;
      this.#starts = [];
      this.#keys.clear();
      this.#indexFrom(0, fstatSync(next).size);
      this.#revision += 1;
      return this.#starts.length;
    }
    if (stat.size === this.#end + this.#tornTail) return 0;
    const before = this.#starts.length;
    this.#indexFrom(this.#end, stat.size);
    const found = this.#starts.length - before;
    if (found > 0) this.#revision += 1;
    return found;
  }

  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#broken) return Promise.reject(this.#broken);
    if (this.#syncing) return this.#syncing.then(() => this.flush());
    if (!this.#unsynced) return Promise.resolve();
    return this.#syncNow();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#unsynced) fdatasyncSync(this.#fd);
    } finally {
      closeSync(this.#fd);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`${this.id} is closed`);
  }

  #recordEnd(position: number): number {
    const next = this.#starts[position + 1];
    return (next ?? this.#end) - 1;
  }

  #readAt(position: number): T | undefined {
    this.#assertOpen();
    const start = this.#starts[position]!;
    const length = this.#recordEnd(position) - start;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(this.#fd, buffer, 0, length, start);
    return this.#decodeLine(buffer.toString('utf8', 0, read), position)?.value;
  }

  #decodeLine(line: string, position: number): { value: T } | undefined {
    try {
      return { value: this.#decode(line) };
    } catch (error) {
      logger.warn('[record-log] skipped a damaged record', { path: this.path, position, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  /** Index complete lines in [from, size). Keys need each record decoded once. */
  #indexFrom(from: number, size: number): void {
    const key = this.#options.key;
    let offset = from;
    let lineStart = from;
    const buffer = Buffer.allocUnsafe(Math.min(READ_WINDOW, Math.max(1, size - from)));
    // The start of a line that runs past the window, kept as bytes so a character split by the window survives.
    let carry: Buffer | null = null;
    while (offset < size) {
      const read = readSync(this.#fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (read <= 0) break;
      let scanFrom = 0;
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, scanFrom);
        if (newline === -1 || newline >= read) break;
        const position = this.#starts.push(lineStart) - 1;
        if (key) {
          const bytes = buffer.subarray(scanFrom, newline);
          const text = (carry ? Buffer.concat([carry, bytes]) : bytes).toString('utf8');
          const decoded = this.#decodeLine(text, position);
          if (decoded) this.#keys.set(key(decoded.value), position);
        }
        carry = null;
        lineStart = offset + newline + 1;
        scanFrom = newline + 1;
      }
      if (key && scanFrom < read) {
        const rest = Buffer.from(buffer.subarray(scanFrom, read));
        carry = carry ? Buffer.concat([carry, rest]) : rest;
      }
      offset += read;
    }
    this.#end = lineStart;
    this.#tornTail = size - lineStart;
  }

  /** Find the end of the last complete record by reading backwards from the end of the file. */
  #findEnd(size: number): void {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
    let cursor = size;
    let end = 0;
    while (cursor > 0) {
      const from = Math.max(0, cursor - chunk.length);
      const read = readSync(this.#fd, chunk, 0, cursor - from, from);
      const at = chunk.subarray(0, read).lastIndexOf(NEWLINE);
      if (at !== -1) { end = from + at + 1; break; }
      cursor = from;
    }
    this.#end = end;
    this.#baseEnd = end;
    this.#tornTail = size - end;
  }

  #ensureIndexed(): void {
    if (this.#indexed) return;
    const end = this.#end, tornTail = this.#tornTail;
    this.#starts = [];
    this.#keys = new Map();
    this.#indexFrom(0, this.#baseEnd);
    const base = this.#starts.length;
    for (const start of this.#pendingStarts) this.#starts.push(start);
    for (const [key, position] of this.#pendingKeys) this.#keys.set(key, base + position);
    this.#pendingStarts = [];
    this.#pendingKeys.clear();
    this.#end = end;
    this.#tornTail = tornTail;
    this.#indexed = true;
  }

  #cutTornTail(): void {
    logger.warn('[record-log] removed an unfinished last record left by an interrupted write', { path: this.path, bytes: this.#tornTail });
    ftruncateSync(this.#fd, this.#end);
    this.#tornTail = 0;
  }

  #scheduleSync(): void {
    this.#unsynced = true;
    if (this.#syncScheduled) return;
    this.#syncScheduled = true;
    setImmediate(() => {
      this.#syncScheduled = false;
      if (!this.#closed && this.#unsynced && !this.#syncing) void this.#syncNow().catch(() => { /* reported by flush */ });
    });
  }

  #syncNow(): Promise<void> {
    this.#unsynced = false;
    const fd = this.#fd;
    let failed = false;
    const run = new Promise<void>((resolve, reject) => {
      fdatasync(fd, (error) => {
        if (!error) { resolve(); return; }
        // A descriptor closed or replaced by compaction was already synced by that step.
        if (this.#closed || fd !== this.#fd) { resolve(); return; }
        this.#unsynced = true;
        failed = true;
        logger.error('[record-log] could not sync appended records', { path: this.path, code: error.code });
        reject(error);
      });
    }).finally(() => {
      if (this.#syncing === run) this.#syncing = null;
      // Records appended while this sync ran are covered by the next one. After
      // a failure the next append or flush tries again; nothing spins here.
      if (!failed && this.#unsynced && !this.#closed) this.#scheduleSync();
    });
    this.#syncing = run;
    return run;
  }
}

/** Open (creating when absent) the record log at `path`. */
export function openRecordLog<T>(path: string, options: RecordLogOptions<T>): RecordLog<T> {
  return new FileRecordLog<T>(path, options);
}
