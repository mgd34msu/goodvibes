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
 * The two mechanics:
 *
 *   1. {@link writeFileAtomic} / {@link writeJsonFileAtomic}, write to a
 *      sibling temp file in the same directory as the target (so the later
 *      rename stays on one filesystem), fsync the descriptor before closing
 *      it, chmod it to the exact requested mode (so the result does not depend
 *      on the process umask), then `renameSync` it over the target.
 *      `rename(2)` is atomic on POSIX: a concurrent reader, and a process
 *      that dies mid-write, can only ever observe the previous complete file
 *      or the new complete one, never a torn write. `durable: true` additionally
 *      confirms the published file and complete canonical/alias ancestry before
 *      returning success; the historical default retains rename-only behavior.
 *
 *      The temp name is unique per WRITE, not per process
 *      ({@link createAtomicTempPath}: `<name>.tmp-<pid>-<seq>-<random>`), and
 *      the pre-write sweep of leftovers only reaps temp files older than
 *      {@link STALE_TEMP_FILE_MIN_AGE_MS}. Both halves fix one crash: this
 *      module used to name the temp file `<name>.tmp-<pid>` and sweep every
 *      `<name>.tmp-*` it found, on the reasoning that a temp file for this
 *      store could only be a dead process's leftover. It could also be a
 *      SECOND LIVE WRITER's file, another process writing the same shared
 *      store, or the same process writing the same store from a worker
 *      thread. Writer B's sweep (or, with a shared name, writer B's rename)
 *      then deleted writer A's temp file out from under it, and writer A's
 *      next `chmodSync` died with
 *      `ENOENT: no such file or directory, chmod '…/watchers.json.tmp-905081'`
 *     , a real crash that killed a running agent. With a per-write name,
 *      writer A and writer B never share a path; with an age-gated sweep, a
 *      temp file young enough to belong to a write still in progress is left
 *      alone. Reclamation additionally requires a recognized native PID that
 *      no longer exists; age alone cannot identify a crashed writer.
 *
 *      There is deliberately NO in-process write lock. Every step above is a
 *      synchronous `node:fs` call with no await between them, so two writes of
 *      one store cannot interleave on one thread, and a JavaScript lock
 *      cannot span worker threads or separate processes, which is where the
 *      real concurrency lives. Ordering is settled by `rename(2)` instead:
 *      whichever writer renames last wins, whole.
 *
 *      A write that fails still throws, because most stores must not report a
 *      save that did not happen. Callers whose failure policy is genuinely
 *      log-and-continue, periodic snapshots that rebuild themselves, use
 *      {@link writeJsonFileAtomicSafe}, which logs the path and errno loudly
 *      and returns an {@link AtomicWriteOutcome} instead of throwing.
 *
 *   2. {@link readJsonFileOrQuarantine}, a file this reader cannot trust
 *      (unparseable JSON, a torn or zero-tailed write, the wrong shape) is
 *      moved aside to `<name>.corrupt-<ISO>-<8char>` with a sibling `.why`
 *      receipt, logged loudly at error level, and reported to the caller as
 *      the ordinary "absent" answer (`null`) so the caller rebuilds instead of
 *      crashing. The original file is never deleted and never overwritten,
 *      only renamed, so the evidence survives for inspection. Quarantine
 *      files are bounded at {@link CORRUPT_QUARANTINE_MAX_FILES} per store,
 *      oldest reaped first, and the reap is disclosed in the newest receipt.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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
  /** Defaults to true here. A false requires an already-existing parent. */
  readonly mkdirp?: boolean;
  /** Native owner advances only its own filesystem effects: false for created
   * parents/staging, true after the original stage becomes the destination. */
  readonly onEffect?: ((published?: boolean) => void) | undefined;
  /** Additional operation restriction, completed synchronously before each physical write. */
  readonly assertCurrent?: (() => void) | undefined;
  /**
   * Exact mode of the resulting file. Applied with an explicit `chmod` before
   * the rename, so the result does not vary with the process umask.
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
  const canonical = realpathSync(filePath);
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
  if (cursor !== canonical) throw new Error('Durable path changed during resolution');
  const file = lstatSync(canonical);
  if (!file.isFile()) throw new Error('Durable publication is not a regular file');
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
      if (realpathSync(filePath) !== path.canonical || !sameFile(fstatSync(fd), path.file)
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

interface AtomicDirectoryOwner { readonly canonical: string; assertCurrent(): void; assertPhysicalCurrent(): void }
const atomicDirectoryStamp = (stat: BigIntStats): string => {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Atomic file parent is not a physical directory');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
};
const atomicFileStamp = (stat: BigIntStats): string => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
  stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
function atomicMissing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

/** Plan the actual parent lookup, including configured existing aliases and
 * symlink-aware '..', before creating anything. Never create a dangling alias's
 * target. Original directories and links stay pinned through publication. */
