import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { readFileObservation } from '../utils/file-observation.js';

const imageObservationBrand: unique symbol = Symbol('sqlite-persisted-image');
/** One actual read's identity; never a schema certificate or permission grant. */
export interface SQLiteImageObservation { readonly [imageObservationBrand]: true }
export interface SQLitePersistedImage {
  readonly data: Buffer | null;
  readonly evidence: SQLiteImageObservation;
  readonly identity: string;
}
// Native readers are registered only by the actual constructor. Replacing a
// public read/stat method cannot mint another store's physical image evidence.
const nativeImageReaders = new WeakMap<SQLiteStorePersistence, () => SQLitePersistedImage>();
const getNativeImageReader = nativeImageReaders.get.bind(nativeImageReaders);
const registerNativeImageReader = nativeImageReaders.set.bind(nativeImageReaders);
const nativeFreeze = Object.freeze;
export function readSQLitePersistedImage(owner: SQLiteStorePersistence): SQLitePersistedImage {
  const read = getNativeImageReader(owner);
  if (!read) throw new Error('SQLiteStore: persisted image owner is unavailable');
  return read();
}
function directoryIdentity(path: string): readonly string[] {
  const entries: string[] = [];
  for (let current = dirname(path);;) {
    const entry = lstatSync(current, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('SQLiteStore: coordinated directory changed');
    entries.push(`${current}:${entry.dev}:${entry.ino}:${entry.birthtimeNs}`);
    const parent = dirname(current); if (parent === current) return entries; current = parent;
  }
}

function canonicalDatabasePath(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // realpath alone cannot distinguish an absent file from a dangling symlink.
  // Follow the latter before choosing the stable first-write lock and rename
  // destination; replacing the symlink would fork two independent stores.
  let linkTarget: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      linkTarget = readlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Do not swallow a failure resolving the target and fall back to replacing
  // the original link. A missing target directory is a failed initialization.
  if (linkTarget !== undefined) return canonicalDatabasePath(resolve(dirname(path), linkTarget));
  return join(realpathSync(dirname(path)), basename(path));
}

/** Internal fault-testing seam; production always uses the native filesystem. */
export type SQLitePublicationIO = Pick<typeof import('node:fs'), 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;
const nativePublicationIO: SQLitePublicationIO = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync };
interface PreviousImage { readonly bytes: Buffer; readonly digest: string }

/** Internal whole-image coordination; never merges or replays stale SQL. */
export class SQLiteStorePersistence {
  readonly path: string;
  readonly #path: string;
  readonly #io: SQLitePublicationIO;
  #baseline: string | null = null;
  #established = false;
  readonly #absentObservation = `absent:${randomUUID()}`;

  constructor(path: string, io: SQLitePublicationIO = nativePublicationIO) {
    const absolute = resolve(path);
    ensureDurableDirectory(dirname(absolute));
    this.path = canonicalDatabasePath(absolute);
    this.#path = this.path;
    this.#io = { openSync: io.openSync.bind(io), writeFileSync: io.writeFileSync.bind(io), fsyncSync: io.fsyncSync.bind(io),
      closeSync: io.closeSync.bind(io), renameSync: io.renameSync.bind(io), unlinkSync: io.unlinkSync.bind(io) };
    registerNativeImageReader(this, () => this.#readImage());
    // A symlink alias can enter another directory tree. Its containing entries
    // need their own proof; fsyncing the alias's ancestors does not cover them.
    if (dirname(this.path) !== dirname(absolute)) syncDirectoryAncestry(dirname(this.path));
  }

  read(): Buffer | null {
    return this.#readImage().data;
  }

  /**
   * Whole-image publication identity, including identical-byte replacements.
   * A fresh store intentionally has no file until its first save. The supported
   * coordinated protocol never deletes a published canonical database: once
   * observed, absence is an error, not a resurrection of the initial lifetime.
   */
  observationIdentity(): string {
    return this.#currentIdentity();
  }

