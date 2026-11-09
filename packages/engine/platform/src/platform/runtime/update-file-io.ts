/** Captured native update I/O and private physical-observation provenance. */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

// Only these actual OS readers and captures made here can certify physical
// revisions. Neither Object.freeze nor a custom adapter's metadata is proof.
const nativeReadFile = realUpdateFileIo.readFile, nativeObserve = realUpdateFileIo.observe;
const nativeObservations = new WeakMap<UpdateFileIo, {
  readonly readFile: UpdateFileIo['readFile']; readonly observe: UpdateFileIo['observe'];
}>();
function ownsNativeObservations(io: UpdateFileIo, readFile: UpdateFileIo['readFile'], observe: UpdateFileIo['observe']): boolean {
  if (readFile === nativeReadFile && observe === nativeObserve) return true;
  const owned = nativeObservations.get(io);
  return owned !== undefined && owned.readFile === readFile && owned.observe === observe;
}
/** Internal provenance check. There is no exported registration/mint operation. */
export function hasNativeUpdateObservations(io: UpdateFileIo, readFile: UpdateFileIo['readFile'], observe: UpdateFileIo['observe']): boolean {
  return ownsNativeObservations(io, readFile, observe);
}

/** Capture adapter methods before asynchronous caller preparation can replace them. */
export function captureUpdateFileIo(io: UpdateFileIo): UpdateFileIo {
  const readFile = io.readFile, observe = io.observe;
  const native = ownsNativeObservations(io, readFile, observe);
  const captured: UpdateFileIo = {
    writeFile: io.writeFile.bind(io), rename: io.rename.bind(io), chmod: io.chmod.bind(io),
    exists: io.exists.bind(io), mkdir: io.mkdir.bind(io),
    ...(io.writeExclusive ? { writeExclusive: io.writeExclusive.bind(io) } : {}),
    ...(io.remove ? { remove: io.remove.bind(io) } : {}),
    ...(readFile ? { readFile: readFile.bind(io) } : {}),
    ...(observe ? { observe: observe.bind(io) } : {}),
  };
  if (native) nativeObservations.set(captured, { readFile: captured.readFile, observe: captured.observe });
  return captured;
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
export function createOwnedNativeUpdateFile(path: string, data: Buffer, mode: number, assertDirectory: () => void): OwnedNativeUpdateFile {
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
    writeFileSync(fd, data); fchmodSync(fd, mode); fsyncSync(fd);
    expected = fstatSync(fd, { bigint: true });
    if (expected.size !== BigInt(data.byteLength) || (expected.mode & 0o7777n) !== BigInt(mode)) throw new Error('Native update stage did not finish');
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
