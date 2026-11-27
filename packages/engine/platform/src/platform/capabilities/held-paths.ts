/**
 * held-paths.ts, the file or folder a caller other than the person names, held from the check to the act for the
 * whole call (path-inputs.ts `callerPathOf`), so a folder or a file swapped for a link after the check gains nothing.
 *
 * The target is opened first and judged by where the opened file really is (`/proc/self/fd/<n>`), never by a path read
 * again later: a link anywhere on the way is judged by what was opened, and once opened the file stays the one checked
 * whatever is renamed or replaced around it.
 *
 * - A folder that exists is NOT copied: the handler works on the real folder through the handle the daemon opened. It is
 *   given that handle's path (`/proc/<pid>/fd/<n>`), and every path beneath it the handler acts on is resolved through
 *   `heldPath`, one component at a time from an opened, checked folder, never following a link: the next component is
 *   opened as `/proc/self/fd/<n>/<name>` without following it, and a link, a FIFO, a device or a socket met on the way
 *   is refused. A project root with its dependencies is as usable as it is; nothing in it can be redirected by a link
 *   planted inside it; what the handler deletes there is deleted (there is no copy to lose it in).
 * - A file that exists is a private copy of the held one, read through its handle, bounded (`HELD_MAX_BYTES`, by its
 *   length, so a sparse file of a terabyte is refused, never read); when the call ends well and the copy changed, it is
 *   written back over the held file through the held folder, unless the file changed meanwhile (refused, never silently
 *   replaced).
 * - A file or folder to be made: nothing yet; the handler makes it in a folder of this call's own, and what it made is
 *   put into the project through the held folder when the call ends well, all or nothing.
 *
 * Two calls on one file: a call that holds a file (a copy it will write back, or a file beneath a held folder it
 * writes) holds that file's lock until it ends; another call naming the same file meanwhile is refused in words, and a
 * write-back finds the file as its copy was taken or is refused. Neither replaces the other unseen.
 *
 * The call's own folder is in the program's own home (`<daemon home>/held`, or `~/.goodvibes/held` for a terminal
 * program: never the shared temp folder), owner-only; it is removed and every handle closed when the call ends, whatever
 * came of it. Its words name the project's file, never the call's own folder or a handle.
 *
 * A program the handler starts is never handed the `/proc/<pid>/fd/<n>` path of the process holding the call, through
 * which it would read that process's whole handle table: on a held folder (git on a memory folder) it inherits the
 * opened descriptor itself and names it by its own `/proc/self/fd/3` (`heldForChild`); on a held file (a browser
 * opening an export) it gets its own copy of what was written (`copyForProgram`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync, writeSync, type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Why a named path was not held: outside the project, changed while checked, a link or special file, too big, or busy. */
export class HeldPathRefusal extends Error {
  constructor(readonly why: 'outside' | 'changed' | 'kind' | 'too-big' | 'busy', message: string) {
    super(message);
    this.name = 'HeldPathRefusal';
  }
}

/** What one call may copy out of a project for its handler (a held single file, by its length). */
export const HELD_MAX_BYTES = 256 * 1024 * 1024;
export const HELD_MAX_FILES = 10_000;

/** A held file's identity as its copy was taken: the write-back refuses when it differs then. */
interface FileIdentity { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }

interface StagedFile {
  /** This call's own folder holding the copy. */
  readonly root: string;
  /** The held folder holding the file (its handle). */
  readonly folderFd: number;
  readonly folderReal: string;
  readonly named: string;
  /** The copy as taken, and the held file as it was then. */
  readonly copied: FileIdentity;
  readonly original: FileIdentity;
  readonly lockKey: string;
  readonly projectReal: string;
}

interface StagedNew {
  /** This call's own folder standing for `folderReal` (what the handler makes goes there first). */
  readonly root: string;
  readonly folderFd: number | undefined;
  readonly folderReal: string;
  readonly named: string;
  readonly projectReal: string;
}

interface HeldFolder {
  readonly fd: number;
  /** The path the handler is given for it (the handle's), and the form this process also names it by. */
  readonly root: string;
  readonly self: string;
  readonly projectReal: string;
  /** The folders beneath it opened so far, by their path relative to it. */
  readonly opened: Map<string, number>;
}

interface CallHold {
  readonly fds: number[];
  readonly files: StagedFile[];
  readonly fresh: StagedNew[];
  readonly folders: HeldFolder[];
  readonly base: string;
  /** What this call copied so far, against the bounds. */
  readonly budget: { bytes: number; files: number };
  /** The file locks this call holds. */
  readonly locks: Set<string>;
}

const calls = new AsyncLocalStorage<CallHold>();
/** Which call holds each file's lock (by the file's device and inode, or its real path when it is to be made). */
const fileLocks = new Map<string, CallHold>();

