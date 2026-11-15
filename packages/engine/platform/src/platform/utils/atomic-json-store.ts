/**
 * atomic-json-store, the two file mechanics every on-disk JSON store in this
 * platform shares, in one place.
 *
 * This module lives under `utils/` deliberately: `utils/` is the documented
 * leaf of the platform dependency graph (no intra-platform imports beyond
 * `./logger.js`, which is itself a leaf), so `config/`, `core/`, `daemon/`,
 * `mcp/`, `pairing/`, `plugins/`, `profiles/`, `providers/`, `runtime/`, and
 * `watchers/` can all import it without creating a layering edge between two
 * domains that must stay independent.
 *
 * A small document a store holds in memory and writes on a real change uses
 * {@link writeDocument} (one temp file, one write, one sync, one rename) and
 * {@link readDocument} when it opens. Rows go in a SQLite file
 * (`state/sqlite-file.ts`) and records that only grow in a record log
 * (`state/record-log.ts`). The guarded writer below remains for stores that
 * still need its path and effect observation.
 *
 * The two mechanics:
 *
 *   1. {@link writeFileAtomic} / {@link writeJsonFileAtomic}: write a uniquely
 *      named sibling temp file (same directory, so the rename stays on one
 *      filesystem), set its exact mode (independent of the umask), sync its
 *      data, then `rename(2)` it over the target. A concurrent reader, and a
 *      process that dies mid-write, sees the previous complete file or the new
 *      complete one, never a torn write. The data sync before the rename is
 *      what keeps a power loss from leaving an empty file under the old name.
 *      `durable: true` also syncs the parent directory (and any directory the
 *      write created) after the rename, so the new name itself survives a
 *      power loss before success is returned.
 *
 *      The parent directory is created once per process and then trusted.
 *      A caller that passes `assertCurrent` or `onEffect` gets exactly one
 *      check of its guard and of the parent directory's identity, immediately
 *      before the rename; nothing else re-proves the path. Another process of
 *      the same user could write the store file directly, so per-syscall
 *      ancestry checks would buy nothing.
 *
 *      The temp name is unique per WRITE ({@link createAtomicTempPath}:
 *      `<name>.tmp-<pid>-<seq>-<random>`), so two live writers of one store
 *      never share or delete each other's temp file. A temp file left by a
 *      writer that died is reaped the first time this process writes that
 *      store (one directory listing per store per process), and only when its
 *      writer pid is gone and the file is older than
 *      {@link STALE_TEMP_FILE_MIN_AGE_MS}.
 *
 *      There is deliberately NO in-process write lock. Every step above is a
 *      synchronous `node:fs` call with no await between them, so two writes of
 *      one store cannot interleave on one thread; ordering between processes
 *      is settled by `rename(2)`: whichever writer renames last wins, whole.
 *
 *      A write that fails still throws, because most stores must not report a
 *      save that did not happen. Callers whose failure policy is genuinely
 *      log-and-continue, periodic snapshots that rebuild themselves, use
 *      {@link writeJsonFileAtomicSafe}, which logs the path and errno loudly
 *      and returns an {@link AtomicWriteOutcome} instead of throwing.
 *
 *   2. {@link readJsonFileOrQuarantine}: one open and one read. Only a file
 *      this reader cannot trust
 *      (unparseable JSON, a torn or zero-tailed write, the wrong shape) is
 *      exclusively linked to `<name>.corrupt-<ISO>-<8char>` with a sibling `.why`
 *      receipt, logged loudly at error level, and reported to the caller as
 *      the ordinary "absent" answer (`null`) so the caller rebuilds instead of
 *      crashing. The original file is never deleted and never overwritten,
 *      unlinked from its old name only after its original inode is archived.
 *      The private `.why` receipt binds native file observations, not a digest
 *      or authentication claim. Unknown historical recovery paths remain intact.
 *      Physically owned archive/receipt pairs are bounded at {@link CORRUPT_QUARANTINE_MAX_FILES} per store,
 *      oldest reaped first, and the reap is disclosed in the newest receipt.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readFile,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import type { BigIntStats, Stats } from 'node:fs';
import { logger } from './logger.js';

/**
 * Hard ceiling on `.corrupt-*` files kept per store directory, oldest reaped
 * first. A flapping writer that corrupts its file on every boot must not be
 * allowed to fill the disk with forensic copies, "a handful" is enough to
 * look at what went wrong without becoming a leak.
 */
export const CORRUPT_QUARANTINE_MAX_FILES = 5;

/** Minimum age before a proven-dead native writer's temporary file can be
 * reclaimed. Age alone never proves that a paused or slow writer has exited;
 * live, inaccessible and unrecognized writer identities remain untouched. */
export const STALE_TEMP_FILE_MIN_AGE_MS = 60_000;

/** Default mode for a store file: owner read/write only. */
const DEFAULT_STORE_FILE_MODE = 0o600;

/**
 * Per-process counter that makes each temp name unique within this process
 * even when two writes land in the same millisecond.
 */
let atomicTempSequence = 0;

/**
 * Build the temp path for one atomic write of `filePath`.
 *
 * Unique per call, never per process: `<name>.tmp-<pid>-<seq>-<random>`. The
 * pid and sequence are there so a leftover file names the process and the
 * write that produced it when someone goes looking; the random suffix is what
 * guarantees two writers never collide even across pid reuse.
 *
 * Exported so a test can hold a second writer's temp file the way a real
 * concurrent writer does, and assert the sweep leaves it alone.
 */
