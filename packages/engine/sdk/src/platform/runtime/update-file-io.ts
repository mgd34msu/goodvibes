/** Captured native update I/O and private physical-observation provenance. */
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