const within = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Whether this system lets a path be held (Linux's `/proc/self/fd`). */
const holdable = (): boolean => process.platform === 'linux' && existsSync('/proc/self/fd');

const fdLink = (fd: number): string => `/proc/self/fd/${fd}`;
/** The held handle as a path another part of this process names (the daemon's pid, so it names this process). */
const fdPath = (fd: number): string => `/proc/${process.pid}/fd/${fd}`;

/** Where the opened file really is now; a file removed since it was opened is nowhere. */
function realOf(fd: number): string | undefined {
  const target = readlinkSync(fdLink(fd));
  return target.endsWith(' (deleted)') || !target.startsWith('/') ? undefined : target;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

const OPEN_TARGET = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
const OPEN_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY;
/** The prefix of this call's own names beside a part's place in the project, while it is being put there. */
const PENDING = '.goodvibes-held-';

/** What a staging lifetime is: a folder older than this was left by a daemon that stopped mid-call, and is removed. */
const STAGING_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * The folder held calls stage in: `<daemon home>/held` given by the door (routes/capabilities.ts), else the program's own
 * `~/.goodvibes/held`. Made owner-only, refused unless it is a real folder of this account; folders older than their
 * lifetime are removed (a daemon stopped mid-call left them).
 */
function stagingBaseOf(given: string | undefined): string {
  const base = given ?? join(homedir(), '.goodvibes', 'held');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const info = lstatSync(base);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new HeldPathRefusal('outside', `${base}, where a call keeps its own copies, is not this account's own folder (a link, or another account's)`);
  }
  if ((info.mode & 0o777) !== 0o700) chmodSync(base, 0o700);
  const now = Date.now();
  for (const entry of readdirSync(base)) {
    try { if (now - lstatSync(join(base, entry)).mtimeMs > STAGING_LIFETIME_MS) rmSync(join(base, entry), { recursive: true, force: true }); } catch { /* gone */ }
  }
  return base;
}

/** A folder opened and checked inside the project; the handle is the caller's to keep or close. */
function heldFolder(path: string, projectReal: string): number {
  const fd = openSync(path, OPEN_FOLDER);
  const real = realOf(fd);
  if (real === undefined || !within(real, projectReal)) {
    closeSync(fd);
    throw new HeldPathRefusal('outside', `${path} is outside the project`);
  }
  return fd;
}

/** Take `key`'s lock for this call; refused while another call holds it. */
function lockFile(hold: CallHold, key: string, shown: string): void {
  const holder = fileLocks.get(key);
  if (holder !== undefined && holder !== hold) {
    throw new HeldPathRefusal('busy', `${shown} is being worked on by another call right now`);
  }
  fileLocks.set(key, hold);
  hold.locks.add(key);
}

const identityOf = (stat: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }): FileIdentity =>
  ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Copy one opened file's content into a new file at `to`; its identity as copied. */
function copyOpenedFile(fd: number, to: string, mode: number): FileIdentity {
  const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o777);
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let at = 0;
    for (;;) {
      const got = readSync(fd, chunk, 0, chunk.length, at);
      if (got === 0) break;
      let put = 0;
      while (put < got) put += writeSync(out, chunk, put, got - put);
      at += got;
    }
  } finally {
    closeSync(out);
  }
  return identityOf(lstatSync(to));
}

/**
 * The path the handler acts on for `given`, a path whose real place was found inside `projectReal`; held for the call.
 * Undefined when no call holds paths (a handler run outside a door) or the system cannot hold one: the caller then acts
 * on the checked path as it is.
 */