function prepareAtomicDirectory(absolute: string, assertOwner: () => void, effect: (() => void) | undefined, mkdirp: boolean): AtomicDirectoryOwner {
  const directories = new Map<string, string>(), links: Array<{ path: string; identity: string; target: string }> = [];
  const absent = new Set<string>();
  let cursor = parse(absolute).root, pending = absolute.slice(cursor.length).split(sep);
  directories.set(cursor, atomicDirectoryStamp(lstatSync(cursor, { bigint: true })));
  const observe = (path: string) => {
    const stat = lstatSync(path, { bigint: true }), identity = atomicDirectoryStamp(stat), previous = directories.get(path);
    if (previous !== undefined && previous !== identity) throw new Error('Atomic file parent changed during capture');
    directories.set(path, identity);
  };
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
      if (atomicFileStamp(lstatSync(path, { bigint: true })) !== identity || !statSync(realpathSync(path)).isDirectory()) throw new Error('Atomic file parent alias is unavailable');
      links.push({ path, identity, target });
      if (isAbsolute(target)) { cursor = parse(target).root; observe(cursor); }
      pending = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep), ...pending];
      continue;
    }
    observe(path); cursor = path;
  }
  const canonical = cursor;
  const current = (checkAbsent = true) => {
    for (const [path, identity] of directories) if (atomicDirectoryStamp(lstatSync(path, { bigint: true })) !== identity) throw new Error('Atomic file parent changed');
    for (const link of links) if (atomicFileStamp(lstatSync(link.path, { bigint: true })) !== link.identity || readlinkSync(link.path) !== link.target) throw new Error('Atomic file parent alias changed');
    for (const path of checkAbsent ? absent : []) {
      try { lstatSync(path); } catch (error) { if (atomicMissing(error)) continue; throw error; }
      throw new Error('Atomic file parent appeared during capture');
    }
  };
  current();
  if (!mkdirp && absent.size) throw Object.assign(new Error('Atomic publication parent does not exist'), { code: 'ENOENT' });
  for (const path of [...absent]) {
    assertOwner(); current(); mkdirSync(path);
    const created = lstatSync(path, { bigint: true });
    directories.set(path, atomicDirectoryStamp(created)); absent.delete(path); current(false);
    // Retain inherited group/special bits while ensuring the creator can finish
    // a nested write even under a restrictive umask.
    const mode = Number(created.mode & 0o7777n) | 0o700;
    if (Number(created.mode & 0o7777n) !== mode) {
      chmodSync(path, mode); const after = lstatSync(path, { bigint: true });
      if (after.dev !== created.dev || after.ino !== created.ino) throw new Error('Atomic file created parent changed');
      directories.set(path, atomicDirectoryStamp(after));
    }
    current(); if (effect) { effect(); current(); }
  }
  current(); if (realpathSync(absolute) !== canonical) throw new Error('Atomic file parent lookup changed');
  const physical: Array<{ path: string; identity: string }> = [];
  for (let path = canonical;; path = dirname(path)) {
    const identity = directories.get(path); if (identity === undefined) throw new Error('Atomic physical parent proof is unavailable');
    physical.push({ path, identity }); if (dirname(path) === path) break;
  }
  return { canonical,
    assertCurrent() { current(); if (realpathSync(absolute) !== canonical) throw new Error('Atomic file parent lookup changed'); },
    assertPhysicalCurrent() { for (const parent of physical) if (atomicDirectoryStamp(lstatSync(parent.path, { bigint: true })) !== parent.identity) throw new Error('Atomic physical parent changed'); },
  };
}

function ownsAtomicFile(stat: BigIntStats | undefined, original: BigIntStats | undefined): boolean {
  return !!stat && !!original && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && stat.dev === original.dev && stat.ino === original.ino && stat.uid === original.uid && stat.gid === original.gid && stat.birthtimeNs === original.birthtimeNs;
}
/**
 * Write `contents` to `filePath` atomically, creating parent directories as
 * needed. See the module docstring for the mechanics and why they matter.
 */
