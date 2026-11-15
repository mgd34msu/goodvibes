import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquireCrossProcessLock as lockFile } from '../workspace/checkpoint/cross-process-lock.js';
import { confirmFileDurable as confirmDurable, writeJsonFileAtomic as writeJson } from '../utils/atomic-json-store.js';
/**
 * Node-only persistence primitives for product-owned request journals, and
 * `BoundedJsonFile`, the one small durable JSON file built on them. Journals requiring durable publication must pass `durable: true`
 * and `strictOwnership: true` explicitly. A published-indeterminate error
 * never proves rollback; inspect/confirm the visible file before proceeding.
 */
export { writeFileAtomic, writeJsonFileAtomic, confirmFileDurable, AtomicWriteDurabilityError } from '../utils/atomic-json-store.js';
export type { AtomicWriteOptions, AtomicJsonWriteOptions, AtomicWriteDurabilityPhase } from '../utils/atomic-json-store.js';
export { captureExistingDirectory } from '../utils/atomic-json-store.js';
export { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
export type { CrossProcessLockOptions } from '../workspace/checkpoint/cross-process-lock.js';


/** The file operations a bounded JSON file performs; tests may replace them. */
export interface BoundedJsonFileIO {
  readonly writeJsonFileAtomic: typeof writeJson;
  readonly confirmFileDurable: typeof confirmDurable;
  readonly acquireCrossProcessLock: typeof lockFile;
}

export interface BoundedJsonFileOptions<T> {
  /** Largest file accepted on read and written. */
  readonly maxBytes: number;
  /** Turns parsed JSON into the owner's value, or throws `invalid()`. */
  readonly parse: (value: unknown) => T;
  /** The value of a file that does not exist yet. */
  readonly empty: () => T;
  /** The owner's error for a file that is not a regular file, not JSON, or fails `parse`. */
  readonly invalid: () => Error;
  /** The owner's error for a file over `maxBytes`. */
  readonly limit: () => Error;
  /** Further rules the file itself must meet (owner, mode, link count), checked on the path and the opened file. */
  readonly accept?: (stat: Stats) => boolean;
  readonly io?: Partial<BoundedJsonFileIO>;
}

/** What `BoundedJsonFile.transact` hands its body; every call runs under the held lock. */
export interface BoundedJsonFileTransaction<T> {
  read(): T;
  /** Durable publication; refuses a value over the size bound with the owner's limit error. */
  write(value: T): void;
  /** Confirm the visible bytes are durable. */
  confirm(): void;
}

const isMissing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

/**
 * A small JSON file that survives a restart: never read or written through a
 * symlink (the file or an existing ancestor), bounded in size, changed only
 * under the cross-process lock and published durably. The one implementation
 * of that rule; owners supply the shape and their own error codes.
 */
export class BoundedJsonFile<T> {
  readonly path: string;
  private readonly io: BoundedJsonFileIO;
  private ancestorsChecked = false;
  constructor(path: string, private readonly options: BoundedJsonFileOptions<T>) {
    this.path = resolve(path);
    this.io = { writeJsonFileAtomic: writeJson, confirmFileDurable: confirmDurable, acquireCrossProcessLock: lockFile, ...options.io };
  }

  /** Read under the lock. */
  read(): Promise<T> { return this.locked(() => this.readNow()); }

  /** Read without the lock: a snapshot for a caller that changes nothing, with the same file rules. */
  peek(): T {
    this.assertAncestors();
    return this.readNow();
  }

  /**
   * Read, decide and write under one lock: `decide` returns the value to store
   * (or `undefined` to leave the file alone) and the result to hand back.
   */
  update<R>(decide: (current: T) => { readonly next?: T; readonly value: R }): Promise<R> {
    return this.locked(() => {
      const { next, value } = decide(this.readNow());
      if (next !== undefined) this.writeNow(next);
      return value;
    });
  }

  /** Confirm the visible bytes are durable; for a file this process did not just write. */
  confirm(check: (current: T) => void): Promise<void> {
    return this.locked(() => { check(this.readNow()); this.io.confirmFileDurable(this.path); });
  }

  /**
   * Several steps under one lock, for an owner whose operation is more than one
   * read-decide-write (a confirm of an unchanged record, or a side file written
   * after the record is durable).
   */
  transact<R>(body: (file: BoundedJsonFileTransaction<T>) => R): Promise<R> {
    return this.locked(() => body({
      read: () => this.readNow(),
      write: value => this.writeNow(value),
      confirm: () => this.io.confirmFileDurable(this.path),
    }));
  }

  private async locked<R>(operation: () => R): Promise<R> {
    if (!this.ancestorsChecked) {
      this.assertAncestors();
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.ancestorsChecked = true;
    }
    const release = await this.io.acquireCrossProcessLock(`${this.path}.lock`, { strictOwnership: true });
    try { return operation(); } finally { release(); }
  }

  private assertAncestors(): void {
    for (let current = dirname(this.path); ; current = dirname(current)) {
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw this.options.invalid();
      } catch (error) { if (!isMissing(error)) throw error; }
      if (dirname(current) === current) return;
    }
  }

  private readNow(): T {
    let stat: Stats;
    try { stat = lstatSync(this.path); } catch (error) { if (isMissing(error)) return this.options.empty(); throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || (this.options.accept && !this.options.accept(stat))) throw this.options.invalid();
    if (stat.size > this.options.maxBytes) throw this.options.limit();
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev
        || (this.options.accept && !this.options.accept(opened))) throw this.options.invalid();
      if (opened.size > this.options.maxBytes) throw this.options.limit();
      // Sized to the file, one byte over to notice growth during the read.
      const bytes = new Uint8Array(Math.min(opened.size, this.options.maxBytes) + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length > this.options.maxBytes) throw this.options.limit();
      if (length !== opened.size) throw this.options.invalid();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { throw this.options.invalid(); }
      return this.options.parse(value);
    } finally { closeSync(fd); }
  }

  private writeNow(value: T): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.options.maxBytes) throw this.options.limit();
    this.io.writeJsonFileAtomic(this.path, value, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
  }
}