export function holdCallerPath(given: string, projectReal: string): string | undefined {
  const hold = calls.getStore();
  if (hold === undefined || !holdable()) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(given, OPEN_TARGET);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw new HeldPathRefusal('outside', `${given} is a link that leads nowhere`);
  }
  if (fd !== undefined) {
    const real = realOf(fd);
    if (real === undefined || !within(real, projectReal)) {
      closeSync(fd);
      throw new HeldPathRefusal('outside', `${given} is outside the project`);
    }
    hold.fds.push(fd);
    const opened = fstatSync(fd);
    if (opened.isDirectory()) {
      // A folder: the real one, through its handle; every path beneath it goes through `heldPath`.
      const folder: HeldFolder = { fd, root: fdPath(fd), self: fdLink(fd), projectReal, opened: new Map() };
      hold.folders.push(folder);
      return folder.root;
    }
    if (!opened.isFile()) throw new HeldPathRefusal('kind', `${given} is not a file or a folder`);
    const leaf = basename(real);
    // The folder holding it, so the write-back goes through the same checked folder.
    const folderFd = heldFolder(dirname(real), projectReal);
    hold.fds.push(folderFd);
    let there: { dev: number; ino: number } | undefined;
    try { there = lstatSync(join(fdLink(folderFd), leaf)); } catch { there = undefined; }
    if (there === undefined || there.dev !== opened.dev || there.ino !== opened.ino) {
      throw new HeldPathRefusal('changed', `${given} changed while it was checked`);
    }
    lockFile(hold, `${opened.dev}:${opened.ino}`, given);
    // Refused by its length before anything is read.
    hold.budget.bytes += opened.size;
    hold.budget.files += 1;
    if (hold.budget.bytes > HELD_MAX_BYTES || hold.budget.files > HELD_MAX_FILES) {
      throw new HeldPathRefusal('too-big', `${given} is more than one call works on (${HELD_MAX_BYTES / (1024 * 1024)} MiB or ${HELD_MAX_FILES} files in all, a file counted by its length)`);
    }
    const root = mkdtempSync(join(hold.base, 'call-'));
    const copied = copyOpenedFile(fd, join(root, leaf), opened.mode);
    hold.files.push({ root, folderFd, folderReal: dirname(real), named: leaf, copied, original: identityOf(opened), lockKey: `${opened.dev}:${opened.ino}`, projectReal });
    return join(root, leaf);
  }
  // Nothing to open there (yet): a link that leads nowhere is refused; else the nearest folder that exists is held.
  let link = false;
  try { link = lstatSync(given).isSymbolicLink(); } catch { link = false; }
  if (link) throw new HeldPathRefusal('outside', `${given} is a link that leads nowhere`);
  const rest: string[] = [];
  let folder = given;
  let folderFd: number | undefined;
  for (;;) {
    rest.unshift(basename(folder));
    const parent = dirname(folder);
    if (parent === folder) throw new HeldPathRefusal('outside', `${given} is outside the project`);
    folder = parent;
    try {
      folderFd = heldFolder(folder, projectReal);
      break;
    } catch (error) {
      if (error instanceof HeldPathRefusal) throw error;
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new HeldPathRefusal('outside', `${given} cannot be reached`);
    }
  }
  hold.fds.push(folderFd);
  const folderReal = realOf(folderFd)!;
  lockFile(hold, join(folderReal, ...rest), given);
  const root = mkdtempSync(join(hold.base, 'call-'));
  hold.fresh.push({ root, folderFd, folderReal, named: rest.join(sep), projectReal });
  return join(root, ...rest);
}

/** The held folder `path` is in (its handle's path, or this process's own form of it), and the rest of the path. */
function heldFolderOf(hold: CallHold, path: string): { readonly folder: HeldFolder; readonly rest: string[] } | undefined {
  for (const folder of hold.folders) {
    for (const root of [folder.root, folder.self]) {
      if (path === root) return { folder, rest: [] };
      if (path.startsWith(`${root}${sep}`)) return { folder, rest: path.slice(root.length + 1).split(sep).filter((part) => part !== '' && part !== '.') };
    }
  }
  return undefined;
}

/** What a part met inside a held folder is, in words, when it is not a plain file or a folder. */
function partKind(info: { isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean }): string | undefined {
  if (info.isSymbolicLink()) return 'a link';
  if (info.isFIFO()) return 'a FIFO';
  if (info.isSocket()) return 'a socket';
  if (info.isCharacterDevice() || info.isBlockDevice()) return 'a device';
  return undefined;
}

/**
 * A path beneath a held folder, as the handler acts on it: resolved one component at a time from the held folder's
 * handle, each folder on the way opened as `/proc/self/fd/<n>/<name>` without following it (made first when `use` is
 * `write` and it is missing), so a link planted anywhere inside leads nowhere; a link, a FIFO, a device or a socket met
 * on the way, or as the part itself, is refused (`HeldPathRefusal` `kind`). The answer is rooted in an opened handle:
 * `/proc/<pid>/fd/<folder>/<name>` for a file (or one to be made), the folder's own handle for `use: 'folder'`. A file
 * written (`write`) takes its lock for the call. A path held by no call, or not beneath a held folder, is as it is.
 */
