import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { readFileObservation } from '../utils/file-observation.js';
import { AtomicWriteDurabilityError, confirmFileDurable, writeFileAtomic } from '../utils/atomic-json-store.js';

const imageObservationBrand: unique symbol = Symbol('sqlite-persisted-image');
/** One actual read's identity; never a schema certificate or permission grant. */
export interface SQLiteImageObservation { readonly [imageObservationBrand]: true }
const baselineObservationBrand: unique symbol = Symbol('sqlite-accepted-baseline');
/** Original accepted bytes and physical owner only; never a schema certificate. */
export interface SQLiteBaselineObservation { readonly [baselineObservationBrand]: true }
export interface SQLitePersistedImage {
  readonly data: Buffer | null;
  readonly evidence: SQLiteImageObservation;
  readonly identity: string;
  /** Issued by the native reader only when this exact read still equals the
   * already accepted private baseline and its original physical file. */
  readonly baseline?: SQLiteBaselineObservation;
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
    entries.push(`${current}:${entry.dev}:${entry.ino}:${entry.mode}:${entry.uid}:${entry.gid}:${entry.birthtimeNs}`);
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

/** Internal whole-image coordination; never merges or replays stale SQL. */
export class SQLiteStorePersistence {
  readonly path: string;
  readonly #path: string;
  readonly #io: SQLitePublicationIO;
  readonly #nativePublication: boolean;
  readonly #directories: readonly string[];
  #baseline: Buffer | null = null;
  #baselineIdentity: string | undefined;
  #baselineObservation: SQLiteBaselineObservation | undefined;
  #established = false;
  readonly #absentObservation = `absent:${randomUUID()}`;