  #currentIdentity(): string {
    const directories = directoryIdentity(this.#path);
    try {
      const info = lstatSync(this.#path, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw new Error('SQLiteStore: unsupported coordinated file identity');
      this.#established = true;
      return JSON.stringify([directories, [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink,
        info.size, info.ctimeNs, info.mtimeNs, info.birthtimeNs].map(String)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.#established) return JSON.stringify([directories, this.#absentObservation]);
      throw error;
    }
  }

  #readImage(): SQLitePersistedImage {
    const identity = this.#currentIdentity();
    let data: Buffer | null;
    try { data = readFileObservation(this.#path).bytes; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.#established) throw error;
      data = null;
    }
    if (this.#currentIdentity() !== identity) throw new Error('SQLiteStore: persisted image changed while reading');
    // Evidence belongs to this exact read. A stat match cannot prove that a
    // different read has the same contents on every supported filesystem.
    const evidence = nativeFreeze<SQLiteImageObservation>({ [imageObservationBrand]: true });
    return nativeFreeze({ data, evidence, identity });
  }

  acceptBaseline(data: Uint8Array | null): void { this.#acceptBaseline(data); }

  #acceptBaseline(data: Uint8Array | null, previous?: PreviousImage): void {
    const current = this.#readImage();
    if (current.data === null || data === null ? current.data !== data : !current.data.equals(data)) {
      throw new Error('SQLiteStore: baseline differs from the current persisted image');
    }
    const digest = current.data === null ? null
      : previous && current.data.equals(previous.bytes) ? previous.digest : imageDigest(current.data);
    if (this.#currentIdentity() !== current.identity) throw new Error('SQLiteStore: baseline changed during capture');
    this.#baseline = digest;
  }

  async lock(): Promise<() => void> {
    return acquireCrossProcessLock(`${this.#path}.knowledge-lock`, { strictOwnership: true });
  }

  /** Caller owns the lock. A stale ordinary save leaves both images intact. */
  writeIfCurrent(data: Uint8Array): void {
    const current = this.#readImage();
    const digest = current.data === null ? null : imageDigest(current.data);
    if (digest !== this.#baseline) {
      throw new Error('SQLiteStore: persisted state changed; pending local changes were not saved');
    }
    if (this.#currentIdentity() !== current.identity) throw new Error('SQLiteStore: persisted state changed before save');
    this.#write(data, current.data && digest !== null ? { bytes: current.data, digest } : undefined);
  }

  /** Establish durability even for a no-op receipt retry after an uncertain rename. */
  confirmDurable(): void {
    if (this.#readImage().data === null) return;
    const fd = this.#io.openSync(this.#path, 'r');
    try { this.#io.fsyncSync(fd); } finally { this.#safeClose(fd); }
    this.#syncAncestry();
  }

  /** Caller owns the lock and has constructed this image from the current file. */
  write(data: Uint8Array): void { this.#write(data); }

  #write(data: Uint8Array, previous?: PreviousImage): void {
    const temporary = `${this.#path}.pending-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    let renamed = false;
    try {
      let mode = 0o600;
      try { mode = statSync(this.#path).mode & 0o777; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      fd = this.#io.openSync(temporary, 'wx', mode);
      this.#io.writeFileSync(fd, data);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = undefined;
      this.#io.renameSync(temporary, this.#path);
      renamed = true;
      this.#established = true;
      // Rename visibility is not durable success. Never restore older bytes if
      // this sync fails: the exact receipt retry must reconcile the new image.
      this.#syncAncestry();
      this.#acceptBaseline(data, previous);
    } catch (cause) {
      throw new SQLitePublicationError(renamed ? 'indeterminate' : 'before-publication', cause);
    } finally {
      if (fd !== undefined) this.#safeClose(fd);
      try { this.#io.unlinkSync(temporary); } catch { /* Postpublication cleanup is not rollback. */ }
    }
  }

  #safeClose(fd: number): void { try { this.#io.closeSync(fd); } catch { /* Post-sync cleanup. */ } }
  #syncAncestry(): void {
    syncDirectoryAncestry(dirname(this.#path), this.#io);
  }

}

/** One compact original-byte commitment per save baseline, without keeping
 * another database image alive. Revalidate immediately before ordinary saves;
 * ephemeral read frames use exact private bytes and owner evidence instead. */
function imageDigest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class SQLitePublicationError extends Error {
  constructor(readonly phase: 'before-publication' | 'indeterminate', cause: unknown) {
    super(`SQLiteStore: ${phase} persistence failure`, { cause });
    this.name = 'SQLitePublicationError';
  }
}

/**
 * Existing directories may be remnants of an interrupted mkdir/fsync attempt.
 * Existence never proves their parent entries durable. Reestablish every edge,
 * leaf first, through the filesystem root on acquisition, commit and replay.
 */
function syncDirectoryAncestry(path: string, io: SQLitePublicationIO = nativePublicationIO): void {
  let current = path;
  for (;;) {
    const fd = io.openSync(current, 'r');
    try { io.fsyncSync(fd); }
    finally { try { io.closeSync(fd); } catch { /* A post-sync close cannot undo durability. */ } }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensureDurableDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  // Always traverse existing ancestry too. An earlier attempt may have created
  // these directories and failed before synchronizing an ancestor's new entry.
  syncDirectoryAncestry(path);
}