export function heldPath(path: string, use: 'read' | 'write' | 'folder' = 'read'): string {
  const hold = calls.getStore();
  if (hold === undefined) return path;
  const found = heldFolderOf(hold, path);
  if (found === undefined) return path;
  const { folder, rest } = found;
  if (rest.some((part) => part === '..')) throw new HeldPathRefusal('outside', `${path} leaves the folder it names`);
  if (rest.length === 0) return folder.root;
  const shown = (upTo: number): string => {
    let real = '';
    try { real = realOf(folder.fd) ?? ''; } catch { real = ''; }
    return join(real || folder.root, ...rest.slice(0, upTo));
  };
  let dirFd = folder.fd;
  let rel = '';
  const steps = use === 'folder' ? rest.length : rest.length - 1;
  for (let index = 0; index < steps; index += 1) {
    const name = rest[index]!;
    rel = rel ? join(rel, name) : name;
    const known = folder.opened.get(rel);
    if (known !== undefined) { dirFd = known; continue; }
    const at = join(fdLink(dirFd), name);
    let info;
    try { info = lstatSync(at); } catch (error) {
      if (errorCode(error) !== 'ENOENT' || use === 'read') return join(fdPath(dirFd), ...rest.slice(index));
      try { mkdirSync(at); } catch (made) { if (errorCode(made) !== 'EEXIST') throw made; }
      info = lstatSync(at);
    }
    const kind = partKind(info);
    if (kind !== undefined) throw new HeldPathRefusal('kind', `${shown(index + 1)} is ${kind}, met inside the folder named; nothing was read or written through it`);
    if (!info.isDirectory()) throw new HeldPathRefusal('kind', `${shown(index + 1)} is not a folder`);
    let next: number;
    try { next = openSync(at, OPEN_FOLDER | constants.O_NOFOLLOW); } catch {
      throw new HeldPathRefusal('changed', `${shown(index + 1)} was changed while this call ran (a link was put in its place)`);
    }
    const real = realOf(next);
    if (real === undefined || !within(real, folder.projectReal)) {
      closeSync(next);
      throw new HeldPathRefusal('outside', `${shown(index + 1)} is no longer inside the project`);
    }
    hold.fds.push(next);
    folder.opened.set(rel, next);
    dirFd = next;
  }
  if (use === 'folder') return fdPath(dirFd);
  const leaf = rest[rest.length - 1]!;
  let info: ReturnType<typeof lstatSync> | undefined;
  try { info = lstatSync(join(fdLink(dirFd), leaf)); } catch { info = undefined; }
  if (info !== undefined) {
    const kind = partKind(info);
    if (kind !== undefined) throw new HeldPathRefusal('kind', `${shown(rest.length)} is ${kind}, met inside the folder named; nothing was read or written through it`);
  }
  if (use === 'write') {
    const key = info !== undefined && info.isFile() ? `${info.dev}:${info.ino}` : join(realOf(dirFd) ?? fdPath(dirFd), leaf);
    lockFile(hold, key, shown(rest.length));
  }
  return join(fdPath(dirFd), leaf);
}

/** Whether `placed` (an answer of `heldPath`) is rooted in a handle this call holds: beneath a held folder. */
function heldRooted(hold: CallHold | undefined, placed: string): boolean {
  if (hold === undefined) return false;
  return hold.fds.some((fd) => placed.startsWith(`${fdPath(fd)}${sep}`) || placed.startsWith(`${fdLink(fd)}${sep}`));
}

/** One file a handler writes: where (as the handler names it), what, and the mode a new file gets. */
export interface HeldWrite {
  readonly path: string;
  readonly data: string | Uint8Array;
  /** A new file's mode (default 0o644); a file written over keeps its own. */
  readonly mode?: number | undefined;
  /** Only a new file: whatever is at its name (a file, or a link put there this instant) is left as it is and the write refused (EEXIST). */
  readonly exclusive?: boolean | undefined;
}

/**
 * THE way every handler of a path capability writes a file (a file beneath a held folder, a held file's copy, a file to
 * be made, or a path held by no call); no handler writes one by plain path. Beneath a held folder the file is resolved
 * through `heldPath` (`write`: folders on the way opened without following a link, its lock taken), its content
 * written under a pending name of this call's own INSIDE that opened, checked folder (made exclusively, never through
 * a link) and renamed onto its own name: a link swapped in at the file's own name at any instant, even between the
 * check and the write, is replaced by the file, never followed, and gains nothing. A file written over keeps its mode.
 * Several files are all written beside their places first and then each renamed into place; one that cannot be
 * written beside its place leaves no pending name and none of them placed (a rename refused part way, by a folder put
 * at a file's name, stops there and says so). A path not beneath a held folder (this call's own copy or
 * staging, which the call puts into the project itself by rename; or a path the person named, held by no call) is
 * written as it is. The paths written, as the handler acts on them.
 */
export function writeHeldFiles(writes: readonly HeldWrite[]): string[] {
  const hold = calls.getStore();
  const placed = writes.map((write) => ({ write, at: heldPath(write.path, 'write') }));
  const plain = placed.filter((entry) => !heldRooted(hold, entry.at));
  const held = placed.filter((entry) => heldRooted(hold, entry.at));
  const pending: { readonly dir: string; readonly name: string; readonly leaf: string; readonly shown: string; readonly exclusive: boolean }[] = [];
  try {
    for (const { write, at } of held) {
      const dir = dirname(at);
      const leaf = basename(at);
      let mode = write.mode ?? 0o644;
      let there: Stats | undefined;
      try { there = lstatSync(at); } catch { there = undefined; }
      if (there !== undefined && there.isFile()) mode = there.mode & 0o7777;
      const name = `${PENDING}${randomUUID()}`;
      const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      pending.push({ dir, name, leaf, shown: write.path, exclusive: write.exclusive === true });
      try {
        const content = typeof write.data === 'string' ? Buffer.from(write.data, 'utf-8') : write.data;
        let put = 0;
        while (put < content.length) put += writeSync(fd, content, put, content.length - put);
        if (there !== undefined && there.isFile()) fchmodSync(fd, mode);
      } finally {
        closeSync(fd);
      }
    }
    while (pending.length > 0) {
      const part = pending[0]!;
      try {
        if (part.exclusive) {
          // link(2) makes the name only when nothing is there (a link put there included, never followed): EEXIST.
          linkSync(join(part.dir, part.name), join(part.dir, part.leaf));
          unlinkSync(join(part.dir, part.name));
        } else {
          // rename(2) replaces the name itself: whatever is at the file's own name now (the file, or a link swapped in
          // this instant) is replaced, and nothing it points to is touched.
          renameSync(join(part.dir, part.name), join(part.dir, part.leaf));
        }
      } catch (error) {
        if (part.exclusive && errorCode(error) === 'EEXIST') throw Object.assign(new Error(`${part.shown} is already there and was left as it is; nothing more was written`), { code: 'EEXIST' });
        throw new HeldPathRefusal('changed', `${part.shown} could not be put in place (${errorCode(error) === 'EISDIR' || errorCode(error) === 'ENOTEMPTY' ? 'a folder is there' : errorCode(error) ?? 'error'}); nothing more was written`);
      }
      pending.shift();
    }
  } finally {
    for (const part of pending) { try { unlinkSync(join(part.dir, part.name)); } catch { /* gone */ } }
  }
  for (const { write, at } of plain) {
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, write.data, { mode: write.mode ?? 0o644, ...(write.exclusive === true ? { flag: 'wx' } : {}) });
  }
  return placed.map((entry) => entry.at);
}