export function createAtomicTempPath(filePath: string): string {
  atomicTempSequence += 1;
  return `${filePath}.tmp-${process.pid}-${atomicTempSequence.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export interface AtomicWriteOptions {
  /** False publishes the complete staged image only if the target is absent. */
  readonly replaceExisting?: boolean;
  /** Defaults to true here. A false requires an already-existing parent. */
  readonly mkdirp?: boolean;
  /** Native owner advances only its own filesystem effects: false for created
   * parents/staging, true after the original stage becomes the destination. */
  readonly onEffect?: ((published?: boolean) => void) | undefined;
  /** Additional operation restriction, completed synchronously before each physical write. */
  readonly assertCurrent?: (() => void) | undefined;
  /**
   * Exact mode of the resulting file. Applied with an explicit `chmod` before
   * publication, so the result does not vary with the process umask.
   * Defaults to `0o600`.
   */
  readonly mode?: number;
  /** Opt in to file + complete pathname-ancestry durability before success. */
  readonly durable?: boolean;
  /** Omit opportunistic deletion of other writes' stale temp files for a bounded effect. */
  readonly cleanupStaleTemps?: boolean;
}

export interface AtomicJsonWriteOptions extends AtomicWriteOptions {
  /** `JSON.stringify` indent. `null` writes compact JSON. Defaults to `2`. */
  readonly indent?: number | null;
  /** Append a trailing newline to the serialized JSON. Defaults to `true`. */
  readonly trailingNewline?: boolean;
}

export type AtomicWriteDurabilityPhase = 'before-publication' | 'published-indeterminate';

/** A failed post-rename confirmation is uncertainty, never proof of rollback. */
export class AtomicWriteDurabilityError extends Error {
  readonly code = 'ATOMIC_WRITE_DURABILITY_FAILED';
  constructor(readonly filePath: string, readonly phase: AtomicWriteDurabilityPhase, cause: unknown) {
    super(`Atomic file durability failed (${phase}): ${filePath}`, { cause });
    this.name = 'AtomicWriteDurabilityError';
  }
}

interface DurablePathEntry { readonly path: string; readonly identity: Stats; }
interface DurablePathLink extends DurablePathEntry { readonly target: string; }
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: Stats, b: Stats): boolean {
  return sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * Trace actual lookup, including symlink chains and their parent directories.
 * realpath + lexical ancestors alone misses an intermediate symlink's parent.
 * Keep `..` until after symlinks resolve, exactly as filesystem lookup does.
 */
function traceDurablePath(filePath: string): {
  readonly canonical: string; readonly file: Stats;
  readonly directories: readonly DurablePathEntry[]; readonly links: readonly DurablePathLink[];
} {
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  let cursor = parse(absolute).root;
  let pending = absolute.slice(cursor.length).split(sep);
  const directories = new Map<string, DurablePathEntry>();
  const links: DurablePathLink[] = [];
  const rememberDirectory = (path: string) => {
    const identity = lstatSync(path);
    if (!identity.isDirectory()) throw new Error('Durable path ancestor is not a directory');
    directories.set(path, { path, identity });
  };
  rememberDirectory(cursor);
  while (pending.length > 0) {
    const component = pending.shift()!;
    if (!component || component === '.') continue;
    if (component === '..') { cursor = dirname(cursor); rememberDirectory(cursor); continue; }
    const path = join(cursor, component);
    const identity = lstatSync(path);
    if (identity.isSymbolicLink()) {
      if (links.length >= 40) throw new Error('Durable path has too many symbolic links');
      const target = readlinkSync(path);
      links.push({ path, identity, target });
      if (isAbsolute(target)) { cursor = parse(target).root; rememberDirectory(cursor); }
      pending = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep), ...pending];
      continue;
    }
    cursor = path;
    if (identity.isDirectory()) rememberDirectory(cursor);
  }
  // Preserve the exact symlink-aware walk. realpathSync can normalize '..'
  // before resolving aliases; the kernel's native stat must select this same
  // original physical file before any durability effects begin.
  const canonical = cursor, file = lstatSync(canonical);
  if (!file.isFile()) throw new Error('Durable publication is not a regular file');
  if (!sameFile(statSync(filePath), file)) throw new Error('Durable path changed during resolution');
  return { canonical, file, directories: [...directories.values()], links };
}

/**
 * Establish durability of already-visible bytes, including newly created
 * ancestors and every symlink/alias ancestry. Call under the store's owner
 * lock; this helper supplies durability, not cross-writer serialization.
 * A read/restart can use this to recover an indeterminate publication. Failures
 * never remove, restore, quarantine or rewrite the published file.
 */
export function confirmFileDurable(filePath: string): void {
  try {
    const path = traceDurablePath(filePath);
    const fd = openSync(path.canonical, 'r');
    try {
      if (!sameFile(fstatSync(fd), path.file)) throw new Error('Durable file changed before confirmation');
      fsyncSync(fd);
      // Reverse lookup order preserves descendant-before-ancestor ordering,
      // including branches traversed by a chain of symlinks.
      for (const directory of [...path.directories].reverse()) {
        const dirFd = openSync(directory.path, 'r');
        try {
          if (!sameInode(fstatSync(dirFd), directory.identity)) throw new Error('Durable ancestor changed');
          fsyncSync(dirFd);
        } finally { closeSync(dirFd); }
      }
      const selectedFile = lstatSync(path.canonical);
      if (!selectedFile.isFile() || !sameFile(selectedFile, path.file) || !sameFile(fstatSync(fd), path.file)
        || !sameFile(statSync(filePath), path.file)) throw new Error('Durable file changed during confirmation');
      for (const directory of path.directories) {
        if (!sameInode(lstatSync(directory.path), directory.identity)) throw new Error('Durable ancestor changed');
      }
      for (const link of path.links) {
        if (!sameInode(lstatSync(link.path), link.identity) || readlinkSync(link.path) !== link.target) {
          throw new Error('Durable alias changed during confirmation');
        }
      }
    } finally { closeSync(fd); }
  } catch (error) {
    throw new AtomicWriteDurabilityError(filePath, 'published-indeterminate', error);
  }
}

interface AtomicDirectoryOwner { readonly canonical: string; readonly durabilityDirectories: readonly string[]; readonly ancestryDirectories: readonly string[]; assertCurrent(): void; assertPhysicalCurrent(): void }
const atomicDirectoryStamp = (stat: BigIntStats): string => {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('Atomic file parent is not a physical directory'), { code: 'ENOTDIR' });
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
};
const atomicFileStamp = (stat: BigIntStats): string => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
  stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
function atomicMissing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

/** Plan the actual parent lookup, including configured existing aliases and
 * symlink-aware '..', before creating anything. Never create a dangling alias's
 * target. Original directories and links stay pinned through publication. */
function prepareAtomicDirectory(absolute: string, assertOwner: () => void, effect: (() => void) | undefined, mkdirp: boolean, concurrentInitialCreation = false, privatePermissionTightening = false): AtomicDirectoryOwner {
  const directories = new Map<string, string>(), links: Array<{ path: string; identity: string; target: string }> = [];
  const absent = new Set<string>(), createdDirectories = new Set<string>();
  let cursor = parse(absolute).root, pending = absolute.slice(cursor.length).split(sep);
  directories.set(cursor, atomicDirectoryStamp(lstatSync(cursor, { bigint: true })));
  const retainCurrent = (path: string, stat: BigIntStats, message = 'Atomic file parent changed'): void => {
    const identity = atomicDirectoryStamp(stat), previous = directories.get(path);
    if (previous !== undefined && previous !== identity) {
      const originalMode = BigInt(previous.split(':')[2]!);
      // A private shared writer can remove group/other access on the SAME
      // original directory. Owner access, special bits, inode, owner and birth
      // remain exact. Advance the observed mode so restoring removed bits is
      // refused too; no alias or foreign directory can inherit this policy.
      if (!privatePermissionTightening || (stat.mode & ~0o077n) !== (originalMode & ~0o077n)
        || ((stat.mode & 0o077n) | (originalMode & 0o077n)) !== (originalMode & 0o077n)
        || [stat.dev, stat.ino, originalMode, stat.uid, stat.gid, stat.birthtimeNs].join(':') !== previous) throw new Error(message);
    }
    directories.set(path, identity);
  };
  const observe = (path: string) => retainCurrent(path, lstatSync(path, { bigint: true }), 'Atomic file parent changed during capture');
  while (pending.length) {
    const component = pending.shift(); if (!component || component === '.') continue;
    if (component === '..') { cursor = dirname(cursor); if (!absent.has(cursor)) observe(cursor); continue; }
    const path = join(cursor, component);
    let stat: BigIntStats;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if (!atomicMissing(error)) throw error; absent.add(path); cursor = path; continue; }
    if (stat.isSymbolicLink()) {
      if (links.length >= 40) throw new Error('Atomic file parent has too many aliases');
      const target = readlinkSync(path), identity = atomicFileStamp(stat);
      if (atomicFileStamp(lstatSync(path, { bigint: true })) !== identity || !statSync(path).isDirectory()) throw new Error('Atomic file parent alias is unavailable');
      links.push({ path, identity, target });
      if (isAbsolute(target)) { cursor = parse(target).root; observe(cursor); }
      pending = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep), ...pending];
      continue;
    }
    observe(path); cursor = path;
  }
  const canonical = cursor;
  const current = (checkAbsent = true) => {
    for (const path of directories.keys()) retainCurrent(path, lstatSync(path, { bigint: true }));
    for (const link of links) if (atomicFileStamp(lstatSync(link.path, { bigint: true })) !== link.identity || readlinkSync(link.path) !== link.target) throw new Error('Atomic file parent alias changed');
    for (const path of checkAbsent ? absent : []) {
      try { lstatSync(path); } catch (error) { if (atomicMissing(error)) continue; throw error; }
      throw new Error('Atomic file parent appeared during capture');
    }
  };
  current(!concurrentInitialCreation);
  if (!mkdirp && absent.size) throw Object.assign(new Error('Atomic publication parent does not exist'), { code: 'ENOENT' });
  for (const path of [...absent]) {
    assertOwner(); current(!concurrentInitialCreation); let made = false;
    try { mkdirSync(path); made = true; }
    catch (error) { if (!concurrentInitialCreation || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const created = lstatSync(path, { bigint: true });
    if (!made && (process.geteuid && created.uid !== BigInt(process.geteuid()))) throw new Error('Atomic initial parent belongs to another owner');
    // A competing plain writer can establish an ordinary initial directory,
    // never a symlink or replacement of any already retained original parent.
    // Record its actual mode without chmodding somebody else's creation.
    if (made) createdDirectories.add(path);
    directories.set(path, atomicDirectoryStamp(created)); absent.delete(path); current(false);
    // Retain inherited group/special bits while ensuring the creator can finish
    // a nested write even under a restrictive umask.
    const mode = Number(created.mode & 0o7777n) | 0o700;
    if (made && Number(created.mode & 0o7777n) !== mode) {
      chmodSync(path, mode); const after = lstatSync(path, { bigint: true });
      if (after.dev !== created.dev || after.ino !== created.ino) throw new Error('Atomic file created parent changed');
      directories.set(path, atomicDirectoryStamp(after));
    }
    current(!concurrentInitialCreation); if (effect) { effect(); current(); }
  }
  const assertLookupCurrent = () => {
    current();
    // realpathSync (including .native under Bun) may normalize '..' before
    // resolving aliases. Compare the kernel's actual selected directory with
    // the original physical target instead, retaining every traversed alias.
    retainCurrent(canonical, statSync(absolute, { bigint: true }), 'Atomic file parent lookup changed');
    current();
  };
  assertLookupCurrent();
  const physical: string[] = [];
  for (let path = canonical;; path = dirname(path)) {
    if (!directories.has(path)) throw new Error('Atomic physical parent proof is unavailable');
    physical.push(path); if (dirname(path) === path) break;
  }
  const durability = new Set([canonical]);
  for (const created of createdDirectories) { durability.add(created); durability.add(dirname(created)); }
  return { canonical, durabilityDirectories: Object.freeze([...durability].sort((left, right) => right.length - left.length)),
    ancestryDirectories: Object.freeze([...directories.keys()].sort((left, right) => right.length - left.length)),
    assertCurrent: assertLookupCurrent,
    assertPhysicalCurrent() { for (const path of physical) retainCurrent(path, lstatSync(path, { bigint: true }), 'Atomic physical parent changed'); },
  };
}

/** Read-only custody of an existing directory and its actual alias lookup.
 * No directories are created and no file bodies are read. Normal operations
 * check the selected alias; compensation may use the retained canonical tree
 * only while its original physical parents still exist unchanged.
 */
export function captureExistingDirectory(directory: string, options: { readonly allowPrivatePermissionTightening?: boolean } = {}): AtomicDirectoryOwner {
  const absolute = isAbsolute(directory) ? directory : `${process.cwd()}${sep}${directory}`;
  return Object.freeze(prepareAtomicDirectory(absolute, () => {}, undefined, false, false, options.allowPrivatePermissionTightening === true));
}

/** The shared native parent plan for actual asynchronous publishers. No second
 * alias walker or directory-creation protocol is maintained by each store. */
export function prepareAtomicPublicationDirectory(directory: string, options: Pick<AtomicWriteOptions, 'mkdirp' | 'assertCurrent' | 'onEffect'> = {}): ReturnType<typeof captureExistingDirectory> {
  const guard = options.assertCurrent?.bind(options), notify = options.onEffect?.bind(options);
  const check = (value: unknown) => { if (value !== undefined) { if (nodeTypes.isPromise(value)) Reflect.apply(Promise.prototype.then, value, [undefined, () => {}]); throw new Error('Atomic publication callbacks must complete synchronously.'); } };
  const absolute = isAbsolute(directory) ? directory : `${process.cwd()}${sep}${directory}`;
  return Object.freeze(prepareAtomicDirectory(absolute, () => check(guard?.()), notify ? () => check(notify(false)) : undefined, options.mkdirp !== false));
}

/** Parent directories this process already created or found, so a write does not ask again. */
const knownAtomicParents = new Set<string>();
/** Store files whose dead writers' temp files this process already reaped. */
const reapedAtomicTargets = new Set<string>();

function completeSynchronously(value: unknown, message: string): void {
  if (value === undefined) return;
  if (nodeTypes.isPromise(value)) Reflect.apply(Promise.prototype.then, value, [undefined, () => {}]);
  throw new Error(message);
}

function directoryIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw Object.assign(new Error(`Atomic file parent is not a directory: ${path}`), { code: 'ENOTDIR' });
  return `${stat.dev}:${stat.ino}`;
}

/** Make the parent once per process. Returns the directories this call created, outermost first. */
function ensureAtomicParent(dir: string, mkdirp: boolean, beforeCreate: (() => void) | undefined): string[] {
  if (knownAtomicParents.has(dir)) return [];
  let created: string[] = [];
  const existing = statSync(dir, { throwIfNoEntry: false });
  if (existing === undefined) {
    if (!mkdirp) throw Object.assign(new Error(`Atomic publication parent does not exist: ${dir}`), { code: 'ENOENT' });
    beforeCreate?.();
    const first = mkdirSync(dir, { recursive: true });
    if (first !== undefined) {
      for (let path = dir; ; path = dirname(path)) { created.unshift(path); if (path === first || dirname(path) === path) break; }
      // A restrictive umask must not leave the creator unable to finish its own nested write.
      for (const path of created) {
        const directoryMode = statSync(path).mode & 0o7777;
        if ((directoryMode & 0o700) !== 0o700) chmodSync(path, directoryMode | 0o700);
      }
    }
  } else if (!existing.isDirectory()) {
    throw Object.assign(new Error(`Atomic file parent is not a directory: ${dir}`), { code: 'ENOTDIR' });
  }
  knownAtomicParents.add(dir);
  return created;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Write `contents` to `filePath` atomically, creating parent directories as
 * needed. See the module docstring for the mechanics and why they matter.
 */
export function writeFileAtomic(filePath: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  const guard = options.assertCurrent?.bind(options), onEffect = options.onEffect?.bind(options);
  const mode = options.mode ?? DEFAULT_STORE_FILE_MODE, replaceExisting = options.replaceExisting !== false;
  const durable = options.durable === true, mkdirp = options.mkdirp !== false;
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const leaf = basename(absolute), dir = dirname(absolute);
  const check = () => completeSynchronously(guard?.(), 'Atomic file operation currentness is unavailable.');
  const notify = (published: boolean) => completeSynchronously(onEffect?.(published), 'Atomic file effect notification must complete synchronously');
  // tmpPath is set only once this write created the file, so a failure never removes another writer's file.
  let tmpPath: string | undefined, fd: number | undefined, published = false;
  try {
    if (!leaf || leaf === '.' || leaf === '..' || absolute.endsWith(sep) || absolute.includes('\0')) throw new Error('Atomic publication requires a file target');
    check();
    const created = ensureAtomicParent(dir, mkdirp, onEffect ? () => notify(false) : undefined);
    const parentIdentity = guard || onEffect ? directoryIdentity(dir) : undefined;
    if (options.cleanupStaleTemps !== false && !reapedAtomicTargets.has(absolute)) {
      reapedAtomicTargets.add(absolute);
      cleanupStaleTempFiles(dir, absolute, () => {}, undefined);
    }
    const staging = createAtomicTempPath(absolute);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    try { fd = openSync(staging, flags, DEFAULT_STORE_FILE_MODE); }
    catch (error) {
      // The parent was removed since this process first saw it: make it once more.
      if (!mkdirp || !atomicMissing(error)) throw error;
      knownAtomicParents.delete(dir);
      created.push(...ensureAtomicParent(dir, mkdirp, undefined));
      fd = openSync(staging, flags, DEFAULT_STORE_FILE_MODE);
    }
    tmpPath = staging;
    if (onEffect) notify(false);
    fchmodSync(fd, mode);
    const written = writeSync(fd, bytes, 0, bytes.byteLength, 0);
    if (written !== bytes.byteLength) throw new Error(`Incomplete atomic file write: ${written} of ${bytes.byteLength} bytes`);
    if (durable) fsyncSync(fd); else fdatasyncSync(fd);
    const done = fd; fd = undefined; closeSync(done);
    // The one currentness check: the caller's guard and the parent it resolved, just before publication.
    if (parentIdentity !== undefined) {
      check();
      if (directoryIdentity(dir) !== parentIdentity) throw new Error(`Atomic file parent changed before publication: ${dir}`);
    }
    if (replaceExisting) { renameSync(tmpPath, absolute); published = true; }
    else {
      // A same-directory hard link publishes the complete file only when the name is free (EEXIST otherwise).
      linkSync(tmpPath, absolute); published = true;
      unlinkSync(tmpPath);
    }
    tmpPath = undefined;
    // The rename happened: the observer hears of it even if the durability sync below fails.
    if (onEffect) notify(true);
    if (durable) {
      try {
        syncDirectory(dir);
        for (const path of created) syncDirectory(dirname(path));
      } catch (error) { throw new AtomicWriteDurabilityError(filePath, 'published-indeterminate', error); }
    }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* the original error is the diagnostic */ } }
    if (tmpPath !== undefined && !published) { try { unlinkSync(tmpPath); } catch { /* nothing was published */ } }
    if (durable && !(error instanceof AtomicWriteDurabilityError)) {
      throw new AtomicWriteDurabilityError(filePath, published ? 'published-indeterminate' : 'before-publication', error);
    }
    throw error;
  }
}

/** Serialize `value` as JSON and write it atomically via {@link writeFileAtomic}. */
export function writeJsonFileAtomic(filePath: string, value: unknown, options: AtomicJsonWriteOptions = {}): void {
  const durable = options.durable === true;
  try {
    const indent = options.indent === undefined ? 2 : options.indent;
    const trailingNewline = options.trailingNewline ?? true;
    const serialized = indent === null ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    if (serialized === undefined) throw new Error('Atomic JSON input did not serialize to a value');
    writeFileAtomic(filePath, trailingNewline ? `${serialized}\n` : serialized, options);
  } catch (error) {
    if (durable && !(error instanceof AtomicWriteDurabilityError)) {
      throw new AtomicWriteDurabilityError(filePath, 'before-publication', error);
    }
    throw error;
  }
}

export interface AtomicJsonSafeWriteOptions extends AtomicJsonWriteOptions {
  /**
   * Short store name for the failure log, e.g. `'watchers/store'`. Rendered as
   * `[<label>]`. Defaults to `'atomic-json-store'`.
   */
  readonly label?: string;
}

/** What {@link writeJsonFileAtomicSafe} reports back instead of throwing. */
export interface AtomicWriteOutcome {
  /** True when the bytes are on disk under `filePath`. */
  readonly ok: boolean;
  /** The store file the write targeted. */
  readonly filePath: string;
  /** The failure, when `ok` is false. */
  readonly error?: Error;
  /** The errno string when the failure carried one, e.g. `'ENOENT'`, `'ENOSPC'`. */
  readonly code?: string;
  /** The failing syscall when the failure named one, e.g. `'chmod'`, `'rename'`. */
  readonly syscall?: string;
}

/** Pull the errno fields off a thrown filesystem error without asserting a shape it may not have. */
function describeWriteFailure(error: unknown): { code?: string; syscall?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const fields = error as { code?: unknown; syscall?: unknown };
  return {
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(typeof fields.syscall === 'string' ? { syscall: fields.syscall } : {}),
  };
}

/**
 * {@link writeJsonFileAtomic} for callers whose failure policy is
 * log-and-continue: the failure is logged at error level with the store path,
 * the errno and the failing syscall, and returned as an
 * {@link AtomicWriteOutcome} rather than thrown.
 *
 * This exists because a periodic snapshot must never be able to kill its host.
 * A watcher-store write that failed inside a fleet tick propagated out of a
 * timer callback with nothing above it to catch it, and the whole agent
 * process died, from a store whose entire recovery story is "it rebuilds from
 * live registrations on the next load". Stores where a silent failure would be
 * a lie (settings, secrets, pairing tokens, anything a user just asked to
 * save) keep using {@link writeJsonFileAtomic} and keep throwing.
 */
export function writeJsonFileAtomicSafe(
  filePath: string,
  value: unknown,
  options: AtomicJsonSafeWriteOptions = {},
): AtomicWriteOutcome {
  const { label = 'atomic-json-store', ...writeOptions } = options;
  try {
    writeJsonFileAtomic(filePath, value, writeOptions);
    return { ok: true, filePath };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const { code, syscall } = describeWriteFailure(error);
    logger.error(`[${label}] could not persist the store file; the in-memory state stands and the next write retries`, {
      filePath,
      ...(code !== undefined ? { code } : {}),
      ...(syscall !== undefined ? { syscall } : {}),
      error: failure.message,
    });
    return {
      ok: false,
      filePath,
      error: failure,
      ...(code !== undefined ? { code } : {}),
      ...(syscall !== undefined ? { syscall } : {}),
    };
  }
}

export interface DocumentWriteOptions {
  /** Exact mode of the file. Default `0o600`. */
  readonly mode?: number;
  /** `JSON.stringify` indent; `null` writes compact JSON. Default `2`. */
  readonly indent?: number | null;
}

/** Parent directories this process already created or found, so a write does not ask again. */
const documentParents = new Set<string>();

function openDocumentTemp(temp: string, parent: string, mode: number): number {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  if (!documentParents.has(parent)) {
    mkdirSync(parent, { recursive: true });
    documentParents.add(parent);
  }
  try {
    return openSync(temp, flags, mode);
  } catch (error) {
    if (!atomicMissing(error)) throw error;
    // The directory was removed since it was first seen; make it once more.
    mkdirSync(parent, { recursive: true });
    return openSync(temp, flags, mode);
  }
}

/**
 * The document writer: a small JSON document held in memory by its owner and
 * written whole on a real change. One temp file beside the target, one write,
 * one data sync, one rename; the parent directory is resolved once per process.
 *
 * A reader sees the old document or the new one, never part of either, and a
 * crash leaves one of the two. The rename itself is not synced to the
 * directory: after a power loss the previous document may be the one found,
 * which a document store accepts. Leftover temp files and unreadable documents
 * are dealt with once, when the owner opens the document ({@link readDocument}).
 * Throws when the document was not written.
 */
export function writeDocument(filePath: string, value: unknown, options: DocumentWriteOptions = {}): void {
  const indent = options.indent === undefined ? 2 : options.indent;
  const serialized = indent === null ? JSON.stringify(value) : JSON.stringify(value, null, indent);
  if (serialized === undefined) throw new Error('Document value did not serialize to JSON');
  const contents = Buffer.from(`${serialized}\n`, 'utf8');
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const mode = options.mode ?? DEFAULT_STORE_FILE_MODE;
  const temp = createAtomicTempPath(absolute);
  let fd: number | undefined = openDocumentTemp(temp, dirname(absolute), mode);
  let renamed = false;
  try {
    fchmodSync(fd, mode);
    const written = writeSync(fd, contents, 0, contents.length);
    if (written !== contents.length) throw new Error(`Document write was short: ${written} of ${contents.length} bytes`);
    fdatasyncSync(fd);
    const done = fd;
    fd = undefined;
    closeSync(done);
    renameSync(temp, absolute);
    renamed = true;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* the write error is the one reported */ } }
    if (!renamed) { try { unlinkSync(temp); } catch { /* nothing was published */ } }
  }
}

/**
 * Open a document: remove temp files a dead writer left beside it, then read
 * it, moving an unreadable one aside exactly as {@link readJsonFileOrQuarantine}
 * does. Returns null when there is no document yet. Call once when the owner
 * loads the document; writes then go through {@link writeDocument}.
 */
export function readDocument<T>(filePath: string, options: QuarantineLoadOptions<T>): T | null {
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const dir = dirname(absolute), prefix = `${basename(absolute)}.tmp-`;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* no directory yet: nothing to read or reap */ }
  const staleBefore = Date.now() - STALE_TEMP_FILE_MIN_AGE_MS;
  for (const name of names) {
    if (name.startsWith(prefix)) cleanupStaleTempFile(dir, absolute, name, staleBefore, () => {}, undefined);
  }
  return readJsonFileOrQuarantine(absolute, options);
}

export interface QuarantineLoadOptions<T> {
  /**
   * Short store name used in the log line and the `.why` receipt, e.g.
   * `'config/secrets'`. Rendered as `[<label>]` in logs.
   */
  readonly label: string;
  /**
   * Narrow the parsed JSON to the store's shape. Throw with a human-readable
   * reason when the content cannot be trusted, that reason is what lands in
   * the `.why` receipt and the error log.
   */
  readonly validate: (parsed: unknown) => T;
  /**
   * One sentence for the `.why` receipt describing what happens now that the
   * file is gone, i.e. how this store rebuilds. Written for a human reading
   * the receipt months later with no other context.
   */
  readonly recovery: string;
}

/** Original read source. Closing releases the descriptor and raw bytes; the
 * immutable path observation can still restrict a later synchronous write.
 * A closed/copy/parsed object cannot be used to move a file into quarantine.
 */
export class QuarantineEncodingError extends Error { override readonly name = 'QuarantineEncodingError'; constructor() { super('Original store source is not valid UTF-8.'); } }
export interface QuarantineSource {
  read(): string;
  assertCurrent(): void;
  close(): void;
}
interface NativeQuarantineSource {
  readonly selected: string; readonly path: string; readonly parent: AtomicDirectoryOwner;
  readonly fd: number; readonly original: BigIntStats;
  bytes: Buffer | undefined; closed: boolean; consumed: boolean; pendingReads: number; fdClosed: boolean; readFailed: boolean;
}
const sourceStates = new WeakMap<QuarantineSource, NativeQuarantineSource>();
const nativeQuarantineThen = Promise.prototype.then;
const nativeQuarantineApply = Reflect.apply, nativeSourceGet = WeakMap.prototype.get, nativeSourceSet = WeakMap.prototype.set;
const sameQuarantineFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.birthtimeNs === b.birthtimeNs;
const absoluteQuarantinePath = (path: string) => isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
function quarantineUnavailable(): never { throw new Error('Original store or recovery ownership is unavailable; existing files were preserved.'); }
function invokeQuarantineCallback(callback: (() => void) | undefined): void {
  const result: unknown = callback?.();
  if (result !== undefined) { if (nodeTypes.isPromise(result)) nativeQuarantineApply(nativeQuarantineThen, result, [undefined, () => {}]); quarantineUnavailable(); }
}
function originalQuarantineSource(source: QuarantineSource): NativeQuarantineSource {
  const original = nativeQuarantineApply(nativeSourceGet, sourceStates, [source]) as NativeQuarantineSource | undefined;
  if (!original || original.closed || original.consumed) quarantineUnavailable(); return original;
}
export function captureQuarantineSource(filePath: string): QuarantineSource | null {
  const selected = absoluteQuarantinePath(filePath);
  if (!lstatSync(selected, { throwIfNoEntry: false })) return null;
  const parent = captureExistingDirectory(dirname(selected)), path = join(parent.canonical, basename(selected));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let accepted = false;
  try {
    const original = fstatSync(fd, { bigint: true });
    if (!original.isFile() || original.nlink !== 1n || (process.geteuid && original.uid !== BigInt(process.geteuid()))) quarantineUnavailable();
    const state: NativeQuarantineSource = { selected, path, parent, fd, original, bytes: undefined, closed: false, consumed: false, pendingReads: 0, fdClosed: false, readFailed: false };
    const current = () => {
      parent.assertCurrent(); if (state.consumed || atomicFileStamp(lstatSync(path, { bigint: true })) !== atomicFileStamp(original)
        || ((!state.closed || state.pendingReads > 0) && atomicFileStamp(fstatSync(fd, { bigint: true })) !== atomicFileStamp(original))) quarantineUnavailable();
    };
    current();
    const source = Object.freeze({ read() { current(); if (state.closed || state.readFailed || state.pendingReads > 0) quarantineUnavailable(); if (!state.bytes) { try { state.bytes = readFileSync(fd); } catch (error) { state.readFailed = true; throw error; } current(); } try { return new TextDecoder('utf8', { fatal: true }).decode(state.bytes); } catch { throw new QuarantineEncodingError(); } }, assertCurrent: current,
      close() { if (state.closed) return; state.closed = true; state.bytes = undefined; if (state.pendingReads === 0) { state.fdClosed = true; closeSync(fd); } } });
    nativeQuarantineApply(nativeSourceSet, sourceStates, [source, state]); accepted = true; return source;
  } finally { if (!accepted) closeSync(fd); }
}
/** Verify the genuine original source/path before lending its private bytes. */
export function readCapturedQuarantineSource(filePath: string, source: QuarantineSource): string {
  const original = originalQuarantineSource(source); if (original.selected !== absoluteQuarantinePath(filePath)) quarantineUnavailable();
  source.assertCurrent(); return source.read();
}
/** Async read of the same retained original descriptor. Close requests cancel
 * publication but never release/reuse the descriptor before native read drains.
 */
export async function readCapturedQuarantineSourceAsync(filePath: string, source: QuarantineSource): Promise<string> {
  const original = originalQuarantineSource(source);
  if (original.selected !== absoluteQuarantinePath(filePath) || original.readFailed || original.pendingReads > 0) quarantineUnavailable();
  source.assertCurrent(); if (original.bytes) return source.read();
  original.pendingReads++;
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => { readFile(original.fd, (error, data) => { if (error) { original.readFailed = true; reject(error); } else resolve(data); }); });
    source.assertCurrent(); if (original.closed) quarantineUnavailable(); original.bytes = bytes;
    try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { throw new QuarantineEncodingError(); }
  } finally {
    original.pendingReads--; if (original.closed) { original.bytes = undefined; if (!original.fdClosed && original.pendingReads === 0) { original.fdClosed = true; closeSync(original.fd); } }
  }
}
type StoreParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function parseStoreBytes<T>(bytes: Uint8Array, validate: (parsed: unknown) => T): StoreParse<T> {
  let raw: string;
  try { raw = new TextDecoder('utf8', { fatal: true }).decode(bytes); }
  catch { return { ok: false, reason: 'store source is not valid UTF-8' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { return { ok: false, reason: 'store JSON could not be parsed' }; }
  let value: T;
  try { value = validate(parsed); }
  catch { return { ok: false, reason: 'store shape validation failed' }; }
  if (nodeTypes.isPromise(value)) { nativeQuarantineApply(nativeQuarantineThen, value, [undefined, () => {}]); throw new TypeError('Store validation must complete synchronously.'); }
  return { ok: true, value };
}

/**
 * Read a JSON store: one open (refusing a symlinked store file) and one read.
 * Returns null when there is no file. A file this reader cannot trust is read
 * again through a retained descriptor; if it is still unreadable, that exact
 * file is preserved as `<name>.corrupt-*` (see {@link quarantineCorruptFile})
 * and null is returned so the caller rebuilds. A file another writer fixed in
 * between is returned instead. Read failures other than absence propagate.
 */
export function readJsonFileOrQuarantine<T>(filePath: string, options: QuarantineLoadOptions<T>): T | null {
  const validate = options.validate.bind(options);
  let fd: number;
  try { fd = openSync(absoluteQuarantinePath(filePath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (atomicMissing(error)) return null; throw error; }
  let bytes: Buffer;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  const first = parseStoreBytes(bytes, validate);
  if (first.ok) return first.value;
  // Only an untrusted file pays for the retained source the quarantine needs.
  const source = captureQuarantineSource(filePath); if (!source) return null;
  try {
    const native = originalQuarantineSource(source);
    let again: Buffer;
    try { source.read(); again = native.bytes!; }
    catch (error) { if (!(error instanceof QuarantineEncodingError)) throw error; again = native.bytes!; }
    const second = parseStoreBytes(again, validate);
    if (second.ok) return second.value;
    source.assertCurrent();
    quarantineCorruptFile(filePath, { source, label: options.label, reason: second.reason, recovery: options.recovery });
    return null;
  } finally { source.close(); }
}
export interface QuarantineOptions {
  readonly label: string;
  /** Explicit host reason; native parse/validation callers use value-free text. */
  readonly reason: string;
  readonly recovery: string;
  /** Actual source retained before reading/parsing, never captured in a catch. */
  readonly source?: QuarantineSource | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly onEffect?: ((published?: boolean) => void) | undefined;
  readonly maxFiles?: number | undefined;
  readonly maximumAgeMs?: number | undefined;
  readonly now?: number | undefined;
}
export interface QuarantineOutcome { readonly quarantinePath: string; readonly reaped: number; readonly preservedUnknown: number }
interface QuarantineReceipt {
  readonly schema: 1; readonly role: 'goodvibes-owned-quarantine'; readonly source: string; readonly archive: string;
  readonly createdAt: number; readonly physical: string; readonly explanation: string;
}
const MAX_QUARANTINE_RECORDS = 2048;
function receiptDocument(value: unknown, base: string, name: string): QuarantineReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 7 && row['schema'] === 1 && row['role'] === 'goodvibes-owned-quarantine' && row['source'] === base && row['archive'] === name
    && typeof row['createdAt'] === 'number' && Number.isSafeInteger(row['createdAt']) && row['createdAt'] >= 0
    && typeof row['physical'] === 'string' && typeof row['explanation'] === 'string' ? row as unknown as QuarantineReceipt : null;
}
/** A receipt is local retention metadata, never authentication against another
 * same-user writer. Full original native facts fence both sides of deletion.
 */
export interface OwnedQuarantineReapOptions {
  readonly maxFiles?: number | undefined;
  readonly maximumAgeMs?: number | undefined;
  readonly now?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly onEffect?: ((published?: boolean) => void) | undefined;
  readonly currentName?: string | undefined;
}
export interface OwnedQuarantineReapSummary {
  readonly reaped: number;
  readonly expired: number;
  readonly overCap: number;
  readonly bytesReclaimed: number;
  readonly preservedUnknown: number;
}
export function reapOwnedQuarantines(filePath: string, options: OwnedQuarantineReapOptions = {}): { readonly reaped: number; readonly preservedUnknown: number } {
  const absolute = absoluteQuarantinePath(filePath), base = basename(absolute);
  const result = reapQuarantineScopes([dirname(absolute)], name => name.startsWith(`${base}.corrupt-`) ? base : undefined, options);
  return { reaped: result.reaped, preservedUnknown: result.preservedUnknown };
}
/** Global retention across a store's actual namespaces. Only native archive /
 * receipt pairs for selected source basenames can be removed. One directory
 * inventory and bounded receipt reads; corrupt payload bodies are never read. */
export function reapOwnedQuarantineDirectories(directories: readonly string[], acceptsSource: (name: string) => boolean, options: OwnedQuarantineReapOptions = {}): OwnedQuarantineReapSummary {
  return reapQuarantineScopes(directories, name => {
    const separator = name.indexOf('.corrupt-'), base = name.slice(0, separator);
    return separator > 0 && acceptsSource(base) === true ? base : undefined;
  }, options);
}
/** How long an empty receipt may exist before it is treated as the leftover of an interrupted quarantine. */
const EMPTY_RECEIPT_GRACE_MS = 60_000;
function reapQuarantineScopes(directories: readonly string[], sourceForArchive: (name: string) => string | undefined, options: OwnedQuarantineReapOptions): OwnedQuarantineReapSummary {
  const guard = options.assertCurrent?.bind(options), effect = options.onEffect?.bind(options), now = options.now ?? Date.now(), cap = options.maxFiles ?? CORRUPT_QUARANTINE_MAX_FILES, age = options.maximumAgeMs, currentName = options.currentName;
  if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isFinite(now) || (age !== undefined && (!Number.isFinite(age) || age < 0))) quarantineUnavailable();
  const rows: Array<{ name: string; path: string; why: string; dataPhysical: string; receiptPhysical: string; createdAt: number; bytes: number; current: () => void }> = [];
  let preservedUnknown = 0, reaped = 0, expired = 0, overCap = 0, bytesReclaimed = 0, candidates = 0;
  const currents: Array<() => void> = [], canonical = new Set<string>();
  for (const directory of new Set(directories.map(absoluteQuarantinePath))) {
    if (!lstatSync(directory, { throwIfNoEntry: false })) continue;
    const parent = captureExistingDirectory(directory), current = () => { invokeQuarantineCallback(guard); parent.assertCurrent(); };
    currents.push(current); current();
    if (canonical.has(parent.canonical)) continue;
    canonical.add(parent.canonical);
    const bases = new Map<string, string>();
    const names = readdirSync(parent.canonical).filter(name => {
      const base = sourceForArchive(name);
      if (base === undefined) return false;
      bases.set(name, base); return true;
    }), nameSet = new Set(names);
    candidates += names.length;
    if (candidates > MAX_QUARANTINE_RECORDS * 2) quarantineUnavailable();
    for (const name of names.filter(name => !name.endsWith('.why'))) {
      current(); const path = join(parent.canonical, name), why = `${path}.why`, base = bases.get(name)!;
      let data: QuarantineSource | null = null, receipt: QuarantineSource | null = null;
      try {
        data = captureQuarantineSource(path); receipt = captureQuarantineSource(why); if (!data || !receipt) { preservedUnknown++; continue; }
        const native = originalQuarantineSource(data), originalReceipt = originalQuarantineSource(receipt);
        if (originalReceipt.original.size > 65536n) { preservedUnknown++; continue; }
        if (originalReceipt.original.size === 0n) {
          // A process that died between unlinking the source and writing the receipt leaves an owned archive with an
          // empty receipt. Past the grace window no writer can still be mid-publication, so the pair ages and counts
          // against retention like any other instead of being preserved as unknown forever.
          const receiptCreatedAt = Number(originalReceipt.original.mtimeNs / 1_000_000n);
          if (now - receiptCreatedAt <= EMPTY_RECEIPT_GRACE_MS || (native.original.mode & 0o777n) !== 0o600n || (originalReceipt.original.mode & 0o777n) !== 0o600n) { preservedUnknown++; continue; }
          data.assertCurrent(); receipt.assertCurrent(); rows.push({ name, path, why, dataPhysical: atomicFileStamp(native.original), receiptPhysical: atomicFileStamp(originalReceipt.original), createdAt: receiptCreatedAt, bytes: Number(native.original.size), current });
          continue;
        }
        const record = receiptDocument(JSON.parse(receipt.read()) as unknown, base, name);
        if (!record || atomicFileStamp(native.original) !== record.physical || (native.original.mode & 0o777n) !== 0o600n || (originalReceipt.original.mode & 0o777n) !== 0o600n) { preservedUnknown++; continue; }
        data.assertCurrent(); receipt.assertCurrent(); rows.push({ name, path, why, dataPhysical: atomicFileStamp(native.original), receiptPhysical: atomicFileStamp(originalReceipt.original), createdAt: record.createdAt, bytes: Number(native.original.size + originalReceipt.original.size), current });
      } catch { preservedUnknown++; } finally { try { data?.close(); } finally { receipt?.close(); } }
    }
    preservedUnknown += names.filter(name => name.endsWith('.why') && !nameSet.has(name.slice(0, -4))).length;
  }
  rows.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
  const retained = currentName ? rows.filter(row => row.name === currentName).concat(rows.filter(row => row.name !== currentName)) : rows;
  for (let index = 0; index < retained.length; index++) {
    const row = retained[index]!, old = age !== undefined && now - row.createdAt > age;
    if (row.name === currentName || (index < cap && !old)) continue;
    row.current(); let data: QuarantineSource | null = null, receipt: QuarantineSource | null = null;
    try {
      data = captureQuarantineSource(row.path); receipt = captureQuarantineSource(row.why);
      if (!data || !receipt) { if (data || receipt) preservedUnknown++; continue; }
      if (atomicFileStamp(originalQuarantineSource(data).original) !== row.dataPhysical || atomicFileStamp(originalQuarantineSource(receipt).original) !== row.receiptPhysical) { preservedUnknown++; continue; }
      row.current(); data.assertCurrent(); receipt.assertCurrent();
      try { unlinkSync(row.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      logger.warn('[atomic-json-store] physically owned quarantine payload removed', { quarantinePath: row.path });
      invokeQuarantineCallback(() => effect?.(false)); row.current(); receipt.assertCurrent();
      unlinkSync(row.why); invokeQuarantineCallback(() => effect?.(false)); reaped++;
      if (old) expired++; else overCap++;
      bytesReclaimed += row.bytes;
    } finally { try { data?.close(); } finally { receipt?.close(); } }
  }
  for (const current of currents) current();
  return { reaped, expired, overCap, bytesReclaimed, preservedUnknown };
}

/** Preserve the exact already-read file with exclusive link publication. A
 * failed recovery never reports absent and lets callers overwrite a survivor.
 */
export function quarantineCorruptFile(filePath: string, options: QuarantineOptions): QuarantineOutcome {
  const label = options.label, reason = options.reason, recovery = options.recovery;
  const guard = options.assertCurrent?.bind(options), effect = options.onEffect?.bind(options);
  const maxFiles = options.maxFiles ?? CORRUPT_QUARANTINE_MAX_FILES, maximumAgeMs = options.maximumAgeMs, now = options.now ?? Date.now();
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(now) || now < 0) quarantineUnavailable();
  const borrowed = options.source, source = borrowed ?? captureQuarantineSource(filePath); if (!source) quarantineUnavailable();
  const native = originalQuarantineSource(source);
  if (native.selected !== absoluteQuarantinePath(filePath)) quarantineUnavailable();
  const current = () => { invokeQuarantineCallback(guard); source.assertCurrent(); };
  let archiveLinked = false;
  let archive: string | undefined, whyFd: number | undefined, whyOriginal: BigIntStats | undefined, why: string | undefined;
  try {
    current();
    const reaped = reapOwnedQuarantines(filePath, { maxFiles: maxFiles - 1, ...(maximumAgeMs === undefined ? {} : { maximumAgeMs }), now, assertCurrent: current, onEffect: effect }); current();
    const dir = native.parent.canonical, base = basename(native.path), timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (readdirSync(dir).filter(name => name.startsWith(`${base}.corrupt-`)).length >= MAX_QUARANTINE_RECORDS * 2) quarantineUnavailable();
    archive = join(dir, `${base}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`); why = `${archive}.why`;
    // Refuse a collision on either member before changing the source. Native
    // open/link exclusivity also protects a collision after this observation.
    if (lstatSync(archive, { throwIfNoEntry: false }) || lstatSync(why, { throwIfNoEntry: false })) quarantineUnavailable();
    whyFd = openSync(why, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); whyOriginal = fstatSync(whyFd, { bigint: true }); fchmodSync(whyFd, 0o600);
    const emptyReceipt = atomicFileStamp(fstatSync(whyFd, { bigint: true }));
    invokeQuarantineCallback(() => effect?.(false)); current();
    if (atomicFileStamp(fstatSync(whyFd, { bigint: true })) !== emptyReceipt || atomicFileStamp(lstatSync(why, { bigint: true })) !== emptyReceipt) quarantineUnavailable();
    linkSync(native.path, archive); archiveLinked = true;
    let linked = fstatSync(native.fd, { bigint: true });
    if (!sameQuarantineFile(linked, native.original) || linked.nlink !== 2n || linked.size !== native.original.size || linked.mtimeNs !== native.original.mtimeNs
      || atomicFileStamp(lstatSync(archive, { bigint: true })) !== atomicFileStamp(linked) || atomicFileStamp(lstatSync(native.path, { bigint: true })) !== atomicFileStamp(linked)) quarantineUnavailable();
    // Only our exact original source is removed; the archive already names it.
    native.parent.assertCurrent(); if (atomicFileStamp(lstatSync(native.path, { bigint: true })) !== atomicFileStamp(linked)) quarantineUnavailable(); unlinkSync(native.path); native.consumed = true;
    fchmodSync(native.fd, 0o600); linked = fstatSync(native.fd, { bigint: true });
    const archived = atomicFileStamp(linked);
    const archiveCurrent = () => { invokeQuarantineCallback(guard); native.parent.assertCurrent(); if (atomicFileStamp(fstatSync(native.fd, { bigint: true })) !== archived || atomicFileStamp(lstatSync(archive!, { bigint: true })) !== archived) quarantineUnavailable(); };
    invokeQuarantineCallback(() => effect?.(true)); archiveCurrent(); confirmFileDurable(archive); archiveCurrent();
    const explanation = `The ${label} store file failed to load: ${reason}.\nThe corrupt file was preserved as ${basename(archive)}.\n${recovery}${reaped.reaped > 0 ? `\n${reaped.reaped} older physically owned quarantine pair(s) were deleted under the ${maxFiles}-file retention bound.` : ''}${reaped.preservedUnknown > 0 ? `\n${reaped.preservedUnknown} unverified historical recovery path(s) were preserved for inspection.` : ''}`;
    const record: QuarantineReceipt = { schema: 1, role: 'goodvibes-owned-quarantine', source: base, archive: basename(archive), createdAt: now, physical: archived, explanation };
    writeFileSync(whyFd, `${JSON.stringify(record, null, 2)}\n`); fsyncSync(whyFd);
    const receiptStamp = atomicFileStamp(fstatSync(whyFd, { bigint: true }));
    archiveCurrent(); if (atomicFileStamp(lstatSync(why, { bigint: true })) !== receiptStamp) quarantineUnavailable(); confirmFileDurable(why); archiveCurrent();
    if (atomicFileStamp(lstatSync(why, { bigint: true })) !== receiptStamp) quarantineUnavailable();
    if (reaped.reaped > 0) logger.warn(`[${label}] older physically owned quarantine pairs were deleted`, { filePath, reaped: reaped.reaped });
    logger.error(`[${label}] store file was quarantined; ${recovery}`, { filePath, quarantinePath: archive, reaped: reaped.reaped, preservedUnknown: reaped.preservedUnknown });
    return Object.freeze({ quarantinePath: archive, ...reaped });
  } catch (error) {
    // A visible archive is forensic evidence, even after an uncertain receipt or
    // directory sync. No rollback removes it or restores over a new source.
    throw error;
  } finally {
    if (archiveLinked && !native.consumed && archive) {
      // Undo only our acknowledged extra link while the original source still
      // exists as the same file. A lost source-removal acknowledgement retains
      // the visible archive, never removes a replacement source or archive.
      try { native.parent.assertCurrent(); const original = lstatSync(native.path, { bigint: true, throwIfNoEntry: false }), saved = lstatSync(archive, { bigint: true, throwIfNoEntry: false });
        if (saved && sameQuarantineFile(saved, native.original)) {
          if (original && sameQuarantineFile(original, native.original)) { unlinkSync(archive); invokeQuarantineCallback(() => effect?.(false)); }
          else native.consumed = true;
        }
      } catch { /* Uncertain/retired native paths remain intact for recovery. */ }
    }
    try { if (whyFd !== undefined) { try { if (!native.consumed && why && whyOriginal) { native.parent.assertCurrent(); const actual = lstatSync(why, { bigint: true, throwIfNoEntry: false }); if (actual && sameQuarantineFile(actual, whyOriginal)) unlinkSync(why); } } finally { closeSync(whyFd); } } }
    finally { if (!borrowed) source.close(); }
  }
}

/** Reclaim only an aged, recognized native temp whose recorded writer is
 * proven dead. Return its bytes only after exact physical deletion. */
function cleanupStaleTempFile(dir: string, filePath: string, name: string, staleBefore: number,
  assertCurrent: () => void, onEffect: (() => void) | undefined, legacyPidTimestamp = false): number | undefined {
  const prefix = `${basename(filePath)}.tmp-`;
  if (basename(name) !== name) return undefined;
  // Current writer PID/sequence/UUID suffix, or the actual earlier PID-only
  // format. A coincidental '.json.tmp-' substring is not a native receipt.
  let writer = name.startsWith(prefix)
    ? /^([1-9]\d*)(?:-[0-9a-z]+-[0-9a-f]{8})?$/.exec(name.slice(prefix.length)) : null;
  if (!writer && legacyPidTimestamp && name.startsWith(`${basename(filePath)}.`)) {
    // Explicit orchestration-store compatibility only. Its released writer
    // used <snapshot.json>.<pid>.<Date.now()>.tmp, never an arbitrary *.tmp.
    const earlier = /^([1-9]\d*)\.(\d+)\.tmp$/.exec(name.slice(basename(filePath).length + 1));
    const timestamp = earlier ? Number(earlier[2]) : NaN;
    if (Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= staleBefore) writer = earlier;
  }
  if (!writer) return undefined;
  const pid = Number(writer[1]); if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return undefined; }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') return undefined; }
  const stalePath = join(dir, name); assertCurrent();
  let before: BigIntStats;
  try { before = lstatSync(stalePath, { bigint: true }); } catch { return undefined; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || Number(before.mtimeMs) > staleBefore
    || (process.geteuid && before.uid !== BigInt(process.geteuid()))) return undefined;
  assertCurrent();
  try {
    const after = lstatSync(stalePath, { bigint: true });
    if (atomicFileStamp(after) !== atomicFileStamp(before)) return undefined;
    unlinkSync(stalePath);
  } catch { return undefined; } // Unknown ownership/replacement retains the source.
  onEffect?.(); // A failed owner notification is never an optional GC miss.
  logger.warn('[atomic-json-store] removed a stale temp file left by a dead writer', { filePath, stalePath, ageMs: Math.max(0, Date.now() - Number(before.mtimeMs)) });
  return Number(before.size);
}

/** Explicit housekeeping uses the same native writer identity policy as an
 * atomic publication. Inspect one listed candidate, without rescanning the
 * directory per contract or creating a missing directory. */
export function reapOwnedAtomicTempFile(filePath: string, temporaryName: string, options: {
  readonly now?: number;
  readonly minimumAgeMs?: number;
  /** Only stores whose actual old writer used <file>.<pid>.<timestamp>.tmp. */
  readonly legacyPidTimestamp?: boolean;
} = {}): number | undefined {
  const now = options.now ?? Date.now(), minimumAge = Math.max(STALE_TEMP_FILE_MIN_AGE_MS, options.minimumAgeMs ?? STALE_TEMP_FILE_MIN_AGE_MS);
  if (!Number.isFinite(now) || !Number.isFinite(minimumAge)) throw new Error('Invalid atomic temporary-file cleanup clock');
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const parent = prepareAtomicDirectory(dirname(absolute), () => {}, undefined, false);
  parent.assertCurrent();
  return cleanupStaleTempFile(parent.canonical, join(parent.canonical, basename(absolute)), temporaryName, now - minimumAge, () => parent.assertCurrent(), undefined, options.legacyPidTimestamp === true);
}

/** Opportunistic publication cleanup shares the same closed leaf selector. */
function cleanupStaleTempFiles(dir: string, filePath: string, assertCurrent: () => void, onEffect: (() => void) | undefined): void {
  let names: string[]; try { names = readdirSync(dir); } catch { return; }
  const staleBefore = Date.now() - STALE_TEMP_FILE_MIN_AGE_MS;
  for (const name of names) cleanupStaleTempFile(dir, filePath, name, staleBefore, assertCurrent, onEffect);
}
