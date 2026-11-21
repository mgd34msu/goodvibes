/** Captured native update I/O. */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * What a staged file is written from: bytes held in memory (claims, receipts,
 * small generated files), or a release file the update downloaded to its
 * private download directory, copied into the stage in pieces so a release of
 * several hundred megabytes is never held in memory whole. A downloaded file
 * carries the size and SHA-256 that were verified against the release as it
 * arrived; every later read of it is held to both.
 */
export type UpdatePayload = Buffer | { readonly file: string; readonly size: number; readonly sha256: string };

const COPY_CHUNK_BYTES = 1 << 20;

const DOWNLOAD_CHANGED = 'Native update download changed before it was staged';

/** The whole payload in memory: for the small files that are parsed, and for adapters that write only bytes. */
export function updatePayloadBytes(payload: UpdatePayload): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  const bytes = readFileSync(payload.file);
  if (bytes.byteLength !== payload.size || createHash('sha256').update(bytes).digest('hex') !== payload.sha256) throw new Error(DOWNLOAD_CHANGED);
  return bytes;
}

function updatePayloadSize(payload: UpdatePayload): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : payload.size;
}

/**
 * Copy a downloaded file into an open descriptor in pieces, hashing what is
 * copied, and refuse when the copy is not the verified download (size and
 * SHA-256), so a stage is only ever the bytes that matched the release.
 */
function copyVerifiedFileInto(fd: number, source: { readonly file: string; readonly size: number; readonly sha256: string }): void {
  const from = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES), hash = createHash('sha256');
    let copied = 0;
    for (let read = readSync(from, chunk, 0, chunk.length, null); read > 0; read = readSync(from, chunk, 0, chunk.length, null)) {
      hash.update(chunk.subarray(0, read));
      for (let offset = 0; offset < read;) offset += writeSync(fd, chunk, offset, read - offset);
      copied += read;
    }
    if (copied !== source.size || hash.digest('hex') !== source.sha256) throw new Error(DOWNLOAD_CHANGED);
  } finally { closeSync(from); }
}

/** The SHA-256 and size of a file, read in pieces. */
export function digestUpdateFile(path: string): { readonly sha256: string; readonly size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let size = 0;
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) {
      hash.update(chunk.subarray(0, read)); size += read;
    }
    return { sha256: hash.digest('hex'), size };
  } finally { closeSync(fd); }
}

const DOWNLOAD_DIRECTORY = /^\.update-fetch-(\d+)-/;

/**
 * A private directory (mode 0700) in `parent` that one update downloads its
 * release files into before staging them; the caller removes it when the
 * update ends. Directories left by an update whose process is gone are
 * removed first. `parent` is the installation directory, so the download
 * lives on the disk it is installed to rather than in memory.
 */