/** One file written the one way (`writeHeldFiles`); the path written, as the handler acts on it. */
export function writeHeldFile(path: string, data: string | Uint8Array, mode?: number, exclusive?: boolean): string {
  return writeHeldFiles([{ path, data, mode, exclusive }])[0]!;
}

/**
 * THE way a handler reads a file beneath a held folder: resolved through `heldPath` and opened without following a
 * link, so a link swapped in at the file's own name after the check is refused (`HeldPathRefusal` `kind`), never read
 * through; only a plain file. A path not beneath a held folder is read as it is.
 */
export function readHeldFile(path: string): Buffer;
export function readHeldFile(path: string, encoding: 'utf-8' | 'utf8'): string;
export function readHeldFile(path: string, encoding?: 'utf-8' | 'utf8'): Buffer | string {
  const at = heldPath(path, 'read');
  if (!heldRooted(calls.getStore(), at)) return encoding ? readFileSync(at, encoding) : readFileSync(at);
  let fd: number;
  try {
    fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw new HeldPathRefusal('kind', `${shownPath(at)} is a link, met inside the folder named; nothing was read through it`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new HeldPathRefusal('kind', `${shownPath(at)} is not a plain file; nothing was read`);
    const buffer = Buffer.alloc(info.size);
    let got = 0;
    while (got < buffer.length) {
      const read = readSync(fd, buffer, got, buffer.length - got, got);
      if (read === 0) break;
      got += read;
    }
    const content = buffer.subarray(0, got);
    return encoding ? content.toString('utf-8') : content;
  } finally {
    closeSync(fd);
  }
}

/** One part of the commit: written beside its place first (`pending`), then renamed into place. */
interface PendingPart {
  readonly dirFd: number;
  readonly name: string;
  readonly pending: string;
  /** A held file written back: its identity when its copy was taken (it must still be that). */
  readonly over?: FileIdentity | undefined;
  readonly shown: string;
}

/** What the commit did, so a failure part-way puts the project back as it was. */
interface CommitLog {
  readonly madeFolders: { readonly dirFd: number; readonly name: string }[];
  readonly parts: PendingPart[];
  readonly openedFds: number[];
}

/** Write `from`'s content beside its place in `intoFd` under a pending name; the part, or a refusal. */
function preparePart(from: string, intoFd: number, name: string, projectReal: string, shown: string, over: FileIdentity | undefined, refusals: string[], log: CommitLog): void {
  const info = lstatSync(from);
  const pending = `${PENDING}${randomUUID()}`;
  let fileFd: number;
  try {
    fileFd = openSync(join(fdLink(intoFd), pending), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, info.mode & 0o777);
  } catch {
    refusals.push(`${shown} could not be written`);
    return;
  }
  let refused = false;
  try {
    const real = realOf(fileFd);
    if (real === undefined || !within(real, projectReal)) { refusals.push(`${shown} is no longer inside the project`); refused = true; return; }
    const content = readFileSync(from);
    let at = 0;
    while (at < content.length) at += writeSync(fileFd, content, at, content.length - at);
  } finally {
    closeSync(fileFd);
    // A part refused here leaves nothing of it beside its place.
    if (refused) { try { unlinkSync(join(fdLink(intoFd), pending)); } catch { /* gone */ } }
  }
  log.parts.push({ dirFd: intoFd, name, pending, ...(over ? { over } : {}), shown });
}

/**
 * Step one for what the handler made in this call's own folder: every part written beside its place, each folder on the
 * way opened without following a link (made when missing) and checked inside the project.
 */
function prepareFresh(stagedDir: string, intoFd: number, rel: string, projectReal: string, shownBase: string, refusals: string[], log: CommitLog): void {
  for (const name of readdirSync(stagedDir)) {
    const from = join(stagedDir, name);
    const relName = rel ? join(rel, name) : name;
    const shown = join(shownBase, relName);
    const info = lstatSync(from);
    if (info.isDirectory()) {
      let made = false;
      try { mkdirSync(join(fdLink(intoFd), name)); made = true; } catch (error) {
        if (errorCode(error) !== 'EEXIST') { refusals.push(`${shown} could not be made`); continue; }
      }
      let childFd: number;
      try {
        childFd = openSync(join(fdLink(intoFd), name), OPEN_FOLDER | constants.O_NOFOLLOW);
      } catch {
        refusals.push(`${shown} was changed while this call ran (a link was put in its place)`);
        continue;
      }
      log.openedFds.push(childFd);
      if (made) log.madeFolders.push({ dirFd: intoFd, name });
      const real = realOf(childFd);
      if (real === undefined || !within(real, projectReal)) { refusals.push(`${shown} is no longer inside the project`); continue; }
      prepareFresh(from, childFd, relName, projectReal, shownBase, refusals, log);
      continue;
    }
    if (!info.isFile()) {
      refusals.push(`${shown} is ${info.isSymbolicLink() ? 'a link' : info.isFIFO() ? 'a FIFO' : 'not a plain file'}, so nothing was written`);
      continue;
    }
    preparePart(from, intoFd, name, projectReal, shown, undefined, refusals, log);
  }
}

/** Undo step one: every pending part removed, every folder this commit made removed (deepest first). */
function undoPrepared(log: CommitLog): void {
  for (const part of log.parts) { try { unlinkSync(join(fdLink(part.dirFd), part.pending)); } catch { /* gone */ } }
  for (const folder of [...log.madeFolders].reverse()) { try { rmdirSync(join(fdLink(folder.dirFd), folder.name)); } catch { /* not empty, or gone */ } }
}

/**
 * Step two: each pending part renamed into its place. A held file written back must still be as its copy was taken
 * (else refused: another writer changed it meanwhile); the file it replaces is renamed aside first and put back if a
 * later part fails. A new file's place must still be empty. On any failure everything done is undone.
 */
function placeParts(log: CommitLog): string[] {
  const done: { readonly part: PendingPart; readonly aside?: string }[] = [];
  const fail = (why: string): string[] => {
    for (const step of [...done].reverse()) {
      try {
        if (step.aside) renameSync(join(fdLink(step.part.dirFd), step.aside), join(fdLink(step.part.dirFd), step.part.name));
        else unlinkSync(join(fdLink(step.part.dirFd), step.part.name));
      } catch { /* best effort, said below */ }
    }
    undoPrepared(log);
    return [why];
  };
  for (const part of log.parts) {
    const place = join(fdLink(part.dirFd), part.name);
    let there: ReturnType<typeof lstatSync> | undefined;
    try { there = lstatSync(place); } catch { there = undefined; }
    try {
      if (part.over !== undefined) {
        // Only a plain file is written over; a link put in its place meanwhile is never replaced or followed.
        if (there !== undefined && !there.isFile()) return fail(`${part.shown} was changed while this call ran (a link was put in its place), so nothing was written`);
        if (there === undefined || !sameIdentity(identityOf(there), part.over)) {
          return fail(`${part.shown} changed while this call ran (another writer), so nothing was written: writing now would replace that change`);
        }
        const aside = `${PENDING}aside-${randomUUID()}`;
        renameSync(place, join(fdLink(part.dirFd), aside));
        renameSync(join(fdLink(part.dirFd), part.pending), place);
        done.push({ part, aside });
      } else {
        if (there !== undefined) return fail(`${part.shown} was not written: something is already there and was left as it is, so nothing was written`);
        renameSync(join(fdLink(part.dirFd), part.pending), place);
        done.push({ part });
      }
    } catch (error) {
      return fail(`${part.shown} could not be put in place (${errorCode(error) ?? 'error'}), so nothing was written`);
    }
  }
  for (const step of done) { if (step.aside) { try { unlinkSync(join(fdLink(step.part.dirFd), step.aside)); } catch { /* gone */ } } }
  return [];
}

function commit(hold: CallHold): string[] {
  const refusals: string[] = [];
  const log: CommitLog = { madeFolders: [], parts: [], openedFds: [] };
  try {
    for (const staged of hold.files) {
      const copy = join(staged.root, staged.named);
      let now: ReturnType<typeof lstatSync> | undefined;
      try { now = lstatSync(copy); } catch { now = undefined; }
      // Left as it was copied (or removed in the copy): nothing to write back.
      if (now === undefined || !now.isFile() || sameIdentity(identityOf(now), staged.copied)) continue;
      let shownBase = staged.folderReal;
      try { shownBase = realOf(staged.folderFd) ?? shownBase; } catch { /* closed */ }
      preparePart(copy, staged.folderFd, staged.named, staged.projectReal, join(shownBase, staged.named), staged.original, refusals, log);
    }
    for (const staged of hold.fresh) {
      if (!existsSync(staged.root) || readdirSync(staged.root).length === 0) continue;
      if (staged.folderFd === undefined) { refusals.push(`${staged.folderReal} is outside the project; nothing was written there`); continue; }
      // Named where the held folder is now (renamed meanwhile or not).
      let shownBase = staged.folderReal;
      try { shownBase = realOf(staged.folderFd) ?? shownBase; } catch { /* closed */ }
      prepareFresh(staged.root, staged.folderFd, '', staged.projectReal, shownBase, refusals, log);
    }
    if (refusals.length > 0) { undoPrepared(log); return refusals; }
    return placeParts(log);
  } catch (error) {
    undoPrepared(log);
    return [`what the call made could not be put in the project (${error instanceof Error ? error.message : String(error)}), so nothing was written`];
  } finally {
    for (const fd of log.openedFds) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/** Words that name a held path, as the project's file: never this call's own folder or a handle. */
function shownWith(hold: CallHold): (text: string) => string {
  const now = (fd: number | undefined, fallback: string): string => {
    if (fd === undefined) return fallback;
    try { return realOf(fd) ?? fallback; } catch { return fallback; }
  };
  const pairs: [string, string][] = [
    ...hold.fresh.map((staged): [string, string] => [staged.root, now(staged.folderFd, staged.folderReal)]),
    ...hold.files.map((staged): [string, string] => [staged.root, now(staged.folderFd, staged.folderReal)]),
  ];
  for (const fd of hold.fds) {
    try { const real = realOf(fd); if (real !== undefined) pairs.push([fdPath(fd), real], [fdLink(fd), real]); } catch { /* closed */ }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of pairs) {
      if (!out.includes(from)) continue;
      out = out.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'g'), to);
    }
    return out;
  };
}