  constructor(path: string, io: SQLitePublicationIO = nativePublicationIO) {
    const absolute = resolve(path);
    ensureDurableDirectory(dirname(absolute));
    this.path = canonicalDatabasePath(absolute);
    this.#path = this.path;
    this.#directories = directoryIdentity(this.#path);
    this.#nativePublication = io === nativePublicationIO;
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

  #assertDirectories(): void {
    const current = directoryIdentity(this.#path);
    if (current.length !== this.#directories.length || current.some((entry, index) => entry !== this.#directories[index])) {
      throw new Error('SQLiteStore: original coordinated directory changed');
    }
  }

  #currentIdentity(): string {
    this.#assertDirectories();
    const directories = this.#directories;
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
    const baseline = data !== null && this.#baseline !== null && identity === this.#baselineIdentity
      && data.equals(this.#baseline) ? this.#baselineObservation : undefined;
    return nativeFreeze({ data, evidence, identity, ...(baseline ? { baseline } : {}) });
  }

  acceptBaseline(data: Uint8Array | null): void { this.#acceptBaseline(data); }

  #acceptBaseline(data: Uint8Array | null): void {
    const current = this.#readImage();
    if (current.data === null || data === null ? current.data !== data : !current.data.equals(data)) {
      throw new Error('SQLiteStore: baseline differs from the current persisted image');
    }
    if (this.#currentIdentity() !== current.identity) throw new Error('SQLiteStore: baseline changed during capture');
    // #readImage owns this detached native buffer. Caller-provided bytes are
    // compared above and never retained as the baseline. Keep exact original
    // content privately; equality needs no cryptographic commitment.
    this.#baseline = current.data;
    this.#baselineIdentity = current.identity;
    // Each accepted publication gets new metadata, including an identical-byte
    // rewrite. Reading a foreign/current image never adopts a write baseline.
    this.#baselineObservation = current.data === null ? undefined
      : nativeFreeze<SQLiteBaselineObservation>({ [baselineObservationBrand]: true });
  }

  async lock(): Promise<() => void> {
    return acquireCrossProcessLock(`${this.#path}.knowledge-lock`, { strictOwnership: true });
  }

  /** Caller owns the lock. A stale ordinary save leaves both images intact. */
  writeIfCurrent(data: Uint8Array): void {
    const current = this.#readImage();
    if (current.data === null || this.#baseline === null ? current.data !== this.#baseline : !current.data.equals(this.#baseline)) {
      throw new Error('SQLiteStore: persisted state changed; pending local changes were not saved');
    }
    if (this.#currentIdentity() !== current.identity) throw new Error('SQLiteStore: persisted state changed before save');
    this.#write(data);
  }

  /** Establish durability even for a no-op receipt retry after an uncertain rename. */
  confirmDurable(): void {
    if (this.#readImage().data === null) return;
    if (this.#nativePublication) { confirmFileDurable(this.#path); this.#assertDirectories(); return; }
    const identity = this.#currentIdentity(), before = lstatSync(this.#path, { bigint: true });
    const assertCurrent = () => { if (this.#currentIdentity() !== identity) throw new Error('SQLiteStore: durable image changed'); };
    const fd = this.#io.openSync(this.#path, 'r');
    try {
      assertCurrent();
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.ctimeNs !== before.ctimeNs || opened.mtimeNs !== before.mtimeNs || opened.size !== before.size) throw new Error('SQLiteStore: durable descriptor changed');
      this.#io.fsyncSync(fd); assertCurrent();
    } finally { this.#safeClose(fd); }
    this.#syncAncestry(assertCurrent);
  }

  /** Caller owns the lock and has constructed this image from the current file. */
  write(data: Uint8Array): void { this.#write(data); }

  #write(data: Uint8Array): void {
    let before: string;
    try { before = this.#currentIdentity(); }
    catch (cause) { throw new SQLitePublicationError('before-publication', cause); }
    let published = false;
    if (this.#nativePublication) {
      try {
        let mode = 0o600;
        const original = lstatSync(this.#path, { throwIfNoEntry: false });
        if (original) mode = original.mode & 0o777;
        // Production uses the platform's original-FD, exclusive-temp binary
        // publisher. Directory durability and uncertain-rename accounting are
        // shared with the other native stores, rather than reimplemented here.
        writeFileAtomic(this.#path, data, { mode, durable: true, mkdirp: false, cleanupStaleTemps: false,
          assertCurrent: () => {
            this.#assertDirectories();
            if (!published && this.#currentIdentity() !== before) throw new Error('SQLiteStore: persisted state changed before publication');
          },
          onEffect: complete => { if (complete) { published = true; this.#established = true; } },
        });
        this.#acceptBaseline(data);
      } catch (cause) {
        if (cause instanceof AtomicWriteDurabilityError && cause.phase === 'published-indeterminate') published = true;
        throw new SQLitePublicationError(published ? 'indeterminate' : 'before-publication', cause);
      }
      return;
    }
    // An explicitly supplied host/fault adapter keeps its captured effects.
    // Native descriptors still prove the original temp and physical parent;
    // an exclusive-open failure never owns a colliding pathname.
    const input = Buffer.from(data), temporary = `${this.#path}.pending-${process.pid}-${randomUUID()}`;
    let writer: number | undefined, custody: number | undefined, original: BigIntStats | undefined, prepared: BigIntStats | undefined;
    let attempted = false, publishedImage: BigIntStats | undefined;
    const owner = (value: BigIntStats | undefined): boolean => value !== undefined && original !== undefined
      && value.isFile() && !value.isSymbolicLink() && value.nlink === 1n
      && value.dev === original.dev && value.ino === original.ino && value.birthtimeNs === original.birthtimeNs
      && value.uid === original.uid && value.gid === original.gid;
    const stamp = (value: BigIntStats, renamed = false) => [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink,
      value.size, value.mtimeNs, ...(renamed ? [] : [value.ctimeNs]), value.birthtimeNs].join(':');
    const physical = () => this.#assertDirectories();
    const current = () => {
      physical();
      if (!published && this.#currentIdentity() !== before) throw new Error('SQLiteStore: persisted state changed before publication');
    };
    const stage = () => {
      current();
      const selected = lstatSync(temporary, { bigint: true }), descriptor = fstatSync(custody ?? writer!, { bigint: true });
      if (!owner(selected) || !owner(descriptor) || stamp(selected) !== stamp(descriptor)
        || prepared && stamp(descriptor) !== stamp(prepared)) throw new Error('SQLiteStore: original temporary image changed');
    };
    const observePublished = () => {
      physical();
      const selected = lstatSync(this.#path, { bigint: true }), descriptor = fstatSync(custody!, { bigint: true });
      if (!owner(selected) || !owner(descriptor) || stamp(selected) !== stamp(descriptor)
        || !prepared || stamp(descriptor, true) !== stamp(prepared, true)) throw new Error('SQLiteStore: published image ownership changed');
      return descriptor;
    };
    const assertPublished = () => {
      const actual = observePublished();
      if (publishedImage && stamp(actual) !== stamp(publishedImage)) throw new Error('SQLiteStore: published image changed during durability confirmation');
    };
    // Closing an injected writer may throw after close. Inspect the retained
    // native inode before any cleanup; never close a reused foreign descriptor.
    const closeWriter = () => {
      if (writer === undefined) return;
      const fd = writer; writer = undefined;
      try { this.#io.closeSync(fd); }
      catch (error) {
        try { if (owner(fstatSync(fd, { bigint: true }))) closeSync(fd); } catch { /* Original descriptor is already closed or retired. */ }
        throw error;
      }
    };
    try {
      current();
      const mode = lstatSync(this.#path, { throwIfNoEntry: false })?.mode;
      writer = this.#io.openSync(temporary, 'wx', 0o600);
      original = fstatSync(writer, { bigint: true }); stage();
      fchmodSync(writer, mode === undefined ? 0o600 : mode & 0o777); stage();
      this.#io.writeFileSync(writer, input);
      prepared = fstatSync(writer, { bigint: true }); stage();
      this.#io.fsyncSync(writer); stage();
      custody = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); stage();
      closeWriter(); stage();
      attempted = true; this.#io.renameSync(temporary, this.#path); published = true; this.#established = true;
      publishedImage = observePublished();
      this.#syncAncestry(assertPublished); assertPublished();
      this.#acceptBaseline(input); assertPublished();
    } catch (cause) {
      if (attempted && !published) {
        try { stage(); } catch { published = true; }
      }
      throw new SQLitePublicationError(published ? 'indeterminate' : 'before-publication', cause);
    } finally {
      if (!published && original) {
        try {
          physical();
          const selected = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
          if (owner(selected)) { this.#io.unlinkSync(temporary); physical(); }
        } catch { /* Preserve foreign/replaced temporary files and parents. */ }
      }
      try { closeWriter(); } catch { /* Preserve the original publication outcome. */ }
      if (custody !== undefined) { try { if (owner(fstatSync(custody, { bigint: true }))) closeSync(custody); } catch { /* Original custody already retired. */ } }
    }
  }

  #safeClose(fd: number): void { try { this.#io.closeSync(fd); } catch { /* Post-sync cleanup. */ } }
  #syncAncestry(assertCurrent: () => void = () => this.#assertDirectories()): void {
    syncDirectoryAncestry(dirname(this.#path), this.#io, assertCurrent);
  }

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
function syncDirectoryAncestry(path: string, io: SQLitePublicationIO = nativePublicationIO, assertCurrent: () => void = () => {}): void {
  let current = path;
  for (;;) {
    assertCurrent();
    const named = lstatSync(current, { bigint: true }), canonical = realpathSync(current), original = lstatSync(canonical, { bigint: true });
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('SQLiteStore: durable directory changed');
    const assertDirectory = () => {
      assertCurrent();
      const actual = lstatSync(current, { bigint: true }), target = lstatSync(canonical, { bigint: true });
      if (realpathSync(current) !== canonical || actual.dev !== named.dev || actual.ino !== named.ino || actual.birthtimeNs !== named.birthtimeNs
        || actual.isSymbolicLink() !== named.isSymbolicLink() || target.dev !== original.dev || target.ino !== original.ino || target.birthtimeNs !== original.birthtimeNs) throw new Error('SQLiteStore: durable directory lookup changed');
    };
    assertDirectory();
    const fd = io.openSync(canonical, 'r');
    try {
      assertDirectory();
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || opened.dev !== original.dev || opened.ino !== original.ino || opened.birthtimeNs !== original.birthtimeNs) throw new Error('SQLiteStore: durable directory descriptor changed');
      io.fsyncSync(fd); assertDirectory();
    } finally { try { io.closeSync(fd); } catch { /* A post-sync close cannot undo durability. */ } }
    assertDirectory();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensureDurableDirectory(path: string): void {
  // Resolve an explicitly existing configured alias once. Missing levels are
  // created individually below its original physical target, never by a
  // recursive mkdir that can adopt an intermediate replacement.
  const missing: string[] = [];
  let anchor = resolve(path);
  while (!lstatSync(anchor, { throwIfNoEntry: false })) {
    missing.unshift(basename(anchor));
    const parent = dirname(anchor); if (parent === anchor) throw new Error('SQLiteStore: database directory root is unavailable');
    anchor = parent;
  }
  const root = realpathSync(anchor), expected = new Map<string, string>();
  const directory = (selected: string): string => {
    const value = lstatSync(selected, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('SQLiteStore: database directory is not physical');
    return [value.dev, value.ino, value.mode, value.uid, value.gid, value.birthtimeNs].join(':');
  };
  for (let selected = root;; selected = dirname(selected)) { expected.set(selected, directory(selected)); if (dirname(selected) === selected) break; }
  const current = () => {
    if (realpathSync(anchor) !== root || [...expected].some(([selected, original]) => directory(selected) !== original)) throw new Error('SQLiteStore: database directory changed during creation');
  };
  let selected = root;
  for (const name of missing) {
    current(); selected = join(selected, name); mkdirSync(selected, { mode: 0o700 });
    const original = lstatSync(selected, { bigint: true }); expected.set(selected, directory(selected)); current();
    // Set the original created directory's owner access explicitly; a mode000
    // directory from umask must not prevent creating its remaining descendants.
    chmodSync(selected, 0o700);
    const after = lstatSync(selected, { bigint: true });
    if (after.dev !== original.dev || after.ino !== original.ino || after.birthtimeNs !== original.birthtimeNs) throw new Error('SQLiteStore: created database directory changed');
    expected.set(selected, directory(selected)); current();
  }
  current();
  // Existing directories may be remnants of an interrupted mkdir/fsync. Sync
  // canonical and configured-lookup ancestry even when no creation was needed.
  syncDirectoryAncestry(selected, nativePublicationIO, current);
  if (resolve(path) !== selected) syncDirectoryAncestry(resolve(path), nativePublicationIO, current);
}