export function writeFileAtomic(filePath: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const input = typeof contents === 'string' ? contents : Buffer.from(contents);
  const expectedLength = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  const guard = options.assertCurrent?.bind(options), onEffect = options.onEffect?.bind(options), mode = options.mode ?? DEFAULT_STORE_FILE_MODE;
  const durable = options.durable === true, sweep = options.cleanupStaleTemps !== false, mkdirp = options.mkdirp !== false;
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const leaf = basename(absolute);
  let parent: AtomicDirectoryOwner | undefined, tmpPath: string | undefined, target: string | undefined;
  let fd: number | undefined, original: BigIntStats | undefined, prepared: BigIntStats | undefined, publishedImage: BigIntStats | undefined;
  let published = false, attempted = false, publicationNotified = false;
  const effect = (isPublished = false) => {
    if (isPublished) { if (publicationNotified) return; publicationNotified = true; }
    const returned: unknown = onEffect?.(isPublished);
    if (returned !== undefined) {
      if (nodeTypes.isPromise(returned)) Reflect.apply(Promise.prototype.then, returned, [undefined, () => {}]);
      throw new Error('Atomic file effect notification must complete synchronously');
    }
  };
  const current = () => {
    const result: unknown = guard?.();
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) Reflect.apply(Promise.prototype.then, result, [undefined, () => {}]);
      throw new Error('Atomic file operation currentness is unavailable.');
    }
    parent?.assertCurrent();
  };
  const assertTemporary = () => {
    parent?.assertCurrent();
    if (fd === undefined || !tmpPath || !original) throw new Error('Atomic staging ownership is unavailable');
    const descriptor = fstatSync(fd, { bigint: true }), selected = lstatSync(tmpPath, { bigint: true, throwIfNoEntry: false });
    if (!ownsAtomicFile(descriptor, original) || !ownsAtomicFile(selected, original)
      || (prepared !== undefined && (atomicFileStamp(descriptor) !== atomicFileStamp(prepared) || !selected || atomicFileStamp(selected) !== atomicFileStamp(prepared)))) throw new Error('Atomic staging source changed');
  };
  const observePublished = (): BigIntStats => {
    parent?.assertCurrent();
    if (fd === undefined || !target || !original) throw new Error('Atomic published ownership is unavailable');
    const descriptor = fstatSync(fd, { bigint: true }), selected = lstatSync(target, { bigint: true });
    if (!ownsAtomicFile(descriptor, original) || !ownsAtomicFile(selected, original)
      || atomicFileStamp(descriptor) !== atomicFileStamp(selected)) throw new Error('Atomic publication is not the original staged image');
    return descriptor;
  };
  const assertPublished = () => {
    if (!publishedImage || atomicFileStamp(observePublished()) !== atomicFileStamp(publishedImage)) throw new Error('Atomic published image changed');
  };
  const cleanup = () => {
    if (!parent || !tmpPath || !original || published) return;
    try { parent.assertPhysicalCurrent(); if (ownsAtomicFile(lstatSync(tmpPath, { bigint: true, throwIfNoEntry: false }), original)) unlinkSync(tmpPath); }
    catch { /* Preserve unknown/foreign paths. Cleanup never supplies authority. */ }
  };
  try {
    if (!leaf || leaf === '.' || leaf === '..' || absolute.endsWith(sep) || absolute.includes('\0')) throw new Error('Atomic publication requires a file target');
    parent = prepareAtomicDirectory(dirname(absolute), current, onEffect ? () => effect() : undefined, mkdirp); current();
    target = join(parent.canonical, leaf);
    if (sweep) cleanupStaleTempFiles(parent.canonical, target, current, onEffect ? () => { parent?.assertCurrent(); effect(); parent?.assertCurrent(); } : undefined);
    tmpPath = createAtomicTempPath(target); current();
    fd = openSync(tmpPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, DEFAULT_STORE_FILE_MODE);
    original = fstatSync(fd, { bigint: true });
    if (onEffect) { assertTemporary(); effect(); assertTemporary(); }
    current(); assertTemporary();
    fchmodSync(fd, mode); current(); assertTemporary();
    const written = typeof input === 'string' ? writeSync(fd, input, null, 'utf8') : writeSync(fd, input, 0, input.byteLength, null);
    if (written !== expectedLength) throw new Error('Incomplete atomic file write');
    prepared = fstatSync(fd, { bigint: true });
    if (prepared.size !== BigInt(expectedLength)) throw new Error('Atomic staging size changed');
    current(); assertTemporary(); fsyncSync(fd);
    current(); assertTemporary();
    // The prepared nanosecond file stamp detects edits by a borrowed guard;
    // publication does not need to read back or hash the completed file.
    // No borrowed callback or async gap is allowed between the identity proof
    // and the native rename into the retained original physical parent.
    attempted = true; renameSync(tmpPath, target); published = true;
    // rename changes ctime. Capture the new exact descriptor/path stamp before
    // any borrowed observer may advance its own source receipt.
    publishedImage = observePublished();
    if (onEffect) { effect(true); assertPublished(); }
    if (durable) {
      try { confirmFileDurable(absolute); }
      catch (error) {
        if (error instanceof AtomicWriteDurabilityError && error.filePath !== filePath) throw new AtomicWriteDurabilityError(filePath, error.phase, error.cause);
        throw error;
      }
    }
    assertPublished();
    closeSync(fd); fd = undefined;
  } catch (error) {
    if (!published && attempted) {
      // A thrown rename is only pre-publication when the exact original stage
      // still exists under the original parent. Otherwise retain uncertainty.
      try { assertTemporary(); } catch { published = true; }
      if (onEffect && published && !publicationNotified && target && parent) {
        try {
          publishedImage = observePublished();
          effect(true); assertPublished();
        } catch { /* Uncertain/foreign publication cannot supply an effect receipt. */ }
      }
    }
    if (fd !== undefined) { try { closeSync(fd); } catch { /* The original error remains the diagnostic. */ } fd = undefined; }
    cleanup();
    if (durable) {
      if (error instanceof AtomicWriteDurabilityError) throw error;
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

/**
 * Read and parse a JSON store file, never throwing on corrupt content.
 *
 * Returns `null` both when the file does not exist and when it existed but
 * could not be trusted, in the latter case the file is quarantined first (see
 * the module docstring). Callers treat `null` as "no store yet" and rebuild.
 *
 * A read failure (permissions, the file vanishing between the exists check and
 * the read) is deliberately NOT caught: there is no content to move aside, so
 * quarantine has nothing to do and the error propagates to the caller.
 */
export function readJsonFileOrQuarantine<T>(filePath: string, options: QuarantineLoadOptions<T>): T | null {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');

  try {
    return options.validate(JSON.parse(raw) as unknown);
  } catch (error) {
    quarantineCorruptFile(filePath, {
      label: options.label,
      reason: error instanceof Error ? error.message : String(error),
      recovery: options.recovery,
    });
    return null;
  }
}

export interface QuarantineOptions {
  /** Short store name, e.g. `'config/secrets'`. */
  readonly label: string;
  /** Why the file could not be trusted. */
  readonly reason: string;
  /** What happens now that the file is gone, for the `.why` receipt. */
  readonly recovery: string;
}

/**
 * Move a corrupt store file aside, write a `.why` receipt beside it, log the
 * event loudly, and reap old quarantine files past the bound.
 *
 * Exported for stores that parse in stages and decide for themselves which
 * stage counts as container corruption (`config/secrets.ts` quarantines an
 * unreadable JSON envelope but must never quarantine a decrypt failure, which
 * means the file is intact and the key is wrong).
 */
export function quarantineCorruptFile(filePath: string, options: QuarantineOptions): void {
  const { label, reason, recovery } = options;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = join(dir, `${base}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`);
  const whyPath = `${quarantinePath}.why`;

  let moved = false;
  try {
    renameSync(filePath, quarantinePath);
    moved = true;
  } catch (renameError) {
    logger.error(`[${label}] could not move a corrupt store file aside; leaving it in place`, {
      filePath,
      reason,
      renameError: renameError instanceof Error ? renameError.message : String(renameError),
    });
  }

  // The just-quarantined file is excluded from reaping by name: its .why is
  // written only after the reap, so on a filesystem with coarse mtimes an
  // all-tie sort could otherwise pick it as the "oldest" victim and leave the
  // receipt written below orphaned, the exact failure a matrix runner caught.
  const reapResult = moved
    ? reapCorruptQuarantineFiles(dir, base, basename(quarantinePath))
    : { scanned: 0, reaped: 0 };

  if (moved) {
    const whyLines = [
      `The ${label} store file at ${filePath} failed to load: ${reason}.`,
      `The corrupt file was moved to ${basename(quarantinePath)} for inspection and is never parsed again.`,
      recovery,
      reapResult.reaped > 0
        ? `${reapResult.reaped} older quarantined file(s) beyond the ${CORRUPT_QUARANTINE_MAX_FILES}-file bound were deleted (oldest first) to keep this quarantine from growing without limit.`
        : null,
    ].filter((line): line is string => line !== null);
    try {
      writeFileSync(whyPath, `${whyLines.join('\n')}\n`, 'utf-8');
    } catch (whyError) {
      logger.error(`[${label}] could not write the .why receipt beside a quarantined store file`, {
        whyPath,
        whyError: whyError instanceof Error ? whyError.message : String(whyError),
      });
    }
  }

  logger.error(`[${label}] store file was corrupt and has been quarantined; ${recovery}, ${reason}`, {
    filePath,
    quarantinePath: moved ? quarantinePath : undefined,
    reaped: reapResult.reaped,
  });
}

/** Reclaim only an aged, recognized native temp whose recorded writer is
 * proven dead. Return its bytes only after exact physical deletion. */
function cleanupStaleTempFile(dir: string, filePath: string, name: string, staleBefore: number,
  assertCurrent: () => void, onEffect: (() => void) | undefined): number | undefined {
  const prefix = `${basename(filePath)}.tmp-`;
  if (basename(name) !== name || !name.startsWith(prefix)) return undefined;
  // Current writer PID/sequence/UUID suffix, or the actual earlier PID-only
  // format. A coincidental '.json.tmp-' substring is not a native receipt.
  const writer = /^([1-9]\d*)(?:-[0-9a-z]+-[0-9a-f]{8})?$/.exec(name.slice(prefix.length));
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
} = {}): number | undefined {
  const now = options.now ?? Date.now(), minimumAge = Math.max(STALE_TEMP_FILE_MIN_AGE_MS, options.minimumAgeMs ?? STALE_TEMP_FILE_MIN_AGE_MS);
  if (!Number.isFinite(now) || !Number.isFinite(minimumAge)) throw new Error('Invalid atomic temporary-file cleanup clock');
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const parent = prepareAtomicDirectory(dirname(absolute), () => {}, undefined, false);
  parent.assertCurrent();
  return cleanupStaleTempFile(parent.canonical, join(parent.canonical, basename(absolute)), temporaryName, now - minimumAge, () => parent.assertCurrent(), undefined);
}

/** Opportunistic publication cleanup shares the same closed leaf selector. */
function cleanupStaleTempFiles(dir: string, filePath: string, assertCurrent: () => void, onEffect: (() => void) | undefined): void {
  let names: string[]; try { names = readdirSync(dir); } catch { return; }
  const staleBefore = Date.now() - STALE_TEMP_FILE_MIN_AGE_MS;
  for (const name of names) cleanupStaleTempFile(dir, filePath, name, staleBefore, assertCurrent, onEffect);
}

/**
 * Delete `.corrupt-*` files (and their `.why` receipts) beyond
 * {@link CORRUPT_QUARANTINE_MAX_FILES}, oldest first. Runs after every new
 * quarantine so a repeatedly-corrupting writer cannot accumulate files without
 * bound.
 */
function reapCorruptQuarantineFiles(
  dir: string,
  base: string,
  /** The quarantine file created by the caller in this same pass, never a victim. */
  currentName?: string,
): { scanned: number; reaped: number } {
  const prefix = `${base}.corrupt-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const quarantineNames = new Set(names.filter((name) => name.startsWith(prefix) && !name.endsWith('.why')));

  // Self-heal: a .why with no surviving quarantine file discloses nothing and
  // keeps nothing, delete it, whatever past interruption produced it.
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.why')) continue;
    if (!quarantineNames.has(name.slice(0, -'.why'.length))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Best-effort.
      }
    }
  }

  const corruptFiles = [...quarantineNames]
    .filter((name) => name !== currentName)
    .map((name) => {
      const full = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { full, name, mtimeMs };
    });

  // The cap counts every quarantine file including the current one; only the
  // older ones are eligible victims.
  const cap = currentName !== undefined && quarantineNames.has(currentName)
    ? CORRUPT_QUARANTINE_MAX_FILES - 1
    : CORRUPT_QUARANTINE_MAX_FILES;

  let reaped = 0;
  if (corruptFiles.length > cap) {
    // Oldest first; mtime ties (coarse-mtime filesystems) break by the
    // millisecond timestamp baked into the quarantine name, so the order is
    // total and matches creation order.
    corruptFiles.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));
    const excess = corruptFiles.length - cap;
    for (const victim of corruptFiles.slice(0, excess)) {
      try {
        unlinkSync(victim.full);
        reaped += 1;
      } catch {
        // Best-effort, a file another sweeper already removed counts as reclaimed.
      }
      try {
        unlinkSync(`${victim.full}.why`);
      } catch {
        // The receipt may not exist (an earlier write failure), not an error.
      }
    }
  }

  return { scanned: quarantineNames.size, reaped };
}