function shownValue(value: unknown, shown: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return shown(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => shownValue(item, shown, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shownValue(item, shown, depth + 1)]));
}

function release(hold: CallHold): void {
  for (const staged of [...hold.files, ...hold.fresh]) rmSync(staged.root, { recursive: true, force: true });
  for (const fd of hold.fds) { try { closeSync(fd); } catch { /* closed */ } }
  hold.fds.length = 0;
  for (const key of hold.locks) { if (fileLocks.get(key) === hold) fileLocks.delete(key); }
  hold.locks.clear();
}

/** Make the error a handler threw name the project's files; a refusal stays a refusal of the same kind. */
export type ShownError = (error: unknown, shown: (text: string) => string) => unknown;

/**
 * Run one call with every path it names held (see the file's comment): what it made or changed in a copy is put into
 * the project when it ends well, its words name the project's files, and its folder, handles and file locks are let go
 * whatever came of it. A call inside a call shares the outer one's hold. `refusal` builds the door's refusal from a
 * sentence. `stagingBase`: where its own copies are kept (`<daemon home>/held` for the daemon; the program's
 * `~/.goodvibes/held` when not given).
 */
export async function holdingCallerPaths<T>(run: () => Promise<T>, options: {
  readonly shownError?: ShownError;
  readonly refusal: (message: string) => Error;
  readonly stagingBase?: string | undefined;
}): Promise<T> {
  if (calls.getStore() !== undefined) return run();
  const hold: CallHold = { fds: [], files: [], fresh: [], folders: [], base: holdable() ? stagingBaseOf(options.stagingBase) : '', budget: { bytes: 0, files: 0 }, locks: new Set() };
  try {
    let result: T;
    try {
      result = await calls.run(hold, run);
    } catch (error) {
      const shown = shownWith(hold);
      throw options.shownError ? options.shownError(error, shown) : error;
    }
    const shown = shownWith(hold);
    const refusals = commit(hold);
    if (refusals.length > 0) throw options.refusal(`${refusals.join('; ')}.`);
    return shownValue(result, shown) as T;
  } finally {
    release(hold);
  }
}