export function createUpdateDownloadDirectory(parent: string): string {
  for (const name of readdirSync(parent)) {
    const holder = Number(DOWNLOAD_DIRECTORY.exec(name)?.[1] ?? 0);
    if (!Number.isSafeInteger(holder) || holder <= 0 || holder === process.pid) continue;
    try { process.kill(holder, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    rmSync(join(parent, name), { recursive: true, force: true });
  }
  return mkdtempSync(join(parent, `.update-fetch-${process.pid}-`));
}

/**
 * Injectable filesystem surface. Existing adapters remain source compatible,
 * but mutations fail closed until they implement exclusive claims and cleanup.
 * rename must either succeed or throw without changing either path. Install
 * directories must be trusted: unrelated writers and parent symlink changes
 * cannot be fenced by this interface.
 */
export interface UpdateFileIo {
  writeFile(path: string, data: Buffer): void;
  rename(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
  /** Atomically create a file, failing without modifying it if it already exists. */
  writeExclusive?(path: string, data: Buffer): void;
  /** Remove an owned file; a missing file is a successful no-op. */
  remove?(path: string): void;
  /** Native cohorts require exact bytes and physical file/parent observations. */
  readFile?(path: string): Buffer;
  /** Null means absent. Reject symlinks and non-regular payloads. */
  observe?(path: string): { readonly identity: string; readonly ownerIdentity: string; readonly mode: number } | null;
}

export const realUpdateFileIo: UpdateFileIo = {
  writeFile: (path, data) => writeFileSync(path, data),
  writeExclusive: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  chmod: (path, mode) => chmodSync(path, mode),
  // lstat sees dangling symlinks too; they must never be mistaken for empty slots.
  exists: (path) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  remove: (path) => {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  },
  readFile: (path) => readFileSync(path),
  observe: (path) => {
    const parents: string[] = [];
    for (let current = dirname(path);;) {
      try {
        const stat = lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native update directory is not a retained regular directory');
        parents.push(`${current}:${realpathSync(current)}:${stat.dev}:${stat.ino}`);
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native update payload is not a regular file');
      return { identity: `${parents.join('|')}:${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}`,
        ownerIdentity: `${stat.dev}:${stat.ino}`, mode: Number(stat.mode & 0o777n) };
    } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  },
};

/** The slots an update keeps beside a target while it runs. */
export const UPDATE_TRANSIENT_SLOT_SUFFIXES = ['.update-download', '.update-previous', '.rollback-exchange'] as const;
/** The claim an update or install holds beside each target while it runs. */
export const UPDATE_CLAIM_SUFFIX = '.update-transaction';
const TRANSIENT_SLOT_SUFFIXES = UPDATE_TRANSIENT_SLOT_SUFFIXES;
const CLAIM_SUFFIX = UPDATE_CLAIM_SUFFIX;

/** The files an update or install keeps beside a target while it runs: its claim and its transient slots. */
export const UPDATE_TRANSACTION_SUFFIXES: readonly string[] = Object.freeze([CLAIM_SUFFIX, ...TRANSIENT_SLOT_SUFFIXES]);

/**
 * Release the claims of an update whose process is gone when nothing partial
 * remains. An update renames only after staging every target, and keeps a
 * download or saved-previous slot beside a target until the whole cohort is in
 * place, so with no slot beside any target it named it either renamed nothing
 * or finished every rename: the installed files are whole. That is the rule
 * the installer applies to an abandoned claim too. A rollback (no slot between
 * targets), a recovery fence (written by a transaction that already failed),
 * a live or unknown holder, or a claim this module did not write is left for
 * inspection. Returns true when the claim at `claimPath` was released.
 */
export function releaseAbandonedUpdateClaim(claimPath: string, io: UpdateFileIo = realUpdateFileIo): boolean {
  if (!claimPath.endsWith(CLAIM_SUFFIX) || !io.readFile || !io.remove) return false;
  let claim: { readonly pid: number; readonly startedAt: number; readonly targets: readonly string[] };
  try {
    const raw = io.readFile(claimPath);
    if (raw.byteLength > 64 * 1024) return false;
    const parsed = JSON.parse(raw.toString('utf8')) as { operation?: unknown; pid?: unknown; startedAt?: unknown; fenced?: unknown; targets?: unknown };
    if (parsed.operation !== 'update' || parsed.fenced === true) return false;
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || parsed.pid === process.pid) return false;
    if (typeof parsed.startedAt !== 'number') return false;
    const named = Array.isArray(parsed.targets) ? parsed.targets.map((entry) => (entry as { target?: unknown } | null)?.target) : [];
    const ownTarget = claimPath.slice(0, -CLAIM_SUFFIX.length);
    const targets = [...new Set([ownTarget, ...named.filter((target): target is string => typeof target === 'string' && isAbsolute(target))])];
    claim = { pid: parsed.pid, startedAt: parsed.startedAt, targets };
  } catch { return false; }
  try { process.kill(claim.pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  for (const target of claim.targets) for (const suffix of TRANSIENT_SLOT_SUFFIXES) if (io.exists(target + suffix)) return false;
  for (const target of claim.targets) {
    const sibling = target + CLAIM_SUFFIX;
    try {
      const raw = io.readFile(sibling);
      const parsed = JSON.parse(raw.toString('utf8')) as { pid?: unknown; startedAt?: unknown; fenced?: unknown };
      if (parsed.pid === claim.pid && parsed.startedAt === claim.startedAt && parsed.fenced !== true) io.remove(sibling);
    } catch { /* Absent, foreign or unreadable: not this transaction's claim. */ }
  }
  return !io.exists(claimPath);
}

/**
 * Whether an adapter reads bytes and observes file identities, so native
 * update paths hold files to their file-system identity (the rule
 * `retainNativeUpdateSources` states) and use the cross-process lock and the
 * retained-directory checks. One rule for every adapter: the daemon and the
 * updaters pass `realUpdateFileIo`; an adapter is composition input, trusted
 * like the rest of it.
 */
export function observesUpdateFiles(io: Pick<UpdateFileIo, 'readFile' | 'observe'>): boolean {
  return io.readFile !== undefined && io.observe !== undefined;
}

/** Capture adapter methods before asynchronous caller preparation can replace them. */
export function captureUpdateFileIo(io: UpdateFileIo): UpdateFileIo {
  const readFile = io.readFile, observe = io.observe;
  return {
    writeFile: io.writeFile.bind(io), rename: io.rename.bind(io), chmod: io.chmod.bind(io),
    exists: io.exists.bind(io), mkdir: io.mkdir.bind(io),
    ...(io.writeExclusive ? { writeExclusive: io.writeExclusive.bind(io) } : {}),
    ...(io.remove ? { remove: io.remove.bind(io) } : {}),
    ...(readFile ? { readFile: readFile.bind(io) } : {}),
    ...(observe ? { observe: observe.bind(io) } : {}),
  };
}


export interface NativeUpdateDirectoryOwner {
  /** Physical ownership only; ordinary child/file changes are expected. */
  assertCurrent(): void;
  /** Create only originally missing selected directory levels. No aliases or
   * post-capture foreign directories can be adopted. */
  ensure(path?: string): void;
}
/** Capture the original physical root and all selected child parents before
 * async update preparation. This performs no mkdir or other publication. */
export function retainNativeUpdateDirectory(directory: string, childDirectories: readonly string[] = []): NativeUpdateDirectoryOwner {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Native update directory must be absolute and normalized');
  const selected = new Set([directory, ...childDirectories]), expected = new Map<string, string | null>();
  const stamp = (path: string): string | null => {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native update ancestor is not an original physical directory');
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
  };
  const ancestry = (path: string): string[] => {
    const paths: string[] = [];
    for (let current = path;; current = dirname(current)) { paths.push(current); if (dirname(current) === current) break; }
    return paths.reverse();
  };
  for (const path of selected) {
    const within = relative(directory, path);
    if (!isAbsolute(path) || resolve(path) !== path || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Native update directory is outside its selected root');
    for (const parent of ancestry(path)) {
      const value = stamp(parent);
      if (expected.has(parent) && expected.get(parent) !== value) throw new Error('Native update directory changed during capture');
      expected.set(parent, value);
    }
  }
  const assertCurrent = () => { for (const [path, value] of expected) if (stamp(path) !== value) throw new Error('Native update original directory changed'); };
  assertCurrent();
  return Object.freeze({ assertCurrent, ensure(path = directory): void {
    if (!selected.has(path)) throw new Error('Native update directory was not originally selected');
    assertCurrent();
    for (const parent of ancestry(path)) {
      if (expected.get(parent) !== null) continue;
      assertCurrent(); mkdirSync(parent, { mode: 0o700 });
      const created = lstatSync(parent, { bigint: true });
      expected.set(parent, stamp(parent));
      // Do not inspect still-missing descendants under an umask-created mode0
      // directory until its original creator has restored owner access.
      for (const [known, value] of expected) if (value !== null && stamp(known) !== value) throw new Error('Native update created parent changed');
      if ((created.mode & 0o700n) !== 0o700n) {
        chmodSync(parent, Number(created.mode & 0o7777n) | 0o700);
        const after = lstatSync(parent, { bigint: true });
        if (after.dev !== created.dev || after.ino !== created.ino) throw new Error('Native update created directory changed');
        expected.set(parent, stamp(parent));
      }
      assertCurrent();
    }
    assertCurrent();
  } });
}


export interface OwnedNativeUpdateFile {
  assertAt(path: string): void;
  renamed(from: string, to: string): void;
  removeAt(path: string): void;
  close(): void;
}
/** Native creator proof for a claim or stage. The original descriptor remains
 * open until cleanup/transaction completion. Unknown colliding paths are never
 * truncated, adopted, chmodded or removed. No content digest/readback is needed. */
export function createOwnedNativeUpdateFile(path: string, data: UpdatePayload, mode: number, assertDirectory: () => void): OwnedNativeUpdateFile {
  assertDirectory();
  let fd: number | undefined, selected = path;
  let expected: BigIntStats | undefined;
  const stamp = (stat: BigIntStats, rename = false): string => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Native update source is not an original regular file');
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, ...(rename ? [] : [stat.ctimeNs]), stat.birthtimeNs].join(':');
  };
  const close = () => { if (fd !== undefined) { const original = fd; fd = undefined; closeSync(original); } };
  const current = (path: string, renamed = false) => {
    assertDirectory();
    if (fd === undefined || !expected) throw new Error('Native update creator is closed');
    const descriptor = fstatSync(fd, { bigint: true }), file = lstatSync(path, { bigint: true });
    if (stamp(descriptor, renamed) !== stamp(expected, renamed) || stamp(file) !== stamp(descriptor)) throw new Error('Native update source changed');
    return descriptor;
  };
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    expected = fstatSync(fd, { bigint: true }); current(path);
    if (Buffer.isBuffer(data)) writeFileSync(fd, data);
    else copyVerifiedFileInto(fd, data);
    fchmodSync(fd, mode); fsyncSync(fd);
    expected = fstatSync(fd, { bigint: true });
    if (expected.size !== BigInt(updatePayloadSize(data)) || (expected.mode & 0o7777n) !== BigInt(mode)) throw new Error('Native update stage did not finish');
    current(path);
    return Object.freeze({
      assertAt(path: string) { if (path !== selected) throw new Error('Native update selected source changed'); current(path); },
      renamed(from: string, to: string) {
        if (from !== selected) throw new Error('Native update rename source changed');
        expected = current(to, true); selected = to;
      },
      removeAt(path: string) { if (path !== selected) throw new Error('Native update cleanup source changed'); current(path); unlinkSync(path); close(); },
      close,
    });
  } catch (error) {
    // fd creation failure supplies no ownership. A replaced source/parent is
    // foreign even when our original descriptor is still open.
    if (fd !== undefined && expected) {
      try {
        assertDirectory();
        const descriptor = fstatSync(fd, { bigint: true }), file = lstatSync(path, { bigint: true });
        const original = expected;
        const owned = (value: BigIntStats) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && value.dev === original.dev && value.ino === original.ino && value.uid === original.uid && value.gid === original.gid && value.birthtimeNs === original.birthtimeNs;
        if (owned(descriptor) && owned(file)) unlinkSync(path);
      } catch { /* Retain unknown/foreign evidence. */ }
    }
    try { close(); } catch { /* Preserve the original creation failure. */ }
    throw error;
  }
}