/**
 * A held path as the project's file, for what a handler keeps (a record, a log line) rather than says: the call's own
 * folder is gone when it ends. A path held by no call is as it is.
 */
export function shownPath(path: string): string {
  const hold = calls.getStore();
  return hold === undefined ? path : shownWith(hold)(path);
}

/** Whether `path` is one this call holds (placed and checked already: nothing places it again). */
export function isHeldPath(path: string): boolean {
  const hold = calls.getStore();
  if (hold === undefined) return false;
  if ([...hold.files, ...hold.fresh].some((staged) => path === staged.root || path.startsWith(`${staged.root}${sep}`))) return true;
  return heldFolderOf(hold, path) !== undefined;
}

/**
 * A copy of a held file for a program started on it (a browser opening an export): the program is never handed the
 * daemon's or this program's `/proc/<pid>/fd` path, and the project's path could be a link by the time it reads it, so
 * it reads exactly what was written, in a folder of its own beside the call's (removed with the others once its
 * lifetime has passed). A path not held is as it is.
 */
export function copyForProgram(path: string): string {
  const hold = calls.getStore();
  if (hold === undefined || !isHeldPath(path)) return path;
  const folder = mkdtempSync(join(hold.base, 'open-'));
  const copy = join(folder, basename(path));
  const fd = openSync(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const content = readHeldFile(path);
    let at = 0;
    while (at < content.length) at += writeSync(fd, content, at, content.length - at);
  } finally {
    closeSync(fd);
  }
  return copy;
}

/** The descriptor number a program started on a held folder finds it at (`heldForChild`). */
export const CHILD_HELD_FD = 3;

/**
 * A held folder, or a path beneath one, as a program the handler starts reaches it: never by the daemon's own
 * `/proc/<pid>/fd/<n>` path, which another process would read through the daemon's handle table (every handle the
 * daemon holds, not only this one). The folder is opened here one component at a time without following a link
 * (`heldPath`), and the program inherits that opened descriptor itself as its descriptor `CHILD_HELD_FD` (pass
 * `inherit` there: `stdio: ['pipe', 'pipe', 'pipe', inherit]`), and is told `/proc/self/fd/3/<rest>`, its own process's
 * handle. A path held by no call (a call's own copy, or a path not held at all) is as it is, with nothing to inherit.
 */
export function heldForChild(path: string): { readonly path: string; readonly inherit?: number } {
  const hold = calls.getStore();
  if (hold === undefined || heldFolderOf(hold, path) === undefined) return { path };
  // The deepest folder of the path that exists, opened without following; the rest (a file, or one to be made) after it.
  const placed = heldPath(path, 'read');
  const prefix = `/proc/${process.pid}/fd/`;
  if (!placed.startsWith(prefix)) return { path };
  const [fdText, ...rest] = placed.slice(prefix.length).split(sep);
  const fd = Number(fdText);
  if (!Number.isInteger(fd) || !hold.fds.includes(fd)) return { path };
  // A folder named whole: its own handle (heldPath gives the folder's handle for a folder that is the held one).
  let inherit = fd;
  let tail = rest;
  if (tail.length > 0) {
    try {
      const info = lstatSync(join(fdLink(fd), ...tail));
      if (info.isDirectory()) {
        const folderPlaced = heldPath(path, 'folder');
        const folderFd = Number(folderPlaced.slice(prefix.length).split(sep)[0]);
        if (Number.isInteger(folderFd) && hold.fds.includes(folderFd)) { inherit = folderFd; tail = []; }
      }
    } catch { /* not there yet: named beneath its nearest folder */ }
  }
  return { path: join(`/proc/self/fd/${CHILD_HELD_FD}`, ...tail), inherit };
}

/** Whether a call holding paths is running here. */
export const holdingPaths = (): boolean => calls.getStore() !== undefined;

/** What reading a project's file came to: its text, nothing there, or why it was not read. */
export type ProjectFileReading =
  | { readonly kind: 'read'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * One file of a project read the way a held path is (the same rule as `holdCallerPath`): opened first and judged by
 * where the opened file really is, so a link out of the project (to a key, a token file, another project) is refused
 * whatever it is renamed to around the read; only a plain file; at most `maxBytes` read (a larger or sparse file is
 * refused by its length, never read whole), its text cut to `maxChars`. For a file read into a model's prompt
 * (utils/prompt-loader.ts, terminal-shell project-context-files.ts).
 */
export function readProjectFile(path: string, projectRoot: string, limits: { readonly maxBytes: number; readonly maxChars: number }): ProjectFileReading {
  let rootReal: string;
  try { rootReal = realpathSync(projectRoot); } catch { return { kind: 'refused', reason: 'its project folder could not be read' }; }
  let fd: number;
  try {
    fd = openSync(path, OPEN_TARGET);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'refused', reason: code === 'ELOOP' ? 'it is a link that leads nowhere' : 'it could not be opened' };
  }
  try {
    const real = holdable() ? realOf(fd) : (() => { try { return realpathSync(path); } catch { return undefined; } })();
    if (real === undefined || !within(real, rootReal)) return { kind: 'refused', reason: 'it is a link that leads out of the project, so nothing of it was read' };
    const info = fstatSync(fd);
    if (!info.isFile()) return { kind: 'refused', reason: 'it is not a plain file' };
    if (info.size > limits.maxBytes) return { kind: 'refused', reason: `it is ${info.size} bytes, over the ${limits.maxBytes} byte limit` };
    const buffer = Buffer.alloc(info.size);
    let at = 0;
    while (at < buffer.length) {
      const got = readSync(fd, buffer, at, buffer.length - at, at);
      if (got === 0) break;
      at += got;
    }
    const text = buffer.subarray(0, at).toString('utf8');
    return text.length > limits.maxChars ? { kind: 'read', text: text.slice(0, limits.maxChars), truncated: true } : { kind: 'read', text, truncated: false };
  } finally {
    closeSync(fd);
  }
}
